// Environment configuration with explicit startup failures for production.
import path from "node:path";

const TRUE = new Set(["1", "true", "yes", "on"]);

function integer(value, { name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER }) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} 必须为 ${min}–${max} 的整数`);
  return parsed;
}

export function loadConfig(env = process.env, root = process.cwd()) {
  const nodeEnv = env.NODE_ENV || "development";
  const production = nodeEnv === "production";
  const appSecret = env.APP_SECRET || "";
  if (production) {
    if (!appSecret || appSecret.length < 32 || appSecret.includes("请替换"))
      throw new Error("生产环境必须配置至少 32 位随机 APP_SECRET");
  }
  const dataDir = path.resolve(root, env.DATA_DIR || path.join(root, "data"));
  return {
    root,
    nodeEnv,
    production,
    port: integer(env.PORT, { name: "PORT", fallback: 8080, min: 1, max: 65535 }),
    host: env.HOST || "127.0.0.1",
    dataDir,
    backupDir: env.BACKUP_DIR ? path.resolve(root, env.BACKUP_DIR) : "",
    backupKeepRecent: integer(env.BACKUP_KEEP_RECENT, {
      name: "BACKUP_KEEP_RECENT",
      fallback: 24,
      min: 1,
      max: 500,
    }),
    appSecret: appSecret || "development-only-change-me-not-for-production",
    appOrigin: (env.APP_ORIGIN || "").replace(/\/+$/, ""),
    trustProxyHops: integer(env.TRUST_PROXY_HOPS, {
      name: "TRUST_PROXY_HOPS",
      fallback: 0,
      min: 0,
      max: 10,
    }),
    sessionDays: integer(env.SESSION_DAYS, { name: "SESSION_DAYS", fallback: 7, min: 1, max: 90 }),
    loginMaxFailures: integer(env.LOGIN_MAX_FAILURES, {
      name: "LOGIN_MAX_FAILURES",
      fallback: 8,
      min: 3,
      max: 100,
    }),
    loginWindowSeconds: integer(env.LOGIN_WINDOW_SECONDS, {
      name: "LOGIN_WINDOW_SECONDS",
      fallback: 600,
      min: 60,
      max: 86400,
    }),
    evidenceMaxMb: integer(env.EVIDENCE_MAX_MB, {
      name: "EVIDENCE_MAX_MB",
      fallback: 8,
      min: 1,
      max: 50,
    }),
    cookieSecure: TRUE.has(String(env.COOKIE_SECURE || (production ? "1" : "0"))),
    allowPublicRegistration: TRUE.has(String(env.ALLOW_PUBLIC_REGISTRATION || "0")),
  };
}
