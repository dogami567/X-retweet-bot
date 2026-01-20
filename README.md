# X-retweet-bot

本项目是一个本地运行的「监控 + 搬运发布」工具：

- 监控（读）：用 `twitterapi.io` 拉取目标账号最新推文
- 搬运（写）：用 X 官方 API（`twitter-api-v2`）把文本 + 图片发到你的账号（支持本地 Clash 代理）
- 可选：启用“翻译为中文”（Google 免费）后，无论原推英文/中文，最终发布统一为中文（仅 `create tweet` 生效）
- 批量：支持批量账号的独立浏览器 Profile 登录、批量发帖与更清晰的报错汇总（见批量面板）

## 批量起号（多账号定时发帖）

入口：运行程序后打开面板 `http://localhost:3000`，点击右上角「批量起号」进入 `bulk.html`。

这个板块用来管理多个账号，按计划自动发帖（随机文案 + 随机配图数量），并提供：

- 每账号独立浏览器 Profile 登录（不需要保存账号密码）
- 定时调度（间隔 + 抖动）+ 手动发送
- 图库上传/扫描/自动刷新
- 日志与“报错汇总”（快速定位哪个账号失败、失败原因）

### 1) 第一次使用（推荐流程）

1. **配置图库目录**：默认是 `data/bulk-images`。你也可以改成其它目录（比如放在大盘符里），然后点击「保存全局」。
2. **导入/编辑文案库**：
   - 右侧「文案库」支持手动新增/更新/删除
   - 支持导入 `.txt`（一行一条文案；会自动去重、忽略空行）
3. **准备图片**：
   - 右侧「图库」点“上传”，或者直接把图片复制到你配置的图片目录
   - 支持：jpg/jpeg/png/gif/webp
   - 面板会定期扫描，且目录新增图片会自动加入图库（必要时点右上角刷新按钮）
4. **添加账号并登录**：
   - 左侧「账号管理」点 `+` 新建账号
   - 在「浏览器登录」点击「打开浏览器登录」，在弹出的 Chrome/Edge 窗口完成登录（可选 Continue with Google）
   - 登录成功后，Profile 会保存到 `data/browser-profiles/<账号id>`，下次无需重复登录
5. **设置调度策略**：
   - 基础间隔（分）+ 随机抖动（±分）
   - 图片数量（Min/Max），每次会在范围内随机选取（最多 4 张）
6. **启动**：
   - 顶部点「开始」后会按计划运行
   - 选中某个账号可点「手动发送」立即发一条

### 2) 代理（每账号独立）

在「账号详情」里有 `代理 (Proxy)`：

- **每个账号都可以填写自己的代理地址**（例如 `http://127.0.0.1:7890` / `socks5://127.0.0.1:7890`）
- 留空则回退到 `.env` 的 `HTTPS_PROXY/HTTP_PROXY/ALL_PROXY`
- 打开登录浏览器、浏览器发帖、以及（若你使用 API）X API 请求，都会使用该账号的代理配置

### 3) API 凭证（可选）

账号支持两种发帖方式：

- **推荐：浏览器 Profile 发帖**（不需要填 Token）
- **可选：X 官方 API 发帖**（需要在账号里填 4 个 Token），并且权限必须是 Read and Write

面板右上角「验证」会调用 `users/me` 检查该账号 API 是否可用。

### 4) Dry Run（建议先开）

账号勾选 `Dry Run` 时：

- 只写日志，不会真的发帖
- 适合先验证：文案/图片是否正常、调度是否符合预期

### 5) 图片选择（避免重复）

系统会尽量让**同一个账号**在一轮内不重复使用同一张图；当图片都用过一遍后再开始下一轮（最多 4 张/次）。

### 6) 排错方式

- 「日志」：查看详细过程
- 「报错」：聚合展示每个账号最近一次错误（账号/时间/错误），用于快速定位需要重新登录或调整代理/配置的账号

## v0.3.3 更新（2026-01-20）

- 批量：代理配置改为“每账号独立代理”（移除全局默认代理/代理池的配置方式）
- 文档：补充“批量起号”板块的完整使用说明

## v0.3.1 更新（2026-01-20）

- 修复：点击“手动抓取/测试抓取”等接口不再导致服务直接退出
- 批量：登录方式改为“每账号独立浏览器 Profile”（不再依赖 Cookie）
- 批量：新增“报错汇总”Tab；图片按账号轮换；图库目录新增监控并自动刷新

更详细更新请看 `CHANGELOG.md`。

## 下载与运行（推荐：免安装 EXE）

1. 去 GitHub 的 Releases 下载 `X-get2put-exe.zip` 并解压
2. 双击运行 `X-get2put.exe`（会弹出黑色日志窗口，并自动打开浏览器面板）
3. 在网页“配置”里填写并保存：`twitterapi.io API Key` + `X 官方 4 个 Token`（以及可选代理）

## 准备工作（三大块）
1. 获取监控用的 Key (twitterapi.io)
用途：用来监控目标账号有没有发新推。

步骤：

