// 家长只读分享测试：高熵 token 仅存哈希、过期/撤销/不存在统一 404、
// 访问日志与计数、学号脱敏、不泄露其他学生与排名。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { createTestServer } from "./test-utils.mjs";

let s: any;

beforeAll(async () => {
  s = await createTestServer();
});
afterAll(async () => {
  if (s) await s.close();
});

const INVALID_MESSAGE = "分享链接无效或已过期";
const PRIVACY = "仅限授权家长查看，不展示班级排名与其他学生信息";

async function createShare(cookie: string, studentId: string, expiresInDays = 7, label = "测试分享") {
  return s.request("/api/shares", {
    method: "POST",
    cookie,
    body: { studentId, expiresInDays, label },
  });
}

describe("创建与列表", () => {
  it("管理员/德育处可创建高熵 token，库中只保存 sha256", async () => {
    const { cookie } = await s.login("admin");
    const student = s.fixtures.students[0];
    const res = await createShare(cookie, student.id);
    expect(res.status).toBe(201);
    const share = res.body.share;
    expect(share.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(share.url).toBe(`/#/share/${share.token}`);
    expect(share.studentName).toBe(student.name);
    expect(share.expiresAt > new Date().toISOString()).toBe(true);
    const row = s.db.prepare("SELECT * FROM parent_shares WHERE id=?").get(share.id);
    expect(row.token_hash).toBe(createHash("sha256").update(share.token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(share.token);
    // 德育处同样可以创建
    const { cookie: moral } = await s.login("moral");
    const moralShare = await createShare(moral, student.id);
    expect(moralShare.status).toBe(201);
  });

  it("值日老师无权创建/查看分享", async () => {
    const { cookie } = await s.login("teacher1");
    const res = await createShare(cookie, s.fixtures.students[0].id);
    expect(res.status).toBe(403);
    const list = await s.request("/api/shares", { cookie });
    expect(list.status).toBe(403);
  });

  it("有效期必须为 1-90 天", async () => {
    const { cookie } = await s.login("admin");
    const student = s.fixtures.students[0];
    for (const days of [0, 91, -1]) {
      const res = await createShare(cookie, student.id, days);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("1-90");
    }
    const missingStudent = await s.request("/api/shares", {
      method: "POST",
      cookie,
      body: { studentId: "00000000-0000-4000-8000-000000000000", expiresInDays: 7 },
    });
    expect(missingStudent.status).toBe(404);
  });

  it("分享列表返回状态与访问计数且不包含 token 原文", async () => {
    const { cookie } = await s.login("admin");
    const created = await createShare(cookie, s.fixtures.students[1].id, 7, "列表测试");
    const res = await s.request("/api/shares?page=1&pageSize=50", { cookie });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(3);
    const item = res.body.items.find((row: any) => row.id === created.body.share.id);
    expect(item.status).toBe("ACTIVE");
    expect(item.statusLabel).toBe("有效");
    expect(item.accessCount).toBe(0);
    expect(item.createdByName).toBe("林校长");
    expect(JSON.stringify(res.body)).not.toContain(created.body.share.token);
    // 按学生筛选
    const filtered = await s.request(`/api/shares?studentId=${s.fixtures.students[0].id}`, { cookie });
    expect(filtered.status).toBe(200);
    expect(filtered.body.items.every((row: any) => row.studentId === s.fixtures.students[0].id)).toBe(true);
  });
});

describe("公开访问与隐私", () => {
  it("访问成功返回脱敏学生报告、写入访问日志并更新计数", async () => {
    const { cookie } = await s.login("admin");
    const student = s.fixtures.students.find(
      (item: any) => item.class_id === s.fixtures.classes[0].id,
    );
    const created = await createShare(cookie, student.id);
    const token = created.body.share.token;
    const res = await s.request(`/api/public/share/${token}`, {
      headers: { "user-agent": "vitest-parent-share/1.0" },
    });
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.student.id).toBe(student.id);
    expect(body.student.name).toBe(student.name);
    expect(body.student.studentNo).toContain("*");
    expect(JSON.stringify(body)).not.toContain(student.student_no);
    expect(body.period.type).toBe("term");
    expect(Array.isArray(body.narrative)).toBe(true);
    expect(Array.isArray(body.honors)).toBe(true);
    expect(Array.isArray(body.rewards)).toBe(true);
    expect(body.privacyNote).toBe(PRIVACY);
    expect(body.expiresAt).toBeTruthy();
    expect(body.shareLabel).toBe("测试分享");
    // 不泄露其他学生信息与排名明细
    const otherNames = s.fixtures.students
      .filter((item: any) => item.id !== student.id)
      .slice(0, 30)
      .map((item: any) => item.name);
    const text = JSON.stringify(body);
    expect(otherNames.some((name: string) => text.includes(name))).toBe(false);
    expect(text).not.toContain("班级排名：");
    // 访问日志与计数
    const log = s.db
      .prepare("SELECT * FROM parent_share_access_log WHERE share_id=? ORDER BY created_at DESC")
      .get(created.body.share.id);
    expect(log).toBeTruthy();
    expect(log.user_agent).toContain("vitest-parent-share");
    const row = s.db.prepare("SELECT access_count,last_accessed_at FROM parent_shares WHERE id=?").get(
      created.body.share.id,
    );
    expect(row.access_count).toBe(1);
    expect(row.last_accessed_at).toBeTruthy();
    await s.request(`/api/public/share/${token}`);
    expect(
      s.db.prepare("SELECT access_count FROM parent_shares WHERE id=?").get(created.body.share.id)
        .access_count,
    ).toBe(2);
  });

  it("撤销后立即失效且重复撤销返回 400", async () => {
    const { cookie } = await s.login("admin");
    const created = await createShare(cookie, s.fixtures.students[2].id);
    const token = created.body.share.token;
    const before = await s.request(`/api/public/share/${token}`);
    expect(before.status).toBe(200);
    const revoke = await s.request(`/api/shares/${created.body.share.id}/revoke`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(revoke.status).toBe(200);
    expect(revoke.body.share.status).toBe("REVOKED");
    expect(revoke.body.share.statusLabel).toBe("已撤销");
    const after = await s.request(`/api/public/share/${token}`);
    expect(after.status).toBe(404);
    expect(after.body.error).toBe(INVALID_MESSAGE);
    const again = await s.request(`/api/shares/${created.body.share.id}/revoke`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(again.status).toBe(400);
  });

  it("过期、不存在、被撤销的分享统一返回 404 中文提示", async () => {
    const expiredToken = `expired-${"x".repeat(30)}`;
    s.db
      .prepare(
        "INSERT INTO parent_shares(id,school_id,student_id,token_hash,label,created_by,expires_at,revoked_at,created_at,last_accessed_at,access_count) VALUES(?,?,?,?,?,?,?,NULL,?,NULL,0)",
      )
      .run(
        "share-expired-test-01",
        s.fixtures.schoolId,
        s.fixtures.students[0].id,
        createHash("sha256").update(expiredToken).digest("hex"),
        "过期分享",
        s.fixtures.userIds.admin,
        "2020-01-01T00:00:00.000Z",
        new Date().toISOString(),
      );
    const expired = await s.request(`/api/public/share/${expiredToken}`);
    expect(expired.status).toBe(404);
    expect(expired.body.error).toBe(INVALID_MESSAGE);
    const unknown = await s.request(`/api/public/share/${"y".repeat(43)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe(INVALID_MESSAGE);
    const fixtureRevoked = await s.request("/api/public/share/revoked-demo-share-token");
    expect(fixtureRevoked.status).toBe(404);
    expect(fixtureRevoked.body.error).toBe(INVALID_MESSAGE);
  });

  it("演示分享 token 可访问且不返回学号原文", async () => {
    const res = await s.request(`/api/public/share/${s.fixtures.shareToken}`);
    expect(res.status).toBe(200);
    expect(res.body.privacyNote).toBe(PRIVACY);
    expect(JSON.stringify(res.body)).not.toContain(s.fixtures.students[0].student_no);
  });
});
