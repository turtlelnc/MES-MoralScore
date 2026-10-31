// 基础资料模块（backend-data）：学校资料、学年学期、年级/班级、学生、教师
// 与前端选择器数据。所有读接口都通过 ctx.scope 裁剪数据范围；基础资料
// 的写接口只允许 SYSTEM_ADMIN（德育处只读）。
import { z } from "zod";
import {
  ROLE_LABELS,
  SCHOOL_STAGES,
  httpError,
  iso,
  likePattern,
  pageResult,
  paginate,
  today,
} from "./core.mjs";
import { recordViews, studentTermScore, studentTermScores } from "./ledger.mjs";

const str = (value) => (Array.isArray(value) ? value[0] : value);
function q(req, name) {
  const raw = str(req.query?.[name]);
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

const GENDERS = ["男", "女", "其他"];
const STUDENT_STATUSES = ["ACTIVE", "ARCHIVED", "TRANSFERRED"];
const TEACHER_STATUSES = ["ACTIVE", "ARCHIVED"];

const idField = (name = "ID") => z.string({ required_error: `请填写${name}` }).trim().min(1, `请填写${name}`);
const dateField = (name) =>
  z
    .string({ required_error: `请填写${name}` })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${name}必须为 YYYY-MM-DD 格式`)
    .refine((value) => !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()), {
      message: `${name}不是有效日期`,
    });
const optionalDateField = (name) =>
  z
    .string()
    .trim()
    .optional()
    .refine((value) => value === undefined || value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value), {
      message: `${name}必须为 YYYY-MM-DD 格式`,
    })
    .refine((value) => value === undefined || value === "" || !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()), {
      message: `${name}不是有效日期`,
    });
const enumField = (values, name) =>
  z.string({ required_error: `请选择${name}` }).trim().refine((value) => values.includes(value), {
    message: `${name}必须为：${values.join("/")}`,
  });
const optionalEnumField = (values, name) =>
  z
    .string()
    .trim()
    .optional()
    .refine((value) => value === undefined || value === "" || values.includes(value), {
      message: `${name}必须为：${values.join("/")}`,
    });
const nonEmptyUpdate = (schema, message = "没有需要更新的字段") =>
  schema.refine((value) => Object.values(value).some((item) => item !== undefined), { message });

const schoolPatchSchema = nonEmptyUpdate(
  z.object({
    name: z.string().trim().min(2, "学校名称至少需要 2 个字符").max(100, "学校名称不能超过 100 个字符").optional(),
    address: z.string().trim().max(200, "地址不能超过 200 个字符").optional(),
    contact: z.string().trim().max(100, "联系方式不能超过 100 个字符").optional(),
    stage: optionalEnumField(SCHOOL_STAGES, "学段"),
  }),
);

const academicYearSchema = z.object({
  name: z.string().trim().min(2, "学年名称至少需要 2 个字符").max(50, "学年名称不能超过 50 个字符"),
  startDate: dateField("开始日期"),
  endDate: dateField("结束日期"),
});

const termSchema = z.object({
  academicYearId: idField("学年"),
  name: z.string().trim().min(2, "学期名称至少需要 2 个字符").max(50, "学期名称不能超过 50 个字符"),
  startDate: dateField("开始日期"),
  endDate: dateField("结束日期"),
});

const gradeCreateSchema = z.object({
  name: z.string().trim().min(1, "请填写年级名称").max(30, "年级名称不能超过 30 个字符"),
  sortOrder: z.coerce.number().int("排序必须为整数").min(0, "排序不能为负数").max(9999, "排序过大").optional(),
});
const gradePatchSchema = nonEmptyUpdate(
  z.object({
    name: z.string().trim().min(1, "请填写年级名称").max(30, "年级名称不能超过 30 个字符").optional(),
    sortOrder: z.coerce.number().int("排序必须为整数").min(0, "排序不能为负数").max(9999, "排序过大").optional(),
  }),
);

const classCreateSchema = z.object({
  gradeId: idField("年级"),
  name: z.string().trim().min(1, "请填写班级名称").max(30, "班级名称不能超过 30 个字符"),
  headTeacherId: z.string().trim().optional(),
  sortOrder: z.coerce.number().int("排序必须为整数").min(0, "排序不能为负数").max(9999, "排序过大").optional(),
});
const classPatchSchema = nonEmptyUpdate(
  z.object({
    gradeId: z.string().trim().min(1, "请选择年级").optional(),
    name: z.string().trim().min(1, "请填写班级名称").max(30, "班级名称不能超过 30 个字符").optional(),
    headTeacherId: z.string().trim().optional(),
    sortOrder: z.coerce.number().int("排序必须为整数").min(0, "排序不能为负数").max(9999, "排序过大").optional(),
  }),
);

const studentCreateSchema = z.object({
  name: z.string().trim().min(1, "请填写学生姓名").max(50, "学生姓名不能超过 50 个字符"),
  studentNo: z.string().trim().min(1, "请填写学号").max(40, "学号不能超过 40 个字符"),
  classId: idField("班级"),
  gender: optionalEnumField(GENDERS, "性别"),
  status: optionalEnumField(STUDENT_STATUSES, "状态"),
  joinedAt: optionalDateField("入学日期"),
});
const studentPatchSchema = nonEmptyUpdate(
  z.object({
    name: z.string().trim().min(1, "请填写学生姓名").max(50, "学生姓名不能超过 50 个字符").optional(),
    studentNo: z.string().trim().min(1, "请填写学号").max(40, "学号不能超过 40 个字符").optional(),
    classId: z.string().trim().min(1, "请选择班级").optional(),
    gender: optionalEnumField(GENDERS, "性别"),
    status: optionalEnumField(STUDENT_STATUSES, "状态"),
    joinedAt: optionalDateField("入学日期"),
  }),
);

const teacherCreateSchema = z.object({
  name: z.string().trim().min(1, "请填写教师姓名").max(50, "教师姓名不能超过 50 个字符"),
  employeeNo: z.string().trim().min(1, "请填写教师工号").max(40, "教师工号不能超过 40 个字符"),
  subject: z.string().trim().max(50, "学科不能超过 50 个字符").optional(),
  phone: z.string().trim().max(30, "手机号不能超过 30 个字符").optional(),
  status: optionalEnumField(TEACHER_STATUSES, "状态"),
});
const teacherPatchSchema = nonEmptyUpdate(
  z.object({
    name: z.string().trim().min(1, "请填写教师姓名").max(50, "教师姓名不能超过 50 个字符").optional(),
    employeeNo: z.string().trim().min(1, "请填写教师工号").max(40, "教师工号不能超过 40 个字符").optional(),
    subject: z.string().trim().max(50, "学科不能超过 50 个字符").optional(),
    phone: z.string().trim().max(30, "手机号不能超过 30 个字符").optional(),
    status: optionalEnumField(TEACHER_STATUSES, "状态"),
  }),
);

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message || ""));
}

function currentTermRow(db, schoolId) {
  return (
    db
      .prepare(
        `SELECT t.*, y.name AS academic_year_name
         FROM terms t JOIN academic_years y ON y.id=t.academic_year_id
         WHERE t.school_id=? AND t.is_current=1`,
      )
      .get(schoolId) || null
  );
}

function resolveTerm(db, schoolId, termId) {
  if (termId) {
    const term = db
      .prepare(
        `SELECT t.*, y.name AS academic_year_name
         FROM terms t JOIN academic_years y ON y.id=t.academic_year_id
         WHERE t.id=? AND t.school_id=?`,
      )
      .get(String(termId), schoolId);
    if (!term) throw httpError(404, "学期不存在");
    return term;
  }
  return currentTermRow(db, schoolId);
}

function termView(term) {
  if (!term) return null;
  return {
    id: term.id,
    name: term.name,
    academicYearName: term.academic_year_name,
    startDate: term.start_date,
    endDate: term.end_date,
    isCurrent: term.is_current === 1,
  };
}

function scopedGradeIds(db, scope, user) {
  if (scope.hasFullScope(user)) return null;
  const classIds = scope.classIdsFor(user) || [];
  if (!classIds.length) return [];
  const rows = db
    .prepare(`SELECT DISTINCT grade_id FROM classes WHERE id IN (${classIds.map(() => "?").join(",")})`)
    .all(...classIds);
  return rows.map((row) => row.grade_id);
}

function assertGradeAccess(db, scope, user, gradeId) {
  const grade = db.prepare("SELECT * FROM grades WHERE id=? AND school_id=?").get(gradeId, user.school_id);
  if (!grade) throw httpError(404, "年级不存在");
  const allowed = scopedGradeIds(db, scope, user);
  if (allowed !== null && !allowed.includes(grade.id)) throw httpError(403, "无权访问该年级的数据");
  return grade;
}

function gradeClassCounts(db, schoolId) {
  const rows = db
    .prepare(
      `SELECT g.id AS grade_id,
         (SELECT COUNT(*) FROM classes c WHERE c.grade_id=g.id AND c.school_id=g.school_id) AS class_count,
         (SELECT COUNT(*) FROM students s WHERE s.grade_id=g.id AND s.school_id=g.school_id AND s.status='ACTIVE') AS student_count
       FROM grades g WHERE g.school_id=?`,
    )
    .all(schoolId);
  return new Map(rows.map((row) => [row.grade_id, row]));
}

function classRows(db, schoolId, classIds) {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.grade_id, c.head_teacher_id, c.sort_order,
         g.name AS grade_name, t.name AS head_teacher_name,
         (SELECT COUNT(*) FROM students s WHERE s.class_id=c.id AND s.status='ACTIVE') AS student_count
       FROM classes c
       JOIN grades g ON g.id=c.grade_id
       LEFT JOIN teachers t ON t.id=c.head_teacher_id
       WHERE c.school_id=? ORDER BY g.sort_order, c.sort_order, c.name`,
    )
    .all(schoolId);
  const filter = classIds === null ? null : new Set(classIds);
  return rows.filter((row) => (filter ? filter.has(row.id) : true));
}

