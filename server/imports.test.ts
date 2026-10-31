// CSV 导入测试：预览逐行校验、事务提交、整体回滚、错误明细、模板与权限。
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

function csv(header: string[], rows: (string | number)[][]): string {
  const escape = (value: string | number) => {
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `\uFEFF${[header, ...rows].map((row) => row.map(escape).join(",")).join("\r\n")}\r\n`;
}

async function upload(
  cookie: string,
  options: { kind: string; content: string | Uint8Array; filename?: string },
) {
  const form = new FormData();
  form.append("kind", options.kind);
  form.append(
    "file",
    new Blob([options.content as any], { type: "text/csv" }),
    options.filename || "import.csv",
  );
  return s.request("/api/imports/preview", { method: "POST", cookie, formData: form });
}

function countRows(table: string, where = "1=1", params: any[] = []): number {
  return s.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params).count;
}

describe("模板与权限", () => {
  it("管理员可下载 CSV 模板", async () => {
    const { cookie } = await s.login("admin");
    const res = await s.request("/api/imports/template.csv?kind=students", { cookie });
    expect(res.status).toBe(200);
    expect(res.body).toContain("姓名");
    expect(res.body).toContain("学号");
    const bad = await s.request("/api/imports/template.csv?kind=unknown", { cookie });
    expect(bad.status).toBe(400);
    const classes = await s.request("/api/imports/template.csv?kind=classes", { cookie });
    expect(classes.body).toContain("班主任工号");
    const teachers = await s.request("/api/imports/template.csv?kind=teachers", { cookie });
    expect(teachers.body).toContain("工号");
  });

  it("德育处/值日老师无权导入", async () => {
    for (const key of ["moral", "teacher1"]) {
      const { cookie } = await s.login(key);
      const res = await upload(cookie, {
        kind: "students",
        content: csv(["姓名", "学号", "年级", "班级"], [["张三", "2026999", "七年级", "1班"]]),
      });
      expect(res.status).toBe(403);
      const history = await s.request("/api/imports", { cookie });
      expect(history.status).toBe(403);
    }
  });
});