注册登录 [twitterapi.io](https://twitterapi.io/)。

在 Dashboard（仪表盘）左侧找到 User Information 卡片。

复制里面的 API Key（点眼睛图标显示，再复制）。

避坑：不要去点什么 Login 接口换 Cookie，监控只需要这一个 Key 就够了！不要去管 Dashboard 上的 User ID。

2. 获取转发用的 Key (X 官方开发者平台)
用途：用来发推/转推。这一步坑最多，请严格按步骤来。

步骤：

浏览器登录你的 X 账号，访问 [X Developer Portal](https://developer.x.com/en/portal/dashboard)。

注册 Free 账号：如果弹窗让你选套餐，记得选最下面的 "Sign up for Free Account"（免费版），别选 Basic（那是付费的）。

填写申请理由：随便写 250 字以上的英文（可以用这个模板）：

I am a software developer learning to use the X API v2. My goal is to build a simple personal bot that automates retweeting posts from a few specific tech news accounts that I follow. The app will run locally on my machine for educational purposes. It will strictly perform read and write operations on my own account timeline. I will not analyze user data, share data with third parties, or use it for surveillance. My focus is solely on understanding OAuth 2.0 authentication and API endpoint interactions within the free tier limits.

创建 App：在 Projects & Apps 下创建一个新 App。

【天坑 1：权限设置】：

刚创建完 千万别急着记 Key！ 此时 Token 是只读的，发推会报错。

点左侧菜单你的 App 名字 -> Settings -> User authentication settings -> Set up / Edit。

App permissions: 必须选 Read and Write（读写权限）。

Type of App: 选 Web App, Automated App or Bot。

App info:

Callback URI: 填 http://www.google.com

Website URL: 填 https://www.google.com

点 Save 保存。

【天坑 2：重置 Token】：

权限改完后，回到 Keys and Tokens 页面。

必须找到 Authentication Tokens (Access Token and Secret) 这一栏。

点击 Regenerate (重新生成)！

这之后复制下来的 Access Token 和 Secret 才是带写权限的。

最终记下 4 个码：

API Key (Consumer Key)

API Key Secret (Consumer Secret)

Access Token

Access Token Secret

3. 准备本地环境 (.env 配置)
你需要一个 .env 文件来存放所有敏感信息。

如果你是给“小白”用（不想碰 `.env`）：

- 直接运行 `npm run dev`（或 `npm start`），打开 http://localhost:3000
- 在网页“配置”里填写并保存：`twitterapi.io API Key` + `X 官方 4 个 Token`（以及可选代理）
- 保存后立即生效，不需要重启服务；后续只要改网页配置然后刷新页面即可

更适合小白的方式（双击运行）：

- 第一次：双击 `01-安装环境.bat`（会执行 `npm install`）
- 每次启动：双击 `02-启动面板(开发模式).bat`（会执行 `npm run dev` 并自动打开浏览器）

更省事的方式（免安装 EXE 版）：

- 解压 `X-get2put-exe.zip`
- 双击 `X-get2put.exe`（会弹出黑色日志窗口，并自动打开浏览器面板）
- 在网页“配置”里填写并保存：`twitterapi.io API Key` + `X 官方 4 个 Token`（以及可选代理）
- 关闭黑色窗口 = 停止服务

注意：EXE 版第一次运行会在同目录生成 `data/`（存放下载内容与本地配置），请不要放在需要管理员权限的目录（如 `C:\\Program Files`），建议解压到桌面/任意普通文件夹。

打包版里会附带一个空的 `.env`（模板来自 `.env.empty`），但小白一般不需要填它，直接在网页配置里填 Key/Token 即可。

【天坑 3：代理设置】：

不要去买什么公网代理，直接用你本地的 Clash！

HTTPS_PROXY: 填 http://127.0.0.1:7890（确认一下 Clash 端口是不是 7890）。

TWITTERAPI_IO_KEY: 填第 1 步拿到的那个 Key。

X_...: 填第 2 步拿到的那 4 个官方 Key。

推荐稳定配置：

MONITOR_POLL_INTERVAL_SEC：建议 1800（30 分钟轮询一次，省额度更稳定）

MONITOR_FETCH_LIMIT：每次抓取条数上限（默认 20）。如果你想“补漏”（例如半小时轮询一次），可以调大一些（例如 60/100）；注意会自动翻页，调用次数也会增加。

FORWARD_MODE=create_tweet：搬运模式（下载文本+图片后发新推）

FORWARD_SEND_INTERVAL_SEC=5：一次发现多条新推时，每条间隔 5 秒发一条（更稳）

常见报错 & 解决方案
报错 403 Forbidden (Privilege Missing)

原因：Access Token 是旧的（只读权限）。

解法：回到 X 开发者后台，确保 User authentication settings 里勾选了 "Read and Write"，然后必须去 Regenerate (重新生成) Access Token 和 Secret，填入 .env 替换旧的。

报错 Connection Refused / Timeout

原因：脚本连不上推特服务器，代理配置不对。

解法：检查 .env 里的 HTTPS_PROXY 是否填对（例如 http://127.0.0.1:7890），并确保你的 Clash 是开着的，且 System Proxy（系统代理）模式不影响脚本，脚本是直接连端口的。

报错 429 Too Many Requests

原因：请求太频繁。

解法：官方 Free API 每天发帖限额 50 条；twitterapi.io 也有频率限制。把你的脚本轮询间隔调大一点（比如 60s 或 3-5 分钟查一次）。

补充：监控搬运模式下，如果读接口被 429 限流，系统会把任务留在队列里延迟重试（不会降级成“只发文本不带图”）。

补充 2：如果写接口（官方 X API）返回 429，系统会暂停处理队列直到下次重试时间，避免把队列里所有任务都打到 429；等限流解除会自动继续处理。
