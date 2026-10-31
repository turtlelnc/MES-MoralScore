// 申诉中心：登记（仅已生效记录）、状态流转、德育处裁决。
// 接受申诉必须走冲正/更正；裁决记录 append-only，利益冲突必须说明。
import { z } from "zod";
import { httpError, iso, pageResult, paginate, parseBody, uid } from "./core.mjs";
import { recordViews } from "./ledger.mjs";
import { evidenceSummary, validateEvidenceIds } from "./evidence.mjs";
import { resolveRuleForScoring } from "./rules.mjs";
import { correctionEntry, reversalEntry, translateLedgerError, withTransaction } from "./scoring.mjs";

const APPEAL_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED"];
const APPEAL_STATUS_LABELS = Object.freeze({
  SUBMITTED: "待处理",
  UNDER_REVIEW: "复核中",
  ACCEPTED: "已接受",
  REJECTED: "已驳回",
});
const DECISION_LABELS = Object.freeze({
  UNDER_REVIEW: "受理复核",
  ACCEPTED: "接受申诉",
  REJECTED: "驳回申诉",
});

const optionalInteger = (name, { min = 0, max = 100000 } = {}) =>
  z.preprocess(
    (value) => (value === "" || value === null || value === undefined ? undefined : value),
    z.coerce
      .number({ invalid_type_error: `${name}必须为数字` })
      .int(`${name}必须为整数`)
      .min(min, `${name}不能小于 ${min}`)
      .max(max, `${name}不能大于 ${max}`)
      .optional(),
  );

const createAppealSchema = z.object({
  recordId: z
    .string({ required_error: "请选择要申诉的积分记录", invalid_type_error: "请选择要申诉的积分记录" })
    .min(1, "请选择要申诉的积分记录"),
  reason: z
    .string({ required_error: "请填写申诉理由", invalid_type_error: "请填写申诉理由" })
    .trim()
    .min(2, "申诉理由至少需要 2 个字符")
    .max(1000, "申诉理由不能超过 1000 个字符"),
  evidenceIds: z
    .array(z.string({ invalid_type_error: "证据 ID 无效" }).min(1, "证据 ID 无效"))
    .max(5, "单条申诉最多关联 5 个证据文件")
    .optional(),
});

const startReviewSchema = z.object({
  note: z.string().trim().max(500, "受理说明不能超过 500 个字符").optional(),
});

const correctionSchema = z.object({
  mode: z
    .enum(["REVOKE", "REPLACE"], { errorMap: () => ({ message: "更正方式无效" }) })
    .optional(),
  ruleId: z.string().trim().optional(),
  points: optionalInteger("更正后的分值", { min: 1, max: 1000 }),
  note: z.string().trim().max(500, "更正说明不能超过 500 个字符").optional(),
});

const decideSchema = z.object({
  decision: z.enum(["ACCEPTED", "REJECTED"], {
    errorMap: () => ({ message: "裁决结果无效" }),
  }),
  reason: z
    .string({ required_error: "请填写裁决理由", invalid_type_error: "请填写裁决理由" })
    .trim()
    .min(2, "裁决理由至少需要 2 个字符")
    .max(1000, "裁决理由不能超过 1000 个字符"),
  conflictReason: z.string().trim().max(500, "利益冲突说明不能超过 500 个字符").optional(),
  correction: correctionSchema.optional(),
});

const APPEAL_SELECT = `
  SELECT a.*, s.name AS student_name, s.student_no AS student_no, c.name AS class_name, g.name AS grade_name,
         u1.display_name AS submitted_by_name,
         u2.display_name AS handler_name
  FROM appeals a
  JOIN students s ON s.id = a.student_id
  JOIN classes c ON c.id = a.class_id
  JOIN grades g ON g.id = c.grade_id
  LEFT JOIN users u1 ON u1.id = a.submitted_by
  LEFT JOIN users u2 ON u2.id = COALESCE(a.decided_by, a.handler_id)`;

