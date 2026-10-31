// Shared server helpers: errors, validation, auth/session, data scope, audit,
// settings, CSV and rate limiting. Feature modules receive this context from
// server/app.mjs instead of importing server internals directly.
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

const scryptAsync = promisify(scrypt);

export const ROLES = Object.freeze({
  SYSTEM_ADMIN: "SYSTEM_ADMIN",
  MORAL_AFFAIRS: "MORAL_AFFAIRS",
  DUTY_TEACHER: "DUTY_TEACHER",
});
export const ROLE_LABELS = Object.freeze({
  SYSTEM_ADMIN: "系统管理员",
  MORAL_AFFAIRS: "德育处/政教处",
  DUTY_TEACHER: "值日老师",
});
export const SCHOOL_STAGES = Object.freeze(["小学", "初中", "高中"]);
export const DIRECTIONS = Object.freeze(["ADD", "DEDUCT"]);
export const DIRECTION_LABELS = Object.freeze({ ADD: "加分", DEDUCT: "减分" });

export const uid = () => randomUUID();
export const iso = () => new Date().toISOString();
export const today = () => iso().slice(0, 10);
export const DAY_MS = 86_400_000;

export function httpError(status, message, code = "") {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

export function assert(condition, status, message) {
  if (!condition) throw httpError(status, message);
}

export function publicUser(user) {
  if (!user) return null;
  const {
    password_hash: _hash,
    salt: _salt,
    ...rest
  } = user;
  return rest;
}

export function safeJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function text(value, { name, min = 1, max = 200, required = true, trim = true } = {}) {
  let result = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  if (trim) result = result.trim();
  if (!result) {
    if (!required) return "";
    throw httpError(400, `请填写${name}`);
  }
  if (result.length < min) throw httpError(400, `${name}至少需要 ${min} 个字符`);
  if (result.length > max) throw httpError(400, `${name}不能超过 ${max} 个字符`);
  return result;
}

export function optionalText(value, { name, max = 500 } = {}) {
  return text(value, { name, min: 0, max, required: false });
}

export function integer(value, { name, min = 0, max = Number.MAX_SAFE_INTEGER, fallback, required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    if (!required) return undefined;
    throw httpError(400, `请填写${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw httpError(400, `${name}必须为 ${min} 到 ${max} 之间的整数`);
  return parsed;
}

export function number(value, { name, min = 0, max = Number.MAX_SAFE_INTEGER, fallback, required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    if (!required) return undefined;
    throw httpError(400, `请填写${name}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max)
    throw httpError(400, `${name}必须为 ${min} 到 ${max} 之间的数字`);
  return parsed;
}

export function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) throw httpError(400, `${name}无效`);
  return value;
}

export function isoDateTime(value, name, { required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (!required) return "";
    throw httpError(400, `请填写${name}`);
  }
  const raw = String(value);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw httpError(400, `${name}不是有效时间`);
  return date.toISOString();
}

export function dateOnly(value, name, { required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (!required) return "";
    throw httpError(400, `请填写${name}`);
  }
  const raw = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime()))
    throw httpError(400, `${name}必须为 YYYY-MM-DD 格式`);
  return raw;
}

export function booleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return Boolean(value);
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function parseBody(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue.path.length ? `${issue.path.join(".")}：` : "";
  const error = httpError(400, `${path}${issue.message}`, "VALIDATION_ERROR");
  error.issues = result.error.issues;
  throw error;
}

