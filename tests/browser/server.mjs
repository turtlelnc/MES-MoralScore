// Playwright 专用隔离 fixture 服务：临时 DATA_DIR + 迁移 schema + 播演示数据，
// 同时提供真实 /api 与项目构建产物 dist（SPA 回退到 index.html）。
// 由 playwright.config.mjs 的 webServer 启动，监听 127.0.0.1:18877。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../../server/migrations.mjs";
import { createApp } from "../../server/app.mjs";
import { seedFixtures } from "../../server/fixtures.mjs";
import { testConfig } from "../../server/test-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const staticDir = path.join(root, "dist");
const host = "127.0.0.1";
const port = Number(process.env.PW_FIXTURE_PORT || 18877);

function fail(message) {
  console.error(`[fixture] ${message}`);
  process.exit(1);
}

// dist 是浏览器测试的前端产物；缺失时先构建（不修改业务源码）。
function ensureDist() {
  if (fs.existsSync(path.join(staticDir, "index.html"))) return;
  console.log("[fixture] 未找到 dist/index.html，先执行 npm run build …");
  const result = spawnSync("npm run build", {
    cwd: root,
    shell: true,
    stdio: "inherit",
  });
  if (result.status !== 0 || !fs.existsSync(path.join(staticDir, "index.html"))) {
    throw new Error("npm run build 失败，无法启动浏览器测试服务");
  }
}

ensureDist();

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mes-moral-browser-"));
const dataDir = path.join(tempDir, "data");
const backupDir = path.join(tempDir, "backups");
fs.mkdirSync(path.join(dataDir, "evidence"), { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });

const config = { ...testConfig({ dataDir, backupDir }), host, port };
const db = new DatabaseSync(path.join(dataDir, "moral-score.sqlite"));
db.exec("PRAGMA busy_timeout=5000");
migrateDatabase(db);
const fixtures = seedFixtures(db);

const { app } = createApp({ db, config, staticDir });
const server = app.listen(port, host);

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  server.close(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows 上 WAL 文件可能短暂被占用，临时目录清理尽力而为。
    }
    process.exit(code);
  });
  // 兜底：5 秒内仍未关闭则直接退出。
  setTimeout(() => process.exit(code), 5000).unref();
}

server.once("error", (error) => {
  if (error.code === "EADDRINUSE") {
    fail(`端口 ${port} 已被占用（请先结束旧的 fixture 进程）`);
  }
  fail(`启动失败：${error.message}`);
});

server.once("listening", () => {
  console.log(
    `[fixture] http://${host}:${port} 已启动 | 学校=${fixtures.school.name} | 学生=${fixtures.students.length} | 临时库=${dataDir}`,
  );
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGBREAK", () => shutdown(0));
