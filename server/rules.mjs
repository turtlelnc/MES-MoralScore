// 指标分类与评分规则：分类维护 + 规则版本生命周期
// DRAFT -> SUBMITTED -> APPROVED -> PUBLISHED -> ARCHIVED（驳回 SUBMITTED -> REJECTED -> DRAFT）。
// 已发布版本内容不可覆盖，修改生成新版本；记分只允许使用 PUBLISHED 且生效窗口/适用范围匹配的版本。
import { z } from "zod";
import {
  DIRECTION_LABELS,
  httpError,
  iso,
  isoDateTime,
  parseBody,
  safeJson,
  uid,
} from "./core.mjs";

export const RULE_STATUSES = Object.freeze([
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "PUBLISHED",
  "REJECTED",
  "ARCHIVED",
]);

export const RULE_STATUS_LABELS = Object.freeze({
  DRAFT: "草稿",
  SUBMITTED: "待审核",
  APPROVED: "已审核",
  PUBLISHED: "已发布",
  REJECTED: "已驳回",
  ARCHIVED: "已归档",
});

const TARGET_SCOPES = ["ALL", "GRADE", "CLASS"];
const MANAGER_ROLES = ["SYSTEM_ADMIN", "MORAL_AFFAIRS"];

// ------------------------------------------------------------------ zod helpers
function enumField(name, values) {
  return z.enum(values, { errorMap: () => ({ message: `${name}无效` }) });
}

function optionalInteger(name, { min = 0, max = 100000 } = {}) {
  return z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z
      .union([
        z.null(),
        z.coerce
          .number({ invalid_type_error: `${name}必须为数字` })
          .int(`${name}必须为整数`)
          .min(min, `${name}不能小于 ${min}`)
          .max(max, `${name}不能大于 ${max}`),
      ])
      .optional(),
  );
}

function requiredInteger(name, { min = 0, max = 100000 } = {}) {
  return z.preprocess(
    (value) => (value === "" || value === null || value === undefined ? undefined : value),
    z.coerce
      .number({ invalid_type_error: `${name}必须为数字` })
      .int(`${name}必须为整数`)
      .min(min, `${name}不能小于 ${min}`)
      .max(max, `${name}不能大于 ${max}`),
  );
}

const optionalText = (name, max) =>
  z.string().trim().max(max, `${name}不能超过 ${max} 个字符`).optional();

const categoryCreateSchema = z.object({
  name: z
    .string({ required_error: "请填写分类名称", invalid_type_error: "请填写分类名称" })
    .trim()
    .min(1, "请填写分类名称")
    .max(40, "分类名称不能超过 40 个字符"),
  description: optionalText("分类说明", 500),
  directionScope: enumField("分类方向", ["BOTH", "ADD", "DEDUCT"]).optional(),
  sortOrder: optionalInteger("排序号", { min: 0, max: 9999 }),
  isEnabled: z.boolean({ invalid_type_error: "启用状态无效" }).optional(),
});

const categoryUpdateSchema = categoryCreateSchema.partial();

const ruleCreateSchema = z.object({
  categoryId: z
    .string({ required_error: "请选择指标分类", invalid_type_error: "请选择指标分类" })
    .trim()
    .min(1, "请选择指标分类"),
  name: z
    .string({ required_error: "请填写规则名称", invalid_type_error: "请填写规则名称" })
    .trim()
    .min(2, "规则名称至少需要 2 个字符")
    .max(80, "规则名称不能超过 80 个字符"),
  description: optionalText("规则说明", 1000),
  examples: optionalText("规则示例", 1000),
  direction: enumField("加减分方向", ["ADD", "DEDUCT"]),
  points: requiredInteger("分值", { min: 1, max: 1000 }),
  minPoints: optionalInteger("单次分值下限", { min: 1, max: 1000 }),
  maxPoints: optionalInteger("单次分值上限", { min: 1, max: 1000 }),
  targetScope: enumField("适用范围", TARGET_SCOPES).optional(),
  scopeIds: z
    .array(z.string({ invalid_type_error: "适用范围 ID 无效" }).trim().min(1, "适用范围 ID 无效"))
    .max(200, "适用范围不能超过 200 项")
    .optional(),
  evidenceRequired: z.boolean({ invalid_type_error: "证据要求无效" }).optional(),
  requiresReview: z.boolean({ invalid_type_error: "复核设置无效" }).optional(),
  changeNote: optionalText("变更说明", 300),
  effectiveFrom: z.string().trim().optional(),
  effectiveTo: z.string().trim().optional(),
});

const ruleUpdateSchema = ruleCreateSchema.partial();

const publishSchema = z.object({
  effectiveFrom: z
    .string({ required_error: "请填写生效时间", invalid_type_error: "请填写生效时间" })
    .trim()
    .min(1, "请填写生效时间"),
  effectiveTo: z.string().trim().optional(),
  note: optionalText("发布说明", 300),
});

