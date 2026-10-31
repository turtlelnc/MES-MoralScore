// 生产环境初始化：创建学校、当前学年学期、默认指标分类与首个系统管理员账号。
// 用法：npm run admin:create -- --account=admin --password=YourStrongPass1 --name=林校长 \
//        --school-name=某某实验学校 --school-code=MY-SCHOOL [--stage=初中]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./server/config.mjs";
import { migrateDatabase } from "./server/migrations.mjs";
import { hashPassword, assertPasswordPolicy } from "./server/core.mjs";
import { iso } from "./server/core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) return [arg.replace(/^--/, ""), "1"];
    return [match[1], match[2]];
  }),
);
const account = String(args.account || process.env.BOOTSTRAP_ADMIN_ACCOUNT || "").trim();
const password = String(args.password || process.env.BOOTSTRAP_ADMIN_PASSWORD || "");
const displayName = String(args.name || "系统管理员").trim();
const schoolName = String(args["school-name"] || "我的学校").trim();
const schoolCode = String(args["school-code"] || "MY-SCHOOL").trim().toUpperCase();
const stage = String(args.stage || "初中");
if (!account) throw new Error("缺少 --account=管理员账号");
if (!password) throw new Error("缺少 --password=管理员密码（或在环境变量 BOOTSTRAP_ADMIN_PASSWORD 中提供）");
if (!["小学", "初中", "高中"].includes(stage)) throw new Error("--stage 必须为 小学/初中/高中");
assertPasswordPolicy(password, { account });

const config = loadConfig(process.env, root);
fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, "moral-score.sqlite"));
db.exec("PRAGMA busy_timeout=2000");
migrateDatabase(db);
const now = iso();

let school = db.prepare("SELECT * FROM schools WHERE code=?").get(schoolCode);
if (!school) {
  const schoolId = randomUUID();
  db.prepare(
    "INSERT INTO schools(id,name,code,stage,address,contact,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(schoolId, schoolName, schoolCode, stage, "", "", now);
  school = db.prepare("SELECT * FROM schools WHERE id=?").get(schoolId);
  console.log(`已创建学校：${schoolName}（${schoolCode}）`);
}

const existingUser = db.prepare("SELECT id FROM users WHERE account=?").get(account);
if (existingUser) throw new Error(`账号 ${account} 已存在，请更换 --account 或到系统管理中重置密码`);

// 当前学年与学期（8 月 1 日之后视为秋季学期开始）
const today = new Date();
const year = today.getMonth() + 1 >= 8 ? today.getFullYear() : today.getFullYear() - 1;
let currentYear = db
  .prepare("SELECT * FROM academic_years WHERE school_id=? AND is_current=1")
  .get(school.id);
let currentTerm = db.prepare("SELECT * FROM terms WHERE school_id=? AND is_current=1").get(school.id);
if (!currentYear) {
  const yearId = randomUUID();
  db.prepare(
    "INSERT INTO academic_years(id,school_id,name,start_date,end_date,is_current,created_at) VALUES(?,?,?,?,?,1,?)",
  ).run(yearId, school.id, `${year}-${year + 1} 学年`, `${year}-09-01`, `${year + 1}-07-10`, now);
  currentYear = db.prepare("SELECT * FROM academic_years WHERE id=?").get(yearId);
  db.prepare(
    "INSERT INTO terms(id,school_id,academic_year_id,name,start_date,end_date,is_current,created_at) VALUES(?,?,?,?,?,?,1,?)",
  ).run(
    randomUUID(),
    school.id,
    yearId,
    `${year} 秋季学期`,
    `${year}-09-01`,
    `${year + 1}-01-20`,
    now,
  );
  db.prepare(
    "INSERT INTO terms(id,school_id,academic_year_id,name,start_date,end_date,is_current,created_at) VALUES(?,?,?,?,?,?,0,?)",
  ).run(
    randomUUID(),
    school.id,
    yearId,
    `${year + 1} 春季学期`,
    `${year + 1}-02-20`,
    `${year + 1}-07-08`,
    now,
  );
  console.log(`已创建学年学期：${year}-${year + 1} 学年`);
}

const categories = [
  ["日常行为规范", "日常行为、纪律与习惯相关表现"],
  ["课堂纪律", "课堂参与、秩序与学习状态"],
  ["宿舍内务", "宿舍卫生与内务整理"],
  ["环境卫生", "校园与班级环境卫生"],
  ["文明礼仪", "文明用语、礼仪与互助"],
  ["社会实践", "社会实践与研学活动"],
  ["竞赛荣誉", "学科、文体与综合竞赛荣誉"],
  ["志愿服务", "校内外志愿服务"],
  ["其他", "其他德育表现"],
];
const insertCategory = db.prepare(
  "INSERT OR IGNORE INTO scoring_categories(id,school_id,name,description,direction_scope,sort_order,is_enabled,created_at) VALUES(?,?,?,?,'BOTH',?,1,?)",
);
categories.forEach(([name, description], index) => {
  insertCategory.run(randomUUID(), school.id, name, description, index + 1, now);
});

const insertSetting = db.prepare(
  "INSERT OR IGNORE INTO system_settings(school_id,key,value,updated_at) VALUES(?,?,?,?)",
);
for (const [key, value] of [
  ["initial_points", "100"],
  ["allow_negative", "0"],
  ["review_threshold", "10"],
])
  insertSetting.run(school.id, key, value, now);

const { hash, salt } = await hashPassword(password);
const userId = randomUUID();
db.prepare(
  "INSERT INTO users(id,school_id,account,display_name,role,password_hash,salt,teacher_id,status,must_change_password,created_at) VALUES(?,?,?,?,?,?,?,NULL,'ACTIVE',1,?)",
).run(userId, school.id, account, displayName, "SYSTEM_ADMIN", hash, salt, now);
db.prepare(
  "INSERT INTO audit_logs(id,school_id,actor_id,actor_account,actor_role,action,target_type,target_id,summary,before_json,after_json,ip,user_agent,result,created_at) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,'',?, 'SUCCESS',?)",
).run(randomUUID(), school.id, userId, account, "SYSTEM_ADMIN", "BOOTSTRAP_ADMIN", "USER", userId, "初始化系统管理员账号", "cli", now);

console.log(`已创建系统管理员：${account}（${displayName}）`);
console.log("该账号首次登录后会被提示修改密码。");
console.log("下一步：启动服务后进入「系统管理」维护年级/班级/学生，或使用 CSV 导入；然后由德育处发布评分规则。");
db.close();
