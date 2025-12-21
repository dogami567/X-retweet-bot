# X-retweet-bot

本项目是一个本地运行的「监控 + 搬运发布」工具：

- 监控（读）：用 `twitterapi.io` 拉取目标账号最新推文
- 搬运（写）：用 X 官方 API（`twitter-api-v2`）把文本 + 图片发到你的账号（支持本地 Clash 代理）

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