function classView(row) {
  return {
    id: row.id,
    name: row.name,
    gradeId: row.grade_id,
    gradeName: row.grade_name,
    headTeacherId: row.head_teacher_id || null,
    headTeacherName: row.head_teacher_name || "",
    studentCount: row.student_count,
    sortOrder: row.sort_order,
  };
}

function studentView(row, termScoreValue) {
  const view = {
    id: row.id,
    name: row.name,
    studentNo: row.student_no,
    gender: row.gender,
    classId: row.class_id,
    className: row.class_name,
    gradeId: row.grade_id,
    gradeName: row.grade_name,
    status: row.status,
    joinedAt: row.joined_at,
  };
  if (termScoreValue) view.termScore = termScoreValue.total;
  return view;
}

function publishScopeFilter(version, { fullScope, classIds, gradeIds }) {
  const targetScope = version.target_scope;
  if (targetScope === "ALL") return true;
  let scopeIds = [];
  try {
    scopeIds = JSON.parse(version.scope_json || "[]");
  } catch {
    scopeIds = [];
  }
  if (!Array.isArray(scopeIds) || scopeIds.length === 0) return true;
  if (fullScope) return true;
  if (targetScope === "CLASS") return scopeIds.some((id) => classIds.includes(id));
  if (targetScope === "GRADE") return scopeIds.some((id) => gradeIds.includes(id));
  return true;
}

