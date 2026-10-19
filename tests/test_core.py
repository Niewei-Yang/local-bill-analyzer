from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path

from openpyxl import Workbook

from app import import_bytes
from bill_analyzer.analytics import dashboard, transactions
from bill_analyzer.categorize import classify
from bill_analyzer.db import add_rule, connect, import_transactions, init_db
from bill_analyzer.importers import SchoolIncomeImporter
from bill_analyzer.models import Transaction


def alipay_csv() -> bytes:
    text = """支付宝交易明细\r
交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,\r
2026-01-01 12:00:00,餐饮美食,测试餐厅,,午餐,支出,100.00,银行卡,交易成功,A001,M001,,\r
2026-01-02 12:00:00,退款,测试餐厅,,退款-午餐,不计收支,20.00,银行卡,退款成功,A002,M002,,\r
2026-01-03 09:00:00,转账红包,朋友,,转账,收入,50.00,余额,交易成功,A003,M003,,\r
"""
    return text.encode("gb18030")


def wechat_xlsx() -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    for _ in range(17):
        sheet.append([""])
    sheet.append(["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号", "商户单号", "备注"])
    sheet.append(["2026-01-04 18:00:00", "商户消费", "麦当劳", "晚餐", "支出", 30, "零钱", "支付成功", "W001", "WM001", ""])
    stream = io.BytesIO()
    workbook.save(stream)
    return stream.getvalue()


