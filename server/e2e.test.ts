// 主链路端到端集成测试（真实 Express + 临时 SQLite + 演示 fixture，不用 mock）：
// 登录 → 建学生/规则发布 → 教师记分（含待复核）→ 复核生效 → 申报创建/通过
// → 冲正/更正 → 申诉裁决 → 仪表盘/报告数字一致性 → 分享公开访问与撤销 → 越权 403。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestServer } from "./test-utils.mjs";
import { studentTermScore } from "./ledger.mjs";

const SUBMITTED_RULE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa102"; // fixtures：待审核「文明就餐监督岗」
const DRAFT_RULE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa101"; // fixtures：草稿「校园拾光志愿服务」

let s: any;
let admin: any;
let moral: any;
let teacher1: any;
let teacher2: any;
let class7Id: string;
let class8Id: string;
let categoryId: string;
let testStudent: any;
let class8StudentId: string;
let publishedRule: any; // 主动帮助同学（加分 2，已发布）
let reviewRule: any; // 校级竞赛获奖（加分 10，需复核）
let pendingRecordId: string;
let mainRecordId: string;

function ruleByName(name: string) {
  return s.db
    .prepare(
      `SELECT r.id AS id, v.id AS versionId, v.name, v.status, v.points, v.requires_review
       FROM scoring_rules r
       JOIN scoring_rule_versions v ON v.rule_id=r.id AND v.version=r.latest_version
       WHERE v.name=?`,
    )
    .get(name);
}

function scoreOf(studentId: string) {
  const settings = s.ctx.settings.get(s.fixtures.schoolId);
  return studentTermScore(s.db, settings, { studentId, termId: s.fixtures.currentTerm.id });
}

function recordCount() {
  return s.db.prepare("SELECT COUNT(*) AS count FROM score_records").get().count;
}

beforeAll(async () => {
  s = await createTestServer();
  admin = await s.login("admin");
  moral = await s.login("moral");
  teacher1 = await s.login("teacher1");
  teacher2 = await s.login("teacher2");
  categoryId = s.db.prepare("SELECT id FROM scoring_categories WHERE name='日常行为规范'").get().id;
  class7Id = s.db
    .prepare(
      "SELECT c.id FROM classes c JOIN grades g ON g.id=c.grade_id WHERE g.name='七年级' AND c.name='1班'",
    )
    .get().id;
  class8Id = s.db
    .prepare(
      "SELECT c.id FROM classes c JOIN grades g ON g.id=c.grade_id WHERE g.name='八年级' AND c.name='1班'",
    )
    .get().id;
  class8StudentId = s.db
    .prepare("SELECT id FROM students WHERE class_id=? ORDER BY student_no LIMIT 1")
    .get(class8Id).id;
  publishedRule = ruleByName("主动帮助同学");
  // 考试违纪：减分 5、requires_review=1 且不强制证据，用于验证复核链路
  reviewRule = ruleByName("考试违纪");
  expect(publishedRule?.status).toBe("PUBLISHED");
  expect(reviewRule?.requires_review).toBe(1);
});

afterAll(async () => {
  await s?.close();
});