const rejectSchema = z.object({
  reason: z
    .string({ required_error: "请填写驳回理由", invalid_type_error: "请填写驳回理由" })
    .trim()
    .min(2, "驳回理由至少需要 2 个字符")
    .max(300, "驳回理由不能超过 300 个字符"),
});

// ------------------------------------------------------------------ serializers
const SUMMARY_COLUMNS = `
  SELECT r.id AS rule_id, r.active_version_id, r.latest_version AS rule_latest_version,
         r.archived_at AS rule_archived_at, r.created_at AS rule_created_at, r.updated_at AS rule_updated_at,
         v.id AS version_id, v.version AS version_number, v.status AS version_status,
         v.category_id, v.name AS rule_name, v.description, v.examples, v.direction, v.points,
         v.min_points, v.max_points, v.target_scope, v.scope_json, v.evidence_required,
         v.requires_review, v.change_note, v.created_at AS version_created_at,
         v.published_at, v.effective_from, v.effective_to, v.approved_at, v.submitted_at,
         c.name AS category_name`;
const SUMMARY_FROM_ALL = `
  FROM scoring_rules r
  JOIN scoring_rule_versions v ON v.rule_id = r.id
  LEFT JOIN scoring_categories c ON c.id = v.category_id`;
const SUMMARY_FROM_LATEST = `
  FROM scoring_rules r
  JOIN scoring_rule_versions v ON v.rule_id = r.id AND v.version = r.latest_version
  LEFT JOIN scoring_categories c ON c.id = v.category_id`;
const SUMMARY_FROM_ACTIVE = `
  FROM scoring_rules r
  JOIN scoring_rule_versions v ON v.id = r.active_version_id
  LEFT JOIN scoring_categories c ON c.id = v.category_id`;

function summaryFromRow(row) {
  return {
    id: row.rule_id,
    activeVersionId: row.active_version_id,
    versionId: row.version_id,
    version: row.version_number,
    name: row.rule_name,
    categoryId: row.category_id,
    categoryName: row.category_name || "",
    direction: row.direction,
    directionLabel: DIRECTION_LABELS[row.direction] || row.direction,
    points: row.points,
    minPoints: row.min_points,
    maxPoints: row.max_points,
    targetScope: row.target_scope,
    scopeIds: safeJson(row.scope_json, []),
    evidenceRequired: Boolean(row.evidence_required),
    requiresReview: Boolean(row.requires_review),
    status: row.version_status,
    statusLabel: RULE_STATUS_LABELS[row.version_status] || row.version_status,
    description: row.description,
    examples: row.examples,
    changeNote: row.change_note,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.version_created_at,
    updatedAt: row.rule_updated_at,
    publishedAt: row.published_at,
    archived: row.version_status === "ARCHIVED" || Boolean(row.rule_archived_at),
  };
}

function categoryView(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    directionScope: row.direction_scope,
    sortOrder: row.sort_order,
    isEnabled: Boolean(row.is_enabled),
  };
}

function latestRuleSummary(db, ruleId) {
  const row = db
    .prepare(`${SUMMARY_COLUMNS} ${SUMMARY_FROM_LATEST} WHERE r.id=?`)
    .get(ruleId);
  return row ? summaryFromRow(row) : null;
}

function latestVersion(db, ruleId) {
  return db
    .prepare(
      `SELECT v.*, c.name AS category_name FROM scoring_rule_versions v
       LEFT JOIN scoring_categories c ON c.id=v.category_id
       WHERE v.rule_id=? AND v.version=(SELECT latest_version FROM scoring_rules WHERE id=?)`,
    )
    .get(ruleId, ruleId);
}

function ruleById(db, schoolId, ruleId) {
  return db.prepare("SELECT * FROM scoring_rules WHERE id=? AND school_id=?").get(ruleId, schoolId);
}

function friendlyDbError(error, message) {
  const raw = String(error?.message || "");
  if (raw.includes("UNIQUE constraint failed") || raw.includes("constraint failed")) {
    throw httpError(400, message);
  }
  throw error;
}

// ------------------------------------------------------------------ validation
function validateScopeIds(db, schoolId, targetScope, scopeIds) {
  if (targetScope === "ALL") return [];
  const ids = [...new Set(scopeIds || [])];
  if (!ids.length) throw httpError(400, "请选择适用范围的具体年级或班级");
  const table = targetScope === "GRADE" ? "grades" : "classes";
  const rows = db
    .prepare(`SELECT id FROM ${table} WHERE school_id=? AND id IN (${ids.map(() => "?").join(",")})`)
    .all(schoolId, ...ids);
  if (rows.length !== ids.length)
    throw httpError(400, targetScope === "GRADE" ? "适用范围包含无效的年级" : "适用范围包含无效的班级");
  return ids;
}

function validatePoints(points, minPoints, maxPoints) {
  if (minPoints != null && maxPoints != null && minPoints > maxPoints)
    throw httpError(400, "单次分值下限不能大于上限");
  if (minPoints != null && points < minPoints) throw httpError(400, "规则分值不能小于单次分值下限");
  if (maxPoints != null && points > maxPoints) throw httpError(400, "规则分值不能大于单次分值上限");
}

