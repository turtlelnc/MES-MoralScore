// 数据分析测试：仪表盘真实聚合、班级人均分口径、多维筛选一致性、
// 异常提醒、范围隔离与 CSV 导出裁剪。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestServer } from "./test-utils.mjs";

let s: any;

beforeAll(async () => {
  s = await createTestServer();
});
afterAll(async () => {
  if (s) await s.close();
});

const termId = () => s.fixtures.currentTerm.id;

function perStudentTotals({ classIds = null, gradeId = "" }: { classIds?: string[] | null; gradeId?: string } = {}) {
  const clauses = ["s.school_id=?", "s.status='ACTIVE'"];
  const params: any[] = [s.fixtures.schoolId];
  if (classIds) {
    clauses.push(`s.class_id IN (${classIds.map(() => "?").join(",")})`);
    params.push(...classIds);
  }
  if (gradeId) {
    clauses.push("s.grade_id=?");
    params.push(gradeId);
  }
  return s.db
    .prepare(
      `SELECT s.id AS studentId, s.class_id AS classId, s.grade_id AS gradeId,
         COALESCE(SUM(CASE WHEN r.signed_points>0 THEN r.signed_points ELSE 0 END),0) AS adds,
         COALESCE(SUM(CASE WHEN r.signed_points<0 THEN -r.signed_points ELSE 0 END),0) AS deducts,
         COALESCE(SUM(r.signed_points),0) AS net, COUNT(r.id) AS recordCount
       FROM students s
       LEFT JOIN score_records r ON r.student_id=s.id AND r.term_id=? AND r.status='EFFECTIVE'
       WHERE ${clauses.join(" AND ")}
       GROUP BY s.id`,
    )
    .all(termId(), ...params)
    .map((row: any) => ({ ...row, total: Math.max(0, 100 + row.net) }));
}

function mean(list: number[]): number {
  return Math.round((list.reduce((sum, value) => sum + value, 0) / list.length) * 10) / 10;
}

function sum(list: any[], key: string): number {
  return list.reduce((acc, row) => acc + (Number(row[key]) || 0), 0);
}

