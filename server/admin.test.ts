// 系统管理测试：账号与数据范围、自我保护、系统参数、荣誉/兑换配置、
// 审计日志筛选、真实备份（VACUUM INTO 文件与保留策略）与运维 CLI。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTestServer } from "./test-utils.mjs";

let s: any;

beforeAll(async () => {
  s = await createTestServer();
});
afterAll(async () => {
  if (s) await s.close();
});

describe("账号与数据范围管理", () => {
  it("仅管理员可访问账号与系统管理接口", async () => {
    const { cookie: admin } = await s.login("admin");
    const list = await s.request("/api/admin/users", { cookie: admin });
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(5);
    expect(list.body.items[0].roleLabel).toBeTruthy();
    for (const key of ["moral", "teacher1"]) {
      const { cookie } = await s.login(key);
      expect((await s.request("/api/admin/users", { cookie })).status).toBe(403);
      expect((await s.request("/api/admin/system", { cookie })).status).toBe(403);
      expect((await s.request("/api/admin/backups", { cookie })).status).toBe(403);
      expect((await s.request("/api/admin/audit-logs", { cookie })).status).toBe(403);
      expect((await s.request("/api/admin/honors", { cookie })).status).toBe(403);
    }
  });

  it("创建账号：密码策略、账号唯一、角色与数据范围校验", async () => {
    const { cookie } = await s.login("admin");
    const weak = await s.request("/api/admin/users", {
      method: "POST",
      cookie,
      body: { account: "weakuser", displayName: "弱密码", password: "1234567890", role: "DUTY_TEACHER" },
    });
    expect(weak.status).toBe(400);
    expect(weak.body.error).toContain("密码");
    const badRole = await s.request("/api/admin/users", {
      method: "POST",
      cookie,
      body: { account: "roleuser", displayName: "角色", password: "Valid@Pass2026", role: "PRINCIPAL" },
    });
    expect(badRole.status).toBe(400);
    expect(badRole.body.error).toContain("角色");
    const created = await s.request("/api/admin/users", {
      method: "POST",
      cookie,
      body: {
        account: "datateacher",
        displayName: "数据老师",
        password: "Qx9!MoralData",
        role: "DUTY_TEACHER",
        scopes: [
          { scopeType: "CLASS", scopeId: s.fixtures.classes[0].id },
          { scopeType: "GRADE", scopeId: s.fixtures.grades[1].id },
        ],
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.user.scopes.length).toBe(2);
    expect(created.body.user.mustChangePassword).toBe(true);
    expect(created.body.user.password_hash).toBeUndefined();
    expect(JSON.stringify(created.body)).not.toContain("password");
    const duplicate = await s.request("/api/admin/users", {
      method: "POST",
      cookie,
      body: { account: "datateacher", displayName: "重复", password: "Qx9!MoralData", role: "MORAL_AFFAIRS" },
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toContain("已存在");
    const invalidScope = await s.request("/api/admin/users", {
      method: "POST",
      cookie,
      body: {
        account: "badscope1",
        displayName: "错误范围",
        password: "Qx9!MoralBadScope",
        role: "DUTY_TEACHER",
        scopes: [{ scopeType: "CLASS", scopeId: "00000000-0000-4000-8000-000000000000" }],
      },
    });
    expect(invalidScope.status).toBe(400);
    expect(invalidScope.body.error).toContain("不存在");
    // 非值日老师角色忽略 scopes
    const moralUser = await s.request("/api/admin/users", {
      method: "POST",
      cookie,
      body: {
        account: "xavier1",
        displayName: "德育协助",
        password: "Qx9!Teamwork9",
        role: "MORAL_AFFAIRS",
        scopes: [{ scopeType: "CLASS", scopeId: s.fixtures.classes[0].id }],
      },
    });
    expect(moralUser.status).toBe(201);
    expect(moralUser.body.user.scopes.length).toBe(0);
    // 新账号可登录且必须改密
    const login = await s.login("datateacher", "Qx9!MoralData");
    expect(login.user.mustChangePassword).toBe(true);
  });

  it("不能停用或降级自己，也不能修改自己的角色", async () => {
    const { cookie } = await s.login("admin");
    const adminId = s.fixtures.userIds.admin;
    const disable = await s.request(`/api/admin/users/${adminId}`, {
      method: "PATCH",
      cookie,
      body: { status: "DISABLED" },
    });
    expect(disable.status).toBe(400);
    expect(disable.body.error).toContain("不能停用");
    const demote = await s.request(`/api/admin/users/${adminId}`, {
      method: "PATCH",
      cookie,
      body: { role: "MORAL_AFFAIRS" },
    });
    expect(demote.status).toBe(400);
    expect(demote.body.error).toContain("不能修改自己的角色");
    const self = await s.request("/api/me", { cookie });
    expect(self.status).toBe(200);
  });

  it("编辑账号：停用后无法登录、数据范围可替换，角色变化会清理范围", async () => {
    const { cookie } = await s.login("admin");
    const created = await s.request("/api/admin/users", {
      method: "POST",
      cookie,
      body: {
        account: "walter1",
        displayName: "范围测试",
        password: "Qx9!Teamwork8",
        role: "DUTY_TEACHER",
        scopes: [{ scopeType: "CLASS", scopeId: s.fixtures.classes[0].id }],
      },
    });
    const userId = created.body.user.id;
    const disable = await s.request(`/api/admin/users/${userId}`, {
      method: "PATCH",
      cookie,
      body: { status: "DISABLED" },
    });
    expect(disable.status).toBe(200);
    const disabledLogin = await s.request("/api/auth/login", {
      method: "POST",
      body: { account: "walter1", password: "Qx9!Teamwork8" },
    });
    expect(disabledLogin.status).toBe(403);
    const enable = await s.request(`/api/admin/users/${userId}`, {
      method: "PATCH",
      cookie,
      body: { status: "ACTIVE" },
    });
    expect(enable.status).toBe(200);
    const renamed = await s.request(`/api/admin/users/${userId}`, {
      method: "PATCH",
      cookie,
      body: {
        displayName: "范围测试改",
        scopes: [{ scopeType: "GRADE", scopeId: s.fixtures.grades[1].id }],
      },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.user.displayName).toBe("范围测试改");
    expect(renamed.body.user.scopes.length).toBe(1);
    expect(renamed.body.user.scopes[0].scopeType).toBe("GRADE");
    const toMoral = await s.request(`/api/admin/users/${userId}`, {
      method: "PATCH",
      cookie,
      body: { role: "MORAL_AFFAIRS" },
    });
    expect(toMoral.status).toBe(200);
    expect(toMoral.body.user.scopes.length).toBe(0);
    // 可关联/取消关联教师目录（前端编辑账号会带 teacherId）
    const freeTeacher = s.db.prepare("SELECT id FROM teachers WHERE employee_no='T004'").get();
    const linked = await s.request(`/api/admin/users/${userId}`, {
      method: "PATCH",
      cookie,
      body: { teacherId: freeTeacher.id },
    });
    expect(linked.status).toBe(200);
    expect(linked.body.user.teacherId).toBe(freeTeacher.id);
    expect(linked.body.user.teacherName).toBe("陈晓");
    const takenTeacher = s.db.prepare("SELECT id FROM teachers WHERE employee_no='T001'").get();
    const conflict = await s.request(`/api/admin/users/${userId}`, {
      method: "PATCH",
      cookie,
      body: { teacherId: takenTeacher.id },
    });
    expect(conflict.status).toBe(400);
    expect(conflict.body.error).toContain("已关联");
    const unlinked = await s.request(`/api/admin/users/${userId}`, {
      method: "PATCH",
      cookie,
      body: { teacherId: null },
    });
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.user.teacherId).toBeNull();
    const empty = await s.request(`/api/admin/users/${userId}`, {
      method: "PATCH",
      cookie,
      body: {},
    });
    expect(empty.status).toBe(400);
  });

  it("重置密码后 must_change_password=1，旧密码失效", async () => {
    const { cookie } = await s.login("admin");
    const created = await s.request("/api/admin/users", {
      method: "POST",
      cookie,
      body: { account: "resetuser", displayName: "重置用户", password: "Qx9!BeforeReset", role: "MORAL_AFFAIRS" },
    });
    const userId = created.body.user.id;
    const weak = await s.request(`/api/admin/users/${userId}/reset-password`, {
      method: "POST",
      cookie,
      body: { password: "1234567890" },
    });
    expect(weak.status).toBe(400);
    const reset = await s.request(`/api/admin/users/${userId}/reset-password`, {
      method: "POST",
      cookie,
      body: { password: "Zz8@AfterReset" },
    });
    expect(reset.status).toBe(200);
    expect(reset.body.mustChangePassword).toBe(true);
    expect(s.db.prepare("SELECT must_change_password FROM users WHERE id=?").get(userId).must_change_password).toBe(1);
    const oldLogin = await s.request("/api/auth/login", {
      method: "POST",
      body: { account: "resetuser", password: "Qx9!BeforeReset" },
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await s.login("resetuser", "Zz8@AfterReset");
    expect(newLogin.user.mustChangePassword).toBe(true);
  });
});

describe("系统参数与荣誉/兑换配置", () => {
  it("读取并修改系统参数，学校接口同步生效", async () => {
    const { cookie } = await s.login("admin");
    const initial = await s.request("/api/admin/system", { cookie });
    expect(initial.status).toBe(200);
    expect(initial.body.settings).toEqual({ initialPoints: 100, allowNegative: false, reviewThreshold: 10 });
    expect(initial.body.backupDirConfigured).toBe(true);
    expect(initial.body.periods.years.length).toBe(2);
    const patched = await s.request("/api/admin/system", {
      method: "PATCH",
      cookie,
      body: { initialPoints: 120, allowNegative: true, reviewThreshold: 5 },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.settings).toEqual({ initialPoints: 120, allowNegative: true, reviewThreshold: 5 });
    const school = await s.request("/api/school", { cookie });
    expect(school.body.settings).toEqual({ initialPoints: 120, allowNegative: true, reviewThreshold: 5 });
    for (const body of [{ reviewThreshold: 0 }, { reviewThreshold: 5000 }, { initialPoints: -1 }, { initialPoints: 1.5 }]) {
      const bad = await s.request("/api/admin/system", { method: "PATCH", cookie, body });
      expect(bad.status).toBe(400);
    }
    const restore = await s.request("/api/admin/system", {
      method: "PATCH",
      cookie,
      body: { initialPoints: 100, allowNegative: false, reviewThreshold: 10 },
    });
    expect(restore.body.settings.initialPoints).toBe(100);
  });

  it("荣誉参考规则与积分兑换项目支持增改", async () => {
    const { cookie } = await s.login("admin");
    const honors = await s.request("/api/admin/honors", { cookie });
    expect(honors.status).toBe(200);
    expect(honors.body.items.length).toBe(3);
    const createdHonor = await s.request("/api/admin/honors", {
      method: "POST",
      cookie,
      body: { name: "进步鼓励奖", description: "鼓励持续进步", minPoints: 150, minPositiveRecords: 6 },
    });
    expect(createdHonor.status).toBe(201);
    const honorId = createdHonor.body.honor.id;
    const patchedHonor = await s.request(`/api/admin/honors/${honorId}`, {
      method: "PATCH",
      cookie,
      body: { minPoints: 160, isEnabled: false },
    });
    expect(patchedHonor.status).toBe(200);
    expect(patchedHonor.body.honor.minPoints).toBe(160);
    expect(patchedHonor.body.honor.isEnabled).toBe(false);
    const invalidHonor = await s.request(`/api/admin/honors/${honorId}`, {
      method: "PATCH",
      cookie,
      body: { minPoints: -5 },
    });
    expect(invalidHonor.status).toBe(400);

    const rewards = await s.request("/api/admin/rewards", { cookie });
    expect(rewards.body.items.length).toBe(3);
    const createdReward = await s.request("/api/admin/rewards", {
      method: "POST",
      cookie,
      body: { name: "免值日一次", description: "参考兑换", pointsCost: 25 },
    });
    expect(createdReward.status).toBe(201);
    const rewardId = createdReward.body.reward.id;
    const patchedReward = await s.request(`/api/admin/rewards/${rewardId}`, {
      method: "PATCH",
      cookie,
      body: { pointsCost: 35, isEnabled: false },
    });
    expect(patchedReward.status).toBe(200);
    expect(patchedReward.body.reward.pointsCost).toBe(35);
    const invalidReward = await s.request("/api/admin/rewards", {
      method: "POST",
      cookie,
      body: { name: "零积分", pointsCost: 0 },
    });
    expect(invalidReward.status).toBe(400);
    const missing = await s.request("/api/admin/honors/00000000-0000-4000-8000-000000000000", {
      method: "PATCH",
      cookie,
      body: { minPoints: 10 },
    });
    expect(missing.status).toBe(404);
  });
});

describe("审计日志", () => {
  it("支持 action/actorId/时间筛选且分页字段完整", async () => {
    const { cookie } = await s.login("admin");
    const res = await s.request("/api/admin/audit-logs?action=USER_CREATE&page=1&pageSize=5", { cookie });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((item: any) => item.action === "USER_CREATE")).toBe(true);
    expect(res.body.items[0].actorAccount).toBe("admin");
    expect(res.body.items[0].createdAt).toBeTruthy();
    expect(res.body.items[0].result).toBe("SUCCESS");
    expect(res.body).toHaveProperty("totalPages");
    const byActor = await s.request(
      `/api/admin/audit-logs?action=USER_CREATE&actorId=${s.fixtures.userIds.admin}`,
      { cookie },
    );
    expect(byActor.status).toBe(200);
    expect(byActor.body.items.length).toBeGreaterThanOrEqual(res.body.items.length);
    const byRange = await s.request("/api/admin/audit-logs?from=2020-01-01&to=2030-12-31", { cookie });
    expect(byRange.status).toBe(200);
    expect(byRange.body.items.length).toBeGreaterThan(0);
    const badRange = await s.request("/api/admin/audit-logs?from=2030-01-01&to=2020-01-01", { cookie });
    expect(badRange.status).toBe(400);
    const invalidDate = await s.request("/api/admin/audit-logs?from=not-a-date", { cookie });
    expect(invalidDate.status).toBe(400);
    // 敏感操作都有审计
    const actions = s.db.prepare("SELECT DISTINCT action FROM audit_logs").all().map((row: any) => row.action);
    for (const action of [
      "USER_CREATE",
      "USER_UPDATE",
      "USER_RESET_PASSWORD",
      "SYSTEM_SETTINGS_UPDATE",
      "HONOR_CREATE",
      "REWARD_CREATE",
    ]) {
      expect(actions).toContain(action);
    }
  });
});

describe("真实备份", () => {
  it("POST /api/admin/backups 执行 VACUUM INTO 并生成可查询的快照", async () => {
    const { cookie } = await s.login("admin");
    const before = await s.request("/api/admin/backups", { cookie });
    expect(before.status).toBe(200);
    expect(before.body.backupDirConfigured).toBe(true);
    const initialCount = before.body.items.length;
    const res = await s.request("/api/admin/backups", { method: "POST", cookie, body: {} });
    expect(res.status).toBe(201);
    const job = res.body.job;
    expect(job.status).toBe("SUCCEEDED");
    expect(job.sizeBytes).toBeGreaterThan(0);
    expect(job.fileName.endsWith(".sqlite")).toBe(true);
    expect(fs.existsSync(job.filePath)).toBe(true);
    expect(fs.statSync(job.filePath).size).toBe(job.sizeBytes);
    // 快照是真实 SQLite 数据库，包含业务数据
    const snapshot = new DatabaseSync(job.filePath, { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT COUNT(*) AS count FROM schools").get().count).toBe(1);
      expect(snapshot.prepare("SELECT COUNT(*) AS count FROM students").get().count).toBe(
        s.db.prepare("SELECT COUNT(*) AS count FROM students").get().count,
      );
    } finally {
      snapshot.close();
    }
    const list = await s.request("/api/admin/backups", { cookie });
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(initialCount + 1);
    expect(list.body.items[0].id).toBe(job.id);
    expect(list.body.items[0].createdByName).toBe("林校长");
    expect(list.body.items[0].startedAt).toBeTruthy();
    expect(list.body.items[0].finishedAt).toBeTruthy();
    expect(s.db.prepare("SELECT action FROM audit_logs WHERE action='BACKUP_RUN'").get()).toBeTruthy();
  });

  it("未配置 BACKUP_DIR 时返回 400 中文说明", async () => {
    const { cookie } = await s.login("admin");
    const original = s.config.backupDir;
    s.config.backupDir = "";
    try {
      const res = await s.request("/api/admin/backups", { method: "POST", cookie, body: {} });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("BACKUP_DIR");
      const system = await s.request("/api/admin/system", { cookie });
      expect(system.body.backupDirConfigured).toBe(false);
    } finally {
      s.config.backupDir = original;
    }
  });

  it("保留最近 N 份备份（BACKUP_KEEP_RECENT），按时间倒序返回", async () => {
    const { cookie } = await s.login("admin");
    const keep = s.config.backupKeepRecent;
    const backupDir = s.config.backupDir;
    fs.readdirSync(backupDir)
      .filter((name: string) => name.endsWith(".sqlite"))
      .forEach((name: string) => fs.rmSync(path.join(backupDir, name), { force: true }));
    s.db.prepare("DELETE FROM backup_jobs").run();
    for (let index = 0; index < keep + 2; index += 1) {
      const res = await s.request("/api/admin/backups", { method: "POST", cookie, body: {} });
      expect(res.status).toBe(201);
    }
    const files = fs.readdirSync(backupDir).filter((name: string) => name.endsWith(".sqlite"));
    expect(files.length).toBe(keep);
    const list = await s.request("/api/admin/backups", { cookie });
    expect(list.body.items.length).toBe(keep);
    const times = list.body.items.map((item: any) => item.startedAt);
    const sorted = [...times].sort().reverse();
    expect(times).toEqual(sorted);
    // 最后一次运行 pruned 了最早的文件
    const lastRun = await s.request("/api/admin/backups", { method: "POST", cookie, body: {} });
    expect(lastRun.body.pruned.length).toBe(1);
    expect(fs.readdirSync(backupDir).filter((name: string) => name.endsWith(".sqlite")).length).toBe(keep);
  });

  it("运维 CLI 可执行真实备份并输出 JSON，未配置时退出码非 0", async () => {
    const cliPath = path.resolve(process.cwd(), "tools/ops/backup.mjs");
    const env = {
      ...process.env,
      DATA_DIR: s.config.dataDir,
      BACKUP_DIR: s.config.backupDir,
      BACKUP_KEEP_RECENT: "5",
    };
    const status = spawnSync(process.execPath, [cliPath, "status"], { env, encoding: "utf8" });
    expect(status.status).toBe(0);
    const statusJson = JSON.parse(status.stdout);
    expect(statusJson.ok).toBe(true);
    expect(statusJson.backupDirConfigured).toBe(true);
    expect(statusJson.items.length).toBeGreaterThan(0);
    const run = spawnSync(process.execPath, [cliPath, "run"], { env, encoding: "utf8" });
    expect(run.status).toBe(0);
    const runJson = JSON.parse(run.stdout);
    expect(runJson.ok).toBe(true);
    expect(runJson.job.status).toBe("SUCCEEDED");
    expect(fs.existsSync(runJson.job.filePath)).toBe(true);
    const unconfigured = spawnSync(process.execPath, [cliPath, "run"], {
      env: { ...env, BACKUP_DIR: "" },
      encoding: "utf8",
    });
    expect(unconfigured.status).toBe(1);
    const unconfiguredJson = JSON.parse(unconfigured.stdout);
    expect(unconfiguredJson.ok).toBe(false);
    expect(unconfiguredJson.error).toContain("BACKUP_DIR");
    const badCommand = spawnSync(process.execPath, [cliPath, "bogus"], { env, encoding: "utf8" });
    expect(badCommand.status).toBe(1);
  });
});

describe("管理员自身会话安全", () => {
  it("重置自己的密码后当前会话仍有效且被要求改密", async () => {
    const { cookie } = await s.login("admin");
    const res = await s.request(`/api/admin/users/${s.fixtures.userIds.admin}/reset-password`, {
      method: "POST",
      cookie,
      body: { password: "Adm1n@SelfReset2026" },
    });
    expect(res.status).toBe(200);
    expect(res.body.mustChangePassword).toBe(true);
    expect(
      s.db.prepare("SELECT must_change_password FROM users WHERE id=?").get(s.fixtures.userIds.admin)
        .must_change_password,
    ).toBe(1);
    const me = await s.request("/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(me.body.user.mustChangePassword).toBe(true);
  });
});
