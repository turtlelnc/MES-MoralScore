// OWNER: frontend-insight. 成长报告：学生周/月/学期报告、班级报告、打印与 CSV 导出。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Award,
  BookOpen,
  Copy,
  Download,
  Gift,
  Link2,
  Printer,
  RefreshCw,
  Search,
  Sprout,
  Users,
} from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, download, query, ApiError } from "../api";
import { formatDateTime, formatMonthDay, formatScore, formatSignedScore, todayInput } from "../format";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Segmented,
  Select,
  cn,
  useToast,
} from "../components/ui";
import type {
  ClassReport,
  OptionsData,
  PageProps,
  StudentReport,
} from "../types";

/* ------------------------------------------------------------------ helpers */

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录状态已失效，请重新登录";
    if (error.status === 403) return "没有权限查看该学生/班级的报告，请确认数据范围";
    if (error.status === 404) return error.message || "学生或报告不存在";
    if (error.status === 400) return error.message || "报告参数不符合要求";
    if (error.status >= 500) return "服务暂时不可用，请稍后重试";
    return error.message;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") return "请求超时，请稍后重试";
  return "网络异常，请检查网络后重试";
}

type PeriodType = "week" | "month" | "term";

interface StudentOption {
  id: string;
  name: string;
  studentNo?: string;
  className?: string;
  classId?: string;
  gradeName?: string;
}

interface SelectedStudent {
  id: string;
  name: string;
}

interface CreatedShare {
  link: string;
  expiresAt: string;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 退回到 execCommand 方案
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ name?: string | number; value?: number | string | Array<number | string>; dataKey?: string | number; color?: string }>;
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="chart-tooltip">
      {label !== undefined && label !== null && <strong>{String(label)}</strong>}
      {payload.map((entry, index) => (
        <div key={`${String(entry.dataKey ?? index)}-${index}`}>
          <span className="legend-dot" style={{ background: entry.color || "var(--brand)" }} />
          {String(entry.name ?? entry.dataKey ?? "")}：{formatScore(Number(entry.value))} 分
        </div>
      ))}
    </div>
  );
}

