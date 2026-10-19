# Vercel + Neon 部署

部署目录为本项目根目录。前端和 Python API 由 Vercel 托管，账单存入 Neon PostgreSQL。本地不设置 `DATABASE_URL` 时仍使用 `data/bills.db`。

## 环境变量

在 Vercel 项目 Settings → Environment Variables 配置 Production 环境：

| 名称 | 内容 |
| --- | --- |
| `DATABASE_URL` | Neon 的 PostgreSQL 连接串，保留 `sslmode=require`；推荐 pooled 地址 |
| `APP_USERNAME` | 网站登录用户名，默认 `admin` |
| `APP_PASSWORD` | 至少 8 个字符的独立网站密码 |

访问网站时浏览器弹出登录框。数据库连接串仅由后端使用，不会发送到页面。缺少数据库连接或网站密码时，云端接口返回未配置状态，不会回退为临时 SQLite。

首次使用 Neon 集成时，账号持有人需要在 Vercel 页面确认 Marketplace/Neon 条款。创建数据库时选 Free 套餐，并让数据库和 Vercel Function 使用相近地区。仅将生产连接配置到 Production；预览环境应使用单独的测试数据库或 Neon 分支。

## 创建部署

```powershell
python -m pip install -r requirements.txt
npx vercel login
npx vercel link
# 在 Vercel Storage 中创建 Neon 并连接 Production，再设置上述登录变量
npx vercel --prod
```

根目录的 `vercel.json` 把请求路由到 `api/index.py`。无需启动 `python app.py serve`，也不需要另外构建前端。`.vercelignore` 会排除账单、数据库、测试截图及环境变量文件，防止这些文件进入部署包。

Vercel 的 Production 环境变量变更需要重新部署才会生效。修改 `APP_USERNAME` 或 `APP_PASSWORD` 后，在 Deployments 中重新部署生产版本；如果浏览器仍使用旧登录信息，可打开无痕窗口重新登录。

CLI 部署后，可用 `npx vercel git connect https://github.com/Niewei-Yang/local-bill-analyzer.git` 连接 GitHub 仓库。本项目已连接，生产分支为 `main`，后续推送到该分支会触发生产部署。

## 一次性迁移现有账本

在本地创建 `.env`（参考 `.env.example`），填入 Neon `DATABASE_URL`。此文件已被 Git 和 Vercel 部署排除。

```powershell
# 首次迁移只接受空云库，保留交易 ID、去重指纹、导入历史、分类规则
python -m bill_analyzer.migration import data/bills.db

# 从云库导出 SQLite 快照；导出文件名必须尚不存在
python -m bill_analyzer.migration export data/cloud-export.db
```

源 SQLite 通过只读连接读取，不修改原账本。迁移先检查完整性和外键，在同一个 PostgreSQL 事务中写入并核对各表数量，失败会回滚。已有云端数据时默认停止；确实要替换时使用 `--replace`，替换前会把旧账本作为 SQLite 备份持久保存在云库 `database_backups` 表中。

```powershell
python -m bill_analyzer.migration import data/bills.db --replace
```

网页中的导出功能也会生成兼容本地版的 SQLite 文件。恢复会替换云端账本并保留云端备份。返回的 `cloud-backup-123.db` 可通过已登录的 `/api/database/export?backup=123` 下载。较大账本应通过命令行迁移，避免网页上传和响应大小限制。

## 上传限制和验证

云端网页单文件及数据库导入/导出上限设为 4 MiB（低于 Vercel Function 的 4.5 MB 请求/响应限制）；本地账单上传仍为 50 MB。原始文件在本次请求中解析，不会作为附件永久存储，数据库中保留解析后的交易。

部署后验证：未登录无法读取账单；登录后统计与本地一致；导入可去重；刷新、重新部署后数据仍在；导出快照可重新打开。云端与本地是两个账本，不自动双向同步。

## 测试

```powershell
python -m unittest discover -s tests -v
node tests/test_growth.mjs
```

PostgreSQL 集成测试会创建并清理独立的随机测试 schema，不操作生产表。使用测试数据库：

```powershell
$env:TEST_DATABASE_URL = 'postgresql://...'
python -m unittest tests.test_cloud -v
```

参考：[Vercel Python Runtime](https://vercel.com/docs/functions/runtimes/python)、[Neon Vercel Integration](https://neon.com/blog/neon-vercel-native-integration)、[Vercel Function Limits](https://vercel.com/docs/functions/limitations)。
