// MES-MoralScore production bootstrap: config -> SQLite -> migrations -> HTTP.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.mjs";
import { migrateDatabase } from "./migrations.mjs";
import { createApp } from "./app.mjs";
import { APP_VERSION, VERSION_LABEL } from "./version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadConfig(process.env, root);
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, "evidence"), { recursive: true });

const dbPath = path.join(config.dataDir, "moral-score.sqlite");
const db = new DatabaseSync(dbPath);
const busyTimeout = Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 1500);
if (!Number.isSafeInteger(busyTimeout) || busyTimeout < 0 || busyTimeout > 10000)
  throw new Error("SQLITE_BUSY_TIMEOUT_MS 必须为 0–10000 的整数");
db.exec(`PRAGMA busy_timeout=${busyTimeout}`);
migrateDatabase(db);

const { app } = createApp({
  db,
  config,
  staticDir: path.join(root, "dist"),
});

const server = app.listen(config.port, config.host);

server.once("listening", () => {
  const shown = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  console.log(`MES-MoralScore ${VERSION_LABEL}: http://${shown}:${config.port}`);
  const users = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  if (users === 0)
    console.log(
      "提示：数据库还没有账号。可运行 `npm run seed:demo` 载入演示数据，或 `npm run admin:create -- --account=admin --password=...` 创建管理员。",
    );
});

server.on("error", (error) => {
  console.error(`MES-MoralScore 无法监听 ${config.host}:${config.port}：${error.message}`);
  if (error.code === "EACCES")
    console.error("提示：该端口可能被系统保留或需要管理员权限，请用 PORT 环境变量改用其他端口（例如 PORT=8080）。");
  process.exitCode = 1;
});

function shutdown(signal) {
  console.log(`收到 ${signal}，正在关闭服务…`);
  server.close(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