/**
 * 合并请求体与既有版本（修改场景），返回可直接写库的规范化字段。
 * base 为 scoring_rule_versions 原始行（新建时传 null）。
 */
function prepareRuleData(db, schoolId, input, base = null) {
  const categoryId = input.categoryId ?? base?.category_id;
  if (!categoryId) throw httpError(400, "请选择指标分类");
  const category = db
    .prepare("SELECT * FROM scoring_categories WHERE id=? AND school_id=?")
    .get(categoryId, schoolId);
  if (!category) throw httpError(400, "所选指标分类不存在");

  const direction = input.direction ?? base?.direction;
  if (!["ADD", "DEDUCT"].includes(direction)) throw httpError(400, "加减分方向无效");
  const points = input.points ?? base?.points;
  if (!Number.isSafeInteger(points) || points < 1 || points > 1000)
    throw httpError(400, "分值必须为 1 到 1000 之间的整数");
  const minPoints = input.minPoints !== undefined ? input.minPoints : (base?.min_points ?? null);
  const maxPoints = input.maxPoints !== undefined ? input.maxPoints : (base?.max_points ?? null);
  validatePoints(points, minPoints, maxPoints);

  const name = input.name ?? base?.name;
  if (!name || String(name).trim().length < 2) throw httpError(400, "规则名称至少需要 2 个字符");
  const targetScope = input.targetScope ?? base?.target_scope ?? "ALL";
  if (!TARGET_SCOPES.includes(targetScope)) throw httpError(400, "适用范围无效");
  let scopeIds;
  if (targetScope === "ALL") scopeIds = [];
  else if (input.scopeIds !== undefined) scopeIds = input.scopeIds;
  else scopeIds = safeJson(base?.scope_json, []);
  scopeIds = validateScopeIds(db, schoolId, targetScope, scopeIds);

  const parseWindow = (value, fallback, field) => {
    if (value === undefined) return fallback ?? null;
    if (value === "") return null;
    return isoDateTime(value, field);
  };
  const effectiveFrom = parseWindow(input.effectiveFrom, base?.effective_from, "生效时间");
  const effectiveTo = parseWindow(input.effectiveTo, base?.effective_to, "失效时间");
  if (
    effectiveFrom &&
    effectiveTo &&
    new Date(effectiveTo).getTime() <= new Date(effectiveFrom).getTime()
  )
    throw httpError(400, "失效时间必须晚于生效时间");

  return {
    categoryId,
    name: String(name).trim().slice(0, 80),
    description: input.description ?? base?.description ?? "",
    examples: input.examples ?? base?.examples ?? "",
    direction,
    points,
    minPoints,
    maxPoints,
    targetScope,
    scopeIds,
    evidenceRequired: input.evidenceRequired ?? Boolean(base?.evidence_required),
    requiresReview: input.requiresReview ?? Boolean(base?.requires_review),
    changeNote: input.changeNote ?? base?.change_note ?? "",
    effectiveFrom,
    effectiveTo,
  };
}

