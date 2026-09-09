from __future__ import annotations

from collections.abc import Iterable, Mapping


def _contains(text: str, words: Iterable[str]) -> bool:
    return any(word.lower() in text for word in words)


def rule_value(record: Mapping[str, object], field: str) -> str:
    fields = {
        "counterparty": "counterparty",
        "description": "description",
        "payment_method": "payment_method",
        "category_raw": "category_raw",
        "status": "status",
    }
    if field == "all":
        return " ".join(str(record.get(name, "")) for name in fields.values()).lower()
    return str(record.get(fields.get(field, field), "")).lower()


def classify(record: Mapping[str, object], rules: Iterable[Mapping[str, object]] = ()) -> str:
    for rule in rules:
        pattern = str(rule.get("pattern", "")).strip().lower()
        if pattern and pattern in rule_value(record, str(rule.get("field", "all"))):
            return str(rule.get("category", "其他"))

    platform = str(record.get("platform", ""))
    text = f"{record.get('counterparty', '')} {record.get('description', '')}".lower()
    raw = str(record.get("category_raw", ""))

    if platform == "微信":
        if _contains(text, ["月付", "还款", "美团金融"]):
            return "账单还款"
        if _contains(text, ["酒店", "旅店", "住宿", "三千里"]):
            return "旅行住宿"
        if _contains(text, ["自行车", "单车", "骑行", "链条", "码表", "把立", "破风", "黑鸟运动", "速痕", "报名_2026"]):
            return "骑行/运动"
        if _contains(text, ["北航", "北京航空航天大学", "校园卡", "航财通", "学生缴纳电费", "洗衣机"]):
            return "校园生活"
        if _contains(text, ["医院", "门诊", "药房", "医疗", "诊所"]):
            return "医疗健康"
        if _contains(text, ["铁路", "12306", "地铁", "公交", "打车", "滴滴", "高德", "乘车", "先骑后付", "共享单车", "华铁旅客", "租车", "机票", "航旅", "机场"]):
            return "交通出行"
        if _contains(text, ["deepseek", "api服务", "云空间", "软件", "会员", "连续包月", "华为", "充值缴费", "话费"]):
            return "数码/订阅"
        if _contains(text, ["顺丰", "京东快递", "中通", "先寄后付", "货拉拉", "搬家", "美容", "美发", "理发"]):
            return "生活服务"
        if _contains(text, ["宠物", "鱼缸", "水族", "鱼店", "除藻", "水草"]):
            return "宠物"
        if _contains(text, ["美团", "大众点评", "食堂", "餐", "饭", "菜", "厨", "茶", "咖啡", "奶", "酒", "啤", "冰城", "早餐", "食品", "熟食", "水果", "果蔬", "面包", "点心", "饽饽", "饮品", "外卖", "超市", "便利", "零售", "货柜", "蹄花", "烧烤", "火锅", "豆浆", "面馆", "麦当劳", "lawson", "惜食", "元气空间", "hot maxx"]):
            return "餐饮"
        if _contains(text, ["淘宝", "天猫", "京东", "拼多多", "商品订单", "数码", "专卖店", "书店", "文创", "店内购物", "销售商品", "五金", "门窗", "蜂业"]):
            return "购物"
        if raw in {"转账", "扫二维码付款", "微信红包（单发）", "群收款", "微信红包-退款"}:
            return "人情/转账"
        if _contains(text, ["游戏", "电影", "音乐", "演出", "图书", "公园", "景区", "参考消息"]):
            return "文化娱乐"
        return "其他"

    if _contains(text, ["自行车", "单车", "骑行", "链条", "码表", "把立", "羽毛球", "跑步", "运动", "迪卡侬", "黑鸟"]):
        return "骑行/运动"
    if _contains(text, ["医院", "门诊", "药房", "医疗", "诊所"]):
        return "医疗健康"
    if _contains(text, ["智能货柜", "电解质水", "餐", "饭", "菜", "外卖", "食品", "饮品", "咖啡", "奶茶", "面包", "水果", "超市", "便利"]):
        return "餐饮"
    if raw == "退款":
        if _contains(text, ["火车票", "铁路", "12306"]):
            return "交通出行"
        if _contains(text, ["鱼缸", "水族", "鳌虾", "水草"]):
            return "宠物"
        if _contains(text, ["羽毛球", "跑步", "运动", "迪卡侬"]):
            return "骑行/运动"
        return "其他"
    return {
        "餐饮美食": "餐饮",
        "交通出行": "交通出行",
        "酒店旅游": "旅行住宿",
        "日用百货": "购物",
        "服饰装扮": "购物",
        "数码电器": "购物",
        "家居家装": "购物",
        "运动户外": "骑行/运动",
        "文化休闲": "文化娱乐",
        "住房物业": "住房",
        "生活服务": "生活服务",
        "宠物": "宠物",
        "美容美发": "生活服务",
        "医疗健康": "医疗健康",
        "充值缴费": "通讯缴费",
        "商业服务": "生活服务",
        "转账红包": "人情/转账",
        "投资理财": "资金调拨",
        "其他": "其他",
    }.get(raw, "其他")
