// 记分与账本后端契约测试：待复核策略、不可篡改账本、冲正/更正、批量事务、范围隔离与导出。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestServer } from "./test-utils.mjs";
import { studentTermScore } from "./ledger.mjs";

let s: any;
let teacher1: any;
let teacher2: any;
let moral: any;
let class7Id: string;
let class8Id: string;
let grade7Id: string;
let categoryId: string;
let ruleCounter = 0;

beforeAll(async () => {
  s = await createTestServer();
  teacher1 = await s.login("teacher1");
  teacher2 = await s.login("teacher2");
  moral = await s.login("moral");
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

async function createPublishedRule(
  overrides: Record<string, any> = {},
  effectiveFrom = "2026-09-01T00:00:00.000Z",
) {
  ruleCounter += 1;
  const categoryName = overrides.categoryName || "日常行为规范";
  const body: Record<string, any> = {
    categoryId: s.db.prepare("SELECT id FROM scoring_categories WHERE name=?").get(categoryName).id,
    name: `评分测试规则-${ruleCounter}`,
    direction: "ADD",
    points: 2,
    description: "用于测试的评分规则",
    ...overrides,
  };
  delete body.categoryName;
  const created = await s.request("/api/rules", { method: "POST", cookie: moral.cookie, body });
  expect(created.status).toBe(201);
  const ruleId = created.body.rule.id;
  const submitted = await s.request(`/api/rules/${ruleId}/submit`, {
    method: "POST",
    cookie: moral.cookie,
  });
  expect(submitted.status).toBe(200);
  const approved = await s.request(`/api/rules/${ruleId}/approve`, {
    method: "POST",
    cookie: moral.cookie,
  });
  expect(approved.status).toBe(200);
  const published = await s.request(`/api/rules/${ruleId}/publish`, {
    method: "POST",
    cookie: moral.cookie,
    body: { effectiveFrom, note: "测试发布" },
  });
  expect(published.status).toBe(200);
  return published.body.rule;
}

function studentOf(classId: string, offset = 0) {
  const rows = s.db
    .prepare("SELECT * FROM students WHERE class_id=? ORDER BY student_no")
    .all(classId);
  expect(rows.length).toBeGreaterThan(offset);
  return rows[offset];
}

async function score(cookie: any, body: Record<string, any>) {
  return s.request("/api/scoring", { method: "POST", cookie, body });
}

function recordCount() {
  return s.db.prepare("SELECT COUNT(*) AS c FROM score_records").get().c;
}

function effectiveNet(studentId: string) {
  const settings = s.ctx.settings.get(s.fixtures.schoolId);
  return studentTermScore(s.db, settings, {
    studentId,
    termId: s.fixtures.currentTerm.id,
  });
}

describe("待复核策略", () => {
  it("规则要求复核、分值达到阈值、竞赛荣誉加分都会进入待复核；德育处录入直接生效", async () => {
    const student = studentOf(class7Id);
    const netBefore = effectiveNet(student.id);
    const examRule = publishedRule("考试违纪");
    const pending = await score(teacher1.cookie, {
      ruleId: examRule.ruleId,
      studentId: student.id,
      occurrenceAt: "2026-10-09T08:00:00.000Z",
      note: "考试期间交头接耳",
    });
    expect(pending.status).toBe(201);
    expect(pending.body.record.status).toBe("PENDING_REVIEW");
    expect(pending.body.record.reviewerName).toBe("");
    // 分类名称必须写入记录与快照（否则仪表盘分类占比会出现空分类）
    expect(pending.body.record.categoryName).toBe("课堂纪律");
    expect(pending.body.record.ruleName).toBe("考试违纪");
    const pendingRow = s.db
      .prepare("SELECT * FROM score_records WHERE id=?")
      .get(pending.body.record.id);
    expect(pendingRow.category_name).toBe("课堂纪律");
    expect(JSON.parse(pendingRow.rule_snapshot_json).categoryName).toBe("课堂纪律");

    // 达到 review_threshold=10 的普通规则
    const thresholdRule = await createPublishedRule({ points: 10 });
    const thresholdPending = await score(teacher1.cookie, {
      ruleId: thresholdRule.id,
      studentId: student.id,
      occurrenceAt: "2026-10-10T08:00:00.000Z",
      note: "达到复核阈值",
    });
    expect(thresholdPending.status).toBe(201);
    expect(thresholdPending.body.record.status).toBe("PENDING_REVIEW");

    // 竞赛荣誉 ADD >= 10 即使规则未标记需复核也要待复核
    const honorRule = await createPublishedRule({
      categoryName: "竞赛荣誉",
      points: 10,
      requiresReview: false,
    });
    const honorPending = await score(teacher1.cookie, {
      ruleId: honorRule.id,
      studentId: student.id,
      occurrenceAt: "2026-10-11T08:00:00.000Z",
      note: "校级竞赛获奖",
    });
    expect(honorPending.status).toBe(201);
    expect(honorPending.body.record.status).toBe("PENDING_REVIEW");

    // 待复核记录不计入积分：与记分前完全一致
    const netStillPending = effectiveNet(student.id);
    expect(netStillPending.recordCount).toBe(netBefore.recordCount);
    expect(netStillPending.net).toBe(netBefore.net);

    // 德育处直接录入 → EFFECTIVE
    const moralScore = await score(moral.cookie, {
      ruleId: examRule.ruleId,
      studentId: student.id,
      occurrenceAt: "2026-10-12T08:00:00.000Z",
      note: "德育处复核后直接登记",
    });
    expect(moralScore.status).toBe(201);
    expect(moralScore.body.record.status).toBe("EFFECTIVE");
    const netAfter = effectiveNet(student.id);
    expect(netAfter.recordCount).toBe(netBefore.recordCount + 1);
    expect(netAfter.net).toBe(netBefore.net - examRule.points);
  });

  it("规则要求证据时必须先上传证据", async () => {
    const student = studentOf(class7Id);
    const evidenceRule = publishedRule("校级竞赛获奖");
    const res = await score(teacher1.cookie, {
      ruleId: evidenceRule.ruleId,
      studentId: student.id,
      occurrenceAt: "2026-10-10T08:00:00.000Z",
      note: "未附证据的竞赛记录",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("证据");
  });
});

describe("账本只追加与冲正", () => {
  it("EFFECTIVE 记录不能被直接修改/删除，冲正生成相反方向的 REVERSAL", async () => {
    const student = studentOf(class7Id, 1);
    const rule = publishedRule("主动帮助同学");
    const created = await score(teacher1.cookie, {
      ruleId: rule.ruleId,
      studentId: student.id,
      occurrenceAt: "2026-10-13T08:00:00.000Z",
      note: "主动整理图书角",
    });
    expect(created.status).toBe(201);
    const record = created.body.record;
    expect(record.status).toBe("EFFECTIVE");

    // 数据库触发器兜底：已生效记录不可改、不可删
    expect(() =>
      s.db.prepare("UPDATE score_records SET note='篡改' WHERE id=?").run(record.id),
    ).toThrow(/不可修改/);
    expect(() => s.db.prepare("DELETE FROM score_records WHERE id=?").run(record.id)).toThrow(
      /不可删除/,
    );

    const countBefore = recordCount();
    const revoked = await s.request(`/api/records/${record.id}/revoke`, {
      method: "POST",
      cookie: moral.cookie,
      body: { reason: "记录对象选错，予以冲正" },
    });
    expect(revoked.status).toBe(200);
    const reversal = revoked.body.reversal;
    expect(reversal.recordKind).toBe("REVERSAL");
    expect(reversal.reversesRecordId).toBe(record.id);
    expect(reversal.direction).toBe(record.direction === "ADD" ? "DEDUCT" : "ADD");
    expect(reversal.signedPoints).toBe(-record.signedPoints);
    expect(reversal.points).toBe(record.points);
    expect(revoked.body.record.reversed).toBe(true);
    expect(revoked.body.record.statusLabel).toBe("已冲正");
    expect(recordCount()).toBe(countBefore + 1);

    // 原记录内容保持不变
    const originalRow = s.db.prepare("SELECT * FROM score_records WHERE id=?").get(record.id);
    expect(originalRow.note).toBe("主动整理图书角");
    expect(originalRow.status).toBe("EFFECTIVE");

    // 同一记录只允许一条生效冲正
    const again = await s.request(`/api/records/${record.id}/revoke`, {
      method: "POST",
      cookie: moral.cookie,
      body: { reason: "重复冲正测试" },
    });
    expect(again.status).toBe(400);
    expect(again.body.error).toContain("已冲正");
    expect(
      s.db
        .prepare("SELECT COUNT(*) AS c FROM score_records WHERE reverses_record_id=?")
        .get(record.id).c,
    ).toBe(1);

    // 审计记录
    const auditRow = s.db
      .prepare("SELECT * FROM audit_logs WHERE action='SCORE_REVERSAL' AND target_id=?")
      .get(reversal.id);
    expect(auditRow).toBeTruthy();
    expect(auditRow.actor_id).toBe(s.fixtures.userIds.moral);

    // 缺少理由 / 越权
    const noReason = await s.request(`/api/records/${record.id}/revoke`, {
      method: "POST",
      cookie: moral.cookie,
      body: { reason: "" },
    });
    expect(noReason.status).toBe(400);
    const teacherRevoke = await s.request(`/api/records/${record.id}/revoke`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { reason: "越权冲正尝试" },
    });
    expect(teacherRevoke.status).toBe(403);

    // 详情返回冲正关联
    const detail = await s.request(`/api/records/${record.id}`, { cookie: moral.cookie });
    expect(detail.status).toBe(200);
    expect(detail.body.relations.reversal.id).toBe(reversal.id);
  });

  it("待复核记录不能被冲正，只能审批或驳回", async () => {
    const student = studentOf(class7Id, 7);
    const examRule = publishedRule("考试违纪");
    const pending = await score(teacher1.cookie, {
      ruleId: examRule.ruleId,
      studentId: student.id,
      occurrenceAt: "2026-10-14T08:00:00.000Z",
      note: "待复核记录冲正测试",
    });
    expect(pending.body.record.status).toBe("PENDING_REVIEW");
    const revokePending = await s.request(`/api/records/${pending.body.record.id}/revoke`, {
      method: "POST",
      cookie: moral.cookie,
      body: { reason: "尝试冲正待复核记录" },
    });
    expect(revokePending.status).toBe(400);
    expect(revokePending.body.error).toContain("已生效");
  });
});

describe("更正", () => {
  it("更正 = 冲正 + 新 CORRECTION 记录，必须填写理由", async () => {
    const student = studentOf(class7Id, 2);
    const rule = publishedRule("主动帮助同学");
    const created = await score(teacher1.cookie, {
      ruleId: rule.ruleId,
      studentId: student.id,
      occurrenceAt: "2026-10-15T08:00:00.000Z",
      note: "帮助同学",
    });
    const original = created.body.record;

    const noReason = await s.request(`/api/records/${original.id}/correct`, {
      method: "POST",
      cookie: moral.cookie,
      body: { points: 3 },
    });
    expect(noReason.status).toBe(400);

    const corrected = await s.request(`/api/records/${original.id}/correct`, {
      method: "POST",
      cookie: moral.cookie,
      body: { reason: "实际应为 3 分，更正分值", points: 3, note: "经核实更正为 3 分" },
    });
    expect(corrected.status).toBe(200);
    const reversal = corrected.body.reversal;
    const correction = corrected.body.correction;
    expect(reversal.recordKind).toBe("REVERSAL");
    expect(reversal.signedPoints).toBe(-original.signedPoints);
    expect(correction.recordKind).toBe("CORRECTION");
    expect(correction.correctsRecordId).toBe(original.id);
    expect(correction.points).toBe(3);
    expect(correction.direction).toBe(original.direction);
    expect(correction.status).toBe("EFFECTIVE");
    expect(corrected.body.record.reversed).toBe(true);

    // 原记录仍未被改写
    const row = s.db.prepare("SELECT * FROM score_records WHERE id=?").get(original.id);
    expect(row.points).toBe(original.points);
    expect(row.status).toBe("EFFECTIVE");

    // 审计：冲正与更正各一条
    const actionRows = s.db
      .prepare(
        "SELECT action FROM audit_logs WHERE target_id IN (?,?) ORDER BY created_at",
      )
      .all(reversal.id, correction.id)
      .map((item: any) => item.action);
    expect(actionRows).toContain("SCORE_REVERSAL");
    expect(actionRows).toContain("SCORE_CORRECTION");

    // 已冲正的记录不能重复更正
    const again = await s.request(`/api/records/${original.id}/correct`, {
      method: "POST",
      cookie: moral.cookie,
      body: { reason: "重复更正测试", points: 4 },
    });
    expect(again.status).toBe(400);
    expect(again.body.error).toContain("已冲正");

    // 老师无权更正
    const teacherCorrect = await s.request(`/api/records/${original.id}/correct`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { reason: "越权更正尝试", points: 4 },
    });
    expect(teacherCorrect.status).toBe(403);

    // 详情返回更正关联
    const detail = await s.request(`/api/records/${original.id}`, { cookie: moral.cookie });
    expect(detail.body.relations.correctedBy.id).toBe(correction.id);
    expect(detail.body.relations.reversal.id).toBe(reversal.id);

    // 更正记录自身详情里有 corrects 关联
    const correctionDetail = await s.request(`/api/records/${correction.id}`, {
      cookie: moral.cookie,
    });
    expect(correctionDetail.body.relations.corrects.id).toBe(original.id);
  });
});

describe("待复核审批 / 驳回", () => {
  it("只有德育处/管理员能审批待复核记录；驳回必须填写理由", async () => {
    const student = studentOf(class7Id, 3);
    const examRule = publishedRule("考试违纪");
    const pending = await score(teacher1.cookie, {
      ruleId: examRule.ruleId,
      studentId: student.id,
      occurrenceAt: "2026-10-16T08:00:00.000Z",
      note: "待复核审批测试",
    });
    const pendingId = pending.body.record.id;
    const teacherApprove = await s.request(`/api/records/${pendingId}/approve`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: {},
    });
    expect(teacherApprove.status).toBe(403);

    const approved = await s.request(`/api/records/${pendingId}/approve`, {
      method: "POST",
      cookie: moral.cookie,
      body: { note: "核实违纪事实成立" },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.record.status).toBe("EFFECTIVE");
    expect(approved.body.record.reviewerName).toBe("陈德处");

    const approveAgain = await s.request(`/api/records/${pendingId}/approve`, {
      method: "POST",
      cookie: moral.cookie,
      body: {},
    });
    expect(approveAgain.status).toBe(400);

    const pending2 = await score(teacher1.cookie, {
      ruleId: examRule.ruleId,
      studentId: student.id,
      occurrenceAt: "2026-10-17T08:00:00.000Z",
      note: "待驳回记录",
    });
    const rejectNoReason = await s.request(`/api/records/${pending2.body.record.id}/reject`, {
      method: "POST",
      cookie: moral.cookie,
      body: {},
    });
    expect(rejectNoReason.status).toBe(400);
    expect(rejectNoReason.body.error).toContain("理由");
    const rejected = await s.request(`/api/records/${pending2.body.record.id}/reject`, {
      method: "POST",
      cookie: moral.cookie,
      body: { reason: "经核实学生当日请假，记录不成立" },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.record.status).toBe("REJECTED");
    expect(rejected.body.record.reviewNote).toContain("请假");
  });
});

describe("批量记分", () => {
  it("批量记分事务全有或全无，返回逐条结果", async () => {
    const students = s.db
      .prepare("SELECT * FROM students WHERE class_id=? ORDER BY student_no LIMIT 3")
      .all(class7Id);
    const rule = publishedRule("主动帮助同学");
    const before = recordCount();
    const batch = await s.request("/api/scoring/batch", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        ruleId: rule.ruleId,
        studentIds: students.map((item: any) => item.id),
        occurrenceAt: "2026-10-18T08:00:00.000Z",
        note: "批量记录主动帮助同学",
      },
    });
    expect(batch.status).toBe(201);
    expect(batch.body.records.length).toBe(3);
    expect(batch.body.summary).toEqual({ created: 3, pendingReview: 0 });
    expect(new Set(batch.body.records.map((item: any) => item.batchId)).size).toBe(1);
    for (const item of batch.body.records) {
      expect(item.status).toBe("EFFECTIVE");
      expect(item.signedPoints).toBe(rule.points);
      // 批量记分也必须写入分类名称
      expect(item.categoryName).toBe("日常行为规范");
      expect(item.ruleName).toBe("主动帮助同学");
    }
    expect(recordCount()).toBe(before + 3);

    const auditRow = s.db
      .prepare("SELECT * FROM audit_logs WHERE action='SCORE_BATCH_CREATE' ORDER BY created_at DESC")
      .get();
    expect(auditRow).toBeTruthy();
    expect(auditRow.actor_id).toBe(s.fixtures.userIds.teacher1);

    // 含不存在学生：整体回滚
    const countBeforeInvalid = recordCount();
    const invalid = await s.request("/api/scoring/batch", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        ruleId: rule.ruleId,
        studentIds: [students[0].id, "00000000-0000-4000-8000-000000000001"],
        occurrenceAt: "2026-10-18T08:00:00.000Z",
        note: "包含无效学生的批量",
      },
    });
    expect([400, 403, 404]).toContain(invalid.status);
    expect(recordCount()).toBe(countBeforeInvalid);

    // 含越权班级学生：整体回滚
    const class8Student = studentOf(class8Id);
    const crossScope = await s.request("/api/scoring/batch", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        ruleId: rule.ruleId,
        studentIds: [students[0].id, class8Student.id],
        occurrenceAt: "2026-10-18T08:00:00.000Z",
        note: "跨班批量",
      },
    });
    expect(crossScope.status).toBe(403);
    expect(recordCount()).toBe(countBeforeInvalid);

    // 规则要求证据但未上传：整体回滚
    const evidenceRule = publishedRule("校级竞赛获奖");
    const noEvidence = await s.request("/api/scoring/batch", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        ruleId: evidenceRule.ruleId,
        studentIds: students.map((item: any) => item.id),
        occurrenceAt: "2026-10-18T08:00:00.000Z",
        note: "批量缺证据",
      },
    });
    expect(noEvidence.status).toBe(400);
    expect(recordCount()).toBe(countBeforeInvalid);

    // 空学生列表校验
    const empty = await s.request("/api/scoring/batch", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { ruleId: rule.ruleId, studentIds: [] },
    });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toContain("学生");
  });
});

