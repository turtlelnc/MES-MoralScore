// CSV 批量导入（backend-data）：先预览逐行校验并入库 import_jobs/import_errors，
// 再一次性事务提交（任何错误整体回滚，绝不产生半批脏数据）。教师导入只生成
// teachers 档案，不自动创建登录账号。仅 SYSTEM_ADMIN 可用。
import path from "node:path";
import multer from "multer";
import { z } from "zod";
import { httpError, iso, safeFilename, uid } from "./core.mjs";

const KIND_LABELS = Object.freeze({ students: "学生", classes: "班级", teachers: "教师" });
const KINDS = Object.keys(KIND_LABELS);

const GENDERS = ["男", "女", "其他"];
const STUDENT_STATUS_ALIASES = {
  ACTIVE: "ACTIVE",
  在读: "ACTIVE",
  ARCHIVED: "ARCHIVED",
  毕业: "ARCHIVED",
  TRANSFERRED: "TRANSFERRED",
  转学: "TRANSFERRED",
};
const STUDENT_STATUSES = Object.keys(STUDENT_STATUS_ALIASES);

// 模板：必需列在前，可选列在后；示例使用虚构数据。
const TEMPLATES = Object.freeze({
  students: {
    header: ["姓名", "学号", "年级", "班级", "性别", "状态"],
    sample: ["张三", "2026001", "七年级", "1班", "男", "ACTIVE"],
    required: ["姓名", "学号", "年级", "班级"],
  },
  classes: {
    header: ["年级", "班级", "班主任工号"],
    sample: ["七年级", "1班", "T001"],
    required: ["年级", "班级"],
  },
  teachers: {
    header: ["姓名", "工号", "学科", "手机号"],
    sample: ["张三", "T001", "数学", "13800000000"],
    required: ["姓名", "工号"],
  },
});

const FIELD_LABELS = Object.freeze({
  students: { name: "姓名", studentNo: "学号", gradeName: "年级", className: "班级", gender: "性别", status: "状态" },
  classes: { gradeName: "年级", className: "班级", headTeacherNo: "班主任工号" },
  teachers: { name: "姓名", employeeNo: "工号", subject: "学科", phone: "手机号" },
});

const textCell = (label, { max = 50, required = true } = {}) =>
  z
    .string({ required_error: `请填写${label}` })
    .trim()
    .refine((value) => !required || value.length > 0, { message: `${label}不能为空` })
    .refine((value) => value.length <= max, { message: `${label}不能超过 ${max} 个字符` });

const optionalCell = (label, max = 50) =>
  z.string().trim().max(max, `${label}不能超过 ${max} 个字符`).optional();

const studentRowSchema = z.object({
  name: textCell("姓名", { max: 50 }),
  studentNo: textCell("学号", { max: 40 }),
  gradeName: textCell("年级", { max: 30 }),
  className: textCell("班级", { max: 30 }),
  gender: z.enum(GENDERS, { errorMap: () => ({ message: `性别必须为：${GENDERS.join("/")}` }) }).optional(),
  status: z
    .enum(STUDENT_STATUSES, { errorMap: () => ({ message: `状态必须为：${STUDENT_STATUSES.join("/")}` }) })
    .optional(),
});

const classRowSchema = z.object({
  gradeName: textCell("年级", { max: 30 }),
  className: textCell("班级", { max: 30 }),
  headTeacherNo: optionalCell("班主任工号", 40),
});

const teacherRowSchema = z.object({
  name: textCell("姓名", { max: 50 }),
  employeeNo: textCell("工号", { max: 40 }),
  subject: optionalCell("学科", 50),
  phone: optionalCell("手机号", 30),
});

const ROW_SCHEMAS = { students: studentRowSchema, classes: classRowSchema, teachers: teacherRowSchema };

const previewSchema = z.object({
  kind: z.string({ required_error: "请选择导入类型" }).trim().refine((value) => KINDS.includes(value), {
    message: "导入类型必须为 students/classes/teachers",
  }),
});

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message || ""));
}

function jobView(row) {
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: KIND_LABELS[row.kind] || row.kind,
    filename: row.filename,
    status: row.status,
    statusLabel: row.status === "PREVIEW" ? "待确认" : row.status === "COMMITTED" ? "已导入" : "导入失败",
    totalRows: row.total_rows,
    validRows: row.valid_rows,
    errorRows: row.error_rows,
    resultSummary: row.result_summary,
    createdAt: row.created_at,
    committedAt: row.committed_at,
  };
}