function TrendChart({
  data,
  periodText,
}: {
  data: Array<{ date: string; adds: number; deducts: number; net: number }>;
  periodText: string;
}) {
  if (!data || data.length === 0) {
    return <EmptyState compact title="本期暂无趋势数据" description="该周期内没有已生效的积分记录。" />;
  }
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, left: -14, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(value: string) => formatMonthDay(value)}
            tick={{ fontSize: 11, fill: "#8b96a9" }}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            minTickGap={18}
          />
          <YAxis tick={{ fontSize: 11, fill: "#8b96a9" }} tickLine={false} axisLine={false} width={44} />
          <Tooltip content={<ChartTooltip />} />
          <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
          <Line type="monotone" dataKey="adds" name="加分" stroke="var(--add)" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="deducts" name="减分" stroke="var(--deduct)" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="net" name="净分" stroke="var(--brand)" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function CompositionList({
  items,
  direction,
  emptyText,
}: {
  items: Array<{ categoryName: string; recordCount: number; magnitude: number }>;
  direction: "ADD" | "DEDUCT";
  emptyText: string;
}) {
  if (items.length === 0) {
    return <p className="muted text-xs">{emptyText}</p>;
  }
  const max = Math.max(1, ...items.map((item) => Math.abs(Number(item.magnitude) || 0)));
  return (
    <div className="stack gap-sm">
      {items.map((item) => {
        const width = Math.max(4, Math.round((Math.abs(Number(item.magnitude) || 0) / max) * 100));
        return (
          <div
            className="bar-row"
            key={`${direction}-${item.categoryName}`}
            style={{ gridTemplateColumns: "minmax(76px, 1.1fr) minmax(50px, 2fr) auto" }}
          >
            <span className="bar-label" title={item.categoryName}>
              {item.categoryName}
            </span>
            <div className="bar-track">
              <div className={cn("bar-fill", direction === "ADD" ? "add" : "deduct")} style={{ width: `${width}%` }} />
            </div>
            <span className="bar-value no-wrap">
              {formatScore(item.magnitude)} 分 · {item.recordCount} 条
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------- page */

export function ReportsPage({ user, params }: PageProps) {
  const toast = useToast();
  const initialStudentId = params.studentId || "";
  const [mode, setMode] = useState<"student" | "class">(() =>
    params.studentId ? "student" : params.classId ? "class" : "student",
  );

  /* ------------------------------------------------------------ shared options */
  const [options, setOptions] = useState<OptionsData | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState("");

  const loadOptions = useCallback(async () => {
    setOptionsLoading(true);
    setOptionsError("");
    try {
      const result = await api<OptionsData>("/options");
      setOptions(result);
    } catch (requestError) {
      setOptionsError(errorText(requestError));
    } finally {
      setOptionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  /* ------------------------------------------------------------ student mode */
  const [selectedStudent, setSelectedStudent] = useState<SelectedStudent | null>(() =>
    initialStudentId ? { id: initialStudentId, name: "" } : null,
  );
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<StudentOption[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesError, setCandidatesError] = useState("");
  const [searchKey, setSearchKey] = useState(0);
  const [period, setPeriod] = useState<PeriodType>("week");
  const [date, setDate] = useState(todayInput());
  const [report, setReport] = useState<StudentReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  /* -------------------------------------------------------------- class mode */
  const [classId, setClassId] = useState(params.classId || "");
  const [termId, setTermId] = useState(user.currentTerm?.id ?? "");
  const [classReport, setClassReport] = useState<ClassReport | null>(null);
  const [classLoading, setClassLoading] = useState(false);
  const [classError, setClassError] = useState("");
  const [classReloadKey, setClassReloadKey] = useState(0);

  useEffect(() => {
    if (!options || termId) return;
    const current = options.terms.find((term) => term.isCurrent) || options.terms[0];
    if (current) setTermId(current.id);
  }, [options, termId]);

  // 学生搜索（防抖），用于选择器；GET /api/options/students?search=
  useEffect(() => {
    if (mode !== "student") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setCandidatesLoading(true);
      setCandidatesError("");
      api<{ items: StudentOption[] }>(
        `/options/students${query({ search: search.trim() || undefined })}`,
        { signal: controller.signal },
      )
        .then((data) => {
          if (controller.signal.aborted) return;
          setCandidates(data.items || []);
        })
        .catch((requestError) => {
          if (controller.signal.aborted) return;
          setCandidatesError(errorText(requestError));
        })
        .finally(() => {
          if (!controller.signal.aborted) setCandidatesLoading(false);
        });
    }, 280);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [mode, search, searchKey]);

  // 学生成长报告：GET /api/reports/student/:id?period=&date=
  useEffect(() => {
    if (mode !== "student" || !selectedStudent) {
      setReport(null);
      return;
    }
    const controller = new AbortController();
    setReportLoading(true);
    setReportError("");
    api<StudentReport>(
      `/reports/student/${selectedStudent.id}${query({ period, date: date || undefined })}`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setReport(data);
      })
      .catch((requestError) => {
        if (controller.signal.aborted) return;
        setReportError(errorText(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setReportLoading(false);
      });
    return () => controller.abort();
  }, [mode, selectedStudent, period, date, reloadKey]);

  // 班级报告：GET /api/reports/class/:classId?termId=
  useEffect(() => {
    if (mode !== "class" || !classId) {
      setClassReport(null);
      return;
    }
    const controller = new AbortController();
    setClassLoading(true);
    setClassError("");
    api<ClassReport>(`/reports/class/${classId}${query({ termId: termId || undefined })}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        setClassReport(data);
      })
      .catch((requestError) => {
        if (controller.signal.aborted) return;
        setClassError(errorText(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setClassLoading(false);
      });
    return () => controller.abort();
  }, [mode, classId, termId, classReloadKey]);

  const allStudents = useMemo(() => {
    const seen = new Set<string>();
    const result: StudentOption[] = [];
    for (const item of candidates) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      result.push(item);
    }
    return result.slice(0, 30);
  }, [candidates]);

  const selectedName =
    report?.student?.name || selectedStudent?.name || (selectedStudent ? "已选择的学生" : "");

  async function exportCsv() {
    if (!selectedStudent) return;
    setExporting(true);
    try {
      await download(
        `/reports/student/${selectedStudent.id}/export.csv${query({ period, date: date || undefined })}`,
        `成长报告-${selectedName || "学生"}.csv`,
      );
      toast("CSV 已开始下载", "success");
    } catch (requestError) {
      toast(errorText(requestError), "error");
    } finally {
      setExporting(false);
    }
  }

  function openClassStudent(student: { id: string; name: string }) {
    setSelectedStudent({ id: student.id, name: student.name });
    setMode("student");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function clearSelection() {
    setSelectedStudent(null);
    setReport(null);
    setSearch("");
  }

  const periodOptions: Array<{ value: PeriodType; label: string }> = [
    { value: "week", label: "本周" },
    { value: "month", label: "本月" },
    { value: "term", label: "本学期" },
  ];

  const modeSegment = (
    <Segmented
      value={mode}
      options={[
        { value: "student", label: "学生成长报告" },
        { value: "class", label: "班级报告" },
      ]}
      onChange={(next) => setMode(next)}
      ariaLabel="报告类型"
      size="sm"
    />
  );

  return (
    <div className="page">
      <div className="no-print">
        <PageHeader
          title="成长报告"
          description="面向家校沟通的周报/月报/学期报告：客观、中性、建设性，仅呈现学生本人在授权范围内的数据。"
          actions={
            <>
              {modeSegment}
              <Button
                variant="secondary"
                icon={<RefreshCw size={16} />}
                loading={mode === "student" ? reportLoading : classLoading}
                onClick={() => {
                  if (mode === "student") setReloadKey((key) => key + 1);
                  else setClassReloadKey((key) => key + 1);
                }}
              >
                刷新
              </Button>
            </>
          }
        />
      </div>

      {mode === "student" && (
        <>
          <Card
            className="no-print"
            title="选择学生与报告周期"
            subtitle="可搜索姓名或学号；周期由服务端按学校学期配置计算。"
          >
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
              <Field label="搜索学生">
                <div className="search-box">
                  <Search size={16} />
                  <Input
                    placeholder="输入姓名或学号"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
              </Field>
              <Field label="报告周期">
                <Segmented
                  value={period}
                  options={periodOptions}
                  onChange={(next) => setPeriod(next)}
                  ariaLabel="报告周期"
                />
              </Field>
              <Field label="参考日期" hint="周/月报告以该日期所在周期计算。">
                <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </Field>
            </div>

            {selectedStudent && (
              <div className="row" style={{ marginTop: 10, gap: 8 }}>
                <span className="muted text-xs">当前学生：</span>
                <Badge tone="brand">{selectedName}</Badge>
                {report?.student?.studentNo && <Badge tone="neutral">{report.student.studentNo}</Badge>}
                {report?.student?.className && (
                  <Badge tone="neutral">
                    {report.student.gradeName} {report.student.className}
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={clearSelection}>
                  更换学生
                </Button>
              </div>
            )}

            {!selectedStudent && (
              <div style={{ marginTop: 12 }}>
                {candidatesLoading && <Loading label="正在搜索学生…" />}
                {!candidatesLoading && candidatesError && (
                  <Alert
                    tone="danger"
                    title="学生列表加载失败"
                    onRetry={() => setSearchKey((key) => key + 1)}
                  >
                    {candidatesError}
                  </Alert>
                )}
                {!candidatesLoading && !candidatesError && allStudents.length === 0 && (
                  <EmptyState
                    compact
                    icon={<Search size={20} />}
                    title="未找到匹配学生"
                    description="请检查姓名或学号是否正确，或联系管理员确认数据范围。"
                  />
                )}
                {!candidatesLoading && !candidatesError && allStudents.length > 0 && (
                  <>
                    <div className="muted text-xs" style={{ marginBottom: 6 }}>
                      {search.trim() ? "搜索结果" : "可选择的学生"}（最多显示 30 个，输入关键词可精确查找）
                    </div>
                    <div className="list" style={{ maxHeight: 240, overflowY: "auto", paddingRight: 2 }}>
                      {allStudents.map((student) => (
                        <button
                          key={student.id}
                          type="button"
                          className="list-item"
                          style={{ textAlign: "left", width: "100%", cursor: "pointer" }}
                          onClick={() => {
                            setSelectedStudent({ id: student.id, name: student.name });
                            setSearch("");
                          }}
                        >
                          <span className="avatar-sm">{student.name.slice(0, 1)}</span>
                          <span className="list-main">
                            <span className="list-title">
                              {student.name}
                              {student.studentNo && (
                                <span className="muted text-xs mono">{student.studentNo}</span>
                              )}
                            </span>
                            {(student.gradeName || student.className) && (
                              <span className="list-sub">
                                {student.gradeName || ""} {student.className || ""}
                              </span>
                            )}
                          </span>
                          <span className="list-side muted text-xs">查看报告 →</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </Card>

          {reportError && (
            <div style={{ marginTop: 14 }}>
              <Alert
                tone="danger"
                title="成长报告加载失败"
                onRetry={() => setReloadKey((key) => key + 1)}
              >
                {reportError}
              </Alert>
            </div>
          )}

          {reportLoading && !report && (
            <div style={{ marginTop: 14 }}>
              <Card>
                <Loading label="正在生成成长报告…" />
              </Card>
            </div>
          )}

          {!reportLoading && !reportError && !selectedStudent && (
            <div style={{ marginTop: 14 }}>
              <Card>
                <EmptyState
                  icon={<Sprout size={22} />}
                  title="请选择一名学生生成成长报告"
                  description="成长报告包含积分构成、趋势、亮点记录、需要关注的行为类别（中性措辞）、规则解释、荣誉与兑换参考。"
                />
              </Card>
            </div>
          )}

          {report && (
            <>
              <div className="no-print row" style={{ justifyContent: "flex-end", margin: "14px 0 10px", gap: 8 }}>
                <Button
                  variant="secondary"
                  icon={<Printer size={16} />}
                  onClick={() => window.print()}
                >
                  打印报告
                </Button>
                <Button
                  variant="secondary"
                  icon={<Download size={16} />}
                  loading={exporting}
                  onClick={() => void exportCsv()}
                >
                  导出 CSV
                </Button>
                {user.permissions.manageShares && (
                  <Button
                    variant="secondary"
                    icon={<Link2 size={16} />}
                    onClick={() => setShareOpen(true)}
                  >
                    生成家长分享链接
                  </Button>
                )}
              </div>

              <article className="report-sheet">
                <header className="report-head">
                  <div>
                    <div className="report-student-name">{report.student.name}</div>
                    <div className="report-meta">
                      学号 {report.student.studentNo || "—"} · {report.student.gradeName}{" "}
                      {report.student.className}
                    </div>
                    <div className="report-meta">
                      {report.period.label}（{report.period.from} 至 {report.period.to}）
                    </div>
                  </div>
                  <div className="report-score-block">
                    <div className="big">
                      {formatScore(report.score.total)}
                      <small style={{ fontSize: 14, fontWeight: 600, marginLeft: 3 }}>分</small>
                    </div>
                    <div className="sub">当前周期得分</div>
                    <div className="sub">
                      本期净分 {formatSignedScore(report.score.net)} 分 · 记录 {report.score.recordCount} 条
                    </div>
                  </div>
                </header>

                <div className="report-grid">
                  <div className="report-stat">
                    <div className="report-stat-label">期初分</div>
                    <div className="report-stat-value">{formatScore(report.score.initialPoints)}</div>
                  </div>
                  <div className="report-stat">
                    <div className="report-stat-label">本期加分</div>
                    <div className="report-stat-value score-add">
                      {report.score.adds ? `+${formatScore(report.score.adds)}` : "0"}
                    </div>
                  </div>
                  <div className="report-stat">
                    <div className="report-stat-label">本期减分</div>
                    <div className="report-stat-value score-deduct">
                      {report.score.deducts ? `-${formatScore(report.score.deducts)}` : "0"}
                    </div>
                  </div>
                  <div className="report-stat">
                    <div className="report-stat-label">本期净分</div>
                    <div className="report-stat-value">{formatSignedScore(report.score.net)}</div>
                  </div>
                </div>

                <section className="report-section">
                  <h2 className="report-section-title">积分构成</h2>
                  <div className="grid cols-2">
                    <div className="record-card">
                      <div className="text-strong" style={{ marginBottom: 8 }}>
                        <Badge tone="add">加分构成</Badge>
                      </div>
                      <CompositionList
                        items={report.composition.filter((item) => item.direction === "ADD")}
                        direction="ADD"
                        emptyText="本期暂无加分记录。"
                      />
                    </div>
                    <div className="record-card">
                      <div className="text-strong" style={{ marginBottom: 8 }}>
                        <Badge tone="deduct">减分构成</Badge>
                      </div>
                      <CompositionList
                        items={report.composition.filter((item) => item.direction === "DEDUCT")}
                        direction="DEDUCT"
                        emptyText="本期暂无减分记录。"
                      />
                    </div>
                  </div>
                </section>

                <section className="report-section">
                  <h2 className="report-section-title">积分趋势（单位：分）</h2>
                  <div className="muted text-xs" style={{ marginBottom: 6 }}>
                    统计区间：{report.period.from} 至 {report.period.to}
                  </div>
                  <TrendChart data={report.trend} periodText={report.period.label} />
                </section>

                <section className="report-section">
                  <h2 className="report-section-title">本期亮点记录</h2>
                  {report.highlights.length === 0 ? (
                    <EmptyState compact title="本期暂无亮点记录" description="继续参与班级活动与志愿服务，会记录更多积极表现。" />
                  ) : (
                    <div className="list">
                      {report.highlights.map((highlight, index) => (
                        <div className="list-item" key={`highlight-${index}`}>
                          <div className="list-main">
                            <div className="list-title">
                              {highlight.ruleName}
                              <Badge tone="add">+{formatScore(highlight.points)} 分</Badge>
                              <span className="muted text-xs">{highlight.categoryName}</span>
                            </div>
                            <div className="list-sub">
                              {formatDateTime(highlight.occurrenceAt)}
                              {highlight.note ? ` · ${highlight.note}` : ""}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="report-section">
                  <h2 className="report-section-title">需要一起关注的行为类别</h2>
                  <div className="notice notice-info">
                    以下类别来自客观记录，仅用于家校沟通与正向引导，不构成对学生品德的评价；请关注行为背后的原因与改进方式。
                  </div>
                  {report.attention.length === 0 ? (
                    <div className="empty empty-compact">
                      <div className="empty-title">本期暂无需要特别关注的类别</div>
                      <div className="empty-desc">继续保持当前的良好表现即可。</div>
                    </div>
                  ) : (
                    <div className="stack gap-sm" style={{ marginTop: 8 }}>
                      {report.attention.map((item, index) => (
                        <div className="record-card" key={`attention-${index}`}>
                          <div className="list-title">
                            {item.categoryName}
                            <Badge tone="warning">发生 {item.recordCount} 次</Badge>
                            <span className="muted text-xs">合计 {formatScore(item.magnitude)} 分</span>
                          </div>
                          <div className="list-sub">
                            建议与班主任、家长一起回顾相关情景，明确规则要求与改进方向，避免简单贴标签。
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="report-section">
                  <h2 className="report-section-title">规则解释</h2>
                  {report.ruleExplanations.length === 0 ? (
                    <p className="muted text-xs">本期暂无涉及的评分规则。</p>
                  ) : (
                    <div className="stack gap-sm">
                      {report.ruleExplanations.map((rule, index) => (
                        <details className="record-card" key={`rule-${index}`}>
                          <summary style={{ cursor: "pointer", fontWeight: 620 }}>
                            {rule.name}
                            <span style={{ marginLeft: 8 }}>
                              <Badge tone={rule.direction === "ADD" ? "add" : "deduct"}>
                                {rule.direction === "ADD" ? "加分" : "减分"} {formatScore(rule.points)} 分
                              </Badge>
                            </span>
                          </summary>
                          <div className="list-sub" style={{ marginTop: 6 }}>
                            {rule.description || "—"}
                          </div>
                          {rule.examples && (
                            <div className="notice notice-info mt-2">示例：{rule.examples}</div>
                          )}
                        </details>
                      ))}
                    </div>
                  )}
                </section>

                <section className="report-section">
                  <h2 className="report-section-title">荣誉参考</h2>
                  <div className="notice notice-info">
                    荣誉仅为系统根据积分规则给出的参考结果，不作为评优、奖学金或处分的唯一依据。
                  </div>
                  {report.honors.length === 0 ? (
                    <p className="muted text-xs" style={{ marginTop: 8 }}>
                      本周期暂未配置可参考的荣誉项目。
                    </p>
                  ) : (
                    <div className="stack gap-sm" style={{ marginTop: 8 }}>
                      {report.honors.map((honor, index) => (
                        <div className={cn("report-honor", honor.eligible && "eligible")} key={`honor-${index}`}>
                          <Award size={18} className="report-honor-icon" />
                          <div>
                            <div className="list-title">
                              {honor.name}
                              <Badge tone={honor.eligible ? "success" : "neutral"}>
                                {honor.eligible ? "达到参考条件" : "暂未达到"}
                              </Badge>
                            </div>
                            <div className="list-sub">{honor.description || "—"}</div>
                            {!honor.eligible && honor.reason && (
                              <div className="list-sub">说明：{honor.reason}</div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="report-section">
                  <h2 className="report-section-title">兑换参考</h2>
                  <div className="notice notice-info">
                    兑换项目仅为参考展示，不会自动兑换；实际兑换以学校德育处安排为准。
                  </div>
                  {report.rewards.length === 0 ? (
                    <p className="muted text-xs" style={{ marginTop: 8 }}>
                      本周期暂未配置积分兑换项目。
                    </p>
                  ) : (
                    <div className="stack gap-sm" style={{ marginTop: 8 }}>
                      {report.rewards.map((reward, index) => (
                        <div className="report-honor" key={`reward-${index}`}>
                          <Gift size={18} className="report-honor-icon" style={{ color: "var(--brand)" }} />
                          <div>
                            <div className="list-title">
                              {reward.name}
                              <Badge tone={reward.affordable ? "success" : "neutral"}>
                                {reward.affordable ? "积分可参考兑换" : "积分暂不足"}
                              </Badge>
                              <span className="muted text-xs">需 {formatScore(reward.pointsCost)} 分</span>
                            </div>
                            <div className="list-sub">{reward.description || "—"}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="report-section">
                  <h2 className="report-section-title">成长寄语</h2>
                  <div className="report-narrative">
                    {report.narrative.length === 0 ? (
                      <p className="muted">暂无寄语内容。</p>
                    ) : (
                      report.narrative.map((paragraph, index) => <p key={`narrative-${index}`}>{paragraph}</p>)
                    )}
                  </div>
                </section>

                <footer className="privacy-foot">
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                    <BookOpen size={14} style={{ marginTop: 3, flex: "none" }} />
                    <span>
                      {report.privacyNote ||
                        "本报告仅用于学校内部教育管理与家校沟通，请勿公开传播；报告不构成对学生品德的绝对评价。"}
                    </span>
                  </div>
                </footer>

                <div className="print-only muted" style={{ marginTop: 14, fontSize: 11 }}>
                  MES-MoralScore 成长报告 · {report.student.name} · {report.period.label} · 打印时间{" "}
                  {formatDateTime(new Date())}
                </div>
              </article>

              {shareOpen && (
                <ShareCreateModal
                  studentId={report.student.id}
                  studentName={report.student.name}
                  onClose={() => setShareOpen(false)}
                />
              )}
            </>
          )}
        </>
      )}

      {mode === "class" && (
        <>
          <Card
            className="no-print"
            title="选择班级与学期"
            subtitle="班级报告展示班级人均分、学生列表、分类构成与趋势；班级数据仅限授权范围与班主任。"
          >
            {optionsError ? (
              <Alert tone="danger" title="班级/学期选项加载失败" onRetry={() => void loadOptions()}>
                {optionsError}
              </Alert>
            ) : (
              <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
                <Field label="班级" required>
                  <Select
                    value={classId}
                    onChange={(event) => setClassId(event.target.value)}
                    disabled={optionsLoading}
                  >
                    <option value="">{optionsLoading ? "正在加载班级…" : "请选择班级"}</option>
                    {(options?.classes ?? []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.gradeName} · {item.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="学期">
                  <Select value={termId} onChange={(event) => setTermId(event.target.value)}>
                    <option value="">当前学期</option>
                    {(options?.terms ?? []).map((term) => (
                      <option key={term.id} value={term.id}>
                        {term.name}
                        {term.isCurrent ? "（当前）" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            <div className="notice notice-info mt-2">
              班级报告使用「人均得分」口径并同时展示人数；如需学生个人报告，请在下方学生列表中点击「成长报告」。
            </div>
          </Card>

          {classError && (
            <div style={{ marginTop: 14 }}>
              <Alert
                tone="danger"
                title="班级报告加载失败"
                onRetry={() => setClassReloadKey((key) => key + 1)}
              >
                {classError}
              </Alert>
            </div>
          )}

          {classLoading && !classReport && (
            <div style={{ marginTop: 14 }}>
              <Card>
                <Loading label="正在生成班级报告…" />
              </Card>
            </div>
          )}

          {!classId && !classLoading && (
            <div style={{ marginTop: 14 }}>
              <Card>
                <EmptyState
                  icon={<Users size={22} />}
                  title="请选择要查看的班级"
                  description="班级报告可供班主任与德育处查看，普通值日老师仅能查看授权班级。"
                />
              </Card>
            </div>
          )}

          {classReport && (
            <>
              <div className="no-print row" style={{ justifyContent: "flex-end", margin: "14px 0 10px" }}>
                <Button variant="secondary" icon={<Printer size={16} />} onClick={() => window.print()}>
                  打印报告
                </Button>
              </div>

              <article className="report-sheet">
                <header className="report-head">
                  <div>
                    <div className="report-student-name">
                      {classReport.class.gradeName} {classReport.class.name}
                    </div>
                    <div className="report-meta">
                      班级成长报告 · {classReport.term?.name || "当前学期"} · 学生{" "}
                      {formatScore(classReport.class.studentCount)} 人
                    </div>
                  </div>
                  <div className="report-score-block">
                    <div className="big">
                      {formatScore(classReport.avgScore)}
                      <small style={{ fontSize: 14, fontWeight: 600, marginLeft: 3 }}>分</small>
                    </div>
                    <div className="sub">班级人均得分</div>
                    <div className="sub">
                      加分合计 {formatScore(classReport.adds)} · 减分合计 {formatScore(classReport.deducts)}
                    </div>
                  </div>
                </header>

                <div className="report-grid">
                  <div className="report-stat">
                    <div className="report-stat-label">学生人数</div>
                    <div className="report-stat-value">{formatScore(classReport.class.studentCount)}</div>
                  </div>
                  <div className="report-stat">
                    <div className="report-stat-label">人均得分</div>
                    <div className="report-stat-value">{formatScore(classReport.avgScore)}</div>
                  </div>
                  <div className="report-stat">
                    <div className="report-stat-label">加分合计</div>
                    <div className="report-stat-value score-add">
                      {classReport.adds ? `+${formatScore(classReport.adds)}` : "0"}
                    </div>
                  </div>
                  <div className="report-stat">
                    <div className="report-stat-label">减分合计</div>
                    <div className="report-stat-value score-deduct">
                      {classReport.deducts ? `-${formatScore(classReport.deducts)}` : "0"}
                    </div>
                  </div>
                </div>

                <section className="report-section">
                  <h2 className="report-section-title">班级分类构成</h2>
                  <div className="grid cols-2">
                    <div className="record-card">
                      <div style={{ marginBottom: 8 }}>
                        <Badge tone="add">加分构成</Badge>
                      </div>
                      <CompositionList
                        items={classReport.categories.filter((item) => item.direction === "ADD")}
                        direction="ADD"
                        emptyText="本学期暂无加分分类数据。"
                      />
                    </div>
                    <div className="record-card">
                      <div style={{ marginBottom: 8 }}>
                        <Badge tone="deduct">减分构成</Badge>
                      </div>
                      <CompositionList
                        items={classReport.categories.filter((item) => item.direction === "DEDUCT")}
                        direction="DEDUCT"
                        emptyText="本学期暂无减分分类数据。"
                      />
                    </div>
                  </div>
                </section>

                <section className="report-section">
                  <h2 className="report-section-title">班级积分趋势（单位：分）</h2>
                  <TrendChart
                    data={classReport.trend}
                    periodText={classReport.term?.name || "本学期"}
                  />
                </section>

                <section className="report-section">
                  <h2 className="report-section-title">学生积分概览（人均得分口径）</h2>
                  {classReport.students.length === 0 ? (
                    <EmptyState compact title="该班暂无学生数据" />
                  ) : (
                    <div className="table-wrap">
                      <table className="table" style={{ minWidth: 560 }}>
                        <thead>
                          <tr>
                            <th>学生</th>
                            <th>学号</th>
                            <th>总分</th>
                            <th>加分</th>
                            <th>减分</th>
                            <th>记录数</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {classReport.students.map((student) => (
                            <tr key={student.id}>
                              <td className="cell-strong">{student.name}</td>
                              <td className="mono text-xs">{student.studentNo || "—"}</td>
                              <td className="amount">{formatScore(student.total)} 分</td>
                              <td className="score-add">
                                {student.adds ? `+${formatScore(student.adds)}` : "0"}
                              </td>
                              <td className="score-deduct">
                                {student.deducts ? `-${formatScore(student.deducts)}` : "0"}
                              </td>
                              <td>{formatScore(student.recordCount)}</td>
                              <td>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => openClassStudent(student)}
                                >
                                  成长报告
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                <div className="grid cols-2">
                  <section className="report-section">
                    <h2 className="report-section-title">高频正向规则</h2>
                    {classReport.topPositiveRules.length === 0 ? (
                      <p className="muted text-xs">本学期暂无正向规则记录。</p>
                    ) : (
                      <div className="stack gap-sm">
                        {classReport.topPositiveRules.map((rule, index) => (
                          <div className="list-item" key={`top-${index}`}>
                            <div className="list-main">
                              <div className="list-title">
                                {rule.ruleName}
                                <Badge tone="add">{formatScore(rule.magnitude)} 分</Badge>
                              </div>
                              <div className="list-sub">记录 {rule.recordCount} 条</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="report-section">
                    <h2 className="report-section-title">需要关注的规则类别（中性）</h2>
                    <div className="notice notice-info">
                      仅用于班级层面的过程管理与正向引导，不公开学生个人减分明细。
                    </div>
                    {classReport.attentionRules.length === 0 ? (
                      <p className="muted text-xs" style={{ marginTop: 8 }}>
                        本学期暂无需要特别关注的规则类别。
                      </p>
                    ) : (
                      <div className="stack gap-sm" style={{ marginTop: 8 }}>
                        {classReport.attentionRules.map((rule, index) => (
                          <div className="list-item" key={`attention-${index}`}>
                            <div className="list-main">
                              <div className="list-title">
                                {rule.ruleName}
                                <Badge tone="warning">{formatScore(rule.magnitude)} 分</Badge>
                              </div>
                              <div className="list-sub">记录 {rule.recordCount} 条</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </div>

                <footer className="privacy-foot">
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                    <BookOpen size={14} style={{ marginTop: 3, flex: "none" }} />
                    <span>班级报告仅供班主任、德育处内部教育管理使用，请勿公开传播或用于学生排名公示。</span>
                  </div>
                </footer>

                <div className="print-only muted" style={{ marginTop: 14, fontSize: 11 }}>
                  MES-MoralScore 班级成长报告 · {classReport.class.gradeName} {classReport.class.name} ·{" "}
                  打印时间 {formatDateTime(new Date())}
                </div>
              </article>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------- parent share modal */

function ShareCreateModal({
  studentId,
  studentName,
  onClose,
}: {
  studentId: string;
  studentName: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [expiresInDays, setExpiresInDays] = useState("30");
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedShare | null>(null);

  async function createShare() {
    setError("");
    const days = Number(expiresInDays);
    if (![7, 30, 90].includes(days)) {
      setError("有效期需为 7、30 或 90 天");
      return;
    }
    setCreating(true);
    try {
      const data = await api<{
        share: { id: string; token: string; url: string; expiresAt: string };
      }>("/shares", {
        method: "POST",
        body: JSON.stringify({
          studentId,
          expiresInDays: days,
          label: label.trim() || undefined,
        }),
      });
      const link = data.share.token
        ? `${window.location.origin}/#/share/${data.share.token}`
        : data.share.url
          ? new URL(data.share.url, window.location.origin).href
          : "";
      setCreated({ link, expiresAt: data.share.expiresAt || "" });
      toast("家长分享链接已创建，请及时复制", "success");
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setCreating(false);
    }
  }

  async function copyCreated() {
    if (!created) return;
    const ok = await copyText(created.link);
    if (ok) toast("链接已复制", "success");
    else toast("复制失败，请手动选择链接复制", "error");
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="生成家长分享链接"
      description={`${studentName} · 家长只读成长报告入口`}
      size="md"
      footer={
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
          {!created && (
            <Button icon={<Link2 size={15} />} loading={creating} onClick={() => void createShare()}>
              生成分享链接
            </Button>
          )}
        </div>
      }
    >
      <div className="stack gap-lg">
        {created ? (
          <>
            <Alert tone="success" title="家长分享链接创建成功">
              <div className="stack gap-sm">
                <div className="code-block" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                  {created.link}
                </div>
                <div className="row">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Copy size={14} />}
                    onClick={() => void copyCreated()}
                  >
                    复制链接
                  </Button>
                  {created.expiresAt && (
                    <span className="muted text-xs">有效期至 {formatDateTime(created.expiresAt)}</span>
                  )}
                </div>
              </div>
            </Alert>
            <div className="notice notice-warning">
              <div>
                <strong>链接只显示这一次，关闭弹窗后无法再次查看</strong>
                （系统只保存链接哈希）。如遗失请重新生成并撤销旧链接。
              </div>
              <div style={{ marginTop: 6 }}>
                请仅通过学校已核验的家校渠道发送给家长；家长只能查看该学生的报告，不会看到其他学生信息。
                链接可随时撤销，请勿发到群聊或公开网络。
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="notice notice-info">
              生成后家长可通过链接只读查看该学生的成长报告；链接只保存哈希，创建成功时展示原文一次。
            </div>
            <Field label="有效期" required hint="到期后链接自动失效，可随时在系统管理中撤销。">
              <Segmented
                value={expiresInDays}
                options={[
                  { value: "7", label: "7 天" },
                  { value: "30", label: "30 天" },
                  { value: "90", label: "90 天" },
                ]}
                onChange={(next) => setExpiresInDays(next)}
                ariaLabel="分享链接有效期"
              />
            </Field>
            <Field label="备注标签" hint="可选，例如「10 月成长报告 · 家长会」，便于日后识别。">
              <Input
                maxLength={60}
                placeholder="选填"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </Field>
            {error && <div className="alert alert-danger">{error}</div>}
          </>
        )}
      </div>
    </Modal>
  );
}

