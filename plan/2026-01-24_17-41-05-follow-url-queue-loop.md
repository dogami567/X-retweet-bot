---
mode: plan
cwd: f:\xiangmu\X-get2put
task: 批量关注：URL 队列 + 运行中追加 + 冷却/间隔
complexity: complex
planning_method: builtin
created_at: 2026-01-24T17:41:05.3289547+08:00
---

# Plan: 批量关注 URL 队列持续运行（含图库运行中追加）

🎯 任务概述
- 支持维护多条 X 推文链接（/status/），任务运行中可追加链接且不影响正在执行。
- 每个勾选“关注评论”的账号按 URL 列表顺序逐条处理：在当前 URL 下关注若干评论用户后切到下一条；跑完整个列表后继续循环，长时间无人值守持续运行。
- 关注节奏可配置：每次关注间隔（秒）；每成功关注 N 个后暂停 T 秒冷却；到点自动继续。
- 图文发图文（批量发帖）运行中可追加图片：用户可随时把图片放入图库目录或通过 UI 上传，新图片自动被监控/扫描，后续发帖可直接使用且不影响运行。

📋 执行计划
1. 明确数据模型与默认值：在 `data/bulk_config.json` 的 schema 中新增 `followUrls[]`、`followActionDelaySec`、`followCooldownEvery`、`followCooldownSec`（以及必要的 `followIdleSleepSec` 防止队列空/无新增时热循环），并补齐 `defaultBulkConfig()`/`normalizeBulkConfig()`。
2. 设计 API（尽量兼容现有接口）：
   - 追加 URL：`POST /api/bulk/follow-urls/add`（支持多行文本/数组，服务端去重+校验+normalize）。
   - 读取队列：复用 `GET /api/bulk/follow-commenters/status` 增加 queue 字段（urlsTotal/urls/updatedAt/currentUrl 等）。
   - 启动/停止：`POST /api/bulk/follow-commenters/start` 支持“无 tweetUrl 仅启动队列”，保留传入 tweetUrl 时等价于“先追加再启动”。
3. 后端执行引擎改造（核心）：把“单 URL 一次性任务”升级为“URL 队列循环任务”。
   - 每个账号 worker：按 `followConcurrency` 并行执行；worker 内部按 `followUrls` 顺序处理 URL；处理完最后一条回到第一条。
   - 每次成功关注后 sleep `followActionDelaySec`；每成功关注 `followCooldownEvery` 次后 sleep `followCooldownSec`；sleep 期间也可响应 stop。
4. “完成一条 URL”的判定与切换策略：
   - 对单条 URL：沿用现有 `maxPerAccount`（每号在该 URL 下最多成功关注 X 个），达到上限/无新增/日上限耗尽 → 切到下一条 URL。
   - 当 `followUrls` 为空：进入 idle（sleep `followIdleSleepSec`），等待用户运行中追加 URL。
5. 状态与可观测性：扩展 `bulkFollowJob` 结构，新增：`urlsTotal/urlsDone/currentUrl/currentAccount/cooldownRemainingSec/idle` 等；日志增加“切换 URL / 进入冷却 / 队列变更”关键信息。
6. UI 改造（bulk 面板）：在“关注评论用户”卡片增加：
   - 多行 URL 输入框 + “追加到队列”按钮 + 队列摘要（总数/当前处理/上次更新）。
   - 新增 3 个配置框：`每次关注间隔(秒)`、`每 N 个暂停 T 秒`（两个输入），并与配置保存/渲染绑定。
7. 兼容与迁移：启动时若检测到旧字段 `tweetUrl`（历史配置）可自动迁移为 `followUrls=[tweetUrl]`（一次性迁移或兼容读取）。
8. 验证与回归：
   - 手工验证：准备 2 个账号 + 2 条推文链接，启动后观察：账号按 URL 列表轮转；运行中追加新 URL 后能被后续轮次处理；冷却与间隔生效；停止按钮在冷却/idle 也能立即停。
   - 边界验证：空队列启动、重复 URL、非法 URL、日上限打满后账号进入“等到明天”或跳过策略（需要在实现中明确）。
9. 发布：更新 `README.md` 与 `CHANGELOG.md`，本地打包 `npm run release:exe` 验证 UI 可见；推送 `main` 并打 tag 触发 GitHub Actions 发布。
10. 图库运行中追加（图文发图文）：补齐“新增图片自动可用”的可观测性与稳定性（避免拷贝未完成就被选中），并明确当图片不足时的处理策略（跳过/等待/仅发文案），最后把用法写入 UI 提示与 README。

⚠️ 风险与注意事项
- 长时间运行下的“热循环”风险：当 URL 无新增或队列为空时必须有 idle sleep，避免高频刷新导致风控或占用资源。
- 状态一致性：运行中修改队列需要明确“对正在处理的 URL 是否立即生效（建议：下一次取队列时生效）”。
- 日上限与冷却的交互：账号达到每日 300 后如何处理（建议：该账号 worker 进入等待到次日 00:00 的 sleep）。
- 图库文件“拷贝未完成”风险：文件监听/扫描可能在大文件写入过程中触发，需避免选中不可读/半成品文件导致发帖失败。

📎 参考
- `server.js:4999`（关注任务 start/stop/status 接口）
- `server.js:1016`（`bulkFollowJob` 结构与 stopRequested）
- `public/bulk.html`、`public/bulk.js`（关注评论用户 UI 与参数绑定）
- `data/bulk_config.json`（批量配置持久化文件）
- `server.js:3951`（`pickBulkImagesForAccount`：按账号记录已用图片）
- `server.js:4004`（`scanBulkImages`：图库扫描）
- `server.js:4064`（`startBulkImageWatcher`：图库目录监听）
- `server.js:5600`（`GET /api/bulk/images`：图库列表）
- `server.js:5659`（`PUT /api/bulk/upload`：UI 上传图片）
- `public/bulk.js:561`（`setGalleryInfo`）
- `public/bulk.js:573`（`refreshImages`）
- `public/bulk.js:724`（`uploadFiles`）
