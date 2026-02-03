// @ts-check

/**
 * 说明：
 * - 本项目主要是本地 UI 面板（bulk.html）+ 后端接口（server.js）
 * - E2E 目标：验证页面能打开、关键控件存在、关键接口可用（不做真实登录/真实关注）
 */

const { defineConfig } = require("@playwright/test");

const PORT = Number(process.env.E2E_PORT || 3015);

module.exports = defineConfig({
  testDir: "tests",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // 使用本机已安装 Chrome，避免下载 Playwright 浏览器包
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: "node server.js",
    port: PORT,
    reuseExistingServer: true,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
    },
  },
});

