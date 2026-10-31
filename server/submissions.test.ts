// 学生干部申报后端契约测试：token 哈希存储/撤销/过期、公开入口不泄露名册、
// 申报不产生积分、老师核实后才生成 STUDENT_CADRE 正式记录。
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestServer } from "./test-utils.mjs";
import { studentTermScore } from "./ledger.mjs";

let s: any;
let teacher1: any;
let teacher2: any;
let moral: any;
let admin: any;
let class7Id: string;
let class8Id: string;
let grade7Id: string;
let categoryId: string;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

beforeAll(async () => {
  s = await createTestServer();
  teacher1 = await s.login("teacher1");
  teacher2 = await s.login("teacher2");
  moral = await s.login("moral");
  admin = await s.login("admin");
  grade7Id = s.db.prepare("SELECT id FROM grades WHERE name='七年级'").get().id;
  class7Id = s.db.prepare("SELECT id FROM classes WHERE grade_id=? AND name='1班'").get(grade7Id).id;
  class8Id = s.db
    .prepare(
      "SELECT id FROM classes WHERE grade_id=(SELECT id FROM grades WHERE name='八年级') AND name='1班'",
    )
    .get().id;
  categoryId = s.db.prepare("SELECT id FROM scoring_categories WHERE name='日常行为规范'").get().id;
});

afterAll(async () => {
  await s?.close();
});

function studentOf(classId: string, offset = 0) {
  const rows = s.db.prepare("SELECT * FROM students WHERE class_id=? ORDER BY student_no").all(classId);
  expect(rows.length).toBeGreaterThan(offset);
  return rows[offset];
}

function recordCount() {
  return s.db.prepare("SELECT COUNT(*) AS c FROM score_records").get().c;
}

function termScore(studentId: string) {
  return studentTermScore(s.db, s.ctx.settings.get(s.fixtures.schoolId), {
    studentId,
    termId: s.fixtures.currentTerm.id,
  });
}

function publishedRule(name: string) {
  const rule = s.db
    .prepare(
      `SELECT r.id AS ruleId, v.id AS versionId, v.* FROM scoring_rules r
       JOIN scoring_rule_versions v ON v.id=r.active_version_id
       WHERE v.name=? AND v.status='PUBLISHED'`,
    )
    .get(name);
  expect(rule).toBeTruthy();
  return rule;
}

async function publicSubmit(token: string, overrides: Record<string, any> = {}) {
  const student = studentOf(class7Id, 3);
  return s.request(`/api/public/submission/${token}`, {
    method: "POST",
    body: {
      studentNo: student.student_no,
      name: student.name,
      categoryId,
      direction: "ADD",
      description: "主动协助班级整理卫生角",
      ...overrides,
    },
  });
}

async function createPendingSubmission(description: string) {
  const student = studentOf(class7Id, 9);
  const res = await s.request("/api/submissions", {
    method: "POST",
    cookie: teacher1.cookie,
    body: { studentId: student.id, categoryId, direction: "ADD", description },
  });
  expect(res.status).toBe(201);
  expect(res.body.submission.status).toBe("PENDING_REVIEW");
  return res.body.submission;
}

