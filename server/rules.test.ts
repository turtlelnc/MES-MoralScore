// 规则版本 / 分类 的后端契约测试：生命周期、版本不可覆盖、发布权限与记分解析。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestServer } from "./test-utils.mjs";

let s: any;
let teacher1: any;
let teacher2: any;
let teacher3: any;
let moral: any;
let admin: any;
let grade7Id: string;
let grade8Id: string;
let class7Id: string;
let class8Id: string;
let class9Id: string;
let categoryId: string;
let ruleCounter = 0;

beforeAll(async () => {
  s = await createTestServer();
  teacher1 = await s.login("teacher1");
  teacher2 = await s.login("teacher2");
  teacher3 = await s.login("teacher3");
  moral = await s.login("moral");
  admin = await s.login("admin");
  const grade7 = s.db.prepare("SELECT * FROM grades WHERE name='七年级'").get();
  const grade8 = s.db.prepare("SELECT * FROM grades WHERE name='八年级'").get();
  grade7Id = grade7.id;
  grade8Id = grade8.id;
  class7Id = s.db
    .prepare("SELECT id FROM classes WHERE grade_id=? AND name='1班'")
    .get(grade7Id).id;
  class8Id = s.db
    .prepare("SELECT id FROM classes WHERE grade_id=? AND name='1班'")
    .get(grade8Id).id;
  class9Id = s.db
    .prepare("SELECT id FROM classes WHERE grade_id=(SELECT id FROM grades WHERE name='九年级') AND name='1班'")
    .get().id;
  categoryId = s.db.prepare("SELECT id FROM scoring_categories WHERE name='日常行为规范'").get().id;
});

afterAll(async () => {
  await s?.close();
});

function nextName(prefix = "测试规则") {
  ruleCounter += 1;
  return `${prefix}-${ruleCounter}`;
}

async function createDraftRule(overrides: Record<string, any> = {}) {
  const body = {
    categoryId,
    name: nextName(),
    direction: "ADD",
    points: 2,
    description: "测试规则说明",
    ...overrides,
  };
  if (body.categoryName) {
    body.categoryId = s.db
      .prepare("SELECT id FROM scoring_categories WHERE name=?")
      .get(body.categoryName).id;
    delete body.categoryName;
  }
  const res = await s.request("/api/rules", { method: "POST", cookie: moral.cookie, body });
  expect(res.status).toBe(201);
  return res.body.rule;
}

async function publishRule(overrides: Record<string, any> = {}, effectiveFrom = "2026-09-01T00:00:00.000Z") {
  const rule = await createDraftRule(overrides);
  const submitted = await s.request(`/api/rules/${rule.id}/submit`, {
    method: "POST",
    cookie: moral.cookie,
  });
  expect(submitted.status).toBe(200);
  const approved = await s.request(`/api/rules/${rule.id}/approve`, {
    method: "POST",
    cookie: moral.cookie,
  });
  expect(approved.status).toBe(200);
  const published = await s.request(`/api/rules/${rule.id}/publish`, {
    method: "POST",
    cookie: moral.cookie,
    body: { effectiveFrom },
  });
  expect(published.status).toBe(200);
  return published.body.rule;
}

function studentOf(classId: string) {
  const student = s.db.prepare("SELECT * FROM students WHERE class_id=? LIMIT 1").get(classId);
  expect(student).toBeTruthy();
  return student;
}

function latestVersion(ruleId: string) {
  return s.db
    .prepare(
      "SELECT v.* FROM scoring_rule_versions v JOIN scoring_rules r ON r.id=v.rule_id WHERE v.rule_id=? AND v.version=r.latest_version",
    )
    .get(ruleId);
}

