// 记分与积分账本：只追加账本、待复核策略、冲正/更正、复核审批与 CSV 导出。
// EFFECTIVE 记录绝不允许 UPDATE/DELETE（schema 触发器兜底），错误一律转为中文 400。
import { z } from "zod";
import {
  DIRECTION_LABELS,
  httpError,
  iso,
  isoDateTime,
  paginate,
  pageResult,
  parseBody,
  uid,
} from "./core.mjs";
import { recordListWhere, recordViews, resolveTermForDate } from "./ledger.mjs";
import { validateEvidenceIds } from "./evidence.mjs";
import { resolveRuleForScoring } from "./rules.mjs";

const RECORD_STATUS_LABELS = Object.freeze({
  EFFECTIVE: "已生效",
  PENDING_REVIEW: "待复核",
  REJECTED: "已驳回",
});

const APPEAL_STATUS_LABELS = Object.freeze({
  SUBMITTED: "待处理",
  UNDER_REVIEW: "复核中",
  ACCEPTED: "已接受",
  REJECTED: "已驳回",
});

// ------------------------------------------------------------------ zod helpers
function optionalInteger(name, { min = 0, max = 100000 } = {}) {
  return z.preprocess(
    (value) => (value === "" || value === null || value === undefined ? undefined : value),
    z.coerce
      .number({ invalid_type_error: `${name}必须为数字` })
      .int(`${name}必须为整数`)
      .min(min, `${name}不能小于 ${min}`)
      .max(max, `${name}不能大于 ${max}`)
      .optional(),
  );
}

const evidenceIdsSchema = z
  .array(z.string({ invalid_type_error: "证据 ID 无效" }).min(1, "证据 ID 无效"))
  .max(5, "单条记录最多关联 5 个证据文件")
  .optional();

const singleScoreSchema = z.object({
  ruleId: z
    .string({ required_error: "请选择评分规则", invalid_type_error: "请选择评分规则" })
    .min(1, "请选择评分规则"),
  studentId: z
    .string({ required_error: "请选择学生", invalid_type_error: "请选择学生" })
    .min(1, "请选择学生"),
  occurrenceAt: z.string().trim().optional(),
  note: z.string().trim().max(500, "说明不能超过 500 个字符").optional(),
  evidenceIds: evidenceIdsSchema,
});

const batchScoreSchema = z.object({
  ruleId: z
    .string({ required_error: "请选择评分规则", invalid_type_error: "请选择评分规则" })
    .min(1, "请选择评分规则"),
  studentIds: z
    .array(z.string({ invalid_type_error: "学生 ID 无效" }).min(1, "学生 ID 无效"))
    .min(1, "请至少选择一名学生")
    .max(200, "单次批量记分最多 200 名学生"),
  occurrenceAt: z.string().trim().optional(),
  note: z.string().trim().max(500, "说明不能超过 500 个字符").optional(),
  evidenceIds: evidenceIdsSchema,
});

const reasonSchema = z.object({
  reason: z
    .string({ required_error: "请填写操作理由", invalid_type_error: "请填写操作理由" })
    .trim()
    .min(2, "操作理由至少需要 2 个字符")
    .max(300, "操作理由不能超过 300 个字符"),
});

const correctSchema = z.object({
  reason: z
    .string({ required_error: "请填写更正理由", invalid_type_error: "请填写更正理由" })
    .trim()
    .min(2, "更正理由至少需要 2 个字符")
    .max(300, "更正理由不能超过 300 个字符"),
  ruleId: z.string().trim().optional(),
  points: optionalInteger("更正后的分值", { min: 1, max: 1000 }),
  note: z.string().trim().max(500, "更正说明不能超过 500 个字符").optional(),
});

const reviewApproveSchema = z.object({
  note: z.string().trim().max(500, "复核说明不能超过 500 个字符").optional(),
});

// ------------------------------------------------------------------ primitives
export function withTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 事务可能已被 SQLite 自动回滚
    }
    throw error;
  }
}

/** 把数据库触发器/唯一索引错误翻译成用户可理解的中文 400 错误。 */
export function translateLedgerError(error) {
  const raw = String(error?.message || "");
  if (raw.includes("UNIQUE constraint failed: score_records.reverses_record_id"))
    throw httpError(400, "该积分记录已存在生效冲正，不能重复冲正");
  if (raw.includes("积分账本记录不可删除") || raw.includes("已生效或已驳回的积分记录不可修改"))
    throw httpError(400, "积分账本只追加，不允许修改或删除已生效记录，请使用冲正/更正");
  if (raw.includes("UNIQUE constraint failed")) throw httpError(400, "数据重复，操作已被拒绝");
  throw error;
}

