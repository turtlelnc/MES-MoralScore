// 载入演示数据：npm run seed:demo / npm run seed。
// 所有演示数据均为虚构，仅用于演示与测试；重复执行不会重复插入（--force 可重播）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.mjs";
import { migrateDatabase } from "./migrations.mjs";
import { seedFixtures, DEMO_ACCOUNTS, DEMO_TOKENS } from "./fixtures.mjs";
import { VERSION_LABEL } from "./version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadConfig(process.env, root);
fs.mkdirSync(config.dataDir, { recursive: true });
const dbPath = path.join(config.dataDir, "moral-score.sqlite");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout=2000");
migrateDatabase(db);
const force = process.argv.includes("--force");
const summary = seedFixtures(db, { force });
console.log(`MES-MoralScore ${VERSION_LABEL} 演示数据已就绪：${dbPath}`);
console.log(`学校：${summary.school.name}（${summary.school.code}）`);
console.log(`学生 ${summary.students.length} 人 / 班级 ${summary.classes.length} 个 / 规则 ${summary.rules.length} 条`);
console.log("演示账号：");
for (const [key, definition] of Object.entries(DEMO_ACCOUNTS)) {
  console.log(`  ${key.padEnd(9)} ${definition.account.padEnd(9)} ${definition.password.padEnd(16)} ${definition.role}`);
}
console.log(`演示家长分享链接：/#/share/${DEMO_TOKENS.share}`);
console.log(`演示干部申报链接：/#/submit/${DEMO_TOKENS.submission}（七年级1班）`);
console.log(`提示：运行 npm start 或 npm run dev:server 启动服务；重复 seed 是幂等的，--force 会清空本校演示数据后重播。`);
db.close();