describe("分类与规则维护权限", () => {
  it("分类所有角色可读，只有系统管理员可以创建/修改", async () => {
    const list = await s.request("/api/categories", { cookie: teacher1.cookie });
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(9);
    const item = list.body.items[0];
    expect(item).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      directionScope: expect.any(String),
      isEnabled: expect.any(Boolean),
    });

    const forbidden = await s.request("/api/categories", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { name: "越权分类" },
    });
    expect(forbidden.status).toBe(403);

    const created = await s.request("/api/categories", {
      method: "POST",
      cookie: admin.cookie,
      body: { name: "测试自定义分类", description: "测试用", sortOrder: 99 },
    });
    expect(created.status).toBe(201);
    expect(created.body.category.name).toBe("测试自定义分类");

    const duplicate = await s.request("/api/categories", {
      method: "POST",
      cookie: admin.cookie,
      body: { name: "测试自定义分类" },
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toContain("已存在");

    const updated = await s.request(`/api/categories/${created.body.category.id}`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { description: "修改后的说明", isEnabled: false },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.category.description).toBe("修改后的说明");
    expect(updated.body.category.isEnabled).toBe(false);
  });

  it("管理员可以建规则草稿但不能发布，值日老师不能建规则", async () => {
    const draft = await s.request("/api/rules", {
      method: "POST",
      cookie: admin.cookie,
      body: { categoryId, name: nextName("管理员草稿"), direction: "ADD", points: 1 },
    });
    expect(draft.status).toBe(201);
    expect(draft.body.rule.status).toBe("DRAFT");

    const submit = await s.request(`/api/rules/${draft.body.rule.id}/submit`, {
      method: "POST",
      cookie: admin.cookie,
    });
    expect(submit.status).toBe(200);
    const approveByAdmin = await s.request(`/api/rules/${draft.body.rule.id}/approve`, {
      method: "POST",
      cookie: admin.cookie,
    });
    expect(approveByAdmin.status).toBe(403);
    const publishByAdmin = await s.request(`/api/rules/${draft.body.rule.id}/publish`, {
      method: "POST",
      cookie: admin.cookie,
      body: { effectiveFrom: "2026-09-01" },
    });
    expect(publishByAdmin.status).toBe(403);

    const teacherCreate = await s.request("/api/rules", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { categoryId, name: nextName("老师越权"), direction: "ADD", points: 1 },
    });
    expect(teacherCreate.status).toBe(403);
    const teacherPatch = await s.request(`/api/rules/${draft.body.rule.id}`, {
      method: "PATCH",
      cookie: teacher1.cookie,
      body: { points: 5 },
    });
    expect(teacherPatch.status).toBe(403);
  });
});