/** evidence_json 是证据 id 数组；解析失败时按空数组处理，避免坏数据影响列表。 */
function parseEvidenceIds(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function appealView(db, row) {
  return {
    id: row.id,
    recordId: row.record_id,
    studentId: row.student_id,
    studentName: row.student_name || "",
    studentNo: row.student_no || "",
    classId: row.class_id,
    className: row.class_name || "",
    gradeName: row.grade_name || "",
    status: row.status,
    statusLabel: APPEAL_STATUS_LABELS[row.status] || row.status,
    reason: row.reason,
    evidence: evidenceSummary(db, parseEvidenceIds(row.evidence_json)),
    submittedByName: row.submitted_by_name || "",
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    conflictFlag: Boolean(row.conflict_flag),
    conflictReason: row.conflict_reason,
    handlerName: row.handler_name || "",
    reversalRecordId: row.reversal_record_id,
    correctionRecordId: row.correction_record_id,
  };
}

function decisionView(row) {
  return {
    id: row.id,
    decision: row.decision,
    decisionLabel: DECISION_LABELS[row.decision] || row.decision,
    reason: row.reason,
    actorName: row.actor_name || "",
    conflictFlag: Boolean(row.conflict_flag),
    conflictReason: row.conflict_reason,
    reversalRecordId: row.reversal_record_id,
    correctionRecordId: row.correction_record_id,
    createdAt: row.created_at,
  };
}

function loadAppealRow(db, schoolId, appealId) {
  return db.prepare(`${APPEAL_SELECT} WHERE a.id=? AND a.school_id=?`).get(appealId, schoolId);
}

function insertDecision(db, entry) {
  const id = uid();
  db.prepare(
    `INSERT INTO appeal_decisions(id,appeal_id,actor_id,decision,reason,conflict_flag,conflict_reason,reversal_record_id,correction_record_id,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    entry.appealId,
    entry.actorId,
    entry.decision,
    entry.reason || "",
    entry.conflictFlag ? 1 : 0,
    entry.conflictReason || "",
    entry.reversalRecordId ?? null,
    entry.correctionRecordId ?? null,
    iso(),
  );
  return id;
}

function activeReversal(db, recordId) {
  return db
    .prepare("SELECT id FROM score_records WHERE reverses_record_id=? AND status='EFFECTIVE'")
    .get(recordId);
}

export function registerAppealRoutes(app, ctx) {
  const { db, auth, audit, requireMoral, requireStaff } = ctx;

  // ---------------------------------------------------------------- 列表
  app.get("/api/appeals", auth, requireStaff, (req, res) => {
    const query = req.query || {};
    const status = String(query.status || "").trim();
    if (status && !APPEAL_STATUSES.includes(status)) throw httpError(400, "申诉状态无效");
    const clauses = ["a.school_id=?"];
    const params = [req.user.school_id];
    if (status) {
      clauses.push("a.status=?");
      params.push(status);
    }
    const recordId = String(query.recordId || "").trim();
    if (recordId) {
      clauses.push("a.record_id=?");
      params.push(recordId);
    }
    const classId = String(query.classId || "").trim();
    if (classId) {
      ctx.scope.assertClassAccess(req.user, classId);
      clauses.push("a.class_id=?");
      params.push(classId);
    } else {
      const filter = ctx.scope.classFilter(req.user, "a.class_id");
      clauses.push(`(${filter.sql})`);
      params.push(...filter.params);
    }
    const { page, pageSize, offset } = paginate(query);
    const total = db
      .prepare(`SELECT COUNT(*) AS total FROM appeals a WHERE ${clauses.join(" AND ")}`)
      .get(...params).total;
    const rows = db
      .prepare(`${APPEAL_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset);
    res.json(pageResult(rows.map((row) => appealView(db, row)), total, { page, pageSize }));
  });

  // ---------------------------------------------------------------- 登记申诉
  app.post("/api/appeals", auth, requireStaff, (req, res) => {
    const body = parseBody(createAppealSchema, req.body);
    const record = db
      .prepare("SELECT * FROM score_records WHERE id=? AND school_id=?")
      .get(body.recordId, req.user.school_id);
    if (!record) throw httpError(404, "积分记录不存在");
    ctx.scope.assertClassAccess(req.user, record.class_id);
    if (record.status !== "EFFECTIVE") throw httpError(400, "只能对已生效的积分记录发起申诉");
    if (activeReversal(db, record.id)) throw httpError(400, "该记录已冲正，无需再发起申诉");
    const open = db
      .prepare("SELECT id FROM appeals WHERE record_id=? AND status IN ('SUBMITTED','UNDER_REVIEW')")
      .get(record.id);
    if (open) throw httpError(400, "该记录已有未结申诉，请勿重复提交");
    const evidenceIds = validateEvidenceIds(db, {
      evidenceIds: body.evidenceIds || [],
      studentId: record.student_id,
      classId: record.class_id,
    });
    const now = iso();
    const id = uid();
    db.prepare(
      `INSERT INTO appeals(id,school_id,record_id,student_id,class_id,reason,evidence_json,status,submitted_by,handler_id,decided_by,decided_at,decision_reason,conflict_flag,conflict_reason,reversal_record_id,correction_record_id,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?, 'SUBMITTED', ?,NULL,NULL,NULL,'',0,'',NULL,NULL,?,?)`,
    ).run(
      id,
      req.user.school_id,
      record.id,
      record.student_id,
      record.class_id,
      body.reason,
      JSON.stringify(evidenceIds),
      req.user.id,
      now,
      now,
    );
    audit.record({
      req,
      user: req.user,
      action: "APPEAL_CREATE",
      targetType: "APPEAL",
      targetId: id,
      summary: `登记申诉：${record.category_name || "积分"}记录（${body.reason}）`,
      after: { appealId: id, recordId: record.id, status: "SUBMITTED" },
    });
    res.status(201).json({ appeal: appealView(db, loadAppealRow(db, req.user.school_id, id)) });
  });

  // ---------------------------------------------------------------- 详情
  app.get("/api/appeals/:id", auth, requireStaff, (req, res) => {
    const row = loadAppealRow(db, req.user.school_id, req.params.id);
    if (!row) throw httpError(404, "申诉不存在");
    ctx.scope.assertClassAccess(req.user, row.class_id);
    const record = db
      .prepare("SELECT * FROM score_records WHERE id=? AND school_id=?")
      .get(row.record_id, req.user.school_id);
    const decisions = db
      .prepare(
        `SELECT d.*, u.display_name AS actor_name FROM appeal_decisions d
         LEFT JOIN users u ON u.id=d.actor_id
         WHERE d.appeal_id=? ORDER BY d.created_at ASC, d.rowid ASC`,
      )
      .all(row.id);
    res.json({
      appeal: appealView(db, row),
      record: record ? recordViews(db, [record])[0] : null,
      decisions: decisions.map(decisionView),
    });
  });

  // ---------------------------------------------------------------- 开始复核（仅德育处）
  app.post("/api/appeals/:id/start-review", auth, requireMoral, (req, res) => {
    const body = parseBody(startReviewSchema, req.body);
    const row = loadAppealRow(db, req.user.school_id, req.params.id);
    if (!row) throw httpError(404, "申诉不存在");
    if (row.status !== "SUBMITTED") throw httpError(400, "只有待处理的申诉可以开始复核");
    const reason = body.note || "已受理申诉，进入复核";
    db.exec("BEGIN");
    try {
      db.prepare(
        "UPDATE appeals SET status='UNDER_REVIEW', handler_id=?, updated_at=? WHERE id=?",
      ).run(req.user.id, iso(), row.id);
      insertDecision(db, {
        appealId: row.id,
        actorId: req.user.id,
        decision: "UNDER_REVIEW",
        reason,
        conflictFlag: false,
        conflictReason: "",
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      translateLedgerError(error);
    }
    audit.record({
      req,
      user: req.user,
      action: "APPEAL_START_REVIEW",
      targetType: "APPEAL",
      targetId: row.id,
      summary: `受理申诉并开始复核：${reason}`,
      before: { status: row.status },
      after: { status: "UNDER_REVIEW" },
    });
    res.json({ appeal: appealView(db, loadAppealRow(db, req.user.school_id, row.id)) });
  });

  // ---------------------------------------------------------------- 裁决（仅德育处）
  app.post("/api/appeals/:id/decide", auth, requireMoral, (req, res) => {
    const body = parseBody(decideSchema, req.body);
    const appeal = loadAppealRow(db, req.user.school_id, req.params.id);
    if (!appeal) throw httpError(404, "申诉不存在");
    if (!["SUBMITTED", "UNDER_REVIEW"].includes(appeal.status))
      throw httpError(400, "该申诉已裁决，不能重复处理");
    const record = db
      .prepare("SELECT * FROM score_records WHERE id=? AND school_id=?")
      .get(appeal.record_id, req.user.school_id);
    if (!record) throw httpError(404, "申诉关联的积分记录不存在");
    // 裁决人 == 原记录提交人 ⇒ 利益冲突，必须记录例外原因。
    const conflictFlag = record.submitter_id === req.user.id;
    let conflictReason = body.conflictReason || "";
    if (conflictFlag && !conflictReason.trim())
      throw httpError(400, "您是该积分记录的原提交人，存在利益冲突，请填写利益冲突说明后再裁决");

    if (body.decision === "REJECTED") {
      const now = iso();
      db.exec("BEGIN");
      try {
        db.prepare(
          `UPDATE appeals SET status='REJECTED', handler_id=COALESCE(handler_id,?), decided_by=?, decided_at=?,
             decision_reason=?, conflict_flag=?, conflict_reason=?, updated_at=? WHERE id=?`,
        ).run(
          req.user.id,
          req.user.id,
          now,
          body.reason,
          conflictFlag ? 1 : 0,
          conflictReason,
          now,
          appeal.id,
        );
        insertDecision(db, {
          appealId: appeal.id,
          actorId: req.user.id,
          decision: "REJECTED",
          reason: body.reason,
          conflictFlag,
          conflictReason,
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        translateLedgerError(error);
      }
      audit.record({
        req,
        user: req.user,
        action: "APPEAL_DECIDE",
        targetType: "APPEAL",
        targetId: appeal.id,
        summary: `驳回申诉：${body.reason}`,
        before: { status: appeal.status },
        after: { status: "REJECTED", conflictFlag },
      });
      return res.json({
        appeal: appealView(db, loadAppealRow(db, req.user.school_id, appeal.id)),
      });
    }

    // ---- 接受申诉：必须通过冲正/更正处理账本
    if (record.status !== "EFFECTIVE") throw httpError(400, "申诉关联的积分记录已不是生效状态");
    if (activeReversal(db, record.id)) throw httpError(400, "该积分记录已被冲正，无法重复处理");
    const mode = body.correction?.mode || "REVOKE";
    let resolved = null;
    let correctionPoints = body.correction?.points;
    let correctionNote = body.correction?.note || "";
    if (mode === "REPLACE") {
      if (body.correction?.ruleId) {
        resolved = resolveRuleForScoring(db, {
          ruleId: body.correction.ruleId,
          at: iso(),
          classId: record.class_id,
          gradeId: record.grade_id,
          schoolId: req.user.school_id,
        });
      }
      if (!resolved && correctionPoints === undefined && !correctionNote)
        throw httpError(400, "更正处理请选择新的评分规则、分值或说明");
    }
    const now = iso();
    let reversal = null;
    let correction = null;
    let decisionId = null;
    db.exec("BEGIN");
    try {
      if (appeal.status === "SUBMITTED") {
        db.prepare(
          "UPDATE appeals SET status='UNDER_REVIEW', handler_id=COALESCE(handler_id,?), updated_at=? WHERE id=?",
        ).run(req.user.id, now, appeal.id);
        insertDecision(db, {
          appealId: appeal.id,
          actorId: req.user.id,
          decision: "UNDER_REVIEW",
          reason: "受理申诉，进入复核",
        });
      }
      reversal = reversalEntry(ctx, {
        req,
        user: req.user,
        record,
        reason: `申诉接受：${body.reason}`,
        source: "APPEAL",
      });
      if (mode === "REPLACE") {
        correction = correctionEntry(ctx, {
          req,
          user: req.user,
          record,
          version: resolved?.version || null,
          categoryName: resolved?.categoryName || "",
          points: correctionPoints,
          note: correctionNote || body.reason,
          reason: `申诉接受：${body.reason}`,
          source: "APPEAL",
        });
      }
      db.prepare(
        `UPDATE appeals SET status='ACCEPTED', handler_id=COALESCE(handler_id,?), decided_by=?, decided_at=?,
           decision_reason=?, conflict_flag=?, conflict_reason=?, reversal_record_id=?, correction_record_id=?, updated_at=?
         WHERE id=?`,
      ).run(
        req.user.id,
        req.user.id,
        now,
        body.reason,
        conflictFlag ? 1 : 0,
        conflictReason,
        reversal.id,
        correction?.id ?? null,
        now,
        appeal.id,
      );
      decisionId = insertDecision(db, {
        appealId: appeal.id,
        actorId: req.user.id,
        decision: "ACCEPTED",
        reason: body.reason,
        conflictFlag,
        conflictReason,
        reversalRecordId: reversal.id,
        correctionRecordId: correction?.id ?? null,
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      translateLedgerError(error);
    }
    audit.record({
      req,
      user: req.user,
      action: "APPEAL_DECIDE",
      targetType: "APPEAL",
      targetId: appeal.id,
      summary: `接受申诉（${mode === "REPLACE" ? "冲正+更正" : "仅冲正"}）：${body.reason}`,
      before: { status: appeal.status, recordId: record.id },
      after: {
        status: "ACCEPTED",
        conflictFlag,
        reversalRecordId: reversal.id,
        correctionRecordId: correction?.id ?? null,
        decisionId,
      },
    });
    res.json({
      appeal: appealView(db, loadAppealRow(db, req.user.school_id, appeal.id)),
      reversal: recordViews(db, [reversal])[0],
      correction: correction ? recordViews(db, [correction])[0] : null,
    });
  });
}
