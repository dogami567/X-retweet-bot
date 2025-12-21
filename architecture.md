# TwitterAPI.io 监控与转发系统架构设计文档

## 1. 项目概述

**目标**：构建一个轻量级的网页端测试与监控系统，用于验证 TwitterAPI.io 的功能，并实现监控指定 X/Twitter 账号（个位数），一旦发布新原推（Original Tweet），自动获取内容并通过第三方 API 转发到指定账号。

**核心功能**：
*   **API 测试面板**：提供网页界面，方便手动测试 TwitterAPI.io 的核心接口（获取用户推文、发推）。
*   **自动化监控**：后台轮询机制，监控目标账号动态。
*   **智能过滤**：精准区分原推、转推（Retweet）和回复（Reply）。
*   **自动转发**：捕获新推文并自动发布。
*   **日志与反馈**：在网页端实时显示运行日志和 API 响应结果，便于排查问题。

---

## 2. 技术栈架构

为满足“网页端测试”和“方便查看情况”的需求，推荐使用 **Node.js 全栈** 方案，部署简单且响应迅速。

*   **前端 (UI)**: HTML5 + Bootstrap (或 Tailwind CSS) + JavaScript (Vanilla/jQuery)。
    *   *理由*：轻量级，无需复杂构建工具，直接在浏览器展示 API 返回的 JSON 和日志。
*   **后端 (Server)**: Node.js + Express。
    *   *理由*：处理 HTTP 请求，执行定时任务 (Cron/setInterval)，作为中转服务器调用 TwitterAPI.io（保护 API Key 不暴露在前端）。
*   **数据存储 (Temp)**: 本地 JSON 文件 (如 `monitor_db.json`) 或内存。
    *   *理由*：记录上次抓取的 `tweet_id`，用于去重。对于小规模（个位数账号）监控，无需重型数据库。

---

## 3. 系统模块设计

### 3.1 用户界面 (Web Dashboard)

界面应包含三个主要区域：

1.  **配置区 (Configuration)**
    *   **TwitterAPI Key 输入框**：允许用户动态输入/保存 API Key。
    *   **目标账号设置**：输入要监控的 `screen_name` (例如 @elonmusk)。
    *   **转发账号设置**：(如果 API 需要) 输入发推所需的 Token/Cookie。

2.  **手动测试实验室 (Test Lab)**
    *   **"获取最新推文" 按钮**：点击后调用后端，展示目标用户的最新 5 条推文原始 JSON。
    *   **"模拟发推" 按钮**：输入一段文本，测试发推接口是否通畅。
    *   **"过滤器测试"**：展示最近抓取的推文，并标记哪条是原推，哪条是转推，验证逻辑是否正确。

3.  **运行控制台 (Live Console)**
    *   **状态开关**：[开始监控] / [停止监控]。
    *   **实时日志窗口**：滚动显示系统操作，例如：
        *   `[10:00:01] 正在轮询 @user...`
        *   `[10:00:02] 发现新推文 ID: 123456...`
        *   `[10:00:02] 判定为转推，跳过。`
        *   `[10:00:05] 转发成功！响应: {...}`

### 3.2 后端逻辑 (Backend Services)

#### A. 代理服务 (API Proxy)
由于跨域问题 (CORS) 和安全性，前端不应直接访问 TwitterAPI.io。
*   `GET /api/tweets?user=xxx`: 后端请求 TwitterAPI 获取数据，返回给前端。
*   `POST /api/tweet`: 后端接收文本，调用 TwitterAPI 发推。

#### B. 轮询引擎 (Polling Engine)
*   **频率**：可配置，建议 60秒/次。
*   **去重逻辑**：
    *   读取 `db.json` 中该用户的 `last_seen_id`。
    *   获取 API 返回的推文列表。
    *   遍历列表：`if (tweet.id > last_seen_id)` -> **新推文**。
    *   更新 `last_seen_id` 为最新的 ID。

#### C. 过滤器 (Filter Core)
这是最关键的部分，需要根据 TwitterAPI.io 返回的实际 JSON 结构编写。
*   **逻辑伪代码**：
    ```javascript
    function isOriginalTweet(tweet) {
        if (tweet.is_retweet) return false; // 显式字段
        if (tweet.text.startsWith("RT @")) return false; // 文本特征
        if (tweet.in_reply_to_status_id) return false; // 是回复
        if (tweet.in_reply_to_user_id) return false; // 是回复
        return true;
    }
    ```

---

## 4. 接口定义 (Internal API)

为了让前端和后端解耦，定义以下简单的内部接口：

| 方法 | 路径 | 参数 | 描述 |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/config` | `{ apiKey, targetUser }` | 保存配置信息 |
| `GET` | `/api/test-fetch` | `{ username }` | 手动触发一次抓取测试，返回原始 JSON |
| `POST` | `/api/test-post` | `{ text }` | 手动触发一次发推测试 |
| `POST` | `/api/monitor/start` | - | 启动自动监控任务 |
| `POST` | `/api/monitor/stop` | - | 停止监控任务 |
| `GET` | `/api/logs` | - | 获取最新的运行日志 |

---

## 5. 实施步骤 (Task List for AI)

请将此部分复制给执行 AI：

1.  **环境搭建**:
    *   初始化 Node.js 项目 (`npm init -y`)。
    *   安装依赖: `express`, `axios` (用于请求 API), `body-parser`, `cors`。

2.  **后端开发 (`server.js`)**:
    *   搭建 Express 服务器，端口 3000。
    *   实现上述 **4. 接口定义** 中的所有路由。
    *   实现 **轮询逻辑**：使用 `setInterval`，每隔一定时间调用 Fetch 逻辑。
    *   实现 **过滤逻辑**：编写函数区分原推和转推。
    *   实现 **内存日志**：创建一个数组存放最近 50 条日志，供前端轮询获取。

3.  **前端开发 (`public/index.html`)**:
    *   编写一个单页应用。
    *   包含配置表单。
    *   包含两个面板：左侧显示 API 原始响应 (JSON Pretty Print)，右侧显示实时日志。
    *   使用 JavaScript (`fetch`) 调用后端接口并更新 UI。

4.  **调试与验证**:
    *   先手动点击“测试抓取”，观察 TwitterAPI.io 返回的真实数据结构。
    *   根据真实数据调整 `server.js` 中的过滤逻辑。
    *   开启自动监控，观察日志输出。

---

## 6. 关键注意点

*   **API 额度保护**：在测试阶段，请务必在前端显示“剩余额度”或“调用次数”，避免死循环耗尽免费额度。
*   **错误处理**：API 可能会超时或返回 429 (Too Many Requests)，代码必须包含 `try-catch` 块，并在日志中显示错误信息，而不是直接崩溃。
*   **数据结构差异**：不同的第三方 Twitter API 返回的 JSON 字段名可能不同（例如 `full_text` vs `text`）。**必须**先通过“测试抓取”功能拿到真实 JSON 样本，再编写过滤代码。
