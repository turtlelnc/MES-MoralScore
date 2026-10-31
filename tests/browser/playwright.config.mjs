// Playwright 配置：真实浏览器 + 隔离 fixture 服务（临时数据库 + 演示数据）。
// 本机 8787 端口被系统保留，fixture 固定使用 18877。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const port = Number(process.env.PW_FIXTURE_PORT || 18877);

// Windows 上 Playwright 结束 webServer 依赖 taskkill：若当前 PATH 缺少 System32，
// 测试跑完后 fixture 服务无法被终止，整个命令会一直挂起。这里在配置加载时补齐 PATH。
if (process.platform === "win32") {
  const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const entries = (process.env.PATH || "").split(path.delimiter);
  const hasSystem32 = entries.some(
    (entry) => path.resolve(entry || ".").toLowerCase() === system32.toLowerCase(),
  );
  if (!hasSystem32) {
    process.env.PATH = `${system32}${path.delimiter}${process.env.PATH || ""}`;
  }
}
const baseURL = `http://127.0.0.1:${port}`;
// 未下载 Playwright Chromium 时可用系统 Chrome：
//   $env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.pw.mjs",
  timeout: 30000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: path.join(root, "playwright-report") }]]
    : [["list"]],
  use: {
    baseURL,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 10000,
    navigationTimeout: 20000,
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
  ],
  webServer: {
    command: "node tests/browser/server.mjs",
    cwd: root,
    url: `${baseURL}/api/health`,
    timeout: 180000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PW_FIXTURE_PORT: String(port),
    },
  },
});