function runLedgerTransaction(db, fn) {
  try {
    return withTransaction(db, fn);
  } catch (error) {
    translateLedgerError(error);
  }
}

function safeJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function buildSnapshot(version, categoryName, direction, points) {
  return {
    name: version.name,
    categoryId: version.category_id,
    categoryName: categoryName || "",
    direction,
    points,
    version: version.version,
    description: version.description || "",
    examples: version.examples || "",
  };
}

/**
 * 待复核策略：规则显式要求复核、分值达到学校阈值、或竞赛荣誉类加分 >= 10。
 * 仅对值日老师录入生效；德育处/管理员录入默认直接生效。
 */
export function shouldRequireReview(settingsValue, version, categoryName) {
  if (!version) return false;
  if (Number(version.requires_review) === 1) return true;
  if (Number(version.points) >= Number(settingsValue.reviewThreshold || 10)) return true;
  if (
    String(categoryName || "").includes("竞赛荣誉") &&
    version.direction === "ADD" &&
    Number(version.points) >= 10
  )
    return true;
  return false;
}

/**
 * 写入一条账本记录（唯一写入口）。
 * 返回 score_records 原始行；调用方用 ledger.recordViews 序列化。
 */
export function createLedgerEntry(ctx, options) {
  const { db, audit, settings } = ctx;
  const {
    req = null,
    user,
    student,
    version = null,
    occurrenceAt,
    note = "",
    evidenceIds = [],
    source = "TEACHER",
    status = null,
    recordKind = "STANDARD",
    direction,
    points,
    reversesRecordId = null,
    correctsRecordId = null,
    submissionId = null,
    batchId = null,
    reviewer = null,
    reviewNote = "",
    snapshot = null,
    categoryName = "",
    categoryId = null,
    ruleId = null,
    ruleVersionId = null,
    term = null,
    academicYearId = null,
    skipAudit = false,
    auditAction = null,
    auditSummary = "",
  } = options;
  if (!user) throw new Error("createLedgerEntry 缺少操作者");
  if (!student) throw new Error("createLedgerEntry 缺少学生");
  if (!["STANDARD", "REVERSAL", "CORRECTION"].includes(recordKind))
    throw new Error("非法账本记录类型");
  const when = isoDateTime(occurrenceAt || iso(), "发生时间");
  const resolvedTerm = term || resolveTermForDate(db, user.school_id, when);
  const termId = resolvedTerm.id;
  const yearId = academicYearId || resolvedTerm.academic_year_id;
  const finalDirection = direction || version?.direction;
  const finalPoints = points ?? version?.points;
  if (!["ADD", "DEDUCT"].includes(finalDirection)) throw httpError(400, "加减分方向无效");
  if (!Number.isSafeInteger(finalPoints) || finalPoints <= 0 || finalPoints > 1000)
    throw httpError(400, "分值必须为 1 到 1000 之间的整数");
  if ((recordKind === "STANDARD" || recordKind === "CORRECTION") && !snapshot && !version)
    throw new Error("createLedgerEntry 缺少规则版本或规则快照");
  if (recordKind === "REVERSAL" && !reversesRecordId) throw new Error("冲正记录必须关联原记录");
  if (recordKind === "CORRECTION" && !correctsRecordId)
    throw new Error("更正记录必须关联被更正记录");

  let finalStatus = status;
  if (!finalStatus) {
    finalStatus =
      user.role === "DUTY_TEACHER" &&
      recordKind === "STANDARD" &&
      shouldRequireReview(settings.get(user.school_id), version, categoryName)
        ? "PENDING_REVIEW"
        : "EFFECTIVE";
  }
  if (!["EFFECTIVE", "PENDING_REVIEW", "REJECTED"].includes(finalStatus))
    throw new Error("非法账本状态");
  const now = iso();
  const isEffective = finalStatus === "EFFECTIVE";
  const finalReviewer = isEffective ? reviewer || user : null;
  // 分类名兜底：版本行通常已带 category_name（resolveRuleForScoring 附带），
  // 缺失时再按 category_id 查一次，避免调用方漏传导致空分类进入仪表盘聚合。
  let resolvedCategoryName = categoryName || version?.category_name || "";
  if (!resolvedCategoryName && version?.category_id) {
    const categoryRow = db
      .prepare("SELECT name FROM scoring_categories WHERE id=?")
      .get(version.category_id);
    resolvedCategoryName = categoryRow?.name || "";
  }
  const snapshotData =
    snapshot || buildSnapshot(version, resolvedCategoryName, finalDirection, finalPoints);
  const finalCategoryId = categoryId ?? version?.category_id ?? snapshotData.categoryId ?? null;
  const finalCategoryName = resolvedCategoryName || snapshotData.categoryName || "";
  const finalRuleId = ruleId ?? version?.rule_id ?? null;
  const finalRuleVersionId = ruleVersionId ?? version?.id ?? null;
  const id = uid();
  db.prepare(
    `INSERT INTO score_records(
       id,school_id,academic_year_id,term_id,student_id,class_id,grade_id,
       rule_id,rule_version_id,rule_snapshot_json,category_id,category_name,
       direction,points,signed_points,record_kind,status,occurrence_at,note,evidence_json,
       source,submitter_id,reviewer_id,reviewed_at,review_note,submission_id,
       reverses_record_id,corrects_record_id,batch_id,created_at,effective_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    user.school_id,
    yearId,
    termId,
    student.id,
    student.class_id,
    student.grade_id,
    finalRuleId,
    finalRuleVersionId,
    JSON.stringify(snapshotData),
    finalCategoryId,
    finalCategoryName,
    finalDirection,
    finalPoints,
    finalDirection === "ADD" ? finalPoints : -finalPoints,
    recordKind,
    finalStatus,
    when,
    String(note || "").slice(0, 500),
    JSON.stringify(Array.isArray(evidenceIds) ? evidenceIds : []),
    source,
    user.id,
    finalReviewer?.id ?? null,
    isEffective ? now : null,
    isEffective ? String(reviewNote || "").slice(0, 500) : "",
    submissionId,
    reversesRecordId,
    correctsRecordId,
    batchId,
    now,
    isEffective ? now : null,
  );
  if (!skipAudit) {
    const defaultAction =
      recordKind === "REVERSAL"
        ? "SCORE_REVERSAL"
        : recordKind === "CORRECTION"
          ? "SCORE_CORRECTION"
          : "SCORE_RECORD_CREATE";
    audit.record({
      req,
      user,
      action: auditAction || defaultAction,
      targetType: "SCORE_RECORD",
      targetId: id,
      summary:
        auditSummary ||
        `${RECORD_STATUS_LABELS[finalStatus] || finalStatus}：${student.name || "学生"} ${
          DIRECTION_LABELS[finalDirection]
        } ${finalPoints} 分（${snapshotData.name || finalCategoryName || "积分"}）`,
      after: {
        recordId: id,
        recordKind,
        status: finalStatus,
        direction: finalDirection,
        points: finalPoints,
        ruleId: finalRuleId,
        reviewerId: finalReviewer?.id ?? null,
        submissionId,
        reversesRecordId,
        correctsRecordId,
      },
    });
  }
  return db.prepare("SELECT * FROM score_records WHERE id=?").get(id);
}

/** 冲正：新增一条相反方向、相同分值的 REVERSAL 记录（原记录永不修改）。 */
export function reversalEntry(ctx, { req = null, user, record, reason, source = "MORAL_AFFAIRS" }) {
  if (!record) throw httpError(404, "积分记录不存在");
  if (record.status !== "EFFECTIVE") throw httpError(400, "仅已生效的积分记录可以冲正");
  if (record.record_kind === "REVERSAL") throw httpError(400, "冲正记录不能再次冲正");
  const existing = ctx.db
    .prepare("SELECT id FROM score_records WHERE reverses_record_id=? AND status='EFFECTIVE'")
    .get(record.id);
  if (existing) throw httpError(400, "该记录已冲正，无需重复操作");
  const student = ctx.db.prepare("SELECT * FROM students WHERE id=?").get(record.student_id);
  if (!student) throw httpError(404, "学生不存在");
  const baseSnapshot = safeJsonObject(record.rule_snapshot_json);
  const direction = record.direction === "ADD" ? "DEDUCT" : "ADD";
  return createLedgerEntry(ctx, {
    req,
    user,
    student,
    occurrenceAt: record.occurrence_at,
    note: reason,
    source,
    recordKind: "REVERSAL",
    direction,
    points: record.points,
    reversesRecordId: record.id,
    categoryName: record.category_name,
    categoryId: record.category_id,
    ruleId: record.rule_id,
    ruleVersionId: record.rule_version_id,
    snapshot: { ...baseSnapshot, direction, points: record.points, reversedRecordId: record.id },
    status: "EFFECTIVE",
    term: { id: record.term_id, academic_year_id: record.academic_year_id },
    auditSummary: `冲正积分记录（${student.name || "学生"}）：${reason}`,
  });
}

/**
 * 更正：在冲正原记录之后，新增一条 CORRECTION 记录承载新规则/分值/说明。
 * version 为空时沿用原记录规则与分值（仅更正说明）。
 */
export function correctionEntry(
  ctx,
  {
    req = null,
    user,
    record,
    version = null,
    categoryName = "",
    direction,
    points,
    note = "",
    reason,
    source = "MORAL_AFFAIRS",
  },
) {
  if (!record) throw httpError(404, "积分记录不存在");
  if (record.status !== "EFFECTIVE") throw httpError(400, "仅已生效的积分记录可以更正");
  const student = ctx.db.prepare("SELECT * FROM students WHERE id=?").get(record.student_id);
  if (!student) throw httpError(404, "学生不存在");
  const baseSnapshot = safeJsonObject(record.rule_snapshot_json);
  const finalDirection = direction || version?.direction || record.direction;
  const finalPoints = points ?? version?.points ?? record.points;
  const finalCategoryName = categoryName || version?.category_name || record.category_name;
  const snapshot = version
    ? buildSnapshot(version, finalCategoryName, finalDirection, finalPoints)
    : {
        ...baseSnapshot,
        categoryName: finalCategoryName,
        direction: finalDirection,
        points: finalPoints,
        correctedFromRecordId: record.id,
      };
  return createLedgerEntry(ctx, {
    req,
    user,
    student,
    occurrenceAt: record.occurrence_at,
    note: note || reason,
    source,
    recordKind: "CORRECTION",
    direction: finalDirection,
    points: finalPoints,
    correctsRecordId: record.id,
    version: version || null,
    categoryName: finalCategoryName,
    categoryId: version ? version.category_id : record.category_id,
    ruleId: version ? version.rule_id : record.rule_id,
    ruleVersionId: version ? version.id : record.rule_version_id,
    snapshot,
    status: "EFFECTIVE",
    term: { id: record.term_id, academic_year_id: record.academic_year_id },
    auditSummary: `更正积分记录（${student.name || "学生"}）：${reason}`,
  });
}

function recordView(ctx, row) {
  return recordViews(ctx.db, [row])[0];
}

function loadScopedRecord(ctx, user, recordId) {
  const record = ctx.db
    .prepare("SELECT * FROM score_records WHERE id=? AND school_id=?")
    .get(recordId, user.school_id);
  if (!record) throw httpError(404, "积分记录不存在");
  ctx.scope.assertClassAccess(user, record.class_id);
  return record;
}

function rangeValue(value, endOfDay = false) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw))
    return `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
  return isoDateTime(raw, "时间范围");
}

function recordFilter(ctx, user, query) {
  const fullScope = ctx.scope.hasFullScope(user);
  const classIds = fullScope ? null : ctx.scope.classIdsFor(user);
  const classId = String(query.classId || "").trim();
  if (classId) ctx.scope.assertClassAccess(user, classId);
  const studentId = String(query.studentId || "").trim();
  if (studentId) ctx.scope.assertStudentAccess(user, studentId);
  const direction = String(query.direction || "").trim();
  if (direction && !["ADD", "DEDUCT"].includes(direction)) throw httpError(400, "加减分方向无效");
  const status = String(query.status || "").trim();
  if (status && !Object.keys(RECORD_STATUS_LABELS).includes(status))
    throw httpError(400, "记录状态无效");
  return recordListWhere({
    termId: String(query.termId || "").trim(),
    classId,
    classIds,
    gradeId: String(query.gradeId || "").trim(),
    studentId,
    categoryId: String(query.categoryId || "").trim(),
    direction,
    status,
    from: rangeValue(query.from),
    to: rangeValue(query.to, true),
    search: String(query.search || "").trim(),
  });
}

function recordWhereSql(filter) {
  return `FROM score_records r JOIN students s ON s.id=r.student_id WHERE r.school_id=? AND (${filter.where})`;
}

// ------------------------------------------------------------------ routes
export function registerScoringRoutes(app, ctx) {
  const { db, auth, audit, requireManagement, requireStaff } = ctx;

  // ---- 单条记分
  app.post("/api/scoring", auth, requireStaff, (req, res) => {
    const body = parseBody(singleScoreSchema, req.body);
    const student = ctx.scope.assertStudentAccess(req.user, body.studentId);
    const when = isoDateTime(body.occurrenceAt || iso(), "发生时间");
    const resolved = resolveRuleForScoring(db, {
      ruleId: body.ruleId,
      at: when,
      classId: student.class_id,
      gradeId: student.grade_id,
      schoolId: req.user.school_id,
    });
    if (resolved.version.evidence_required && !(body.evidenceIds || []).length)
      throw httpError(400, "该评分规则要求上传证据，请先上传证据文件");
    const evidenceIds = validateEvidenceIds(db, {
      evidenceIds: body.evidenceIds || [],
      studentId: student.id,
      classId: student.class_id,
    });
    const source = req.user.role === "DUTY_TEACHER" ? "TEACHER" : "MORAL_AFFAIRS";
    const record = createLedgerEntry(ctx, {
      req,
      user: req.user,
      student,
      version: resolved.version,
      categoryName: resolved.categoryName,
      occurrenceAt: when,
      note: body.note || "",
      evidenceIds,
      source,
      auditSummary: `记分：${student.name} ${DIRECTION_LABELS[resolved.version.direction]} ${resolved.version.points} 分（${resolved.version.name}）`,
    });
    res.status(201).json({ record: recordView(ctx, record) });
  });

  // ---- 批量记分：事务全有或全无
  app.post("/api/scoring/batch", auth, requireStaff, (req, res) => {
    const body = parseBody(batchScoreSchema, req.body);
    const studentIds = [...new Set(body.studentIds)];
    const when = isoDateTime(body.occurrenceAt || iso(), "发生时间");
    const source = req.user.role === "DUTY_TEACHER" ? "TEACHER" : "MORAL_AFFAIRS";
    // 先逐条解析并校验（不写库），任何一条失败都不产生记录。
    const plans = studentIds.map((studentId) => {
      const student = ctx.scope.assertStudentAccess(req.user, studentId);
      const resolved = resolveRuleForScoring(db, {
        ruleId: body.ruleId,
        at: when,
        classId: student.class_id,
        gradeId: student.grade_id,
        schoolId: req.user.school_id,
      });
      if (resolved.version.evidence_required && !(body.evidenceIds || []).length)
        throw httpError(400, "该评分规则要求上传证据，请先上传证据文件");
      const evidenceIds = validateEvidenceIds(db, {
        evidenceIds: body.evidenceIds || [],
        studentId: student.id,
        classId: student.class_id,
      });
      return { student, resolved, evidenceIds };
    });
    const batchId = uid();
    let records = [];
    try {
      runLedgerTransaction(db, () => {
        records = plans.map((plan) =>
          createLedgerEntry(ctx, {
            req,
            user: req.user,
            student: plan.student,
            version: plan.resolved.version,
            categoryName: plan.resolved.categoryName,
            occurrenceAt: when,
            note: body.note || "",
            evidenceIds: plan.evidenceIds,
            source,
            batchId,
            skipAudit: true,
          }),
        );
      });
    } catch (error) {
      translateLedgerError(error);
    }
    const pendingReview = records.filter((row) => row.status === "PENDING_REVIEW").length;
    audit.record({
      req,
      user: req.user,
      action: "SCORE_BATCH_CREATE",
      targetType: "SCORE_BATCH",
      targetId: batchId,
      summary: `批量记分：${records.length} 条（规则「${plans[0]?.resolved.version.name || ""}」，待复核 ${pendingReview} 条）`,
      after: { batchId, created: records.length, pendingReview, studentIds },
    });
    res.status(201).json({
      records: recordViews(db, records),
      summary: { created: records.length, pendingReview },
    });
  });

  // ---- CSV 导出（必须在 /api/records/:id 之前注册）
  app.get("/api/records/export.csv", auth, requireStaff, (req, res) => {
    const filter = recordFilter(ctx, req.user, req.query || {});
    const rows = db
      .prepare(
        `SELECT r.* ${recordWhereSql(filter)} ORDER BY r.occurrence_at DESC, r.created_at DESC LIMIT 10000`,
      )
      .all(req.user.school_id, ...filter.params);
    const views = recordViews(db, rows);
    ctx.sendCsv(
      res,
      `moral-score-records-${iso().slice(0, 10)}.csv`,
      [
        "记录ID",
        "学生姓名",
        "学号",
        "班级",
        "年级",
        "规则名称",
        "分类",
        "方向",
        "分值",
        "记录状态",
        "记录类型",
        "发生时间",
        "来源",
        "提交人",
        "复核人",
        "说明",
        "是否已冲正",
      ],
      views.map((row) => [
        row.id,
        row.studentName,
        row.studentNo,
        row.className,
        row.gradeName,
        row.ruleName,
        row.categoryName,
        row.directionLabel,
        row.signedPoints,
        row.statusLabel,
        row.recordKindLabel,
        row.occurrenceAt,
        row.sourceLabel,
        row.submitterName,
        row.reviewerName,
        row.note,
        row.reversed ? "是" : "否",
      ]),
    );
  });

  // ---- 账本查询
  app.get("/api/records", auth, requireStaff, (req, res) => {
    const filter = recordFilter(ctx, req.user, req.query || {});
    const { page, pageSize, offset } = paginate(req.query || {});
    const total = db
      .prepare(`SELECT COUNT(*) AS total ${recordWhereSql(filter)}`)
      .get(req.user.school_id, ...filter.params).total;
    const rows = db
      .prepare(
        `SELECT r.* ${recordWhereSql(filter)} ORDER BY r.occurrence_at DESC, r.created_at DESC, r.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(req.user.school_id, ...filter.params, pageSize, offset);
    res.json(pageResult(recordViews(db, rows), total, { page, pageSize }));
  });

  // ---- 账本详情与关联关系
  app.get("/api/records/:id", auth, requireStaff, (req, res) => {
    const record = loadScopedRecord(ctx, req.user, req.params.id);
    const reversal = db
      .prepare("SELECT * FROM score_records WHERE reverses_record_id=? AND status='EFFECTIVE'")
      .get(record.id);
    const correctedByRows = db
      .prepare("SELECT * FROM score_records WHERE corrects_record_id=? ORDER BY created_at")
      .all(record.id);
    const correctsRow = record.corrects_record_id
      ? db.prepare("SELECT * FROM score_records WHERE id=?").get(record.corrects_record_id)
      : null;
    const appealRows = db
      .prepare(
        `SELECT a.*, u.display_name AS submitted_by_name
         FROM appeals a LEFT JOIN users u ON u.id=a.submitted_by
         WHERE a.record_id=? ORDER BY a.created_at DESC`,
      )
      .all(record.id);
    res.json({
      record: recordView(ctx, record),
      relations: {
        reversal: reversal ? recordView(ctx, reversal) : null,
        correctedBy: correctedByRows.length ? recordView(ctx, correctedByRows[0]) : null,
        corrects: correctsRow ? recordView(ctx, correctsRow) : null,
        appeals: appealRows.map((row) => ({
          id: row.id,
          status: row.status,
          statusLabel: APPEAL_STATUS_LABELS[row.status] || row.status,
          reason: row.reason,
          submittedByName: row.submitted_by_name || "",
          createdAt: row.created_at,
          decidedAt: row.decided_at,
          decisionReason: row.decision_reason,
          conflictFlag: Boolean(row.conflict_flag),
        })),
      },
    });
  });

  // ---- 冲正
  app.post("/api/records/:id/revoke", auth, requireManagement, (req, res) => {
    const body = parseBody(reasonSchema, req.body);
    const record = loadScopedRecord(ctx, req.user, req.params.id);
    let reversal = null;
    try {
      runLedgerTransaction(db, () => {
        reversal = reversalEntry(ctx, {
          req,
          user: req.user,
          record,
          reason: body.reason,
        });
      });
    } catch (error) {
      translateLedgerError(error);
    }
    const original = db.prepare("SELECT * FROM score_records WHERE id=?").get(record.id);
    res.json({
      reversal: recordView(ctx, reversal),
      record: recordView(ctx, original),
    });
  });

  // ---- 更正（冲正 + 新 CORRECTION 记录）
  app.post("/api/records/:id/correct", auth, requireManagement, (req, res) => {
    const body = parseBody(correctSchema, req.body);
    const record = loadScopedRecord(ctx, req.user, req.params.id);
    if (record.record_kind === "REVERSAL") throw httpError(400, "冲正记录不能更正");
    const existing = db
      .prepare("SELECT id FROM score_records WHERE reverses_record_id=? AND status='EFFECTIVE'")
      .get(record.id);
    if (existing) throw httpError(400, "该记录已冲正，不能重复更正");
    let resolved = null;
    if (body.ruleId) {
      resolved = resolveRuleForScoring(db, {
        ruleId: body.ruleId,
        at: iso(),
        classId: record.class_id,
        gradeId: record.grade_id,
        schoolId: req.user.school_id,
      });
    }
    const hasChange = Boolean(resolved || body.points !== undefined || body.note);
    if (!hasChange) throw httpError(400, "请填写更正后的规则、分值或说明");
    if (record.status !== "EFFECTIVE") throw httpError(400, "仅已生效的积分记录可以更正");
    let reversal = null;
    let correction = null;
    try {
      runLedgerTransaction(db, () => {
        reversal = reversalEntry(ctx, {
          req,
          user: req.user,
          record,
          reason: body.reason,
          source: "MORAL_AFFAIRS",
        });
        correction = correctionEntry(ctx, {
          req,
          user: req.user,
          record,
          version: resolved?.version || null,
          categoryName: resolved?.categoryName || "",
          points: body.points,
          note: body.note || body.reason,
          reason: body.reason,
          source: "MORAL_AFFAIRS",
        });
      });
    } catch (error) {
      translateLedgerError(error);
    }
    const original = db.prepare("SELECT * FROM score_records WHERE id=?").get(record.id);
    res.json({
      reversal: recordView(ctx, reversal),
      correction: recordView(ctx, correction),
      record: recordView(ctx, original),
    });
  });

  // ---- 待复核：通过
  app.post("/api/records/:id/approve", auth, requireManagement, (req, res) => {
    const body = parseBody(reviewApproveSchema, req.body);
    const record = loadScopedRecord(ctx, req.user, req.params.id);
    if (record.status !== "PENDING_REVIEW")
      throw httpError(400, "只有待复核的积分记录可以审批");
    const now = iso();
    db.prepare(
      "UPDATE score_records SET status='EFFECTIVE', reviewer_id=?, reviewed_at=?, review_note=?, effective_at=? WHERE id=?",
    ).run(req.user.id, now, body.note || "", now, record.id);
    audit.record({
      req,
      user: req.user,
      action: "RECORD_APPROVE",
      targetType: "SCORE_RECORD",
      targetId: record.id,
      summary: `复核通过积分记录：${record.category_name || ""} ${record.points} 分`,
      before: { status: record.status, reviewerId: null },
      after: { status: "EFFECTIVE", reviewerId: req.user.id },
    });
    const updated = db.prepare("SELECT * FROM score_records WHERE id=?").get(record.id);
    res.json({ record: recordView(ctx, updated) });
  });

  // ---- 待复核：驳回
  app.post("/api/records/:id/reject", auth, requireManagement, (req, res) => {
    const body = parseBody(reasonSchema, req.body);
    const record = loadScopedRecord(ctx, req.user, req.params.id);
    if (record.status !== "PENDING_REVIEW")
      throw httpError(400, "只有待复核的积分记录可以驳回");
    const now = iso();
    db.prepare(
      "UPDATE score_records SET status='REJECTED', reviewer_id=?, reviewed_at=?, review_note=? WHERE id=?",
    ).run(req.user.id, now, body.reason, record.id);
    audit.record({
      req,
      user: req.user,
      action: "RECORD_REJECT",
      targetType: "SCORE_RECORD",
      targetId: record.id,
      summary: `驳回待复核积分记录：${body.reason}`,
      before: { status: record.status },
      after: { status: "REJECTED", reviewNote: body.reason },
    });
    const updated = db.prepare("SELECT * FROM score_records WHERE id=?").get(record.id);
    res.json({ record: recordView(ctx, updated) });
  });
}