function decodeCsvFile(file) {
  if (!file) throw httpError(400, "请选择需要导入的 CSV 文件");
  const originalName = safeFilename(file.originalname || "import.csv");
  if (path.extname(originalName).toLowerCase() !== ".csv")
    throw httpError(400, "仅支持 .csv 文件，请另存为 CSV 后重试");
  // 严格 UTF-8 解码：GBK 等编码会在这里得到明确提示，而不是悄悄乱码。
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
  } catch {
    throw httpError(400, "文件编码必须为 UTF-8（可带 BOM），请另存为 UTF-8 CSV 后重试");
  }
  if (!raw.replace(/^\uFEFF/, "").trim()) throw httpError(400, "CSV 文件为空，请填写数据后重新上传");
  return { originalName, raw };
}

function buildColumnIndex(header, kind) {
  const index = new Map();
  header.forEach((name, position) => {
    const key = String(name || "").trim();
    if (key && !index.has(key)) index.set(key, position);
  });
  const missing = TEMPLATES[kind].required.filter((name) => !index.has(name));
  if (missing.length)
    throw httpError(400, `CSV 缺少必需列：${missing.join("、")}，请下载模板后重新填写`);
  return index;
}

function cellValue(cells, columnIndex, columnName) {
  const position = columnIndex.get(columnName);
  if (position === undefined) return "";
  return String(cells[position] ?? "").trim();
}

/** 逐行校验：先做列/枚举的表单校验，再做年级班级关联、重复学号等业务校验。 */
function validateRows(db, { schoolId, kind, rows, columnIndex }) {
  const schema = ROW_SCHEMAS[kind];
  const fileKeys = new Set();
  const preview = [];
  const errors = [];
  const gradeCache = new Map();
  const classCache = new Map();

  const gradeIdByName = (name) => {
    if (!gradeCache.has(name)) {
      const row = db
        .prepare("SELECT id FROM grades WHERE school_id=? AND name=?")
        .get(schoolId, name);
      gradeCache.set(name, row?.id || "");
    }
    return gradeCache.get(name);
  };
  const classIdByKey = (gradeId, name) => {
    const key = `${gradeId}::${name}`;
    if (!classCache.has(key)) {
      const row = db
        .prepare("SELECT id FROM classes WHERE school_id=? AND grade_id=? AND name=?")
        .get(schoolId, gradeId, name);
      classCache.set(key, row?.id || "");
    }
    return classCache.get(key);
  };

  rows.forEach((cells, offset) => {
    const rowNumber = offset + 2; // 表头为第 1 行
    const labels = FIELD_LABELS[kind];
    const rowErrors = [];
    const raw = {};
    for (const columnName of TEMPLATES[kind].header) raw[columnName] = cellValue(cells, columnIndex, columnName);

    const candidate = {};
    if (kind === "students") {
      candidate.name = raw["姓名"];
      candidate.studentNo = raw["学号"];
      candidate.gradeName = raw["年级"];
      candidate.className = raw["班级"];
      const gender = raw["性别"];
      if (gender) candidate.gender = gender;
      if (raw["状态"]) candidate.status = raw["状态"];
    } else if (kind === "classes") {
      candidate.gradeName = raw["年级"];
      candidate.className = raw["班级"];
      if (raw["班主任工号"]) candidate.headTeacherNo = raw["班主任工号"];
    } else {
      candidate.name = raw["姓名"];
      candidate.employeeNo = raw["工号"];
      if (raw["学科"]) candidate.subject = raw["学科"];
      if (raw["手机号"]) candidate.phone = raw["手机号"];
    }

    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] || "");
        rowErrors.push({ column: labels[field] || field, message: issue.message });
      }
    }
    const data = parsed.success ? parsed.data : candidate;
    if (parsed.success && kind === "students") {
      // 状态允许中文别名（在读/毕业/转学），入库前统一为枚举值。
      data.status = STUDENT_STATUS_ALIASES[data.status] || "ACTIVE";
    }

    if (parsed.success) {
      if (kind === "students") {
        const gradeId = gradeIdByName(data.gradeName);
        if (!gradeId) {
          rowErrors.push({ column: "年级", message: `年级「${data.gradeName}」不存在，请先维护年级` });
        } else {
          const classId = classIdByKey(gradeId, data.className);
          if (!classId)
            rowErrors.push({
              column: "班级",
              message: `班级「${data.gradeName}${data.className}」不存在，请先维护班级`,
            });
        }
        const fileKey = `no:${data.studentNo}`;
        if (fileKeys.has(fileKey)) rowErrors.push({ column: "学号", message: "文件内学号重复" });
        else fileKeys.add(fileKey);
        const duplicate = db
          .prepare("SELECT id FROM students WHERE school_id=? AND student_no=?")
          .get(schoolId, data.studentNo);
        if (duplicate) rowErrors.push({ column: "学号", message: "该学号在学生档案中已存在" });
      } else if (kind === "classes") {
        const gradeId = gradeIdByName(data.gradeName);
        if (!gradeId) {
          rowErrors.push({ column: "年级", message: `年级「${data.gradeName}」不存在，请先维护年级` });
        } else if (classIdByKey(gradeId, data.className)) {
          rowErrors.push({ column: "班级", message: "该年级下已存在同名班级" });
        }
        const fileKey = `class:${data.gradeName}::${data.className}`;
        if (fileKeys.has(fileKey)) rowErrors.push({ column: "班级", message: "文件内班级重复" });
        else fileKeys.add(fileKey);
        if (data.headTeacherNo) {
          const teacher = db
            .prepare("SELECT id FROM teachers WHERE school_id=? AND employee_no=?")
            .get(schoolId, data.headTeacherNo);
          if (!teacher)
            rowErrors.push({ column: "班主任工号", message: `工号「${data.headTeacherNo}」的教师不存在` });
        }
      } else {
        const fileKey = `emp:${data.employeeNo}`;
        if (fileKeys.has(fileKey)) rowErrors.push({ column: "工号", message: "文件内工号重复" });
        else fileKeys.add(fileKey);
        const duplicate = db
          .prepare("SELECT id FROM teachers WHERE school_id=? AND employee_no=?")
          .get(schoolId, data.employeeNo);
        if (duplicate) rowErrors.push({ column: "工号", message: "该工号在教师档案中已存在" });
      }
    }

    const entry = { rowNumber, ok: rowErrors.length === 0, data, errors: rowErrors };
    if (!entry.ok) {
      preview.push(entry);
      for (const item of rowErrors) errors.push({ rowNumber, columnName: item.column, message: item.message, raw });
    } else preview.push(entry);
  });
  return { preview, errors };
}

