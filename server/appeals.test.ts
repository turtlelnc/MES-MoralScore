// 申诉中心后端契约测试：登记范围、状态流转、理由必填、利益冲突留痕、
// 接受申诉必须走冲正/更正、裁决记录 append-only。
import { randomUUID } from "node:crypto";
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

beforeAll(async () => {
  s = await createTestServer();
  teacher1 = await s.login("teacher1");
  teacher2 = await s.login("teacher2");
  moral = await s.login("moral");
  admin = await s.login("admin");
  class7Id = s.db
    .prepare(
      "SELECT id FROM classes WHERE grade_id=(SELECT id FROM grades WHERE name='七年级') AND name='1班'",
    )
    .get().id;
  class8Id = s.db
    .prepare(
      "SELECT id FROM classes WHERE grade_id=(SELECT id FROM grades WHERE name='八年级') AND name='1班'",
    )
    .get().id;
});

afterAll(async () => {
  await s?.close();
});

/** 选一条可申诉的已生效标准记录（未冲正、无未结申诉）。 */
function appealableRecord(classId = class7Id) {
  const record = s.db
    .prepare(
      `SELECT r.* FROM score_records r
       WHERE r.class_id=? AND r.status='EFFECTIVE' AND r.record_kind='STANDARD'
         AND NOT EXISTS (SELECT 1 FROM score_records x WHERE x.reverses_record_id=r.id AND x.status='EFFECTIVE')
         AND NOT EXISTS (SELECT 1 FROM appeals a WHERE a.record_id=r.id AND a.status IN ('SUBMITTED','UNDER_REVIEW'))
       ORDER BY r.created_at DESC LIMIT 1`,
    )
    .get(classId);
  expect(record).toBeTruthy();
  return record;
}