describe("申报链接", () => {
  it("token 只存 sha256，公开页不泄露学生名册，链接可撤销/过期", async () => {
    const created = await s.request("/api/submission-tokens", {
      method: "POST",
      cookie: moral.cookie,
      body: { classId: class7Id, expiresInDays: 7, label: "七年级1班测试申报" },
    });
    expect(created.status).toBe(201);
    expect(created.body.token).toEqual(expect.any(String));
    expect(created.body.token.length).toBeGreaterThanOrEqual(20);
    expect(created.body.url).toBe(`/#/submit/${created.body.token}`);
    expect(created.body.expiresAt).toBeTruthy();
    expect(created.body.id).toBeTruthy();

    const stored = s.db.prepare("SELECT * FROM submission_tokens WHERE id=?").get(created.body.id);
    expect(stored.token_hash).toBe(sha256(created.body.token));
    expect(stored.token_hash).not.toBe(created.body.token);
    expect(JSON.stringify(stored)).not.toContain(created.body.token);

    const list = await s.request(`/api/submission-tokens?classId=${class7Id}`, {
      cookie: moral.cookie,
    });
    expect(list.status).toBe(200);
    const view = list.body.items.find((item: any) => item.id === created.body.id);
    expect(view).toBeTruthy();
    expect(view.token).toBeUndefined();
    expect(view.status).toBe("ACTIVE");
    expect(view.className).toBe("1班");
    expect(view.useCount).toBe(0);
    expect(view.createdByName).toBe("陈德处");

    const teacherForbidden = await s.request("/api/submission-tokens", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { classId: class7Id, expiresInDays: 7 },
    });
    expect(teacherForbidden.status).toBe(403);

    // 公开页只返回班级、分类和有效期，不含任何学生信息
    const student = studentOf(class7Id);
    const publicPage = await s.request(`/api/public/submission/${created.body.token}`);
    expect(publicPage.status).toBe(200);
    expect(publicPage.body.class.id).toBe(class7Id);
    expect(publicPage.body.class.name).toBe("1班");
    expect(publicPage.body.class.gradeName).toBe("七年级");
    expect(publicPage.body.categories.length).toBeGreaterThanOrEqual(9);
    expect(JSON.stringify(publicPage.body)).not.toContain(student.name);
    expect(JSON.stringify(publicPage.body)).not.toContain(student.student_no);

    // 撤销后公开页与提交均 404
    const revoked = await s.request(`/api/submission-tokens/${created.body.id}/revoke`, {
      method: "POST",
      cookie: moral.cookie,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.token.status).toBe("REVOKED");
    const revokedPage = await s.request(`/api/public/submission/${created.body.token}`);
    expect(revokedPage.status).toBe(404);
    expect(revokedPage.body.error).toBe("申报链接无效或已过期");
    const revokedSubmit = await publicSubmit(created.body.token);
    expect(revokedSubmit.status).toBe(404);
    const revokeAgain = await s.request(`/api/submission-tokens/${created.body.id}/revoke`, {
      method: "POST",
      cookie: moral.cookie,
    });
    expect(revokeAgain.status).toBe(400);

    // 过期链接：404
    const expiring = await s.request("/api/submission-tokens", {
      method: "POST",
      cookie: moral.cookie,
      body: { classId: class7Id, expiresInDays: 1 },
    });
    s.db
      .prepare("UPDATE submission_tokens SET expires_at=? WHERE id=?")
      .run("2026-01-01T00:00:00.000Z", expiring.body.id);
    const expiredPage = await s.request(`/api/public/submission/${expiring.body.token}`);
    expect(expiredPage.status).toBe(404);
    expect(expiredPage.body.error).toBe("申报链接无效或已过期");

    // 不存在的 token 也是同一个 404 错误
    const unknown = await s.request("/api/public/submission/not-a-real-token");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("申报链接无效或已过期");
  });
});