describe("仪表盘真实聚合", () => {
  it("KPI、趋势、班级/年级分布均与数据库一致", async () => {
    const { cookie } = await s.login("admin");
    const res = await s.request("/api/dashboard", { cookie });
    expect(res.status).toBe(200);
    const totals = perStudentTotals();
    const expectedAvg = mean(totals.map((row: any) => row.total));
    expect(res.body.kpis.studentCount).toBe(totals.length);
    expect(res.body.kpis.avgScore).toBe(expectedAvg);
    expect(res.body.kpis.classCount).toBe(5);
    const effective = s.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN signed_points>0 THEN signed_points ELSE 0 END),0) adds,
                COALESCE(SUM(CASE WHEN signed_points<0 THEN -signed_points ELSE 0 END),0) deducts,
                COALESCE(SUM(signed_points),0) net, COUNT(*) count
         FROM score_records WHERE term_id=? AND status='EFFECTIVE'`,
      )
      .get(termId());
    expect(res.body.kpis.totalAdds).toBe(effective.adds);
    expect(res.body.kpis.totalDeducts).toBe(effective.deducts);
    expect(res.body.kpis.net).toBe(effective.net);
    expect(res.body.kpis.recordCount).toBe(effective.count);
    // 趋势按天且与 KPI 吻合
    expect(sum(res.body.trend, "adds")).toBe(effective.adds);
    expect(sum(res.body.trend, "deducts")).toBe(effective.deducts);
    expect(sum(res.body.trend, "net")).toBe(effective.net);
    expect(res.body.trend.every((item: any) => /^\d{4}-\d{2}-\d{2}$/.test(item.date))).toBe(true);
    // 待处理项来自真实查询
    const pendingReview = s.db.prepare("SELECT COUNT(*) c FROM score_records WHERE status='PENDING_REVIEW'").get().c;
    const pendingSubmissions = s.db.prepare("SELECT COUNT(*) c FROM student_submissions WHERE status='PENDING_REVIEW'").get().c;
    const openAppeals = s.db.prepare("SELECT COUNT(*) c FROM appeals WHERE status IN ('SUBMITTED','UNDER_REVIEW')").get().c;
    expect(res.body.kpis.pendingReviewCount).toBe(pendingReview);
    expect(res.body.kpis.pendingSubmissionCount).toBe(pendingSubmissions);
    expect(res.body.kpis.openAppealCount).toBe(openAppeals);
    // 分布同时返回人均分与人数
    expect(res.body.classDistribution.length).toBe(5);
    expect(
      res.body.classDistribution.every((item: any) => typeof item.avgScore === "number" && item.studentCount > 0),
    ).toBe(true);
    expect(res.body.classDistribution.reduce((acc: number, item: any) => acc + item.studentCount, 0)).toBe(totals.length);
    expect(res.body.gradeDistribution.length).toBe(3);
    expect(res.body.categories.length).toBeGreaterThan(0);
    expect(res.body.topPositiveRules.length).toBeGreaterThan(0);
    expect(res.body.topPositiveRules.length).toBeLessThanOrEqual(5);
    expect(res.body.alerts.length).toBeLessThanOrEqual(5);
    expect(res.body.recentRecords.length).toBeGreaterThan(0);
    expect(res.body.recentRecords[0].studentName).toBeTruthy();
    expect(res.body.term.id).toBe(termId());
  });

  it("班级对比使用人均分口径而非总分", async () => {
    const { cookie } = await s.login("admin");
    const res = await s.request("/api/analytics/overview", { cookie });
    expect(res.status).toBe(200);
    const totals = perStudentTotals();
    const classSizes = new Map<string, number>();
    for (const row of totals) classSizes.set(row.classId, (classSizes.get(row.classId) || 0) + 1);
    expect(res.body.classComparison.length).toBe(5);
    for (const item of res.body.classComparison) {
      const students = totals.filter((row: any) => row.classId === item.classId);
      expect(item.studentCount).toBe(students.length);
      expect(item.avgScore).toBe(mean(students.map((row: any) => row.total)));
      // 人均分不等于总分（班级人数 > 1）
      expect(item.avgScore).not.toBe(sum(students, "total"));
    }
    // 年级对比同样归一化
    for (const item of res.body.gradeComparison) {
      const students = totals.filter((row: any) => row.gradeId === item.gradeId);
      expect(item.studentCount).toBe(students.length);
      expect(item.avgScore).toBe(mean(students.map((row: any) => row.total)));
    }
  });

  it("无 termId 时默认当前学期，指定老学期返回零值数据", async () => {
    const { cookie } = await s.login("admin");
    const oldTerm = s.fixtures.terms.find((term: any) => !term.is_current);
    const res = await s.request(`/api/dashboard?termId=${oldTerm.id}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.term.id).toBe(oldTerm.id);
    expect(res.body.kpis.totalAdds).toBe(0);
    expect(res.body.kpis.totalDeducts).toBe(0);
    expect(res.body.kpis.recordCount).toBe(0);
    expect(res.body.classDistribution.length).toBe(5);
    expect(
      res.body.classDistribution.every(
        (item: any) => item.adds === 0 && item.deducts === 0 && item.avgScore === 100,
      ),
    ).toBe(true);
    expect(res.body.categories).toEqual([]);
    expect(res.body.trend.every((item: any) => item.adds === 0 && item.deducts === 0)).toBe(true);
    const badTerm = await s.request("/api/dashboard?termId=00000000-0000-4000-8000-000000000000", { cookie });
    expect(badTerm.status).toBe(404);
  });
});

