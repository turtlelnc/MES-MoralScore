// Express application factory. Kept side-effect free (no listen, no env reads)
// so tests can build an isolated app on a temporary database.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import * as core from "./core.mjs";
import { APP_VERSION, BUILD_NUMBER, VERSION_LABEL } from "./version.mjs";
import { registerAuthRoutes } from "./auth.mjs";
import { registerRosterRoutes } from "./roster.mjs";
import { registerRulesRoutes } from "./rules.mjs";
import { registerScoringRoutes } from "./scoring.mjs";
import { registerSubmissionRoutes } from "./submissions.mjs";
import { registerAppealRoutes } from "./appeals.mjs";
import { registerAnalyticsRoutes } from "./analytics.mjs";
import { registerReportRoutes } from "./reports.mjs";
import { registerShareRoutes } from "./share.mjs";
import { registerAdminRoutes } from "./admin.mjs";
import { registerImportRoutes } from "./imports.mjs";
import { registerEvidenceRoutes } from "./evidence.mjs";

export function buildContext({ db, config }) {
  const authKit = core.createAuthKit({ db, config });
  const scope = core.createScopeKit({ db });
  const audit = core.createAuditKit({ db, config });
  const settings = core.createSettingsKit({ db });
  return {
    ...core,
    db,
    config,
    ...authKit,
    scope,
    audit,
    settings,
    version: { APP_VERSION, BUILD_NUMBER, VERSION_LABEL },
  };
}

export function createApp({ db, config, staticDir = null }) {
  const ctx = buildContext({ db, config });
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxyHops > 0) app.set("trust proxy", config.trustProxyHops);
  app.use(core.securityHeaders(config));
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", core.sameOriginWrites(config));
  app.use("/api", (req, _res, next) => {
    req.requestStartedAt = Date.now();
    next();
  });

  registerAuthRoutes(app, ctx);
  registerRosterRoutes(app, ctx);
  registerRulesRoutes(app, ctx);
  registerScoringRoutes(app, ctx);
  registerSubmissionRoutes(app, ctx);
  registerAppealRoutes(app, ctx);
  registerAnalyticsRoutes(app, ctx);
  registerReportRoutes(app, ctx);
  registerShareRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerImportRoutes(app, ctx);
  registerEvidenceRoutes(app, ctx);

  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }));

  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, maxAge: "1h" }));
    app.get("/{*path}", (_req, res) => res.sendFile(path.join(staticDir, "index.html")));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (res.headersSent || res.destroyed) return;
    const databaseBusy =
      error.errcode === 5 ||
      error.errcode === 6 ||
      error.code === "SQLITE_BUSY" ||
      error.code === "SQLITE_LOCKED";
    let status = error.status || 500;
    let message = error.message || "请求失败";
    if (databaseBusy) {
      status = 503;
      message = "数据库繁忙，请稍后重试";
    } else if (error.code === "LIMIT_FILE_SIZE") {
      status = 413;
      message = "文件超过大小上限";
    } else if (error.code === "ENOSPC") {
      status = 507;
      message = "服务器存储空间不足，请联系管理员";
    } else if (status >= 500) {
      console.error(`[api] ${req.method} ${req.originalUrl} failed:`, error);
      message = "服务内部错误，请稍后重试";
    }
    if ([429, 503, 507].includes(status)) res.setHeader("Retry-After", "5");
    if (status === 400 && error.issues) {
      return res.status(400).json({ error: message, issues: error.issues });
    }
    res.status(status).json({ error: message });
  });

  return { app, ctx };
}