def school_income_xls() -> bytes:
    return (Path(__file__).parent / "fixtures" / "studentSRCX-sample.xls").read_bytes()


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "test.db"
        init_db(self.db)

    def tearDown(self):
        self.temp.cleanup()

    def test_import_deduplicates_and_reconciles_refunds(self):
        first = import_bytes(self.db, "支付宝交易明细.csv", alipay_csv())
        second = import_bytes(self.db, "支付宝交易明细.csv", alipay_csv())
        self.assertEqual(first["inserted"], 3)
        self.assertEqual(second["unchanged"], 3)
        result = dashboard(self.db, {})
        self.assertEqual(result["summary"]["net_spend"], 80.0)
        self.assertEqual(result["summary"]["income"], 50.0)
        self.assertEqual(result["summary"]["row_count"], 3)
        top_expense = transactions(self.db, {"direction": "expense", "sort": "amount_desc", "size": "1"})
        self.assertEqual(top_expense["total"], 1)
        self.assertEqual(top_expense["items"][0]["amount"], 100.0)

    def test_same_order_updates_without_creating_duplicate(self):
        import_bytes(self.db, "支付宝交易明细.csv", alipay_csv())
        changed_content = alipay_csv().decode("gb18030").replace("100.00", "110.00").encode("gb18030")
        updated = import_bytes(self.db, "支付宝交易明细-更新.csv", changed_content)
        self.assertEqual(updated["inserted"], 0)
        self.assertEqual(updated["updated"], 1)
        self.assertEqual(updated["unchanged"], 2)
        result = dashboard(self.db, {})
        self.assertEqual(result["summary"]["row_count"], 3)
        self.assertEqual(result["summary"]["net_spend"], 90.0)

    def test_dashboard_supports_month_week_and_day_trends(self):
        import_bytes(self.db, "支付宝交易明细.csv", alipay_csv())
        import_bytes(self.db, "微信支付账单.xlsx", wechat_xlsx())
        expected = {"month": "2026-01", "week": "2025-12-29", "day": "2026-01-01"}
        for granularity, first_period in expected.items():
            with self.subTest(granularity=granularity):
                result = dashboard(self.db, {"granularity": granularity})
                self.assertEqual(result["granularity"], granularity)
                self.assertEqual(result["trend"][0]["period"], first_period)
                self.assertAlmostEqual(sum(item["total"] for item in result["trend"]), result["summary"]["net_spend"])

        invalid = dashboard(self.db, {"granularity": "quarter"})
        self.assertEqual(invalid["granularity"], "month")

    def test_wechat_parser_and_custom_rule(self):
        imported = import_bytes(self.db, "微信支付账单.xlsx", wechat_xlsx())
        self.assertEqual(imported["inserted"], 1)
        with connect(self.db) as connection:
            before = connection.execute("SELECT category FROM transactions").fetchone()[0]
        self.assertEqual(before, "餐饮")
        result = add_rule(
            self.db,
            {"field": "counterparty", "pattern": "麦当劳", "category": "外出就餐", "priority": 500, "apply_existing": True},
        )
        self.assertEqual(result["reclassified"], 1)
        with connect(self.db) as connection:
            after = connection.execute("SELECT category FROM transactions").fetchone()[0]
        self.assertEqual(after, "外出就餐")

    def test_school_income_daily_is_independent_and_respects_filters(self):
        records = [
            Transaction("校内收入", "2026-01-02 10:00:00", "income", 312000),
            Transaction("校内收入", "2026-01-02 11:00:00", "income", 1501),
            Transaction("校内收入", "2026-02-03 10:00:00", "income", 80000),
            Transaction("校内收入", "2026-01-04 10:00:00", "income", 900, is_refund=1),
            Transaction("微信", "2026-01-03 10:00:00", "income", 20000, category_raw="转账"),
            Transaction("支付宝", "2026-01-03 12:00:00", "expense", 100000),
        ]
        import_transactions(self.db, "income.csv", "测试", b"income-series", records)
        expected = [{"day": "2026-01-02", "amount": 3135.01}, {"day": "2026-02-03", "amount": 800}]
        for granularity in ("month", "week", "day"):
            result = dashboard(self.db, {"granularity": granularity})
            self.assertEqual(result["school_income_daily"], expected)
            self.assertEqual(result["summary"]["net_spend"], 791)
        filtered = dashboard(self.db, {"end": "2026-01-31", "exclude_large_expenses": "true"})
        self.assertEqual(filtered["school_income_daily"], expected[:1])
        self.assertEqual(filtered["summary"]["net_spend"], -209)
        self.assertEqual(dashboard(self.db, {"platform": "微信"})["school_income_daily"], [])
        self.assertEqual(dashboard(self.db, {"start": "2026-01-03"})["school_income_daily"], expected[1:])
        self.assertEqual(dashboard(self.db, {"platform": "校内收入"})["school_income_daily"], expected)

    def test_wechat_qr_income_offsets_net_spend_once(self):
        records = [
            Transaction("微信", "2026-01-28 12:00:00", "expense", 311380),
            Transaction("微信", "2026-01-28 13:04:48", "income", 3800, category_raw="转账"),
            Transaction("微信", "2026-01-28 20:29:35", "income", 299400, category_raw="二维码收款"),
            Transaction("校内收入", "2026-01-28 10:00:00", "income", 160000),
            Transaction("支付宝", "2026-01-28 10:00:00", "income", 10000, category_raw="二维码收款"),
            Transaction("微信", "2026-01-28 10:00:00", "neutral", 20000, category_raw="二维码收款"),
        ]
        import_transactions(self.db, "qr.csv", "测试", b"qr-income", records)
        for granularity in ("month", "week", "day"):
            with self.subTest(granularity=granularity):
                result = dashboard(self.db, {"granularity": granularity})
                self.assertEqual(result["summary"]["transfer_income"], 38)
                self.assertEqual(result["summary"]["qr_income"], 2994)
                self.assertEqual(result["summary"]["wechat_income"], 3032)
                self.assertEqual(result["summary"]["net_spend"], 81.8)
                for section, key in (("trend", "total"), ("monthly", "total"), ("categories", "amount"), ("platforms", "amount")):
                    self.assertAlmostEqual(sum(item[key] for item in result[section]), 81.8)
        filtered = dashboard(self.db, {"exclude_large_expenses": "true"})
        self.assertEqual(filtered["summary"]["wechat_income"], 3032)
        self.assertEqual(filtered["summary"]["net_spend"], -3032)
        self.assertEqual(dashboard(self.db, {"platform": "支付宝"})["summary"]["qr_income"], 0)
        self.assertEqual(dashboard(self.db, {"start": "2026-01-29"})["summary"]["qr_income"], 0)
        import_transactions(self.db, "qr-refund.csv", "测试", b"qr-refund", [
            Transaction("微信", "2026-01-28 23:00:00", "income", 100, category_raw="二维码收款", is_refund=1),
        ])
        refunded = dashboard(self.db, {})
        self.assertEqual(refunded["summary"]["qr_income"], 2994)
        self.assertEqual(refunded["summary"]["net_spend"], 80.8)
        self.assertAlmostEqual(sum(item["total"] for item in refunded["trend"]), 80.8)

    def test_exclude_large_expenses_across_statistics_and_details(self):
        records = [
            Transaction("微信", "2026-10-01 12:00:00", "expense", 99999, counterparty="小额商户"),
            Transaction("微信", "2026-10-02 12:00:00", "expense", 100000, counterparty="整千商户"),
            Transaction("支付宝", "2026-10-03 12:00:00", "expense", 100001, counterparty="大额商户"),
            Transaction("支付宝", "2026-10-04 12:00:00", "income", 300000),
            Transaction("支付宝", "2026-10-05 12:00:00", "neutral", 150000, is_refund=1),
            Transaction("微信", "2026-10-06 12:00:00", "income", 200000, category_raw="转账"),
            Transaction("支付宝", "2026-10-07 12:00:00", "neutral", 400000),
        ]
        import_transactions(self.db, "threshold.csv", "测试", b"threshold", records)
        params = {"exclude_large_expenses": "true", "start": "2026-10-01", "end": "2026-10-31"}
        for granularity in ("month", "week", "day"):
            with self.subTest(granularity=granularity):
                result = dashboard(self.db, {**params, "granularity": granularity})
                summary = result["summary"]
                self.assertEqual(summary["row_count"], 5)
                self.assertEqual(summary["gross_expense"], 999.99)
                self.assertEqual(summary["expense_count"], 1)
                self.assertEqual(summary["median_expense"], 999.99)
                self.assertEqual(summary["income"], 5000)
                self.assertEqual(summary["refunds"], 1500)
                self.assertEqual(summary["transfer_income"], 2000)
                for section, key in (("trend", "total"), ("categories", "amount"), ("platforms", "amount")):
                    self.assertAlmostEqual(sum(item[key] for item in result[section]), summary["net_spend"])
                self.assertAlmostEqual(sum(item["amount"] for item in result["heatmap"]), 999.99)
                self.assertEqual([item["merchant"] for item in result["merchants"]], ["小额商户"])
                self.assertEqual(result["top_days"], [{"date": "2026-10-01", "amount": 999.99}])
                self.assertTrue(all(item["amount"] < 1000 for item in result["recent"] if item["direction"] == "expense"))

        first = transactions(self.db, {**params, "size": "2"})
        second = transactions(self.db, {**params, "size": "2", "page": "2"})
        third = transactions(self.db, {**params, "size": "2", "page": "3"})
        self.assertEqual(first["total"], 5)
        self.assertEqual(len({item["id"] for page in (first, second, third) for item in page["items"]}), 5)
        top = transactions(self.db, {**params, "direction": "expense", "sort": "amount_desc", "size": "1"})
        self.assertEqual(top["items"][0]["amount"], 999.99)
        wechat = transactions(self.db, {**params, "platform": "微信", "category": top["items"][0]["category"], "direction": "expense"})
        self.assertEqual(wechat["total"], 1)
        empty = {**params, "start": "2026-10-02", "end": "2026-10-03"}
        self.assertEqual(dashboard(self.db, empty)["summary"]["row_count"], 0)
        self.assertEqual(transactions(self.db, empty)["items"], [])
        self.assertEqual(dashboard(self.db, {})["summary"]["expense_count"], 3)
        self.assertEqual(transactions(self.db, {"exclude_large_expenses": "false"})["total"], 7)

    def test_trend_other_category_is_counted_once_after_filtering(self):
        records = [Transaction("微信", "2026-10-01 12:00:00", "expense", 50000, category_raw="其他")]
        records += [Transaction("微信", "2026-10-01 12:00:00", "expense", (8-i)*1000, category_raw=f"分类{i}") for i in range(7)]
        records += [
            Transaction("微信", "2026-10-01 12:00:00", "expense", 1000000, category_raw="大额支出"),
            Transaction("微信", "2026-10-01 12:00:00", "neutral", 10000, category_raw="退款类别", is_refund=1),
        ]
        import_transactions(self.db, "categories.csv", "微信", b"categories", records)
        with connect(self.db) as connection:
            connection.execute("UPDATE transactions SET category = category_raw")
        for params in ({}, {"exclude_large_expenses": "true"}):
            for granularity in ("month", "week", "day"):
                with self.subTest(params=params, granularity=granularity):
                    result = dashboard(self.db, {**params, "granularity": granularity})
                    for legend_key, periods_key in (("trend_categories", "trend"), ("monthly_categories", "monthly")):
                        categories = result[legend_key]
                        self.assertEqual(categories.count("其他"), 1)
                        self.assertEqual(len(categories), len(set(categories)))
                        for period in result[periods_key]:
                            self.assertAlmostEqual(sum(period["categories"].get(category, 0) for category in categories), period["total"])

    def test_school_income_categories(self):
        base = {"platform": "校内收入", "counterparty": "学校", "description": "", "category_raw": ""}
        expected = {
            "博士国家助学金": "助学金",
            "助研津贴": "助研津贴",
            "奖学金*": "奖学金",
            "学生劳务": "劳务收入",
            "学生资助*": "学生资助",
        }
        for raw, category in expected.items():
            with self.subTest(raw=raw):
                self.assertEqual(classify({**base, "category_raw": raw}), category)

        import_transactions(
            self.db,
            "校内收入.xls",
            "校内收入",
            b"school-income-fixture",
            [
                Transaction(
                    platform="校内收入",
                    transaction_time="2025-09-09 00:00:00",
                    direction="income",
                    amount_cents=150000,
                    category_raw="博士国家助学金",
                    source_order_id="S001",
                )
            ],
        )
        filtered = dashboard(self.db, {"platform": "校内收入"})
        self.assertEqual(filtered["summary"]["row_count"], 1)
        self.assertEqual(filtered["summary"]["income"], 1500.0)


