// Playwright 真实浏览器流程测试：真实 UI + 真实 Express API + 真实临时 SQLite（fixture 服务）。
// 不使用 mock；需要业务数据时通过真实 /api 以真实账号获取（setup），断言走页面交互。
import { test, expect } from "@playwright/test";

const ACCOUNTS = {
  admin: { account: "admin", password: "Admin@MES2026", roleLabel: "系统管理员" },
  moral: { account: "moral", password: "Moral@MES2026", roleLabel: "德育处/政教处" },
  teacher1: { account: "teacher1", password: "Teacher@MES2026", roleLabel: "值日老师" },
  teacher2: { account: "teacher2", password: "Teacher@MES2026", roleLabel: "值日老师" },
};

const SUBMIT_TOKEN = "demo-cadre-link-2026";
const SHARE_TOKEN = "demo-parent-share-2026";

/* ------------------------------------------------------------------ 稳定性 */
// 每个用例监听 pageerror 并断言为空（过滤 Chromium ResizeObserver 内部噪音）。
const pageErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => {
    const message = error?.message || String(error);
    if (message.includes("ResizeObserver loop")) return;
    errors.push(message);
  });
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) || [], "页面不应出现未捕获的运行时异常").toEqual([]);
});

/* -------------------------------------------------------------------- 工具 */
async function gotoLogin(page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录校园德育工作台" })).toBeVisible();
}

async function loginViaUi(page, key) {
  const account = ACCOUNTS[key];
  await gotoLogin(page);
  await page.locator("#login-account").fill(account.account);
  await page.locator("#login-password").fill(account.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".user-chip-role")).toHaveText(account.roleLabel);
  await expect(page.locator(".page-title").first()).toBeVisible();
}

async function logoutViaUi(page) {
  await page.locator(".user-chip").click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录校园德育工作台" })).toBeVisible();
}

/** 桌面端：通过左侧导航切换页面。 */
async function desktopNav(page, label, expectedTitle) {
  await page.locator(".sidebar-nav").getByRole("button", { name: label }).click();
  if (expectedTitle) await expect(page.locator(".page-title").first()).toHaveText(expectedTitle);
}

/** 移动端：通过底部导航切换页面。 */
async function mobileNav(page, label) {
  const nav = page.getByRole("navigation", { name: "底部导航" });
  await nav.getByRole("button", { name: label, exact: true }).click();
}

function dialog(page, text) {
  return page.getByRole("dialog").filter({ hasText: text });
}

function toast(page, text) {
  return page.locator(".toast").filter({ hasText: text });
}

/** 关闭弹窗：点 footer 的「关闭」按钮，避开 header 中同名的图标按钮。 */
async function closeModal(dialogLocator) {
  await dialogLocator
    .locator(".modal-actions")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
}

async function expectNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    metrics.scrollWidth,
    `${label} 出现整页横向溢出（scrollWidth=${metrics.scrollWidth}, innerWidth=${metrics.innerWidth}）`,
  ).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

async function apiLogin(request, key) {
  const response = await request.post("/api/auth/login", { data: ACCOUNTS[key] });
  expect(response.ok(), `${key} 通过 API 登录`).toBeTruthy();
  return response.json();
}

async function fetchClasses(request) {
  const response = await request.get("/api/classes");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return body.items;
}

