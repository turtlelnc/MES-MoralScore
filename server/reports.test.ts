// 成长报告测试：周/月/学期周期边界、真实聚合、确定性中文叙事、
// 荣誉与兑换参考、班级报告与数据范围隔离。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer } from "./test-utils.mjs";

let s: any;

beforeAll(async () => {
  s = await createTestServer();
});
afterAll(async () => {
  if (s) await s.close();
});

const termId = () => s.fixtures.currentTerm.id;

function periodSql(studentId: string, fromDate: string, toDate: string) {
  return s.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN signed_points>0 THEN signed_points ELSE 0 END),0) adds,
              COALESCE(SUM(CASE WHEN signed_points<0 THEN -signed_points ELSE 0 END),0) deducts,
              COALESCE(SUM(signed_points),0) net, COUNT(*) recordCount
       FROM score_records
       WHERE student_id=? AND term_id=? AND status='EFFECTIVE'
         AND occurrence_at>=? AND occurrence_at<?`,
    )
    .get(studentId, termId(), `${fromDate}T00:00:00.000Z`, `${toDate}T00:00:00.000Z`);
}

function termSql(studentId: string) {
  return s.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN signed_points>0 THEN signed_points ELSE 0 END),0) adds,
              COALESCE(SUM(CASE WHEN signed_points<0 THEN -signed_points ELSE 0 END),0) deducts,
              COALESCE(SUM(signed_points),0) net, COUNT(*) recordCount
       FROM score_records WHERE student_id=? AND term_id=? AND status='EFFECTIVE'`,
    )
    .get(studentId, termId());
}

function firstAddRecord() {
  return s.db
    .prepare(
      `SELECT student_id, substr(occurrence_at,1,10) AS day, occurrence_at FROM score_records
       WHERE status='EFFECTIVE' AND direction='ADD' AND term_id=? ORDER BY occurrence_at LIMIT 1`,
    )
    .get(termId());
}

const FORBIDDEN = ["差生", "问题学生", "坏学生", "无可救药", "屡教不改", "耻辱", "笨蛋", "垃圾"];