class CategoryFallbackTests(unittest.TestCase):
    def test_missing_categories_and_refunds(self):
        cases = [
            ("微信", "商户消费", "湖北笑联科技有限公司", "/", "校园生活"),
            ("微信", "商户消费", "要打印", "取件单号", "生活服务"),
            ("微信", "商户消费", "三吨片健身工作室", "/", "骑行/运动"),
            ("微信", "商户消费", "Cotti Coffee", "美式", "餐饮"),
            ("微信", "微信红包（群红包）", "朋友", "/", "人情/转账"),
            ("微信", "转账-退款", "/", "微信转账", "人情/转账"),
            ("微信", "零钱提现", "银行", "/", "资金调拨"),
            ("支付宝", "信用借还", "花呗", "自动还款", "账单还款"),
            ("支付宝", "退款", "滴滴顺风车", "退款-费用", "交通出行"),
            ("支付宝", "退款", "店铺", "退款-Strava会员订阅", "骑行/运动"),
            ("支付宝", "其他", "上海亦净网络科技有限公司", "坚果云专业版", "数码/订阅"),
            ("支付宝", "保险", "保险公司", "意外险", "保险"),
        ]
        for platform, raw, merchant, description, expected in cases:
            with self.subTest(merchant=merchant, raw=raw):
                self.assertEqual(classify(dict(platform=platform, category_raw=raw,
                    counterparty=merchant, description=description)), expected)

    def test_ambiguous_records_and_keyword_conflicts(self):
        cases = [
            ("习惯就好", "/", "其他"),
            ("麦穗", "/", "其他"),
            ("云免押", "关闭订单解冻", "其他"),
            ("中国石化北京石油", "运动饮料西柚味600ml", "餐饮"),
            ("搜电科技", "免押租借充电宝", "生活服务"),
            ("微信小店", "购买充电宝", "购物"),
        ]
        for merchant, description, expected in cases:
            with self.subTest(merchant=merchant):
                self.assertEqual(classify(dict(platform="微信", category_raw="商户消费",
                    counterparty=merchant, description=description)), expected)

    def test_existing_category_and_custom_rule_take_precedence(self):
        record = dict(platform="支付宝", category_raw="日用百货",
                      counterparty="沃尔玛", description="订单")
        self.assertEqual(classify(record), "购物")
        rule = dict(field="counterparty", pattern="沃尔玛", category="日常采购")
        self.assertEqual(classify(record, [rule]), "日常采购")


class SchoolIncomeXlsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "test.db"
        init_db(self.db)

    def tearDown(self):
        self.temp.cleanup()

    def test_imports_school_income_xls(self):
        imported = import_bytes(self.db, "studentSRCX20260924.xls", school_income_xls())
        self.assertEqual(imported["total"], 4)
        self.assertEqual(imported["inserted"], 4)
        self.assertEqual(imported["excluded"], 0)
        with connect(self.db) as connection:
            rows = {row["source_order_id"]: row for row in connection.execute("SELECT * FROM transactions")}
        voucher = rows["202603104416"]
        self.assertEqual(voucher["transaction_time"], "2026-03-08 00:00:00")
        self.assertEqual(voucher["status"], "已制证")
        self.assertEqual(voucher["amount_cents"], 312000)
        self.assertEqual(voucher["category"], "助研津贴")
        self.assertEqual(voucher["counterparty"], "北京航空航天大学")
        self.assertEqual(voucher["description"], "测试研究生劳务")
        self.assertEqual(voucher["payment_method"], "621558xxxxxx863778")
        self.assertEqual(voucher["merchant_order_id"], "26030118519")
        self.assertEqual(voucher["note"], "航空发动机研究院；测试科研项目")
        entry = rows["202601200006"]
        self.assertEqual(entry["transaction_time"], "2026-01-06 00:00:00")
        self.assertEqual(entry["status"], "已录入")
        self.assertEqual(entry["description"], "博士国家助学金")
        self.assertEqual(entry["category"], "助学金")
        self.assertEqual(entry["note"], "暂付款；工资助学金")
        festival = rows["202509200013"]
        self.assertEqual(festival["transaction_time"], "2025-09-05 00:00:00")
        self.assertEqual(festival["amount_cents"], 1500)
        self.assertEqual(festival["category"], "学生资助")
        self.assertEqual(festival["note"], "")
        again = import_bytes(self.db, "studentSRCX20260924.xls", school_income_xls())
        self.assertEqual(again["unchanged"], 4)

    def test_income_scoped_to_expense_window(self):
        import_transactions(
            self.db,
            "微信支付账单.xlsx",
            "微信",
            b"expense-window-seed",
            [
                Transaction(
                    platform="微信",
                    transaction_time="2025-09-09 09:08:10",
                    direction="expense",
                    amount_cents=1200,
                    category_raw="商户消费",
                    source_order_id="W002",
                )
            ],
        )
        imported = import_bytes(self.db, "studentSRCX20260924.xls", school_income_xls())
        self.assertEqual(imported["total"], 3)
        self.assertEqual(imported["inserted"], 3)
        self.assertEqual(imported["excluded"], 1)
        with connect(self.db) as connection:
            ids = [
                row[0]
                for row in connection.execute(
                    "SELECT source_order_id FROM transactions WHERE platform = '校内收入' ORDER BY source_order_id"
                )
            ]
        # 2025-09-05 的收入与 2025-09-09 的支出同月，保留；2025-08 的一条被时间窗挡下
        self.assertEqual(ids, ["202509200013", "202601200006", "202603104416"])

    def test_score_targets_xls_income_files(self):
        importer = SchoolIncomeImporter()
        content = school_income_xls()
        self.assertGreater(importer.score("studentSRCX20260924.xls", content), 0)
        self.assertGreater(importer.score("收入查询.xls", content), 0)
        self.assertEqual(importer.score("studentSRCX20260924.xlsx", content), 0)
        self.assertEqual(importer.score("studentSRCX20260924.xls", b"PK\x03\x04 not ole"), 0)


if __name__ == "__main__":
    unittest.main()