describe("查询、范围隔离与导出", () => {
  it("记录列表支持筛选/分页，值日老师只能看到授权班级", async () => {
    const page = await s.request("/api/records?page=1&pageSize=5", { cookie: teacher1.cookie });
    expect(page.status).toBe(200);
    expect(page.body.items.length).toBe(5);
    expect(page.body.total).toBeGreaterThan(5);
    expect(page.body.page).toBe(1);
    expect(page.body.pageSize).toBe(5);
    expect(page.body.totalPages).toBeGreaterThan(1);
    const class7Ids = s.db
      .prepare(
        "SELECT id FROM classes WHERE id IN (SELECT scope_id FROM user_scopes WHERE user_id=? AND scope_type='CLASS')",
      )
      .all(s.fixtures.userIds.teacher1)
      .map((row: any) => row.id);
    for (const item of page.body.items) expect(class7Ids).toContain(item.classId);

    const pendingList = await s.request("/api/records?status=PENDING_REVIEW&pageSize=100", {
      cookie: teacher1.cookie,
    });
    expect(pendingList.status).toBe(200);
    expect(pendingList.body.items.length).toBeGreaterThan(0);
    for (const item of pendingList.body.items) expect(item.status).toBe("PENDING_REVIEW");

    const deducts = await s.request("/api/records?direction=DEDUCT&pageSize=100", {
      cookie: teacher1.cookie,
    });
    expect(deducts.status).toBe(200);
    for (const item of deducts.body.items) expect(item.direction).toBe("DEDUCT");

    // 关键词搜索（学生姓名/规则名/说明）
    const student = studentOf(class7Id, 12);
    const rule = publishedRule("主动帮助同学");
    const keyword = `唯一关键词${Date.now()}`;
    await score(teacher1.cookie, {
      ruleId: rule.ruleId,
      studentId: student.id,
      occurrenceAt: "2026-10-19T08:00:00.000Z",
      note: keyword,
    });
    const searched = await s.request(`/api/records?search=${encodeURIComponent(keyword)}`, {
      cookie: teacher1.cookie,
    });
    expect(searched.status).toBe(200);
    expect(searched.body.total).toBe(1);
    expect(searched.body.items[0].note).toContain(keyword);

    const invalidStatus = await s.request("/api/records?status=UNKNOWN", {
      cookie: teacher1.cookie,
    });
    expect(invalidStatus.status).toBe(400);

    // 跨范围：指定八年级班级直接 403
    const crossClass = await s.request(`/api/records?classId=${class8Id}`, {
      cookie: teacher1.cookie,
    });
    expect(crossClass.status).toBe(403);
    expect(crossClass.body.error).toContain("无权");

    // 详情跨范围 403
    const class8Record = s.db
      .prepare("SELECT * FROM score_records WHERE class_id=? LIMIT 1")
      .get(class8Id);
    expect(class8Record).toBeTruthy();
    const crossDetail = await s.request(`/api/records/${class8Record.id}`, {
      cookie: teacher1.cookie,
    });
    expect(crossDetail.status).toBe(403);
    const ownDetail = await s.request(`/api/records/${class8Record.id}`, {
      cookie: teacher2.cookie,
    });
    expect(ownDetail.status).toBe(200);

    // 老师不能给非授权学生记分
    const crossScore = await score(teacher1.cookie, {
      ruleId: rule.ruleId,
      studentId: class8Record.student_id,
      occurrenceAt: "2026-10-19T08:00:00.000Z",
      note: "越权记分尝试",
    });
    expect(crossScore.status).toBe(403);
  });

  it("occurrenceAt 超出已配置学期时拒绝记分", async () => {
    const student = studentOf(class7Id, 4);
    // 使用过去生效的规则，使规则窗口校验通过，单独验证学期校验。
    const rule = await createPublishedRule({}, "2025-01-01T00:00:00.000Z");
    const res = await score(teacher1.cookie, {
      ruleId: rule.id,
      studentId: student.id,
      occurrenceAt: "2025-03-01T08:00:00.000Z",
      note: "学期外记录",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("学期");
  });

  it("新记分记录写入分类名称，仪表盘分类占比不出现空分类", async () => {
    const student = studentOf(class7Id, 14);
    const rule = publishedRule("主动帮助同学");
    const keyword = `分类名称回归${Date.now()}`;
    const created = await score(teacher1.cookie, {
      ruleId: rule.ruleId,
      studentId: student.id,
      occurrenceAt: "2026-10-21T08:00:00.000Z",
      note: keyword,
    });
    expect(created.status).toBe(201);
    expect(created.body.record.categoryName).toBe("日常行为规范");
    expect(created.body.record.ruleName).toBe("主动帮助同学");

    // 记录列表里新记录的分类不能为空
    const list = await s.request(`/api/records?search=${encodeURIComponent(keyword)}`, {
      cookie: teacher1.cookie,
    });
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(1);
    expect(list.body.items[0].categoryName).toBe("日常行为规范");

    // 仪表盘分类占比不能出现空分类名
    const dashboard = await s.request(`/api/dashboard?termId=${s.fixtures.currentTerm.id}`, {
      cookie: teacher1.cookie,
    });
    expect(dashboard.status).toBe(200);
    expect(Array.isArray(dashboard.body.categories)).toBe(true);
    expect(dashboard.body.categories.length).toBeGreaterThan(0);
    expect(dashboard.body.categories.filter((item: any) => !item.categoryName)).toEqual([]);
    expect(
      dashboard.body.categories.some((item: any) => item.categoryName === "日常行为规范"),
    ).toBe(true);
  });

  it("CSV 导出使用 sendCsv、遵守数据范围", async () => {
    const res = await s.request("/api/records/export.csv", { cookie: teacher1.cookie });
    expect(res.status).toBe(200);
    expect(String(res.headers.get("content-type"))).toContain("text/csv");
    // fetch 的 text() 会剥离 BOM，这里用 raw Response 检查真实字节。
    const raw = await s.request("/api/records/export.csv", { cookie: teacher1.cookie, raw: true });
    const bytes = new Uint8Array(await raw.arrayBuffer());
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(text).toContain("学生姓名");
    expect(text).toContain("分值");
    // teacher1 只应导出七1/七2 班，不包含八年级班级
    expect(text).not.toContain("八年级1班");
    const filtered = await s.request("/api/records/export.csv?status=PENDING_REVIEW", {
      cookie: teacher1.cookie,
    });
    expect(filtered.status).toBe(200);
    expect(String(filtered.body)).toContain("待复核");
  });
});