function insertVersionRow(db, { ruleId, schoolId, version, status, data, createdBy, now }) {
  const id = uid();
  db.prepare(
    `INSERT INTO scoring_rule_versions(id,rule_id,school_id,version,status,category_id,name,description,examples,direction,points,min_points,max_points,target_scope,scope_json,evidence_required,requires_review,change_note,created_by,created_at,effective_from,effective_to)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    ruleId,
    schoolId,
    version,
    status,
    data.categoryId,
    data.name,
    data.description,
    data.examples,
    data.direction,
    data.points,
    data.minPoints,
    data.maxPoints,
    data.targetScope,
    JSON.stringify(data.scopeIds),
    data.evidenceRequired ? 1 : 0,
    data.requiresReview ? 1 : 0,
    data.changeNote,
    createdBy,
    now,
    data.effectiveFrom,
    data.effectiveTo,
  );
  return id;
}

function updateVersionContent(db, versionId, data, { status = null } = {}) {
  const sets = [
    "category_id=?",
    "name=?",
    "description=?",
    "examples=?",
    "direction=?",
    "points=?",
    "min_points=?",
    "max_points=?",
    "target_scope=?",
    "scope_json=?",
    "evidence_required=?",
    "requires_review=?",
    "change_note=?",
    "effective_from=?",
    "effective_to=?",
  ];
  const params = [
    data.categoryId,
    data.name,
    data.description,
    data.examples,
    data.direction,
    data.points,
    data.minPoints,
    data.maxPoints,
    data.targetScope,
    JSON.stringify(data.scopeIds),
    data.evidenceRequired ? 1 : 0,
    data.requiresReview ? 1 : 0,
    data.changeNote,
    data.effectiveFrom,
    data.effectiveTo,
  ];
  if (status) {
    sets.push("status=?");
    params.push(status);
  }
  params.push(versionId);
  db.prepare(`UPDATE scoring_rule_versions SET ${sets.join(",")} WHERE id=?`).run(...params);
}

function scopeOptions(db, ctx, user) {
  if (ctx.scope.hasFullScope(user)) {
    return {
      grades: db
        .prepare("SELECT id,name FROM grades WHERE school_id=? ORDER BY sort_order,id")
        .all(user.school_id),
      classes: db
        .prepare(
          `SELECT c.id, c.name, c.grade_id AS gradeId, g.name AS gradeName
           FROM classes c JOIN grades g ON g.id=c.grade_id
           WHERE c.school_id=? ORDER BY g.sort_order, c.sort_order, c.id`,
        )
        .all(user.school_id),
    };
  }
  const classIds = ctx.scope.classIdsFor(user);
  if (!classIds.length) return { grades: [], classes: [] };
  const marks = classIds.map(() => "?").join(",");
  const classes = db
    .prepare(
      `SELECT c.id, c.name, c.grade_id AS gradeId, g.name AS gradeName
       FROM classes c JOIN grades g ON g.id=c.grade_id
       WHERE c.id IN (${marks}) ORDER BY g.sort_order, c.sort_order, c.id`,
    )
    .all(...classIds);
  const gradeIds = [...new Set(classes.map((row) => row.gradeId))];
  const grades = gradeIds.length
    ? db
        .prepare(
          `SELECT id,name FROM grades WHERE id IN (${gradeIds.map(() => "?").join(",")}) ORDER BY sort_order,id`,
        )
        .all(...gradeIds)
    : [];
  return { grades, classes };
}

// ------------------------------------------------------------------ rule listing
function listRuleSummaries(ctx, user, query) {
  const { db } = ctx;
  const fullScope = ctx.scope.hasFullScope(user);
  const from = fullScope ? SUMMARY_FROM_LATEST : SUMMARY_FROM_ACTIVE;
  const clauses = ["r.school_id=?"];
  const params = [user.school_id];
  if (!fullScope) clauses.push("v.status='PUBLISHED'");
  if (query.status) {
    clauses.push("v.status=?");
    params.push(String(query.status).trim());
  }
  if (query.categoryId) {
    clauses.push("v.category_id=?");
    params.push(String(query.categoryId).trim());
  }
  if (query.direction) {
    clauses.push("v.direction=?");
    params.push(String(query.direction).trim());
  }
  if (query.search) {
    const pattern = `%${String(query.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    clauses.push("(v.name LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  if (!fullScope) {
    const now = iso();
    clauses.push(
      "(v.effective_from IS NULL OR v.effective_from<=?)",
      "(v.effective_to IS NULL OR v.effective_to>=?)",
    );
    params.push(now, now);
  }
  const sql = `SELECT * FROM (${SUMMARY_COLUMNS} ${from} WHERE ${clauses.join(
    " AND ",
  )}) ORDER BY rule_updated_at DESC, rule_id`;
  const rows = db.prepare(sql).all(...params);
  let items = rows.map(summaryFromRow);
  if (!fullScope) {
    const classIds = new Set(ctx.scope.classIdsFor(user));
    const gradeIds = new Set(
      db
        .prepare(
          `SELECT DISTINCT grade_id FROM classes WHERE school_id=? AND id IN (${
            [...classIds].map(() => "?").join(",") || "''"
          })`,
        )
        .all(user.school_id, ...classIds)
        .map((row) => row.grade_id),
    );
    items = items.filter((item) => {
      if (item.targetScope === "ALL") return true;
      if (item.targetScope === "GRADE") return item.scopeIds.some((id) => gradeIds.has(id));
      return item.scopeIds.some((id) => classIds.has(id));
    });
  }
  return items;
}

// ------------------------------------------------------------------ scoring resolver
function withinWindow(version, whenMs) {
  const start = version.effective_from ? new Date(version.effective_from).getTime() : null;
  const end = version.effective_to ? new Date(version.effective_to).getTime() : null;
  if (start !== null && Number.isFinite(start) && whenMs < start) return false;
  if (end !== null && Number.isFinite(end) && whenMs > end) return false;
  return true;
}

/**
 * 记分时必须调用的规则解析：只接受 PUBLISHED 且在生效窗口内、适用范围匹配的版本。
 * ruleId 既支持传评分规则 id，也支持直接传版本 id。
 * 返回 { rule, version, categoryName, scopeIds }。
 */
export function resolveRuleForScoring(db, { ruleId, at, classId, gradeId, schoolId = null }) {
  if (!ruleId) throw httpError(400, "请选择评分规则");
  const when = isoDateTime(at ?? iso(), "记分时间");
  const whenMs = new Date(when).getTime();
  let rule = db.prepare("SELECT * FROM scoring_rules WHERE id=?").get(String(ruleId));
  let versions = [];
  if (rule) {
    if (schoolId && rule.school_id !== schoolId) throw httpError(404, "评分规则不存在");
    versions = db
      .prepare(
        `SELECT v.*, c.name AS category_name FROM scoring_rule_versions v
         LEFT JOIN scoring_categories c ON c.id=v.category_id
         WHERE v.rule_id=? AND v.status='PUBLISHED' ORDER BY v.version DESC`,
      )
      .all(rule.id);
  } else {
    const version = db
      .prepare(
        `SELECT v.*, r.school_id AS rule_school_id, c.name AS category_name
         FROM scoring_rule_versions v JOIN scoring_rules r ON r.id=v.rule_id
         LEFT JOIN scoring_categories c ON c.id=v.category_id
         WHERE v.id=?`,
      )
      .get(String(ruleId));
    if (version) {
      if (schoolId && version.rule_school_id !== schoolId) throw httpError(404, "评分规则不存在");
      rule = db.prepare("SELECT * FROM scoring_rules WHERE id=?").get(version.rule_id);
      versions = [version];
    }
  }
  if (!rule || !versions.length) throw httpError(400, "评分规则不存在或尚未发布");
  const active = rule.active_version_id
    ? versions.find((item) => item.id === rule.active_version_id)
    : null;
  const version = active || versions.find((item) => withinWindow(item, whenMs)) || null;
  if (!version) throw httpError(400, "该评分规则当前不在生效时间内，不能用于记分");
  if (!withinWindow(version, whenMs)) {
    const start = version.effective_from ? version.effective_from.slice(0, 10) : "不限";
    const end = version.effective_to ? version.effective_to.slice(0, 10) : "不限";
    throw httpError(400, `该评分规则不在生效时间内（生效：${start} 至 ${end}）`);
  }
  const scopeIds = safeJson(version.scope_json, []);
  if (version.target_scope === "GRADE") {
    if (!gradeId || !scopeIds.includes(gradeId))
      throw httpError(400, "该评分规则不适用于该学生所在年级");
  } else if (version.target_scope === "CLASS") {
    if (!classId || !scopeIds.includes(classId))
      throw httpError(400, "该评分规则不适用于该学生所在班级");
  }
  return { rule, version, categoryName: version.category_name || "", scopeIds };
}

// ------------------------------------------------------------------ routes
export function registerRulesRoutes(app, ctx) {
  const { db, auth, audit, requireAdmin, requireManagement, requireMoral, requireStaff } = ctx;

  const assertRuleEditor = (user) => {
    if (!MANAGER_ROLES.includes(user.role)) throw httpError(403, "当前角色无权维护评分规则");
  };

  // ---- 指标分类
  app.get("/api/categories", auth, requireStaff, (req, res) => {
    const fullScope = ctx.scope.hasFullScope(req.user);
    const rows = db
      .prepare(
        `SELECT * FROM scoring_categories WHERE school_id=? ${
          fullScope ? "" : "AND is_enabled=1"
        } ORDER BY sort_order, id`,
      )
      .all(req.user.school_id);
    res.json({ items: rows.map(categoryView) });
  });

  app.post("/api/categories", auth, requireAdmin, (req, res) => {
    const body = parseBody(categoryCreateSchema, req.body);
    const id = uid();
    const now = iso();
    try {
      db.prepare(
        `INSERT INTO scoring_categories(id,school_id,name,description,direction_scope,sort_order,is_enabled,created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        req.user.school_id,
        body.name,
        body.description || "",
        body.directionScope || "BOTH",
        body.sortOrder ?? 0,
        body.isEnabled === false ? 0 : 1,
        now,
      );
    } catch (error) {
      friendlyDbError(error, "分类名称已存在，请更换名称");
    }
    audit.record({
      req,
      user: req.user,
      action: "CATEGORY_CREATE",
      targetType: "CATEGORY",
      targetId: id,
      summary: `新建指标分类「${body.name}」`,
      after: { categoryId: id, name: body.name, directionScope: body.directionScope || "BOTH" },
    });
    const row = db.prepare("SELECT * FROM scoring_categories WHERE id=?").get(id);
    res.status(201).json({ category: categoryView(row) });
  });

  app.patch("/api/categories/:id", auth, requireAdmin, (req, res) => {
    const body = parseBody(categoryUpdateSchema, req.body);
    const row = db
      .prepare("SELECT * FROM scoring_categories WHERE id=? AND school_id=?")
      .get(req.params.id, req.user.school_id);
    if (!row) throw httpError(404, "指标分类不存在");
    const next = {
      name: body.name ?? row.name,
      description: body.description ?? row.description,
      directionScope: body.directionScope ?? row.direction_scope,
      sortOrder: body.sortOrder ?? row.sort_order,
      isEnabled: body.isEnabled === undefined ? row.is_enabled : body.isEnabled ? 1 : 0,
    };
    try {
      db.prepare(
        "UPDATE scoring_categories SET name=?,description=?,direction_scope=?,sort_order=?,is_enabled=? WHERE id=?",
      ).run(next.name, next.description, next.directionScope, next.sortOrder, next.isEnabled, row.id);
    } catch (error) {
      friendlyDbError(error, "分类名称已存在，请更换名称");
    }
    audit.record({
      req,
      user: req.user,
      action: "CATEGORY_UPDATE",
      targetType: "CATEGORY",
      targetId: row.id,
      summary: `修改指标分类「${row.name}」`,
      before: categoryView(row),
      after: categoryView({ ...row, ...next, is_enabled: next.isEnabled }),
    });
    const updated = db.prepare("SELECT * FROM scoring_categories WHERE id=?").get(row.id);
    res.json({ category: categoryView(updated) });
  });

  // ---- 规则列表
  app.get("/api/rules", auth, requireStaff, (req, res) => {
    res.json({ items: listRuleSummaries(ctx, req.user, req.query || {}) });
  });

  // ---- 规则详情（含版本历史）
  app.get("/api/rules/:id", auth, requireStaff, (req, res) => {
    const rule = ruleById(db, req.user.school_id, req.params.id);
    if (!rule) throw httpError(404, "评分规则不存在");
    const rows = db
      .prepare(`${SUMMARY_COLUMNS} ${SUMMARY_FROM_ALL} WHERE r.id=? ORDER BY v.version DESC`)
      .all(rule.id);
    if (!rows.length) throw httpError(404, "评分规则不存在");
    const fullScope = ctx.scope.hasFullScope(req.user);
    let visible = rows;
    if (!fullScope) {
      visible = rows.filter(
        (row) => row.version_status === "PUBLISHED" && withinWindow(row, Date.now()),
      );
      if (!visible.length) throw httpError(404, "评分规则不存在或尚未发布");
    }
    const current = fullScope
      ? visible.find((row) => row.version_number === rule.latest_version) || visible[0]
      : visible[0];
    res.json({
      rule: summaryFromRow(current),
      versions: visible.map((row) => {
        const summary = summaryFromRow(row);
        return {
          id: summary.versionId,
          versionId: summary.versionId,
          activeVersionId: summary.activeVersionId,
          version: summary.version,
          name: summary.name,
          categoryId: summary.categoryId,
          categoryName: summary.categoryName,
          direction: summary.direction,
          points: summary.points,
          minPoints: summary.minPoints,
          maxPoints: summary.maxPoints,
          targetScope: summary.targetScope,
          scopeIds: summary.scopeIds,
          evidenceRequired: summary.evidenceRequired,
          requiresReview: summary.requiresReview,
          status: summary.status,
          statusLabel: summary.statusLabel,
          description: summary.description,
          examples: summary.examples,
          changeNote: summary.changeNote,
          effectiveFrom: summary.effectiveFrom,
          effectiveTo: summary.effectiveTo,
          createdAt: summary.createdAt,
          submittedAt: row.submitted_at,
          approvedAt: row.approved_at,
          publishedAt: summary.publishedAt,
          archived: summary.archived,
        };
      }),
      scopes: scopeOptions(db, ctx, req.user),
    });
  });

  // ---- 创建规则（v1 草稿）：系统管理员与德育处均可创建，但发布需德育处
  app.post("/api/rules", auth, requireManagement, (req, res) => {
    assertRuleEditor(req.user);
    const body = parseBody(ruleCreateSchema, req.body);
    const data = prepareRuleData(db, req.user.school_id, body, null);
    const now = iso();
    const ruleId = uid();
    let versionId = null;
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO scoring_rules(id,school_id,active_version_id,latest_version,archived_at,created_by,created_at,updated_at)
         VALUES(?,?,NULL,1,NULL,?,?,?)`,
      ).run(ruleId, req.user.school_id, req.user.id, now, now);
      versionId = insertVersionRow(db, {
        ruleId,
        schoolId: req.user.school_id,
        version: 1,
        status: "DRAFT",
        data,
        createdBy: req.user.id,
        now,
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "RULE_CREATE",
      targetType: "RULE",
      targetId: ruleId,
      summary: `创建评分规则「${data.name}」草稿 v1`,
      after: { ruleId, versionId, name: data.name, points: data.points },
    });
    res.status(201).json({ rule: latestRuleSummary(db, ruleId) });
  });

  // ---- 修改规则：草稿原地改；已提交/已审核/已发布/已归档生成新版本
  app.patch("/api/rules/:id", auth, requireManagement, (req, res) => {
    assertRuleEditor(req.user);
    const rule = ruleById(db, req.user.school_id, req.params.id);
    if (!rule) throw httpError(404, "评分规则不存在");
    const body = parseBody(ruleUpdateSchema, req.body);
    const base = latestVersion(db, rule.id);
    if (!base) throw httpError(500, "评分规则版本数据缺失");
    const data = prepareRuleData(db, req.user.school_id, body, base);
    const now = iso();
    const editableInPlace = base.status === "DRAFT" || base.status === "REJECTED";
    let createdVersion = null;
    db.exec("BEGIN");
    try {
      if (editableInPlace) {
        updateVersionContent(db, base.id, data, { status: "DRAFT" });
        db.prepare("UPDATE scoring_rules SET updated_at=? WHERE id=?").run(now, rule.id);
      } else {
        // 被替换的 SUBMITTED/APPROVED 版本作废，避免旧内容被审核/发布。
        if (base.status === "SUBMITTED" || base.status === "APPROVED")
          db.prepare("UPDATE scoring_rule_versions SET status='REJECTED', change_note=? WHERE id=?").run(
            `${base.change_note ? `${base.change_note}；` : ""}已生成新版本，本版本作废`,
            base.id,
          );
        createdVersion = insertVersionRow(db, {
          ruleId: rule.id,
          schoolId: req.user.school_id,
          version: Number(rule.latest_version || 1) + 1,
          status: "DRAFT",
          data,
          createdBy: req.user.id,
          now,
        });
        db.prepare(
          "UPDATE scoring_rules SET latest_version=latest_version+1, archived_at=NULL, updated_at=? WHERE id=?",
        ).run(now, rule.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      friendlyDbError(error, "规则版本保存失败，请稍后重试");
    }
    audit.record({
      req,
      user: req.user,
      action: "RULE_UPDATE",
      targetType: "RULE",
      targetId: rule.id,
      summary: editableInPlace
        ? `修改评分规则「${data.name}」草稿`
        : `修改评分规则「${data.name}」并生成新草稿版本`,
      before: {
        versionId: base.id,
        version: base.version,
        status: base.status,
        name: base.name,
        points: base.points,
      },
      after: { name: data.name, points: data.points, createdVersion },
    });
    res.json({ rule: latestRuleSummary(db, rule.id) });
  });

  // ---- 提交审核（系统管理员与德育处均可提交）
  app.post("/api/rules/:id/submit", auth, requireManagement, (req, res) => {
    assertRuleEditor(req.user);
    const rule = ruleById(db, req.user.school_id, req.params.id);
    if (!rule) throw httpError(404, "评分规则不存在");
    const base = latestVersion(db, rule.id);
    const now = iso();
    if (base.status === "DRAFT") {
      db.prepare(
        "UPDATE scoring_rule_versions SET status='SUBMITTED', submitted_by=?, submitted_at=? WHERE id=?",
      ).run(req.user.id, now, base.id);
    } else if (base.status === "REJECTED") {
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE scoring_rule_versions SET status='DRAFT' WHERE id=?").run(base.id);
        db.prepare(
          "UPDATE scoring_rule_versions SET status='SUBMITTED', submitted_by=?, submitted_at=? WHERE id=?",
        ).run(req.user.id, now, base.id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        friendlyDbError(error, "规则状态流转失败，请刷新后重试");
      }
    } else if (base.status === "SUBMITTED") {
      throw httpError(400, "该评分规则已提交审核，请等待审核结果");
    } else if (base.status === "APPROVED") {
      throw httpError(400, "该评分规则已通过审核，请直接发布");
    } else if (base.status === "PUBLISHED") {
      throw httpError(400, "该评分规则已发布，如需调整请先修改生成新版本");
    } else {
      throw httpError(400, "当前版本状态不可提交审核");
    }
    db.prepare("UPDATE scoring_rules SET updated_at=? WHERE id=?").run(now, rule.id);
    audit.record({
      req,
      user: req.user,
      action: "RULE_SUBMIT",
      targetType: "RULE",
      targetId: rule.id,
      summary: `提交评分规则「${base.name}」v${base.version} 审核`,
      before: { status: base.status },
      after: { status: "SUBMITTED", versionId: base.id, version: base.version },
    });
    res.json({ rule: latestRuleSummary(db, rule.id) });
  });

  // ---- 审核通过（仅德育处）
  app.post("/api/rules/:id/approve", auth, requireMoral, (req, res) => {
    const rule = ruleById(db, req.user.school_id, req.params.id);
    if (!rule) throw httpError(404, "评分规则不存在");
    const base = latestVersion(db, rule.id);
    if (base.status !== "SUBMITTED") throw httpError(400, "只有待审核的规则版本可以审核通过");
    const now = iso();
    db.prepare(
      "UPDATE scoring_rule_versions SET status='APPROVED', approved_by=?, approved_at=? WHERE id=?",
    ).run(req.user.id, now, base.id);
    db.prepare("UPDATE scoring_rules SET updated_at=? WHERE id=?").run(now, rule.id);
    audit.record({
      req,
      user: req.user,
      action: "RULE_APPROVE",
      targetType: "RULE",
      targetId: rule.id,
      summary: `审核通过评分规则「${base.name}」v${base.version}`,
      before: { status: base.status },
      after: { status: "APPROVED", versionId: base.id, version: base.version },
    });
    res.json({ rule: latestRuleSummary(db, rule.id) });
  });

  // ---- 发布（仅德育处）：旧已发布版本归档，active_version_id 指向新版本
  app.post("/api/rules/:id/publish", auth, requireMoral, (req, res) => {
    const body = parseBody(publishSchema, req.body);
    const rule = ruleById(db, req.user.school_id, req.params.id);
    if (!rule) throw httpError(404, "评分规则不存在");
    const base = latestVersion(db, rule.id);
    if (base.status !== "APPROVED") throw httpError(400, "只有已审核通过的规则版本可以发布");
    const effectiveFrom = isoDateTime(body.effectiveFrom, "生效时间");
    const effectiveTo = body.effectiveTo ? isoDateTime(body.effectiveTo, "失效时间") : null;
    if (effectiveTo && new Date(effectiveTo).getTime() <= new Date(effectiveFrom).getTime())
      throw httpError(400, "失效时间必须晚于生效时间");
    const now = iso();
    const changeNote = body.note ?? base.change_note;
    db.exec("BEGIN");
    try {
      db.prepare(
        "UPDATE scoring_rule_versions SET status='ARCHIVED' WHERE rule_id=? AND status='PUBLISHED' AND id<>?",
      ).run(rule.id, base.id);
      db.prepare(
        `UPDATE scoring_rule_versions
         SET status='PUBLISHED', published_at=?, effective_from=?, effective_to=?, change_note=?
         WHERE id=?`,
      ).run(now, effectiveFrom, effectiveTo, changeNote, base.id);
      db.prepare(
        "UPDATE scoring_rules SET active_version_id=?, archived_at=NULL, updated_at=? WHERE id=?",
      ).run(base.id, now, rule.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      friendlyDbError(error, "规则发布失败，请稍后重试");
    }
    audit.record({
      req,
      user: req.user,
      action: "RULE_PUBLISH",
      targetType: "RULE",
      targetId: rule.id,
      summary: `发布评分规则「${base.name}」v${base.version}（生效：${effectiveFrom.slice(0, 10)}）`,
      after: {
        versionId: base.id,
        version: base.version,
        effectiveFrom,
        effectiveTo,
        activeVersionId: base.id,
      },
    });
    res.json({ rule: latestRuleSummary(db, rule.id) });
  });

  // ---- 驳回（仅德育处）
  app.post("/api/rules/:id/reject", auth, requireMoral, (req, res) => {
    const body = parseBody(rejectSchema, req.body);
    const rule = ruleById(db, req.user.school_id, req.params.id);
    if (!rule) throw httpError(404, "评分规则不存在");
    const base = latestVersion(db, rule.id);
    if (base.status !== "SUBMITTED" && base.status !== "APPROVED")
      throw httpError(400, "只有待审核或已审核的规则版本可以驳回");
    const now = iso();
    const changeNote = `${base.change_note ? `${base.change_note}；` : ""}驳回理由：${body.reason}`;
    db.prepare("UPDATE scoring_rule_versions SET status='REJECTED', change_note=? WHERE id=?").run(
      changeNote,
      base.id,
    );
    db.prepare("UPDATE scoring_rules SET updated_at=? WHERE id=?").run(now, rule.id);
    audit.record({
      req,
      user: req.user,
      action: "RULE_REJECT",
      targetType: "RULE",
      targetId: rule.id,
      summary: `驳回评分规则「${base.name}」v${base.version}：${body.reason}`,
      before: { status: base.status },
      after: { status: "REJECTED", reason: body.reason },
    });
    res.json({ rule: latestRuleSummary(db, rule.id) });
  });

  // ---- 归档（仅德育处）
  app.post("/api/rules/:id/archive", auth, requireMoral, (req, res) => {
    const rule = ruleById(db, req.user.school_id, req.params.id);
    if (!rule) throw httpError(404, "评分规则不存在");
    const published = db
      .prepare("SELECT * FROM scoring_rule_versions WHERE rule_id=? AND status='PUBLISHED'")
      .all(rule.id);
    if (!published.length) throw httpError(400, "该评分规则当前没有已发布版本可归档");
    const now = iso();
    db.exec("BEGIN");
    try {
      db.prepare(
        "UPDATE scoring_rule_versions SET status='ARCHIVED' WHERE rule_id=? AND status='PUBLISHED'",
      ).run(rule.id);
      db.prepare(
        "UPDATE scoring_rules SET active_version_id=NULL, archived_at=?, updated_at=? WHERE id=?",
      ).run(now, now, rule.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      friendlyDbError(error, "规则归档失败，请稍后重试");
    }
    audit.record({
      req,
      user: req.user,
      action: "RULE_ARCHIVE",
      targetType: "RULE",
      targetId: rule.id,
      summary: `归档评分规则「${published[0].name}」`,
      before: { status: "PUBLISHED", versionId: published[0].id },
      after: { status: "ARCHIVED", activeVersionId: null },
    });
    res.json({ rule: latestRuleSummary(db, rule.id) });
  });
}