describe("公开申报", () => {
  it("公开申报只创建 PENDING_REVIEW 记录，不直接产生积分", async () => {
    const student = studentOf(class7Id, 3);
    const recordsBefore = recordCount();
    const tokenRowBefore = s.db
      .prepare("SELECT * FROM submission_tokens WHERE token_hash=?")
      .get(sha256(s.fixtures.submissionToken));
    const res = await s.request(`/api/public/submission/${s.fixtures.submissionToken}`, {
      method: "POST",
      body: {
        studentNo: student.student_no,
        name: student.name,
        categoryId,
        direction: "ADD",
        description: "课间主动帮助同学搬运图书",
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toContain("等待老师核实");

    const row = s.db
      .prepare(
        "SELECT * FROM student_submissions WHERE student_id=? AND description=? ORDER BY created_at DESC",
      )
      .get(student.id, "课间主动帮助同学搬运图书");
    expect(row).toBeTruthy();
    expect(row.status).toBe("PENDING_REVIEW");
    expect(row.source).toBe("CADRE_LINK");
    expect(row.score_record_id).toBeNull();
    expect(recordCount()).toBe(recordsBefore);
    const tokenRowAfter = s.db
      .prepare("SELECT * FROM submission_tokens WHERE token_hash=?")
      .get(sha256(s.fixtures.submissionToken));
    expect(tokenRowAfter.use_count).toBe(tokenRowBefore.use_count + 1);
    expect(tokenRowAfter.last_used_at).toBeTruthy();

    // 统计口径：申报不影响学生积分
    const scoreBefore = termScore(student.id);
    expect(scoreBefore.recordCount).toBe(
      s.db
        .prepare(
          "SELECT COUNT(*) AS c FROM score_records WHERE student_id=? AND term_id=? AND status='EFFECTIVE'",
        )
        .get(student.id, s.fixtures.currentTerm.id).c,
    );

    // 学号/姓名错误时提示一致，不泄露名册信息
    const wrongName = await publicSubmit(s.fixtures.submissionToken, { name: "不存在的名字" });
    const wrongNo = await publicSubmit(s.fixtures.submissionToken, {
      studentNo: "000000",
      name: student.name,
    });
    expect(wrongName.status).toBe(400);
    expect(wrongNo.status).toBe(400);
    expect(wrongName.body.error).toBe(wrongNo.body.error);
    expect(wrongName.body.error).toContain("不匹配");

    // 方向与分类不匹配
    const addOnly = await s.request("/api/categories", {
      method: "POST",
      cookie: admin.cookie,
      body: { name: "仅加分测试分类", directionScope: "ADD" },
    });
    const badDirection = await publicSubmit(s.fixtures.submissionToken, {
      categoryId: addOnly.body.category.id,
      direction: "DEDUCT",
    });
    expect(badDirection.status).toBe(400);
    expect(badDirection.body.error).toContain("加分");

    const invalidToken = await publicSubmit("definitely-not-valid");
    expect(invalidToken.status).toBe(404);
  });
});

describe("老师核实", () => {
  it("通过时必须选择 PUBLISHED 规则，并生成 source=STUDENT_CADRE 的正式记录", async () => {
    const student = studentOf(class7Id, 3);
    const submitBefore = recordCount();
    const publicRes = await s.request(`/api/public/submission/${s.fixtures.submissionToken}`, {
      method: "POST",
      body: {
        studentNo: student.student_no,
        name: student.name,
        categoryId,
        direction: "ADD",
        description: "午餐后主动协助整理餐盘",
      },
    });
    expect(publicRes.status).toBe(201);
    expect(recordCount()).toBe(submitBefore);

    const queue = await s.request("/api/submissions?status=PENDING_REVIEW&pageSize=100", {
      cookie: teacher1.cookie,
    });
    expect(queue.status).toBe(200);
    const target = queue.body.items.find(
      (item: any) => item.description === "午餐后主动协助整理餐盘",
    );
    expect(target).toBeTruthy();
    expect(target.statusLabel).toBe("待核实");

    // 跨范围：八年级老师不能核实七年级1班申报
    const crossRead = await s.request(`/api/submissions/${target.id}`, { cookie: teacher2.cookie });
    expect(crossRead.status).toBe(403);
    const crossApprove = await s.request(`/api/submissions/${target.id}/approve`, {
      method: "POST",
      cookie: teacher2.cookie,
      body: { ruleId: publishedRule("主动帮助同学").ruleId },
    });
    expect(crossApprove.status).toBe(403);

    // 未选择规则 / 使用未发布规则都被拒绝
    const noRule = await s.request(`/api/submissions/${target.id}/approve`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: {},
    });
    expect(noRule.status).toBe(400);
    const draftRuleRow = s.db
      .prepare(
        "SELECT r.id AS ruleId FROM scoring_rules r JOIN scoring_rule_versions v ON v.rule_id=r.id WHERE v.status='DRAFT' LIMIT 1",
      )
      .get();
    expect(draftRuleRow).toBeTruthy();
    const draftApprove = await s.request(`/api/submissions/${target.id}/approve`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { ruleId: draftRuleRow.ruleId },
    });
    expect(draftApprove.status).toBe(400);

    // 正确通过：选择已发布规则
    const rule = publishedRule("主动帮助同学");
    const scoreBefore = termScore(student.id);
    const approved = await s.request(`/api/submissions/${target.id}/approve`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { ruleId: rule.ruleId, note: "经核实情况属实，同意加分" },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.submission.status).toBe("APPROVED");
    expect(approved.body.submission.scoreRecordId).toBe(approved.body.record.id);
    expect(approved.body.record.source).toBe("STUDENT_CADRE");
    expect(approved.body.record.status).toBe("EFFECTIVE");
    expect(approved.body.record.submissionId).toBe(target.id);
    expect(approved.body.record.reviewerName).toBe("张明");
    expect(approved.body.record.points).toBe(rule.points);
    // 申报通过生成的正式记录必须带分类名称（否则仪表盘出现空分类）
    expect(approved.body.record.categoryName).toBe("日常行为规范");
    expect(approved.body.record.ruleName).toBe("主动帮助同学");
    const approvedRow = s.db
      .prepare("SELECT * FROM score_records WHERE id=?")
      .get(approved.body.record.id);
    expect(approvedRow.category_name).toBe("日常行为规范");
    expect(JSON.parse(approvedRow.rule_snapshot_json).categoryName).toBe("日常行为规范");

    // 正式记录生效后学生积分增加
    const scoreAfter = termScore(student.id);
    expect(scoreAfter.recordCount).toBe(scoreBefore.recordCount + 1);
    expect(scoreAfter.net).toBe(scoreBefore.net + rule.points);

    // 不能重复核实
    const duplicate = await s.request(`/api/submissions/${target.id}/approve`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { ruleId: rule.ruleId },
    });
    expect(duplicate.status).toBe(400);
  });

  it("驳回 / 要求补充必须填写理由", async () => {
    const submission = await createPendingSubmission("重复申报事项，等待核实");
    const noReason = await s.request(`/api/submissions/${submission.id}/reject`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { reason: "" },
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toContain("理由");
    const tooShort = await s.request(`/api/submissions/${submission.id}/reject`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { reason: "x" },
    });
    expect(tooShort.status).toBe(400);
    const rejected = await s.request(`/api/submissions/${submission.id}/reject`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { reason: "该事迹已由老师登记，避免重复加分" },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.submission.status).toBe("REJECTED");
    expect(rejected.body.submission.reviewNote).toContain("重复加分");
    expect(rejected.body.submission.reviewerName).toBe("张明");

    const another = await createPendingSubmission("需要补充证据的申报");
    const infoNoReason = await s.request(`/api/submissions/${another.id}/request-info`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { reason: "" },
    });
    expect(infoNoReason.status).toBe(400);
    const needInfo = await s.request(`/api/submissions/${another.id}/request-info`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { reason: "请补充活动照片或老师签字说明" },
    });
    expect(needInfo.status).toBe(200);
    expect(needInfo.body.submission.status).toBe("NEEDS_INFO");

    // 跨范围不能处理
    const crossReject = await s.request(`/api/submissions/${another.id}/reject`, {
      method: "POST",
      cookie: teacher2.cookie,
      body: { reason: "越权处理尝试" },
    });
    expect(crossReject.status).toBe(403);
    // 已处理记录不能重复处理
    const repeat = await s.request(`/api/submissions/${submission.id}/reject`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { reason: "重复处理测试" },
    });
    expect(repeat.status).toBe(400);
  });

  it("申报队列按数据范围过滤", async () => {
    const list1 = await s.request("/api/submissions?pageSize=100", { cookie: teacher1.cookie });
    expect(list1.status).toBe(200);
    expect(list1.body.total).toBeGreaterThan(0);
    for (const item of list1.body.items) expect(item.classId).toBe(class7Id);

    const list2 = await s.request("/api/submissions?pageSize=100", { cookie: teacher2.cookie });
    expect(list2.status).toBe(200);
    const allowed = new Set(
      s.db
        .prepare(
          "SELECT id FROM classes WHERE id IN (SELECT scope_id FROM user_scopes WHERE user_id=? AND scope_type='CLASS')",
        )
        .all(s.fixtures.userIds.teacher2)
        .map((row: any) => row.id),
    );
    for (const item of list2.body.items) expect(allowed.has(item.classId)).toBe(true);

    const crossClass = await s.request(`/api/submissions?classId=${class7Id}`, {
      cookie: teacher2.cookie,
    });
    expect(crossClass.status).toBe(403);
    const invalidStatus = await s.request("/api/submissions?status=UNKNOWN", {
      cookie: teacher1.cookie,
    });
    expect(invalidStatus.status).toBe(400);
  });
});