async function fetchStudentsOfClass(request, classId) {
  const response = await request.get("/api/students", {
    params: { classId, pageSize: 100 },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return body.items;
}

/** 以 teacher1 身份取到「七年级1班」及其学生（真实 API，用于选择学生/公共申报身份）。 */
async function loadTeacher1ClassAndStudents(request) {
  await apiLogin(request, "teacher1");
  const classes = await fetchClasses(request);
  const class71 = classes.find((item) => item.gradeName === "七年级" && item.name === "1班");
  expect(class71, "应能查询到七年级1班").toBeTruthy();
  const students = await fetchStudentsOfClass(request, class71.id);
  expect(students.length).toBeGreaterThan(0);
  return { class71, students };
}

/** 以 teacher2 身份在八年级1班创建一条已生效记录，返回记录 id 与唯一说明。 */
async function createTeacher2Record(request) {
  await apiLogin(request, "teacher2");
  const classes = await fetchClasses(request);
  const class81 = classes.find((item) => item.gradeName === "八年级" && item.name === "1班");
  expect(class81, "应能查询到八年级1班").toBeTruthy();
  const students = await fetchStudentsOfClass(request, class81.id);
  const rulesResponse = await request.get("/api/rules", {
    params: { search: "主动帮助同学" },
  });
  expect(rulesResponse.ok()).toBeTruthy();
  const rules = (await rulesResponse.json()).items;
  const rule = rules.find((item) => item.name === "主动帮助同学");
  expect(rule, "教师应能看到已发布规则").toBeTruthy();
  const note = `浏览器申诉测试记录-${Date.now()}`;
  const scored = await request.post("/api/scoring", {
    data: { ruleId: rule.id, studentId: students[0].id, note },
  });
  expect(scored.ok(), "API 创建申诉测试记录").toBeTruthy();
  const body = await scored.json();
  return { recordId: body.record.id, student: students[0], class81, rule, note };
}

/* -------------------------------------------------------------------- 用例 */
test.describe("登录与权限边界", () => {
  test("登录：错误密码提示；admin/moral/teacher1 登录成功；退出返回登录页；未登录 API 401", async ({
    page,
    request,
  }) => {
    await gotoLogin(page);
    await page.locator("#login-account").fill("admin");
    await page.locator("#login-password").fill("wrong-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "账号或密码不正确" })).toBeVisible();
    // 仍在登录页
    await expect(page.getByRole("heading", { name: "登录校园德育工作台" })).toBeVisible();

    await loginViaUi(page, "admin");
    await expect(page.locator(".sidebar-nav").getByRole("button", { name: "系统管理" })).toBeVisible();
    await logoutViaUi(page);

    await loginViaUi(page, "moral");
    await expect(page.locator(".sidebar-nav").getByRole("button", { name: "申诉中心" })).toBeVisible();
    await expect(page.locator(".sidebar-nav").getByRole("button", { name: "系统管理" })).toHaveCount(0);
    await logoutViaUi(page);

    await loginViaUi(page, "teacher1");
    await expect(page.locator(".sidebar-nav").getByRole("button", { name: "快捷记分" })).toBeVisible();
    await expect(page.locator(".sidebar-nav").getByRole("button", { name: "系统管理" })).toHaveCount(0);
    await logoutViaUi(page);

    // 未登录访问受保护 API：直接 401（request 上下文没有会话 Cookie）
    for (const path of ["/api/students", "/api/records", "/api/dashboard"]) {
      const response = await request.get(path);
      expect(response.status(), `${path} 未登录应 401`).toBe(401);
    }
  });

  test("权限与数据范围：teacher1 看不到八年级数据，直接请求范围外数据 403", async ({
    page,
    request,
  }) => {
    // 先以 admin 取到八年级班级 id（用于越权请求），再以 teacher1 登录校验。
    await apiLogin(request, "admin");
    const allClasses = await fetchClasses(request);
    const class81 = allClasses.find((item) => item.gradeName === "八年级" && item.name === "1班");
    expect(class81).toBeTruthy();
    await apiLogin(request, "teacher1");

    const crossClass = await request.get("/api/records", {
      params: { classId: class81.id },
    });
    expect(crossClass.status()).toBe(403);
    const crossStudents = await request.get("/api/students", {
      params: { classId: class81.id },
    });
    expect(crossStudents.status()).toBe(403);

    // UI：积分记录的班级筛选项只有授权范围内的七年级班级
    await loginViaUi(page, "teacher1");
    await desktopNav(page, "积分记录", "积分记录");
    const classOptions = await page
      .locator('select[aria-label="按班级筛选"] option')
      .allTextContents();
    expect(classOptions.some((text) => text.includes("1班（七年级）"))).toBeTruthy();
    expect(classOptions.some((text) => text.includes("2班（七年级）"))).toBeTruthy();
    expect(classOptions.some((text) => text.includes("八年级"))).toBeFalsy();
    // 学生筛选也只包含授权范围学生
    const studentOptions = await page
      .locator('select[aria-label="按学生筛选"] option')
      .allTextContents();
    expect(studentOptions.some((text) => text.includes("八年级"))).toBeFalsy();
  });
});

test.describe("规则发布流程", () => {
  test("管理员不可审核/发布；德育处审核并发布后教师快捷记分可选到该规则", async ({ page, request }) => {
    test.setTimeout(90000);
    const ruleName = "文明就餐监督岗"; // fixtures 中的 SUBMITTED 规则

    // 1) 管理员查看待审核规则：能看到但没有任何审核/发布按钮
    await loginViaUi(page, "admin");
    await desktopNav(page, "评分规则", "评分规则");
    await page.locator('input[aria-label="搜索规则"]').fill(ruleName);
    await page
      .locator("table.table tbody tr")
      .filter({ hasText: ruleName })
      .getByRole("button", { name: ruleName })
      .click();
    const adminDetail = dialog(page, ruleName);
    await expect(adminDetail).toBeVisible();
    await expect(
      adminDetail.getByText("系统管理员不能审核或发布规则", { exact: false }),
    ).toBeVisible();
    await expect(adminDetail.getByRole("button", { name: "审核通过" })).toHaveCount(0);
    await expect(adminDetail.getByRole("button", { name: "发布规则" })).toHaveCount(0);
    await closeModal(adminDetail);
    await logoutViaUi(page);

    // 2) 德育处审核通过
    await loginViaUi(page, "moral");
    await desktopNav(page, "评分规则", "评分规则");
    await page.locator('input[aria-label="搜索规则"]').fill(ruleName);
    await page
      .locator("table.table tbody tr")
      .filter({ hasText: ruleName })
      .getByRole("button", { name: ruleName })
      .click();
    const moralDetail = dialog(page, ruleName);
    await expect(moralDetail.getByRole("button", { name: "审核通过" })).toBeVisible();
    await moralDetail.getByRole("button", { name: "审核通过" }).click();
    const approveConfirm = dialog(page, "审核通过该规则？");
    await expect(approveConfirm).toBeVisible();
    await approveConfirm.getByRole("button", { name: "审核通过" }).click();
    await expect(toast(page, "审核通过，等待发布")).toBeVisible();
    await expect(moralDetail.getByRole("button", { name: "发布规则" })).toBeVisible();
    await closeModal(moralDetail);
    await logoutViaUi(page);

    // 3) 管理员复核：已审核规则仍无发布权限（仅显示禁用的「发布（需德育处）」）
    await loginViaUi(page, "admin");
    await desktopNav(page, "评分规则", "评分规则");
    await page.locator('input[aria-label="搜索规则"]').fill(ruleName);
    await page
      .locator("table.table tbody tr")
      .filter({ hasText: ruleName })
      .getByRole("button", { name: ruleName })
      .click();
    const adminDetail2 = dialog(page, ruleName);
    const disabledPublish = adminDetail2.getByRole("button", { name: "发布（需德育处）" });
    await expect(disabledPublish).toBeVisible();
    await expect(disabledPublish).toBeDisabled();
    await expect(adminDetail2.getByRole("button", { name: "发布规则" })).toHaveCount(0);
    await closeModal(adminDetail2);
    await logoutViaUi(page);

    // 4) 德育处填写生效时间并发布（二次确认）
    await loginViaUi(page, "moral");
    await desktopNav(page, "评分规则", "评分规则");
    await page.locator('input[aria-label="搜索规则"]').fill(ruleName);
    await page
      .locator("table.table tbody tr")
      .filter({ hasText: ruleName })
      .getByRole("button", { name: ruleName })
      .click();
    const moralDetail2 = dialog(page, ruleName);
    await moralDetail2.getByRole("button", { name: "发布规则" }).click();
    const publishModal = dialog(page, "发布评分规则");
    await expect(publishModal).toBeVisible();
    await publishModal.locator('input[type="datetime-local"]').first().fill("2026-09-01T00:00");
    await publishModal.getByRole("button", { name: "下一步：确认发布" }).click();
    const publishConfirm = dialog(page, "确认发布该规则？");
    await expect(publishConfirm).toBeVisible();
    await expect(publishConfirm.locator("dt").filter({ hasText: "生效时间" })).toBeVisible();
    await expect(publishConfirm.locator("dt").filter({ hasText: "适用范围" })).toBeVisible();
    await publishConfirm.getByRole("button", { name: "确认发布" }).click();
    await expect(toast(page, "规则已发布")).toBeVisible();
    await closeModal(moralDetail2);
    await logoutViaUi(page);

    // 5) 值日老师在快捷记分第 2 步可选到刚发布的规则
    const { students } = await loadTeacher1ClassAndStudents(request);
    await loginViaUi(page, "teacher1");
    await desktopNav(page, "快捷记分", "快捷记分");
    await page.getByRole("textbox", { name: "搜索学生姓名或学号" }).fill(students[0].name);
    await expect(page.getByRole("checkbox")).toHaveCount(1);
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "下一步：选择规则" }).click();
    const ruleLabel = page.locator("label.list-item").filter({ hasText: ruleName });
    await expect(ruleLabel).toBeVisible();
    await ruleLabel.click();
    await expect(
      page.getByText(`已选：${ruleName}`, { exact: false }).first(),
    ).toBeVisible();
  });
});

test.describe("快捷记分与积分记录", () => {
  test("教师完成单条记分：确认弹窗 → 成功提示 → 积分记录出现该记录", async ({ page, request }) => {
    test.setTimeout(60000);
    const { students } = await loadTeacher1ClassAndStudents(request);
    const student = students[0];
    const note = `浏览器记分测试：主动帮助同学讲解数学题-${Date.now()}`;

    await loginViaUi(page, "teacher1");
    await desktopNav(page, "快捷记分", "快捷记分");
    // 第 1 步：搜索并选择学生
    await page.getByRole("textbox", { name: "搜索学生姓名或学号" }).fill(student.name);
    await expect(page.getByRole("checkbox")).toHaveCount(1);
    await page.getByRole("checkbox").first().check();
    await expect(page.locator(".badge").filter({ hasText: "已选 1 人" })).toBeVisible();
    await page.getByRole("button", { name: "下一步：选择规则" }).click();
    // 第 2 步：选择已发布规则
    const ruleLabel = page.locator("label.list-item").filter({ hasText: "主动帮助同学" });
    await expect(ruleLabel).toBeVisible();
    await ruleLabel.click();
    await page.getByRole("button", { name: "下一步：填写说明" }).click();
    // 第 3 步：填写说明并二次确认
    await expect(page.locator("#score-note")).toBeVisible();
    await page.locator("#score-note").fill(note);
    await page.getByRole("button", { name: "提交前确认" }).click();
    const confirmModal = dialog(page, "确认提交记分");
    await expect(confirmModal).toBeVisible();
    await expect(confirmModal.getByText("学生名单")).toBeVisible();
    await expect(confirmModal.getByText(student.name, { exact: false })).toBeVisible();
    await expect(confirmModal.getByText("记分规则")).toBeVisible();
    await expect(confirmModal.getByText("主动帮助同学（加分 2 分）").first()).toBeVisible();
    await expect(confirmModal.getByText("+2 分 / 人").first()).toBeVisible();
    await expect(confirmModal.getByText(note)).toBeVisible();
    await confirmModal.getByRole("button", { name: "确认提交" }).click();
    await expect(toast(page, "记分已提交")).toBeVisible();
    await expect(page.getByRole("heading", { name: "记分已提交" })).toBeVisible();
    await expect(page.getByText("已直接生效", { exact: false })).toBeVisible();

    // 进入积分记录页验证记录存在
    await page.getByRole("button", { name: "查看积分记录" }).click();
    await expect(page.locator(".page-title").first()).toHaveText("积分记录");
    await page.getByRole("textbox", { name: "关键词搜索" }).fill(note.slice(0, 12));
    const row = page
      .locator("table.table tbody tr")
      .filter({ hasText: "主动帮助同学" })
      .filter({ hasText: student.name });
    await expect(row.first()).toBeVisible();
    await expect(row.first().getByText("已生效")).toBeVisible();
    await row.first().getByRole("button", { name: "详情" }).click();
    const detail = dialog(page, "规则快照");
    await expect(detail).toBeVisible();
    await expect(detail.getByText("记分说明")).toBeVisible();
    await expect(detail.getByText(note)).toBeVisible();
    await expect(detail.getByText("已生效").first()).toBeVisible();
  });

  test("批量记分：二次确认弹窗展示学生名单与每人分值，提交后提示批量条数", async ({ page, request }) => {
    test.setTimeout(60000);
    const { students } = await loadTeacher1ClassAndStudents(request);
    const picked = students.slice(0, 2);
    const note = `浏览器批量记分测试：课堂积极发言-${Date.now()}`;

    await loginViaUi(page, "teacher1");
    await desktopNav(page, "快捷记分", "快捷记分");
    await page
      .getByRole("combobox", { name: "按班级筛选学生" })
      .selectOption({ label: "1班（七年级）" });
    await expect(page.getByRole("checkbox")).toHaveCount(students.length);
    await page.getByRole("checkbox").nth(0).check();
    await page.getByRole("checkbox").nth(1).check();
    await expect(page.locator(".badge").filter({ hasText: "已选 2 人" })).toBeVisible();
    await page.getByRole("button", { name: "下一步：选择规则" }).click();
    await page.locator("label.list-item").filter({ hasText: "主动帮助同学" }).click();
    await page.getByRole("button", { name: "下一步：填写说明" }).click();
    await page.locator("#score-note").fill(note);
    await page.getByRole("button", { name: "提交前确认" }).click();
    const confirmModal = dialog(page, "确认提交记分");
    await expect(confirmModal.getByText("2 人 · 批量事务")).toBeVisible();
    for (const student of picked) {
      await expect(confirmModal.getByText(student.name, { exact: false })).toBeVisible();
    }
    await expect(confirmModal.getByText("+2 分 / 人").first()).toBeVisible();
    await expect(confirmModal.getByText("每人一条记录，共 2 条")).toBeVisible();
    await expect(confirmModal.getByText("批量事务", { exact: false }).first()).toBeVisible();
    await confirmModal.getByRole("button", { name: "确认提交" }).click();
    await expect(toast(page, "已提交 2 条记分记录")).toBeVisible();
    await expect(page.getByText("已批量提交 2 条记录")).toBeVisible();
  });
});

test.describe("学生干部申报", () => {
  test("公开链接提交申报 → 教师通过审核 → 积分记录来源=学生干部申报；驳回必须填理由", async ({
    page,
    request,
  }) => {
    test.setTimeout(90000);
    const { students } = await loadTeacher1ClassAndStudents(request);
    const student = students[0];
    const description = `浏览器测试：课间主动帮助同学搬运图书并整理书架-${Date.now()}`;

    // 1) 公共申报页（未登录）
    await page.goto(`/#/submit/${SUBMIT_TOKEN}`);
    await expect(page.getByRole("heading", { name: "学生干部表现申报" })).toBeVisible();
    await page.locator("#submit-student-no").fill(student.studentNo);
    await page.locator("#submit-student-name").fill(student.name);
    const categorySelect = page.locator("#submit-category");
    const categoryValue = await categorySelect
      .locator("option", { hasText: "日常行为规范" })
      .first()
      .getAttribute("value");
    await categorySelect.selectOption(categoryValue);
    await page.locator("#submit-description").fill(description);
    await page.getByRole("button", { name: "提交申报" }).click();
    await expect(
      page.getByRole("heading", { name: "已提交，等待老师核实" }),
    ).toBeVisible();
    await expect(page.getByText("待老师核实").first()).toBeVisible();
    await expect(page.getByText("不会直接改变积分", { exact: false })).toBeVisible();

    // 2) 教师核实通过（UI）
    await loginViaUi(page, "teacher1");
    await desktopNav(page, "待核实申报", "待核实申报");
    const queueRow = page.locator("table.table tbody tr").filter({ hasText: description });
    await expect(queueRow.first()).toBeVisible();
    await expect(queueRow.first().getByText("待核实")).toBeVisible();
    await queueRow.first().getByRole("button", { name: "详情" }).click();
    const detail = dialog(page, "申报详情");
    await expect(detail).toBeVisible();
    await expect(detail.getByText("学生干部申报", { exact: false })).toBeVisible();
    await detail.getByRole("button", { name: "通过并生成积分" }).click();
    const approveModal = dialog(page, "通过申报并生成积分");
    await expect(approveModal).toBeVisible();
    const ruleSelect = approveModal.locator("select");
    const ruleValue = await ruleSelect
      .locator("option", { hasText: "主动帮助同学" })
      .first()
      .getAttribute("value");
    await ruleSelect.selectOption(ruleValue);
    await approveModal.getByRole("button", { name: "下一步：确认生成" }).click();
    const approveConfirm = dialog(page, "确认通过该申报？");
    await expect(approveConfirm).toBeVisible();
    await approveConfirm.getByRole("button", { name: "确认通过" }).click();
    await expect(toast(page, "申报已通过，已生成积分记录")).toBeVisible();
    await expect(detail.getByText("已通过并生成积分记录")).toBeVisible();
    await closeModal(detail);

    // 3) 积分记录页出现来源=学生干部申报的记录
    await desktopNav(page, "积分记录", "积分记录");
    await page.getByRole("textbox", { name: "关键词搜索" }).fill(student.name);
    const recordRow = page
      .locator("table.table tbody tr")
      .filter({ hasText: "学生干部申报" })
      .filter({ hasText: "主动帮助同学" })
      .first();
    await expect(recordRow).toBeVisible();
    await expect(recordRow.getByText("已生效")).toBeVisible();

    // 4) 驳回路径必须填写理由：教师打开另一条待核实申报的驳回弹窗，空理由被阻止
    await desktopNav(page, "待核实申报", "待核实申报");
    const anyRow = page
      .locator("table.table tbody tr")
      .filter({ hasText: "待核实" })
      .first();
    if ((await anyRow.count()) > 0) {
      await anyRow.getByRole("button", { name: "详情" }).click();
      const rejectDetail = dialog(page, "申报详情");
      await rejectDetail.getByRole("button", { name: "驳回" }).click();
      const rejectModal = dialog(page, "驳回申报");
      await expect(rejectModal).toBeVisible();
      // 非法路径：驳回原因必填，空理由停留在弹窗并提示
      await rejectModal.getByRole("button", { name: "下一步：确认驳回" }).click();
      await expect(
        rejectModal.getByText("请填写至少 2 个字的原因", { exact: false }),
      ).toBeVisible();
      await expect(dialog(page, "确认驳回该申报？")).toHaveCount(0);
      // 填写理由后可二次确认驳回
      await rejectModal
        .locator("textarea")
        .first()
        .fill("浏览器测试：该事迹与事实不符，未提供可核实信息");
      await rejectModal.getByRole("button", { name: "下一步：确认驳回" }).click();
      const rejectConfirm = dialog(page, "确认驳回该申报？");
      await expect(rejectConfirm).toBeVisible();
      await rejectConfirm.getByRole("button", { name: "确认驳回" }).click();
      await expect(toast(page, "申报已驳回")).toBeVisible();
      await closeModal(rejectDetail);
    }
  });
});

test.describe("申诉登记与裁决", () => {
  test("教师登记申诉 → 德育处受理并裁决（接受→冲正/更正）；无理由被阻止", async ({ page, request }) => {
    test.setTimeout(90000);
    const { note, student } = await createTeacher2Record(request);

    // 1) teacher2 在 UI 登记申诉
    await loginViaUi(page, "teacher2");
    await desktopNav(page, "申诉中心", "申诉中心");
    await page.getByRole("button", { name: "登记申诉" }).click();
    const registerModal = dialog(page, "登记申诉");
    await expect(registerModal).toBeVisible();
    await registerModal
      .locator("select")
      .first()
      .selectOption({ label: "八年级 · 1班" });
    const recordLabel = registerModal
      .locator("label.list-item")
      .filter({ hasText: note });
    await expect(recordLabel).toBeVisible();
    await recordLabel.click();
    await registerModal
      .locator("textarea")
      .first()
      .fill("浏览器申诉测试：当天学生参加校运会方阵训练，迟到已提前请假，希望复核。");
    await registerModal.getByRole("button", { name: "提交申诉" }).click();
    await expect(toast(page, "申诉已登记，等待德育处受理")).toBeVisible();
    const registeredDetail = dialog(page, "申诉详情");
    await expect(registeredDetail).toBeVisible();
    await closeModal(registeredDetail);
    await logoutViaUi(page);

    // 2) 德育处受理并裁决
    await loginViaUi(page, "moral");
    await desktopNav(page, "申诉中心", "申诉中心");
    const appealRow = page
      .locator("table.table tbody tr")
      .filter({ hasText: "浏览器申诉测试" })
      .first();
    await expect(appealRow).toBeVisible();
    await appealRow.getByRole("button", { name: "详情" }).click();
    const detail = dialog(page, "申诉详情");
    await expect(detail).toBeVisible();
    await detail.getByRole("button", { name: "受理申诉" }).click();
    await expect(toast(page, "申诉已受理，进入处理中")).toBeVisible();
    await detail.getByRole("button", { name: "裁决" }).click();
    const decideModal = dialog(page, "裁决申诉");
    await expect(decideModal).toBeVisible();

    // 非法路径：不填理由直接下一步被阻止
    await expect(decideModal.getByText("接受申诉（ACCEPTED）", { exact: false })).toBeVisible();
    await decideModal.getByRole("button", { name: "下一步：确认裁决" }).click();
    await expect(
      decideModal.getByText("请填写至少 2 个字的裁决理由"),
    ).toBeVisible();

    // 接受申诉：选择更正规则（REPLACE），填写理由，二次确认
    await decideModal.getByText("更正为新规则/分值（REPLACE）", { exact: false }).click();
    await decideModal
      .locator("textarea")
      .first()
      .fill("浏览器测试裁决：经核实，原记录情况属实，接受申诉并更正说明");
    const correctionRuleSelect = decideModal.locator("select").first();
    const correctionRuleValue = await correctionRuleSelect
      .locator("option", { hasText: "主动帮助同学" })
      .first()
      .getAttribute("value");
    await correctionRuleSelect.selectOption(correctionRuleValue);
    await decideModal.getByRole("button", { name: "下一步：确认裁决" }).click();
    const decideConfirm = dialog(page, "确认接受该申诉？");
    await expect(decideConfirm).toBeVisible();
    await decideConfirm.getByRole("button", { name: "确认提交裁决" }).click();
    await expect(toast(page, "申诉已接受，已生成冲正/更正记录")).toBeVisible();

    // 裁决后详情出现冲正/更正记录
    await expect(detail.getByText("申诉已接受，账本已处理")).toBeVisible();
    await expect(detail.getByText("冲正记录：", { exact: false })).toBeVisible();
    await expect(detail.getByText("更正记录：", { exact: false })).toBeVisible();
    await expect(detail.getByText(student.name, { exact: false }).first()).toBeVisible();
  });
});

test.describe("账本不可篡改", () => {
  test("记录详情只提供冲正（无编辑/删除）；无理由冲正被阻止；冲正后显示关联记录", async ({
    page,
    request,
  }) => {
    test.setTimeout(60000);
    // 用真实 API 造一条待冲正记录（教师录入）
    const { class71, students } = await loadTeacher1ClassAndStudents(request);
    const rulesResponse = await request.get("/api/rules", { params: { search: "主动帮助同学" } });
    const rule = (await rulesResponse.json()).items.find((item) => item.name === "主动帮助同学");
    expect(rule).toBeTruthy();
    const note = `浏览器冲正测试记录-${Date.now()}`;
    const scored = await request.post("/api/scoring", {
      data: { ruleId: rule.id, studentId: students[0].id, note },
    });
    expect(scored.ok()).toBeTruthy();
    const recordId = (await scored.json()).record.id;

    // 直接修改/删除账本 API 不存在
    const patched = await request.patch(`/api/records/${recordId}`, { data: { points: 99 } });
    expect([404, 405]).toContain(patched.status());
    const deleted = await request.delete(`/api/records/${recordId}`);
    expect([404, 405]).toContain(deleted.status());

    // 德育处在 UI 中只能通过「冲正」处理
    await loginViaUi(page, "moral");
    await desktopNav(page, "积分记录", "积分记录");
    await page.getByRole("textbox", { name: "关键词搜索" }).fill(note);
    const row = page.locator("table.table tbody tr").filter({ hasText: "主动帮助同学" }).first();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "详情" }).click();
    const detail = dialog(page, "规则快照");
    await expect(detail.getByRole("button", { name: "冲正" })).toBeVisible();
    await expect(detail.getByRole("button", { name: "编辑" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "删除" })).toHaveCount(0);
    await detail.getByRole("button", { name: "冲正" }).click();
    const revokeModal = dialog(page, "冲正该积分记录");
    await expect(revokeModal).toBeVisible();
    await revokeModal.getByRole("button", { name: "确认冲正" }).click();
    await expect(
      revokeModal.getByText("请填写冲正理由（会写入审计日志）"),
    ).toBeVisible();
    await revokeModal.locator("textarea").first().fill("浏览器测试：原记录信息有误，冲正");
    await revokeModal.getByRole("button", { name: "确认冲正" }).click();
    await expect(toast(page, "已生成冲正记录")).toBeVisible();
    await expect(detail.getByText("该记录已被冲正", { exact: false })).toBeVisible();
    await expect(detail.getByText("被冲正记录")).toBeVisible();
  });
});

