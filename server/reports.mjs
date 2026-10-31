// 成长报告模块（backend-data）：学生周/月/学期成长报告、班级报告与 CSV 导出。
// 报告结构见 docs/ARCHITECTURE.md 5.3；narrative 使用确定性中文模板，只做
// 客观描述与正向引导，不出现标签化/羞辱性措辞。家长分享模块复用内部函数。
import { httpError, today } from "./core.mjs";
import {
  categoryBreakdown,
  classScoreSummaries,
  resolveTermForDate,
  ruleBreakdown,
  scoreTrend,
  studentTermScores,
  studentTermScore,
} from "./ledger.mjs";

const PRIVACY_NOTE = "仅限授权家长查看，不展示班级排名与其他学生信息";
const PERIOD_TYPES = ["week", "month", "term"];
const PERIOD_LABELS = { week: "周报告", month: "月报告", term: "学期报告" };

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(new Date(`${raw}T00:00:00.000Z`).getTime()))
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

function fillDays(rows, fromDate, toDate) {
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

function periodWindow(db, schoolId, { period, date, termId }) {
  const type = PERIOD_TYPES.includes(period) ? period : "week";
  if (type === "term") {
    const term = resolveTerm(db, schoolId, termId);
    if (!term) throw httpError(400, "尚未配置当前学期，无法生成学期报告");
    return {
      type,
      label: `${term.name}成长报告`,
      fromDate: term.start_date,
      toDate: term.end_date,
      term,
    };
  }
  const day = date ? parseDay(date, "报告日期") : today();
  let term = null;
  try {
    term = resolveTermForDate(db, schoolId, `${day}T00:00:00.000Z`);
  } catch {
    term = currentTermRow(db, schoolId);
  }
  if (!term) throw httpError(400, "所选日期不在任何学期内，请先在系统设置中维护学年学期");
  let fromDate;
  let toDate;
  let labelSuffix = "";
  if (type === "week") {
    const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay(); // 0=周日
    const offset = (weekday + 6) % 7; // 周一为 0
    fromDate = addDays(day, -offset);
    toDate = addDays(fromDate, 6);
    labelSuffix = "周报告";
  } else {
    fromDate = `${day.slice(0, 7)}-01`;
    const nextMonth = addDays(`${day.slice(0, 7)}-28`, 4);
    toDate = addDays(`${nextMonth.slice(0, 7)}-01`, -1);
    labelSuffix = `${day.slice(0, 4)} 年 ${Number(day.slice(5, 7))} 月报告`;
  }
  // 裁剪到学期范围，保证报告不跨学期统计。
  if (fromDate < term.start_date) fromDate = term.start_date;
  if (toDate > term.end_date) toDate = term.end_date;
  if (fromDate > toDate) throw httpError(400, "所选周期不在任何学期范围内");
  const label = type === "week" ? `${fromDate} 至 ${toDate} ${labelSuffix}` : labelSuffix;
  return { type, label, fromDate, toDate, term };
}

function periodRangeIso(window) {
  return {
    from: `${window.fromDate}T00:00:00.000Z`,
    to: `${addDays(window.toDate, 1)}T00:00:00.000Z`,
  };
}

function studentPeriodScore(db, settings, { studentId, termId, from, to }) {
  const aggregate = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN signed_points>0 THEN signed_points ELSE 0 END),0) AS adds,
         COALESCE(SUM(CASE WHEN signed_points<0 THEN -signed_points ELSE 0 END),0) AS deducts,
         COALESCE(SUM(signed_points),0) AS net,
         COUNT(*) AS record_count
       FROM score_records
       WHERE student_id=? AND status='EFFECTIVE' AND occurrence_at>=? AND occurrence_at<? AND term_id=?`,
    )
    .get(studentId, from, to, termId);
  const raw = settings.initialPoints + aggregate.net;
  return {
    initialPoints: settings.initialPoints,
    adds: aggregate.adds,
    deducts: aggregate.deducts,
    net: aggregate.net,
    recordCount: aggregate.record_count,
    total: settings.allowNegative ? raw : Math.max(0, raw),
  };
}

function studentDailyTrend(db, { studentId, termId, from, to }) {
  return db
    .prepare(
      `SELECT substr(occurrence_at,1,10) AS date,
         COALESCE(SUM(CASE WHEN signed_points>0 THEN signed_points ELSE 0 END),0) AS adds,
         COALESCE(SUM(CASE WHEN signed_points<0 THEN -signed_points ELSE 0 END),0) AS deducts,
         COALESCE(SUM(signed_points),0) AS net,
         COUNT(*) AS record_count
       FROM score_records
       WHERE student_id=? AND term_id=? AND status='EFFECTIVE' AND occurrence_at>=? AND occurrence_at<?
       GROUP BY date ORDER BY date`,
    )
    .all(studentId, termId, from, to);
}

function safeJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "null");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function buildNarrative({ student, window, score, highlights, attention, level }) {
  const name = student.name;
  const lines = [];
  const netText = score.net >= 0 ? `+${score.net}` : String(score.net);
  lines.push(
    `本${level}（${window.fromDate} 至 ${window.toDate}），${name}同学共获得 ${score.adds} 分加分、${score.deducts} 分减分，净变化 ${netText} 分。`,
  );
  if (highlights.length) {
    const names = [...new Set(highlights.map((item) => item.ruleName).filter(Boolean))].slice(0, 3);
    lines.push(
      `积极表现：在${names.map((item) => `「${item}」`).join("、")}等方面获得认可，说明良好的行为习惯正在形成。`,
    );
  }
  if (attention.length) {
    const categories = attention.slice(0, 3).map((item) => `「${item.categoryName}」`);
    lines.push(
      `需要关注：本周期在${categories.join("、")}等类别出现了 ${attention.reduce(
        (sum, item) => sum + item.recordCount,
        0,
      )} 次减分记录，建议家长与孩子一起回顾具体情境，共同约定下一步的改进行动。`,
    );
  } else if (score.recordCount > 0) {
    lines.push("本周期没有减分记录，建议及时肯定孩子保持自律的努力。");
  } else {
    lines.push("本周期暂无积分记录，建议家长与班主任了解孩子近期的在校表现，共同关注成长过程。");
  }
  if (score.net >= 0) {
    lines.push("整体表现保持积极，建议继续保持良好的学习和行为习惯。");
  } else {
    lines.push("本周期出现了一些需要改进的方面，这是成长过程中的正常现象，建议家长与学校保持沟通、共同支持孩子进步。");
  }
  lines.push(
    "家庭配合建议：每天用几分钟与孩子交流在校感受，关注具体行为背后的原因；对进步及时给予具体、真诚的肯定，避免使用标签化评价。",
  );
  return lines;
}

/**
 * 生成单个学生的成长报告（周/月/学期）。可被家长分享模块复用：
 * 传入 student 必须包含 id/name/student_no/class_name/grade_name。
 */
export function buildStudentReport(db, settings, { student, period = "week", date = "", termId = "" }) {
  const window = periodWindow(db, student.school_id, { period, date, termId });
  const range = periodRangeIso(window);
  const score = studentPeriodScore(db, settings, {
    studentId: student.id,
    termId: window.term.id,
    from: range.from,
    to: range.to,
  });
  const composition = categoryBreakdown(db, {
    termId: window.term.id,
    studentId: student.id,
    from: range.from,
    to: range.to,
  }).map((row) => ({
    categoryName: row.category_name,
    direction: row.direction,
    recordCount: row.record_count,
    magnitude: row.magnitude,
  }));
  // 趋势只展示到今天，避免周/月报告出现大量未来日期的零值。
  const trendToDate = window.toDate > today() ? today() : window.toDate;
  const trend =
    trendToDate >= window.fromDate
      ? fillDays(
          studentDailyTrend(db, {
            studentId: student.id,
            termId: window.term.id,
            from: range.from,
            to: `${addDays(trendToDate, 1)}T00:00:00.000Z`,
          }),
          window.fromDate,
          trendToDate,
        )
      : [];
  const highlightRows = db
    .prepare(
      `SELECT occurrence_at, points, note, category_name,
         json_extract(rule_snapshot_json,'$.name') AS rule_name
       FROM score_records
       WHERE student_id=? AND term_id=? AND status='EFFECTIVE' AND direction='ADD'
         AND occurrence_at>=? AND occurrence_at<?
       ORDER BY points DESC, occurrence_at DESC LIMIT 5`,
    )
    .all(student.id, window.term.id, range.from, range.to);
  const highlights = highlightRows.map((row) => ({
    ruleName: row.rule_name || row.category_name || "记分记录",
    points: row.points,
    note: row.note,
    occurrenceAt: row.occurrence_at,
    categoryName: row.category_name,
  }));
  const attention = categoryBreakdown(db, {
    termId: window.term.id,
    studentId: student.id,
    from: range.from,
    to: range.to,
  })
    .filter((row) => row.direction === "DEDUCT")
    .slice(0, 5)
    .map((row) => ({
      categoryName: row.category_name,
      recordCount: row.record_count,
      magnitude: row.magnitude,
    }));
  const explanationRows = db
    .prepare(
      `SELECT DISTINCT rule_id, rule_snapshot_json FROM score_records
       WHERE student_id=? AND term_id=? AND status='EFFECTIVE' AND occurrence_at>=? AND occurrence_at<?
         AND rule_id IS NOT NULL`,
    )
    .all(student.id, window.term.id, range.from, range.to);
  const ruleExplanations = [];
  for (const row of explanationRows) {
    const snapshot = safeJson(row.rule_snapshot_json, {}) || {};
    if (!snapshot.name) continue;
    ruleExplanations.push({
      name: snapshot.name,
      description: snapshot.description || "",
      examples: snapshot.examples || "",
      direction: snapshot.direction || "",
      points: snapshot.points || 0,
    });
    if (ruleExplanations.length >= 10) break;
  }

  // 荣誉/兑换参考按「本学期」累计口径计算，避免周报/月报误判学期荣誉。
  const termScore = studentTermScore(db, settings, { studentId: student.id, termId: window.term.id });
  const positiveRecordsTerm = db
    .prepare(
      `SELECT COUNT(*) AS count FROM score_records
       WHERE student_id=? AND term_id=? AND status='EFFECTIVE' AND direction='ADD'`,
    )
    .get(student.id, window.term.id).count;
  const honorRows = db
    .prepare(
      `SELECT name,description,min_points,min_positive_records FROM honor_rules
       WHERE school_id=? AND is_enabled=1 ORDER BY sort_order, name`,
    )
    .all(student.school_id);
  const honors = honorRows.map((row) => {
    const pointsEnough = termScore.total >= row.min_points;
    const recordsEnough = positiveRecordsTerm >= row.min_positive_records;
    const eligible = pointsEnough && recordsEnough;
    const pointGap = Math.max(0, row.min_points - termScore.total);
    const recordGap = Math.max(0, row.min_positive_records - positiveRecordsTerm);
    return {
      name: row.name,
      description: row.description,
      eligible,
      reason: eligible
        ? `满足参考条件（本学期积分 ${termScore.total} 分，正向记录 ${positiveRecordsTerm} 次）`
        : `仅作参考：本学期积分还需 ${pointGap} 分、正向记录还需 ${recordGap} 次，最终以学校评选结果为准`,
    };
  });
  const rewards = db
    .prepare(
      `SELECT name,description,points_cost FROM reward_items
       WHERE school_id=? AND is_enabled=1 ORDER BY sort_order, name`,
    )
    .all(student.school_id)
    .map((row) => ({
      name: row.name,
      description: row.description,
      pointsCost: row.points_cost,
      affordable: termScore.total >= row.points_cost,
    }));

  return {
    student: {
      id: student.id,
      name: student.name,
      studentNo: student.student_no,
      className: student.class_name,
      gradeName: student.grade_name,
    },
    period: {
      type: window.type,
      label: window.label,
      from: window.fromDate,
      to: window.toDate,
    },
    score,
    composition,
    trend,
    highlights,
    attention,
    ruleExplanations,
    honors,
    rewards,
    narrative: buildNarrative({
      student,
      window,
      score,
      highlights,
      attention,
      level: PERIOD_LABELS[window.type].replace("报告", ""),
    }),
    privacyNote: PRIVACY_NOTE,
    term: termView(window.term),
  };
}

export function registerReportRoutes(app, ctx) {
  const { db, auth, requireStaff, scope, settings } = ctx;

  app.get("/api/reports/student/:id", auth, requireStaff, (req, res) => {
    const period = q(req, "period") || "week";
    if (!PERIOD_TYPES.includes(period)) throw httpError(400, "报告周期必须为 week/month/term");
    const student = scope.assertStudentAccess(req.user, String(req.params.id));
    const report = buildStudentReport(db, settings.get(req.user.school_id), {
      student,
      period,
      date: q(req, "date"),
      termId: q(req, "termId"),
    });
    res.json(report);
  });

  app.get("/api/reports/student/:id/export.csv", auth, requireStaff, (req, res) => {
    const period = q(req, "period") || "week";
    if (!PERIOD_TYPES.includes(period)) throw httpError(400, "报告周期必须为 week/month/term");
    const student = scope.assertStudentAccess(req.user, String(req.params.id));
    const report = buildStudentReport(db, settings.get(req.user.school_id), {
      student,
      period,
      date: q(req, "date"),
      termId: q(req, "termId"),
    });
    const rows = [];
    rows.push(["概览", "学生", report.student.name, report.student.className]);
    rows.push(["概览", "报告周期", report.period.label, `${report.period.from} 至 ${report.period.to}`]);
    rows.push(["概览", "初始分", report.score.initialPoints, ""]);
    rows.push(["概览", "加分", report.score.adds, ""]);
    rows.push(["概览", "减分", report.score.deducts, ""]);
    rows.push(["概览", "净变化", report.score.net, ""]);
    rows.push(["概览", "周期得分", report.score.total, ""]);
    rows.push(["概览", "记录数", report.score.recordCount, ""]);
    for (const item of report.composition)
      rows.push(["积分构成", item.categoryName, `${item.direction === "ADD" ? "加分" : "减分"} ${item.magnitude} 分`, `${item.recordCount} 条`]);
    for (const day of report.trend) rows.push(["每日趋势", day.date, `+${day.adds} / -${day.deducts}`, `净 ${day.net}`]);
    for (const item of report.highlights)
      rows.push(["积极表现", item.ruleName, `${item.points} 分`, `${item.occurrenceAt?.slice(0, 10) || ""} ${item.note}`]);
    for (const item of report.attention)
      rows.push(["需要关注", item.categoryName, `减分 ${item.magnitude} 分`, `${item.recordCount} 条`]);
    for (const item of report.honors)
      rows.push(["荣誉参考", item.name, item.eligible ? "满足参考条件" : "暂未满足", item.reason]);
    for (const item of report.rewards)
      rows.push(["兑换参考", item.name, `${item.pointsCost} 分`, item.affordable ? "可参考兑换" : "积分不足"]);
    report.narrative.forEach((line, index) => rows.push(["成长叙事", `第 ${index + 1} 段`, line, ""]));
    rows.push(["隐私提示", PRIVACY_NOTE, "", ""]);
    ctx.sendCsv(
      res,
      `report-${report.student.id}-${report.period.type}-${report.period.from}-${report.period.to}.csv`,
      ["区块", "项目", "数值", "说明"],
      rows,
    );
  });

  app.get("/api/reports/class/:id", auth, requireStaff, (req, res) => {
    const schoolId = req.user.school_id;
    const classId = String(req.params.id);
    scope.assertClassAccess(req.user, classId);
    const klass = db
      .prepare(
        `SELECT c.id,c.name,g.name AS grade_name FROM classes c JOIN grades g ON g.id=c.grade_id
         WHERE c.id=? AND c.school_id=?`,
      )
      .get(classId, schoolId);
    if (!klass) throw httpError(404, "班级不存在");
    const term = resolveTerm(db, schoolId, q(req, "termId"));
    if (!term) throw httpError(400, "尚未配置当前学期，无法生成班级报告");
    const config = settings.get(schoolId);
    const range = {
      fromDate: term.start_date,
      toDate: today() > term.end_date ? term.end_date : today(),
    };
    if (range.toDate < range.fromDate) range.toDate = range.fromDate;
    const rangeIso = {
      from: `${range.fromDate}T00:00:00.000Z`,
      to: `${addDays(range.toDate, 1)}T00:00:00.000Z`,
    };
    const students = db
      .prepare(
        `SELECT s.id,s.name,s.student_no,s.gender FROM students s
         WHERE s.class_id=? AND s.status='ACTIVE' ORDER BY s.student_no`,
      )
      .all(classId);
    const scoreMap = studentTermScores(db, config, {
      studentIds: students.map((row) => row.id),
      termId: term.id,
    });
    const studentRows = students
      .map((row) => {
        const score = scoreMap.get(row.id);
        return {
          id: row.id,
          name: row.name,
          studentNo: row.student_no,
          total: score.total,
          adds: score.adds,
          deducts: score.deducts,
          recordCount: score.recordCount,
        };
      })
      .sort((left, right) => right.total - left.total || left.studentNo.localeCompare(right.studentNo));
    const summary =
      classScoreSummaries(db, config, { termId: term.id, classIds: [classId] })[0] || {
        avgScore: 0,
        adds: 0,
        deducts: 0,
        net: 0,
        recordCount: 0,
        studentCount: students.length,
      };
    const categories = categoryBreakdown(db, { termId: term.id, classIds: [classId] }).map((row) => ({
      categoryName: row.category_name,
      direction: row.direction,
      recordCount: row.record_count,
      magnitude: row.magnitude,
    }));
    const trend = fillDays(
      scoreTrend(db, { termId: term.id, classIds: [classId], from: rangeIso.from, to: rangeIso.to }),
      range.fromDate,
      range.toDate,
    );
    const ruleRows = ruleBreakdown(db, { termId: term.id, classIds: [classId] });
    const topPositiveRules = ruleRows
      .filter((row) => row.direction === "ADD")
      .slice(0, 5)
      .map((row) => ({
        ruleName: row.rule_name || row.category_name || "未命名规则",
        recordCount: row.record_count,
        magnitude: row.magnitude,
      }));
    const attentionRules = ruleRows
      .filter((row) => row.direction === "DEDUCT")
      .slice(0, 5)
      .map((row) => ({
        ruleName: row.rule_name || row.category_name || "未命名规则",
        recordCount: row.record_count,
        magnitude: row.magnitude,
      }));
    res.json({
      class: {
        id: klass.id,
        name: klass.name,
        gradeName: klass.grade_name,
        studentCount: students.length,
      },
      term: termView(term),
      period: { from: range.fromDate, to: range.toDate },
      avgScore: summary.avgScore,
      adds: summary.adds,
      deducts: summary.deducts,
      net: summary.net,
      recordCount: summary.recordCount,
      categories,
      trend,
      students: studentRows,
      topPositiveRules,
      attentionRules,
    });
  });
}