export function likePattern(value) {
  return `%${String(value).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export function paginate(query = {}, { defaultSize = 20, maxSize = 100 } = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number(query.pageSize) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function pageResult(items, total, { page, pageSize }) {
  return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- passwords
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scryptAsync(password, salt, 64);
  return { hash: key.toString("hex"), salt };
}

export async function verifyPassword(password, hash, salt) {
  if (typeof password !== "string" || typeof hash !== "string" || typeof salt !== "string")
    return false;
  try {
    const expected = Buffer.from(hash, "hex");
    if (expected.length !== 64) return false;
    const actual = await scryptAsync(password, salt, 64);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

const WEAK_PASSWORDS = new Set([
  "1234567890",
  "password",
  "password123",
  "qwertyuiop",
  "admin12345",
  "1111111111",
  "abc1234567",
]);

export function assertPasswordPolicy(password, { account = "", role = "" } = {}) {
  const value = typeof password === "string" ? password : "";
  if (value.length < 10) throw httpError(400, "密码至少需要 10 个字符");
  if (Buffer.byteLength(value, "utf8") > 256) throw httpError(400, "密码过长");
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value))
    throw httpError(400, "密码必须同时包含字母和数字");
  if (account && value.toLowerCase().includes(String(account).toLowerCase()))
    throw httpError(400, "密码不能包含账号名");
  if (WEAK_PASSWORDS.has(value.toLowerCase())) throw httpError(400, "该密码过于常见，请更换");
  if (role && value.toLowerCase() === role.toLowerCase()) throw httpError(400, "密码强度不足");
  return value;
}

// ------------------------------------------------------------------ sessions
export const SESSION_COOKIE = "mse_session";

export function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .filter(Boolean)
      .map((part) => part.trim().split(/=(.*)/s).slice(0, 2)),
  );
}

export function createAuthKit({ db, config }) {
  function readSessionUser(req) {
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (!sid) return null;
    const user = db
      .prepare(
        `SELECT u.*, s.id AS session_id FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > ? AND u.status = 'ACTIVE'`,
      )
      .get(sid, iso());
    return user || null;
  }

  function auth(req, res, next) {
    const user = readSessionUser(req);
    if (!user) return res.status(401).json({ error: "请先登录" });
    req.user = user;
    req.sessionId = user.session_id;
    next();
  }

  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: "请先登录" });
      if (!roles.includes(req.user.role))
        return res.status(403).json({ error: "当前角色无权执行此操作" });
      next();
    };
  }

  const requireAdmin = requireRole(ROLES.SYSTEM_ADMIN);
  const requireMoral = requireRole(ROLES.MORAL_AFFAIRS);
  const requireManagement = requireRole(ROLES.SYSTEM_ADMIN, ROLES.MORAL_AFFAIRS);
  const requireStaff = requireRole(ROLES.SYSTEM_ADMIN, ROLES.MORAL_AFFAIRS, ROLES.DUTY_TEACHER);

  function setSession(res, userId) {
    const sid = randomBytes(32).toString("hex");
    const createdAt = iso();
    const expiresAt = new Date(Date.now() + config.sessionDays * DAY_MS).toISOString();
    db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
      sid,
      userId,
      expiresAt,
      createdAt,
    );
    // 顺带清理过期会话，避免表无限增长（每次登录最多做一次删除）。
    db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(createdAt);
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.sessionDays * 86400}${
        config.cookieSecure ? "; Secure" : ""
      }`,
    );
    return sid;
  }

  function clearSession(res) {
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${
        config.cookieSecure ? "; Secure" : ""
      }`,
    );
  }

  return {
    auth,
    requireRole,
    requireAdmin,
    requireMoral,
    requireManagement,
    requireStaff,
    setSession,
    clearSession,
    readSessionUser,
  };
}

// --------------------------------------------------------------------- scope
// SYSTEM_ADMIN 与 MORAL_AFFAIRS 拥有全校数据范围；值日老师只能访问
// user_scopes 授权的年级/班级，服务端每个读写接口都必须经过这里。
export function createScopeKit({ db }) {
  const allRoles = new Set([ROLES.SYSTEM_ADMIN, ROLES.MORAL_AFFAIRS]);

  function hasFullScope(user) {
    return allRoles.has(user.role);
  }

  function classIdsFor(user) {
    if (hasFullScope(user)) return null;
    const rows = db
      .prepare(
        `SELECT DISTINCT c.id
         FROM classes c
         WHERE c.school_id = ?
           AND (
             c.grade_id IN (SELECT scope_id FROM user_scopes WHERE user_id=? AND scope_type='GRADE')
             OR c.id IN (SELECT scope_id FROM user_scopes WHERE user_id=? AND scope_type='CLASS')
           )`,
      )
      .all(user.school_id, user.id, user.id);
    return rows.map((row) => row.id);
  }

  /** SQL fragment restricting a column to the user's class scope. */
  function classFilter(user, column = "class_id") {
    const ids = classIdsFor(user);
    if (ids === null) return { sql: "1=1", params: [] };
    if (!ids.length) return { sql: "1=0", params: [] };
    return { sql: `${column} IN (${ids.map(() => "?").join(",")})`, params: ids };
  }

  function canAccessClass(user, classId) {
    if (hasFullScope(user)) return true;
    return classIdsFor(user).includes(classId);
  }

  function assertClassAccess(user, classId) {
    if (!canAccessClass(user, classId))
      throw httpError(403, "无权访问该班级的数据");
    return classId;
  }

  function studentById(studentId, schoolId) {
    const student = db
      .prepare(
        `SELECT s.*, c.name AS class_name, g.name AS grade_name
         FROM students s
         JOIN classes c ON c.id = s.class_id
         JOIN grades g ON g.id = s.grade_id
         WHERE s.id = ? AND s.school_id = ?`,
      )
      .get(studentId, schoolId);
    if (!student) throw httpError(404, "学生不存在");
    return student;
  }

  function assertStudentAccess(user, studentId) {
    const student = studentById(studentId, user.school_id);
    assertClassAccess(user, student.class_id);
    return student;
  }

  function scopedStudents(user, { classId = "", gradeId = "", search = "" } = {}) {
    const clauses = ["s.school_id = ?", "s.status = 'ACTIVE'"];
    const params = [user.school_id];
    if (classId) {
      assertClassAccess(user, classId);
      clauses.push("s.class_id = ?");
      params.push(classId);
    } else {
      const filter = classFilter(user, "s.class_id");
      clauses.push(`(${filter.sql})`);
      params.push(...filter.params);
    }
    if (gradeId) {
      clauses.push("s.grade_id = ?");
      params.push(gradeId);
    }
    if (search) {
      clauses.push("(s.name LIKE ? ESCAPE '\\' OR s.student_no LIKE ? ESCAPE '\\')");
      const pattern = likePattern(search);
      params.push(pattern, pattern);
    }
    return { where: clauses.join(" AND "), params };
  }

  return {
    hasFullScope,
    classIdsFor,
    classFilter,
    canAccessClass,
    assertClassAccess,
    studentById,
    assertStudentAccess,
    scopedStudents,
  };
}

// --------------------------------------------------------------------- audit
export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded && typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

export function createAuditKit({ db, config }) {
  return {
    record({
      req = null,
      user = null,
      schoolId = null,
      action,
      targetType = "",
      targetId = "",
      summary = "",
      before = null,
      after = null,
      result = "SUCCESS",
    }) {
      db.prepare(
        `INSERT INTO audit_logs(id,school_id,actor_id,actor_account,actor_role,action,target_type,target_id,summary,before_json,after_json,ip,user_agent,result,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        uid(),
        schoolId ?? user?.school_id ?? null,
        user?.id ?? null,
        user?.account ?? "",
        user?.role ?? "",
        action,
        targetType,
        targetId,
        summary,
        before == null ? null : JSON.stringify(before),
        after == null ? null : JSON.stringify(after),
        req ? clientIp(req) : "",
        req ? String(req.headers["user-agent"] || "").slice(0, 300) : "",
        result,
        iso(),
      );
    },
  };
}

