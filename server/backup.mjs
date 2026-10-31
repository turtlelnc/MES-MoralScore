// 真实 SQLite 备份：使用 VACUUM INTO 生成一致性快照文件，记录 backup_jobs
// 状态、大小与错误，并按 BACKUP_KEEP_RECENT 保留最近 N 份。供 admin 接口与
// CLI（tools/ops/backup.mjs）复用，绝不返回伪造的成功状态。
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { httpError, iso, uid } from "./core.mjs";

export function backupDirOf(config) {
  if (!config?.backupDir) return "";
  return path.resolve(String(config.backupDir));
}

export function backupConfigured(config) {
  return Boolean(backupDirOf(config));
}

export function keepRecentOf(config) {
  const value = Number(config?.backupKeepRecent ?? 24);
  if (!Number.isSafeInteger(value) || value < 1) return 24;
  return Math.min(value, 500);
}

function jobSelectSql(where = "") {
  return `SELECT b.*, u.display_name AS created_by_name
          FROM backup_jobs b LEFT JOIN users u ON u.id=b.created_by
          ${where ? `WHERE ${where}` : ""}`;
}

export function backupJobView(row) {
  return {
    id: row.id,
    status: row.status,
    filePath: row.file_path || "",
    fileName: row.file_path ? path.basename(row.file_path) : "",
    sizeBytes: row.size_bytes,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdByName: row.created_by_name || "系统任务",
  };
}

export function getBackupJob(db, id) {
  const row = db.prepare(jobSelectSql("b.id=?")).get(String(id));
  return row ? backupJobView(row) : null;
}

/** 按时间倒序返回备份任务（含真实文件大小与错误信息）。 */
export function listBackupJobs(db, { limit = 50 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db
    .prepare(`SELECT b.*, u.display_name AS created_by_name
              FROM backup_jobs b LEFT JOIN users u ON u.id=b.created_by
              ORDER BY b.started_at DESC, b.rowid DESC LIMIT ?`)
    .all(size)
    .map(backupJobView);
}

function pruneBackups(db, { dir, keepRecent }) {
  const keep = Math.max(1, Number(keepRecent) || 24);
  const rows = db
    .prepare(
      "SELECT id,file_path FROM backup_jobs WHERE status='SUCCEEDED' ORDER BY started_at DESC, rowid DESC",
    )
    .all();
  const pruned = [];
  const dirPath = path.resolve(dir);
  for (const row of rows.slice(keep)) {
    if (row.file_path) {
      const resolved = path.resolve(row.file_path);
      // 只删除备份目录内部的真实文件，避免误删任意路径。
      if (resolved.startsWith(dirPath + path.sep) && fs.existsSync(resolved)) {
        try {
          fs.rmSync(resolved, { force: true });
        } catch {
          // 文件被占用时保留任务记录，等待下次清理。
          continue;
        }
      }
    }
    db.prepare("DELETE FROM backup_jobs WHERE id=?").run(row.id);
    pruned.push({ id: row.id, fileName: row.file_path ? path.basename(row.file_path) : "" });
  }
  return pruned;
}

/**
 * 执行一次真实备份。未配置 BACKUP_DIR 或目录不可写时抛出带中文说明的
 * 400 错误；VACUUM INTO 失败时把真实错误写入 backup_jobs 并抛出 400。
 */
export function runBackup({ db, config, createdBy = null, schoolId = null }) {
  const dir = backupDirOf(config);
  if (!dir) throw httpError(400, "未配置备份目录（BACKUP_DIR），无法执行备份");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw httpError(400, `无法创建备份目录：${String(error.message || error).slice(0, 120)}`);
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw httpError(400, "备份目录不可写，请检查目录权限");
  }
  const stamp = iso().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const fileName = `moral-score-${stamp}-${randomBytes(3).toString("hex")}.sqlite`;
  const filePath = path.join(dir, fileName);
  const id = uid();
  const startedAt = iso();
  db.prepare(
    "INSERT INTO backup_jobs(id,school_id,status,file_path,size_bytes,error,created_by,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,NULL)",
  ).run(id, schoolId, "RUNNING", filePath, 0, "", createdBy, startedAt);

  try {
    // VACUUM INTO 生成与主库一致的快照文件（不能放在事务内）。
    db.prepare("VACUUM INTO ?").run(filePath);
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) throw new Error("备份文件为空");
    db.prepare(
      "UPDATE backup_jobs SET status='SUCCEEDED', size_bytes=?, finished_at=? WHERE id=?",
    ).run(stat.size, iso(), id);
  } catch (error) {
    try {
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    } catch {
      // 忽略清理失败
    }
    const message = String(error?.message || error).slice(0, 500);
    db.prepare("UPDATE backup_jobs SET status='FAILED', error=?, finished_at=? WHERE id=?").run(
      message,
      iso(),
      id,
    );
    throw httpError(400, `备份执行失败：${message.slice(0, 120)}`);
  }

  const pruned = pruneBackups(db, { dir, keepRecent: keepRecentOf(config) });
  return { job: getBackupJob(db, id), pruned };
}