test.describe("家长分享", () => {
  test("公共分享链接无登录可打开且不泄露他人；撤销后显示无效提示", async ({ page, request }) => {
    test.setTimeout(60000);
    // 未登录直接打开演示分享链接
    await page.goto(`/#/share/${SHARE_TOKEN}`);
    const studentName = (await page.locator(".report-student-name").textContent())?.trim() || "";
    expect(studentName.length).toBeGreaterThan(0);
    await expect(page.getByText("当前总分", { exact: false })).toBeVisible();
    await expect(
      page.getByText("不展示班级排名与其他学生信息", { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "打印 / 另存 PDF" })).toBeVisible();

    // 页面不出现其他学生姓名（用真实 API 取同班名单比对）
    const { students } = await loadTeacher1ClassAndStudents(request);
    const others = students.filter((item) => item.name !== studentName).map((item) => item.name);
    const bodyText = await page.locator("body").innerText();
    for (const name of others.slice(0, 20)) {
      expect(bodyText, `分享页不应出现其他学生姓名 ${name}`).not.toContain(name);
    }
    expect(bodyText).not.toMatch(/班级排名\s*[：:]/);
    expect(bodyText).not.toContain("名次");

    // 新建分享 → 可访问 → 撤销 → 无效
    await apiLogin(request, "moral");
    const created = await request.post("/api/shares", {
      data: { studentId: students[0].id, expiresInDays: 3, label: "浏览器测试家长分享" },
    });
    expect(created.status()).toBe(201);
    const share = (await created.json()).share;
    await page.goto(`/#/share/${share.token}`);
    await expect(page.locator(".report-student-name")).toBeVisible();
    await expect(page.locator(".report-student-name")).toHaveText(students[0].name);

    const revoked = await request.post(`/api/shares/${share.id}/revoke`);
    expect(revoked.ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByText("分享链接无效或已过期").first()).toBeVisible();

    // 已撤销的演示 token 同样无效
    await page.goto("/#/share/revoked-demo-share-token");
    await expect(page.getByText("分享链接无效或已过期").first()).toBeVisible();
  });
});