describe("多维分析的筛选一致性", () => {
  it("from/to 窗口的 KPI、趋势、规则排行与 SQL 一致", async () => {
    const { cookie } = await s.login("admin");
    const res = await s.request("/api/analytics/overview?from=2026-10-01&to=2026-10-10", { cookie });
    expect(res.status).toBe(200);
    const expected = s.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN signed_points>0 THEN signed_points ELSE 0 END),0) adds,
                COALESCE(SUM(CASE WHEN signed_points<0 THEN -signed_points ELSE 0 END),0) deducts,
                COALESCE(SUM(signed_points),0) net, COUNT(*) count
         FROM score_records WHERE status='EFFECTIVE'
           AND occurrence_at>='2026-10-01T00:00:00.000Z' AND occurrence_at<'2026-10-11T00:00:00.000Z'`,
      )
      .get();
    expect(res.body.kpis.totalAdds).toBe(expected.adds);
    expect(res.body.kpis.totalDeducts).toBe(expected.deducts);
    expect(res.body.kpis.net).toBe(expected.net);
    expect(res.body.kpis.recordCount).toBe(expected.count);
    expect(sum(res.body.trend, "adds")).toBe(expected.adds);
    expect(res.body.trend.length).toBe(10);
    expect(res.body.range).toEqual({ from: "2026-10-01", to: "2026-10-10" });
    // 分类与规则排行的数量口径一致
    expect(sum(res.body.categories, "recordCount")).toBe(expected.count);
    expect(sum(res.body.rules, "recordCount")).toBe(expected.count);
    // 时间对比与 SQL 一致
    const previous = s.db
      .prepare(
        `SELECT COUNT(*) count, COALESCE(SUM(signed_points),0) net FROM score_records
         WHERE status='EFFECTIVE' AND occurrence_at>='2026-09-21T00:00:00.000Z' AND occurrence_at<'2026-10-01T00:00:00.000Z'`,
      )
      .get();
    expect(res.body.timeComparison.current.recordCount).toBe(expected.count);
    expect(res.body.timeComparison.previous.recordCount).toBe(previous.count);
    expect(res.body.timeComparison.previous.net).toBe(previous.net);
    expect(res.body.timeComparison.label).toContain("上一统计期");
  });

  it("gradeId / classId 筛选与对应范围 SQL 一致", async () => {
    const { cookie: admin } = await s.login("admin");
    const gradeId = s.fixtures.grades[1].id; // 八年级
    let res = await s.request(`/api/analytics/overview?termId=${termId()}&gradeId=${gradeId}`, { cookie: admin });
    expect(res.status).toBe(200);
    const expected = s.db
      .prepare(
        `SELECT COUNT(*) count, COALESCE(SUM(signed_points),0) net FROM score_records
         WHERE term_id=? AND status='EFFECTIVE' AND grade_id=?`,
      )
      .get(termId(), gradeId);
    expect(res.body.kpis.recordCount).toBe(expected.count);
    expect(res.body.kpis.net).toBe(expected.net);
    expect(res.body.classComparison.every((item: any) => item.gradeName === "八年级")).toBe(true);
    expect(res.body.gradeComparison.length).toBe(1);
    const classId = s.fixtures.classes[2].id;
    res = await s.request(`/api/analytics/overview?termId=${termId()}&classId=${classId}`, { cookie: admin });
    expect(res.status).toBe(200);
    expect(res.body.classComparison.length).toBe(1);
    expect(res.body.classComparison[0].classId).toBe(classId);
    expect(res.body.kpis.studentCount).toBe((s.db.prepare("SELECT COUNT(*) c FROM students WHERE class_id=? AND status='ACTIVE'").get(classId)).c);
  });

  it("空窗口返回零值数组而不是报错", async () => {
    const { cookie } = await s.login("admin");
    const res = await s.request("/api/analytics/overview?from=2020-01-01&to=2020-01-03", { cookie });
    expect(res.status).toBe(200);
    expect(res.body.kpis.recordCount).toBe(0);
    expect(res.body.kpis.totalAdds).toBe(0);
    expect(res.body.kpis.net).toBe(0);
    expect(res.body.trend.length).toBe(3);
    expect(res.body.trend.every((item: any) => item.adds === 0 && item.deducts === 0 && item.net === 0)).toBe(true);
    expect(res.body.categories).toEqual([]);
    expect(res.body.rules).toEqual([]);
    const invalid = await s.request("/api/analytics/overview?from=2026-13-40", { cookie });
    expect(invalid.status).toBe(400);
    const reversed = await s.request("/api/analytics/overview?from=2026-10-10&to=2026-10-01", { cookie });
    expect(reversed.status).toBe(400);
  });
});

describe("数据范围隔离", () => {
  it("值日老师仪表盘与分析只包含授权班级", async () => {
    const { cookie } = await s.login("teacher1");
    const res = await s.request("/api/dashboard", { cookie });
    expect(res.status).toBe(200);
    const classIds = [s.fixtures.classes[0].id, s.fixtures.classes[1].id];
    const totals = perStudentTotals({ classIds });
    expect(res.body.kpis.studentCount).toBe(totals.length);
    expect(res.body.kpis.avgScore).toBe(mean(totals.map((row: any) => row.total)));
    expect(res.body.classDistribution.length).toBe(2);
    expect(
      res.body.classDistribution.every((item: any) => item.className === "1班" || item.className === "2班"),
    ).toBe(true);
    expect(
      res.body.recentRecords.every((item: any) => item.gradeName === "七年级"),
    ).toBe(true);
    const overview = await s.request("/api/analytics/overview", { cookie });
    expect(overview.status).toBe(200);
    const expectedRecords = s.db
      .prepare(
        `SELECT COUNT(*) c FROM score_records WHERE term_id=? AND status='EFFECTIVE' AND class_id IN (?,?)`,
      )
      .get(termId(), classIds[0], classIds[1]);
    expect(overview.body.kpis.recordCount).toBe(expectedRecords.c);
  });

  it("越权班级/年级筛选返回 403，学生分析亦然", async () => {
    const { cookie } = await s.login("teacher1");
    const otherClass = s.fixtures.classes[2];
    const otherGrade = s.fixtures.grades[1].id;
    const byClass = await s.request(`/api/analytics/overview?classId=${otherClass.id}`, { cookie });
    expect(byClass.status).toBe(403);
    const byGrade = await s.request(`/api/analytics/overview?gradeId=${otherGrade}`, { cookie });
    expect(byGrade.status).toBe(403);
    const otherStudent = s.fixtures.students.find((student: any) => student.class_id === otherClass.id);
    const student = await s.request(`/api/analytics/students/${otherStudent.id}`, { cookie });
    expect(student.status).toBe(403);
    const ownStudent = s.fixtures.students.find((item: any) => item.class_id === s.fixtures.classes[0].id);
    const own = await s.request(`/api/analytics/students/${ownStudent.id}`, { cookie });
    expect(own.status).toBe(200);
    expect(own.body.trend.length).toBeGreaterThan(0);
    expect(own.body.categories.length).toBeGreaterThan(0);
    expect(own.body.recentRecords[0].studentId).toBe(ownStudent.id);
  });

  it("CSV 导出按权限裁剪并且不含其他班级姓名", async () => {
    const { cookie } = await s.login("teacher1");
    const classes = await s.request("/api/analytics/export.csv?type=classes", { cookie });
    expect(classes.status).toBe(200);
    const classLines = String(classes.body).trim().split("\r\n");
    expect(classLines.length).toBe(3); // 表头 + 2 个班级
    expect(classLines[0]).toContain("人均分");
    const students = await s.request("/api/analytics/export.csv?type=students", { cookie });
    expect(students.status).toBe(200);
    expect(String(students.body).trim().split("\r\n").length).toBe(35); // 表头 + 34 名学生
    const records = await s.request("/api/analytics/export.csv?type=records", { cookie });
    expect(records.status).toBe(200);
    const text = String(records.body);
    expect(text).not.toContain("八年级");
    expect(text).not.toContain("九年级");
    const forbidden = await s.request(`/api/analytics/export.csv?type=records&classId=${s.fixtures.classes[2].id}`, {
      cookie,
    });
    expect(forbidden.status).toBe(403);
    const invalidType = await s.request("/api/analytics/export.csv?type=unknown", { cookie });
    expect(invalidType.status).toBe(400);
  });
});

describe("异常提醒基于真实查询", () => {
  function insertRecord({ student, direction, points, occurrenceAt }: any) {
    const version = s.db
      .prepare(
        "SELECT * FROM scoring_rule_versions WHERE school_id=? AND direction=? AND status='PUBLISHED' LIMIT 1",
      )
      .get(s.fixtures.schoolId, direction);
    s.db
      .prepare(
        `INSERT INTO score_records(id,school_id,academic_year_id,term_id,student_id,class_id,grade_id,rule_id,rule_version_id,rule_snapshot_json,category_id,category_name,direction,points,signed_points,record_kind,status,occurrence_at,note,evidence_json,source,submitter_id,reviewer_id,reviewed_at,review_note,submission_id,reverses_record_id,corrects_record_id,batch_id,created_at,effective_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'STANDARD','EFFECTIVE',?,?,'[]','TEACHER',?,?,?, '',NULL,NULL,NULL,NULL,?,?)`,
      )
      .run(
        randomUUID(),
        s.fixtures.schoolId,
        s.fixtures.terms.find((term: any) => term.is_current).academic_year_id,
        termId(),
        student.id,
        student.class_id,
        student.grade_id,
        version.rule_id,
        version.id,
        JSON.stringify({ name: version.name, categoryName: version.name, direction, points, version: 1 }),
        version.category_id,
        version.name,
        direction,
        points,
        direction === "ADD" ? points : -points,
        occurrenceAt,
        "异常提醒测试记录",
        s.fixtures.userIds.admin,
        s.fixtures.userIds.admin,
        occurrenceAt,
        occurrenceAt,
        occurrenceAt,
      );
  }

  it("24 小时高频减分、大额记录、7 天无记录班级均生成真实提醒", async () => {
    const now = new Date().toISOString();
    const classEight = s.fixtures.classes[2];
    const studentEight = s.fixtures.students.find((item: any) => item.class_id === classEight.id);
    for (let index = 0; index < 4; index += 1) {
      insertRecord({ student: studentEight, direction: "DEDUCT", points: 1, occurrenceAt: now });
    }
    const otherEight = s.fixtures.students.filter((item: any) => item.class_id === classEight.id)[1];
    insertRecord({ student: otherEight, direction: "ADD", points: 20, occurrenceAt: now });

    const { cookie: admin } = await s.login("admin");
    const idleClass = s.fixtures.grades[0];
    const createClass = await s.request("/api/classes", {
      method: "POST",
      cookie: admin,
      body: { gradeId: idleClass.id, name: "无记录班" },
    });
    expect(createClass.status).toBe(201);

    const dashboard = await s.request("/api/dashboard", { cookie: admin });
    expect(dashboard.status).toBe(200);
    const alerts = dashboard.body.alerts;
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.length).toBeLessThanOrEqual(5);
    const deductAlert = alerts.find((item: any) => String(item.id).startsWith("deduct-24h"));
    expect(deductAlert).toBeTruthy();
    expect(deductAlert.title).toContain(studentEight.name);
    expect(deductAlert.count).toBeGreaterThanOrEqual(3);
    expect(deductAlert.level).toBe("warn");
    const bigAlert = alerts.find((item: any) => item.id === "high-points");
    expect(bigAlert).toBeTruthy();
    expect(bigAlert.count).toBeGreaterThanOrEqual(1);
    const idleAlert = alerts.find((item: any) => item.id === "idle-classes");
    expect(idleAlert).toBeTruthy();
    expect(idleAlert.title).toContain("7 天内无积分记录");

    // 值日老师看不到其他班级学生的提醒
    const { cookie: teacher } = await s.login("teacher1");
    const scopedDashboard = await s.request("/api/dashboard", { cookie: teacher });
    expect(scopedDashboard.status).toBe(200);
    expect(JSON.stringify(scopedDashboard.body.alerts)).not.toContain(studentEight.name);
  });
});