// ------------------------------------------------------------------ settings
export const SETTING_DEFAULTS = Object.freeze({
  initial_points: "100",
  allow_negative: "0",
  review_threshold: "10",
});

export function createSettingsKit({ db }) {
  function get(schoolId) {
    const rows = db.prepare("SELECT key,value FROM system_settings WHERE school_id=?").all(schoolId);
    const map = { ...SETTING_DEFAULTS };
    for (const row of rows) map[row.key] = row.value;
    return {
      initialPoints: Math.max(0, Number(map.initial_points) || 0),
      allowNegative: map.allow_negative === "1",
      reviewThreshold: Math.max(1, Number(map.review_threshold) || 10),
      raw: map,
    };
  }

  function set(schoolId, values) {
    const timestamp = iso();
    const statement = db.prepare(
      `INSERT INTO system_settings(school_id,key,value,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(school_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    );
    for (const [key, value] of Object.entries(values)) statement.run(schoolId, key, String(value), timestamp);
    return get(schoolId);
  }

  return { get, set };
}

// ---------------------------------------------------------------------- CSV
/** RFC4180-ish CSV parser with BOM handling; returns array of string arrays. */
export function parseCsv(input) {
  const textValue = String(input ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < textValue.length; index += 1) {
    const char = textValue[index];
    if (quoted) {
      if (char === '"') {
        if (textValue[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char === "\r") {
      // 忽略 CR，兼容 CRLF
    } else field += char;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function csvCell(value) {
  const raw = value === null || value === undefined ? "" : String(value);
  // 防止 CSV 公式注入：以 = + - @ 开头的文本前置单引号。
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function buildCsv(header, rows) {
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function sendCsv(res, filename, header, rows) {
  const body = buildCsv(header, rows);
  const safeName = String(filename || "export.csv").replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
  // HTTP 头只能是 latin1：中文文件名只能放在 RFC 5987 的 filename* 里，
  // 同时给旧客户端一个 ASCII fallback。
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, "_") || "export.csv";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
  );
  res.send(body);
}

// ----------------------------------------------------------- rate limiting
export function createRateLimiter({ now = () => Date.now() } = {}) {
  const buckets = new Map();
  function sweep() {
    const current = now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= current) buckets.delete(key);
  }
  return {
    hit(key, { limit, windowMs }) {
      sweep();
      const current = now();
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= current) {
        bucket = { count: 0, resetAt: current + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      if (bucket.count > limit)
        return { allowed: false, retryAfterMs: Math.max(0, bucket.resetAt - current) };
      return { allowed: true, retryAfterMs: 0 };
    },
    reset(key) {
      buckets.delete(key);
    },
    clear() {
      buckets.clear();
    },
  };
}

// 同源写入校验：跨站表单/脚本即使拿到 Cookie 也无法提交改写请求。
export function sameOriginWrites(config) {
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    let expected = "";
    try {
      expected = new URL(origin).host;
    } catch {
      return res.status(403).json({ error: "请求来源无效" });
    }
    const host = req.headers.host || "";
    let configuredHost = "";
    if (config.appOrigin) {
      try {
        configuredHost = new URL(config.appOrigin).host;
      } catch {
        configuredHost = "";
      }
    }
    if (expected !== host && expected !== configuredHost)
      return res.status(403).json({ error: "跨站请求已被拒绝" });
    next();
  };
}

export function securityHeaders(config) {
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (config.production && config.cookieSecure)
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}

// 文件名净化（仅保留安全字符，禁止路径穿越）。
export function safeFilename(name) {
  const base = String(name || "file").split(/[\\/]/).pop() || "file";
  return base.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(0, 120);
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function validIdList(value, { max = 500 } = {}) {
  if (!Array.isArray(value) || value.length === 0) throw httpError(400, "请选择至少一名学生");
  if (value.length > max) throw httpError(400, `单次最多处理 ${max} 条`);
  const ids = [...new Set(value.map((item) => String(item)))];
  if (ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw httpError(400, "学生 ID 格式无效");
  return ids;
}
