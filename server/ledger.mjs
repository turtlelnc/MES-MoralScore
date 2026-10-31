// Deterministic score ledger calculations. Integer points only; EFFECTIVE
// records are the single source of truth. REVERSAL rows negate an original
// record, and corrections are new records — nothing is ever rewritten.
import { httpError } from "./core.mjs";

export const EFFECTIVE = "EFFECTIVE";

function classClause(classIds, column) {
  if (!classIds || classIds.length === 0) return { sql: "1=1", params: [] };
  return {
    sql: `${column} IN (${classIds.map(() => "?").join(",")})`,
    params: [...classIds],
  };
}

export function resolveTermForDate(db, schoolId, dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) throw httpError(400, "记录时间无效");
  const day = date.toISOString().slice(0, 10);
  const term = db
    .prepare(
      `SELECT t.*, y.name AS academic_year_name
       FROM terms t JOIN academic_years y ON y.id=t.academic_year_id
       WHERE t.school_id=? AND t.start_date<=? AND t.end_date>=?
       ORDER BY t.start_date DESC LIMIT 1`,
    )
    .get(schoolId, day, day);
  if (!term) throw httpError(400, "记录时间不在任何已配置的学期内，请先在系统设置中维护学年学期");
  return term;
}

export function scoreFloor(settings, raw) {
  return settings.allowNegative ? raw : Math.max(0, raw);
}

