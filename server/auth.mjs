// 登录、登出、会话信息与自助改密。账号由管理员创建；不开放公开自助注册，
// 避免未成年人数据系统出现不可控账号。
import { z } from "zod";
import {
  ROLE_LABELS,
  ROLES,
  assertPasswordPolicy,
  clientIp,
  createRateLimiter,
  hashPassword,
  httpError,
  iso,
  parseBody,
  publicUser,
  uid,
  verifyPassword,
} from "./core.mjs";

const loginSchema = z.object({
  account: z.string().trim().min(1, "请填写账号"),
  password: z.string().min(1, "请填写密码"),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "请填写当前密码"),
  newPassword: z.string().min(1, "请填写新密码"),
});

const DEMO_PASSWORDS = new Set(["demo123456", "password123", "admin12345"]);

export function permissionsFor(role) {
  const admin = role === ROLES.SYSTEM_ADMIN;
  const moral = role === ROLES.MORAL_AFFAIRS;
  const teacher = role === ROLES.DUTY_TEACHER;
  return {
    manageSchool: admin,
    manageUsers: admin,
    manageRoster: admin,
    manageImports: admin,
    manageBackups: admin,
    viewAudit: admin,
    createRules: admin || moral,
    approveRules: moral,
    score: admin || moral || teacher,
    reviewRecords: admin || moral,
    manageSubmissions: admin || moral || teacher,
    registerAppeals: admin || moral || teacher,
    decideAppeals: moral,
    revokeRecords: admin || moral,
    manageShares: admin || moral,
    viewAnalytics: true,
    exportData: true,
    manageSystem: admin,
  };
}

export function registerAuthRoutes(app, ctx) {
  const { db, config, auth, setSession, clearSession, audit } = ctx;
  const loginLimiter = createRateLimiter();

  function sessionPayload(user) {
    const school = db.prepare("SELECT id,name,code,stage FROM schools WHERE id=?").get(user.school_id);
    const scopes = db
      .prepare(
        `SELECT us.scope_type, us.scope_id,
           CASE us.scope_type
             WHEN 'GRADE' THEN (SELECT name FROM grades WHERE id=us.scope_id)
             ELSE (SELECT c.name || ' · ' || g.name FROM classes c JOIN grades g ON g.id=c.grade_id WHERE c.id=us.scope_id)
           END AS name
         FROM user_scopes us WHERE us.user_id=? ORDER BY us.scope_type, name`,
      )
      .all(user.id);
    const term = db
      .prepare(
        `SELECT t.id, t.name, t.start_date, t.end_date, y.name AS academic_year_name
         FROM terms t JOIN academic_years y ON y.id=t.academic_year_id
         WHERE t.school_id=? AND t.is_current=1`,
      )
      .get(user.school_id);
    return {
      ...publicUser(user),
      displayName: user.display_name,
      display_name: undefined,
      roleLabel: ROLE_LABELS[user.role] || user.role,
      schoolName: school?.name || "",
      schoolCode: school?.code || "",
      schoolStage: school?.stage || "",
      scopes,
      permissions: permissionsFor(user.role),
      mustChangePassword: Boolean(user.must_change_password),
      currentTerm: term
        ? {
            id: term.id,
            name: term.name,
            academicYearName: term.academic_year_name,
            startDate: term.start_date,
            endDate: term.end_date,
          }
        : null,
    };
  }

  app.post("/api/auth/login", async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const account = body.account;
    const limiterKey = `login:${clientIp(req)}:${account.toLowerCase()}`;
    const allowed = loginLimiter.hit(limiterKey, {
      limit: config.loginMaxFailures,
      windowMs: config.loginWindowSeconds * 1000,
    });
    if (!allowed.allowed) {
      res.setHeader("Retry-After", String(Math.ceil(allowed.retryAfterMs / 1000)));
      return res.status(429).json({ error: "登录尝试过于频繁，请稍后再试" });
    }
    const user = db.prepare("SELECT * FROM users WHERE account=? COLLATE NOCASE").get(account);
    const verified =
      user &&
      (await verifyPassword(body.password, user.password_hash, user.salt).catch(() => false));
    if (!verified) {
      audit.record({
        req,
        action: "LOGIN_FAILURE",
        targetType: "USER",
        summary: `登录失败：${account}`,
        result: "FAILURE",
      });
      return res.status(401).json({ error: "账号或密码错误" });
    }
    if (user.status !== "ACTIVE")
      return res.status(403).json({ error: "该账号已被停用，请联系系统管理员" });
    loginLimiter.reset(limiterKey);
    db.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(iso(), user.id);
    setSession(res, user.id);
    audit.record({
      req,
      user: verified,
      action: "LOGIN",
      targetType: "USER",
      targetId: user.id,
      summary: "登录成功",
    });
    res.json({ user: sessionPayload(user) });
  });

  app.post("/api/auth/logout", auth, (req, res) => {
    db.prepare("DELETE FROM sessions WHERE id=?").run(req.sessionId);
    clearSession(res);
    audit.record({
      req,
      user: req.user,
      action: "LOGOUT",
      targetType: "USER",
      targetId: req.user.id,
      summary: "退出登录",
    });
    res.json({ ok: true });
  });

  app.get("/api/me", auth, (req, res) => {
    const fresh = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    if (!fresh || fresh.status !== "ACTIVE")
      return res.status(401).json({ error: "会话已失效，请重新登录" });
    res.json({ user: sessionPayload(fresh) });
  });

  app.post("/api/auth/password", auth, async (req, res) => {
    const body = parseBody(passwordSchema, req.body);
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    if (!(await verifyPassword(body.currentPassword, user.password_hash, user.salt)))
      return res.status(400).json({ error: "当前密码不正确" });
    const next = body.newPassword;
    assertPasswordPolicy(next, { account: user.account, role: user.role });
    if (DEMO_PASSWORDS.has(next.toLowerCase()))
      return res.status(400).json({ error: "演示密码不可用于正式账号，请更换" });
    const { hash, salt } = await hashPassword(next);
    db.prepare(
      "UPDATE users SET password_hash=?, salt=?, must_change_password=0 WHERE id=?",
    ).run(hash, salt, user.id);
    // 改密后吊销其他会话，只保留当前会话。
    db.prepare("DELETE FROM sessions WHERE user_id=? AND id<>?").run(user.id, req.sessionId);
    audit.record({
      req,
      user: req.user,
      action: "PASSWORD_CHANGE",
      targetType: "USER",
      targetId: user.id,
      summary: "修改密码并吊销其他会话",
    });
    res.json({ ok: true });
  });

  app.get("/api/capabilities", (_req, res) => {
    res.json({
      stages: ["小学", "初中", "高中"],
      publicRegistration: false,
      studentAccounts: false,
    });
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      version: ctx.version.APP_VERSION,
      build: ctx.version.BUILD_NUMBER,
      versionLabel: ctx.version.VERSION_LABEL,
      storage: "SQLite + local filesystem",
      time: iso(),
    });
  });
}
