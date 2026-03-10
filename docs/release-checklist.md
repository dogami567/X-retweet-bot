# 发布检查清单

适用范围：`X-get2put` 每次准备本地交付、打包 EXE、或同步线上仓库说明时。

## 1. 构建前准备

- 确认 `README.md` 的“当前状态与已知限制”与代码一致，没有承诺未完成能力。
- 确认 `CHANGELOG.md` 的 `Unreleased` 已包含本次实际改动。
- 如果需要真实采集 / 自动关注验收，准备好：
  - 可访问 `x.com` 的网络 / 代理环境
  - 至少 1 个已登录的浏览器 Profile
  - 本机可写的图片目录与 `data/browser-profiles/*`

## 2. 自动化回归

### 必跑

- `npm run test:bulk-regression`
  - 覆盖旧配置迁移
  - 覆盖 queue-cycle / idle / stop / 冷却参数契约
  - 覆盖蓝 V / 中文 bio 过滤
  - 覆盖 Bulk UI 与内容池热更新 e2e

### 按需追加

- `npm run test:e2e:harvest-acceptance`
  - 仅在本机存在真实登录态、可访问 X 搜索页时执行
  - 目标是确认“关键词采集 -> URL 队列新增 -> UI 可见”真实链路

## 3. UI / 行为 spot check

- 打开 `bulk.html`，确认以下控件可见并可保存回填：
  - `harvestRepeatStrategy`
  - `harvestMinIntervalSec`
  - `followRequireVerified`
  - `followRequireChineseBio`
- 点击“采集状态 / 刷新状态”，确认提示文案能看到：
  - `lastTrigger / lastRequestedAt / lastQueueCycleAt`
  - 当前 URL / 队列指针 / `waitState` / `lastEndedBecause`
- 运行中的 bulk scheduler 保存 captions / 图片目录后，不应出现全局 stop/start。

## 4. 打包与产物检查

- 执行 `npm run release:exe`
- 检查打包产物是否包含：
  - 主程序 EXE
  - `public/` 静态资源
  - 当前 `README.md` / `CHANGELOG.md`（若发布流程有附带文档）
- 手动打开打包产物中的 Bulk 面板，确认新增控件和提示文案仍然存在。

## 5. 交付前记录

- 记录本次执行的命令与结果（至少包含 `npm run test:bulk-regression`）。
- 若跳过了真实 harvest 验收，需在交付说明中明确原因，例如：
  - 缺少登录态
  - 当前环境无法访问 X
  - 仅做 UI / 本地逻辑变更，无需真实链路复测