describe("学生周报告", () => {
  it("周一到周日边界与真实周期聚合", async () => {
    const { cookie } = await s.login("admin");
    const record = firstAddRecord();
    const res = await s.request(`/api/reports/student/${record.student_id}?period=week&date=${record.day}`, {
      cookie,
    });
    expect(res.status).toBe(200);
    const report = res.body;
    expect(report.period.type).toBe("week");
    const weekday = new Date(`${record.day}T00:00:00.000Z`).getUTCDay();
    const naturalFrom = new Date(
      new Date(`${record.day}T00:00:00.000Z`).getTime() - ((weekday + 6) % 7) * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    const naturalTo = new Date(new Date(`${naturalFrom}T00:00:00.000Z`).getTime() + 6 * 86400000)
      .toISOString()
      .slice(0, 10);
    const term = s.fixtures.currentTerm;
    const expectedFrom = naturalFrom < term.start_date ? term.start_date : naturalFrom;
    const expectedTo = naturalTo > term.end_date ? term.end_date : naturalTo;
    expect(report.period.from).toBe(expectedFrom);
    expect(report.period.to).toBe(expectedTo);
    expect(report.period.label).toContain("周报告");
    const expected = periodSql(record.student_id, expectedFrom, expectedTo);
    expect(report.score.initialPoints).toBe(100);
    expect(report.score.adds).toBe(expected.adds);
    expect(report.score.deducts).toBe(expected.deducts);
    expect(report.score.net).toBe(expected.net);
    expect(report.score.recordCount).toBe(expected.recordCount);
    expect(report.score.total).toBe(Math.max(0, 100 + expected.net));
    const trendDays =
      Math.round(
        (new Date(`${report.period.to}T00:00:00.000Z`) - new Date(`${report.period.from}T00:00:00.000Z`)) /
          86400000,
      ) + 1;
    expect(report.trend.length).toBe(trendDays);
    expect(report.trend.length).toBeGreaterThanOrEqual(6);
    expect(report.trend.reduce((acc: number, day: any) => acc + day.adds, 0)).toBe(expected.adds);
    expect(report.highlights.length).toBeGreaterThan(0);
    expect(report.highlights[0].ruleName).toBeTruthy();
    expect(report.highlights[0].occurrenceAt >= `${expectedFrom}T00:00:00.000Z`).toBe(true);
    expect(Array.isArray(report.composition)).toBe(true);
    expect(Array.isArray(report.attention)).toBe(true);
    expect(Array.isArray(report.ruleExplanations)).toBe(true);
    expect(report.student.name).toBeTruthy();
    expect(report.student.className).toBeTruthy();
  });

  it("叙事是确定性中文模板，包含亮点/关注/家庭配合且不标签化", async () => {
    const { cookie } = await s.login("admin");
    const record = firstAddRecord();
    const first = await s.request(`/api/reports/student/${record.student_id}?period=month&date=${record.day}`, {
      cookie,
    });
    const second = await s.request(`/api/reports/student/${record.student_id}?period=month&date=${record.day}`, {
      cookie,
    });
    expect(first.status).toBe(200);
    expect(Array.isArray(first.body.narrative)).toBe(true);
    expect(first.body.narrative.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(first.body.narrative)).toBe(JSON.stringify(second.body.narrative));
    const text = first.body.narrative.join("");
    expect(text).toContain(first.body.student.name);
    expect(text).toContain("家庭配合建议");
    for (const word of FORBIDDEN) expect(text).not.toContain(word);
    expect(first.body.privacyNote).toBe("仅限授权家长查看，不展示班级排名与其他学生信息");
  });

  it("荣誉 eligible 与兑换 affordable 根据配置和学期积分计算", async () => {
    const { cookie } = await s.login("admin");
    const record = firstAddRecord();
    const res = await s.request(`/api/reports/student/${record.student_id}?period=term`, { cookie });
    expect(res.status).toBe(200);
    const score = termSql(record.student_id);
    const total = Math.max(0, 100 + score.net);
    const positiveCount = s.db
      .prepare(
        "SELECT COUNT(*) c FROM score_records WHERE student_id=? AND term_id=? AND status='EFFECTIVE' AND direction='ADD'",
      )
      .get(record.student_id, termId()).c;
    expect(res.body.honors.length).toBe(3);
    const star = res.body.honors.find((item: any) => item.name === "德育之星");
    expect(star.eligible).toBe(total >= 130 && positiveCount >= 3);
    expect(typeof star.reason).toBe("string");
    expect(star.reason.length).toBeGreaterThan(0);
    const rewards = res.body.rewards;
    expect(rewards.length).toBe(3);
    for (const reward of rewards) expect(reward.affordable).toBe(total >= reward.pointsCost);
  });
});

describe("周期边界与裁剪", () => {
  it("周报告裁剪到学期范围", async () => {
    const { cookie } = await s.login("admin");
    const studentId = firstAddRecord().student_id;
    const atStart = await s.request(`/api/reports/student/${studentId}?period=week&date=2026-09-02`, { cookie });
    expect(atStart.status).toBe(200);
    expect(atStart.body.period.from).toBe("2026-09-01");
    expect(atStart.body.period.to).toBe("2026-09-06");
    const atEnd = await s.request(`/api/reports/student/${studentId}?period=week&date=2027-01-20`, { cookie });
    expect(atEnd.status).toBe(200);
    expect(atEnd.body.period.to).toBe("2027-01-20");
    expect(atEnd.body.period.from).toBe("2027-01-18");
  });

  it("月报告为自然月并裁剪到学期", async () => {
    const { cookie } = await s.login("admin");
    const studentId = firstAddRecord().student_id;
    const res = await s.request(`/api/reports/student/${studentId}?period=month&date=2026-10-15`, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.period.from).toBe("2026-10-01");
    expect(res.body.period.to).toBe("2026-10-31");
    expect(res.body.trend.length).toBe(31);
    const expected = periodSql(studentId, "2026-10-01", "2026-11-01");
    expect(res.body.score.net).toBe(expected.net);
    expect(res.body.score.recordCount).toBe(expected.recordCount);
    const sep = await s.request(`/api/reports/student/${studentId}?period=month&date=2026-09-15`, { cookie });
    expect(sep.body.period.from).toBe("2026-09-01");
    expect(sep.body.period.to).toBe("2026-09-30");
  });

  it("学期报告覆盖整学期，可指定 termId", async () => {
    const { cookie } = await s.login("admin");
    const studentId = firstAddRecord().student_id;
    const res = await s.request(`/api/reports/student/${studentId}?period=term`, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.period.from).toBe("2026-09-01");
    expect(res.body.period.to).toBe("2027-01-20");
    const expected = termSql(studentId);
    expect(res.body.score.adds).toBe(expected.adds);
    expect(res.body.score.deducts).toBe(expected.deducts);
    expect(res.body.score.recordCount).toBe(expected.recordCount);
    const oldTerm = s.fixtures.terms.find((term: any) => !term.is_current);
    const old = await s.request(`/api/reports/student/${studentId}?period=term&termId=${oldTerm.id}`, { cookie });
    expect(old.status).toBe(200);
    expect(old.body.score.recordCount).toBe(0);
    expect(old.body.score.net).toBe(0);
    expect(old.body.period.from).toBe(oldTerm.start_date);
  });

  it("非法周期、非法日期与学期外日期返回中文 400", async () => {
    const { cookie } = await s.login("admin");
    const studentId = firstAddRecord().student_id;
    const badPeriod = await s.request(`/api/reports/student/${studentId}?period=day`, { cookie });
    expect(badPeriod.status).toBe(400);
    expect(badPeriod.body.error).toContain("week/month/term");
    const badDate = await s.request(`/api/reports/student/${studentId}?period=week&date=2026-13-40`, { cookie });
    expect(badDate.status).toBe(400);
    const outside = await s.request(`/api/reports/student/${studentId}?period=week&date=2024-06-10`, { cookie });
    expect(outside.status).toBe(400);
    expect(outside.body.error).toContain("学期");
  });
});

describe("班级报告", () => {
  it("返回真实人均分、学生明细、分类与趋势", async () => {
    const { cookie } = await s.login("admin");
    const classId = s.fixtures.classes[0].id;
    const res = await s.request(`/api/reports/class/${classId}?termId=${termId()}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.class.id).toBe(classId);
    expect(res.body.class.studentCount).toBe(18);
    expect(res.body.students.length).toBe(18);
    const expectedAvg = (() => {
      const rows = s.db
        .prepare(
          `SELECT ? + COALESCE(SUM(r.signed_points),0) raw FROM students s
           LEFT JOIN score_records r ON r.student_id=s.id AND r.term_id=? AND r.status='EFFECTIVE'
           WHERE s.class_id=? AND s.status='ACTIVE' GROUP BY s.id`,
        )
        .all(100, termId(), classId)
        .map((row: any) => Math.max(0, row.raw));
      return Math.round((rows.reduce((sum: number, value: number) => sum + value, 0) / rows.length) * 10) / 10;
    })();
    expect(res.body.avgScore).toBe(expectedAvg);
    const totals = res.body.students.map((student: any) => student.total);
    expect(res.body.students[0].total).toBe(Math.max(...totals));
    expect(res.body.students.every((student: any) => typeof student.recordCount === "number")).toBe(true);
    expect(res.body.trend.reduce((acc: number, day: any) => acc + day.adds, 0)).toBe(res.body.adds);
    expect(res.body.trend.reduce((acc: number, day: any) => acc + day.deducts, 0)).toBe(res.body.deducts);
    expect(res.body.categories.length).toBeGreaterThan(0);
    expect(res.body.topPositiveRules.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.attentionRules)).toBe(true);
  });

  it("班级报告受数据范围限制", async () => {
    const { cookie: teacher } = await s.login("teacher1");
    const own = await s.request(`/api/reports/class/${s.fixtures.classes[0].id}`, { cookie: teacher });
    expect(own.status).toBe(200);
    const other = await s.request(`/api/reports/class/${s.fixtures.classes[2].id}`, { cookie: teacher });
    expect(other.status).toBe(403);
    const notFound = await s.request(
      "/api/reports/class/00000000-0000-4000-8000-000000000000",
      { cookie: teacher },
    );
    expect([403, 404]).toContain(notFound.status);
  });
});

describe("报告的数据范围隔离与 CSV 导出", () => {
  it("值日老师只能查看授权学生的成长报告", async () => {
    const { cookie } = await s.login("teacher1");
    const ownStudent = s.fixtures.students.find(
      (student: any) => student.class_id === s.fixtures.classes[0].id,
    );
    const otherStudent = s.fixtures.students.find(
      (student: any) => student.class_id === s.fixtures.classes[2].id,
    );
    const own = await s.request(`/api/reports/student/${ownStudent.id}?period=week&date=2026-10-15`, {
      cookie,
    });
    expect(own.status).toBe(200);
    const other = await s.request(`/api/reports/student/${otherStudent.id}?period=week&date=2026-10-15`, {
      cookie,
    });
    expect(other.status).toBe(403);
    expect(JSON.stringify(other.body)).not.toContain(otherStudent.name);
  });

  it("成长报告 CSV 可下载且包含隐私提示", async () => {
    const { cookie } = await s.login("admin");
    const studentId = firstAddRecord().student_id;
    const res = await s.request(
      `/api/reports/student/${studentId}/export.csv?period=month&date=2026-10-15`,
      { cookie },
    );
    expect(res.status).toBe(200);
    const text = String(res.body);
    expect(text).toContain("概览");
    expect(text).toContain("成长叙事");
    expect(text).toContain("仅限授权家长查看，不展示班级排名与其他学生信息");
    const otherStudent = s.fixtures.students.find(
      (student: any) => student.class_id === s.fixtures.classes[2].id,
    );
    const { cookie: teacher } = await s.login("teacher1");
    const forbidden = await s.request(`/api/reports/student/${otherStudent.id}/export.csv?period=week`, {
      cookie: teacher,
    });
    expect(forbidden.status).toBe(403);
  });
});