test.describe("移动端 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("登录/总览/快捷记分/积分记录无整页横向溢出，底部导航可见，记分流程可完成", async ({
    page,
    request,
  }) => {
    test.setTimeout(90000);
    const { students } = await loadTeacher1ClassAndStudents(request);
    const note = `移动端记分测试：主动帮助同学整理教室-${Date.now()}`;

    await gotoLogin(page);
    await expectNoHorizontalOverflow(page, "登录页");
    await loginViaUi(page, "teacher1");
    await expectNoHorizontalOverflow(page, "总览");

    const bottomNav = page.getByRole("navigation", { name: "底部导航" });
    await expect(bottomNav).toBeVisible();
    await expect(bottomNav.getByRole("button", { name: "总览" })).toBeVisible();
    await expect(bottomNav.getByRole("button", { name: "记分" })).toBeVisible();
    await expect(bottomNav.getByRole("button", { name: "记录" })).toBeVisible();
    await expect(bottomNav.getByRole("button", { name: "更多" })).toBeVisible();

    // 快捷记分：手机上完成一次记分
    await mobileNav(page, "记分");
    await expect(page.locator(".page-title").first()).toHaveText("快捷记分");
    await expectNoHorizontalOverflow(page, "快捷记分-选择学生");
    await page.getByRole("textbox", { name: "搜索学生姓名或学号" }).fill(students[0].name);
    await expect(page.getByRole("checkbox")).toHaveCount(1);
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "下一步：选择规则" }).click();
    await expectNoHorizontalOverflow(page, "快捷记分-选择规则");
    await page.locator("label.list-item").filter({ hasText: "主动帮助同学" }).click();
    await page.getByRole("button", { name: "下一步：填写说明" }).click();
    await expectNoHorizontalOverflow(page, "快捷记分-填写说明");
    await page.locator("#score-note").fill(note);
    await page.getByRole("button", { name: "提交前确认" }).click();
    const confirmModal = dialog(page, "确认提交记分");
    await expect(confirmModal).toBeVisible();
    await confirmModal.getByRole("button", { name: "确认提交" }).click();
    await expect(page.getByRole("heading", { name: "记分已提交" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "快捷记分-成功页");

    // 积分记录页
    await mobileNav(page, "记录");
    await expect(page.locator(".page-title").first()).toHaveText("积分记录");
    await expectNoHorizontalOverflow(page, "积分记录");
    await page.getByRole("textbox", { name: "关键词搜索" }).fill(note.slice(0, 10));
    await expect(
      page.locator(".table-card .record-card").filter({ hasText: "主动帮助同学" }).first(),
    ).toBeVisible();

    // 返回总览
    await mobileNav(page, "总览");
    await expect(page.locator(".page-title").first()).toHaveText("总览仪表盘");
    await expectNoHorizontalOverflow(page, "总览（二次）");
    await expect(bottomNav).toBeVisible();
  });
});
