// Deterministic demo/test fixture: a fictional school ("云杉实验学校") with
// grades, classes, students, staff accounts, published rules, ledger records,
// submissions, appeals, shares and tokens. Synchronous and idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, scryptSync } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEMO_ACCOUNTS = Object.freeze({
  admin: { account: "admin", password: "Admin@MES2026", role: "SYSTEM_ADMIN", displayName: "林校长" },
  moral: { account: "moral", password: "Moral@MES2026", role: "MORAL_AFFAIRS", displayName: "陈德处" },
  teacher1: { account: "teacher1", password: "Teacher@MES2026", role: "DUTY_TEACHER", displayName: "张明" },
  teacher2: { account: "teacher2", password: "Teacher@MES2026", role: "DUTY_TEACHER", displayName: "李静" },
  teacher3: { account: "teacher3", password: "Teacher@MES2026", role: "DUTY_TEACHER", displayName: "王磊" },
});

export const DEMO_TOKENS = Object.freeze({
  share: "demo-parent-share-2026",
  submission: "demo-cadre-link-2026",
});

export const SCHOOL_CODE = "YUNSHAN-DEMO";

const CATEGORY_NAMES = [
  "日常行为规范",
  "课堂纪律",
  "宿舍内务",
  "环境卫生",
  "文明礼仪",
  "社会实践",
  "竞赛荣誉",
  "志愿服务",
  "其他",
];

// 规则定义：direction、分值、是否需要证据、是否需要复核、适用范围
const RULE_DEFS = [
  ["主动帮助同学", "日常行为规范", "ADD", 2, 0, 0, "ALL"],
  ["拾金不昧", "文明礼仪", "ADD", 3, 0, 0, "ALL"],
  ["课堂积极发言", "课堂纪律", "ADD", 1, 0, 0, "ALL"],
  ["校内志愿服务", "志愿服务", "ADD", 2, 0, 0, "ALL"],
  ["社会实践活动", "社会实践", "ADD", 3, 1, 0, "ALL"],
  ["宿舍内务优秀", "宿舍内务", "ADD", 2, 0, 0, "ALL"],
  ["环境卫生示范", "环境卫生", "ADD", 2, 0, 0, "ALL"],
  ["校级竞赛获奖", "竞赛荣誉", "ADD", 10, 1, 1, "ALL"],
  ["区级竞赛获奖", "竞赛荣誉", "ADD", 15, 1, 1, "ALL"],
  ["好人好事突出", "文明礼仪", "ADD", 5, 1, 0, "ALL"],
  ["学习进步显著", "日常行为规范", "ADD", 3, 0, 0, "ALL"],
  ["中考冲刺自律标兵", "日常行为规范", "ADD", 2, 0, 0, "CLASS"],
  ["迟到", "日常行为规范", "DEDUCT", 1, 0, 0, "ALL"],
  ["课堂上扰乱秩序", "课堂纪律", "DEDUCT", 2, 0, 0, "ALL"],
  ["未按要求着装", "文明礼仪", "DEDUCT", 1, 0, 0, "ALL"],
  ["宿舍内务不合格", "宿舍内务", "DEDUCT", 2, 0, 0, "ALL"],
  ["卫生区未打扫", "环境卫生", "DEDUCT", 2, 0, 0, "ALL"],
  ["公共场合追逐打闹", "日常行为规范", "DEDUCT", 2, 0, 0, "ALL"],
  ["损坏公物", "其他", "DEDUCT", 3, 1, 0, "ALL"],
  ["考试违纪", "课堂纪律", "DEDUCT", 5, 0, 1, "ALL"],
];

const SURNAMES = [
  "林", "陈", "张", "李", "王", "黄", "赵", "吴", "周", "徐", "孙", "马",
  "朱", "胡", "郭", "何", "高", "罗", "郑", "梁", "谢", "宋", "唐", "许",
];
const GIVEN = [
  "子涵", "雨桐", "浩然", "思远", "梓萱", "嘉怡", "博文", "欣悦", "宇轩", "晨曦",
  "若彤", "俊杰", "诗涵", "一鸣", "可欣", "天佑", "语嫣", "明轩", "佳琪", "睿泽",
  "梦瑶", "子谦", "静怡", "新宇", "安琪", "皓轩", "雅雯", "铭泽", "紫涵", "泽宇",
];

const ADD_NOTES = [
  "主动整理班级图书角",
  "帮助同学讲解数学题",
  "在升旗仪式上担任护旗手",
  "午休后主动打扫教室卫生",
  "参加校园开放日志愿服务",
  "课堂上积极回答问题并带动讨论",
  "拾到校园卡主动交还失主",
  "担任小组长认真负责",
  "在运动会上为班级争得荣誉",
  "帮助低年级同学搬运物品",
];
const DEDUCT_NOTES = [
  "课间在走廊追逐",
  "早读迟到约 5 分钟",
  "未按学校要求佩戴校徽",
  "值日区域有纸屑未清理",
  "宿舍熄灯后讲话",
  "课堂上有影响他人的小动作",
  "在教室内使用电子产品",
  "午餐排队时插队",
];

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return { hash: scryptSync(password, salt, 64).toString("hex"), salt };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function iso(date) {
  return new Date(date).toISOString();
}

function dayIso(offsetDays) {
  const base = Date.UTC(2026, 8, 1, 8, 0, 0); // 2026-09-01T08:00:00Z
  return new Date(base + offsetDays * 86400000).toISOString();
}

function termDayIso(offsetDays) {
  const base = Date.UTC(2026, 8, 2, 9, 30, 0);
  return new Date(base + offsetDays * 86400000).toISOString();
}

