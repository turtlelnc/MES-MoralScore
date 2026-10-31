// 家长只读分享（backend-data）：高熵随机 token（库中只存 sha256），支持
// 过期与撤销、访问日志与访问计数。公开接口只返回被授权单个学生的脱敏报告，
// 不返回班级排名或其他学生信息；无效/过期/撤销统一返回 404。
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { httpError, iso, sha256 } from "./core.mjs";
import { buildStudentReport } from "./reports.mjs";

const DAY_MS = 86_400_000;
const str = (value) => (Array.isArray(value) ? value[0] : value);
function q(req, name) {
  const raw = str(req.query?.[name]);
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

const createShareSchema = z.object({
  studentId: z.string({ required_error: "请选择学生" }).trim().min(1, "请选择学生"),
  expiresInDays: z.coerce
    .number({ required_error: "请选择有效期" })
    .int("有效天数必须为 1-90 的整数")
    .min(1, "有效天数必须为 1-90 的整数")
    .max(90, "有效天数必须为 1-90 的整数"),
  label: z.string().trim().max(100, "备注不能超过 100 个字符").optional(),
});

export function maskStudentNo(studentNo) {
  const value = String(studentNo || "");
  if (!value) return "";
  if (value.length <= 2) return "**";
  if (value.length <= 4) return `${value[0]}***`;
  return `${value.slice(0, 2)}${"*".repeat(Math.max(2, value.length - 4))}${value.slice(-2)}`;
}

function shareStatus(row) {
  if (row.revoked_at) return { status: "REVOKED", statusLabel: "已撤销" };
  if (row.expires_at <= iso()) return { status: "EXPIRED", statusLabel: "已过期" };
  return { status: "ACTIVE", statusLabel: "有效" };
}

function shareView(row) {
  const status = shareStatus(row);
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name || "",
    studentNo: row.student_no || "",
    className: row.class_name || "",
    gradeName: row.grade_name || "",
    label: row.label,
    status: status.status,
    statusLabel: status.statusLabel,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    createdByName: row.created_by_name || "",
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
  };
}

const SHARE_SELECT = `SELECT ps.*, s.name AS student_name, s.student_no, c.name AS class_name, g.name AS grade_name,
    u.display_name AS created_by_name
  FROM parent_shares ps
  JOIN students s ON s.id=ps.student_id
  JOIN classes c ON c.id=s.class_id
  JOIN grades g ON g.id=s.grade_id
  LEFT JOIN users u ON u.id=ps.created_by`;

