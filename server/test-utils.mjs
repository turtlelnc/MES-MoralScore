// Isolated test harness: temporary SQLite database, migrated schema, seeded
// demo fixture, real Express app on an ephemeral port, cookie-aware helpers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./migrations.mjs";
import { createApp } from "./app.mjs";
import { seedFixtures, DEMO_ACCOUNTS } from "./fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function testConfig({ dataDir, backupDir }) {
  return {
    root,
    nodeEnv: "test",
    production: false,
    port: 0,
    host: "127.0.0.1",
    dataDir,
    backupDir,
    backupKeepRecent: 5,
    appSecret: "test-only-secret-0123456789abcdef0123456789abcdef",
    appOrigin: "",
    trustProxyHops: 0,
    sessionDays: 7,
    loginMaxFailures: 1000,
    loginWindowSeconds: 60,
    evidenceMaxMb: 5,
    cookieSecure: false,
    allowPublicRegistration: false,
  };
}

/**
 * createTestServer({seed=true}) → {
 *   baseUrl, db, ctx, config, dir, fixtures,
 *   request(path, {method, body, cookie, headers, formData, raw}) → {status, body, headers, text},
 *   login(accountOrKey, password?) → {cookie, user},
 *   loginAs(key) → cookie,
 *   close() → Promise,
 * }
 */
export async function createTestServer({ seed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mes-moral-test-"));
  const dataDir = path.join(dir, "data");
  const backupDir = path.join(dir, "backups");
  fs.mkdirSync(path.join(dataDir, "evidence"), { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  const config = testConfig({ dataDir, backupDir });
  const db = new DatabaseSync(path.join(dataDir, "moral-score.sqlite"));
  db.exec("PRAGMA busy_timeout=1000");
  migrateDatabase(db);
  const fixtures = seed ? seedFixtures(db) : null;
  const { app, ctx } = createApp({ db, config });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(
    requestPath,
    { method = "GET", body, cookie, headers = {}, formData, raw = false } = {},
  ) {
    const options = { method, headers: { ...headers } };
    if (cookie) options.headers.cookie = cookie;
    if (formData) {
      options.body = formData;
    } else if (body !== undefined) {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}${requestPath}`, options);
    if (raw) return response;
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    let parsed = text;
    if (contentType.includes("application/json")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: "invalid json", raw: text };
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      body: parsed,
      setCookies: response.headers.getSetCookie ? response.headers.getSetCookie() : [],
    };
  }

  async function login(accountOrKey, password) {
    const definition =
      DEMO_ACCOUNTS[accountOrKey] ||
      Object.values(DEMO_ACCOUNTS).find((item) => item.account === accountOrKey);
    const account = definition?.account || accountOrKey;
    const secret = password || definition?.password;
    if (!secret) throw new Error(`缺少登录密码：${account}`);
    const response = await request("/api/auth/login", {
      method: "POST",
      body: { account, password: secret },
    });
    if (response.status !== 200)
      throw new Error(`登录失败（${response.status}）：${response.body?.error || ""}`);
    const setCookie = response.setCookies.find((value) => value.startsWith("mse_session="));
    const cookie = setCookie.split(";")[0];
    return { cookie, user: response.body.user, response };
  }

  async function loginAs(key) {
    return (await login(key)).cookie;
  }

  return {
    baseUrl,
    db,
    ctx,
    config,
    dir,
    fixtures,
    request,
    login,
    loginAs,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          try {
            db.close();
          } catch {
            // already closed
          }
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            // Windows may briefly lock WAL files; temp dir cleanup is best-effort.
          }
          resolve();
        });
      }),
  };
}

export { DEMO_ACCOUNTS };