export function registerImportRoutes(app, ctx) {
  const { db, auth, requireAdmin, audit, parseCsv, sendCsv } = ctx;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5, parts: 6 },
  });

  function schoolOf(req) {
    return db.prepare("SELECT id FROM schools WHERE id=?").get(req.user.school_id)?.id || "";
  }

  app.post("/api/imports/preview", auth, requireAdmin, upload.single("file"), (req, res) => {
    const body = previewSchema.safeParse(req.body || {});
    if (!body.success)
      throw httpError(400, body.error.issues[0]?.message || "导入类型无效");
    const kind = body.data.kind;
    const { originalName, raw } = decodeCsvFile(req.file);
    const table = parseCsv(raw);
    const header = (table[0] || []).map((cell) => String(cell || "").trim());
    const dataRows = table.slice(1);
    if (dataRows.length === 0) throw httpError(400, "CSV 中没有数据行，请填写后再上传");
    if (dataRows.length > 2000) throw httpError(400, "单次最多导入 2000 行数据，请拆分文件后重试");
    const columnIndex = buildColumnIndex(header, kind);
    const schoolId = schoolOf(req);
    if (!schoolId) throw httpError(400, "学校信息不存在");
    const { preview, errors } = validateRows(db, { schoolId, kind, rows: dataRows, columnIndex });
    const validRows = preview.filter((row) => row.ok).length;
    const jobId = uid();
    const createdAt = iso();
    const job = {
      id: jobId,
      kind,
      filename: originalName,
      status: "PREVIEW",
      total_rows: dataRows.length,
      valid_rows: validRows,
      error_rows: dataRows.length - validRows,
      result_summary: "",
      created_at: createdAt,
      committed_at: null,
    };
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO import_jobs(id,school_id,kind,filename,status,total_rows,valid_rows,error_rows,payload_json,result_summary,created_by,created_at,committed_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      ).run(
        job.id,
        schoolId,
        kind,
        job.filename,
        job.status,
        job.total_rows,
        job.valid_rows,
        job.error_rows,
        JSON.stringify({ header, rows: preview }),
        "",
        req.user.id,
        createdAt,
      );
      const insertError = db.prepare(
        "INSERT INTO import_errors(id,job_id,row_number,column_name,message,raw_json) VALUES(?,?,?,?,?,?)",
      );
      for (const item of errors)
        insertError.run(uid(), job.id, item.rowNumber, item.columnName, item.message, JSON.stringify(item.raw));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "IMPORT_PREVIEW",
      targetType: "IMPORT_JOB",
      targetId: job.id,
      summary: `预览${KIND_LABELS[kind]}导入 ${originalName}：${job.total_rows} 行，${job.error_rows} 行错误`,
    });
    res.status(201).json({ job: jobView(job), preview, template: TEMPLATES[kind].header });
  });

  app.post("/api/imports/:id/commit", auth, requireAdmin, (req, res) => {
    const job = db
      .prepare("SELECT * FROM import_jobs WHERE id=? AND school_id=?")
      .get(String(req.params.id), req.user.school_id);
    if (!job) throw httpError(404, "导入任务不存在");
    if (job.status !== "PREVIEW") {
      throw httpError(
        400,
        job.status === "COMMITTED" ? "该导入任务已提交，不能重复导入" : "该导入任务已失败，请重新上传并预览",
      );
    }
    if (job.error_rows > 0)
      throw httpError(400, `存在 ${job.error_rows} 行错误，已取消提交（不允许部分导入），请修正后重新上传`);
    let payload;
    try {
      payload = JSON.parse(job.payload_json);
    } catch {
      throw httpError(400, "导入任务数据已损坏，请重新上传");
    }
    const preview = Array.isArray(payload?.rows) ? payload.rows : [];
    const rows = preview.filter((row) => row.ok);
    if (!rows.length) throw httpError(400, "没有可导入的有效数据行，请重新上传");
    const schoolId = job.school_id;
    const gradeIdByName = (name) =>
      db.prepare("SELECT id FROM grades WHERE school_id=? AND name=?").get(schoolId, name)?.id || "";
    const classIdByKey = (gradeId, name) =>
      db
        .prepare("SELECT id FROM classes WHERE school_id=? AND grade_id=? AND name=?")
        .get(schoolId, gradeId, name)?.id || "";
    const teacherIdByNo = (employeeNo) =>
      db
        .prepare("SELECT id FROM teachers WHERE school_id=? AND employee_no=?")
        .get(schoolId, employeeNo)?.id || "";

    let inserted = 0;
    db.exec("BEGIN");
    try {
      for (const row of rows) {
        const data = row.data;
        if (job.kind === "students") {
          const gradeId = gradeIdByName(data.gradeName);
          if (!gradeId) throw new Error(`第 ${row.rowNumber} 行：年级「${data.gradeName}」不存在`);
          const classId = classIdByKey(gradeId, data.className);
          if (!classId)
            throw new Error(`第 ${row.rowNumber} 行：班级「${data.gradeName}${data.className}」不存在`);
          db.prepare(
            "INSERT INTO students(id,school_id,grade_id,class_id,student_no,name,gender,status,joined_at,created_at) VALUES(?,?,?,?,?,?,?,?,'',?)",
          ).run(
            uid(),
            schoolId,
            gradeId,
            classId,
            data.studentNo,
            data.name,
            data.gender || "其他",
            data.status || "ACTIVE",
            iso(),
          );
        } else if (job.kind === "classes") {
          const gradeId = gradeIdByName(data.gradeName);
          if (!gradeId) throw new Error(`第 ${row.rowNumber} 行：年级「${data.gradeName}」不存在`);
          let headTeacherId = null;
          if (data.headTeacherNo) {
            headTeacherId = teacherIdByNo(data.headTeacherNo);
            if (!headTeacherId)
              throw new Error(`第 ${row.rowNumber} 行：工号「${data.headTeacherNo}」的教师不存在`);
          }
          const sortOrder =
            db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM classes WHERE school_id=?").get(schoolId)
              .next || 1;
          db.prepare(
            "INSERT INTO classes(id,school_id,grade_id,name,head_teacher_id,sort_order,created_at) VALUES(?,?,?,?,?,?,?)",
          ).run(uid(), schoolId, gradeId, data.className, headTeacherId, sortOrder, iso());
        } else {
          db.prepare(
            "INSERT INTO teachers(id,school_id,name,employee_no,subject,phone,status,created_at) VALUES(?,?,?,?,?,?,'ACTIVE',?)",
          ).run(
            uid(),
            schoolId,
            data.name,
            data.employeeNo,
            data.subject || "",
            data.phone || "",
            iso(),
          );
        }
        inserted += 1;
      }
      db.prepare(
        "UPDATE import_jobs SET status='COMMITTED', committed_at=?, result_summary=? WHERE id=?",
      ).run(
        iso(),
        job.kind === "teachers"
          ? `成功导入 ${inserted} 名教师（仅教师档案，未自动创建账号）`
          : `成功导入 ${inserted} 条${KIND_LABELS[job.kind]}数据`,
        job.id,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      const message = String(error?.message || error).slice(0, 300);
      db.prepare("UPDATE import_jobs SET status='FAILED', result_summary=? WHERE id=?").run(
        `导入失败已整体回滚：${message}`,
        job.id,
      );
      audit.record({
        req,
        user: req.user,
        action: "IMPORT_FAILED",
        targetType: "IMPORT_JOB",
        targetId: job.id,
        summary: `导入失败并回滚：${message}`,
        result: "FAILURE",
      });
      if (isUniqueViolation(error)) throw httpError(400, "导入失败，已整体回滚：存在重复的学号/工号或同名数据");
      throw httpError(400, `导入失败，已整体回滚：${message}`);
    }
    const fresh = db.prepare("SELECT * FROM import_jobs WHERE id=?").get(job.id);
    audit.record({
      req,
      user: req.user,
      action: "IMPORT_COMMIT",
      targetType: "IMPORT_JOB",
      targetId: job.id,
      summary: `提交${KIND_LABELS[job.kind]}导入：成功 ${inserted} 条`,
    });
    res.json({ job: jobView(fresh), inserted });
  });

  app.get("/api/imports", auth, requireAdmin, (req, res) => {
    const kind = String(req.query.kind || "").trim();
    if (kind && !KINDS.includes(kind)) throw httpError(400, "导入类型无效");
    const clauses = ["school_id=?"];
    const params = [req.user.school_id];
    if (kind) {
      clauses.push("kind=?");
      params.push(kind);
    }
    const total = db
      .prepare(`SELECT COUNT(*) AS count FROM import_jobs WHERE ${clauses.join(" AND ")}`)
      .get(...params).count;
    const { page, pageSize, offset } = ctx.paginate(req.query, { defaultSize: 20, maxSize: 100 });
    const rows = db
      .prepare(
        `SELECT * FROM import_jobs WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset);
    res.json(ctx.pageResult(rows.map(jobView), total, { page, pageSize }));
  });

  app.get("/api/imports/:id/errors.csv", auth, requireAdmin, (req, res) => {
    const job = db
      .prepare("SELECT * FROM import_jobs WHERE id=? AND school_id=?")
      .get(String(req.params.id), req.user.school_id);
    if (!job) throw httpError(404, "导入任务不存在");
    const rows = db
      .prepare(
        "SELECT row_number, column_name, message, raw_json FROM import_errors WHERE job_id=? ORDER BY row_number, id",
      )
      .all(job.id);
    const csvRows = rows.length
      ? rows.map((row) => [row.row_number, row.column_name, row.message, row.raw_json])
      : [["-", "-", "无错误行", ""]];
    sendCsv(res, `import-errors-${job.id}.csv`, ["行号", "错误列", "错误信息", "原始数据"], csvRows);
  });

  app.get("/api/imports/template.csv", auth, requireAdmin, (req, res) => {
    const kind = String(req.query.kind || "").trim();
    if (!KINDS.includes(kind)) throw httpError(400, "导入类型必须为 students/classes/teachers");
    const template = TEMPLATES[kind];
    sendCsv(res, `import-template-${kind}.csv`, template.header, [template.sample]);
  });
  app.get("/api/imports/:id", auth, requireAdmin, (req, res) => {
    const job = db
      .prepare("SELECT * FROM import_jobs WHERE id=? AND school_id=?")
      .get(String(req.params.id), req.user.school_id);
    if (!job) throw httpError(404, "导入任务不存在");
    let preview = [];
    try {
      preview = JSON.parse(job.payload_json)?.rows || [];
    } catch {
      preview = [];
    }
    res.json({ job: jobView(job), preview });
  });
}
