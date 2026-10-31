// 系统管理（backend-data）：账号与数据范围、系统参数、荣誉/兑换配置、
// 审计日志与真实备份任务。仅 SYSTEM_ADMIN 可访问；所有敏感操作写审计日志，
// 响应与日志中绝不出现密码哈希、盐或分享 token 原文。
import { z } from "zod";
import {
  ROLE_LABELS,
  ROLES,
  assertPasswordPolicy,
  httpError,
  iso,
  uid,
} from "./core.mjs";
import { backupConfigured, backupDirOf, listBackupJobs, runBackup } from "./backup.mjs";

const str = (value) => (Array.isArray(value) ? value[0] : value);
function q(req, name) {
  const raw = str(req.query?.[name]);
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

const nonEmptyUpdate = (schema, message = "没有需要更新的字段") =>
  schema.refine((value) => Object.values(value).some((item) => item !== undefined), { message });

const roleField = z
  .string({ required_error: "请选择角色" })
  .trim()
  .refine((value) => Object.values(ROLES).includes(value), {
    message: "角色必须为 SYSTEM_ADMIN/MORAL_AFFAIRS/DUTY_TEACHER",
  });
const statusField = z
  .string()
  .trim()
  .refine((value) => ["ACTIVE", "DISABLED"].includes(value), {
    message: "账号状态必须为 ACTIVE/DISABLED",
  });
const scopeSchema = z.object({
  scopeType: z
    .string({ required_error: "请选择数据范围类型" })
    .trim()
    .refine((value) => ["GRADE", "CLASS"].includes(value), { message: "数据范围类型必须为 GRADE/CLASS" }),
  scopeId: z.string({ required_error: "请选择数据范围" }).trim().min(1, "请选择数据范围"),
});

const createUserSchema = z.object({
  account: z
    .string({ required_error: "请填写账号" })
    .trim()
    .min(3, "账号至少需要 3 个字符")
    .max(40, "账号不能超过 40 个字符")
    .regex(/^[A-Za-z0-9_.-]+$/, "账号只能包含字母、数字、下划线、点或短横线"),
  displayName: z.string({ required_error: "请填写姓名" }).trim().min(1, "请填写姓名").max(50, "姓名不能超过 50 个字符"),
  password: z.string({ required_error: "请填写初始密码" }).min(1, "请填写初始密码"),
  role: roleField,
  teacherId: z.string().trim().optional(),
  scopes: z.array(scopeSchema).max(100, "数据范围条目不能超过 100 条").optional(),
});

const patchUserSchema = nonEmptyUpdate(
  z.object({
    displayName: z.string().trim().min(1, "请填写姓名").max(50, "姓名不能超过 50 个字符").optional(),
    status: statusField.optional(),
    role: roleField.optional(),
    scopes: z.array(scopeSchema).max(100, "数据范围条目不能超过 100 条").optional(),
    // 前端允许把账号关联到教师目录；null/空字符串表示取消关联。
    teacherId: z.union([z.string().trim().min(1), z.null()]).optional(),
  }),
);

const resetPasswordSchema = z.object({
  password: z.string({ required_error: "请填写新密码" }).min(1, "请填写新密码"),
});

const systemPatchSchema = nonEmptyUpdate(
  z.object({
    initialPoints: z.coerce
      .number({ invalid_type_error: "初始分必须为整数" })
      .int("初始分必须为 0-10000 的整数")
      .min(0, "初始分必须为 0-10000 的整数")
      .max(10000, "初始分必须为 0-10000 的整数")
      .optional(),
    allowNegative: z.boolean({ invalid_type_error: "允许负分必须为布尔值" }).optional(),
    reviewThreshold: z.coerce
      .number({ invalid_type_error: "复核阈值必须为整数" })
      .int("复核阈值必须为 1-1000 的整数")
      .min(1, "复核阈值必须为 1-1000 的整数")
      .max(1000, "复核阈值必须为 1-1000 的整数")
      .optional(),
  }),
);

const honorCreateSchema = z.object({
  name: z.string({ required_error: "请填写荣誉名称" }).trim().min(1, "请填写荣誉名称").max(100, "荣誉名称不能超过 100 个字符"),
  description: z.string().trim().max(500, "说明不能超过 500 个字符").optional(),
  minPoints: z.coerce.number().int("最低积分必须为整数").min(0, "最低积分不能为负数").max(10000, "最低积分过大").optional(),
  minPositiveRecords: z.coerce
    .number()
    .int("正向记录数必须为整数")
    .min(0, "正向记录数不能为负数")
    .max(10000, "正向记录数过大")
    .optional(),
  isEnabled: z.boolean({ invalid_type_error: "启用状态必须为布尔值" }).optional(),
  sortOrder: z.coerce.number().int("排序必须为整数").min(0, "排序不能为负数").max(9999, "排序过大").optional(),
});
const honorPatchSchema = nonEmptyUpdate(
  z.object({
    name: z.string().trim().min(1, "请填写荣誉名称").max(100, "荣誉名称不能超过 100 个字符").optional(),
    description: z.string().trim().max(500, "说明不能超过 500 个字符").optional(),
    minPoints: z.coerce.number().int("最低积分必须为整数").min(0, "最低积分不能为负数").max(10000, "最低积分过大").optional(),
    minPositiveRecords: z.coerce
      .number()
      .int("正向记录数必须为整数")
      .min(0, "正向记录数不能为负数")
      .max(10000, "正向记录数过大")
      .optional(),
    isEnabled: z.boolean({ invalid_type_error: "启用状态必须为布尔值" }).optional(),
    sortOrder: z.coerce.number().int("排序必须为整数").min(0, "排序不能为负数").max(9999, "排序过大").optional(),
  }),
);

const rewardCreateSchema = z.object({
  name: z.string({ required_error: "请填写兑换项目名称" }).trim().min(1, "请填写兑换项目名称").max(100, "名称不能超过 100 个字符"),
  description: z.string().trim().max(500, "说明不能超过 500 个字符").optional(),
  pointsCost: z.coerce
    .number({ required_error: "请填写所需积分" })
    .int("所需积分必须为 1-100000 的整数")
    .min(1, "所需积分必须为 1-100000 的整数")
    .max(100000, "所需积分必须为 1-100000 的整数"),
  isEnabled: z.boolean({ invalid_type_error: "启用状态必须为布尔值" }).optional(),
  sortOrder: z.coerce.number().int("排序必须为整数").min(0, "排序不能为负数").max(9999, "排序过大").optional(),
});
const rewardPatchSchema = nonEmptyUpdate(
  z.object({
    name: z.string().trim().min(1, "请填写兑换项目名称").max(100, "名称不能超过 100 个字符").optional(),
    description: z.string().trim().max(500, "说明不能超过 500 个字符").optional(),
    pointsCost: z.coerce.number().int("所需积分必须为 1-100000 的整数").min(1, "所需积分必须为 1-100000 的整数").max(100000, "所需积分必须为 1-100000 的整数").optional(),
    isEnabled: z.boolean({ invalid_type_error: "启用状态必须为布尔值" }).optional(),
    sortOrder: z.coerce.number().int("排序必须为整数").min(0, "排序不能为负数").max(9999, "排序过大").optional(),
  }),
);

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message || ""));
}