const GUARD_TRIGGERS = [
  "trg_rule_version_no_delete",
  "trg_rule_version_no_content_update",
  "trg_rule_version_status_transition",
  "trg_score_record_update_guard",
  "trg_score_record_delete_guard",
  "trg_appeal_decision_no_update",
  "trg_appeal_decision_no_delete",
  "trg_audit_no_update",
  "trg_audit_no_delete",
];

/** 强制重播演示数据前临时移除不可删触发器；重播后 schema 会重新创建它们。 */
function dropGuardTriggers(db) {
  for (const name of GUARD_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
}

function ensureSchemaTriggers(db) {
  db.exec(fs.readFileSync(path.join(root, "server/schema.sql"), "utf8"));
}

export function seedFixtures(db, { force = false } = {}) {
  const existing = db.prepare("SELECT id FROM schools WHERE code=?").get(SCHOOL_CODE);
  if (existing && !force) return fixtureSummary(db, existing.id);
  if (existing && force) {
    // 触发器会阻止删除已生效账本/已发布规则，重播前临时移除；重播后 schema 会重建。
    dropGuardTriggers(db);
    // 多路径外键（students.grade_id、classes.grade_id、score_records.term_id 等）
    // 使 SQLite 的 ON DELETE CASCADE 顺序不可靠，这里按依赖顺序显式清理。
    const cleanup = [
      "DELETE FROM appeal_decisions WHERE appeal_id IN (SELECT id FROM appeals WHERE school_id=?)",
      "DELETE FROM appeals WHERE school_id=?",
      "DELETE FROM student_submissions WHERE school_id=?",
      "DELETE FROM score_records WHERE school_id=?",
      "DELETE FROM submission_tokens WHERE school_id=?",
      "DELETE FROM import_errors WHERE job_id IN (SELECT id FROM import_jobs WHERE school_id=?)",
      "DELETE FROM import_jobs WHERE school_id=?",
      "DELETE FROM parent_share_access_log WHERE share_id IN (SELECT id FROM parent_shares WHERE school_id=?)",
      "DELETE FROM parent_shares WHERE school_id=?",
      "DELETE FROM evidence_files WHERE school_id=?",
      "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE school_id=?)",
      "DELETE FROM user_scopes WHERE user_id IN (SELECT id FROM users WHERE school_id=?)",
      // backup_jobs.created_by / scoring_rules.created_by / rule_versions 的审核人
      // 都外键引用 users，必须先于 users 删除。
      "DELETE FROM backup_jobs WHERE school_id=? OR school_id IS NULL",
      "DELETE FROM scoring_rule_versions WHERE school_id=?",
      "DELETE FROM scoring_rules WHERE school_id=?",
      "DELETE FROM users WHERE school_id=?",
      "DELETE FROM students WHERE school_id=?",
      "DELETE FROM classes WHERE school_id=?",
      "DELETE FROM teachers WHERE school_id=?",
      "DELETE FROM grades WHERE school_id=?",
      "DELETE FROM terms WHERE school_id=?",
      "DELETE FROM academic_years WHERE school_id=?",
      "DELETE FROM scoring_categories WHERE school_id=?",
      "DELETE FROM honor_rules WHERE school_id=?",
      "DELETE FROM reward_items WHERE school_id=?",
      "DELETE FROM system_settings WHERE school_id=?",
      "DELETE FROM audit_logs WHERE school_id=? OR school_id IS NULL",
      "DELETE FROM schools WHERE id=?",
    ];
    db.exec("BEGIN");
    try {
      for (const sql of cleanup) db.prepare(sql).run(existing.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    ensureSchemaTriggers(db);
  } else {
    ensureSchemaTriggers(db);
  }

  const rng = lcg(20261031);
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const randInt = (min, max) => min + Math.floor(rng() * (max - min + 1));
  const now = iso("2026-10-31T00:00:00Z");

  const schoolId = "11111111-1111-4111-8111-111111111111";
  db.prepare(
    "INSERT INTO schools(id,name,code,stage,address,contact,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(
    schoolId,
    "云杉实验学校（演示）",
    SCHOOL_CODE,
    "初中",
    "演示市青松区云杉路 1 号",
    "德育处 0000-00000000",
    now,
  );

  // ---- 学年与学期
  const year2026 = "22222222-2222-4222-8222-222222222201";
  const year2025 = "22222222-2222-4222-8222-222222222202";
  const term2026a = "22222222-2222-4222-8222-222222222211";
  const term2025a = "22222222-2222-4222-8222-222222222212";
  const term2025b = "22222222-2222-4222-8222-222222222213";
  db.prepare(
    "INSERT INTO academic_years(id,school_id,name,start_date,end_date,is_current,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(year2026, schoolId, "2026-2027 学年", "2026-09-01", "2027-07-10", 1, now);
  db.prepare(
    "INSERT INTO academic_years(id,school_id,name,start_date,end_date,is_current,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(year2025, schoolId, "2025-2026 学年", "2025-09-01", "2026-07-10", 0, now);
  const insertTerm = db.prepare(
    "INSERT INTO terms(id,school_id,academic_year_id,name,start_date,end_date,is_current,created_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  insertTerm.run(term2026a, schoolId, year2026, "2026 秋季学期", "2026-09-01", "2027-01-20", 1, now);
  insertTerm.run(term2025a, schoolId, year2025, "2025 秋季学期", "2025-09-01", "2026-01-20", 0, now);
  insertTerm.run(term2025b, schoolId, year2025, "2026 春季学期", "2026-02-20", "2026-07-08", 0, now);

  // ---- 年级、班级
  const gradeDefs = [
    ["七年级", 1],
    ["八年级", 2],
    ["九年级", 3],
  ];
  const gradeIds = {};
  const insertGrade = db.prepare(
    "INSERT INTO grades(id,school_id,name,sort_order,created_at) VALUES(?,?,?,?,?)",
  );
  for (const [name, order] of gradeDefs) {
    const id = `33333333-3333-4333-8333-33333333330${order}`;
    gradeIds[name] = id;
    insertGrade.run(id, schoolId, name, order, now);
  }

  // ---- 教师
  const teacherDefs = [
    ["张明", "T001", "数学", "13800000001"],
    ["李静", "T002", "语文", "13800000002"],
    ["王磊", "T003", "英语", "13800000003"],
    ["陈晓", "T004", "体育", "13800000004"],
    ["赵敏", "T005", "音乐", "13800000005"],
    ["周涛", "T006", "物理", "13800000006"],
    ["孙芳", "T007", "历史", "13800000007"],
    ["吴强", "T008", "信息技术", "13800000008"],
  ];
  const teacherIds = {};
  const insertTeacher = db.prepare(
    "INSERT INTO teachers(id,school_id,name,employee_no,subject,phone,status,created_at) VALUES(?,?,?,?,?,?,'ACTIVE',?)",
  );
  teacherDefs.forEach(([name, employeeNo, subject, phone], index) => {
    const id = `44444444-4444-4444-8444-44444444440${index + 1}`;
    teacherIds[employeeNo] = id;
    insertTeacher.run(id, schoolId, name, employeeNo, subject, phone, now);
  });

  const classDefs = [
    ["七年级", "1班", teacherIds.T001],
    ["七年级", "2班", teacherIds.T004],
    ["八年级", "1班", teacherIds.T002],
    ["八年级", "2班", teacherIds.T006],
    ["九年级", "1班", teacherIds.T003],
  ];
  const classIds = {};
  const insertClass = db.prepare(
    "INSERT INTO classes(id,school_id,grade_id,name,head_teacher_id,sort_order,created_at) VALUES(?,?,?,?,?,?,?)",
  );
  classDefs.forEach(([gradeName, className, headTeacherId], index) => {
    const id = `55555555-5555-4555-8555-55555555550${index + 1}`;
    classIds[`${gradeName}${className}`] = id;
    insertClass.run(id, schoolId, gradeIds[gradeName], className, headTeacherId, index + 1, now);
  });

  // ---- 学生
  const classSizes = {
    "七年级1班": 18,
    "七年级2班": 16,
    "八年级1班": 17,
    "八年级2班": 15,
    "九年级1班": 14,
  };
  const studentIds = [];
  const students = [];
  const insertStudent = db.prepare(
    "INSERT INTO students(id,school_id,grade_id,class_id,student_no,name,gender,status,joined_at,created_at) VALUES(?,?,?,?,?,?,?,'ACTIVE',?,?)",
  );
  let nameCursor = 0;
  for (const [className, size] of Object.entries(classSizes)) {
    const gradeName = className.slice(0, 3);
    const classNumber = Number(className.match(/（?\d班/)?.[0]?.replace("班", "") || "1");
    for (let index = 0; index < size; index += 1) {
      const studentNo = `26${gradeIds[gradeName].slice(-1)}${classNumber}${String(index + 1).padStart(2, "0")}`;
      const name = `${SURNAMES[nameCursor % SURNAMES.length]}${GIVEN[nameCursor % GIVEN.length]}`;
      nameCursor += 1;
      const id = `66666666-6666-4666-8666-${String(studentIds.length + 1).padStart(12, "0")}`;
      const gender = rng() > 0.5 ? "男" : "女";
      insertStudent.run(id, schoolId, gradeIds[gradeName], classIds[className], studentNo, name, gender, "2026-09-01", now);
      studentIds.push(id);
      students.push({ id, name, studentNo, classId: classIds[className], className, gradeName });
    }
  }

  // ---- 账号
  const userIds = {};
  const insertUser = db.prepare(
    "INSERT INTO users(id,school_id,account,display_name,role,password_hash,salt,teacher_id,status,must_change_password,created_at) VALUES(?,?,?,?,?,?,?,?,'ACTIVE',0,?)",
  );
  const accountTeacher = { admin: null, moral: null, teacher1: "T001", teacher2: "T002", teacher3: "T003" };
  let accountIndex = 0;
  for (const [key, definition] of Object.entries(DEMO_ACCOUNTS)) {
    accountIndex += 1;
    const id = `77777777-7777-4777-8777-${String(accountIndex).padStart(12, "0")}`;
    userIds[key] = id;
    const { hash, salt } = hashPassword(definition.password);
    insertUser.run(
      id,
      schoolId,
      definition.account,
      definition.displayName,
      definition.role,
      hash,
      salt,
      accountTeacher[key] ? teacherIds[accountTeacher[key]] : null,
      now,
    );
  }

  const scopeRows = [
    [userIds.teacher1, "CLASS", classIds["七年级1班"]],
    [userIds.teacher1, "CLASS", classIds["七年级2班"]],
    [userIds.teacher2, "CLASS", classIds["八年级1班"]],
    [userIds.teacher2, "CLASS", classIds["八年级2班"]],
    [userIds.teacher3, "CLASS", classIds["九年级1班"]],
  ];
  const insertScope = db.prepare(
    "INSERT INTO user_scopes(id,user_id,scope_type,scope_id,created_at) VALUES(?,?,?,?,?)",
  );
  let scopeIndex = 0;
  for (const [userId, scopeType, scopeId] of scopeRows) {
    scopeIndex += 1;
    insertScope.run(`88888888-8888-4888-8888-${String(scopeIndex).padStart(12, "0")}`, userId, scopeType, scopeId, now);
  }

  // ---- 指标分类
  const categoryIds = {};
  const insertCategory = db.prepare(
    "INSERT INTO scoring_categories(id,school_id,name,description,direction_scope,sort_order,is_enabled,created_at) VALUES(?,?,?,?,'BOTH',?,1,?)",
  );
  CATEGORY_NAMES.forEach((name, index) => {
    const id = `99999999-9999-4999-8999-${String(index + 1).padStart(12, "0")}`;
    categoryIds[name] = id;
    insertCategory.run(
      id,
      schoolId,
      name,
      `${name}相关的德育表现与日常行为`,
      index + 1,
      now,
    );
  });

  // ---- 规则与已发布版本
  const insertRule = db.prepare(
    "INSERT INTO scoring_rules(id,school_id,active_version_id,latest_version,archived_at,created_by,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?,?)",
  );
  const insertVersion = db.prepare(
    `INSERT INTO scoring_rule_versions(id,rule_id,school_id,version,status,category_id,name,description,examples,direction,points,min_points,max_points,target_scope,scope_json,evidence_required,requires_review,change_note,created_by,created_at,submitted_by,submitted_at,approved_by,approved_at,published_at,effective_from,effective_to)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const rules = [];
  RULE_DEFS.forEach(([name, categoryName, direction, points, evidenceRequired, requiresReview, targetScope], index) => {
    const ruleId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`;
    const versionId = `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 1).padStart(12, "0")}`;
    const scopeJson =
      targetScope === "CLASS" ? [classIds["九年级1班"]] : [];
    insertRule.run(ruleId, schoolId, versionId, 1, userIds.admin, now, now);
    insertVersion.run(
      versionId,
      ruleId,
      schoolId,
      1,
      "PUBLISHED",
      categoryIds[categoryName],
      name,
      `${categoryName}类${direction === "ADD" ? "加分" : "减分"}规则：${name}。`,
      `示例：${direction === "ADD" ? "学生表现积极，经教师核实后登记加分。" : "学生行为违反规范，经教师核实后登记减分。"}`,
      direction,
      points,
      targetScope,
      JSON.stringify(scopeJson),
      evidenceRequired,
      requiresReview,
      "初始发布",
      userIds.admin,
      now,
      userIds.admin,
      now,
      userIds.moral,
      now,
      now,
      "2026-09-01T00:00:00.000Z",
      null,
    );
    rules.push({
      id: ruleId,
      versionId,
      name,
      categoryId: categoryIds[categoryName],
      categoryName,
      direction,
      points,
      evidenceRequired,
      requiresReview,
      targetScope,
    });
  });

  // 草稿与已提交规则，用于展示版本生命周期
  const draftRuleId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa101";
  const draftVersionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb101";
  insertRule.run(draftRuleId, schoolId, null, 1, userIds.admin, now, now);
  insertVersion.run(
    draftVersionId,
    draftRuleId,
    schoolId,
    1,
    "DRAFT",
    categoryIds["志愿服务"],
    "校园拾光志愿服务",
    "参与校园文化讲解、图书整理等长期志愿服务，每次服务不少于 30 分钟。",
    "示例：担任校园讲解员并完成一次正式讲解。",
    "ADD",
    3,
    "ALL",
    JSON.stringify([]),
    0,
    0,
    "草稿：等待德育处审核",
    userIds.admin,
    now,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  );

  const submittedRuleId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa102";
  const submittedVersionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb102";
  insertRule.run(submittedRuleId, schoolId, null, 1, userIds.moral, now, now);
  insertVersion.run(
    submittedVersionId,
    submittedRuleId,
    schoolId,
    1,
    "SUBMITTED",
    categoryIds["文明礼仪"],
    "文明就餐监督岗",
    "担任食堂文明就餐监督岗，提醒同学有序排队、光盘行动。",
    "示例：连续一周参与午餐监督岗并记录反馈。",
    "ADD",
    2,
    "ALL",
    JSON.stringify([]),
    0,
    0,
    "提交审核：新增文明就餐监督岗",
    userIds.moral,
    now,
    userIds.moral,
    now,
    null,
    null,
    null,
    null,
    null,
  );

  // ---- 系统参数、荣誉、兑换
  const insertSetting = db.prepare(
    "INSERT INTO system_settings(school_id,key,value,updated_at) VALUES(?,?,?,?)",
  );
  // review_threshold 默认 10：>=10 分的记录进入德育处复核队列。
  for (const [key, value] of [
    ["initial_points", "100"],
    ["allow_negative", "0"],
    ["review_threshold", "10"],
  ])
    insertSetting.run(schoolId, key, value, now);

  const insertHonor = db.prepare(
    "INSERT INTO honor_rules(id,school_id,name,description,min_points,min_positive_records,is_enabled,sort_order,created_at) VALUES(?,?,?,?,?,?,1,?,?)",
  );
  insertHonor.run(
    "cccccccc-cccc-4ccc-8ccc-cccccccccc01",
    schoolId,
    "德育之星",
    "本学期德育积分达到 130 分，且在文明礼仪与志愿服务方面有突出表现。",
    130,
    3,
    1,
    now,
  );
  insertHonor.run(
    "cccccccc-cccc-4ccc-8ccc-cccccccccc02",
    schoolId,
    "进步之星",
    "本学期累计获得 5 次以上正向记录，持续进步。",
    110,
    5,
    2,
    now,
  );
  insertHonor.run(
    "cccccccc-cccc-4ccc-8ccc-cccccccccc03",
    schoolId,
    "志愿服务标兵",
    "本学期参与志愿服务不少于 4 次。",
    100,
    3,
    3,
    now,
  );
  const insertReward = db.prepare(
    "INSERT INTO reward_items(id,school_id,name,description,points_cost,is_enabled,sort_order,created_at) VALUES(?,?,?,?,?,1,?,?)",
  );
  insertReward.run("dddddddd-dddd-4ddd-8ddd-dddddddddd01", schoolId, "校园文创礼包", "学校文创礼包一份，由德育处线下发放。", 50, 1, now);
  insertReward.run("dddddddd-dddd-4ddd-8ddd-dddddddddd02", schoolId, "免作业券", "任选一天免做一次常规作业（需任课教师确认）。", 30, 2, now);
  insertReward.run("dddddddd-dddd-4ddd-8ddd-dddddddddd03", schoolId, "图书借阅优先", "新学期图书借阅优先选择权。", 20, 3, now);

  // ---- 积分账本
  const insertRecord = db.prepare(
    `INSERT INTO score_records(
       id,school_id,academic_year_id,term_id,student_id,class_id,grade_id,
       rule_id,rule_version_id,rule_snapshot_json,category_id,category_name,
       direction,points,signed_points,record_kind,status,occurrence_at,note,evidence_json,
       source,submitter_id,reviewer_id,reviewed_at,review_note,submission_id,
       reverses_record_id,corrects_record_id,batch_id,created_at,effective_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const allAddRules = rules.filter((rule) => rule.direction === "ADD");
  const addRules = allAddRules.filter((rule) => !rule.requiresReview);
  const deductRules = rules.filter((rule) => rule.direction === "DEDUCT" && !rule.requiresReview);
  const classTeacherUser = {
    "七年级1班": userIds.teacher1,
    "七年级2班": userIds.teacher1,
    "八年级1班": userIds.teacher2,
    "八年级2班": userIds.teacher2,
    "九年级1班": userIds.teacher3,
  };
  const records = [];
  let recordCounter = 0;
  const newId = () => {
    recordCounter += 1;
    return `eeeeeeee-eeee-4eee-8eee-${String(recordCounter).padStart(12, "0")}`;
  };
  for (const student of students) {
    const applicableRules = addRules.filter(
      (rule) => rule.targetScope === "ALL" || (rule.targetScope === "CLASS" && rule.categoryName === "日常行为规范" && student.gradeName === "九年级"),
    );
    const count = randInt(3, 7);
    for (let index = 0; index < count; index += 1) {
      const isAdd = rng() < 0.72;
      const rule = isAdd ? pick(applicableRules) : pick(deductRules);
      const occurrenceAt = termDayIso(randInt(0, 56));
      const note = isAdd ? pick(ADD_NOTES) : pick(DEDUCT_NOTES);
      const submitter = classTeacherUser[student.className] || userIds.teacher1;
      const pendingReview = Boolean(rule.requiresReview);
      const status = pendingReview ? "PENDING_REVIEW" : "EFFECTIVE";
      const id = newId();
      insertRecord.run(
        id,
        schoolId,
        year2026,
        term2026a,
        student.id,
        student.classId,
        gradeIds[student.gradeName],
        rule.id,
        rule.versionId,
        JSON.stringify({
          name: rule.name,
          categoryId: rule.categoryId,
          categoryName: rule.categoryName,
          direction: rule.direction,
          points: rule.points,
          version: 1,
          description: `${rule.categoryName}类规则`,
          examples: "",
        }),
        rule.categoryId,
        rule.categoryName,
        rule.direction,
        rule.points,
        rule.direction === "ADD" ? rule.points : -rule.points,
        "STANDARD",
        status,
        occurrenceAt,
        note,
        "[]",
        "TEACHER",
        submitter,
        pendingReview ? null : submitter,
        pendingReview ? null : occurrenceAt,
        "",
        null,
        null,
        null,
        null,
        occurrenceAt,
        pendingReview ? null : occurrenceAt,
      );
      records.push({
        id,
        student,
        rule,
        direction: rule.direction,
        points: rule.points,
        status,
        occurrenceAt,
        submitter,
      });
    }
  }

  // 复核队列补充：老师录入的高分记录（>= review_threshold）进入待复核
  for (let index = 0; index < 3; index += 1) {
    const student = students[index * 7 + 2];
    const rule = allAddRules.find((item) => item.points >= 10) || addRules[0];
    const id = newId();
    insertRecord.run(
      id,
      schoolId,
      year2026,
      term2026a,
      student.id,
      student.classId,
      gradeIds[student.gradeName],
      rule.id,
      rule.versionId,
      JSON.stringify({
        name: rule.name,
        categoryId: rule.categoryId,
        categoryName: rule.categoryName,
        direction: rule.direction,
        points: rule.points,
        version: 1,
        description: `${rule.categoryName}类规则`,
        examples: "",
      }),
      rule.categoryId,
      rule.categoryName,
      "ADD",
      rule.points,
      rule.points,
      "STANDARD",
      "PENDING_REVIEW",
      termDayIso(10 + index * 9),
      "校级竞赛获奖，等待德育处复核认定",
      "[]",
      "TEACHER",
      classTeacherUser[student.className],
      null,
      null,
      "",
      null,
      null,
      null,
      null,
      termDayIso(10 + index * 9),
      null,
    );
    records.push({
      id,
      student,
      rule,
      direction: "ADD",
      points: rule.points,
      status: "PENDING_REVIEW",
      occurrenceAt: termDayIso(10 + index * 9),
      submitter: classTeacherUser[student.className],
    });
  }

  // 已驳回示例
  {
    const student = students[5];
    const rule = deductRules[0];
    const id = newId();
    insertRecord.run(
      id,
      schoolId,
      year2026,
      term2026a,
      student.id,
      student.classId,
      gradeIds[student.gradeName],
      rule.id,
      rule.versionId,
      JSON.stringify({ name: rule.name, categoryId: rule.categoryId, categoryName: rule.categoryName, direction: rule.direction, points: rule.points, version: 1, description: "", examples: "" }),
      rule.categoryId,
      rule.categoryName,
      rule.direction,
      rule.points,
      -rule.points,
      "STANDARD",
      "REJECTED",
      termDayIso(20),
      "疑似误记：学生当日请假",
      "[]",
      "TEACHER",
      userIds.teacher1,
      userIds.moral,
      termDayIso(21),
      "经核实学生当日请假，记录不成立",
      null,
      null,
      null,
      null,
      termDayIso(20),
      null,
    );
    records.push({ id, student, rule, direction: rule.direction, points: rule.points, status: "REJECTED", occurrenceAt: termDayIso(20), submitter: userIds.teacher1 });
  }

  // ---- 冲正示例（不可篡改账本）
  const reversalTargets = records.filter((item) => item.status === "EFFECTIVE" && item.student.className === "七年级1班").slice(0, 2);
  for (const target of reversalTargets) {
    const id = newId();
    insertRecord.run(
      id,
      schoolId,
      year2026,
      term2026a,
      target.student.id,
      target.student.classId,
      gradeIds[target.student.gradeName],
      target.rule.id,
      target.rule.versionId,
      JSON.stringify({
        name: target.rule.name,
        categoryId: target.rule.categoryId,
        categoryName: target.rule.categoryName,
        direction: target.rule.direction,
        points: target.rule.points,
        version: 1,
        description: "",
        examples: "",
      }),
      target.rule.categoryId,
      target.rule.categoryName,
      target.direction === "ADD" ? "DEDUCT" : "ADD",
      target.points,
      target.direction === "ADD" ? -target.points : target.points,
      "REVERSAL",
      "EFFECTIVE",
      target.occurrenceAt,
      "原记录信息有误，经德育处核实后冲正",
      "[]",
      "TEACHER",
      userIds.moral,
      userIds.moral,
      now,
      "冲正审批通过",
      null,
      target.id,
      null,
      null,
      now,
      now,
    );
    records.push({ id, student: target.student, rule: target.rule, direction: target.direction === "ADD" ? "DEDUCT" : "ADD", points: target.points, status: "EFFECTIVE", occurrenceAt: target.occurrenceAt, submitter: userIds.moral });
  }

  // ---- 学生干部申报
  const submissionTokenHash = sha256(DEMO_TOKENS.submission);
  const submissionTokenId = "ffffffff-ffff-4fff-8fff-fffffffff001";
  db.prepare(
    "INSERT INTO submission_tokens(id,school_id,class_id,token_hash,label,expires_at,revoked_at,created_by,created_at,last_used_at,use_count) VALUES(?,?,?,?,?,?,NULL,?,?,NULL,0)",
  ).run(
    submissionTokenId,
    schoolId,
    classIds["七年级1班"],
    submissionTokenHash,
    "七年级1班 学生干部申报入口",
    iso("2027-01-10T00:00:00Z"),
    userIds.moral,
    now,
  );

  const class7Students = students.filter((student) => student.className === "七年级1班");
  const insertSubmission = db.prepare(
    `INSERT INTO student_submissions(id,school_id,class_id,student_id,student_no_snapshot,student_name_snapshot,category_id,category_name_snapshot,direction,description,status,source,token_id,submitter_ip,created_at,updated_at,reviewed_by,reviewed_at,review_note,score_record_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const submissionDefs = [
    ["PENDING_REVIEW", "在课间主动帮助同学搬运图书", "ADD", "日常行为规范", 0],
    ["PENDING_REVIEW", "主动清理饮水机旁的积水", "ADD", "环境卫生", 1],
    ["PENDING_REVIEW", "午餐后主动协助食堂整理餐盘", "ADD", "志愿服务", 2],
    ["PENDING_REVIEW", "在课堂上多次提醒同桌保持安静", "ADD", "课堂纪律", 3],
  ];
  submissionDefs.forEach(([status, description, direction, categoryName, studentIndex], index) => {
    const student = class7Students[studentIndex];
    insertSubmission.run(
      `f0f0f0f0-f0f0-4f0f-8f0f-${String(index + 1).padStart(12, "0")}`,
      schoolId,
      classIds["七年级1班"],
      student.id,
      student.studentNo,
      student.name,
      categoryIds[categoryName],
      categoryName,
      direction,
      description,
      status,
      "CADRE_LINK",
      submissionTokenId,
      "127.0.0.1",
      dayIso(30 + index),
      dayIso(30 + index),
      null,
      null,
      "",
      null,
    );
  });

  const approvedStudent = class7Students[5];
  const approvedRule = addRules[0];
  const approvedRecordId = newId();
  insertRecord.run(
    approvedRecordId,
    schoolId,
    year2026,
    term2026a,
    approvedStudent.id,
    approvedStudent.classId,
    gradeIds[approvedStudent.gradeName],
    approvedRule.id,
    approvedRule.versionId,
    JSON.stringify({ name: approvedRule.name, categoryId: approvedRule.categoryId, categoryName: approvedRule.categoryName, direction: "ADD", points: approvedRule.points, version: 1, description: "", examples: "" }),
    approvedRule.categoryId,
    approvedRule.categoryName,
    "ADD",
    approvedRule.points,
    approvedRule.points,
    "STANDARD",
    "EFFECTIVE",
    dayIso(40),
    "学生干部申报：主动整理班级图书角",
    "[]",
    "STUDENT_CADRE",
    userIds.teacher1,
    userIds.teacher1,
    dayIso(41),
    "经核实情况属实，同意加分",
    "f0f0f0f0-f0f0-4f0f-8f0f-000000000101",
    null,
    null,
    null,
    dayIso(41),
    dayIso(41),
  );
  insertSubmission.run(
    "f0f0f0f0-f0f0-4f0f-8f0f-000000000101",
    schoolId,
    classIds["七年级1班"],
    approvedStudent.id,
    approvedStudent.studentNo,
    approvedStudent.name,
    categoryIds["日常行为规范"],
    "日常行为规范",
    "ADD",
    "主动整理班级图书角并坚持一周",
    "APPROVED",
    "CADRE_LINK",
    submissionTokenId,
    "127.0.0.1",
    dayIso(39),
    dayIso(41),
    userIds.teacher1,
    dayIso(41),
    "经核实情况属实，同意加分",
    approvedRecordId,
  );
  insertSubmission.run(
    "f0f0f0f0-f0f0-4f0f-8f0f-000000000102",
    schoolId,
    classIds["七年级1班"],
    class7Students[6].id,
    class7Students[6].studentNo,
    class7Students[6].name,
    categoryIds["文明礼仪"],
    "文明礼仪",
    "ADD",
    "在走廊捡到他人文具并归还",
    "REJECTED",
    "CADRE_LINK",
    submissionTokenId,
    "127.0.0.1",
    dayIso(25),
    dayIso(26),
    userIds.teacher1,
    dayIso(26),
    "该事迹之前已由老师登记，避免重复加分",
    null,
  );

  // ---- 申诉
  const appealRecords = records.filter((item) => item.status === "EFFECTIVE" && item.student.className === "八年级1班").slice(0, 3);
  const appealDefs = [
    {
      status: "SUBMITTED",
      reason: "当天学生参加校运会方阵训练，迟到已提前请假，希望复核。",
      record: appealRecords[0],
    },
    {
      status: "UNDER_REVIEW",
      reason: "该减分记录未附现场说明，申请补充核实。",
      record: appealRecords[1],
    },
    {
      status: "ACCEPTED",
      reason: "课堂上的物品是老师要求准备的学习材料，并非与课堂无关。",
      record: appealRecords[2],
    },
  ];
  const insertAppeal = db.prepare(
    `INSERT INTO appeals(id,school_id,record_id,student_id,class_id,reason,evidence_json,status,submitted_by,handler_id,decided_by,decided_at,decision_reason,conflict_flag,conflict_reason,reversal_record_id,correction_record_id,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertDecision = db.prepare(
    "INSERT INTO appeal_decisions(id,appeal_id,actor_id,decision,reason,conflict_flag,conflict_reason,reversal_record_id,correction_record_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  appealDefs.forEach((definition, index) => {
    const appealId = `a1a1a1a1-a1a1-4a1a-8a1a-${String(index + 1).padStart(12, "0")}`;
    const submittedBy = userIds.teacher2;
    const handlerId = definition.status === "SUBMITTED" ? null : userIds.moral;
    const decidedBy = definition.status === "ACCEPTED" ? userIds.moral : null;
    let reversalId = null;
    let correctionId = null;
    if (definition.status === "ACCEPTED") {
      // 冲正原记录 + 记录更正说明
      const target = definition.record;
      reversalId = newId();
      insertRecord.run(
        reversalId,
        schoolId,
        year2026,
        term2026a,
        target.student.id,
        target.student.classId,
        gradeIds[target.student.gradeName],
        target.rule.id,
        target.rule.versionId,
        JSON.stringify({ name: target.rule.name, categoryId: target.rule.categoryId, categoryName: target.rule.categoryName, direction: target.rule.direction, points: target.rule.points, version: 1, description: "", examples: "" }),
        target.rule.categoryId,
        target.rule.categoryName,
        target.direction === "ADD" ? "DEDUCT" : "ADD",
        target.points,
        target.direction === "ADD" ? -target.points : target.points,
        "REVERSAL",
        "EFFECTIVE",
        target.occurrenceAt,
        "申诉裁决：原记录事实认定有误，冲正原记录",
        "[]",
        "APPEAL",
        userIds.moral,
        userIds.moral,
        now,
        "申诉接受",
        null,
        target.id,
        null,
        null,
        now,
        now,
      );
      correctionId = newId();
      insertRecord.run(
        correctionId,
        schoolId,
        year2026,
        term2026a,
        target.student.id,
        target.student.classId,
        gradeIds[target.student.gradeName],
        target.rule.id,
        target.rule.versionId,
        JSON.stringify({ name: target.rule.name, categoryId: target.rule.categoryId, categoryName: target.rule.categoryName, direction: target.rule.direction, points: target.rule.points, version: 1, description: "", examples: "" }),
        target.rule.categoryId,
        target.rule.categoryName,
        target.direction,
        target.points,
        target.direction === "ADD" ? target.points : -target.points,
        "CORRECTION",
        "EFFECTIVE",
        target.occurrenceAt,
        "申诉裁决：更正原记录说明，经核实行为不属于违纪",
        "[]",
        "APPEAL",
        userIds.moral,
        userIds.moral,
        now,
        "申诉接受",
        null,
        null,
        target.id,
        null,
        now,
        now,
      );
    }
    insertAppeal.run(
      appealId,
      schoolId,
      definition.record.id,
      definition.record.student.id,
      definition.record.student.classId,
      definition.reason,
      "[]",
      definition.status,
      submittedBy,
      handlerId,
      decidedBy,
      definition.status === "ACCEPTED" ? dayIso(45) : null,
      definition.status === "ACCEPTED" ? "经查证学生行为属于课堂学习准备，原减分记录撤销并更正说明。" : "",
      0,
      "",
      reversalId,
      correctionId,
      dayIso(42 + index),
      dayIso(45),
    );
    if (definition.status === "UNDER_REVIEW") {
      insertDecision.run(
        `b1b1b1b1-b1b1-4b1b-8b1b-${String(index + 1).padStart(12, "0")}`,
        appealId,
        userIds.moral,
        "UNDER_REVIEW",
        "已受理，正在向任课教师核实情况",
        0,
        "",
        null,
        null,
        dayIso(44),
      );
    }
    if (definition.status === "ACCEPTED") {
      insertDecision.run(
        `b1b1b1b1-b1b1-4b1b-8b1b-${String(index + 1).padStart(12, "0")}`,
        appealId,
        userIds.moral,
        "ACCEPTED",
        "经查证学生行为属于课堂学习准备，原减分记录撤销并更正说明。",
        0,
        "",
        reversalId,
        correctionId,
        dayIso(45),
      );
    }
  });
  // 已驳回申诉
  const rejectedTarget = records.find((item) => item.status === "EFFECTIVE" && item.student.className === "九年级1班") || records[0];
  insertAppeal.run(
    "a1a1a1a1-a1a1-4a1a-8a1a-000000000104",
    schoolId,
    rejectedTarget.id,
    rejectedTarget.student.id,
    rejectedTarget.student.classId,
    "认为当天并未违反课堂纪律，申请撤销减分。",
    "[]",
    "REJECTED",
    userIds.teacher3,
    userIds.moral,
    userIds.moral,
    dayIso(40),
    "经调取课堂记录并与任课教师核实，原减分记录事实清楚，维持原记录。",
    0,
    "",
    null,
    null,
    dayIso(38),
    dayIso(40),
  );
  insertDecision.run(
    "b1b1b1b1-b1b1-4b1b-8b1b-000000000104",
    "a1a1a1a1-a1a1-4a1a-8a1a-000000000104",
    userIds.moral,
    "REJECTED",
    "经调取课堂记录并与任课教师核实，原减分记录事实清楚，维持原记录。",
    0,
    "",
    null,
    null,
    dayIso(40),
  );

  // ---- 家长分享
  const shareTokenHash = sha256(DEMO_TOKENS.share);
  db.prepare(
    "INSERT INTO parent_shares(id,school_id,student_id,token_hash,label,created_by,expires_at,revoked_at,created_at,last_accessed_at,access_count) VALUES(?,?,?,?,?,?,?,NULL,?,NULL,0)",
  ).run(
    "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c01",
    schoolId,
    class7Students[0].id,
    shareTokenHash,
    "七年级1班演示家长分享",
    userIds.moral,
    iso("2027-01-31T00:00:00Z"),
    now,
  );
  db.prepare(
    "INSERT INTO parent_shares(id,school_id,student_id,token_hash,label,created_by,expires_at,revoked_at,created_at,last_accessed_at,access_count) VALUES(?,?,?,?,?,?,?,?,?,NULL,0)",
  ).run(
    "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c02",
    schoolId,
    class7Students[1].id,
    sha256("revoked-demo-share-token"),
    "已撤销演示分享",
    userIds.moral,
    iso("2027-01-31T00:00:00Z"),
    iso("2026-10-20T00:00:00Z"),
    now,
  );

  // ---- 审计日志
  const insertAudit = db.prepare(
    "INSERT INTO audit_logs(id,school_id,actor_id,actor_account,actor_role,action,target_type,target_id,summary,before_json,after_json,ip,user_agent,result,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const auditSeed = [
    ["登录成功", "LOGIN", "USER", userIds.moral, "MORAL_AFFAIRS", "moral"],
    ["发布评分规则「主动帮助同学」", "RULE_PUBLISH", "RULE", rules[0].id, "MORAL_AFFAIRS", "moral"],
    ["冲正一条错误积分记录", "SCORE_REVERSAL", "SCORE_RECORD", reversalTargets[0]?.id || rules[0].id, "MORAL_AFFAIRS", "moral"],
    ["创建七年级1班学生干部申报链接", "SUBMISSION_TOKEN_CREATE", "SUBMISSION_TOKEN", submissionTokenId, "MORAL_AFFAIRS", "moral"],
  ];
  auditSeed.forEach(([summary, action, targetType, targetId, role, account], index) => {
    insertAudit.run(
      `a2a2a2a2-a2a2-4a2a-8a2a-${String(index + 1).padStart(12, "0")}`,
      schoolId,
      userIds[account],
      account,
      role,
      action,
      targetType,
      targetId,
      summary,
      null,
      null,
      "127.0.0.1",
      "seed-fixture",
      "SUCCESS",
      dayIso(50 + index),
    );
  });

  return fixtureSummary(db, schoolId);
}

function fixtureSummary(db, schoolId) {
  const school = db.prepare("SELECT * FROM schools WHERE id=?").get(schoolId);
  const terms = db.prepare("SELECT * FROM terms WHERE school_id=? ORDER BY start_date").all(schoolId);
  const grades = db.prepare("SELECT * FROM grades WHERE school_id=? ORDER BY sort_order").all(schoolId);
  const classes = db.prepare("SELECT * FROM classes WHERE school_id=? ORDER BY sort_order").all(schoolId);
  const students = db.prepare("SELECT * FROM students WHERE school_id=? ORDER BY student_no").all(schoolId);
  const users = db.prepare("SELECT id,account,display_name,role FROM users WHERE school_id=?").all(schoolId);
  const rules = db.prepare("SELECT * FROM scoring_rules WHERE school_id=?").all(schoolId);
  const classIds = Object.fromEntries(classes.map((row) => [row.id, row]));
  return {
    schoolId,
    school,
    terms,
    currentTerm: terms.find((row) => row.is_current === 1),
    grades,
    classes,
    students,
    users,
    userIds: Object.fromEntries(users.map((row) => [row.account, row.id])),
    rules,
    classIds,
    shareToken: DEMO_TOKENS.share,
    submissionToken: DEMO_TOKENS.submission,
  };
}

export const fixturesPath = path.join(root, "server/fixtures.mjs");
