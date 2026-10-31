// 基础资料模块测试：学校/学年学期/年级班级/学生/教师/选择器与数据范围隔离。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer } from "./test-utils.mjs";

let s: any;

beforeAll(async () => {
  s = await createTestServer();
});
afterAll(async () => {
  if (s) await s.close();
});

describe("学校资料与权限", () => {
  it("三类角色均可读取学校资料与系统参数", async () => {
    for (const key of ["admin", "moral", "teacher1"]) {
      const { cookie } = await s.login(key);
      const res = await s.request("/api/school", { cookie });
      expect(res.status).toBe(200);
      expect(res.body.school.name).toContain("云杉实验学校");
      expect(res.body.settings).toEqual({ initialPoints: 100, allowNegative: false, reviewThreshold: 10 });
    }
  });

  it("德育处与值日老师不能修改基础资料", async () => {
    for (const key of ["moral", "teacher1"]) {
      const { cookie } = await s.login(key);
      const res = await s.request("/api/school", { method: "PATCH", cookie, body: { name: "越权改名" } });
      expect(res.status).toBe(403);
    }
  });

  it("管理员可以修改学校资料并写入审计日志", async () => {
    const { cookie } = await s.login("admin");
    const res = await s.request("/api/school", {
      method: "PATCH",
      cookie,
      body: { name: "云杉实验学校（测试）", address: "测试路 1 号", stage: "初中" },
    });
    expect(res.status).toBe(200);
    expect(res.body.school.name).toBe("云杉实验学校（测试）");
    const audit = s.db.prepare("SELECT action FROM audit_logs WHERE action='SCHOOL_UPDATE'").get();
    expect(audit).toBeTruthy();
    // 校验错误走中文消息
    const bad = await s.request("/api/school", { method: "PATCH", cookie, body: { stage: "大学" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("学段");
    const empty = await s.request("/api/school", { method: "PATCH", cookie, body: {} });
    expect(empty.status).toBe(400);
  });
});

describe("学年与学期", () => {
  it("返回学年-学期树与当前学期", async () => {
    const { cookie } = await s.login("admin");
    const res = await s.request("/api/periods", { cookie });
    expect(res.status).toBe(200);
    expect(res.body.years.length).toBe(2);
    expect(res.body.currentTermId).toBe(s.fixtures.currentTerm.id);
    const currentYear = res.body.years.find((year: any) => year.isCurrent);
    expect(currentYear.terms.some((term: any) => term.id === s.fixtures.currentTerm.id)).toBe(true);
  });

  it("切换当前学期后 school 内唯一且所有查询默认新当前学期", async () => {
    const { cookie } = await s.login("admin");
    const oldTerm = s.fixtures.terms.find((term: any) => term.id !== s.fixtures.currentTerm.id);
    const res = await s.request(`/api/terms/${oldTerm.id}/current`, { method: "POST", cookie, body: {} });
    expect(res.status).toBe(200);
    expect(res.body.currentTermId).toBe(oldTerm.id);
    const currentRows = s.db
      .prepare("SELECT COUNT(*) AS count FROM terms WHERE school_id=? AND is_current=1")
      .get(s.fixtures.schoolId);
    expect(currentRows.count).toBe(1);
    const yearRows = s.db
      .prepare("SELECT COUNT(*) AS count FROM academic_years WHERE school_id=? AND is_current=1")
      .get(s.fixtures.schoolId);
    expect(yearRows.count).toBe(1);
    const periods = await s.request("/api/periods", { cookie });
    expect(periods.body.currentTermId).toBe(oldTerm.id);
    // 默认统计（无 termId）跟随当前学期：老学期没有记录
    const dashboard = await s.request("/api/dashboard", { cookie });
    expect(dashboard.body.kpis.recordCount).toBe(0);
    expect(dashboard.body.term.id).toBe(oldTerm.id);
    // 切回原学期
    const back = await s.request(`/api/terms/${s.fixtures.currentTerm.id}/current`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(back.status).toBe(200);
    expect(back.body.currentTermId).toBe(s.fixtures.currentTerm.id);
  });

  it("值日老师不能新建学年/学期或切换学期", async () => {
    const { cookie } = await s.login("teacher1");
    const year = await s.request("/api/academic-years", {
      method: "POST",
      cookie,
      body: { name: "2028-2029 学年", startDate: "2028-09-01", endDate: "2029-07-10" },
    });
    expect(year.status).toBe(403);
    const term = await s.request(`/api/terms/${s.fixtures.currentTerm.id}/current`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(term.status).toBe(403);
  });

  it("管理员可新建学年与学期，日期校验为中文错误", async () => {
    const { cookie } = await s.login("admin");
    const badYear = await s.request("/api/academic-years", {
      method: "POST",
      cookie,
      body: { name: "坏学年", startDate: "2029-09-01", endDate: "2028-07-10" },
    });
    expect(badYear.status).toBe(400);
    expect(badYear.body.error).toContain("开始日期必须早于结束日期");
    const year = await s.request("/api/academic-years", {
      method: "POST",
      cookie,
      body: { name: "2028-2029 学年", startDate: "2028-09-01", endDate: "2029-07-10" },
    });
    expect(year.status).toBe(201);
    const term = await s.request("/api/terms", {
      method: "POST",
      cookie,
      body: {
        academicYearId: year.body.academicYear.id,
        name: "2028 秋季学期",
        startDate: "2028-09-01",
        endDate: "2029-01-20",
      },
    });
    expect(term.status).toBe(201);
    expect(term.body.term.isCurrent).toBe(false);
    const duplicate = await s.request("/api/terms", {
      method: "POST",
      cookie,
      body: {
        academicYearId: year.body.academicYear.id,
        name: "2028 秋季学期",
        startDate: "2028-09-02",
        endDate: "2029-01-21",
      },
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toContain("同名学期");
  });
});

describe("年级、班级与数据范围隔离", () => {
  it("管理员/德育处看到全校年级与班级", async () => {
    for (const key of ["admin", "moral"]) {
      const { cookie } = await s.login(key);
      const grades = await s.request("/api/grades", { cookie });
      expect(grades.status).toBe(200);
      expect(grades.body.items.length).toBe(3);
      const classes = await s.request("/api/classes", { cookie });
      expect(classes.body.items.length).toBe(5);
      expect(classes.body.items.every((item: any) => item.className === undefined && item.name)).toBe(true);
    }
  });

  it("值日老师只看到授权年级与班级", async () => {
    const { cookie } = await s.login("teacher1");
    const grades = await s.request("/api/grades", { cookie });
    expect(grades.body.items.map((item: any) => item.name)).toEqual(["七年级"]);
    const classes = await s.request("/api/classes", { cookie });
    expect(classes.body.items.length).toBe(2);
    expect(classes.body.items.every((item: any) => item.gradeName === "七年级")).toBe(true);
    expect(classes.body.items.every((item: any) => item.studentCount > 0)).toBe(true);
    const forbiddenGrade = await s.request(
      `/api/classes?gradeId=${s.fixtures.grades[1].id}`,
      { cookie },
    );
    expect(forbiddenGrade.status).toBe(403);
  });

  it("学生列表按范围裁剪且不泄露其他班级姓名", async () => {
    const { cookie: t1 } = await s.login("teacher1");
    const own = await s.request("/api/students?pageSize=100", { cookie: t1 });
    expect(own.status).toBe(200);
    expect(own.body.total).toBe(34);
    expect(own.body.items.every((item: any) => item.gradeName === "七年级")).toBe(true);
    expect(new Set(own.body.items.map((item: any) => item.className))).toEqual(new Set(["1班", "2班"]));
    // 显式请求其他班级 → 403
    const otherClass = s.fixtures.classes[2];
    const forbidden = await s.request(`/api/students?classId=${otherClass.id}`, { cookie: t1 });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toContain("无权");
    // 学生详情越权 → 403
    const otherStudent = s.fixtures.students.find((student: any) => student.class_id === otherClass.id);
    const detail = await s.request(`/api/students/${otherStudent.id}`, { cookie: t1 });
    expect(detail.status).toBe(403);
    expect(JSON.stringify(detail.body)).not.toContain(otherStudent.name);
  });

  it("学生详情包含真实积分构成", async () => {
    const { cookie } = await s.login("admin");
    const student = s.fixtures.students.find((item: any) => item.class_id === s.fixtures.classes[0].id);
    const res = await s.request(`/api/students/${student.id}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.student.id).toBe(student.id);
    const expected = s.db
      .prepare(
        `SELECT COALESCE(SUM(signed_points),0) AS net, COUNT(*) AS recordCount FROM score_records
         WHERE student_id=? AND term_id=? AND status='EFFECTIVE'`,
      )
      .get(student.id, s.fixtures.currentTerm.id);
    expect(res.body.score.initialPoints).toBe(100);
    expect(res.body.score.recordCount).toBe(expected.recordCount);
    expect(res.body.score.total).toBe(Math.max(0, 100 + expected.net));
    expect(res.body.recentRecords.length).toBeGreaterThan(0);
    expect(res.body.recentRecords[0].studentName).toBe(student.name);
  });
});

describe("学生与教师档案维护", () => {
  it("管理员创建/修改学生并校验学号唯一", async () => {
    const { cookie } = await s.login("admin");
    const classId = s.fixtures.classes[1].id;
    const created = await s.request("/api/students", {
      method: "POST",
      cookie,
      body: { name: "测试学生", studentNo: "T900001", classId, gender: "男" },
    });
    expect(created.status).toBe(201);
    expect(created.body.student.studentNo).toBe("T900001");
    const duplicate = await s.request("/api/students", {
      method: "POST",
      cookie,
      body: { name: "重复学号", studentNo: "T900001", classId },
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toContain("学号");
    const patched = await s.request(`/api/students/${created.body.student.id}`, {
      method: "PATCH",
      cookie,
      body: { name: "测试学生甲", classId: s.fixtures.classes[0].id },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.student.name).toBe("测试学生甲");
    expect(patched.body.student.classId).toBe(s.fixtures.classes[0].id);
    const listed = await s.request(`/api/students?search=T900001`, { cookie });
    expect(listed.body.items[0].name).toBe("测试学生甲");
    // status 筛选：默认只返回 ACTIVE，可查询休学/转学等历史档案
    const archived = await s.request(`/api/students/${created.body.student.id}`, {
      method: "PATCH",
      cookie,
      body: { status: "ARCHIVED" },
    });
    expect(archived.status).toBe(200);
    const activeOnly = await s.request(`/api/students?search=T900001`, { cookie });
    expect(activeOnly.body.total).toBe(0);
    const archivedOnly = await s.request(`/api/students?status=ARCHIVED&search=T900001`, { cookie });
    expect(archivedOnly.status).toBe(200);
    expect(archivedOnly.body.items.length).toBe(1);
    expect(archivedOnly.body.items[0].status).toBe("ARCHIVED");
    const invalidStatus = await s.request("/api/students?status=UNKNOWN", { cookie });
    expect(invalidStatus.status).toBe(400);
  });

  it("德育处与学生不能写学生/教师档案", async () => {
    for (const key of ["moral", "teacher1"]) {
      const { cookie } = await s.login(key);
      const res = await s.request("/api/students", {
        method: "POST",
        cookie,
        body: { name: "越权", studentNo: "T900002", classId: s.fixtures.classes[0].id },
      });
      expect(res.status).toBe(403);
      const teacher = await s.request("/api/teachers", {
        method: "POST",
        cookie,
        body: { name: "越权教师", employeeNo: "T999" },
      });
      expect(teacher.status).toBe(403);
    }
  });

  it("教师档案仅管理员/德育处可见，新建教师不自动创建账号", async () => {
    const { cookie: admin } = await s.login("admin");
    const { cookie: teacher } = await s.login("teacher1");
    const denied = await s.request("/api/teachers", { cookie: teacher });
    expect(denied.status).toBe(403);
    const list = await s.request("/api/teachers", { cookie: admin });
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(8);
    expect(list.body.items.find((item: any) => item.account === "teacher1").role).toBe("DUTY_TEACHER");
    const usersBefore = s.db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    const created = await s.request("/api/teachers", {
      method: "POST",
      cookie: admin,
      body: { name: "导入老师", employeeNo: "T900", subject: "地理", phone: "13800009999" },
    });
    expect(created.status).toBe(201);
    expect(created.body.teacher.userId).toBeNull();
    expect(s.db.prepare("SELECT COUNT(*) AS count FROM users").get().count).toBe(usersBefore);
    const duplicate = await s.request("/api/teachers", {
      method: "POST",
      cookie: admin,
      body: { name: "重复工号", employeeNo: "T001" },
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toContain("工号");
    const patched = await s.request(`/api/teachers/${created.body.teacher.id}`, {
      method: "PATCH",
      cookie: admin,
      body: { subject: "历史" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.teacher.subject).toBe("历史");
  });
});

describe("选择器数据", () => {
  it("值日老师的选择器只包含授权范围与有效规则", async () => {
    const { cookie } = await s.login("teacher1");
    const res = await s.request("/api/options", { cookie });
    expect(res.status).toBe(200);
    expect(res.body.grades.map((item: any) => item.name)).toEqual(["七年级"]);
    expect(res.body.classes.length).toBe(2);
    expect(res.body.categories.length).toBe(9);
    // 20 条已发布规则中有一条仅适用九年级班级
    expect(res.body.publishedRules.length).toBe(19);
    expect(res.body.publishedRules.every((rule: any) => rule.name !== "中考冲刺自律标兵")).toBe(true);
    expect(
      res.body.publishedRules.every(
        (rule: any) => rule.categoryId && typeof rule.categoryName === "string",
      ),
    ).toBe(true);
    expect(res.body.terms.length).toBeGreaterThanOrEqual(3);
    const students = await s.request(`/api/options/students?classId=${s.fixtures.classes[0].id}`, { cookie });
    expect(students.status).toBe(200);
    expect(students.body.items.length).toBeGreaterThanOrEqual(18);
    expect(students.body.items[0].studentNo).toBeTruthy();
    expect(students.body.items[0].gradeId).toBeTruthy();
  });

  it("管理员选择器包含全校规则", async () => {
    const { cookie } = await s.login("admin");
    const res = await s.request("/api/options", { cookie });
    expect(res.body.grades.length).toBe(3);
    expect(res.body.classes.length).toBe(5);
    expect(res.body.publishedRules.length).toBe(20);
  });

  it("选择器学生接口拒绝越权班级", async () => {
    const { cookie } = await s.login("teacher1");
    const res = await s.request(`/api/options/students?classId=${s.fixtures.classes[2].id}`, { cookie });
    expect(res.status).toBe(403);
  });
});