function scopesForUsers(db, userIds) {
  if (!userIds.length) return new Map();
  const rows = db
    .prepare(
      `SELECT us.user_id, us.scope_type, us.scope_id,
         CASE us.scope_type
           WHEN 'GRADE' THEN (SELECT name FROM grades WHERE id=us.scope_id)
           ELSE (SELECT c.name || ' · ' || g.name FROM classes c JOIN grades g ON g.id=c.grade_id WHERE c.id=us.scope_id)
         END AS name
       FROM user_scopes us
       WHERE us.user_id IN (${userIds.map(() => "?").join(",")})
       ORDER BY us.scope_type, name`,
    )
    .all(...userIds);
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.user_id)) map.set(row.user_id, []);
    map.get(row.user_id).push({
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      name: row.name || "",
    });
  }
  return map;
}

function userView(row, scopes) {
  return {
    id: row.id,
    account: row.account,
    displayName: row.display_name,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role] || row.role,
    status: row.status,
    teacherId: row.teacher_id || null,
    teacherName: row.teacher_name || "",
    scopes: scopes || [],
    mustChangePassword: row.must_change_password === 1,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

function resolveScopes(db, schoolId, scopes) {
  const unique = [];
  const seen = new Set();
  for (const item of scopes) {
    const key = `${item.scopeType}:${item.scopeId}`;
    if (seen.has(key)) continue;
    if (item.scopeType === "GRADE") {
      const grade = db.prepare("SELECT id FROM grades WHERE id=? AND school_id=?").get(item.scopeId, schoolId);
      if (!grade) throw httpError(400, "数据范围中的年级不存在");
    } else {
      const klass = db.prepare("SELECT id FROM classes WHERE id=? AND school_id=?").get(item.scopeId, schoolId);
      if (!klass) throw httpError(400, "数据范围中的班级不存在");
    }
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function insertUserScopes(db, userId, scopes) {
  const statement = db.prepare(
    "INSERT INTO user_scopes(id,user_id,scope_type,scope_id,created_at) VALUES(?,?,?,?,?)",
  );
  for (const item of scopes) statement.run(uid(), userId, item.scopeType, item.scopeId, iso());
}

function periodsView(db, schoolId) {
  const years = db
    .prepare(
      `SELECT id,name,start_date,end_date,is_current FROM academic_years
       WHERE school_id=? ORDER BY start_date DESC, name DESC`,
    )
    .all(schoolId);
  const terms = db
    .prepare(
      `SELECT id,academic_year_id,name,start_date,end_date,is_current FROM terms
       WHERE school_id=? ORDER BY start_date ASC, name ASC`,
    )
    .all(schoolId);
  return {
    years: years.map((year) => ({
      id: year.id,
      name: year.name,
      startDate: year.start_date,
      endDate: year.end_date,
      isCurrent: year.is_current === 1,
      terms: terms
        .filter((term) => term.academic_year_id === year.id)
        .map((term) => ({
          id: term.id,
          name: term.name,
          startDate: term.start_date,
          endDate: term.end_date,
          isCurrent: term.is_current === 1,
        })),
    })),
    currentTermId: terms.find((term) => term.is_current === 1)?.id || null,
  };
}

function normalizeAuditBound(value, name, endOfDay) {
  if (!value) return "";
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw))
    return `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw httpError(400, `${name}不是有效时间`);
  return date.toISOString();
}

export function registerAdminRoutes(app, ctx) {
  const { db, config, auth, requireAdmin, audit, settings } = ctx;

  // ------------------------------------------------------------ 账号管理
  app.get("/api/admin/users", auth, requireAdmin, (req, res) => {
    const schoolId = req.user.school_id;
    const clauses = ["u.school_id=?"];
    const params = [schoolId];
    const role = q(req, "role");
    const status = q(req, "status");
    const search = q(req, "search");
    if (role) {
      if (!Object.values(ROLES).includes(role)) throw httpError(400, "角色筛选无效");
      clauses.push("u.role=?");
      params.push(role);
    }
    if (status) {
      if (!["ACTIVE", "DISABLED"].includes(status)) throw httpError(400, "账号状态筛选无效");
      clauses.push("u.status=?");
      params.push(status);
    }
    if (search) {
      clauses.push("(u.account LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')");
      const pattern = ctx.likePattern(search);
      params.push(pattern, pattern);
    }
    const total = db
      .prepare(`SELECT COUNT(*) AS count FROM users u WHERE ${clauses.join(" AND ")}`)
      .get(...params).count;
    const { page, pageSize, offset } = ctx.paginate(req.query, { defaultSize: 20, maxSize: 100 });
    const rows = db
      .prepare(
        `SELECT u.*, t.name AS teacher_name FROM users u LEFT JOIN teachers t ON t.id=u.teacher_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY u.created_at DESC, u.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset);
    const scopeMap = scopesForUsers(db, rows.map((row) => row.id));
    res.json(ctx.pageResult(rows.map((row) => userView(row, scopeMap.get(row.id))), total, { page, pageSize }));
  });

  app.post("/api/admin/users", auth, requireAdmin, async (req, res) => {
    const body = ctx.parseBody(createUserSchema, req.body);
    const schoolId = req.user.school_id;
    const existing = db.prepare("SELECT id FROM users WHERE account=? COLLATE NOCASE").get(body.account);
    if (existing) throw httpError(400, "该账号已存在");
    let teacherId = null;
    if (body.teacherId) {
      const teacher = db
        .prepare("SELECT id FROM teachers WHERE id=? AND school_id=?")
        .get(body.teacherId, schoolId);
      if (!teacher) throw httpError(404, "关联的教师不存在");
      const linked = db.prepare("SELECT id FROM users WHERE teacher_id=? AND school_id=?").get(teacher.id, schoolId);
      if (linked) throw httpError(400, "该教师已关联其他账号");
      teacherId = teacher.id;
    }
    assertPasswordPolicy(body.password, { account: body.account, role: body.role });
    const scopes = body.role === ROLES.DUTY_TEACHER ? resolveScopes(db, schoolId, body.scopes || []) : [];
    const { hash, salt } = await ctx.hashPassword(body.password);
    const id = ctx.uid();
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO users(id,school_id,account,display_name,role,password_hash,salt,teacher_id,status,must_change_password,created_at)
         VALUES(?,?,?,?,?,?,?,?,'ACTIVE',1,?)`,
      ).run(id, schoolId, body.account, body.displayName, body.role, hash, salt, teacherId, iso());
      insertUserScopes(db, id, scopes);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (isUniqueViolation(error)) throw httpError(400, "该账号已存在");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "USER_CREATE",
      targetType: "USER",
      targetId: id,
      summary: `创建账号 ${body.account}（${ROLE_LABELS[body.role] || body.role}，数据范围 ${scopes.length} 条）`,
    });
    const fresh = db
      .prepare("SELECT u.*, t.name AS teacher_name FROM users u LEFT JOIN teachers t ON t.id=u.teacher_id WHERE u.id=?")
      .get(id);
    res.status(201).json({ user: userView(fresh, scopes) });
  });

  app.patch("/api/admin/users/:id", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(patchUserSchema, req.body);
    const schoolId = req.user.school_id;
    const target = db
      .prepare("SELECT u.*, t.name AS teacher_name FROM users u LEFT JOIN teachers t ON t.id=u.teacher_id WHERE u.id=? AND u.school_id=?")
      .get(String(req.params.id), schoolId);
    if (!target) throw httpError(404, "账号不存在");
    const isSelf = target.id === req.user.id;
    if (isSelf && body.status === "DISABLED") throw httpError(400, "不能停用当前登录的账号");
    if (isSelf && body.role && body.role !== target.role)
      throw httpError(400, "不能修改自己的角色，避免失去管理权限");
    const nextRole = body.role || target.role;
    const beforeScopes = scopesForUsers(db, [target.id]).get(target.id) || [];
    let nextTeacherId = target.teacher_id;
    if (body.teacherId !== undefined) {
      if (body.teacherId === null) nextTeacherId = null;
      else {
        const teacher = db
          .prepare("SELECT id FROM teachers WHERE id=? AND school_id=?")
          .get(body.teacherId, schoolId);
        if (!teacher) throw httpError(404, "关联的教师不存在");
        const linked = db
          .prepare("SELECT id FROM users WHERE teacher_id=? AND school_id=? AND id<>?")
          .get(teacher.id, schoolId, target.id);
        if (linked) throw httpError(400, "该教师已关联其他账号");
        nextTeacherId = teacher.id;
      }
    }
    db.exec("BEGIN");
    let nextScopes = beforeScopes;
    try {
      db.prepare(
        "UPDATE users SET display_name=?, status=?, role=?, teacher_id=? WHERE id=? AND school_id=?",
      ).run(
        body.displayName ?? target.display_name,
        body.status || target.status,
        nextRole,
        nextTeacherId,
        target.id,
        schoolId,
      );
      if (body.scopes !== undefined || nextRole !== ROLES.DUTY_TEACHER) {
        const scopes = nextRole === ROLES.DUTY_TEACHER ? resolveScopes(db, schoolId, body.scopes || []) : [];
        db.prepare("DELETE FROM user_scopes WHERE user_id=?").run(target.id);
        insertUserScopes(db, target.id, scopes);
        nextScopes = scopes.map((item) => ({ ...item, name: "" }));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "USER_UPDATE",
      targetType: "USER",
      targetId: target.id,
      summary: `更新账号 ${target.account}（${ROLE_LABELS[nextRole] || nextRole}，状态 ${body.status || target.status}）`,
      before: {
        displayName: target.display_name,
        status: target.status,
        role: target.role,
        teacherId: target.teacher_id || null,
        scopes: beforeScopes.map((item) => `${item.scopeType}:${item.scopeId}`),
      },
      after: {
        displayName: body.displayName ?? target.display_name,
        status: body.status || target.status,
        role: nextRole,
        teacherId: nextTeacherId,
        scopes: nextScopes.map((item) => `${item.scopeType}:${item.scopeId}`),
      },
    });
    const fresh = db
      .prepare("SELECT u.*, t.name AS teacher_name FROM users u LEFT JOIN teachers t ON t.id=u.teacher_id WHERE u.id=?")
      .get(target.id);
    res.json({ user: userView(fresh, scopesForUsers(db, [target.id]).get(target.id) || []) });
  });

  app.post("/api/admin/users/:id/reset-password", auth, requireAdmin, async (req, res) => {
    const body = ctx.parseBody(resetPasswordSchema, req.body);
    const target = db
      .prepare("SELECT * FROM users WHERE id=? AND school_id=?")
      .get(String(req.params.id), req.user.school_id);
    if (!target) throw httpError(404, "账号不存在");
    assertPasswordPolicy(body.password, { account: target.account, role: target.role });
    const { hash, salt } = await ctx.hashPassword(body.password);
    db.prepare(
      "UPDATE users SET password_hash=?, salt=?, must_change_password=1 WHERE id=?",
    ).run(hash, salt, target.id);
    // 重置后强制其他会话失效；重置自己时保留当前会话，避免立即被踢出。
    if (target.id === req.user.id)
      db.prepare("DELETE FROM sessions WHERE user_id=? AND id<>?").run(target.id, req.sessionId);
    else db.prepare("DELETE FROM sessions WHERE user_id=?").run(target.id);
    audit.record({
      req,
      user: req.user,
      action: "USER_RESET_PASSWORD",
      targetType: "USER",
      targetId: target.id,
      summary: `重置账号 ${target.account} 的密码，并要求下次登录修改密码`,
    });
    res.json({ ok: true, userId: target.id, mustChangePassword: true });
  });

  // ------------------------------------------------------------ 系统参数
  app.get("/api/admin/system", auth, requireAdmin, (req, res) => {
    const schoolId = req.user.school_id;
    const school = db
      .prepare("SELECT id,name,code,stage,address,contact FROM schools WHERE id=?")
      .get(schoolId);
    const current = settings.get(schoolId);
    const periods = periodsView(db, schoolId);
    res.json({
      settings: {
        initialPoints: current.initialPoints,
        allowNegative: current.allowNegative,
        reviewThreshold: current.reviewThreshold,
      },
      school,
      periods,
      backupDirConfigured: backupConfigured(config),
      backupDir: backupConfigured(config) ? backupDirOf(config) : "",
      backupKeepRecent: Number(config.backupKeepRecent) || 24,
    });
  });

  app.patch("/api/admin/system", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(systemPatchSchema, req.body);
    const schoolId = req.user.school_id;
    const before = settings.get(schoolId);
    const updates = {};
    if (body.initialPoints !== undefined) updates.initial_points = body.initialPoints;
    if (body.allowNegative !== undefined) updates.allow_negative = body.allowNegative ? "1" : "0";
    if (body.reviewThreshold !== undefined) updates.review_threshold = body.reviewThreshold;
    const fresh = settings.set(schoolId, updates);
    audit.record({
      req,
      user: req.user,
      action: "SYSTEM_SETTINGS_UPDATE",
      targetType: "SYSTEM_SETTINGS",
      targetId: schoolId,
      summary: "更新系统参数（初始分/允许负分/复核阈值）",
      before: {
        initialPoints: before.initialPoints,
        allowNegative: before.allowNegative,
        reviewThreshold: before.reviewThreshold,
      },
      after: {
        initialPoints: fresh.initialPoints,
        allowNegative: fresh.allowNegative,
        reviewThreshold: fresh.reviewThreshold,
      },
    });
    res.json({
      settings: {
        initialPoints: fresh.initialPoints,
        allowNegative: fresh.allowNegative,
        reviewThreshold: fresh.reviewThreshold,
      },
    });
  });

  // -------------------------------------------------------- 荣誉/兑换配置
  app.get("/api/admin/honors", auth, requireAdmin, (req, res) => {
    const rows = db
      .prepare(
        `SELECT id,name,description,min_points,min_positive_records,is_enabled,sort_order,created_at
         FROM honor_rules WHERE school_id=? ORDER BY sort_order, name`,
      )
      .all(req.user.school_id);
    res.json({
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        minPoints: row.min_points,
        minPositiveRecords: row.min_positive_records,
        isEnabled: row.is_enabled === 1,
        sortOrder: row.sort_order,
        createdAt: row.created_at,
      })),
    });
  });

  app.post("/api/admin/honors", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(honorCreateSchema, req.body);
    const id = ctx.uid();
    const sortOrder =
      body.sortOrder ??
      (db
        .prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM honor_rules WHERE school_id=?")
        .get(req.user.school_id).next || 1);
    db.prepare(
      `INSERT INTO honor_rules(id,school_id,name,description,min_points,min_positive_records,is_enabled,sort_order,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      req.user.school_id,
      body.name,
      body.description || "",
      body.minPoints ?? 0,
      body.minPositiveRecords ?? 0,
      body.isEnabled === false ? 0 : 1,
      sortOrder,
      iso(),
    );
    audit.record({
      req,
      user: req.user,
      action: "HONOR_CREATE",
      targetType: "HONOR_RULE",
      targetId: id,
      summary: `新建荣誉参考规则「${body.name}」`,
    });
    res.status(201).json({
      honor: {
        id,
        name: body.name,
        description: body.description || "",
        minPoints: body.minPoints ?? 0,
        minPositiveRecords: body.minPositiveRecords ?? 0,
        isEnabled: body.isEnabled !== false,
        sortOrder,
      },
    });
  });

  app.patch("/api/admin/honors/:id", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(honorPatchSchema, req.body);
    const row = db
      .prepare("SELECT * FROM honor_rules WHERE id=? AND school_id=?")
      .get(String(req.params.id), req.user.school_id);
    if (!row) throw httpError(404, "荣誉规则不存在");
    const next = {
      name: body.name ?? row.name,
      description: body.description ?? row.description,
      min_points: body.minPoints ?? row.min_points,
      min_positive_records: body.minPositiveRecords ?? row.min_positive_records,
      is_enabled: body.isEnabled === undefined ? row.is_enabled : body.isEnabled ? 1 : 0,
      sort_order: body.sortOrder ?? row.sort_order,
    };
    db.prepare(
      `UPDATE honor_rules SET name=?,description=?,min_points=?,min_positive_records=?,is_enabled=?,sort_order=?
       WHERE id=? AND school_id=?`,
    ).run(
      next.name,
      next.description,
      next.min_points,
      next.min_positive_records,
      next.is_enabled,
      next.sort_order,
      row.id,
      req.user.school_id,
    );
    audit.record({
      req,
      user: req.user,
      action: "HONOR_UPDATE",
      targetType: "HONOR_RULE",
      targetId: row.id,
      summary: `更新荣誉参考规则「${next.name}」`,
      before: {
        name: row.name,
        minPoints: row.min_points,
        minPositiveRecords: row.min_positive_records,
        isEnabled: row.is_enabled === 1,
      },
      after: {
        name: next.name,
        minPoints: next.min_points,
        minPositiveRecords: next.min_positive_records,
        isEnabled: next.is_enabled === 1,
      },
    });
    res.json({
      honor: {
        id: row.id,
        name: next.name,
        description: next.description,
        minPoints: next.min_points,
        minPositiveRecords: next.min_positive_records,
        isEnabled: next.is_enabled === 1,
        sortOrder: next.sort_order,
      },
    });
  });

  app.get("/api/admin/rewards", auth, requireAdmin, (req, res) => {
    const rows = db
      .prepare(
        `SELECT id,name,description,points_cost,is_enabled,sort_order,created_at
         FROM reward_items WHERE school_id=? ORDER BY sort_order, name`,
      )
      .all(req.user.school_id);
    res.json({
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        pointsCost: row.points_cost,
        isEnabled: row.is_enabled === 1,
        sortOrder: row.sort_order,
        createdAt: row.created_at,
      })),
    });
  });

  app.post("/api/admin/rewards", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(rewardCreateSchema, req.body);
    const id = ctx.uid();
    const sortOrder =
      body.sortOrder ??
      (db
        .prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM reward_items WHERE school_id=?")
        .get(req.user.school_id).next || 1);
    db.prepare(
      `INSERT INTO reward_items(id,school_id,name,description,points_cost,is_enabled,sort_order,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      req.user.school_id,
      body.name,
      body.description || "",
      body.pointsCost,
      body.isEnabled === false ? 0 : 1,
      sortOrder,
      iso(),
    );
    audit.record({
      req,
      user: req.user,
      action: "REWARD_CREATE",
      targetType: "REWARD_ITEM",
      targetId: id,
      summary: `新建积分兑换项目「${body.name}」（${body.pointsCost} 分）`,
    });
    res.status(201).json({
      reward: {
        id,
        name: body.name,
        description: body.description || "",
        pointsCost: body.pointsCost,
        isEnabled: body.isEnabled !== false,
        sortOrder,
      },
    });
  });

  app.patch("/api/admin/rewards/:id", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(rewardPatchSchema, req.body);
    const row = db
      .prepare("SELECT * FROM reward_items WHERE id=? AND school_id=?")
      .get(String(req.params.id), req.user.school_id);
    if (!row) throw httpError(404, "兑换项目不存在");
    const next = {
      name: body.name ?? row.name,
      description: body.description ?? row.description,
      points_cost: body.pointsCost ?? row.points_cost,
      is_enabled: body.isEnabled === undefined ? row.is_enabled : body.isEnabled ? 1 : 0,
      sort_order: body.sortOrder ?? row.sort_order,
    };
    db.prepare(
      `UPDATE reward_items SET name=?,description=?,points_cost=?,is_enabled=?,sort_order=?
       WHERE id=? AND school_id=?`,
    ).run(next.name, next.description, next.points_cost, next.is_enabled, next.sort_order, row.id, req.user.school_id);
    audit.record({
      req,
      user: req.user,
      action: "REWARD_UPDATE",
      targetType: "REWARD_ITEM",
      targetId: row.id,
      summary: `更新积分兑换项目「${next.name}」`,
      before: { name: row.name, pointsCost: row.points_cost, isEnabled: row.is_enabled === 1 },
      after: { name: next.name, pointsCost: next.points_cost, isEnabled: next.is_enabled === 1 },
    });
    res.json({
      reward: {
        id: row.id,
        name: next.name,
        description: next.description,
        pointsCost: next.points_cost,
        isEnabled: next.is_enabled === 1,
        sortOrder: next.sort_order,
      },
    });
  });

  // ------------------------------------------------------------ 审计日志
  app.get("/api/admin/audit-logs", auth, requireAdmin, (req, res) => {
    const clauses = ["school_id=?"];
    const params = [req.user.school_id];
    const action = q(req, "action");
    const actorId = q(req, "actorId");
    if (action) {
      clauses.push("action=?");
      params.push(action);
    }
    if (actorId) {
      clauses.push("actor_id=?");
      params.push(actorId);
    }
    const from = normalizeAuditBound(q(req, "from"), "开始时间", false);
    const to = normalizeAuditBound(q(req, "to"), "结束时间", true);
    if (from) {
      clauses.push("created_at>=?");
      params.push(from);
    }
    if (to) {
      clauses.push("created_at<=?");
      params.push(to);
    }
    if (from && to && from > to) throw httpError(400, "开始时间不能晚于结束时间");
    const total = db
      .prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE ${clauses.join(" AND ")}`)
      .get(...params).count;
    const { page, pageSize, offset } = ctx.paginate(req.query, { defaultSize: 20, maxSize: 100 });
    const rows = db
      .prepare(
        `SELECT id,actor_account,actor_role,action,target_type,target_id,summary,result,ip,created_at
         FROM audit_logs WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset);
    res.json(
      ctx.pageResult(
        rows.map((row) => ({
          id: row.id,
          actorAccount: row.actor_account,
          actorRole: row.actor_role,
          action: row.action,
          targetType: row.target_type,
          targetId: row.target_id,
          summary: row.summary,
          result: row.result,
          ip: row.ip,
          createdAt: row.created_at,
        })),
        total,
        { page, pageSize },
      ),
    );
  });

  // -------------------------------------------------------------- 备份
  app.get("/api/admin/backups", auth, requireAdmin, (req, res) => {
    res.json({
      items: listBackupJobs(db, { limit: 50 }),
      backupDirConfigured: backupConfigured(config),
      backupKeepRecent: Number(config.backupKeepRecent) || 24,
    });
  });

  app.post("/api/admin/backups", auth, requireAdmin, (req, res) => {
    try {
      const result = runBackup({
        db,
        config,
        createdBy: req.user.id,
        schoolId: req.user.school_id,
      });
      audit.record({
        req,
        user: req.user,
        action: "BACKUP_RUN",
        targetType: "BACKUP_JOB",
        targetId: result.job.id,
        summary: `执行数据库备份（${result.job.fileName}，${result.job.sizeBytes} 字节）`,
      });
      res.status(201).json({
        job: result.job,
        pruned: result.pruned,
        backupDirConfigured: true,
      });
    } catch (error) {
      audit.record({
        req,
        user: req.user,
        action: "BACKUP_RUN_FAILED",
        targetType: "BACKUP_JOB",
        summary: `备份失败：${String(error?.message || error).slice(0, 200)}`,
        result: "FAILURE",
      });
      throw error;
    }
  });
}
