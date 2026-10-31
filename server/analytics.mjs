// 数据分析模块（backend-data）：仪表盘、多维分析、学生分析与 CSV 导出。
// 所有数字均来自数据库实时聚合，统计口径复用 server/ledger.mjs；每个查询
// 都通过 ctx.scope 裁剪到操作者的授权班级范围。
import { httpError, today } from "./core.mjs";
import {
  categoryBreakdown,
  classScoreSummaries,
  gradeScoreSummaries,
  recordListWhere,
  recordViews,
  ruleBreakdown,
  scoreTrend,
  studentTermScore,
} from "./ledger.mjs";

const DAY_MS = 86_400_000;
const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

const round1 = (value) => Math.round((Number(value) || 0) * 10) / 10;
const str = (value) => (Array.isArray(value) ? value[0] : value);
function q(req, name) {
  const raw = str(req.query?.[name]);
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

function addDays(dateString, amount) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function parseDay(value, name) {
  const raw = String(value || "").slice(0, 10);
  if (!dateOnlyPattern.test(raw) || Number.isNaN(new Date(`${raw}T00:00:00.000Z`).getTime()))
    throw httpError(400, `${name}必须为 YYYY-MM-DD 格式`);
  return raw;
}

function currentTermRow(db, schoolId) {
  return (
    db
      .prepare(
        `SELECT t.*, y.name AS academic_year_name FROM terms t
         JOIN academic_years y ON y.id=t.academic_year_id
         WHERE t.school_id=? AND t.is_current=1`,
      )
      .get(schoolId) || null
  );
}

function resolveTerm(db, schoolId, termId) {
  if (termId) {
    const term = db
      .prepare(
        `SELECT t.*, y.name AS academic_year_name FROM terms t
         JOIN academic_years y ON y.id=t.academic_year_id
         WHERE t.id=? AND t.school_id=?`,
      )
      .get(String(termId), schoolId);
    if (!term) throw httpError(404, "学期不存在");
    return term;
  }
  return currentTermRow(db, schoolId);
}

function termView(term) {
  if (!term) return null;
  return {
    id: term.id,
    name: term.name,
    academicYearName: term.academic_year_name,
    startDate: term.start_date,
    endDate: term.end_date,
  };
}

function termDefaultRange(term) {
  if (!term) return { fromDate: addDays(today(), -29), toDate: today() };
  let toDate = today() > term.end_date ? term.end_date : today();
  if (toDate < term.start_date) toDate = term.start_date;
  return { fromDate: term.start_date, toDate };
}

/** 统一 from/to 语义：按自然日闭区间；返回 ledger 需要的 [from,to) 字符串。 */
function resolveWindow({ fromRaw, toRaw, term }) {
  const hasFrom = Boolean(fromRaw);
  const hasTo = Boolean(toRaw);
  let fromDate = hasFrom ? parseDay(fromRaw, "开始日期") : "";
  let toDate = hasTo ? parseDay(toRaw, "结束日期") : "";
  if (!fromDate || !toDate) {
    const fallback = termDefaultRange(term);
    if (!fromDate) fromDate = fallback.fromDate;
    if (!toDate) toDate = fallback.toDate;
  }
  if (fromDate > toDate) {
    if (hasFrom && hasTo) throw httpError(400, "开始日期不能晚于结束日期");
    toDate = fromDate;
  }
  return {
    fromDate,
    toDate,
    from: `${fromDate}T00:00:00.000Z`,
    to: `${addDays(toDate, 1)}T00:00:00.000Z`,
    hasExplicitRange: hasFrom || hasTo,
  };
}

function fillTrend(rows, fromDate, toDate) {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const result = [];
  let cursor = fromDate;
  let guard = 0;
  while (cursor <= toDate && guard < 400) {
    const hit = byDate.get(cursor);
    result.push({
      date: cursor,
      adds: hit?.adds || 0,
      deducts: hit?.deducts || 0,
      net: hit?.net || 0,
      recordCount: hit?.record_count || 0,
    });
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return result;
}

function scopedGradeIds(db, scope, user) {
  if (scope.hasFullScope(user)) return null;
  const classIds = scope.classIdsFor(user) || [];
  if (!classIds.length) return [];
  return db
    .prepare(`SELECT DISTINCT grade_id FROM classes WHERE id IN (${classIds.map(() => "?").join(",")})`)
    .all(...classIds)
    .map((row) => row.grade_id);
}

function assertGradeAccess(db, scope, user, gradeId) {
  const grade = db.prepare("SELECT * FROM grades WHERE id=? AND school_id=?").get(gradeId, user.school_id);
  if (!grade) throw httpError(404, "年级不存在");
  if (scope.hasFullScope(user)) return grade;
  const scoped = scopedGradeIds(db, scope, user) || [];
  if (!scoped.includes(grade.id)) throw httpError(403, "无权访问该年级的数据");
  return grade;
}

/**
 * 解析一次分析请求的班级/年级范围：
 * - classId 显式指定时做越权校验；
 * - 否则使用 ctx.scope 的班级列表，若指定 gradeId 则与年级班级求交集；
 * - 返回 classIds=null 表示全校，[] 表示无任何可见班级（必须返回空数据）。
 */
function resolveScopeClassIds(db, scope, user, { classId = "", gradeId = "" }) {
  let classIds;
  if (classId) {
    scope.assertClassAccess(user, classId);
    classIds = [classId];
  } else {
    classIds = scope.classIdsFor(user);
  }
  if (gradeId) {
    assertGradeAccess(db, scope, user, gradeId);
    if (classIds !== null) {
      const rows = db
        .prepare(`SELECT id FROM classes WHERE school_id=? AND grade_id=?`)
        .all(user.school_id, gradeId);
      const gradeClassIds = new Set(rows.map((row) => row.id));
      classIds = classIds.filter((id) => gradeClassIds.has(id));
    }
  }
  return classIds;
}

function classMeta(db, schoolId, classIds) {
  if (classIds !== null && classIds.length === 0) return new Map();
  const filter =
    classIds === null
      ? { sql: "1=1", params: [] }
      : {
          sql: `c.id IN (${classIds.map(() => "?").join(",")})`,
          params: [...classIds],
        };
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.grade_id, g.name AS grade_name
       FROM classes c JOIN grades g ON g.id=c.grade_id
       WHERE c.school_id=? AND (${filter.sql})`,
    )
    .all(schoolId, ...filter.params);
  return new Map(rows.map((row) => [row.id, row]));
}

function gradeMeta(db, schoolId, gradeIds) {
  if (gradeIds !== null && gradeIds.length === 0) return new Map();
  const filter =
    gradeIds === null
      ? { sql: "1=1", params: [] }
      : {
          sql: `id IN (${gradeIds.map(() => "?").join(",")})`,
          params: [...gradeIds],
        };
  const rows = db
    .prepare(`SELECT id,name,sort_order FROM grades WHERE school_id=? AND (${filter.sql}) ORDER BY sort_order`)
    .all(schoolId, ...filter.params);
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * 窗口内逐学生得分（初始分 + 窗口内已生效净分，按 allow_negative 取整）。
 * 用于班级/年级对比的人均分口径：先算每名学生得分，再对人数取平均。
 */
function studentTotalsInWindow(db, settings, { schoolId, classIds, gradeId, termId, from, to }) {
  if (classIds !== null && classIds.length === 0) return { studentCount: 0, avgScore: 0, rows: [] };
  const joinClauses = ["r.student_id=s.id", "r.status='EFFECTIVE'", "r.occurrence_at>=?", "r.occurrence_at<?"];
  const joinParams = [from, to];
  if (termId) {
    joinClauses.push("r.term_id=?");
    joinParams.push(termId);
  }
  const whereClauses = ["s.school_id=?", "s.status='ACTIVE'"];
  const whereParams = [schoolId];
  if (classIds !== null) {
    whereClauses.push(`s.class_id IN (${classIds.map(() => "?").join(",")})`);
    whereParams.push(...classIds);
  }
  if (gradeId) {
    whereClauses.push("s.grade_id=?");
    whereParams.push(gradeId);
  }
  const rows = db
    .prepare(
      `SELECT s.id AS student_id, s.class_id, s.grade_id,
         COALESCE(SUM(CASE WHEN r.signed_points>0 THEN r.signed_points ELSE 0 END),0) AS adds,
         COALESCE(SUM(CASE WHEN r.signed_points<0 THEN -r.signed_points ELSE 0 END),0) AS deducts,
         COALESCE(SUM(r.signed_points),0) AS net,
         COUNT(r.id) AS record_count
       FROM students s
       LEFT JOIN score_records r ON ${joinClauses.join(" AND ")}
       WHERE ${whereClauses.join(" AND ")}
       GROUP BY s.id`,
    )
    .all(...joinParams, ...whereParams)
    .map((row) => {
      const raw = settings.initialPoints + row.net;
      return {
        studentId: row.student_id,
        classId: row.class_id,
        gradeId: row.grade_id,
        total: settings.allowNegative ? raw : Math.max(0, raw),
        adds: row.adds,
        deducts: row.deducts,
        net: row.net,
        recordCount: row.record_count,
      };
    });
  const avgScore = rows.length ? round1(rows.reduce((sum, row) => sum + row.total, 0) / rows.length) : 0;
  return { studentCount: rows.length, avgScore, rows };
}

/** 按维度（班级/年级）聚合窗口内人均分与学生数。 */
function comparisonBy(rows, metaMap, keyName, idField) {
  const grouped = new Map();
  for (const row of rows) {
    const mapKey = row[idField];
    if (!grouped.has(mapKey))
      grouped.set(mapKey, { id: mapKey, studentCount: 0, totalSum: 0, adds: 0, deducts: 0, net: 0, recordCount: 0 });
    const bucket = grouped.get(mapKey);
    bucket.studentCount += 1;
    bucket.totalSum += row.total;
    bucket.adds += row.adds;
    bucket.deducts += row.deducts;
    bucket.net += row.net;
    bucket.recordCount += row.recordCount;
  }
  const result = [];
  for (const bucket of grouped.values()) {
    const meta = metaMap.get(bucket.id);
    if (!meta) continue;
    const item = {
      [`${keyName}Id`]: bucket.id,
      [`${keyName}Name`]: meta.name,
      studentCount: bucket.studentCount,
      avgScore: bucket.studentCount ? round1(bucket.totalSum / bucket.studentCount) : 0,
      adds: bucket.adds,
      deducts: bucket.deducts,
      net: bucket.net,
      recordCount: bucket.recordCount,
    };
    if (keyName === "class") item.gradeName = meta.grade_name;
    result.push(item);
  }
  return result.sort((left, right) => right.avgScore - left.avgScore || left[`${keyName}Name`].localeCompare(right[`${keyName}Name`]));
}

function recordAggregate(db, scope, user, { termId, from, to, classIds, gradeId }) {
  const clauses = ["r.status='EFFECTIVE'"];
  const params = [];
  if (termId) {
    clauses.push("r.term_id=?");
    params.push(termId);
  }
  if (from) {
    clauses.push("r.occurrence_at>=?");
    params.push(from);
  }
  if (to) {
    clauses.push("r.occurrence_at<?");
    params.push(to);
  }
  if (classIds !== null) {
    if (!classIds.length) return { adds: 0, deducts: 0, net: 0, recordCount: 0 };
    clauses.push(`r.class_id IN (${classIds.map(() => "?").join(",")})`);
    params.push(...classIds);
  }
  if (gradeId) {
    clauses.push("r.grade_id=?");
    params.push(gradeId);
  }
  const filter = scope.classFilter(user, "r.class_id");
  clauses.push(`(${filter.sql})`);
  params.push(...filter.params);
  return db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN r.signed_points>0 THEN r.signed_points ELSE 0 END),0) AS adds,
         COALESCE(SUM(CASE WHEN r.signed_points<0 THEN -r.signed_points ELSE 0 END),0) AS deducts,
         COALESCE(SUM(r.signed_points),0) AS net,
         COUNT(*) AS recordCount
       FROM score_records r WHERE ${clauses.join(" AND ")}`,
    )
    .get(...params);
}

function countPending(db, scope, user) {
  const reviewFilter = scope.classFilter(user, "class_id");
  const pendingReview = db
    .prepare(
      `SELECT COUNT(*) AS count FROM score_records r
       WHERE r.status='PENDING_REVIEW' AND (${scope.classFilter(user, "r.class_id").sql})`,
    )
    .get(...scope.classFilter(user, "r.class_id").params).count;
  const pendingSubmissions = db
    .prepare(
      `SELECT COUNT(*) AS count FROM student_submissions r WHERE r.status='PENDING_REVIEW' AND (${reviewFilter.sql})`,
    )
    .get(...reviewFilter.params).count;
  const openAppeals = db
    .prepare(
      `SELECT COUNT(*) AS count FROM appeals r
       WHERE r.status IN ('SUBMITTED','UNDER_REVIEW') AND (${reviewFilter.sql})`,
    )
    .get(...reviewFilter.params).count;
  return { pendingReview, pendingSubmissions, openAppeals };
}

/** 异常提醒：全部基于真实查询，最多 5 条。 */
function buildAlerts(db, scope, user, { classIds, termId }) {
  const alerts = [];
  const classFilter = scope.classFilter(user, "r.class_id");
  const scopeGuard = classFilter.sql;
  const scopeParams = classFilter.params;

  // 1) 24 小时内在减分 ≥3 次的学生（值日老师只看自己范围）。
  const since24h = new Date(Date.now() - DAY_MS).toISOString();
  const heavyDeducts = db
    .prepare(
      `SELECT r.student_id, COUNT(*) AS deduct_count, s.name AS student_name, c.name AS class_name
       FROM score_records r
       JOIN students s ON s.id=r.student_id
       JOIN classes c ON c.id=r.class_id
       WHERE r.status='EFFECTIVE' AND r.direction='DEDUCT' AND r.occurrence_at>=? AND (${scopeGuard})
       GROUP BY r.student_id HAVING COUNT(*)>=3
       ORDER BY deduct_count DESC LIMIT 2`,
    )
    .all(since24h, ...scopeParams);
  for (const row of heavyDeducts) {
    alerts.push({
      id: `deduct-24h-${row.student_id}`,
      level: "warn",
      title: `${row.student_name} 24 小时内减分 ${row.deduct_count} 次`,
      description: `${row.class_name} · 建议及时了解情况并与班主任沟通`,
      count: row.deduct_count,
    });
  }

  // 2) 大额积分记录（|points|≥10），提示核对说明与证据。
  const clauses = ["r.status='EFFECTIVE'", "r.points>=10"];
  const params = [];
  if (termId) {
    clauses.push("r.term_id=?");
    params.push(termId);
  }
  clauses.push(`(${scopeGuard})`);
  params.push(...scopeParams);
  const bigRecords = db
    .prepare(`SELECT COUNT(*) AS count FROM score_records r WHERE ${clauses.join(" AND ")}`)
    .get(...params).count;
  if (bigRecords > 0) {
    alerts.push({
      id: "high-points",
      level: "warn",
      title: `${bigRecords} 条大额积分记录（|分值|≥10）`,
      description: "建议核对记录说明与证据材料，必要时安排复核",
      count: bigRecords,
    });
  }

  // 3) 最近 7 天没有任何积分记录的班级。
  const since7d = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const scopedClasses = classIds === null
    ? db.prepare("SELECT id,name FROM classes WHERE school_id=?").all(user.school_id)
    : classIds.length
      ? db
          .prepare(`SELECT id,name FROM classes WHERE school_id=? AND id IN (${classIds.map(() => "?").join(",")})`)
          .all(user.school_id, ...classIds)
      : [];
  if (scopedClasses.length) {
    const activeClassIds = new Set(
      db
        .prepare(
          `SELECT DISTINCT class_id FROM score_records
           WHERE status='EFFECTIVE' AND occurrence_at>=? AND class_id IN (${scopedClasses.map(() => "?").join(",")})`,
        )
        .all(since7d, ...scopedClasses.map((row) => row.id))
        .map((row) => row.class_id),
    );
    const idle = scopedClasses.filter((row) => !activeClassIds.has(row.id));
    if (idle.length) {
      alerts.push({
        id: "idle-classes",
        level: "info",
        title: `${idle.length} 个班级 7 天内无积分记录`,
        description: `${idle
          .slice(0, 3)
          .map((row) => row.name)
          .join("、")}${idle.length > 3 ? " 等" : ""} · 可提醒教师及时记录`,
        count: idle.length,
      });
    }
  }
  return alerts.slice(0, 5);
}

export function registerAnalyticsRoutes(app, ctx) {
  const { db, auth, requireStaff, scope, settings } = ctx;

  // ------------------------------------------------------------ 仪表盘
  app.get("/api/dashboard", auth, requireStaff, (req, res) => {
    const schoolId = req.user.school_id;
    const term = resolveTerm(db, schoolId, q(req, "termId"));
    const config = settings.get(schoolId);
    let classIds = scope.classIdsFor(req.user);
    const meta = classMeta(db, schoolId, classIds);
    const gradeIds = scopedGradeIds(db, scope, req.user);
    const range = termDefaultRange(term);
    const trend = fillTrend(
      term || classIds === null || classIds.length
        ? scoreTrend(db, { termId: term?.id || "", from: `${range.fromDate}T00:00:00.000Z`, to: `${addDays(range.toDate, 1)}T00:00:00.000Z`, classIds })
        : [],
      range.fromDate,
      range.toDate,
    );

    if (classIds !== null && classIds.length === 0) {
      return res.json({
        term: termView(term),
        kpis: {
          studentCount: 0,
          classCount: 0,
          avgScore: 0,
          totalAdds: 0,
          totalDeducts: 0,
          net: 0,
          recordCount: 0,
          pendingReviewCount: 0,
          pendingSubmissionCount: 0,
          openAppealCount: 0,
        },
        trend,
        classDistribution: [],
        gradeDistribution: [],
        categories: [],
        topPositiveRules: [],
        alerts: [],
        recentRecords: [],
      });
    }

    const classSummaries = classScoreSummaries(db, config, { termId: term?.id || "", classIds });
    const classDistribution = classSummaries
      .map((row) => {
        const info = meta.get(row.classId);
        return {
          classId: row.classId,
          className: info?.name || "",
          gradeName: info?.grade_name || "",
          avgScore: row.avgScore,
          studentCount: row.studentCount,
          adds: row.adds,
          deducts: row.deducts,
        };
      })
      .filter((row) => row.className)
      .sort((left, right) => right.avgScore - left.avgScore);
    const gradeSummary = gradeScoreSummaries(db, config, { termId: term?.id || "", gradeIds: gradeIds || undefined });
    const gradeMap = gradeMeta(db, schoolId, gradeIds);
    const gradeDistribution = gradeSummary
      .map((row) => ({
        gradeId: row.gradeId,
        gradeName: gradeMap.get(row.gradeId)?.name || "",
        avgScore: row.avgScore,
        studentCount: row.studentCount,
      }))
      .filter((row) => row.gradeName)
      .sort((left, right) => right.avgScore - left.avgScore);

    const studentCount = classSummaries.reduce((sum, row) => sum + row.studentCount, 0);
    const totalAdds = classSummaries.reduce((sum, row) => sum + row.adds, 0);
    const totalDeducts = classSummaries.reduce((sum, row) => sum + row.deducts, 0);
    const net = classSummaries.reduce((sum, row) => sum + row.net, 0);
    const recordCount = classSummaries.reduce((sum, row) => sum + row.recordCount, 0);
    // 全校/范围人均分：先算每名学生在学期内的得分，再取平均（避免班级人数不同
    // 时用班级平均分二次加权带来的舍入偏差）。
    const studentWindow = studentTotalsInWindow(db, config, {
      schoolId,
      classIds,
      gradeId: "",
      termId: term?.id || "__none__",
      from: "0000-01-01T00:00:00.000Z",
      to: "9999-12-31T00:00:00.000Z",
    });
    const avgScore = studentWindow.avgScore;
    const pending = countPending(db, scope, req.user);
    const categories = categoryBreakdown(db, { termId: term?.id || "", classIds }).map((row) => ({
      categoryName: row.category_name,
      direction: row.direction,
      recordCount: row.record_count,
      magnitude: row.magnitude,
      net: row.net,
    }));
    const topPositiveRules = ruleBreakdown(db, { termId: term?.id || "", classIds, direction: "ADD" })
      .slice(0, 5)
      .map((row) => ({ ruleName: row.rule_name || row.category_name || "未命名规则", recordCount: row.record_count, magnitude: row.magnitude }));
    const recent = db
      .prepare(
        `SELECT * FROM score_records r WHERE r.term_id=? AND (${scope.classFilter(req.user, "r.class_id").sql})
         ORDER BY r.occurrence_at DESC, r.created_at DESC LIMIT 10`,
      )
      .all(term?.id || "", ...scope.classFilter(req.user, "r.class_id").params);

    res.json({
      term: termView(term),
      kpis: {
        studentCount,
        classCount:
          classIds === null
            ? db.prepare("SELECT COUNT(*) AS count FROM classes WHERE school_id=?").get(schoolId).count
            : classIds.length,
        avgScore,
        totalAdds,
        totalDeducts,
        net,
        recordCount,
        pendingReviewCount: pending.pendingReview,
        pendingSubmissionCount: pending.pendingSubmissions,
        openAppealCount: pending.openAppeals,
      },
      trend,
      classDistribution,
      gradeDistribution,
      categories,
      topPositiveRules,
      alerts: buildAlerts(db, scope, req.user, { classIds, termId: term?.id || "" }),
      recentRecords: recordViews(db, recent),
    });
  });

  // -------------------------------------------------------- 多维分析
  app.get("/api/analytics/overview", auth, requireStaff, (req, res) => {
    const schoolId = req.user.school_id;
    const explicitTermId = q(req, "termId");
    const term = resolveTerm(db, schoolId, explicitTermId);
    const config = settings.get(schoolId);
    const classId = q(req, "classId");
    const gradeId = q(req, "gradeId");
    const classIds = resolveScopeClassIds(db, scope, req.user, { classId, gradeId });
    const range = resolveWindow({ fromRaw: q(req, "from"), toRaw: q(req, "to"), term });
    // 同时给出 termId 与 from/to 时两个条件都生效；仅给 from/to 表示跨学期
    // 按时间筛选；都不给时默认当前学期。
    const windowTermId = range.hasExplicitRange ? (explicitTermId ? term?.id || "" : "") : term?.id || "";
    const empty = {
      term: termView(term),
      range: { from: range.fromDate, to: range.toDate },
      kpis: { studentCount: 0, classCount: 0, avgScore: 0, totalAdds: 0, totalDeducts: 0, net: 0, recordCount: 0 },
      trend: fillTrend([], range.fromDate, range.toDate),
      categories: [],
      rules: [],
      classComparison: [],
      gradeComparison: [],
      timeComparison: {
        current: { adds: 0, deducts: 0, net: 0, recordCount: 0 },
        previous: { adds: 0, deducts: 0, net: 0, recordCount: 0 },
        label: "",
      },
    };
    if (classIds !== null && classIds.length === 0) return res.json(empty);

    const totals = studentTotalsInWindow(db, config, {
      schoolId,
      classIds,
      gradeId,
      termId: windowTermId,
      from: range.from,
      to: range.to,
    });
    const aggregate = recordAggregate(db, scope, req.user, {
      termId: windowTermId,
      from: range.from,
      to: range.to,
      classIds,
      gradeId,
    });
    const classComparison = comparisonBy(totals.rows, classMeta(db, schoolId, classIds), "class", "classId");
    const gradeComparison = comparisonBy(totals.rows, gradeMeta(db, schoolId, scopedGradeIds(db, scope, req.user)), "grade", "gradeId");
    const trend = fillTrend(
      scoreTrend(db, {
        termId: windowTermId,
        from: range.from,
        to: range.to,
        classIds,
        gradeId,
      }),
      range.fromDate,
      range.toDate,
    );
    const categories = categoryBreakdown(db, {
      termId: windowTermId,
      from: range.from,
      to: range.to,
      classIds,
      gradeId,
    }).map((row) => ({
      categoryId: row.category_id,
      categoryName: row.category_name,
      direction: row.direction,
      recordCount: row.record_count,
      magnitude: row.magnitude,
      net: row.net,
    }));
    const rules = ruleBreakdown(db, {
      termId: windowTermId,
      from: range.from,
      to: range.to,
      classIds,
      gradeId,
    }).map((row) => ({
      ruleName: row.rule_name || row.category_name || "未命名规则",
      categoryName: row.category_name,
      direction: row.direction,
      recordCount: row.record_count,
      studentCount: row.student_count,
      magnitude: row.magnitude,
    }));

    // 时间对比：当前窗口 vs 等长的上一窗口（按自然日），用于观察变化趋势。
    const windowDays = Math.max(
      1,
      Math.round(
        (new Date(`${range.toDate}T00:00:00.000Z`) - new Date(`${range.fromDate}T00:00:00.000Z`)) / DAY_MS,
      ) + 1,
    );
    const previousToDate = addDays(range.fromDate, -1);
    const previousFromDate = addDays(previousToDate, -(windowDays - 1));
    const current = recordAggregate(db, scope, req.user, {
      from: range.from,
      to: range.to,
      classIds,
      gradeId,
      termId: "",
    });
    const previous = recordAggregate(db, scope, req.user, {
      from: `${previousFromDate}T00:00:00.000Z`,
      to: `${addDays(previousToDate, 1)}T00:00:00.000Z`,
      classIds,
      gradeId,
      termId: "",
    });

    res.json({
      term: termView(term),
      range: { from: range.fromDate, to: range.toDate },
      kpis: {
        studentCount: totals.studentCount,
        classCount:
          classIds === null
            ? Number(
                db
                  .prepare(
                    `SELECT COUNT(*) AS count FROM classes WHERE school_id=? ${gradeId ? "AND grade_id=?" : ""}`,
                  )
                  .get(...(gradeId ? [schoolId, gradeId] : [schoolId])).count,
              )
            : classIds.length,
        avgScore: totals.avgScore,
        totalAdds: aggregate.adds,
        totalDeducts: aggregate.deducts,
        net: aggregate.net,
        recordCount: aggregate.recordCount,
      },
      trend,
      categories,
      rules,
      classComparison,
      gradeComparison,
      timeComparison: {
        current: {
          adds: current.adds,
          deducts: current.deducts,
          net: current.net,
          recordCount: current.recordCount,
        },
        previous: {
          adds: previous.adds,
          deducts: previous.deducts,
          net: previous.net,
          recordCount: previous.recordCount,
        },
        label: `当前统计期较上一统计期（${previousFromDate} 至 ${previousToDate}）`,
      },
    });
  });

  // -------------------------------------------------------- 学生分析
  app.get("/api/analytics/students/:id", auth, requireStaff, (req, res) => {
    const schoolId = req.user.school_id;
    const student = scope.assertStudentAccess(req.user, String(req.params.id));
    const term = resolveTerm(db, schoolId, q(req, "termId"));
    const config = settings.get(schoolId);
    const score = term
      ? studentTermScore(db, config, { studentId: student.id, termId: term.id })
      : {
          initialPoints: config.initialPoints,
          adds: 0,
          deducts: 0,
          net: 0,
          recordCount: 0,
          total: config.initialPoints,
        };
    const range = term
      ? { fromDate: term.start_date, toDate: today() > term.end_date ? term.end_date : today() }
      : { fromDate: addDays(today(), -29), toDate: today() };
    if (range.toDate < range.fromDate) range.toDate = range.fromDate;
    const categories = categoryBreakdown(db, {
      termId: term?.id || "",
      studentId: student.id,
      from: `${range.fromDate}T00:00:00.000Z`,
      to: `${addDays(range.toDate, 1)}T00:00:00.000Z`,
    }).map((row) => ({
      categoryName: row.category_name,
      direction: row.direction,
      recordCount: row.record_count,
      magnitude: row.magnitude,
      net: row.net,
    }));
    // ledger.scoreTrend 不支持按学生过滤，这里按学生做同样的按天聚合。
    const trendParams = [student.id, "EFFECTIVE", `${range.fromDate}T00:00:00.000Z`, `${addDays(range.toDate, 1)}T00:00:00.000Z`];
    let trendSql =
      "SELECT substr(occurrence_at,1,10) AS date, COUNT(*) AS record_count, " +
      "COALESCE(SUM(CASE WHEN signed_points>0 THEN signed_points ELSE 0 END),0) AS adds, " +
      "COALESCE(SUM(CASE WHEN signed_points<0 THEN -signed_points ELSE 0 END),0) AS deducts, " +
      "COALESCE(SUM(signed_points),0) AS net FROM score_records " +
      "WHERE student_id=? AND status=? AND occurrence_at>=? AND occurrence_at<?";
    if (term) {
      trendSql += " AND term_id=?";
      trendParams.push(term.id);
    }
    trendSql += " GROUP BY date ORDER BY date";
    const trend = fillTrend(db.prepare(trendSql).all(...trendParams), range.fromDate, range.toDate);
    const recent = db
      .prepare(
        `SELECT * FROM score_records WHERE student_id=? ${term ? "AND term_id=?" : ""}
         ORDER BY occurrence_at DESC, created_at DESC LIMIT 10`,
      )
      .all(...(term ? [student.id, term.id] : [student.id]));
    res.json({
      student: {
        id: student.id,
        name: student.name,
        studentNo: student.student_no,
        classId: student.class_id,
        className: student.class_name,
        gradeName: student.grade_name,
        status: student.status,
      },
      term: termView(term),
      score: {
        initialPoints: score.initialPoints,
        adds: score.adds,
        deducts: score.deducts,
        total: score.total,
        recordCount: score.recordCount,
      },
      categories,
      trend,
      recentRecords: recordViews(db, recent),
    });
  });

  // ------------------------------------------------------- CSV 导出
  app.get("/api/analytics/export.csv", auth, requireStaff, (req, res) => {
    const type = q(req, "type") || "records";
    if (!["classes", "records", "students"].includes(type)) throw httpError(400, "导出类型必须为 classes/records/students");
    const schoolId = req.user.school_id;
    const explicitTermId = q(req, "termId");
    const term = resolveTerm(db, schoolId, explicitTermId);
    const config = settings.get(schoolId);
    const classId = q(req, "classId");
    const gradeId = q(req, "gradeId");
    const classIds = resolveScopeClassIds(db, scope, req.user, { classId, gradeId });
    const range = resolveWindow({ fromRaw: q(req, "from"), toRaw: q(req, "to"), term });
    const windowTermId = range.hasExplicitRange ? (explicitTermId ? term?.id || "" : "") : term?.id || "";
    if (classIds !== null && classIds.length === 0) {
      return ctx.sendCsv(res, `analytics-${type}-${today()}.csv`, ["暂无数据"], [["当前账号没有可导出的授权范围"]]);
    }

    if (type === "classes") {
      const totals = studentTotalsInWindow(db, config, {
        schoolId,
        classIds,
        gradeId,
        termId: windowTermId,
        from: range.from,
        to: range.to,
      });
      const rows = comparisonBy(totals.rows, classMeta(db, schoolId, classIds), "class", "classId");
      return ctx.sendCsv(
        res,
        `analytics-classes-${range.fromDate}-${range.toDate}.csv`,
        ["年级", "班级", "学生数", "人均分", "加分", "减分", "净变化", "记录数"],
        rows.map((row) => [
          row.gradeName,
          row.className,
          row.studentCount,
          row.avgScore,
          row.adds,
          row.deducts,
          row.net,
          row.recordCount,
        ]),
      );
    }

    if (type === "students") {
      const totals = studentTotalsInWindow(db, config, {
        schoolId,
        classIds,
        gradeId,
        termId: windowTermId,
        from: range.from,
        to: range.to,
      });
      const studentRows = totals.rows
        .map((row) => ({
          ...row,
          student: db.prepare("SELECT name,student_no,class_id FROM students WHERE id=?").get(row.studentId),
        }))
        .filter((row) => row.student);
      const meta = classMeta(db, schoolId, classIds);
      const gradeMap = gradeMeta(db, schoolId, scopedGradeIds(db, scope, req.user));
      const gradeNameByClass = new Map(
        [...meta.values()].map((row) => [row.id, gradeMap.get(row.grade_id)?.name || row.grade_name]),
      );
      const tokens = studentRows
        .map((row) => ({
          name: row.student.name,
          studentNo: row.student.student_no,
          classId: row.student.class_id,
          className: meta.get(row.student.class_id)?.name || "",
          gradeName: gradeNameByClass.get(row.student.class_id) || "",
          total: row.total,
          adds: row.adds,
          deducts: row.deducts,
          recordCount: row.recordCount,
        }))
        .sort(
          (left, right) =>
            left.gradeName.localeCompare(right.gradeName) ||
            left.className.localeCompare(right.className) ||
            right.total - left.total,
        );
      return ctx.sendCsv(
        res,
        `analytics-students-${range.fromDate}-${range.toDate}.csv`,
        ["年级", "班级", "姓名", "学号", "得分", "加分", "减分", "记录数"],
        tokens.map((row) => [row.gradeName, row.className, row.name, row.studentNo, row.total, row.adds, row.deducts, row.recordCount]),
      );
    }

    // records：明细导出同样受数据范围与筛选条件约束。
    const where = recordListWhere({
      termId: windowTermId,
      classIds,
      classId,
      gradeId,
      from: range.from,
      to: range.to,
      search: q(req, "search"),
      direction: (() => {
        const direction = q(req, "direction");
        if (!direction) return "";
        if (!["ADD", "DEDUCT"].includes(direction)) throw httpError(400, "加减分方向无效");
        return direction;
      })(),
    });
    const rows = db
      .prepare(
        `SELECT r.* FROM score_records r JOIN students s ON s.id=r.student_id
         WHERE ${where.where}
         ORDER BY r.occurrence_at DESC, r.created_at DESC LIMIT 5000`,
      )
      .all(...where.params);
    const views = recordViews(db, rows);
    return ctx.sendCsv(
      res,
      `analytics-records-${range.fromDate}-${range.toDate}.csv`,
      ["日期", "学生", "学号", "年级", "班级", "分类", "规则", "方向", "分值", "状态", "说明", "记录人"],
      views.map((view) => [
        view.occurrenceAt?.slice(0, 10) || "",
        view.studentName,
        view.studentNo,
        view.gradeName,
        view.className,
        view.categoryName,
        view.ruleName,
        view.directionLabel,
        view.points,
        view.statusLabel,
        view.note,
        view.submitterName,
      ]),
    );
  });
}
