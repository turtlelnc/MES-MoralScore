#!/usr/bin/env node
// 运维 CLI：执行真实 SQLite 备份并查看备份任务状态。
// 用法：
//   node tools/ops/backup.mjs run      # 执行 VACUUM INTO 备份并套用保留策略
//   node tools/ops/backup.mjs status   # 查看配置与最近备份任务
// 输出统一为 JSON，便于脚本与监控采集；失败时退出码为 1。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../../server/config.mjs";
import {
  backupConfigured,
  backupDirOf,
  keepRecentOf,
  listBackupJobs,
  runBackup,
} from "../../server/backup.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const command = String(process.argv[2] || "status").toLowerCase();

function emit(payload, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = exitCode;
}

function main() {
  if (!["run", "status"].includes(command)) {
    emit({ ok: false, error: "用法：node tools/ops/backup.mjs <run|status>", allowed: ["run", "status"] }, 1);
    return;
  }
  let config;
  try {
    config = loadConfig(process.env, root);
  } catch (error) {
    emit({ ok: false, error: `配置无效：${error.message}` }, 1);
    return;
  }
  const dbPath = path.join(config.dataDir, "moral-score.sqlite");
  if (!fs.existsSync(dbPath)) {
    emit(
      {
        ok: false,
        error: `数据库文件不存在：${dbPath}`,
        hint: "请先启动一次服务完成数据库初始化（npm run start 或 npm run seed:demo）",
      },
      1,
    );
    return;
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    if (command === "run") {
      if (!backupConfigured(config)) {
        emit(
          {
            ok: false,
            backupDirConfigured: false,
            error: "未配置备份目录：请设置 BACKUP_DIR 环境变量（建议位于 DATA_DIR 之外）",
          },
          1,
        );
        return;
      }
      const result = runBackup({ db, config, createdBy: null, schoolId: null });
      emit({
        ok: true,
        command: "run",
        backupDir: backupDirOf(config),
        keepRecent: keepRecentOf(config),
        job: result.job,
        pruned: result.pruned,
        database: dbPath,
      });
      return;
    }
    emit({
      ok: true,
      command: "status",
      database: dbPath,
      backupDirConfigured: backupConfigured(config),
      backupDir: backupDirOf(config) || null,
      keepRecent: keepRecentOf(config),
      items: listBackupJobs(db, { limit: 20 }),
    });
  } catch (error) {
    emit({ ok: false, error: String(error?.message || error) }, 1);
  } finally {
    try {
      db.close();
    } catch {
      // 已关闭
    }
  }
}

main();