describe("规则版本生命周期", () => {
  it("草稿→提交→审核→发布，修改已发布规则生成新版本并归档旧版本", async () => {
    const created = await createDraftRule({ points: 2, description: "第一版说明" });
    expect(created.status).toBe("DRAFT");
    expect(created.version).toBe(1);
    expect(created.versionId).toBeTruthy();
    expect(created.categoryName).toBe("日常行为规范");

    // 值日老师记分选择列表只包含已发布版本，看不到草稿。
    const teacherListBefore = await s.request("/api/rules", { cookie: teacher1.cookie });
    expect(teacherListBefore.status).toBe(200);
    expect(teacherListBefore.body.items.some((r: any) => r.id === created.id)).toBe(false);

    // 草稿原地修改：不产生新版本
    const patched = await s.request(`/api/rules/${created.id}`, {
      method: "PATCH",
      cookie: moral.cookie,
      body: { points: 3, changeNote: "调整分值" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.rule.version).toBe(1);
    expect(patched.body.rule.points).toBe(3);
    const detailDraft = await s.request(`/api/rules/${created.id}`, { cookie: moral.cookie });
    expect(detailDraft.body.versions.length).toBe(1);

    // 提交 → 审核 → 发布
    expect(
      (await s.request(`/api/rules/${created.id}/submit`, { method: "POST", cookie: moral.cookie }))
        .body.rule.status,
    ).toBe("SUBMITTED");
    expect(
      (await s.request(`/api/rules/${created.id}/approve`, { method: "POST", cookie: moral.cookie }))
        .body.rule.status,
    ).toBe("APPROVED");
    const published = await s.request(`/api/rules/${created.id}/publish`, {
      method: "POST",
      cookie: moral.cookie,
      body: { effectiveFrom: "2026-09-01T00:00:00.000Z", note: "首次发布" },
    });
    expect(published.status).toBe(200);
    expect(published.body.rule.status).toBe("PUBLISHED");
    expect(published.body.rule.effectiveFrom).toBe("2026-09-01T00:00:00.000Z");
    expect(published.body.rule.activeVersionId).toBe(published.body.rule.versionId);
    const ruleRow = s.db.prepare("SELECT * FROM scoring_rules WHERE id=?").get(created.id);
    expect(ruleRow.active_version_id).toBe(published.body.rule.versionId);

    // 发布后老师列表可见、可以记分
    const teacherListAfter = await s.request("/api/rules", { cookie: teacher1.cookie });
    const listed = teacherListAfter.body.items.find((r: any) => r.id === created.id);
    expect(listed).toBeTruthy();
    expect(listed.status).toBe("PUBLISHED");
    expect(listed.version).toBe(1);

    const student = studentOf(class7Id);
    const scored = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        ruleId: created.id,
        studentId: student.id,
        occurrenceAt: "2026-10-10T08:00:00.000Z",
        note: "使用已发布规则记分",
      },
    });
    expect(scored.status).toBe(201);
    expect(scored.body.record.points).toBe(3);
    expect(scored.body.record.ruleId).toBe(created.id);

    // 已发布规则修改 → 新版本 DRAFT，旧版本仍 PUBLISHED 且继续生效
    const patchedPublished = await s.request(`/api/rules/${created.id}`, {
      method: "PATCH",
      cookie: moral.cookie,
      body: { points: 4, changeNote: "第二版：提高分值" },
    });
    expect(patchedPublished.status).toBe(200);
    expect(patchedPublished.body.rule.status).toBe("DRAFT");
    expect(patchedPublished.body.rule.version).toBe(2);
    expect(patchedPublished.body.rule.versionId).not.toBe(published.body.rule.versionId);
    // 老师看到的仍是已发布 v1
    const teacherListV2 = await s.request("/api/rules", { cookie: teacher1.cookie });
    const stillV1 = teacherListV2.body.items.find((r: any) => r.id === created.id);
    expect(stillV1.version).toBe(1);
    expect(stillV1.points).toBe(3);

    // 发布 v2：旧已发布版本归档，active_version_id 指向 v2
    await s.request(`/api/rules/${created.id}/submit`, { method: "POST", cookie: moral.cookie });
    await s.request(`/api/rules/${created.id}/approve`, { method: "POST", cookie: moral.cookie });
    const publishedV2 = await s.request(`/api/rules/${created.id}/publish`, {
      method: "POST",
      cookie: moral.cookie,
      body: { effectiveFrom: "2026-10-01T00:00:00.000Z", note: "第二版发布" },
    });
    expect(publishedV2.status).toBe(200);
    expect(publishedV2.body.rule.version).toBe(2);
    expect(publishedV2.body.rule.status).toBe("PUBLISHED");
    const detailV2 = await s.request(`/api/rules/${created.id}`, { cookie: moral.cookie });
    expect(detailV2.body.versions.length).toBe(2);
    expect(detailV2.body.versions[0].version).toBe(2);
    expect(detailV2.body.versions[0].status).toBe("PUBLISHED");
    expect(detailV2.body.versions[1].version).toBe(1);
    expect(detailV2.body.versions[1].status).toBe("ARCHIVED");
    const ruleRowV2 = s.db.prepare("SELECT * FROM scoring_rules WHERE id=?").get(created.id);
    expect(ruleRowV2.active_version_id).toBe(publishedV2.body.rule.versionId);
    expect(ruleRowV2.latest_version).toBe(2);

    // 新记录使用新版本分值；历史记录快照保持 v1
    const scoredV2 = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        ruleId: created.id,
        studentId: student.id,
        occurrenceAt: "2026-10-11T08:00:00.000Z",
        note: "使用第二版规则记分",
      },
    });
    expect(scoredV2.status).toBe(201);
    expect(scoredV2.body.record.points).toBe(4);
    expect(scoredV2.body.record.ruleVersionId).toBe(publishedV2.body.rule.versionId);
    const oldRecord = s.db.prepare("SELECT * FROM score_records WHERE id=?").get(scored.body.record.id);
    expect(JSON.parse(oldRecord.rule_snapshot_json).points).toBe(3);
    expect(JSON.parse(oldRecord.rule_snapshot_json).version).toBe(1);

    // 审计留痕
    const actions = s.db
      .prepare("SELECT action FROM audit_logs WHERE target_id=? ORDER BY created_at")
      .all(created.id)
      .map((row: any) => row.action);
    expect(actions).toContain("RULE_CREATE");
    expect(actions).toContain("RULE_SUBMIT");
    expect(actions).toContain("RULE_APPROVE");
    expect(actions).toContain("RULE_PUBLISH");
    expect(actions).toContain("RULE_UPDATE");
  });

  it("驳回 SUBMITTED→REJECTED→DRAFT 后可重新提交", async () => {
    const rule = await createDraftRule({ name: nextName("待驳回规则") });
    await s.request(`/api/rules/${rule.id}/submit`, { method: "POST", cookie: moral.cookie });
    const rejectNoReason = await s.request(`/api/rules/${rule.id}/reject`, {
      method: "POST",
      cookie: moral.cookie,
      body: {},
    });
    expect(rejectNoReason.status).toBe(400);
    const rejected = await s.request(`/api/rules/${rule.id}/reject`, {
      method: "POST",
      cookie: moral.cookie,
      body: { reason: "分值与校规不符" },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.rule.status).toBe("REJECTED");
    expect(rejected.body.rule.changeNote).toContain("分值与校规不符");

    // 驳回版本不可直接再次提交 → 先回到草稿
    const submitRejected = await s.request(`/api/rules/${rule.id}/submit`, {
      method: "POST",
      cookie: moral.cookie,
    });
    expect(submitRejected.status).toBe(200);
    const detail = await s.request(`/api/rules/${rule.id}`, { cookie: moral.cookie });
    expect(detail.body.versions[0].status).toBe("SUBMITTED");

    // 重新走完整流程
    const reject2 = await s.request(`/api/rules/${rule.id}/reject`, {
      method: "POST",
      cookie: moral.cookie,
      body: { reason: "仍需调整" },
    });
    expect(reject2.body.rule.status).toBe("REJECTED");
    const backDraft = await s.request(`/api/rules/${rule.id}`, {
      method: "PATCH",
      cookie: moral.cookie,
      body: { changeNote: "按驳回意见调整完毕" },
    });
    expect(backDraft.status).toBe(200);
    expect(backDraft.body.rule.status).toBe("DRAFT");
    expect(
      (await s.request(`/api/rules/${rule.id}/submit`, { method: "POST", cookie: moral.cookie }))
        .body.rule.status,
    ).toBe("SUBMITTED");
  });

  it("发布参数校验：缺少生效时间返回中文 400", async () => {
    const rule = await createDraftRule();
    await s.request(`/api/rules/${rule.id}/submit`, { method: "POST", cookie: moral.cookie });
    await s.request(`/api/rules/${rule.id}/approve`, { method: "POST", cookie: moral.cookie });
    const invalid = await s.request(`/api/rules/${rule.id}/publish`, {
      method: "POST",
      cookie: moral.cookie,
      body: {},
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("生效时间");
    const badRange = await s.request(`/api/rules/${rule.id}/publish`, {
      method: "POST",
      cookie: moral.cookie,
      body: { effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveTo: "2026-09-01T00:00:00.000Z" },
    });
    expect(badRange.status).toBe(400);
    expect(badRange.body.error).toContain("失效时间");
    // 未审核通过的规则不能发布
    const draft2 = await createDraftRule();
    const publishDraft = await s.request(`/api/rules/${draft2.id}/publish`, {
      method: "POST",
      cookie: moral.cookie,
      body: { effectiveFrom: "2026-09-01" },
    });
    expect(publishDraft.status).toBe(400);
  });
});

describe("记分规则解析 resolveRuleForScoring", () => {
  it("未发布/已归档的规则不能记分", async () => {
    const student = studentOf(class7Id);
    const draft = await createDraftRule();
    const draftRes = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher1.cookie,
      body: { ruleId: draft.id, studentId: student.id, occurrenceAt: "2026-10-10T08:00:00.000Z" },
    });
    expect(draftRes.status).toBe(400);
    expect(draftRes.body.error).toContain("尚未发布");

    const published = await publishRule();
    const ok = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        ruleId: published.id,
        studentId: student.id,
        occurrenceAt: "2026-10-10T08:00:00.000Z",
        note: "归档前记分",
      },
    });
    expect(ok.status).toBe(201);
    const archived = await s.request(`/api/rules/${published.id}/archive`, {
      method: "POST",
      cookie: moral.cookie,
    });
    expect(archived.status).toBe(200);
    expect(archived.body.rule.status).toBe("ARCHIVED");
    const afterArchive = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        ruleId: published.id,
        studentId: student.id,
        occurrenceAt: "2026-10-11T08:00:00.000Z",
        note: "归档后记分",
      },
    });
    expect(afterArchive.status).toBe(400);
    expect(afterArchive.body.error).toContain("尚未发布");
  });

  it("生效时间与适用范围必须匹配", async () => {
    // 未来生效
    const future = await publishRule({}, "2026-12-01T00:00:00.000Z");
    const student7 = studentOf(class7Id);
    const beforeEffective = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        ruleId: future.id,
        studentId: student7.id,
        occurrenceAt: "2026-10-20T08:00:00.000Z",
        note: "生效前使用",
      },
    });
    expect(beforeEffective.status).toBe(400);
    expect(beforeEffective.body.error).toContain("生效时间");

    // CLASS 范围：九年级1班规则不能用于七年级学生
    const classRule = await publishRule({
      name: nextName("班级范围规则"),
      targetScope: "CLASS",
      scopeIds: [class9Id],
    });
    const wrongClass = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher1.cookie,
      body: {
        ruleId: classRule.id,
        studentId: student7.id,
        occurrenceAt: "2026-10-10T08:00:00.000Z",
        note: "跨班级使用规则",
      },
    });
    expect(wrongClass.status).toBe(400);
    expect(wrongClass.body.error).toContain("班级");

    // 九年级老师可以用这条班级规则
    const student9 = studentOf(class9Id);
    const rightClass = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher3.cookie,
      body: {
        ruleId: classRule.id,
        studentId: student9.id,
        occurrenceAt: "2026-10-10T08:00:00.000Z",
        note: "本班规则记分",
      },
    });
    expect(rightClass.status).toBe(201);

    // GRADE 范围：七年级规则不能用于八年级学生
    const gradeRule = await publishRule({
      name: nextName("年级范围规则"),
      targetScope: "GRADE",
      scopeIds: [grade7Id],
    });
    const student8 = studentOf(class8Id);
    const wrongGrade = await s.request("/api/scoring", {
      method: "POST",
      cookie: teacher2.cookie,
      body: {
        ruleId: gradeRule.id,
        studentId: student8.id,
        occurrenceAt: "2026-10-10T08:00:00.000Z",
        note: "跨年级使用规则",
      },
    });
    expect(wrongGrade.status).toBe(400);
    expect(wrongGrade.body.error).toContain("年级");
  });

  it("范围参数校验：GRADE/CLASS 必须提供有效范围 ID", async () => {
    const missingScope = await s.request("/api/rules", {
      method: "POST",
      cookie: moral.cookie,
      body: {
        categoryId,
        name: nextName("缺少范围"),
        direction: "ADD",
        points: 1,
        targetScope: "CLASS",
      },
    });
    expect(missingScope.status).toBe(400);
    expect(missingScope.body.error).toContain("适用范围");

    const invalidClass = await s.request("/api/rules", {
      method: "POST",
      cookie: moral.cookie,
      body: {
        categoryId,
        name: nextName("无效范围"),
        direction: "ADD",
        points: 1,
        targetScope: "CLASS",
        scopeIds: ["00000000-0000-4000-8000-000000000000"],
      },
    });
    expect(invalidClass.status).toBe(400);

    const invalidPoints = await s.request("/api/rules", {
      method: "POST",
      cookie: moral.cookie,
      body: { categoryId, name: nextName("非法分值"), direction: "ADD", points: 0 },
    });
    expect(invalidPoints.status).toBe(400);
    expect(invalidPoints.body.error).toContain("分值");

    const invalidDirection = await s.request("/api/rules", {
      method: "POST",
      cookie: moral.cookie,
      body: { categoryId, name: nextName("非法方向"), direction: "UP", points: 1 },
    });
    expect(invalidDirection.status).toBe(400);
    expect(invalidDirection.body.error).toContain("方向");
  });
});
