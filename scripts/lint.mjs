// 轻量静态检查（项目未引入 ESLint）：服务端 ESM 语法检查 + 前端严格 TypeScript 检查。
// 用法：npm run lint（CI 也会执行）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function collect(directory) {
  const result = [];
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...collect(full));
    else if (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")) result.push(full);
  }
  return result;
}

const serverFiles = [...collect(path.join(root, "server")), ...collect(path.join(root, "tools"))];
console.log(`检查 ${serverFiles.length} 个服务端脚本语法…`);
for (const file of serverFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${path.relative(root, file)}\n${result.stderr}`);
}

console.log("运行 TypeScript 严格类型检查（tsc -b）…");
// 直接调用本地 typescript 依赖，避免 npx/shell 在不同平台的差异。
const tsc = spawnSync(
  process.execPath,
  [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-b"],
  { cwd: root, encoding: "utf8" },
);
if (tsc.status !== 0) failures.push(`tsc -b\n${tsc.stdout || ""}${tsc.stderr || ""}`);

if (failures.length) {
  console.error(`\n静态检查失败 ${failures.length} 项：\n`);
  for (const failure of failures) console.error(failure, "\n");
  process.exit(1);
}
console.log(`\n静态检查通过：${serverFiles.length} 个服务端脚本 + TypeScript 严格检查。`);