export function registerRosterRoutes(app, ctx) {
  const { db, auth, requireAdmin, requireManagement, requireStaff, scope, audit, settings } = ctx;

  // ------------------------------------------------------------ 学校资料
  app.get("/api/school", auth, requireStaff, (req, res) => {
    const school = db
      .prepare("SELECT id,name,code,stage,address,contact,created_at FROM schools WHERE id=?")
      .get(req.user.school_id);
    if (!school) throw httpError(404, "学校信息不存在");
    const current = settings.get(req.user.school_id);
    res.json({
      school: {
        id: school.id,
        name: school.name,
        code: school.code,
        stage: school.stage,
        address: school.address,
        contact: school.contact,
      },
      settings: {
        initialPoints: current.initialPoints,
        allowNegative: current.allowNegative,
        reviewThreshold: current.reviewThreshold,
      },
    });
  });

  app.patch("/api/school", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(schoolPatchSchema, req.body);
    const before = db
      .prepare("SELECT id,name,stage,address,contact FROM schools WHERE id=?")
      .get(req.user.school_id);
    if (!before) throw httpError(404, "学校信息不存在");
    const next = {
      name: body.name ?? before.name,
      stage: body.stage ?? before.stage,
      address: body.address ?? before.address,
      contact: body.contact ?? before.contact,
    };
    db.prepare("UPDATE schools SET name=?, stage=?, address=?, contact=? WHERE id=?").run(
      next.name,
      next.stage,
      next.address,
      next.contact,
      req.user.school_id,
    );
    audit.record({
      req,
      user: req.user,
      action: "SCHOOL_UPDATE",
      targetType: "SCHOOL",
      targetId: req.user.school_id,
      summary: "更新学校基础资料",
      before,
      after: next,
    });
    res.json({ school: { id: req.user.school_id, code: before.code, ...next } });
  });

  // ------------------------------------------------------------ 学年学期
  app.get("/api/periods", auth, requireStaff, (req, res) => {
    const schoolId = req.user.school_id;
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
    const current = currentTermRow(db, schoolId);
    res.json({
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
      currentTermId: current?.id || null,
    });
  });

  app.post("/api/academic-years", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(academicYearSchema, req.body);
    if (body.startDate >= body.endDate) throw httpError(400, "学年开始日期必须早于结束日期");
    const schoolId = req.user.school_id;
    const id = ctx.uid();
    const isFirst = !db.prepare("SELECT id FROM academic_years WHERE school_id=? LIMIT 1").get(schoolId);
    db.exec("BEGIN");
    try {
      if (isFirst) db.prepare("UPDATE academic_years SET is_current=0 WHERE school_id=?").run(schoolId);
      db.prepare(
        "INSERT INTO academic_years(id,school_id,name,start_date,end_date,is_current,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(id, schoolId, body.name, body.startDate, body.endDate, isFirst ? 1 : 0, iso());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (isUniqueViolation(error)) throw httpError(400, "该学年已存在");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "ACADEMIC_YEAR_CREATE",
      targetType: "ACADEMIC_YEAR",
      targetId: id,
      summary: `新建学年「${body.name}」`,
    });
    res.status(201).json({
      academicYear: {
        id,
        name: body.name,
        startDate: body.startDate,
        endDate: body.endDate,
        isCurrent: isFirst,
      },
    });
  });

  app.post("/api/terms", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(termSchema, req.body);
    if (body.startDate >= body.endDate) throw httpError(400, "学期开始日期必须早于结束日期");
    const schoolId = req.user.school_id;
    const year = db
      .prepare("SELECT * FROM academic_years WHERE id=? AND school_id=?")
      .get(body.academicYearId, schoolId);
    if (!year) throw httpError(404, "学年不存在");
    const id = ctx.uid();
    const isFirst = !db.prepare("SELECT id FROM terms WHERE school_id=? LIMIT 1").get(schoolId);
    db.exec("BEGIN");
    try {
      if (isFirst) {
        db.prepare("UPDATE terms SET is_current=0 WHERE school_id=?").run(schoolId);
        db.prepare("UPDATE academic_years SET is_current=0 WHERE school_id=?").run(schoolId);
        db.prepare("UPDATE academic_years SET is_current=1 WHERE id=? AND school_id=?").run(year.id, schoolId);
      }
      db.prepare(
        "INSERT INTO terms(id,school_id,academic_year_id,name,start_date,end_date,is_current,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(id, schoolId, year.id, body.name, body.startDate, body.endDate, isFirst ? 1 : 0, iso());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (isUniqueViolation(error)) throw httpError(400, "同一学年内已存在同名学期");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "TERM_CREATE",
      targetType: "TERM",
      targetId: id,
      summary: `新建学期「${body.name}」`,
    });
    res.status(201).json({
      term: {
        id,
        academicYearId: year.id,
        name: body.name,
        startDate: body.startDate,
        endDate: body.endDate,
        isCurrent: isFirst,
      },
    });
  });

  app.post("/api/terms/:id/current", auth, requireAdmin, (req, res) => {
    const schoolId = req.user.school_id;
    const term = db
      .prepare("SELECT * FROM terms WHERE id=? AND school_id=?")
      .get(String(req.params.id), schoolId);
    if (!term) throw httpError(404, "学期不存在");
    const before = currentTermRow(db, schoolId);
    if (before?.id === term.id) {
      return res.json({ currentTermId: term.id, term: termView(before) });
    }
    // schema 对 school 内 current 有唯一索引：先全部清零再设置，保证唯一。
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE terms SET is_current=0 WHERE school_id=?").run(schoolId);
      db.prepare("UPDATE academic_years SET is_current=0 WHERE school_id=?").run(schoolId);
      db.prepare("UPDATE terms SET is_current=1 WHERE id=? AND school_id=?").run(term.id, schoolId);
      db.prepare("UPDATE academic_years SET is_current=1 WHERE id=? AND school_id=?").run(
        term.academic_year_id,
        schoolId,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "TERM_SWITCH",
      targetType: "TERM",
      targetId: term.id,
      summary: `切换当前学期为「${term.name}」`,
      before: before ? { termId: before.id, name: before.name } : null,
      after: { termId: term.id, name: term.name },
    });
    const fresh = currentTermRow(db, schoolId);
    res.json({ currentTermId: fresh?.id || term.id, term: termView(fresh) });
  });

  // -------------------------------------------------------------- 年级
  app.get("/api/grades", auth, requireStaff, (req, res) => {
    const schoolId = req.user.school_id;
    const allowed = scopedGradeIds(db, scope, req.user);
    const rows = db
      .prepare("SELECT id,name,sort_order FROM grades WHERE school_id=? ORDER BY sort_order,name")
      .all(schoolId)
      .filter((row) => (allowed === null ? true : allowed.includes(row.id)));
    const counts = gradeClassCounts(db, schoolId);
    res.json({
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        sortOrder: row.sort_order,
        classCount: counts.get(row.id)?.class_count || 0,
        studentCount: counts.get(row.id)?.student_count || 0,
      })),
    });
  });

  app.post("/api/grades", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(gradeCreateSchema, req.body);
    const schoolId = req.user.school_id;
    const id = ctx.uid();
    const sortOrder =
      body.sortOrder ??
      (db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM grades WHERE school_id=?").get(schoolId).next || 1);
    try {
      db.prepare("INSERT INTO grades(id,school_id,name,sort_order,created_at) VALUES(?,?,?,?,?)").run(
        id,
        schoolId,
        body.name,
        sortOrder,
        iso(),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw httpError(400, "该年级名称已存在");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "GRADE_CREATE",
      targetType: "GRADE",
      targetId: id,
      summary: `新建年级「${body.name}」`,
    });
    res.status(201).json({ grade: { id, name: body.name, sortOrder, classCount: 0, studentCount: 0 } });
  });

  app.patch("/api/grades/:id", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(gradePatchSchema, req.body);
    const schoolId = req.user.school_id;
    const grade = db
      .prepare("SELECT * FROM grades WHERE id=? AND school_id=?")
      .get(String(req.params.id), schoolId);
    if (!grade) throw httpError(404, "年级不存在");
    const next = {
      name: body.name ?? grade.name,
      sort_order: body.sortOrder ?? grade.sort_order,
    };
    try {
      db.prepare("UPDATE grades SET name=?, sort_order=? WHERE id=? AND school_id=?").run(
        next.name,
        next.sort_order,
        grade.id,
        schoolId,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw httpError(400, "该年级名称已存在");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "GRADE_UPDATE",
      targetType: "GRADE",
      targetId: grade.id,
      summary: `更新年级「${next.name}」`,
      before: { name: grade.name, sortOrder: grade.sort_order },
      after: { name: next.name, sortOrder: next.sort_order },
    });
    res.json({ grade: { id: grade.id, name: next.name, sortOrder: next.sort_order } });
  });

  // -------------------------------------------------------------- 班级
  app.get("/api/classes", auth, requireStaff, (req, res) => {
    const schoolId = req.user.school_id;
    const gradeId = q(req, "gradeId");
    const search = q(req, "search");
    if (gradeId) assertGradeAccess(db, scope, req.user, gradeId);
    const allowed = scope.classIdsFor(req.user);
    let rows = classRows(db, schoolId, allowed);
    if (gradeId) rows = rows.filter((row) => row.grade_id === gradeId);
    if (search) {
      const needle = search.toLowerCase();
      rows = rows.filter(
        (row) =>
          row.name.toLowerCase().includes(needle) ||
          `${row.grade_name}${row.name}`.toLowerCase().includes(needle) ||
          `${row.grade_name} ${row.name}`.toLowerCase().includes(needle),
      );
    }
    res.json({ items: rows.map(classView) });
  });

  app.post("/api/classes", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(classCreateSchema, req.body);
    const schoolId = req.user.school_id;
    const grade = db
      .prepare("SELECT * FROM grades WHERE id=? AND school_id=?")
      .get(body.gradeId, schoolId);
    if (!grade) throw httpError(404, "年级不存在");
    let headTeacherId = null;
    if (body.headTeacherId) {
      const teacher = db
        .prepare("SELECT id FROM teachers WHERE id=? AND school_id=?")
        .get(body.headTeacherId, schoolId);
      if (!teacher) throw httpError(404, "班主任教师不存在");
      headTeacherId = teacher.id;
    }
    const id = ctx.uid();
    const sortOrder =
      body.sortOrder ??
      (db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM classes WHERE school_id=?").get(schoolId).next || 1);
    try {
      db.prepare(
        "INSERT INTO classes(id,school_id,grade_id,name,head_teacher_id,sort_order,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(id, schoolId, grade.id, body.name, headTeacherId, sortOrder, iso());
    } catch (error) {
      if (isUniqueViolation(error)) throw httpError(400, "该年级下已存在同名班级");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "CLASS_CREATE",
      targetType: "CLASS",
      targetId: id,
      summary: `新建班级「${grade.name}${body.name}」`,
    });
    res.status(201).json({
      class: {
        id,
        name: body.name,
        gradeId: grade.id,
        gradeName: grade.name,
        headTeacherId,
        headTeacherName: headTeacherId
          ? db.prepare("SELECT name FROM teachers WHERE id=?").get(headTeacherId)?.name || ""
          : "",
        studentCount: 0,
      },
    });
  });

  app.patch("/api/classes/:id", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(classPatchSchema, req.body);
    const schoolId = req.user.school_id;
    const klass = db
      .prepare("SELECT * FROM classes WHERE id=? AND school_id=?")
      .get(String(req.params.id), schoolId);
    if (!klass) throw httpError(404, "班级不存在");
    const gradeId = body.gradeId ?? klass.grade_id;
    const grade = db
      .prepare("SELECT * FROM grades WHERE id=? AND school_id=?")
      .get(gradeId, schoolId);
    if (!grade) throw httpError(404, "年级不存在");
    let headTeacherId = klass.head_teacher_id;
    if (body.headTeacherId !== undefined) {
      if (!body.headTeacherId) headTeacherId = null;
      else {
        const teacher = db
          .prepare("SELECT id FROM teachers WHERE id=? AND school_id=?")
          .get(body.headTeacherId, schoolId);
        if (!teacher) throw httpError(404, "班主任教师不存在");
        headTeacherId = teacher.id;
      }
    }
    const next = {
      grade_id: grade.id,
      name: body.name ?? klass.name,
      head_teacher_id: headTeacherId,
      sort_order: body.sortOrder ?? klass.sort_order,
    };
    db.exec("BEGIN");
    try {
      db.prepare(
        "UPDATE classes SET grade_id=?, name=?, head_teacher_id=?, sort_order=? WHERE id=? AND school_id=?",
      ).run(next.grade_id, next.name, next.head_teacher_id, next.sort_order, klass.id, schoolId);
      // 学生 grade_id 冗余字段与班级保持一致。
      if (next.grade_id !== klass.grade_id)
        db.prepare("UPDATE students SET grade_id=? WHERE class_id=?").run(next.grade_id, klass.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (isUniqueViolation(error)) throw httpError(400, "该年级下已存在同名班级");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "CLASS_UPDATE",
      targetType: "CLASS",
      targetId: klass.id,
      summary: `更新班级「${next.name}」`,
      before: { name: klass.name, gradeId: klass.grade_id, headTeacherId: klass.head_teacher_id },
      after: next,
    });
    res.json({
      class: {
        id: klass.id,
        name: next.name,
        gradeId: next.grade_id,
        gradeName: grade.name,
        headTeacherId: next.head_teacher_id,
        sortOrder: next.sort_order,
      },
    });
  });

  // -------------------------------------------------------------- 学生
  app.get("/api/students", auth, requireStaff, (req, res) => {
    const schoolId = req.user.school_id;
    const classId = q(req, "classId");
    const gradeId = q(req, "gradeId");
    const search = q(req, "search");
    const status = q(req, "status");
    if (status && !STUDENT_STATUSES.includes(status)) throw httpError(400, "学生状态无效");
    if (classId) scope.assertClassAccess(req.user, classId);
    if (gradeId) assertGradeAccess(db, scope, req.user, gradeId);
    // ctx.scope.scopedStudents 固定只返回 ACTIVE；这里按 status 参数自行组装
    // where，保证在授权范围内可以查询休学/转学等历史档案。
    const clauses = ["s.school_id=?", "s.status=?"];
    const params = [schoolId, status || "ACTIVE"];
    if (classId) {
      clauses.push("s.class_id=?");
      params.push(classId);
    } else {
      const filter = scope.classFilter(req.user, "s.class_id");
      clauses.push(`(${filter.sql})`);
      params.push(...filter.params);
    }
    if (gradeId) {
      clauses.push("s.grade_id=?");
      params.push(gradeId);
    }
    if (search) {
      clauses.push("(s.name LIKE ? ESCAPE '\\' OR s.student_no LIKE ? ESCAPE '\\')");
      const pattern = likePattern(search);
      params.push(pattern, pattern);
    }
    const where = clauses.join(" AND ");
    const total = db
      .prepare(`SELECT COUNT(*) AS count FROM students s WHERE ${where}`)
      .get(...params).count;
    const { page, pageSize, offset } = paginate(req.query, { defaultSize: 20, maxSize: 100 });
    const rows = db
      .prepare(
        `SELECT s.*, c.name AS class_name, g.name AS grade_name
         FROM students s JOIN classes c ON c.id=s.class_id JOIN grades g ON g.id=s.grade_id
         WHERE ${where}
         ORDER BY g.sort_order, c.sort_order, c.name, s.student_no
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset);
    const term = resolveTerm(db, schoolId, q(req, "termId"));
    const scoreMap = term
      ? studentTermScores(
          db,
          settings.get(schoolId),
          { studentIds: rows.map((row) => row.id), termId: term.id },
        )
      : new Map();
    res.json(
      pageResult(
        rows.map((row) => studentView(row, scoreMap.get(row.id))),
        total,
        { page, pageSize },
      ),
    );
  });

  app.post("/api/students", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(studentCreateSchema, req.body);
    const schoolId = req.user.school_id;
    const klass = db
      .prepare("SELECT * FROM classes WHERE id=? AND school_id=?")
      .get(body.classId, schoolId);
    if (!klass) throw httpError(404, "班级不存在");
    const id = ctx.uid();
    try {
      db.prepare(
        "INSERT INTO students(id,school_id,grade_id,class_id,student_no,name,gender,status,joined_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        schoolId,
        klass.grade_id,
        klass.id,
        body.studentNo,
        body.name,
        body.gender || "其他",
        body.status || "ACTIVE",
        body.joinedAt || today(),
        iso(),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw httpError(400, "该学号已存在");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "STUDENT_CREATE",
      targetType: "STUDENT",
      targetId: id,
      summary: `新建学生档案（学号 ${body.studentNo}）`,
    });
    const created = db
      .prepare(
        `SELECT s.*, c.name AS class_name, g.name AS grade_name FROM students s
         JOIN classes c ON c.id=s.class_id JOIN grades g ON g.id=s.grade_id WHERE s.id=?`,
      )
      .get(id);
    res.status(201).json({ student: studentView(created) });
  });

  app.patch("/api/students/:id", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(studentPatchSchema, req.body);
    const schoolId = req.user.school_id;
    const student = db
      .prepare("SELECT * FROM students WHERE id=? AND school_id=?")
      .get(String(req.params.id), schoolId);
    if (!student) throw httpError(404, "学生不存在");
    let classId = student.class_id;
    let gradeId = student.grade_id;
    if (body.classId) {
      const klass = db
        .prepare("SELECT * FROM classes WHERE id=? AND school_id=?")
        .get(body.classId, schoolId);
      if (!klass) throw httpError(404, "班级不存在");
      classId = klass.id;
      gradeId = klass.grade_id;
    }
    const next = {
      name: body.name ?? student.name,
      student_no: body.studentNo ?? student.student_no,
      class_id: classId,
      grade_id: gradeId,
      gender: body.gender || student.gender,
      status: body.status || student.status,
      joined_at: body.joinedAt === undefined ? student.joined_at : body.joinedAt,
    };
    try {
      db.prepare(
        "UPDATE students SET name=?, student_no=?, class_id=?, grade_id=?, gender=?, status=?, joined_at=? WHERE id=? AND school_id=?",
      ).run(
        next.name,
        next.student_no,
        next.class_id,
        next.grade_id,
        next.gender,
        next.status,
        next.joined_at,
        student.id,
        schoolId,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw httpError(400, "该学号已存在");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "STUDENT_UPDATE",
      targetType: "STUDENT",
      targetId: student.id,
      summary: `更新学生档案（学号 ${next.student_no}）`,
      before: {
        name: student.name,
        studentNo: student.student_no,
        classId: student.class_id,
        gender: student.gender,
        status: student.status,
      },
      after: next,
    });
    const updated = db
      .prepare(
        `SELECT s.*, c.name AS class_name, g.name AS grade_name FROM students s
         JOIN classes c ON c.id=s.class_id JOIN grades g ON g.id=s.grade_id WHERE s.id=?`,
      )
      .get(student.id);
    res.json({ student: studentView(updated) });
  });

  app.get("/api/students/:id", auth, requireStaff, (req, res) => {
    const student = scope.assertStudentAccess(req.user, String(req.params.id));
    const term = resolveTerm(db, req.user.school_id, q(req, "termId"));
    const score = term
      ? studentTermScore(db, settings.get(req.user.school_id), { studentId: student.id, termId: term.id })
      : { initialPoints: settings.get(req.user.school_id).initialPoints, adds: 0, deducts: 0, net: 0, recordCount: 0, total: settings.get(req.user.school_id).initialPoints };
    const recent = db
      .prepare(
        `SELECT * FROM score_records WHERE student_id=? ${term ? "AND term_id=?" : ""}
         ORDER BY occurrence_at DESC, created_at DESC LIMIT 10`,
      )
      .all(...(term ? [student.id, term.id] : [student.id]));
    res.json({
      student: {
        id: student.id,
        name: student.name,
        studentNo: student.student_no,
        gender: student.gender,
        classId: student.class_id,
        className: student.class_name,
        gradeId: student.grade_id,
        gradeName: student.grade_name,
        status: student.status,
        joinedAt: student.joined_at,
      },
      score: {
        initialPoints: score.initialPoints,
        adds: score.adds,
        deducts: score.deducts,
        total: score.total,
        recordCount: score.recordCount,
      },
      term: termView(term),
      recentRecords: recordViews(db, recent),
    });
  });

  // -------------------------------------------------------------- 教师
  app.get("/api/teachers", auth, requireManagement, (req, res) => {
    const schoolId = req.user.school_id;
    const search = q(req, "search");
    const clauses = ["t.school_id=?"];
    const params = [schoolId];
    if (search) {
      clauses.push("(t.name LIKE ? ESCAPE '\\' OR t.employee_no LIKE ? ESCAPE '\\')");
      const pattern = likePattern(search);
      params.push(pattern, pattern);
    }
    const rows = db
      .prepare(
        `SELECT t.*, u.id AS user_id, u.account, u.role
         FROM teachers t LEFT JOIN users u ON u.teacher_id=t.id
         WHERE ${clauses.join(" AND ")}
         ORDER BY t.employee_no, t.name`,
      )
      .all(...params);
    res.json({
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        employeeNo: row.employee_no,
        subject: row.subject,
        phone: row.phone,
        status: row.status,
        account: row.account || "",
        userId: row.user_id || null,
        role: row.role || null,
        roleLabel: row.role ? ROLE_LABELS[row.role] || row.role : "",
      })),
    });
  });

  app.post("/api/teachers", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(teacherCreateSchema, req.body);
    const id = ctx.uid();
    try {
      db.prepare(
        "INSERT INTO teachers(id,school_id,name,employee_no,subject,phone,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        id,
        req.user.school_id,
        body.name,
        body.employeeNo,
        body.subject || "",
        body.phone || "",
        body.status || "ACTIVE",
        iso(),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw httpError(400, "该教师工号已存在");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "TEACHER_CREATE",
      targetType: "TEACHER",
      targetId: id,
      summary: `新建教师档案（工号 ${body.employeeNo}），未自动创建账号`,
    });
    res.status(201).json({
      teacher: {
        id,
        name: body.name,
        employeeNo: body.employeeNo,
        subject: body.subject || "",
        phone: body.phone || "",
        status: body.status || "ACTIVE",
        account: "",
        userId: null,
      },
    });
  });

  app.patch("/api/teachers/:id", auth, requireAdmin, (req, res) => {
    const body = ctx.parseBody(teacherPatchSchema, req.body);
    const schoolId = req.user.school_id;
    const teacher = db
      .prepare("SELECT * FROM teachers WHERE id=? AND school_id=?")
      .get(String(req.params.id), schoolId);
    if (!teacher) throw httpError(404, "教师不存在");
    const next = {
      name: body.name ?? teacher.name,
      employee_no: body.employeeNo ?? teacher.employee_no,
      subject: body.subject ?? teacher.subject,
      phone: body.phone ?? teacher.phone,
      status: body.status || teacher.status,
    };
    try {
      db.prepare(
        "UPDATE teachers SET name=?, employee_no=?, subject=?, phone=?, status=? WHERE id=? AND school_id=?",
      ).run(next.name, next.employee_no, next.subject, next.phone, next.status, teacher.id, schoolId);
    } catch (error) {
      if (isUniqueViolation(error)) throw httpError(400, "该教师工号已存在");
      throw error;
    }
    audit.record({
      req,
      user: req.user,
      action: "TEACHER_UPDATE",
      targetType: "TEACHER",
      targetId: teacher.id,
      summary: `更新教师档案（工号 ${next.employee_no}）`,
      before: {
        name: teacher.name,
        employeeNo: teacher.employee_no,
        subject: teacher.subject,
        phone: teacher.phone,
        status: teacher.status,
      },
      after: next,
    });
    res.json({ teacher: { id: teacher.id, ...next } });
  });

  // ---------------------------------------------------------- 选择器数据
  app.get("/api/options", auth, requireStaff, (req, res) => {
    const schoolId = req.user.school_id;
    const allowedClassIds = scope.classIdsFor(req.user);
    const grades = db
      .prepare("SELECT id,name,sort_order FROM grades WHERE school_id=? ORDER BY sort_order,name")
      .all(schoolId);
    const allowedGrades = scopedGradeIds(db, scope, req.user);
    const classes = classRows(db, schoolId, allowedClassIds);
    const categories = db
      .prepare(
        `SELECT id,name,direction_scope,sort_order,is_enabled FROM scoring_categories
         WHERE school_id=? AND is_enabled=1 ORDER BY sort_order,name`,
      )
      .all(schoolId);
    const versions = db
      .prepare(
        `SELECT v.*, cat.name AS category_name FROM scoring_rule_versions v
         JOIN scoring_rules r ON r.id=v.rule_id AND r.active_version_id=v.id
         LEFT JOIN scoring_categories cat ON cat.id=v.category_id
         WHERE r.school_id=? AND v.status='PUBLISHED'
           AND (v.effective_from IS NULL OR v.effective_from<=?)
           AND (v.effective_to IS NULL OR v.effective_to>=?)
         ORDER BY v.name`,
      )
      .all(schoolId, today(), today());
    const teacherClassIds = allowedClassIds || classes.map((row) => row.id);
    const teacherGradeIds = allowedGrades || grades.map((row) => row.id);
    const publishedRules = versions
      .filter((version) =>
        publishScopeFilter(version, {
          fullScope: allowedClassIds === null,
          classIds: teacherClassIds,
          gradeIds: teacherGradeIds,
        }),
      )
      .map((version) => {
        let scopeIds = [];
        try {
          scopeIds = JSON.parse(version.scope_json || "[]");
        } catch {
          scopeIds = [];
        }
        return {
          id: version.rule_id,
          versionId: version.id,
          version: version.version,
          name: version.name,
          categoryId: version.category_id,
          categoryName: version.category_name || "",
          direction: version.direction,
          points: version.points,
          minPoints: version.min_points,
          maxPoints: version.max_points,
          targetScope: version.target_scope,
          scopeIds: Array.isArray(scopeIds) ? scopeIds : [],
          evidenceRequired: version.evidence_required === 1,
          requiresReview: version.requires_review === 1,
          description: version.description,
          examples: version.examples,
          status: version.status,
          effectiveFrom: version.effective_from,
          effectiveTo: version.effective_to,
        };
      });
    const terms = db
      .prepare(
        `SELECT t.id,t.name,t.start_date,t.end_date,t.is_current,y.name AS academic_year_name
         FROM terms t JOIN academic_years y ON y.id=t.academic_year_id
         WHERE t.school_id=? ORDER BY t.start_date DESC, t.name DESC`,
      )
      .all(schoolId);
    res.json({
      grades: grades
        .filter((row) => (allowedGrades === null ? true : allowedGrades.includes(row.id)))
        .map((row) => ({ id: row.id, name: row.name, sortOrder: row.sort_order })),
      classes: classes.map((row) => ({
        id: row.id,
        name: row.name,
        gradeId: row.grade_id,
        gradeName: row.grade_name,
        headTeacherName: row.head_teacher_name || "",
        studentCount: row.student_count,
      })),
      categories: categories.map((row) => ({
        id: row.id,
        name: row.name,
        directionScope: row.direction_scope,
        sortOrder: row.sort_order,
        isEnabled: row.is_enabled === 1,
      })),
      publishedRules,
      terms: terms.map((row) => ({
        id: row.id,
        name: row.name,
        startDate: row.start_date,
        endDate: row.end_date,
        isCurrent: row.is_current === 1,
        academicYearName: row.academic_year_name,
      })),
    });
  });

  app.get("/api/options/students", auth, requireStaff, (req, res) => {
    const classId = q(req, "classId");
    const search = q(req, "search");
    const scol = scope.scopedStudents(req.user, { classId, search });
    const rows = db
      .prepare(
        `SELECT s.id,s.name,s.student_no,s.class_id,c.name AS class_name,s.grade_id,g.name AS grade_name
         FROM students s JOIN classes c ON c.id=s.class_id JOIN grades g ON g.id=s.grade_id
         WHERE ${scol.where} ORDER BY c.sort_order, c.name, s.student_no LIMIT 500`,
      )
      .all(...scol.params);
    res.json({
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        studentNo: row.student_no,
        classId: row.class_id,
        className: row.class_name,
        gradeId: row.grade_id,
        gradeName: row.grade_name,
      })),
    });
  });
}
