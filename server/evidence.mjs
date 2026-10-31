// 私有证据文件：随机文件名、类型白名单、大小上限、授权下载。
// 文件永不放在可公开遍历的静态目录，也不允许执行。
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { httpError, clientIp, iso, sha256, safeFilename, uid } from "./core.mjs";

const ALLOWED = new Map([
  ["image/png", { ext: "png", magic: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 }],
  ["image/jpeg", { ext: "jpg", magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }],
  [
    "image/webp",
    {
      ext: "webp",
      magic: (b) =>
        b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
    },
  ],
  ["application/pdf", { ext: "pdf", magic: (b) => b.length > 4 && b.toString("ascii", 0, 4) === "%PDF" }],
]);

export function registerEvidenceRoutes(app, ctx) {
  const { db, config, auth, scope, audit } = ctx;
  const evidenceDir = path.join(config.dataDir, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.evidenceMaxMb * 1024 * 1024, files: 1, fields: 10, parts: 11 },
    // multipart 文件名默认按 latin1 解码，中文文件名会被替换成下划线；
    // multer 2.x 会把该参数透传给 busboy。
    defParamCharset: "utf8",
  });

  app.post("/api/evidence", auth, upload.single("file"), (req, res) => {
    const file = req.file;
    if (!file) throw httpError(400, "请选择需要上传的证据文件");
    const studentId = String(req.body?.studentId || "");
    const classId = String(req.body?.classId || "");
    if (!studentId && !classId) throw httpError(400, "请先选择学生或班级再上传证据");
    let student = null;
    if (studentId) student = scope.assertStudentAccess(req.user, studentId);
    if (classId) scope.assertClassAccess(req.user, classId);
    const detected = ALLOWED.get(file.mimetype);
    if (!detected || !detected.magic(file.buffer))
      throw httpError(400, "仅支持 PNG/JPG/WebP 图片或 PDF 文件");
    const id = uid();
    const storedName = `${id}.${detected.ext}`;
    const storagePath = path.join(evidenceDir, storedName);
    fs.writeFileSync(storagePath, file.buffer, { mode: 0o600 });
    db.prepare(
      `INSERT INTO evidence_files(id,school_id,student_id,class_id,uploaded_by,original_name,mime,size_bytes,sha256,storage_path,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      req.user.school_id,
      student?.id ?? null,
      classId || student?.class_id || null,
      req.user.id,
      safeFilename(file.originalname),
      detected.ext === "jpg" ? "image/jpeg" : file.mimetype,
      file.size,
      sha256(file.buffer),
      storedName,
      iso(),
    );
    audit.record({
      req,
      user: req.user,
      action: "EVIDENCE_UPLOAD",
      targetType: "EVIDENCE",
      targetId: id,
      summary: `上传证据 ${safeFilename(file.originalname)}（${file.size} 字节）`,
    });
    res.status(201).json({
      evidence: {
        id,
        name: safeFilename(file.originalname),
        mime: detected.ext === "jpg" ? "image/jpeg" : file.mimetype,
        sizeBytes: file.size,
      },
    });
  });

  app.get("/api/evidence/:id", auth, (req, res) => {
    const row = db
      .prepare("SELECT * FROM evidence_files WHERE id=? AND school_id=?")
      .get(req.params.id, req.user.school_id);
    if (!row) throw httpError(404, "证据文件不存在");
    if (row.student_id) scope.assertStudentAccess(req.user, row.student_id);
    else if (row.class_id) scope.assertClassAccess(req.user, row.class_id);
    else if (row.uploaded_by !== req.user.id && !scope.hasFullScope(req.user))
      throw httpError(403, "无权查看该证据文件");
    const absolute = path.join(evidenceDir, path.basename(row.storage_path));
    if (!fs.existsSync(absolute)) throw httpError(404, "证据文件已丢失");
    res.setHeader("Content-Type", row.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
    );
    res.setHeader("Cache-Control", "private, max-age=300");
    // DATA_DIR 可能位于隐藏目录（开发/测试），但文件名来自数据库且已限定在证据目录内，
    // 因此允许 send 读取该路径中的 dotfiles。
    res.sendFile(absolute, { dotfiles: "allow" });
  });
}

/** 校验记录引用的证据 id 确实属于该学生或班级，防止越权挂接。 */
export function validateEvidenceIds(db, { evidenceIds, studentId, classId }) {
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) return [];
  if (evidenceIds.length > 5) throw httpError(400, "单条记录最多关联 5 个证据文件");
  const ids = evidenceIds.map((id) => String(id));
  const rows = db
    .prepare(
      `SELECT id, student_id, class_id FROM evidence_files
       WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids);
  if (rows.length !== ids.length) throw httpError(400, "证据文件不存在或已被删除");
  for (const row of rows) {
    const matchesStudent = row.student_id && row.student_id === studentId;
    const matchesClass = row.class_id === classId && !row.student_id;
    if (!matchesStudent && !matchesClass)
      throw httpError(400, "证据文件与所选学生不匹配");
  }
  return ids;
}

export function evidenceSummary(db, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const rows = db
    .prepare(
      `SELECT id, original_name, mime, size_bytes FROM evidence_files
       WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids);
  return rows.map((row) => ({
    id: row.id,
    name: row.original_name,
    mime: row.mime,
    sizeBytes: row.size_bytes,
  }));
}

export { clientIp };
