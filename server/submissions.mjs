// 学生干部申报：班级级 token（只存 sha256、可撤销/过期）、待核实队列、
// 老师通过后才生成正式积分记录（source=STUDENT_CADRE），公开入口不泄露学生名册。
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { httpError, iso, isoDateTime, pageResult, paginate, parseBody, uid } from "./core.mjs";
import { recordViews } from "./ledger.mjs";
import { resolveRuleForScoring } from "./rules.mjs";
import { createLedgerEntry, translateLedgerError, withTransaction } from "./scoring.mjs";

const SUBMISSION_STATUSES = ["PENDING_REVIEW", "APPROVED", "REJECTED", "NEEDS_INFO"];
const SUBMISSION_STATUS_LABELS = Object.freeze({
  PENDING_REVIEW: "待核实",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  NEEDS_INFO: "需补充",
});
const TOKEN_STATUS_LABELS = Object.freeze({
  ACTIVE: "有效",
  EXPIRED: "已过期",
  REVOKED: "已撤销",
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

const directionSchema = z.enum(["ADD", "DEDUCT"], {
  errorMap: () => ({ message: "加减分方向无效" }),
});

const tokenCreateSchema = z.object({
  classId: z
    .string({ required_error: "请选择班级", invalid_type_error: "请选择班级" })
    .min(1, "请选择班级"),
  expiresInDays: optionalInteger("有效期", { min: 1, max: 365 }),
  label: z.string().trim().max(100, "链接备注不能超过 100 个字符").optional(),
});

const manualSubmissionSchema = z.object({
  studentId: z
    .string({ required_error: "请选择学生", invalid_type_error: "请选择学生" })
    .min(1, "请选择学生"),
  categoryId: z
    .string({ required_error: "请选择申报分类", invalid_type_error: "请选择申报分类" })
    .min(1, "请选择申报分类"),
  direction: directionSchema,
  description: z
    .string({ required_error: "请填写申报说明", invalid_type_error: "请填写申报说明" })
    .trim()
    .min(2, "申报说明至少需要 2 个字符")
    .max(500, "申报说明不能超过 500 个字符"),
});

const approveSchema = z.object({
  ruleId: z
    .string({ required_error: "请选择评分规则", invalid_type_error: "请选择评分规则" })
    .min(1, "请选择评分规则"),
  occurrenceAt: z.string().trim().optional(),
  note: z.string().trim().max(500, "核实说明不能超过 500 个字符").optional(),
});

const reasonSchema = z.object({
  reason: z
    .string({ required_error: "请填写处理理由", invalid_type_error: "请填写处理理由" })
    .trim()
    .min(2, "处理理由至少需要 2 个字符")
    .max(300, "处理理由不能超过 300 个字符"),
});

const publicSubmissionSchema = z.object({
  studentNo: z
    .string({ required_error: "请填写学号", invalid_type_error: "请填写学号" })
    .trim()
    .min(1, "请填写学号")
    .max(40, "学号格式不正确"),
  name: z
    .string({ required_error: "请填写姓名", invalid_type_error: "请填写姓名" })
    .trim()
    .min(1, "请填写姓名")
    .max(40, "姓名格式不正确"),
  categoryId: z
    .string({ required_error: "请选择申报分类", invalid_type_error: "请选择申报分类" })
    .min(1, "请选择申报分类"),
  direction: directionSchema,
  description: z
    .string({ required_error: "请填写申报说明", invalid_type_error: "请填写申报说明" })
    .trim()
    .min(2, "申报说明至少需要 2 个字符")
    .max(500, "申报说明不能超过 500 个字符"),
});

const SUBMISSION_SELECT = `
  SELECT sub.*, s.name AS current_student_name, s.student_no AS current_student_no,
         c.name AS class_name, g.name AS grade_name,
         cat.name AS current_category_name, u.display_name AS reviewer_name
  FROM student_submissions sub
  LEFT JOIN students s ON s.id = sub.student_id
  JOIN classes c ON c.id = sub.class_id
  JOIN grades g ON g.id = c.grade_id
  LEFT JOIN scoring_categories cat ON cat.id = sub.category_id
  LEFT JOIN users u ON u.id = sub.reviewed_by`;

function submissionView(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.current_student_name || row.student_name_snapshot || "",
    studentNo: row.current_student_no || row.student_no_snapshot || "",
    classId: row.class_id,
    className: row.class_name || "",
    gradeName: row.grade_name || "",
    categoryId: row.category_id,
    categoryName: row.current_category_name || row.category_name_snapshot || "",
    direction: row.direction,
    directionLabel: row.direction === "ADD" ? "加分" : "减分",
    description: row.description,
    status: row.status,
    statusLabel: SUBMISSION_STATUS_LABELS[row.status] || row.status,
    source: row.source,
    sourceLabel: row.source === "CADRE_LINK" ? "学生干部申报链接" : "教师登记",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
    reviewerName: row.reviewer_name || "",
    reviewNote: row.review_note,
    scoreRecordId: row.score_record_id,
  };
}

function tokenStatus(row) {
  if (row.revoked_at) return "REVOKED";
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return "EXPIRED";
  return "ACTIVE";
}

function tokenView(row) {
  const status = tokenStatus(row);
  return {
    id: row.id,
    classId: row.class_id,
    className: row.class_name || "",
    gradeName: row.grade_name || "",
    label: row.label,
    status,
    statusLabel: TOKEN_STATUS_LABELS[status],
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    createdByName: row.created_by_name || "",
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    submissionCount: row.submission_count ?? 0,
  };
}

function loadScopedSubmission(ctx, user, submissionId) {
  const row = ctx.db
    .prepare(`${SUBMISSION_SELECT} WHERE sub.id=? AND sub.school_id=?`)
    .get(submissionId, user.school_id);
  if (!row) throw httpError(404, "申报记录不存在");
  ctx.scope.assertClassAccess(user, row.class_id);
  return row;
}

function categoryById(ctx, schoolId, categoryId) {
  const category = ctx.db
    .prepare("SELECT * FROM scoring_categories WHERE id=? AND school_id=?")
    .get(categoryId, schoolId);
  if (!category) throw httpError(400, "申报分类不存在");
  return category;
}

function assertDirectionAllowed(category, direction) {
  if (category.direction_scope !== "BOTH" && category.direction_scope !== direction)
    throw httpError(
      400,
      category.direction_scope === "ADD" ? "该分类仅支持加分申报" : "该分类仅支持减分申报",
    );
}

function insertSubmission(ctx, row) {
  const now = iso();
  const id = uid();
  ctx.db.prepare(
    `INSERT INTO student_submissions(
       id,school_id,class_id,student_id,student_no_snapshot,student_name_snapshot,category_id,
       category_name_snapshot,direction,description,status,source,token_id,submitter_ip,
       created_at,updated_at,reviewed_by,reviewed_at,review_note,score_record_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'',NULL)`,
  ).run(
    id,
    row.schoolId,
    row.classId,
    row.studentId ?? null,
    row.studentNo || "",
    row.studentName || "",
    row.categoryId,
    row.categoryName || "",
    row.direction,
    row.description,
    "PENDING_REVIEW",
    row.source,
    row.tokenId ?? null,
    row.ip || "",
    now,
    now,
  );
  return id;
}

export function registerSubmissionRoutes(app, ctx) {
  const { db, auth, audit, config, requireManagement, requireStaff } = ctx;
  const publicLimiter = ctx.createRateLimiter();

  // ---------------------------------------------------------------- 申报链接
  app.post("/api/submission-tokens", auth, requireManagement, (req, res) => {
    const body = parseBody(tokenCreateSchema, req.body);
    const klass = db
      .prepare(
        `SELECT c.*, g.name AS grade_name FROM classes c JOIN grades g ON g.id=c.grade_id
         WHERE c.id=? AND c.school_id=?`,
      )
      .get(body.classId, req.user.school_id);
    if (!klass) throw httpError(400, "所选班级不存在");
    const token = randomBytes(24).toString("base64url");
    const tokenHash = ctx.sha256(token);
    const days = body.expiresInDays ?? 30;
    const now = iso();
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    const id = uid();
    db.prepare(
      `INSERT INTO submission_tokens(id,school_id,class_id,token_hash,label,expires_at,revoked_at,created_by,created_at,last_used_at,use_count)
       VALUES(?,?,?,?,?,?,NULL,?,?,NULL,0)`,
    ).run(
      id,
      req.user.school_id,
      klass.id,
      tokenHash,
      body.label || `${klass.grade_name}${klass.name} 学生干部申报入口`,
      expiresAt,
      req.user.id,
      now,
    );
    audit.record({
      req,
      user: req.user,
      action: "SUBMISSION_TOKEN_CREATE",
      targetType: "SUBMISSION_TOKEN",
      targetId: id,
      summary: `为${klass.grade_name}${klass.name}创建学生干部申报链接（${days} 天有效）`,
      after: { tokenId: id, classId: klass.id, expiresAt, label: body.label || "" },
    });
    res.status(201).json({
      id,
      token,
      url: `/#/submit/${token}`,
      expiresAt,
    });
  });

  app.get("/api/submission-tokens", auth, requireManagement, (req, res) => {
    const clauses = ["t.school_id=?"];
    const params = [req.user.school_id];
    if (req.query.classId) {
      clauses.push("t.class_id=?");
      params.push(String(req.query.classId));
    }
    const rows = db
      .prepare(
        `SELECT t.*, c.name AS class_name, g.name AS grade_name, u.display_name AS created_by_name,
           (SELECT COUNT(*) FROM student_submissions sub WHERE sub.token_id=t.id) AS submission_count
         FROM submission_tokens t
         JOIN classes c ON c.id=t.class_id
         JOIN grades g ON g.id=c.grade_id
         LEFT JOIN users u ON u.id=t.created_by
         WHERE ${clauses.join(" AND ")}
         ORDER BY t.created_at DESC`,
      )
      .all(...params);
    res.json({ items: rows.map(tokenView) });
  });

  app.post("/api/submission-tokens/:id/revoke", auth, requireManagement, (req, res) => {
    const row = db
      .prepare(
        `SELECT t.*, c.name AS class_name, g.name AS grade_name, u.display_name AS created_by_name
         FROM submission_tokens t
         JOIN classes c ON c.id=t.class_id
         JOIN grades g ON g.id=c.grade_id
         LEFT JOIN users u ON u.id=t.created_by
         WHERE t.id=? AND t.school_id=?`,
      )
      .get(req.params.id, req.user.school_id);
    if (!row) throw httpError(404, "申报链接不存在");
    if (row.revoked_at) throw httpError(400, "该申报链接已撤销");
    db.prepare("UPDATE submission_tokens SET revoked_at=? WHERE id=?").run(iso(), row.id);
    audit.record({
      req,
      user: req.user,
      action: "SUBMISSION_TOKEN_REVOKE",
      targetType: "SUBMISSION_TOKEN",
      targetId: row.id,
      summary: `撤销${row.grade_name}${row.class_name}学生干部申报链接`,
      before: { status: tokenStatus(row), revokedAt: row.revoked_at },
      after: { status: "REVOKED", revokedAt: iso() },
    });
    const updated = db
      .prepare(
        `SELECT t.*, c.name AS class_name, g.name AS grade_name, u.display_name AS created_by_name,
           (SELECT COUNT(*) FROM student_submissions sub WHERE sub.token_id=t.id) AS submission_count
         FROM submission_tokens t JOIN classes c ON c.id=t.class_id
         JOIN grades g ON g.id=c.grade_id LEFT JOIN users u ON u.id=t.created_by WHERE t.id=?`,
      )
      .get(row.id);
    res.json({ ok: true, token: tokenView(updated) });
  });

  // ---------------------------------------------------------------- 公开申报入口
  app.get("/api/public/submission/:token", (req, res) => {
    const token = String(req.params.token || "");
    const row = db
      .prepare(
        `SELECT t.*, c.name AS class_name, g.name AS grade_name
         FROM submission_tokens t JOIN classes c ON c.id=t.class_id JOIN grades g ON g.id=c.grade_id
         WHERE t.token_hash=?`,
      )
      .get(ctx.sha256(token));
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now())
      throw httpError(404, "申报链接无效或已过期");
    const categories = db
      .prepare(
        "SELECT id,name,direction_scope FROM scoring_categories WHERE school_id=? AND is_enabled=1 ORDER BY sort_order,id",
      )
      .all(row.school_id);
    res.json({
      class: { id: row.class_id, name: row.class_name, gradeName: row.grade_name },
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        directionScope: category.direction_scope,
      })),
      expiresAt: row.expires_at,
    });
  });

  app.post("/api/public/submission/:token", (req, res) => {
    const ip = ctx.clientIp(req);
    const limit = config.nodeEnv === "test" ? 1000 : 20;
    const allowed = publicLimiter.hit(`public-submission:${ip}`, {
      limit,
      windowMs: 10 * 60 * 1000,
    });
    if (!allowed.allowed) throw httpError(429, "提交过于频繁，请稍后再试");
    const token = String(req.params.token || "");
    const tokenRow = db
      .prepare(
        `SELECT t.*, c.name AS class_name, g.name AS grade_name
         FROM submission_tokens t JOIN classes c ON c.id=t.class_id JOIN grades g ON g.id=c.grade_id
         WHERE t.token_hash=?`,
      )
      .get(ctx.sha256(token));
    if (!tokenRow || tokenRow.revoked_at || new Date(tokenRow.expires_at).getTime() <= Date.now())
      throw httpError(404, "申报链接无效或已过期");
    const body = parseBody(publicSubmissionSchema, req.body);
    // 学号 + 姓名双要素匹配；失败信息不区分“学号不存在/姓名不匹配”。
    const student = db
      .prepare(
        `SELECT * FROM students
         WHERE school_id=? AND class_id=? AND student_no=? AND name=? AND status='ACTIVE'`,
      )
      .get(tokenRow.school_id, tokenRow.class_id, body.studentNo, body.name);
    if (!student) throw httpError(400, "学号与姓名不匹配，请核对后重试");
    const category = categoryById(ctx, tokenRow.school_id, body.categoryId);
    if (!category.is_enabled) throw httpError(400, "该申报分类已停用");
    assertDirectionAllowed(category, body.direction);
    const id = insertSubmission(ctx, {
      schoolId: tokenRow.school_id,
      classId: tokenRow.class_id,
      studentId: student.id,
      studentNo: student.student_no,
      studentName: student.name,
      categoryId: category.id,
      categoryName: category.name,
      direction: body.direction,
      description: body.description,
      source: "CADRE_LINK",
      tokenId: tokenRow.id,
      ip,
    });
    db.prepare(
      "UPDATE submission_tokens SET use_count=use_count+1, last_used_at=? WHERE id=?",
    ).run(iso(), tokenRow.id);
    audit.record({
      req,
      schoolId: tokenRow.school_id,
      action: "PUBLIC_SUBMISSION_CREATE",
      targetType: "SUBMISSION",
      targetId: id,
      summary: `公开学生干部申报（${tokenRow.grade_name}${tokenRow.class_name}·${category.name}）`,
      after: { submissionId: id, classId: tokenRow.class_id, status: "PENDING_REVIEW", source: "CADRE_LINK" },
    });
    res.status(201).json({ ok: true, message: "申报已提交，请等待老师核实" });
  });

  // ---------------------------------------------------------------- 待核实队列
  app.get("/api/submissions", auth, requireStaff, (req, res) => {
    const query = req.query || {};
    const status = String(query.status || "").trim();
    if (status && !SUBMISSION_STATUSES.includes(status)) throw httpError(400, "申报状态无效");
    const clauses = ["sub.school_id=?"];
    const params = [req.user.school_id];
    if (status) {
      clauses.push("sub.status=?");
      params.push(status);
    }
    const classId = String(query.classId || "").trim();
    if (classId) {
      ctx.scope.assertClassAccess(req.user, classId);
      clauses.push("sub.class_id=?");
      params.push(classId);
    } else {
      const filter = ctx.scope.classFilter(req.user, "sub.class_id");
      clauses.push(`(${filter.sql})`);
      params.push(...filter.params);
    }
    const keyword = String(query.search || "").trim();
    if (keyword) {
      const pattern = `%${keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      clauses.push(
        "(sub.student_name_snapshot LIKE ? ESCAPE '\\' OR sub.student_no_snapshot LIKE ? ESCAPE '\\' OR sub.description LIKE ? ESCAPE '\\')",
      );
      params.push(pattern, pattern, pattern);
    }
    const { page, pageSize, offset } = paginate(query);
    const total = db
      .prepare(`SELECT COUNT(*) AS total FROM student_submissions sub WHERE ${clauses.join(" AND ")}`)
      .get(...params).total;
    const rows = db
      .prepare(
        `${SUBMISSION_SELECT} WHERE ${clauses.join(" AND ")}
         ORDER BY sub.created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset);
    res.json(pageResult(rows.map(submissionView), total, { page, pageSize }));
  });

  app.get("/api/submissions/:id", auth, requireStaff, (req, res) => {
    const row = loadScopedSubmission(ctx, req.user, req.params.id);
    res.json({ submission: submissionView(row) });
  });

  // 人工登记申报（source=TEACHER），同样只创建待核实记录，不产生积分。
  app.post("/api/submissions", auth, requireStaff, (req, res) => {
    const body = parseBody(manualSubmissionSchema, req.body);
    const student = ctx.scope.assertStudentAccess(req.user, body.studentId);
    const category = categoryById(ctx, req.user.school_id, body.categoryId);
    if (!category.is_enabled) throw httpError(400, "该申报分类已停用");
    assertDirectionAllowed(category, body.direction);
    const id = insertSubmission(ctx, {
      schoolId: req.user.school_id,
      classId: student.class_id,
      studentId: student.id,
      studentNo: student.student_no,
      studentName: student.name,
      categoryId: category.id,
      categoryName: category.name,
      direction: body.direction,
      description: body.description,
      source: "TEACHER",
      tokenId: null,
      ip: ctx.clientIp(req),
    });
    audit.record({
      req,
      user: req.user,
      action: "SUBMISSION_CREATE",
      targetType: "SUBMISSION",
      targetId: id,
      summary: `登记学生干部申报：${student.name}（${category.name}）`,
      after: { submissionId: id, studentId: student.id, status: "PENDING_REVIEW", source: "TEACHER" },
    });
    const row = db.prepare(`${SUBMISSION_SELECT} WHERE sub.id=?`).get(id);
    res.status(201).json({ submission: submissionView(row) });
  });

  // 通过：必须选择 PUBLISHED 且生效/适用范围内的规则，生成正式记录。
  app.post("/api/submissions/:id/approve", auth, requireStaff, (req, res) => {
    const body = parseBody(approveSchema, req.body);
    const submission = loadScopedSubmission(ctx, req.user, req.params.id);
    if (!["PENDING_REVIEW", "NEEDS_INFO"].includes(submission.status))
      throw httpError(400, "该申报已处理，不能重复核实");
    if (!submission.student_id) throw httpError(400, "该申报未匹配到学生，无法生成积分记录");
    const student = db
      .prepare("SELECT * FROM students WHERE id=? AND school_id=?")
      .get(submission.student_id, req.user.school_id);
    if (!student) throw httpError(400, "申报关联的学生不存在");
    ctx.scope.assertClassAccess(req.user, student.class_id);
    const occurrenceAt = isoDateTime(
      body.occurrenceAt || submission.created_at,
      "发生时间",
    );
    const resolved = resolveRuleForScoring(db, {
      ruleId: body.ruleId,
      at: occurrenceAt,
      classId: student.class_id,
      gradeId: student.grade_id,
      schoolId: req.user.school_id,
    });
    const combinedNote = [submission.description, body.note].filter(Boolean).join("；");
    let record = null;
    try {
      withTransaction(db, () => {
        record = createLedgerEntry(ctx, {
          req,
          user: req.user,
          student,
          version: resolved.version,
          categoryName: resolved.categoryName,
          occurrenceAt,
          note: combinedNote,
          source: "STUDENT_CADRE",
          status: "EFFECTIVE",
          submissionId: submission.id,
          reviewer: req.user,
          reviewNote: body.note || "学生干部申报核实通过",
          auditSummary: `学生干部申报核实通过：${student.name} ${resolved.version.name}`,
        });
        const changed = db
          .prepare(
            `UPDATE student_submissions
             SET status='APPROVED', reviewed_by=?, reviewed_at=?, review_note=?, score_record_id=?, updated_at=?
             WHERE id=? AND status IN ('PENDING_REVIEW','NEEDS_INFO')`,
          )
          .run(
            req.user.id,
            iso(),
            body.note || "经核实情况属实，同意生成积分记录",
            record.id,
            iso(),
            submission.id,
          ).changes;
        if (!changed) throw httpError(400, "该申报已被其他人处理，请刷新后重试");
      });
    } catch (error) {
      translateLedgerError(error);
    }
    const updated = db.prepare(`${SUBMISSION_SELECT} WHERE sub.id=?`).get(submission.id);
    audit.record({
      req,
      user: req.user,
      action: "SUBMISSION_APPROVE",
      targetType: "SUBMISSION",
      targetId: submission.id,
      summary: `通过学生干部申报并生成积分记录：${student.name}`,
      before: { status: submission.status },
      after: { status: "APPROVED", scoreRecordId: record.id },
    });
    res.json({
      submission: submissionView(updated),
      record: recordViews(db, [record])[0],
    });
  });

  app.post("/api/submissions/:id/reject", auth, requireStaff, (req, res) => {
    const body = parseBody(reasonSchema, req.body);
    const submission = loadScopedSubmission(ctx, req.user, req.params.id);
    if (!["PENDING_REVIEW", "NEEDS_INFO"].includes(submission.status))
      throw httpError(400, "该申报已处理，不能重复操作");
    const changed = db
      .prepare(
        `UPDATE student_submissions SET status='REJECTED', reviewed_by=?, reviewed_at=?, review_note=?, updated_at=?
         WHERE id=? AND status IN ('PENDING_REVIEW','NEEDS_INFO')`,
      )
      .run(req.user.id, iso(), body.reason, iso(), submission.id).changes;
    if (!changed) throw httpError(400, "该申报已被其他人处理，请刷新后重试");
    audit.record({
      req,
      user: req.user,
      action: "SUBMISSION_REJECT",
      targetType: "SUBMISSION",
      targetId: submission.id,
      summary: `驳回学生干部申报：${body.reason}`,
    });
    const updated = db.prepare(`${SUBMISSION_SELECT} WHERE sub.id=?`).get(submission.id);
    res.json({ submission: submissionView(updated) });
  });

  app.post("/api/submissions/:id/request-info", auth, requireStaff, (req, res) => {
    const body = parseBody(reasonSchema, req.body);
    const submission = loadScopedSubmission(ctx, req.user, req.params.id);
    if (!["PENDING_REVIEW", "NEEDS_INFO"].includes(submission.status))
      throw httpError(400, "该申报已处理，不能重复操作");
    const changed = db
      .prepare(
        `UPDATE student_submissions SET status='NEEDS_INFO', reviewed_by=?, reviewed_at=?, review_note=?, updated_at=?
         WHERE id=? AND status IN ('PENDING_REVIEW','NEEDS_INFO')`,
      )
      .run(req.user.id, iso(), body.reason, iso(), submission.id).changes;
    if (!changed) throw httpError(400, "该申报已被其他人处理，请刷新后重试");
    audit.record({
      req,
      user: req.user,
      action: "SUBMISSION_REQUEST_INFO",
      targetType: "SUBMISSION",
      targetId: submission.id,
      summary: `要求学生干部申报补充材料：${body.reason}`,
    });
    const updated = db.prepare(`${SUBMISSION_SELECT} WHERE sub.id=?`).get(submission.id);
    res.json({ submission: submissionView(updated) });
  });
}
