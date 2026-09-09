# 本地账单分析

一个只监听本机地址的微信、支付宝账单分析工具。交易数据写入 SQLite，重复导入同一账单不会重复记账；再次导入包含同一订单的新版本时，会更新交易状态和内容。

## 直接使用

双击 `启动账单分析.cmd`，浏览器会自动打开：

```text
http://127.0.0.1:8765
```

在页面右上角点击“导入新账单”，可以一次选择多个文件。支持：

- 微信支付导出的 `.xlsx`
- 支付宝导出的 `.csv`，自动识别 GB18030/GBK 与 UTF-8 编码

趋势图支持按月、按周和按天查看。点击柱形或横轴时间标签，会展开该时段的净支出、环比、分类构成和主要商户；周统计按周一至周日计算。

数据库默认保存在 `data/bills.db`。原始账单文件不会复制到项目目录，也不会上传网络。

## 命令行

```powershell
# 启动本地页面和 API
python app.py serve

# 导入一个或多个账单
python app.py import "微信账单.xlsx" "支付宝账单.csv"

# 输出当前统计结果
python app.py stats

# 指定其他数据库
python app.py --db "D:\账单数据\bills.db" serve
```

首次运行若提示缺少 `openpyxl`：

```powershell
python -m pip install -r requirements.txt
```

## 数据与统计口径

- 金额以“分”存储，避免浮点累计误差。
- 订单号存在时，以“平台 + 订单号”去重；没有订单号时，用时间、金额、方向、商户、说明和支付方式生成稳定指纹。
- 同一订单内容或状态改变时更新原记录。
- 净支出 = 支出交易原额 − 退款记录金额。
- 非退款收入不包含退款。
- 支付宝优先使用原始分类；微信默认按交易类型、商户和商品关键词分类。
- 页面中的自定义规则按优先级执行，可立即重算历史数据，也会用于以后导入。

## 本地 API

服务只绑定 `127.0.0.1`。所有响应均为 JSON。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/meta` | 数据库、分类和支持格式 |
| `GET` | `/api/dashboard` | 概览、趋势、分类、时段、商户和最近交易 |
| `GET` | `/api/transactions` | 分页交易明细 |
| `GET` | `/api/imports` | 导入历史 |
| `POST` | `/api/import` | 上传一个账单文件 |
| `GET` | `/api/rules` | 获取自定义分类规则 |
| `POST` | `/api/rules` | 新增分类规则 |
| `DELETE` | `/api/rules/{id}` | 删除分类规则 |
| `POST` | `/api/reclassify` | 按当前规则重算全部分类 |

`/api/dashboard` 和 `/api/transactions` 支持查询参数：`start=YYYY-MM-DD`、`end=YYYY-MM-DD`、`platform=微信|支付宝`、`category=分类名`。仪表盘另支持 `granularity=month|week|day`，周以周一为起始日；交易明细另支持 `page`、`size`。

### 上传文件

`POST /api/import` 使用原始文件内容作为请求体，并通过 `X-Filename` 传入 URL 编码后的文件名：

```javascript
await fetch("http://127.0.0.1:8765/api/import", {
  method: "POST",
  headers: {
    "Content-Type": "application/octet-stream",
    "X-Filename": encodeURIComponent(file.name)
  },
  body: file
});
```

### 新增分类规则

```json
{
  "field": "counterparty",
  "pattern": "麦当劳",
  "category": "餐饮",
  "priority": 200,
  "apply_existing": true
}
```

可用字段：`all`、`counterparty`、`description`、`category_raw`、`payment_method`、`status`。

## 扩展新的账单来源

1. 在 `bill_analyzer/importers.py` 中新增 `BillImporter` 子类。
2. 实现 `score(filename, content)` 与 `parse(filename, content)`。
3. 把实例加入 `IMPORTERS` 列表。

解析器只需输出统一的 `Transaction`，数据库、去重、分类和全部统计接口会自动复用。

## 备份

停止服务后复制 `data/bills.db` 即可完整备份。恢复时把文件放回原位置。不要在服务运行中只复制单个 `bills.db`，因为 SQLite WAL 模式可能同时存在 `-wal` 文件。