describe("主链路端到端集成（真实 SQLite + Express）", () => {
  it("登录与未授权访问：错误密码 401，未登录受保护接口 401，退出后会话失效", async () => {
    const health = await s.request("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);

    const wrong = await s.request("/api/auth/login", {
      method: "POST",
      body: { account: "admin", password: "definitely-wrong-password" },
    });
    expect(wrong.status).toBe(401);

    for (const path of ["/api/students", "/api/dashboard", "/api/records", "/api/rules"]) {
      const anonymous = await s.request(path);
      expect(anonymous.status, `${path} 未登录应返回 401`).toBe(401);
    }

    const me = await s.request("/api/me", { cookie: admin.cookie });
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe("SYSTEM_ADMIN");
    expect(me.body.user.permissions.manageSystem).toBe(true);

    const logout = await s.request("/api/auth/logout", {
      method: "POST",
      cookie: admin.cookie,
      body: {},
    });
    expect(logout.status).toBe(200);
    const afterLogout = await s.request("/api/me", { cookie: admin.cookie });
    expect(afterLogout.status).toBe(401);
    admin = await s.login("admin");
  });

  it("管理员新建学生档案（主链路起点），值日老师无权新建", async () => {
    const created = await s.request("/api/students", {
      method: "POST",
      cookie: admin.cookie,
      body: { name: "测试学生甲", studentNo: "269901", classId: class7Id, gender: "男" },
    });
    expect(created.status).toBe(201);
    testStudent = created.body.student;
    expect(testStudent.name).toBe("测试学生甲");
    expect(testStudent.classId).toBe(class7Id);
    expect(scoreOf(testStudent.id).total).toBe(100);

    const forbidden = await s.request("/api/students", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { name: "越权学生", studentNo: "269902", classId: class7Id },
    });
    expect(forbidden.status).toBe(403);
  });

  it("规则发布流程：德育处审核+发布后教师可记分；管理员不能审核/发布；草稿规则不可用", async () => {
    const student = { id: testStudent.id };
    // 管理员不能绕过德育处审核与发布
    const adminApprove = await s.request(`/api/rules/${SUBMITTED_RULE_ID}/approve`, {
      method: "POST",
      cookie: admin.cookie,
    });
    expect(adminApprove.status).toBe(403);
    const adminPublish = await s.request(`/api/rules/${SUBMITTED_RULE_ID}/publish`, {
      method: "POST",
      cookie: admin.cookie,
      body: { effectiveFrom: "2026-09-01T00:00:00.000Z" },
    });
    expect(adminPublish.status).toBe(403);
    const adminSubmit = await s.request(`/api/rules/${DRAFT_RULE_ID}/submit`, {
      method: "POST",
      cookie: admin.cookie,
    });
    expect(adminSubmit.status).toBe(200); // 管理员可以提交草稿，但不能审核发布

    // 德育处审核并发布
    const approved = await s.request(`/api/rules/${SUBMITTED_RULE_ID}/approve`, {
      method: "POST",
      cookie: moral.cookie,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.rule.status).toBe("APPROVED");
    const published = await s.request(`/api/rules/${SUBMITTED_RULE_ID}/publish`, {
      method: "POST",
      cookie: moral.cookie,
      body: { effectiveFrom: "2026-09-01T00:00:00.000Z", note: "端到端测试发布" },
    });
    expect(published.status).toBe(200);
    expect(published.body.rule.status).toBe("PUBLISHED");

    // 发布后值日老师在规则列表中可见并可用于记分
    const list = await s.request(`/api/rules?search=${encodeURIComponent("文明就餐监督岗")}`, {
      cookie: teacher1.cookie,
    });
    expect(list.status).toBe(200);
    const visible = list.body.items.find((item: any) => item.id === SUBMITTED_RULE_ID);
    expect(visible?.status).toBe("PUBLISHED");

    const scored = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        ruleId: visible.id,
        studentId: student.id,
        note: "担任食堂文明就餐监督岗，表现认真",
      },
    });
    expect([200, 201]).toContain(scored.status);
    expect(scored.body.record.status).toBe("EFFECTIVE");

    // 草稿规则不能用于记分
    const draftScore = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { ruleId: DRAFT_RULE_ID, studentId: student.id, note: "草稿规则记分" },
    });
    expect(draftScore.status).toBe(400);
    // 适用范围不匹配（仅九年级1班）的规则不能用于七年级学生
    const classScopedRule = ruleByName("中考冲刺自律标兵");
    const scopeMismatch = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { ruleId: classScopedRule.id, studentId: student.id, note: "适用范围不匹配" },
    });
    expect(scopeMismatch.status).toBe(400);
  });

  it("教师记分：授权范围外 403；需复核记录进入待复核且暂不计分", async () => {
    const before = scoreOf(testStudent.id);
    const scored = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { ruleId: publishedRule.id, studentId: testStudent.id, note: "主动帮助同学讲解数学题" },
    });
    expect([200, 201]).toContain(scored.status);
    expect(scored.body.record.status).toBe("EFFECTIVE");
    expect(scored.body.record.direction).toBe("ADD");
    expect(scored.body.record.source).toBe("TEACHER");
    expect(scoreOf(testStudent.id).total).toBe(before.total + publishedRule.points);
    mainRecordId = scored.body.record.id;

    // 需复核规则 → PENDING_REVIEW，且不计入得分
    const pending = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { ruleId: reviewRule.id, studentId: testStudent.id, note: "考试违纪，等待复核" },
    });
    expect([200, 201]).toContain(pending.status);
    expect(pending.body.record.status).toBe("PENDING_REVIEW");
    expect(pending.body.record.direction).toBe("DEDUCT");
    expect(scoreOf(testStudent.id).total).toBe(before.total + publishedRule.points);
    pendingRecordId = pending.body.record.id;

    // 值日老师不能复核（仅管理员/德育处）
    const teacherApprove = await s.request(`/api/records/${pendingRecordId}/approve`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { note: "越权复核" },
    });
    expect(teacherApprove.status).toBe(403);

    // 数据范围隔离：teacher2 不得对七年级学生记分/读取
    const crossScore = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher2.cookie,
      body: { ruleId: publishedRule.id, studentId: testStudent.id, note: "越权记分" },
    });
    expect(crossScore.status).toBe(403);
    const crossClass = await s.request(`/api/records?classId=${class8Id}`, {
      cookie: teacher1.cookie,
    });
    expect(crossClass.status).toBe(403);
    const crossStudent = await s.request(`/api/students/${class8StudentId}`, {
      cookie: teacher1.cookie,
    });
    expect(crossStudent.status).toBe(403);
  });

  it("德育处复核待复核记录后生效并计入得分", async () => {
    const before = scoreOf(testStudent.id);
    const queue = await s.request(
      `/api/records?status=PENDING_REVIEW&studentId=${testStudent.id}`,
      { cookie: moral.cookie },
    );
    expect(queue.status).toBe(200);
    expect(queue.body.items.some((item: any) => item.id === pendingRecordId)).toBe(true);

    const approved = await s.request(`/api/records/${pendingRecordId}/approve`, {
      method: "POST",
      cookie: moral.cookie,
      body: { note: "情况属实，复核通过" },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.record.status).toBe("EFFECTIVE");
    expect(approved.body.record.reviewerName).toBe("陈德处");
    expect(approved.body.record.signedPoints).toBe(-reviewRule.points);
    expect(scoreOf(testStudent.id).total).toBe(
      before.total + approved.body.record.signedPoints,
    );

    // 重复复核被拒绝
    const again = await s.request(`/api/records/${pendingRecordId}/approve`, {
      method: "POST",
      cookie: moral.cookie,
      body: {},
    });
    expect(again.status).toBe(400);
  });

  it("批量记分：一次多名学生，含范围外学生时整批失败且不落库", async () => {
    const studentIds = s.db
      .prepare(
        "SELECT id FROM students WHERE class_id=? AND status='ACTIVE' ORDER BY student_no LIMIT 3",
      )
      .all(class7Id)
      .map((row: any) => row.id);
    const batch = await s.request("/api/scoring/batch", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        ruleId: publishedRule.id,
        studentIds,
        note: "批量记分：课堂积极发言",
      },
    });
    expect([200, 201]).toContain(batch.status);
    expect(batch.body.records).toHaveLength(studentIds.length);
    expect(batch.body.summary.created + batch.body.summary.pendingReview).toBe(studentIds.length);
    expect(batch.body.records.map((row: any) => row.studentId).sort()).toEqual(
      [...studentIds].sort(),
    );

    // 混入范围外学生 → 整批拒绝且不产生任何记录
    const totalBefore = recordCount();
    const invalid = await s.request("/api/scoring/batch", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        ruleId: publishedRule.id,
        studentIds: [studentIds[0], class8StudentId],
        note: "批量越权测试",
      },
    });
    expect(invalid.status).toBe(403);
    expect(recordCount()).toBe(totalBefore);
  });

  it("学生干部申报：公开提交→教师核实生成 STUDENT_CADRE 记录；驳回必须填写理由", async () => {
    const token = s.fixtures.submissionToken;
    const tokenInfo = await s.request(`/api/public/submission/${token}`);
    expect(tokenInfo.status).toBe(200);
    expect(tokenInfo.body.class.id).toBe(class7Id);
    expect(tokenInfo.body.categories.length).toBeGreaterThan(0);

    const before = scoreOf(testStudent.id);
    const description = "校园志愿服务：主动整理公共区域图书并维持一周";
    const submitted = await s.request(`/api/public/submission/${token}`, {
      method: "POST",
      body: {
        studentNo: testStudent.studentNo,
        name: testStudent.name,
        categoryId,
        direction: "ADD",
        description,
      },
    });
    expect(submitted.status).toBe(201);
    expect(submitted.body.message).toContain("等待老师核实");
    // 待核实阶段不产生积分
    expect(scoreOf(testStudent.id).total).toBe(before.total);

    // 学号与姓名不匹配：统一错误信息，不区分哪一项错误
    const mismatch = await s.request(`/api/public/submission/${token}`, {
      method: "POST",
      body: {
        studentNo: "000000",
        name: "不存在的学生",
        categoryId,
        direction: "ADD",
        description: "身份不匹配测试",
      },
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toContain("学号与姓名不匹配");

    // 教师（授权范围）在待核实队列看到
    const queue = await s.request("/api/submissions?status=PENDING_REVIEW", {
      cookie: teacher1.cookie,
    });
    expect(queue.status).toBe(200);
    const item = queue.body.items.find(
      (row: any) => row.studentId === testStudent.id && row.description === description,
    );
    expect(item).toBeTruthy();
    expect(item.source).toBe("CADRE_LINK");

    // 通过必须选择规则
    const noRule = await s.request(`/api/submissions/${item.id}/approve`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: {},
    });
    expect(noRule.status).toBe(400);
    const approved = await s.request(`/api/submissions/${item.id}/approve`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { ruleId: publishedRule.id, note: "经核实情况属实" },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.submission.status).toBe("APPROVED");
    expect(approved.body.record.source).toBe("STUDENT_CADRE");
    expect(approved.body.record.sourceLabel).toContain("学生干部");
    expect(scoreOf(testStudent.id).total).toBe(before.total + publishedRule.points);

    // 驳回路径：必须填写理由
    const second = await s.request(`/api/public/submission/${token}`, {
      method: "POST",
      body: {
        studentNo: testStudent.studentNo,
        name: testStudent.name,
        categoryId,
        direction: "ADD",
        description: "重复申报：已由老师登记的活动",
      },
    });
    expect(second.status).toBe(201);
    const queue2 = await s.request("/api/submissions?status=PENDING_REVIEW", {
      cookie: teacher1.cookie,
    });
    const item2 = queue2.body.items.find(
      (row: any) => row.studentId === testStudent.id && row.description === "重复申报：已由老师登记的活动",
    );
    expect(item2).toBeTruthy();
    const rejectNoReason = await s.request(`/api/submissions/${item2.id}/reject`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: {},
    });
    expect(rejectNoReason.status).toBe(400);
    const rejected = await s.request(`/api/submissions/${item2.id}/reject`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { reason: "该事迹之前已由老师登记，避免重复加分" },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.submission.status).toBe("REJECTED");

    // 范围外老师不能访问该申报
    const cross = await s.request(`/api/submissions/${item.id}`, { cookie: teacher2.cookie });
    expect([403, 404]).toContain(cross.status);
  });

  it("账本不可篡改：冲正/更正保留关联，直接 PATCH/DELETE 与 SQL 改删均被拒绝", async () => {
    const created = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { ruleId: publishedRule.id, studentId: testStudent.id, note: "冲正/更正测试记录" },
    });
    expect([200, 201]).toContain(created.status);
    const recordId = created.body.record.id;
    const before = scoreOf(testStudent.id);

    // 值日老师无冲正权限；无理由被拒绝
    const teacherRevoke = await s.request(`/api/records/${recordId}/revoke`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { reason: "教师尝试冲正" },
    });
    expect(teacherRevoke.status).toBe(403);
    const noReason = await s.request(`/api/records/${recordId}/revoke`, {
      method: "POST",
      cookie: moral.cookie,
      body: {},
    });
    expect(noReason.status).toBe(400);

    // 德育处冲正：新增 REVERSAL 记录，原记录保留
    const revoked = await s.request(`/api/records/${recordId}/revoke`, {
      method: "POST",
      cookie: moral.cookie,
      body: { reason: "原记录信息有误，冲正处理" },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.reversal.recordKind).toBe("REVERSAL");
    expect(revoked.body.reversal.reversesRecordId).toBe(recordId);
    expect(revoked.body.record.id).toBe(recordId);
    expect(scoreOf(testStudent.id).total).toBe(before.total - created.body.record.signedPoints);
    // 同一条记录不能重复冲正
    const duplicate = await s.request(`/api/records/${recordId}/revoke`, {
      method: "POST",
      cookie: moral.cookie,
      body: { reason: "重复冲正" },
    });
    expect(duplicate.status).toBe(400);

    // 更正：冲正 + 新 CORRECTION 记录，详情出现关联
    const second = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { ruleId: publishedRule.id, studentId: testStudent.id, note: "更正测试记录" },
    });
    const secondId = second.body.record.id;
    const corrected = await s.request(`/api/records/${secondId}/correct`, {
      method: "POST",
      cookie: moral.cookie,
      body: { reason: "原说明不准确，更正说明", note: "更正为：主动整理教室卫生" },
    });
    expect(corrected.status).toBe(200);
    expect(corrected.body.reversal.reversesRecordId).toBe(secondId);
    expect(corrected.body.correction.recordKind).toBe("CORRECTION");
    expect(corrected.body.correction.correctsRecordId).toBe(secondId);
    const detail = await s.request(`/api/records/${secondId}`, { cookie: moral.cookie });
    expect(detail.status).toBe(200);
    expect(detail.body.record.reversed).toBe(true);
    expect(detail.body.relations.reversal.id).toBe(corrected.body.reversal.id);
    expect(detail.body.relations.correctedBy.id).toBe(corrected.body.correction.id);

    // API 层不存在直接修改/删除记录的路由
    const patch = await s.request(`/api/records/${recordId}`, {
      method: "PATCH",
      cookie: moral.cookie,
      body: { points: 999 },
    });
    expect([404, 405]).toContain(patch.status);
    const remove = await s.request(`/api/records/${recordId}`, {
      method: "DELETE",
      cookie: moral.cookie,
    });
    expect([404, 405]).toContain(remove.status);

    // 数据库触发器兜底：已生效记录不可 UPDATE / DELETE
    expect(() =>
      s.db.prepare("UPDATE score_records SET note=? WHERE id=?").run("被篡改", recordId),
    ).toThrow();
    expect(() => s.db.prepare("DELETE FROM score_records WHERE id=?").run(recordId)).toThrow();
    expect(
      s.db.prepare("SELECT COUNT(*) AS count FROM score_records WHERE id=?").get(recordId).count,
    ).toBe(1);
  });

  it("申诉：教师登记、德育处受理与裁决，接受后走冲正/更正；裁决理由必填", async () => {
    const target = s.db
      .prepare(
        `SELECT r.* FROM score_records r
         JOIN students s ON s.id=r.student_id
         WHERE s.class_id=? AND r.status='EFFECTIVE' AND r.record_kind='STANDARD'
           AND r.id NOT IN (SELECT record_id FROM appeals)
           AND NOT EXISTS (SELECT 1 FROM score_records rev WHERE rev.reverses_record_id=r.id AND rev.status='EFFECTIVE')
         ORDER BY r.created_at, r.rowid LIMIT 1`,
      )
      .get(class8Id);
    expect(target).toBeTruthy();
    const studentBefore = scoreOf(target.student_id);

    const created = await s.request("/api/appeals", {
      method: "POST",
      cookie: teacher2.cookie,
      body: { recordId: target.id, reason: "当天情况需要复核，申请重新认定该记录" },
    });
    expect(created.status).toBe(201);
    const appealId = created.body.appeal.id;
    expect(created.body.appeal.status).toBe("SUBMITTED");

    // 同一记录只能有一个未结申诉
    const duplicate = await s.request("/api/appeals", {
      method: "POST",
      cookie: teacher2.cookie,
      body: { recordId: target.id, reason: "重复申诉" },
    });
    expect(duplicate.status).toBe(400);

    // 范围外老师看不到该申诉
    const crossDetail = await s.request(`/api/appeals/${appealId}`, { cookie: teacher1.cookie });
    expect([403, 404]).toContain(crossDetail.status);
    // 值日老师不能裁决
    const teacherDecide = await s.request(`/api/appeals/${appealId}/decide`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { decision: "REJECTED", reason: "越权裁决" },
    });
    expect(teacherDecide.status).toBe(403);

    const started = await s.request(`/api/appeals/${appealId}/start-review`, {
      method: "POST",
      cookie: moral.cookie,
      body: { note: "已受理，向任课教师核实" },
    });
    expect(started.status).toBe(200);
    expect(started.body.appeal.status).toBe("UNDER_REVIEW");

    // 裁决必须填写理由
    const noReason = await s.request(`/api/appeals/${appealId}/decide`, {
      method: "POST",
      cookie: moral.cookie,
      body: { decision: "ACCEPTED" },
    });
    expect(noReason.status).toBe(400);

    // 接受申诉：冲正 + 更正（REPLACE）保留完整关联
    const decided = await s.request(`/api/appeals/${appealId}/decide`, {
      method: "POST",
      cookie: moral.cookie,
      body: {
        decision: "ACCEPTED",
        reason: "经核实，原记录事实认定有误，接受申诉并更正",
        correction: {
          mode: "REPLACE",
          ruleId: publishedRule.id,
          points: publishedRule.points,
          note: "更正为：主动帮助同学整理教室",
        },
      },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.appeal.status).toBe("ACCEPTED");
    expect(decided.body.reversal.reversesRecordId).toBe(target.id);
    expect(decided.body.correction.correctsRecordId).toBe(target.id);
    expect(decided.body.appeal.reversalRecordId).toBe(decided.body.reversal.id);

    const appealDetail = await s.request(`/api/appeals/${appealId}`, { cookie: moral.cookie });
    expect(appealDetail.status).toBe(200);
    expect(appealDetail.body.decisions.length).toBe(2); // UNDER_REVIEW + ACCEPTED
    expect(appealDetail.body.decisions.at(-1).decision).toBe("ACCEPTED");
    expect(appealDetail.body.decisions.at(-1).reason).toContain("接受申诉");

    // 原记录详情出现冲正/更正关联
    const recordDetail = await s.request(`/api/records/${target.id}`, { cookie: teacher2.cookie });
    expect(recordDetail.status).toBe(200);
    expect(recordDetail.body.record.reversed).toBe(true);
    expect(recordDetail.body.relations.reversal.id).toBe(decided.body.reversal.id);
    expect(recordDetail.body.relations.correctedBy.id).toBe(decided.body.correction.id);
    // 分数口径：原记录被冲正，更正记录生效
    const studentAfter = scoreOf(target.student_id);
    expect(studentAfter.total).toBe(
      studentBefore.total - target.signed_points + decided.body.correction.signedPoints,
    );
  });

  it("仪表盘/分析/报告数字与账本聚合一致（不是写死数字）", async () => {
    const dashboard = await s.request("/api/dashboard", { cookie: moral.cookie });
    expect(dashboard.status).toBe(200);
    const effectiveInTerm = s.db
      .prepare("SELECT COUNT(*) AS count FROM score_records WHERE term_id=? AND status='EFFECTIVE'")
      .get(s.fixtures.currentTerm.id).count;
    expect(dashboard.body.kpis.recordCount).toBe(effectiveInTerm);
    const activeStudents = s.db
      .prepare("SELECT COUNT(*) AS count FROM students WHERE school_id=? AND status='ACTIVE'")
      .get(s.fixtures.schoolId).count;
    expect(dashboard.body.kpis.studentCount).toBe(activeStudents);
    expect(dashboard.body.kpis.totalAdds).toBeGreaterThan(0);
    expect(dashboard.body.recentRecords.length).toBeGreaterThan(0);

    // 班级对比使用人均分并带人数
    const class7 = dashboard.body.classDistribution.find((row: any) => row.classId === class7Id);
    expect(class7).toBeTruthy();
    const class7Students = s.db
      .prepare("SELECT COUNT(*) AS count FROM students WHERE class_id=? AND status='ACTIVE'")
      .get(class7Id).count;
    expect(class7.studentCount).toBe(class7Students);
    expect(class7).toHaveProperty("avgScore");

    // 学生详情 / 报告 / 账本三处口径一致
    const expected = scoreOf(testStudent.id);
    const detail = await s.request(`/api/students/${testStudent.id}`, { cookie: teacher1.cookie });
    expect(detail.status).toBe(200);
    expect(detail.body.score.total).toBe(expected.total);
    expect(detail.body.score.initialPoints).toBe(100);
    const report = await s.request(`/api/reports/student/${testStudent.id}?period=term`, {
      cookie: teacher1.cookie,
    });
    expect(report.status).toBe(200);
    expect(report.body.student.name).toBe(testStudent.name);
    expect(report.body.score.total).toBe(expected.total);
    expect(report.body.score.recordCount).toBe(expected.recordCount);
    expect(report.body.privacyNote).toBeTruthy();
  });

  it("家长分享：公开访问无需登录、脱敏且不含排名；撤销后 404；教师无权创建分享", async () => {
    const token = s.fixtures.shareToken;
    const pub = await s.request(`/api/public/share/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.student.name).toBeTruthy();
    expect(pub.body.student.studentNo).toContain("*"); // 学号脱敏
    expect(pub.body.privacyNote).toContain("不展示班级排名");
    expect(pub.body.ranking).toBeUndefined();
    expect(pub.body.classComparison).toBeUndefined();
    expect(pub.body.score.total).toBeGreaterThanOrEqual(0);
    const otherName = s.db
      .prepare("SELECT name FROM students WHERE class_id=? AND id<>? LIMIT 1")
      .get(class7Id, pub.body.student.id).name;
    expect(JSON.stringify(pub.body)).not.toContain(otherName);

    // 值日老师没有创建分享权限
    const teacherShare = await s.request("/api/shares", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { studentId: testStudent.id, expiresInDays: 7 },
    });
    expect(teacherShare.status).toBe(403);

    // 德育处新建分享 → 公开访问 → 撤销后失效
    const created = await s.request("/api/shares", {
      method: "POST",
      cookie: moral.cookie,
      body: { studentId: testStudent.id, expiresInDays: 7, label: "端到端测试分享" },
    });
    expect(created.status).toBe(201);
    expect(created.body.share.url).toContain("#/share/");
    const newToken = created.body.share.token;
    const accessible = await s.request(`/api/public/share/${newToken}`);
    expect(accessible.status).toBe(200);
    expect(accessible.body.student.name).toBe(testStudent.name);

    const revoked = await s.request(`/api/shares/${created.body.share.id}/revoke`, {
      method: "POST",
      cookie: moral.cookie,
    });
    expect(revoked.status).toBe(200);
    const afterRevoke = await s.request(`/api/public/share/${newToken}`);
    expect(afterRevoke.status).toBe(404);
    expect(afterRevoke.body.error).toContain("分享链接无效");

    // fixtures 中已撤销的 token 也不可访问
    const revokedDemo = await s.request("/api/public/share/revoked-demo-share-token");
    expect(revokedDemo.status).toBe(404);
  });

  it("权限矩阵：管理员不能裁决申诉/发布规则，德育处不能管理系统账号，值日老师不能登记裁决", async () => {
    // 管理员不能裁决申诉 / 审核发布规则
    const adminDecide = await s.request("/api/appeals/any-appeal/decide", {
      method: "POST",
      cookie: admin.cookie,
      body: { decision: "REJECTED", reason: "越权裁决" },
    });
    expect(adminDecide.status).toBe(403);
    const adminRulePublish = await s.request(`/api/rules/${SUBMITTED_RULE_ID}/publish`, {
      method: "POST",
      cookie: admin.cookie,
      body: { effectiveFrom: "2026-10-01T00:00:00.000Z" },
    });
    expect(adminRulePublish.status).toBe(403);

    // 德育处不能管理账号与审计日志
    const moralUsers = await s.request("/api/admin/users", { cookie: moral.cookie });
    expect(moralUsers.status).toBe(403);
    const moralBackups = await s.request("/api/admin/backups", { cookie: moral.cookie });
    expect(moralBackups.status).toBe(403);

    // 值日老师不能创建规则、分享、看审计日志或裁决申诉
    const teacherRule = await s.request("/api/rules", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { categoryId, name: "越权规则", direction: "ADD", points: 1 },
    });
    expect(teacherRule.status).toBe(403);
    const teacherAudit = await s.request("/api/admin/audit-logs", { cookie: teacher1.cookie });
    expect(teacherAudit.status).toBe(403);

    // 值日老师可以登记申诉（授权范围），但不能裁决
    const appeal = await s.request("/api/appeals", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { recordId: mainRecordId, reason: "家长反馈需要复核，代登记申诉" },
    });
    expect(appeal.status).toBe(201);
    const decide = await s.request(`/api/appeals/${appeal.body.appeal.id}/decide`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { decision: "ACCEPTED", reason: "越权裁决" },
    });
    expect(decide.status).toBe(403);

    // 管理员可以管理账号
    const users = await s.request("/api/admin/users", { cookie: admin.cookie });
    expect(users.status).toBe(200);
    expect(users.body.items.length).toBeGreaterThanOrEqual(5);
  });
});