function reversedRecord(classId = class7Id) {
  const record = s.db
    .prepare(
      `SELECT r.* FROM score_records r
       JOIN score_records x ON x.reverses_record_id=r.id AND x.status='EFFECTIVE'
       WHERE r.class_id=? LIMIT 1`,
    )
    .get(classId);
  expect(record).toBeTruthy();
  return record;
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

async function createAppeal(recordId: string, reason = "当天学生请假，申请复核该记录") {
  return s.request("/api/appeals", {
    method: "POST",
    cookie: teacher1.cookie,
    body: { recordId, reason },
  });
}

function termScore(studentId: string) {
  return studentTermScore(s.db, s.ctx.settings.get(s.fixtures.schoolId), {
    studentId,
    termId: s.fixtures.currentTerm.id,
  });
}

describe("申诉登记", () => {
  it("只能对已生效记录发起，同一记录仅一个未结申诉", async () => {
    const record = appealableRecord();
    const created = await createAppeal(record.id);
    expect(created.status).toBe(201);
    expect(created.body.appeal.status).toBe("SUBMITTED");
    expect(created.body.appeal.recordId).toBe(record.id);
    expect(created.body.appeal.submittedByName).toBe("张明");
    expect(created.body.appeal.statusLabel).toBe("待处理");

    const duplicate = await createAppeal(record.id, "重复提交申诉测试");
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toContain("未结申诉");

    // 待复核记录不能申诉
    const pendingRecord = s.db
      .prepare("SELECT * FROM score_records WHERE status='PENDING_REVIEW' AND class_id=? LIMIT 1")
      .get(class7Id);
    expect(pendingRecord).toBeTruthy();
    const pendingAppeal = await createAppeal(pendingRecord.id);
    expect(pendingAppeal.status).toBe(400);
    expect(pendingAppeal.body.error).toContain("已生效");

    // 已冲正记录不能申诉
    const reversed = reversedRecord();
    const reversedAppeal = await createAppeal(reversed.id);
    expect(reversedAppeal.status).toBe(400);
    expect(reversedAppeal.body.error).toContain("冲正");

    // 不存在 / 越权
    const missing = await createAppeal("00000000-0000-4000-8000-000000000001");
    expect(missing.status).toBe(404);
    const crossScope = await s.request("/api/appeals", {
      method: "POST",
      cookie: teacher2.cookie,
      body: { recordId: appealableRecord().id, reason: "跨班申诉越权测试" },
    });
    expect(crossScope.status).toBe(403);

    // 审计
    const auditRow = s.db
      .prepare("SELECT * FROM audit_logs WHERE action='APPEAL_CREATE' AND target_id=?")
      .get(created.body.appeal.id);
    expect(auditRow).toBeTruthy();
    expect(auditRow.actor_id).toBe(s.fixtures.userIds.teacher1);

    // 记录详情返回申诉关联
    const detail = await s.request(`/api/records/${record.id}`, { cookie: teacher1.cookie });
    expect(detail.body.relations.appeals.length).toBeGreaterThanOrEqual(1);
    expect(detail.body.relations.appeals[0].status).toBe("SUBMITTED");
  });

  it("申诉理由必填", async () => {
    const record = appealableRecord();
    const noReason = await s.request("/api/appeals", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { recordId: record.id },
    });
    expect(noReason.status).toBe(400);
    const shortReason = await s.request("/api/appeals", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { recordId: record.id, reason: "x" },
    });
    expect(shortReason.status).toBe(400);
  });

  it("申诉详情返回关联证据（evidence_json → evidence 列表）", async () => {
    const insertEvidence = s.db.prepare(
      `INSERT INTO evidence_files(
         id,school_id,student_id,class_id,uploaded_by,original_name,mime,size_bytes,sha256,storage_path,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const record = appealableRecord();
    const evidenceId = randomUUID();
    insertEvidence.run(
      evidenceId,
      s.fixtures.schoolId,
      record.student_id,
      record.class_id,
      s.fixtures.userIds.teacher1,
      "申诉证据-请假条.png",
      "image/png",
      128,
      "0".repeat(64),
      `${evidenceId}.png`,
      new Date().toISOString(),
    );

    const created = await s.request("/api/appeals", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        recordId: record.id,
        reason: "已附请假条证据，申请复核该记录",
        evidenceIds: [evidenceId],
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.appeal.evidence).toEqual([
      { id: evidenceId, name: "申诉证据-请假条.png", mime: "image/png", sizeBytes: 128 },
    ]);

    const detail = await s.request(`/api/appeals/${created.body.appeal.id}`, {
      cookie: teacher1.cookie,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.appeal.evidence).toEqual([
      { id: evidenceId, name: "申诉证据-请假条.png", mime: "image/png", sizeBytes: 128 },
    ]);

    // 列表接口不强制返回证据，但也不能因证据序列化而报错
    const list = await s.request("/api/appeals?status=SUBMITTED&pageSize=100", {
      cookie: teacher1.cookie,
    });
    expect(list.status).toBe(200);
    const listed = list.body.items.find((item: any) => item.id === created.body.appeal.id);
    expect(listed).toBeTruthy();

    // 证据必须属于该申诉记录的学生，否则拒绝登记
    const foreignStudent = s.db
      .prepare("SELECT * FROM students WHERE class_id=? ORDER BY student_no LIMIT 1")
      .get(class8Id);
    expect(foreignStudent).toBeTruthy();
    const foreignEvidenceId = randomUUID();
    insertEvidence.run(
      foreignEvidenceId,
      s.fixtures.schoolId,
      foreignStudent.id,
      foreignStudent.class_id,
      s.fixtures.userIds.teacher1,
      "他人证据.png",
      "image/png",
      64,
      "1".repeat(64),
      `${foreignEvidenceId}.png`,
      new Date().toISOString(),
    );
    const mismatch = await s.request("/api/appeals", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        recordId: appealableRecord().id,
        reason: "证据与申诉记录不匹配的测试",
        evidenceIds: [foreignEvidenceId],
      },
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toContain("证据");
  });
});

describe("状态流转与裁决", () => {
  it("SUBMITTED→UNDER_REVIEW 仅德育处可操作，裁决理由必填", async () => {
    const record = appealableRecord();
    const created = await createAppeal(record.id);
    const appealId = created.body.appeal.id;

    const teacherStart = await s.request(`/api/appeals/${appealId}/start-review`, {
      method: "POST",
      cookie: teacher1.cookie,
    });
    expect(teacherStart.status).toBe(403);

    const started = await s.request(`/api/appeals/${appealId}/start-review`, {
      method: "POST",
      cookie: moral.cookie,
      body: { note: "已受理，正在核实情况" },
    });
    expect(started.status).toBe(200);
    expect(started.body.appeal.status).toBe("UNDER_REVIEW");
    const startAgain = await s.request(`/api/appeals/${appealId}/start-review`, {
      method: "POST",
      cookie: moral.cookie,
    });
    expect(startAgain.status).toBe(400);

    const timeline = await s.request(`/api/appeals/${appealId}`, { cookie: moral.cookie });
    expect(timeline.status).toBe(200);
    expect(timeline.body.decisions.length).toBe(1);
    expect(timeline.body.decisions[0].decision).toBe("UNDER_REVIEW");
    expect(timeline.body.decisions[0].actorName).toBe("陈德处");

    // 非法裁决 / 缺少理由
    const invalidDecision = await s.request(`/api/appeals/${appealId}/decide`, {
      method: "POST",
      cookie: moral.cookie,
      body: { decision: "MAYBE", reason: "无效裁决" },
    });
    expect(invalidDecision.status).toBe(400);
    expect(invalidDecision.body.error).toContain("裁决结果");
    const noReason = await s.request(`/api/appeals/${appealId}/decide`, {
      method: "POST",
      cookie: moral.cookie,
      body: { decision: "REJECTED", reason: "" },
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toContain("理由");

    // 老师/系统管理员均无权裁决（仅德育处）
    const teacherDecide = await s.request(`/api/appeals/${appealId}/decide`, {
      method: "POST",
      cookie: teacher1.cookie,
      body: { decision: "REJECTED", reason: "越权裁决尝试" },
    });
    expect(teacherDecide.status).toBe(403);
    const adminDecide = await s.request(`/api/appeals/${appealId}/decide`, {
      method: "POST",
      cookie: admin.cookie,
      body: { decision: "REJECTED", reason: "管理员越权裁决尝试" },
    });
    expect(adminDecide.status).toBe(403);

    const rejected = await s.request(`/api/appeals/${appealId}/decide`, {
      method: "POST",
      cookie: moral.cookie,
      body: { decision: "REJECTED", reason: "经调取课堂记录，原记录事实清楚，维持原记录" },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.appeal.status).toBe("REJECTED");
    expect(rejected.body.appeal.decidedAt).toBeTruthy();
    expect(rejected.body.appeal.decisionReason).toContain("维持原记录");

    const detail = await s.request(`/api/appeals/${appealId}`, { cookie: moral.cookie });
    expect(detail.body.decisions.map((item: any) => item.decision)).toEqual([
      "UNDER_REVIEW",
      "REJECTED",
    ]);
    const auditRow = s.db
      .prepare("SELECT * FROM audit_logs WHERE action='APPEAL_DECIDE' AND target_id=?")
      .get(appealId);
    expect(auditRow).toBeTruthy();

    const decideAgain = await s.request(`/api/appeals/${appealId}/decide`, {
      method: "POST",
      cookie: moral.cookie,
      body: { decision: "REJECTED", reason: "重复裁决测试" },
    });
    expect(decideAgain.status).toBe(400);
  });
});

describe("接受申诉必须走冲正/更正", () => {
  it("REVOKE：仅冲正，原记录不被改写，学分净变化为 0", async () => {
    const record = appealableRecord();
    const scoreBefore = termScore(record.student_id);
    const created = await createAppeal(record.id);
    const appealId = created.body.appeal.id;
    const decided = await s.request(`/api/appeals/${appealId}/decide`, {
      method: "POST",
      cookie: moral.cookie,
      body: {
        decision: "ACCEPTED",
        reason: "经核实学生参加校运会方阵训练，迟到已提前请假，接受申诉",
        correction: { mode: "REVOKE" },
      },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.appeal.status).toBe("ACCEPTED");
    expect(decided.body.appeal.reversalRecordId).toBeTruthy();
    expect(decided.body.appeal.correctionRecordId).toBeNull();
    expect(decided.body.reversal.recordKind).toBe("REVERSAL");
    expect(decided.body.reversal.reversesRecordId).toBe(record.id);
    expect(decided.body.correction).toBeNull();

    // 原记录仍是 EFFECTIVE，内容不变；靠冲正抵消
    const original = s.db.prepare("SELECT * FROM score_records WHERE id=?").get(record.id);
    expect(original.status).toBe("EFFECTIVE");
    expect(original.points).toBe(record.points);
    expect(
      s.db
        .prepare(
          "SELECT COUNT(*) AS c FROM score_records WHERE reverses_record_id=? AND status='EFFECTIVE'",
        )
        .get(record.id).c,
    ).toBe(1);
    const scoreAfter = termScore(record.student_id);
    // 冲正记录与原记录方向相反：该条记录净贡献归零，总分回到“原记录不存在”的水平。
    expect(scoreAfter.net).toBe(scoreBefore.net - record.signed_points);
    expect(scoreAfter.recordCount).toBe(scoreBefore.recordCount + 1);

    // 时间线包含受理 + 裁决
    const detail = await s.request(`/api/appeals/${appealId}`, { cookie: moral.cookie });
    expect(detail.body.decisions.map((item: any) => item.decision)).toEqual([
      "UNDER_REVIEW",
      "ACCEPTED",
    ]);
    expect(detail.body.decisions[1].reversalRecordId).toBe(decided.body.reversal.id);

    // 已裁决的申诉不能重新处理
    const again = await s.request(`/api/appeals/${appealId}/decide`, {
      method: "POST",
      cookie: moral.cookie,
      body: { decision: "ACCEPTED", reason: "重复处理", correction: { mode: "REVOKE" } },
    });
    expect(again.status).toBe(400);
  });

  it("REPLACE：冲正 + 更正为新规则/分值", async () => {
    const record = appealableRecord();
    const rule = publishedRule("好人好事突出");
    const created = await createAppeal(record.id, "事实认定有误，申请更正");
    const decided = await s.request(`/api/appeals/${created.body.appeal.id}/decide`, {
      method: "POST",
      cookie: moral.cookie,
      body: {
        decision: "ACCEPTED",
        reason: "经查证该行为属于好人好事，更正为加分记录",
        correction: { mode: "REPLACE", ruleId: rule.ruleId, note: "经核实为好人好事" },
      },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.appeal.status).toBe("ACCEPTED");
    const correction = decided.body.correction;
    expect(correction.recordKind).toBe("CORRECTION");
    expect(correction.correctsRecordId).toBe(record.id);
    expect(correction.direction).toBe("ADD");
    expect(correction.points).toBe(rule.points);
    expect(correction.status).toBe("EFFECTIVE");
    expect(decided.body.appeal.correctionRecordId).toBe(correction.id);
    expect(decided.body.reversal.signedPoints).toBe(-record.signed_points);
    const detail = await s.request(`/api/appeals/${decided.body.appeal.id}`, {
      cookie: moral.cookie,
    });
    expect(detail.body.decisions[1].correctionRecordId).toBe(correction.id);
  });

  it("REPLACE 缺少更正内容时拒绝", async () => {
    const record = appealableRecord();
    const created = await createAppeal(record.id);
    const decided = await s.request(`/api/appeals/${created.body.appeal.id}/decide`, {
      method: "POST",
      cookie: moral.cookie,
      body: {
        decision: "ACCEPTED",
        reason: "接受申诉但没有给出更正内容",
        correction: { mode: "REPLACE" },
      },
    });
    expect(decided.status).toBe(400);
    expect(decided.body.error).toContain("更正");
  });
});

describe("利益冲突", () => {
  it("裁决人 == 原记录提交人时必须填写冲突原因并留痕", async () => {
    const rule = publishedRule("主动帮助同学");
    const student = s.db
      .prepare("SELECT * FROM students WHERE class_id=? LIMIT 1")
      .get(class7Id);
    const scored = await s.request("/api/scoring", {
      method: "POST",
      cookie: moral.cookie,
      body: {
        ruleId: rule.ruleId,
        studentId: student.id,
        occurrenceAt: "2026-10-20T08:00:00.000Z",
        note: "德育处自己录入的记录",
      },
    });
    expect(scored.status).toBe(201);
    const created = await createAppeal(scored.body.record.id, "申请复核德育处录入的记录");
    const appealId = created.body.appeal.id;

    const noConflictReason = await s.request(`/api/appeals/${appealId}/decide`, {
      method: "POST",
      cookie: moral.cookie,
      body: { decision: "REJECTED", reason: "维持原记录" },
    });
    expect(noConflictReason.status).toBe(400);
    expect(noConflictReason.body.error).toContain("利益冲突");

    const decided = await s.request(`/api/appeals/${appealId}/decide`, {
      method: "POST",
      cookie: moral.cookie,
      body: {
        decision: "REJECTED",
        reason: "经集体评议，原记录事实清楚，维持原记录",
        conflictReason: "本人为原记录提交人，已回避并由德育处集体评议",
      },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.appeal.conflictFlag).toBe(true);
    expect(decided.body.appeal.status).toBe("REJECTED");
    const appealRow = s.db.prepare("SELECT * FROM appeals WHERE id=?").get(appealId);
    expect(appealRow.conflict_flag).toBe(1);
    expect(appealRow.conflict_reason).toContain("回避");
    const decisionRow = s.db
      .prepare("SELECT * FROM appeal_decisions WHERE appeal_id=? AND decision='REJECTED'")
      .get(appealId);
    expect(decisionRow.conflict_flag).toBe(1);
    expect(decisionRow.conflict_reason).toContain("回避");
  });

  it("appeal_decisions 只追加：数据库触发器禁止更新/删除", async () => {
    const decision = s.db.prepare("SELECT * FROM appeal_decisions LIMIT 1").get();
    expect(decision).toBeTruthy();
    expect(() =>
      s.db
        .prepare("UPDATE appeal_decisions SET reason='篡改' WHERE id=?")
        .run(decision.id),
    ).toThrow(/不可修改/);
    expect(() =>
      s.db.prepare("DELETE FROM appeal_decisions WHERE id=?").run(decision.id),
    ).toThrow(/不可删除/);
  });
});

describe("数据范围隔离", () => {
  it("值日老师只能查看授权班级的申诉", async () => {
    const list1 = await s.request("/api/appeals?pageSize=100", { cookie: teacher1.cookie });
    expect(list1.status).toBe(200);
    expect(list1.body.total).toBeGreaterThan(0);
    const allowed1 = new Set(
      s.db
        .prepare(
          "SELECT id FROM classes WHERE id IN (SELECT scope_id FROM user_scopes WHERE user_id=? AND scope_type='CLASS')",
        )
        .all(s.fixtures.userIds.teacher1)
        .map((row: any) => row.id),
    );
    for (const item of list1.body.items) expect(allowed1.has(item.classId)).toBe(true);

    const class8Appeal = s.db
      .prepare(
        `SELECT a.id FROM appeals a JOIN classes c ON c.id=a.class_id
         JOIN grades g ON g.id=c.grade_id WHERE g.name='八年级' LIMIT 1`,
      )
      .get();
    expect(class8Appeal).toBeTruthy();
    const crossView = await s.request(`/api/appeals/${class8Appeal.id}`, {
      cookie: teacher1.cookie,
    });
    expect(crossView.status).toBe(403);
    const ownView = await s.request(`/api/appeals/${class8Appeal.id}`, {
      cookie: teacher2.cookie,
    });
    expect(ownView.status).toBe(200);

    const invalidStatus = await s.request("/api/appeals?status=UNKNOWN", {
      cookie: teacher1.cookie,
    });
    expect(invalidStatus.status).toBe(400);
  });
});