describe("预览逐行校验", () => {
  it("同时返回有效行与逐行错误明细，并入库任务与错误记录", async () => {
    const { cookie } = await s.login("admin");
    const res = await upload(cookie, {
      kind: "students",
      content: csv(
        ["姓名", "学号", "年级", "班级", "性别", "状态"],
        [
          ["导入甲", "9000001", "七年级", "1班", "男", "ACTIVE"],
          ["导入乙", "9000002", "不存在年级", "1班", "", ""],
          ["导入丙", "9000001", "七年级", "1班", "女", ""],
          ["导入丁", "9000003", "七年级", "9班", "", "在读"],
          ["导入戊", "9000004", "七年级", "1班", "未知", "ACTIVE"],
        ],
      ),
    });
    expect(res.status).toBe(201);
    expect(res.body.job).toMatchObject({
      kind: "students",
      filename: "import.csv",
      status: "PREVIEW",
      totalRows: 5,
      validRows: 1,
      errorRows: 4,
    });
    expect(res.body.preview.length).toBe(5);
    expect(res.body.preview[0].ok).toBe(true);
    expect(res.body.preview[0].data.name).toBe("导入甲");
    expect(res.body.preview[1].errors.some((item: any) => item.column === "年级")).toBe(true);
    expect(res.body.preview[2].errors.some((item: any) => item.message.includes("重复"))).toBe(true);
    expect(res.body.preview[3].errors.some((item: any) => item.column === "班级")).toBe(true);
    expect(res.body.preview[4].errors.some((item: any) => item.column === "性别")).toBe(true);
    expect(res.body.preview[0].rowNumber).toBe(2);
    const job = s.db.prepare("SELECT * FROM import_jobs WHERE id=?").get(res.body.job.id);
    expect(job.error_rows).toBe(4);
    expect(countRows("import_errors", "job_id=?", [job.id])).toBeGreaterThanOrEqual(4);
  });

  it("缺少必需列、空文件、非 UTF-8、非 csv 后缀均给出中文错误", async () => {
    const { cookie } = await s.login("admin");
    const missing = await upload(cookie, {
      kind: "students",
      content: csv(["姓名", "年级"], [["张", "七年级"]]),
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("缺少必需列");
    const empty = await upload(cookie, { kind: "students", content: "" });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toContain("CSV 文件为空");
    const gbk = new Uint8Array([0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0xd1, 0xa7, 0xba, 0xc5]);
    const encoding = await upload(cookie, { kind: "students", content: gbk });
    expect(encoding.status).toBe(400);
    expect(encoding.body.error).toContain("编码");
    const extension = await upload(cookie, {
      kind: "students",
      content: csv(["姓名", "学号", "年级", "班级"], [["张", "9000010", "七年级", "1班"]]),
      filename: "students.xlsx",
    });
    expect(extension.status).toBe(400);
    expect(extension.body.error).toContain(".csv");
    const big = await upload(cookie, {
      kind: "students",
      content: "x".repeat(2 * 1024 * 1024 + 100),
      filename: "big.csv",
    });
    expect(big.status).toBe(413);
  });

  it("超过 2000 行拒绝导入", async () => {
    const { cookie } = await s.login("admin");
    const rows = Array.from({ length: 2001 }, (_, index) => [
      `学生${index}`,
      `88${String(index).padStart(6, "0")}`,
      "七年级",
      "1班",
    ]);
    const res = await upload(cookie, {
      kind: "students",
      content: csv(["姓名", "学号", "年级", "班级"], rows),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("2000");
  });
});

describe("事务提交与整体回滚", () => {
  it("存在错误行时拒绝提交，且不产生半批数据", async () => {
    const { cookie } = await s.login("admin");
    const before = countRows("students");
    const preview = await upload(cookie, {
      kind: "students",
      content: csv(
        ["姓名", "学号", "年级", "班级"],
        [
          ["有效学生", "9100001", "七年级", "1班"],
          ["无效班级", "9100002", "七年级", "99班"],
        ],
      ),
    });
    expect(preview.status).toBe(201);
    expect(preview.body.job.errorRows).toBe(1);
    const commit = await s.request(`/api/imports/${preview.body.job.id}/commit`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(commit.status).toBe(400);
    expect(commit.body.error).toContain("不允许部分导入");
    expect(countRows("students")).toBe(before);
  });

  it("提交成功后写入数据，重复提交被拒绝，历史可查询", async () => {
    const { cookie } = await s.login("admin");
    const preview = await upload(cookie, {
      kind: "students",
      content: csv(
        ["姓名", "学号", "年级", "班级", "性别"],
        [
          ["导入学生A", "9100010", "七年级", "2班", "男"],
          ["导入学生B", "9100011", "七年级", "2班", "女"],
        ],
      ),
    });
    expect(preview.status).toBe(201);
    const commit = await s.request(`/api/imports/${preview.body.job.id}/commit`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(commit.status).toBe(200);
    expect(commit.body.inserted).toBe(2);
    expect(commit.body.job.status).toBe("COMMITTED");
    expect(countRows("students", "student_no IN ('9100010','9100011')")).toBe(2);
    const again = await s.request(`/api/imports/${preview.body.job.id}/commit`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(again.status).toBe(400);
    const history = await s.request("/api/imports?kind=students&page=1&pageSize=5", { cookie });
    expect(history.status).toBe(200);
    expect(history.body.items.length).toBeGreaterThan(0);
    expect(history.body.items.every((item: any) => item.kind === "students")).toBe(true);
    expect(history.body.total).toBeGreaterThanOrEqual(1);
    const detail = await s.request(`/api/imports/${preview.body.job.id}`, { cookie });
    expect(detail.status).toBe(200);
    expect(detail.body.job.id).toBe(preview.body.job.id);
  });

  it("提交阶段发生冲突（预览后被其他数据占用）时整体回滚并标记失败", async () => {
    const { cookie } = await s.login("admin");
    const preview = await upload(cookie, {
      kind: "students",
      content: csv(
        ["姓名", "学号", "年级", "班级"],
        [
          ["回滚学生A", "9200001", "七年级", "1班"],
          ["回滚学生B", "9200002", "七年级", "1班"],
        ],
      ),
    });
    expect(preview.status).toBe(201);
    // 预览完成后，其他操作占用了第 2 行的学号。
    s.db
      .prepare(
        "INSERT INTO students(id,school_id,grade_id,class_id,student_no,name,gender,status,joined_at,created_at) VALUES(?,?,?,?,?,?,'其他','ACTIVE','',?)",
      )
      .run(
        randomUUID(),
        s.fixtures.schoolId,
        s.fixtures.grades[0].id,
        s.fixtures.classes[0].id,
        "9200002",
        "冲突学生",
        new Date().toISOString(),
      );
    const commit = await s.request(`/api/imports/${preview.body.job.id}/commit`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(commit.status).toBe(400);
    expect(commit.body.error).toContain("回滚");
    // 第 1 行也不能落库
    expect(countRows("students", "student_no='9200001'")).toBe(0);
    const job = s.db.prepare("SELECT status,result_summary FROM import_jobs WHERE id=?").get(preview.body.job.id);
    expect(job.status).toBe("FAILED");
    expect(job.result_summary).toContain("回滚");
  });

  it("错误明细 CSV 可下载且包含行号与错误信息", async () => {
    const { cookie } = await s.login("admin");
    const preview = await upload(cookie, {
      kind: "students",
      content: csv(["姓名", "学号", "年级", "班级"], [["错误行", "9300001", "七年级", "缺失班级"]]),
    });
    const res = await s.request(`/api/imports/${preview.body.job.id}/errors.csv`, { cookie });
    expect(res.status).toBe(200);
    expect(res.body).toContain("行号");
    expect(res.body).toContain("错误信息");
    expect(res.body).toContain("缺失班级");
    const notFound = await s.request(`/api/imports/${randomUUID()}/errors.csv`, { cookie });
    expect(notFound.status).toBe(404);
  });
});

describe("班级与教师导入", () => {
  it("班级导入校验年级关联与班主任工号", async () => {
    const { cookie } = await s.login("admin");
    const preview = await upload(cookie, {
      kind: "classes",
      content: csv(
        ["年级", "班级", "班主任工号"],
        [
          ["七年级", "导入3班", "T001"],
          ["七年级", "1班", ""],
          ["不存在年级", "1班", ""],
          ["七年级", "导入4班", "T999"],
        ],
      ),
    });
    expect(preview.status).toBe(201);
    expect(preview.body.job.validRows).toBe(1);
    expect(preview.body.job.errorRows).toBe(3);
    const commit = await s.request(`/api/imports/${preview.body.job.id}/commit`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(commit.status).toBe(400); // 错误行存在，整体拒绝
    // 重新只导入有效行
    const cleanPreview = await upload(cookie, {
      kind: "classes",
      content: csv(["年级", "班级", "班主任工号"], [["七年级", "导入3班", "T001"]]),
    });
    expect(cleanPreview.body.job.validRows).toBe(1);
    const cleanCommit = await s.request(`/api/imports/${cleanPreview.body.job.id}/commit`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(cleanCommit.status).toBe(200);
    const row = s.db.prepare("SELECT head_teacher_id FROM classes WHERE name='导入3班'").get();
    expect(row).toBeTruthy();
    expect(row.head_teacher_id).toBeTruthy();
  });

  it("教师导入生成教师目录但不自动创建账号", async () => {
    const { cookie } = await s.login("admin");
    const usersBefore = countRows("users");
    const preview = await upload(cookie, {
      kind: "teachers",
      content: csv(
        ["姓名", "工号", "学科", "手机号"],
        [
          ["导入老师甲", "T910", "数学", "13900000010"],
          ["导入老师乙", "T911", "", ""],
        ],
      ),
    });
    expect(preview.status).toBe(201);
    expect(preview.body.job.validRows).toBe(2);
    const commit = await s.request(`/api/imports/${preview.body.job.id}/commit`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(commit.status).toBe(200);
    expect(commit.body.inserted).toBe(2);
    expect(countRows("teachers", "employee_no IN ('T910','T911')")).toBe(2);
    expect(countRows("users")).toBe(usersBefore);
    const teachers = await s.request("/api/teachers?search=T910", { cookie });
    expect(teachers.body.items[0].account).toBe("");
  });
});