export function registerShareRoutes(app, ctx) {
  const { db, auth, requireManagement, scope, audit, settings } = ctx;
  const rateLimiter = ctx.createRateLimiter();

  app.post("/api/shares", auth, requireManagement, (req, res) => {
    const body = ctx.parseBody(createShareSchema, req.body);
    const student = scope.assertStudentAccess(req.user, body.studentId);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + body.expiresInDays * DAY_MS).toISOString();
    const id = ctx.uid();
    db.prepare(
      `INSERT INTO parent_shares(id,school_id,student_id,token_hash,label,created_by,expires_at,revoked_at,created_at,last_accessed_at,access_count)
       VALUES(?,?,?,?,?,?,?,NULL,?,NULL,0)`,
    ).run(
      id,
      req.user.school_id,
      student.id,
      sha256(token),
      body.label || "",
      req.user.id,
      expiresAt,
      iso(),
    );
    audit.record({
      req,
      user: req.user,
      action: "SHARE_CREATE",
      targetType: "PARENT_SHARE",
      targetId: id,
      summary: `创建家长只读分享（学生 ${student.name}，${body.expiresInDays} 天有效）`,
    });
    res.status(201).json({
      share: {
        id,
        token,
        url: `/#/share/${token}`,
        expiresAt,
        label: body.label || "",
        studentName: student.name,
      },
    });
  });

  app.get("/api/shares", auth, requireManagement, (req, res) => {
    const schoolId = req.user.school_id;
    const studentId = q(req, "studentId");
    const clauses = ["ps.school_id=?"];
    const params = [schoolId];
    if (studentId) {
      const student = db
        .prepare("SELECT id FROM students WHERE id=? AND school_id=?")
        .get(studentId, schoolId);
      if (!student) throw httpError(404, "学生不存在");
      clauses.push("ps.student_id=?");
      params.push(student.id);
    }
    const total = db
      .prepare(`SELECT COUNT(*) AS count FROM parent_shares ps WHERE ${clauses.join(" AND ")}`)
      .get(...params).count;
    const { page, pageSize, offset } = ctx.paginate(req.query, { defaultSize: 20, maxSize: 100 });
    const rows = db
      .prepare(
        `${SHARE_SELECT} WHERE ${clauses.join(" AND ")}
         ORDER BY ps.created_at DESC, ps.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset);
    res.json(ctx.pageResult(rows.map(shareView), total, { page, pageSize }));
  });

  app.post("/api/shares/:id/revoke", auth, requireManagement, (req, res) => {
    const row = db
      .prepare(`${SHARE_SELECT} WHERE ps.id=? AND ps.school_id=?`)
      .get(String(req.params.id), req.user.school_id);
    if (!row) throw httpError(404, "分享链接不存在");
    if (row.revoked_at) throw httpError(400, "该分享链接已撤销，无需重复操作");
    const revokedAt = iso();
    db.prepare("UPDATE parent_shares SET revoked_at=? WHERE id=?").run(revokedAt, row.id);
    audit.record({
      req,
      user: req.user,
      action: "SHARE_REVOKE",
      targetType: "PARENT_SHARE",
      targetId: row.id,
      summary: `撤销家长分享链接（学生 ${row.student_name}）`,
    });
    res.json({ share: shareView({ ...row, revoked_at: revokedAt }) });
  });

  // 公开访问：无登录态，token 原文只用于本地哈希校验，从不落库。
  app.get("/api/public/share/:token", (req, res, next) => {
    try {
      const hit = rateLimiter.hit(`share:${ctx.clientIp(req)}`, { limit: 120, windowMs: 60_000 });
      if (!hit.allowed) {
        res.setHeader("Retry-After", String(Math.ceil(hit.retryAfterMs / 1000)));
        return res.status(429).json({ error: "访问过于频繁，请稍后再试" });
      }
      const token = String(req.params.token || "");
      if (!token || token.length < 20) throw httpError(404, "分享链接无效或已过期");
      const row = db
        .prepare(
          `${SHARE_SELECT} WHERE ps.token_hash=?`,
        )
        .get(sha256(token));
      if (!row || row.revoked_at || row.expires_at <= iso())
        throw httpError(404, "分享链接无效或已过期");
      const student = db
        .prepare(
          `SELECT s.*, c.name AS class_name, g.name AS grade_name
           FROM students s JOIN classes c ON c.id=s.class_id JOIN grades g ON g.id=s.grade_id
           WHERE s.id=? AND s.school_id=?`,
        )
        .get(row.student_id, row.school_id);
      if (!student) throw httpError(404, "分享链接无效或已过期");
      const accessedAt = iso();
      db.prepare(
        "UPDATE parent_shares SET access_count=access_count+1, last_accessed_at=? WHERE id=?",
      ).run(accessedAt, row.id);
      db.prepare(
        "INSERT INTO parent_share_access_log(id,share_id,ip,user_agent,created_at) VALUES(?,?,?,?,?)",
      ).run(
        ctx.uid(),
        row.id,
        ctx.clientIp(req),
        String(req.headers["user-agent"] || "").slice(0, 300),
        accessedAt,
      );
      audit.record({
        req,
        schoolId: row.school_id,
        action: "PARENT_SHARE_ACCESS",
        targetType: "PARENT_SHARE",
        targetId: row.id,
        summary: "家长只读分享被访问",
      });
      res.setHeader("Cache-Control", "no-store");
      let report;
      try {
        report = buildStudentReport(db, settings.get(row.school_id), {
          student,
          period: "term",
        });
      } catch (error) {
        if (error?.status === 400) throw httpError(404, "分享链接无效或已过期");
        throw error;
      }
      res.json({
        ...report,
        student: { ...report.student, studentNo: maskStudentNo(student.student_no) },
        expiresAt: row.expires_at,
        shareLabel: row.label || "",
        privacyNote: "仅限授权家长查看，不展示班级排名与其他学生信息",
      });
    } catch (error) {
      next(error);
    }
  });
}
