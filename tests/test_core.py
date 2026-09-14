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


if __name__ == "__main__":
    unittest.main()