/** 单个学生某学期的积分构成（初始分 + 已生效加减分）。 */
export function studentTermScore(db, settings, { studentId, termId }) {
  const aggregate = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN signed_points>0 THEN signed_points ELSE 0 END),0) AS adds,
         COALESCE(SUM(CASE WHEN signed_points<0 THEN -signed_points ELSE 0 END),0) AS deducts,
         COALESCE(SUM(signed_points),0) AS net,
         COUNT(*) AS record_count
       FROM score_records
       WHERE student_id=? AND term_id=? AND status='EFFECTIVE'`,
    )
    .get(studentId, termId);
  const raw = settings.initialPoints + aggregate.net;
  return {
    initialPoints: settings.initialPoints,
    adds: aggregate.adds,
    deducts: aggregate.deducts,
    net: aggregate.net,
    recordCount: aggregate.record_count,
    total: scoreFloor(settings, raw),
    rawTotal: raw,
  };
}

/** 批量学生本学期得分；避免 N+1 查询。 */
export function studentTermScores(db, settings, { studentIds, termId }) {
  const result = new Map();
  if (!studentIds.length) return result;
  for (let start = 0; start < studentIds.length; start += 500) {
    const chunk = studentIds.slice(start, start + 500);
    const rows = db
      .prepare(
        `SELECT student_id,
           COALESCE(SUM(CASE WHEN signed_points>0 THEN signed_points ELSE 0 END),0) AS adds,
           COALESCE(SUM(CASE WHEN signed_points<0 THEN -signed_points ELSE 0 END),0) AS deducts,
           COALESCE(SUM(signed_points),0) AS net,
           COUNT(*) AS record_count
         FROM score_records
         WHERE term_id=? AND status='EFFECTIVE'
           AND student_id IN (${chunk.map(() => "?").join(",")})
         GROUP BY student_id`,
      )
      .all(termId, ...chunk);
    for (const row of rows) {
      const raw = settings.initialPoints + row.net;
      result.set(row.student_id, {
        initialPoints: settings.initialPoints,
        adds: row.adds,
        deducts: row.deducts,
        net: row.net,
        recordCount: row.record_count,
        total: scoreFloor(settings, raw),
        rawTotal: raw,
      });
    }
  }
  for (const studentId of studentIds) {
    if (!result.has(studentId)) {
      const raw = settings.initialPoints;
      result.set(studentId, {
        initialPoints: settings.initialPoints,
        adds: 0,
        deducts: 0,
        net: 0,
        recordCount: 0,
        total: scoreFloor(settings, raw),
        rawTotal: raw,
      });
    }
  }
  return result;
}

/**
 * 班级维度汇总：平均分按“每名学生得分再取平均”，并同时返回人数、
 * 加减分总量与有记录学生数，避免不同人数班级只比总分。
 */
export function classScoreSummaries(db, settings, { termId, classIds = null }) {
  const filter = classIds ? classClause(classIds, "s.class_id") : { sql: "1=1", params: [] };
  const perStudent = db
    .prepare(
      `WITH totals AS (
         SELECT s.class_id AS class_id, s.id AS student_id,
           ? + COALESCE(SUM(r.signed_points),0) AS raw
         FROM students s
         LEFT JOIN score_records r ON r.student_id=s.id AND r.term_id=? AND r.status='EFFECTIVE'
         WHERE s.status='ACTIVE' AND (${filter.sql})
         GROUP BY s.id
       ),
       scored AS (
         SELECT class_id, student_id,
           CASE WHEN ?=1 THEN raw ELSE MAX(0, raw) END AS total
         FROM totals
       )
       SELECT class_id, COUNT(*) AS student_count,
         ROUND(AVG(total),1) AS avg_score,
         MIN(total) AS min_score, MAX(total) AS max_score
       FROM scored GROUP BY class_id`,
    )
    .all(settings.initialPoints, termId, ...filter.params, settings.allowNegative ? 1 : 0);

  const aggregates = db
    .prepare(
      `SELECT r.class_id AS class_id,
         COUNT(*) AS record_count,
         COUNT(DISTINCT r.student_id) AS active_students,
         COALESCE(SUM(CASE WHEN r.signed_points>0 THEN r.signed_points ELSE 0 END),0) AS adds,
         COALESCE(SUM(CASE WHEN r.signed_points<0 THEN -r.signed_points ELSE 0 END),0) AS deducts,
         COALESCE(SUM(r.signed_points),0) AS net
       FROM score_records r
       WHERE r.term_id=? AND r.status='EFFECTIVE'
         ${classIds ? `AND (${classClause(classIds, "r.class_id").sql})` : ""}
       GROUP BY r.class_id`,
    )
    .all(termId, ...(classIds ? classIds : []));

  const byClass = new Map(aggregates.map((row) => [row.class_id, row]));
  return perStudent.map((row) => {
    const extra = byClass.get(row.class_id) || {
      record_count: 0,
      active_students: 0,
      adds: 0,
      deducts: 0,
      net: 0,
    };
    return {
      classId: row.class_id,
      studentCount: row.student_count,
      avgScore: row.avg_score,
      minScore: row.min_score,
      maxScore: row.max_score,
      recordCount: extra.record_count,
      activeStudents: extra.active_students,
      adds: extra.adds,
      deducts: extra.deducts,
      net: extra.net,
    };
  });
}

export function gradeScoreSummaries(db, settings, { termId, gradeIds = null }) {
  const filter = gradeIds ? classClause(gradeIds, "s.grade_id") : { sql: "1=1", params: [] };
  const perStudent = db
    .prepare(
      `WITH totals AS (
         SELECT s.grade_id AS grade_id, s.id AS student_id,
           ? + COALESCE(SUM(r.signed_points),0) AS raw
         FROM students s
         LEFT JOIN score_records r ON r.student_id=s.id AND r.term_id=? AND r.status='EFFECTIVE'
         WHERE s.status='ACTIVE' AND (${filter.sql})
         GROUP BY s.id
       ),
       scored AS (
         SELECT grade_id, student_id,
           CASE WHEN ?=1 THEN raw ELSE MAX(0, raw) END AS total
         FROM totals
       )
       SELECT grade_id, COUNT(*) AS student_count,
         ROUND(AVG(total),1) AS avg_score, MIN(total) AS min_score, MAX(total) AS max_score
       FROM scored GROUP BY grade_id`,
    )
    .all(settings.initialPoints, termId, ...filter.params, settings.allowNegative ? 1 : 0);

  const aggregates = db
    .prepare(
      `SELECT r.grade_id AS grade_id,
         COUNT(*) AS record_count,
         COALESCE(SUM(CASE WHEN r.signed_points>0 THEN r.signed_points ELSE 0 END),0) AS adds,
         COALESCE(SUM(CASE WHEN r.signed_points<0 THEN -r.signed_points ELSE 0 END),0) AS deducts,
         COALESCE(SUM(r.signed_points),0) AS net
       FROM score_records r
       WHERE r.term_id=? AND r.status='EFFECTIVE'
         ${gradeIds ? `AND (${classClause(gradeIds, "r.grade_id").sql})` : ""}
       GROUP BY r.grade_id`,
    )
    .all(termId, ...(gradeIds ? gradeIds : []));
  const byGrade = new Map(aggregates.map((row) => [row.grade_id, row]));
  return perStudent.map((row) => {
    const extra = byGrade.get(row.grade_id) || {
      record_count: 0,
      adds: 0,
      deducts: 0,
      net: 0,
    };
    return {
      gradeId: row.grade_id,
      studentCount: row.student_count,
      avgScore: row.avg_score,
      minScore: row.min_score,
      maxScore: row.max_score,
      recordCount: extra.record_count,
      adds: extra.adds,
      deducts: extra.deducts,
      net: extra.net,
    };
  });
}

/** 按天趋势（含零值日期补齐在调用方处理）。 */
export function scoreTrend(db, { termId = "", from = "", to = "", classIds = null, gradeId = "" }) {
  const clauses = ["status='EFFECTIVE'"];
  const params = [];
  if (termId) {
    clauses.push("term_id=?");
    params.push(termId);
  }
  if (from) {
    clauses.push("occurrence_at>=?");
    params.push(from);
  }
  if (to) {
    clauses.push("occurrence_at<?");
    params.push(to);
  }
  if (classIds) {
    if (!classIds.length) return [];
    clauses.push(`class_id IN (${classIds.map(() => "?").join(",")})`);
    params.push(...classIds);
  }
  if (gradeId) {
    clauses.push("grade_id=?");
    params.push(gradeId);
  }
  return db
    .prepare(
      `SELECT substr(occurrence_at,1,10) AS date,
         COUNT(*) AS record_count,
         COALESCE(SUM(CASE WHEN signed_points>0 THEN signed_points ELSE 0 END),0) AS adds,
         COALESCE(SUM(CASE WHEN signed_points<0 THEN -signed_points ELSE 0 END),0) AS deducts,
         COALESCE(SUM(signed_points),0) AS net
       FROM score_records
       WHERE ${clauses.join(" AND ")}
       GROUP BY date ORDER BY date ASC`,
    )
    .all(...params);
}

export function categoryBreakdown(db, { termId = "", from = "", to = "", classIds = null, gradeId = "", studentId = "" }) {
  const clauses = ["status='EFFECTIVE'"];
  const params = [];
  if (termId) {
    clauses.push("term_id=?");
    params.push(termId);
  }
  if (from) {
    clauses.push("occurrence_at>=?");
    params.push(from);
  }
  if (to) {
    clauses.push("occurrence_at<?");
    params.push(to);
  }
  if (classIds) {
    if (!classIds.length) return [];
    clauses.push(`class_id IN (${classIds.map(() => "?").join(",")})`);
    params.push(...classIds);
  }
  if (gradeId) {
    clauses.push("grade_id=?");
    params.push(gradeId);
  }
  if (studentId) {
    clauses.push("student_id=?");
    params.push(studentId);
  }
  return db
    .prepare(
      `SELECT category_id, category_name, direction,
         COUNT(*) AS record_count,
         COALESCE(SUM(ABS(signed_points)),0) AS magnitude,
         COALESCE(SUM(signed_points),0) AS net
       FROM score_records
       WHERE ${clauses.join(" AND ")}
       GROUP BY category_id, category_name, direction
       ORDER BY magnitude DESC`,
    )
    .all(...params);
}

export function ruleBreakdown(db, { termId = "", from = "", to = "", classIds = null, gradeId = "", direction = "" }) {
  const clauses = ["status='EFFECTIVE'"];
  const params = [];
  if (termId) {
    clauses.push("term_id=?");
    params.push(termId);
  }
  if (from) {
    clauses.push("occurrence_at>=?");
    params.push(from);
  }
  if (to) {
    clauses.push("occurrence_at<?");
    params.push(to);
  }
  if (classIds) {
    if (!classIds.length) return [];
    clauses.push(`class_id IN (${classIds.map(() => "?").join(",")})`);
    params.push(...classIds);
  }
  if (gradeId) {
    clauses.push("grade_id=?");
    params.push(gradeId);
  }
  if (direction) {
    clauses.push("direction=?");
    params.push(direction);
  }
  return db
    .prepare(
      `SELECT COALESCE(rule_id, category_id) AS rule_key,
         json_extract(rule_snapshot_json,'$.name') AS rule_name,
         category_name, direction,
         COUNT(*) AS record_count, COUNT(DISTINCT student_id) AS student_count,
         COALESCE(SUM(ABS(signed_points)),0) AS magnitude
       FROM score_records
       WHERE ${clauses.join(" AND ")}
       GROUP BY rule_key, rule_name, category_name, direction
       ORDER BY record_count DESC, magnitude DESC`,
    )
    .all(...params);
}

export const RECORD_STATUS_LABELS = Object.freeze({
  EFFECTIVE: "已生效",
  PENDING_REVIEW: "待复核",
  REJECTED: "已驳回",
});
export const RECORD_KIND_LABELS = Object.freeze({
  STANDARD: "记分",
  REVERSAL: "冲正",
  CORRECTION: "更正",
});
export const RECORD_SOURCE_LABELS = Object.freeze({
  TEACHER: "教师录入",
  MORAL_AFFAIRS: "德育处录入",
  STUDENT_CADRE: "学生干部申报",
  IMPORT: "批量导入",
  APPEAL: "申诉更正",
});

function chunks(list, size = 400) {
  const result = [];
  for (let index = 0; index < list.length; index += size) result.push(list.slice(index, index + size));
  return result;
}

/**
 * 批量序列化账本记录（学生/班级/提交人/冲正关系一次查完，避免 N+1）。
 * rows 必须是 score_records 的原始行。
 */
export function recordViews(db, rows) {
  if (!rows.length) return [];
  const studentIds = [...new Set(rows.map((row) => row.student_id))];
  const classIds = [...new Set(rows.map((row) => row.class_id))];
  const userIds = [...new Set(rows.flatMap((row) => [row.submitter_id, row.reviewer_id].filter(Boolean)))];
  const recordIds = rows.map((row) => row.id);
  const studentMap = new Map();
  for (const list of chunks(studentIds)) {
    for (const row of db
      .prepare(`SELECT id,name,student_no FROM students WHERE id IN (${list.map(() => "?").join(",")})`)
      .all(...list))
      studentMap.set(row.id, row);
  }
  const classMap = new Map();
  for (const list of chunks(classIds)) {
    for (const row of db
      .prepare(
        `SELECT c.id,c.name,g.name AS grade_name FROM classes c JOIN grades g ON g.id=c.grade_id
         WHERE c.id IN (${list.map(() => "?").join(",")})`,
      )
      .all(...list))
      classMap.set(row.id, row);
  }
  const userMap = new Map();
  for (const list of chunks(userIds)) {
    for (const row of db
      .prepare(`SELECT id,display_name,role FROM users WHERE id IN (${list.map(() => "?").join(",")})`)
      .all(...list))
      userMap.set(row.id, row);
  }
  const reversedSet = new Set();
  const reversalMap = new Map();
  for (const list of chunks(recordIds)) {
    for (const row of db
      .prepare(
        `SELECT id,reverses_record_id FROM score_records
         WHERE reverses_record_id IN (${list.map(() => "?").join(",")}) AND status='EFFECTIVE'`,
      )
      .all(...list)) {
      reversedSet.add(row.reverses_record_id);
      reversalMap.set(row.reverses_record_id, row.id);
    }
  }
  const evidenceIds = [...new Set(rows.flatMap((row) => safeJsonArray(row.evidence_json)))];
  const evidenceMap = new Map();
  for (const list of chunks(evidenceIds)) {
    for (const row of db
      .prepare(
        `SELECT id,original_name,mime,size_bytes FROM evidence_files
         WHERE id IN (${list.map(() => "?").join(",")})`,
      )
      .all(...list))
      evidenceMap.set(row.id, row);
  }
  return rows.map((row) => {
    const student = studentMap.get(row.student_id);
    const klass = classMap.get(row.class_id);
    const submitter = userMap.get(row.submitter_id);
    const reviewer = row.reviewer_id ? userMap.get(row.reviewer_id) : null;
    const snapshot = safeJsonObject(row.rule_snapshot_json);
    const reversed = reversedSet.has(row.id);
    return {
      id: row.id,
      studentId: row.student_id,
      studentName: student?.name || "（学生已删除）",
      studentNo: student?.student_no || "",
      classId: row.class_id,
      className: klass?.name || "",
      gradeName: klass?.grade_name || "",
      ruleId: row.rule_id,
      ruleVersionId: row.rule_version_id,
      ruleName: snapshot.name || "",
      categoryId: row.category_id,
      categoryName: row.category_name,
      direction: row.direction,
      directionLabel: row.direction === "ADD" ? "加分" : "减分",
      points: row.points,
      signedPoints: row.signed_points,
      recordKind: row.record_kind,
      recordKindLabel: RECORD_KIND_LABELS[row.record_kind] || row.record_kind,
      status: row.status,
      statusLabel: reversed
        ? "已冲正"
        : RECORD_STATUS_LABELS[row.status] || row.status,
      reversed,
      reversalRecordId: reversalMap.get(row.id) || null,
      occurrenceAt: row.occurrence_at,
      note: row.note,
      evidence: safeJsonArray(row.evidence_json)
        .map((id) => evidenceMap.get(id))
        .filter(Boolean)
        .map((file) => ({
          id: file.id,
          name: file.original_name,
          mime: file.mime,
          sizeBytes: file.size_bytes,
        })),
      source: row.source,
      sourceLabel: RECORD_SOURCE_LABELS[row.source] || row.source,
      submitterId: row.submitter_id,
      submitterName: submitter?.display_name || "",
      reviewerName: reviewer?.display_name || "",
      reviewedAt: row.reviewed_at,
      reviewNote: row.review_note,
      submissionId: row.submission_id,
      reversesRecordId: row.reverses_record_id,
      correctsRecordId: row.corrects_record_id,
      batchId: row.batch_id,
      createdAt: row.created_at,
      effectiveAt: row.effective_at,
    };
  });
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function recordListWhere({ termId = "", classIds = null, classId = "", gradeId = "", studentId = "", categoryId = "", direction = "", status = "", from = "", to = "", search = "", submitterId = "" }) {
  const clauses = [];
  const params = [];
  if (termId) {
    clauses.push("r.term_id=?");
    params.push(termId);
  }
  if (classId) {
    clauses.push("r.class_id=?");
    params.push(classId);
  } else if (classIds) {
    if (!classIds.length) return { where: "1=0", params: [] };
    clauses.push(`r.class_id IN (${classIds.map(() => "?").join(",")})`);
    params.push(...classIds);
  }
  if (gradeId) {
    clauses.push("r.grade_id=?");
    params.push(gradeId);
  }
  if (studentId) {
    clauses.push("r.student_id=?");
    params.push(studentId);
  }
  if (categoryId) {
    clauses.push("r.category_id=?");
    params.push(categoryId);
  }
  if (direction) {
    clauses.push("r.direction=?");
    params.push(direction);
  }
  if (status) {
    clauses.push("r.status=?");
    params.push(status);
  }
  if (from) {
    clauses.push("r.occurrence_at>=?");
    params.push(from);
  }
  if (to) {
    clauses.push("r.occurrence_at<?");
    params.push(to);
  }
  if (submitterId) {
    clauses.push("r.submitter_id=?");
    params.push(submitterId);
  }
  if (search) {
    clauses.push(
      "(s.name LIKE ? ESCAPE '\\' OR s.student_no LIKE ? ESCAPE '\\' OR json_extract(r.rule_snapshot_json,'$.name') LIKE ? ESCAPE '\\' OR r.note LIKE ? ESCAPE '\\')",
    );
    const pattern = `%${String(search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(pattern, pattern, pattern, pattern);
  }
  return { where: clauses.length ? clauses.join(" AND ") : "1=1", params };
}
