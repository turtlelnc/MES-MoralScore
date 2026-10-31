// OWNER: frontend-insight. 数据分析：多维度 KPI、趋势、班级/年级对比、分类构成、规则排行与下钻。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  Gauge,
  ListChecks,
  MinusCircle,
  PlusCircle,
  RefreshCw,
  Scale,
  SlidersHorizontal,
  TrendingUp,
  Users,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, query, ApiError } from "../api";
import { formatDate, formatMonthDay, formatScore } from "../format";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Loading,
  PageHeader,
  SectionTitle,
  Select,
  Segmented,
  StatCard,
  cn,
} from "../components/ui";
import type { AnalyticsOverview, ClassItem, OptionsData, PageProps, PeriodsData } from "../types";

/* ------------------------------------------------------------------ helpers */

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录状态已失效，请重新登录";
    if (error.status === 403) return "没有权限查看该范围的数据";
    if (error.status === 400) return error.message || "筛选条件不符合要求";
    if (error.status >= 500) return "服务暂时不可用，请稍后重试";
    return error.message;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") return "请求超时，请稍后重试";
  return "网络异常，请检查网络后重试";
}

function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return formatDate(date);
}

type QuickRange = "7d" | "30d" | "term" | "custom";

interface ChartDatum {
  [key: string]: string | number | undefined;
}

interface ChartTooltipEntry {
  name?: string | number;
  value?: number | string | Array<number | string>;
  dataKey?: string | number;
  color?: string;
  payload?: ChartDatum;
}

function ChartTooltip({
  active,
  payload,
  label,
  unit = "分",
}: {
  active?: boolean;
  payload?: readonly ChartTooltipEntry[];
  label?: string | number;
  unit?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="chart-tooltip">
      {label !== undefined && label !== null && <strong>{String(label)}</strong>}
      {payload.map((entry, index) => (
        <div key={`${String(entry.dataKey ?? index)}-${index}`}>
          <span className="legend-dot" style={{ background: entry.color || "var(--brand)" }} />
          {String(entry.name ?? entry.dataKey ?? "")}：{formatScore(Number(entry.value))} {unit}
        </div>
      ))}
    </div>
  );
}

function CategoryTooltip({
  active,
  payload,
  unit = "分",
}: {
  active?: boolean;
  payload?: readonly ChartTooltipEntry[];
  unit?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const entry = payload[0];
  const datum = (entry?.payload || {}) as {
    categoryName?: string;
    magnitude?: number;
    recordCount?: number;
    net?: number;
  };
  return (
    <div className="chart-tooltip">
      <strong>{datum.categoryName || String(entry?.name ?? "")}</strong>
      <div>合计分值：{formatScore(num(datum.magnitude))} {unit}</div>
      <div>记录数：{num(datum.recordCount)} 条</div>
      <div>净分：{formatScore(num(datum.net))} 分</div>
    </div>
  );
}

function deltaText(current: number, previous: number): { text: string; positive: boolean; neutral: boolean } {
  const diff = current - previous;
  if (previous === 0) {
    if (diff === 0) return { text: "与上期持平", positive: true, neutral: true };
    return {
      text: `${diff > 0 ? "+" : ""}${formatScore(diff)}（上期无数据）`,
      positive: diff > 0,
      neutral: false,
    };
  }
  return {
    text: `${diff > 0 ? "+" : ""}${formatScore(diff)}（${percentChange(diff, previous)}）`,
    positive: diff > 0,
    neutral: diff === 0,
  };
}

function percentChange(diff: number, previous: number): string {
  const percentValue = Math.round((diff / previous) * 100);
  return `${percentValue > 0 ? "+" : ""}${percentValue}%`;
}

/* -------------------------------------------------------------------- page */

export function AnalyticsPage({ user, onNavigate, params }: PageProps) {
  const [options, setOptions] = useState<OptionsData | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [periods, setPeriods] = useState<PeriodsData | null>(null);
  const [periodsError, setPeriodsError] = useState("");
  const [periodsLoading, setPeriodsLoading] = useState(true);

  const [termId, setTermId] = useState(user.currentTerm?.id ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [gradeId, setGradeId] = useState(params.gradeId || "");
  const [classId, setClassId] = useState(params.classId || "");
  const [quick, setQuick] = useState<QuickRange>("term");

  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const loadOptions = useCallback(async () => {
    setOptionsError("");
    try {
      const result = await api<OptionsData>("/options");
      setOptions(result);
    } catch (requestError) {
      setOptionsError(errorText(requestError));
    }
  }, []);

  const loadPeriods = useCallback(async () => {
    setPeriodsLoading(true);
    setPeriodsError("");
    try {
      const result = await api<PeriodsData>("/periods");
      setPeriods(result);
      setTermId((current) => current || result.currentTermId || "");
    } catch (requestError) {
      setPeriodsError(errorText(requestError));
    } finally {
      setPeriodsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOptions();
    void loadPeriods();
  }, [loadOptions, loadPeriods]);

  useEffect(() => {
    if (periodsLoading && !termId) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<AnalyticsOverview>(
      `/analytics/overview${query({
        termId: termId || undefined,
        from: from || undefined,
        to: to || undefined,
        gradeId: gradeId || undefined,
        classId: classId || undefined,
      })}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
      })
      .catch((requestError) => {
        if (controller.signal.aborted) return;
        setError(errorText(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [periodsLoading, termId, from, to, gradeId, classId, reloadKey]);

  const termOptions = useMemo(() => {
    const fromPeriods =
      periods?.years.flatMap((year) =>
        year.terms.map((term) => ({
          id: term.id,
          label: `${year.name} · ${term.name}`,
          startDate: term.startDate,
          endDate: term.endDate,
          isCurrent: term.isCurrent,
        })),
      ) ?? [];
    if (fromPeriods.length > 0) return fromPeriods;
    return (options?.terms ?? []).map((term) => ({
      id: term.id,
      label: term.name,
      startDate: term.startDate,
      endDate: term.endDate,
      isCurrent: term.isCurrent,
    }));
  }, [periods, options]);

  const activeTerm = termOptions.find((term) => term.id === termId) || null;
  const rangeText =
    from || to
      ? `${from || "不限"} 至 ${to || "不限"}`
      : activeTerm
        ? `${activeTerm.startDate} 至 ${activeTerm.endDate}`
        : "全部时间";

  const classOptions: ClassItem[] = useMemo(() => {
    const classes = options?.classes ?? [];
    return gradeId ? classes.filter((item) => item.gradeId === gradeId) : classes;
  }, [options, gradeId]);

  function applyQuickRange(range: Exclude<QuickRange, "custom">) {
    setQuick(range);
    if (range === "term") {
      setFrom("");
      setTo("");
    } else {
      setFrom(daysAgo(range === "7d" ? 6 : 29));
      setTo(formatDate(new Date()));
    }
  }

  function resetFilters() {
    setQuick("term");
    setFrom("");
    setTo("");
    setGradeId("");
    setClassId("");
    void loadPeriods();
  }

  function drillClass(nextClassId: string) {
    setClassId(nextClassId);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const kpis = data?.kpis;
  const trend = data?.trend ?? [];
  const timeComparison = data?.timeComparison;
  const classRows = useMemo(
    () => [...(data?.classComparison ?? [])].sort((a, b) => num(b.avgScore) - num(a.avgScore)),
    [data],
  );
  /** 图表/列表显示「年级+班级」，避免不同年级同名的「1班」混淆。 */
  const classChartRows = useMemo(
    () =>
      classRows.map((row) => ({
        ...row,
        chartLabel: `${row.gradeName || ""}${row.className || ""}`,
      })),
    [classRows],
  );
  const gradeRows = useMemo(
    () => [...(data?.gradeComparison ?? [])].sort((a, b) => num(b.avgScore) - num(a.avgScore)),
    [data],
  );
  const addCategories = useMemo(
    () =>
      [...(data?.categories ?? [])]
        .filter((category) => category.direction === "ADD")
        .sort((a, b) => num(b.magnitude) - num(a.magnitude)),
    [data],
  );
  const deductCategories = useMemo(
    () =>
      [...(data?.categories ?? [])]
        .filter((category) => category.direction === "DEDUCT")
        .sort((a, b) => num(b.magnitude) - num(a.magnitude)),
    [data],
  );
  const addRules = useMemo(
    () =>
      [...(data?.rules ?? [])]
        .filter((rule) => rule.direction === "ADD")
        .sort((a, b) => num(b.magnitude) - num(a.magnitude))
        .slice(0, 10),
    [data],
  );
  const deductRules = useMemo(
    () =>
      [...(data?.rules ?? [])]
        .filter((rule) => rule.direction === "DEDUCT")
        .sort((a, b) => num(b.magnitude) - num(a.magnitude))
        .slice(0, 10),
    [data],
  );

  const comparisonItems = timeComparison
    ? [
        { key: "adds", label: "加分合计", unit: "分", current: num(timeComparison.current.adds), previous: num(timeComparison.previous.adds) },
        { key: "deducts", label: "减分合计", unit: "分", current: num(timeComparison.current.deducts), previous: num(timeComparison.previous.deducts) },
        { key: "net", label: "净分", unit: "分", current: num(timeComparison.current.net), previous: num(timeComparison.previous.net) },
        { key: "recordCount", label: "记录数", unit: "条", current: num(timeComparison.current.recordCount), previous: num(timeComparison.previous.recordCount) },
      ]
    : [];

  return (
    <div className="page">
      <PageHeader
        title="数据分析"
        description="基于已生效积分记录的实时聚合：多维筛选、时间对比、班级人均分对比与下钻。所有数字与图表使用同一筛选条件。"
        actions={
          <Button
            variant="secondary"
            icon={<RefreshCw size={16} />}
            loading={loading}
            onClick={() => setReloadKey((key) => key + 1)}
          >
            刷新数据
          </Button>
        }
      />

      <Card title="筛选条件" subtitle={`统计范围：${rangeText}`}>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          <Field label="学期" hint={periodsError ? "学期列表加载失败，将使用当前学期" : undefined}>
            <Select
              value={termId}
              onChange={(event) => {
                setTermId(event.target.value);
                setQuick("term");
                setFrom("");
                setTo("");
              }}
            >
              <option value="">全部学期</option>
              {termOptions.map((term) => (
                <option key={term.id} value={term.id}>
                  {term.label}
                  {term.isCurrent ? "（当前）" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="年级">
            <Select
              value={gradeId}
              onChange={(event) => {
                setGradeId(event.target.value);
                setClassId("");
              }}
            >
              <option value="">全部年级</option>
              {(options?.grades ?? []).map((grade) => (
                <option key={grade.id} value={grade.id}>
                  {grade.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="班级">
            <Select
              value={classId}
              onChange={(event) => {
                setClassId(event.target.value);
                const next = event.target.value;
                if (next && !gradeId) {
                  const found = (options?.classes ?? []).find((item) => item.id === next);
                  if (found) setGradeId(found.gradeId);
                }
              }}
            >
              <option value="">全部班级</option>
              {classOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="开始日期" hint="留空表示不限">
            <Input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(event) => {
                setFrom(event.target.value);
                setQuick("custom");
              }}
            />
          </Field>
          <Field label="结束日期" hint="留空表示不限">
            <Input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => {
                setTo(event.target.value);
                setQuick("custom");
              }}
            />
          </Field>
        </div>
        <div className="toolbar between" style={{ marginTop: 12 }}>
          <div className="row" style={{ gap: 8 }}>
            <SlidersHorizontal size={15} className="muted" />
            <Segmented
              value={quick}
              options={[
                { value: "7d", label: "近 7 天" },
                { value: "30d", label: "近 30 天" },
                { value: "term", label: "整个学期" },
              ]}
              onChange={(next) => {
                if (next !== "custom") applyQuickRange(next);
              }}
              ariaLabel="快捷时间范围"
              size="sm"
            />
            {quick === "custom" && <Badge tone="neutral">自定义时间</Badge>}
          </div>
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            重置筛选
          </Button>
        </div>
        {optionsError && (
          <div className="muted text-xs mt-2">
            年级/班级选项加载失败：
            <button type="button" className="link" onClick={() => void loadOptions()}>
              重试
            </button>
          </div>
        )}
      </Card>

      {error && (
        <div style={{ marginTop: 14 }}>
          <Alert
            tone="danger"
            title="数据分析加载失败"
            onRetry={() => setReloadKey((key) => key + 1)}
          >
            {error}
          </Alert>
        </div>
      )}

      {loading && !data && (
        <div style={{ marginTop: 14 }}>
          <Card>
            <Loading label="正在聚合分析数据…" />
          </Card>
        </div>
      )}

      {!loading && !error && !data && (
        <div style={{ marginTop: 14 }}>
          <Card>
            <EmptyState
              icon={<BarChart3 size={22} />}
              title="暂无分析数据"
              description="当前筛选条件下没有可用的统计结果，请调整筛选条件后重试。"
            />
          </Card>
        </div>
      )}

      {data && (
        <>
          {(gradeId || classId) && (
            <div className="row" style={{ marginTop: 14, gap: 8 }}>
              <span className="muted text-xs">当前下钻范围：</span>
              {gradeId && (
                <Badge tone="brand">
                  {options?.grades.find((grade) => grade.id === gradeId)?.name || "年级"}
                </Badge>
              )}
              {classId && (
                <Badge tone="brand">
                  {options?.classes.find((item) => item.id === classId)?.name || "班级"}
                </Badge>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setGradeId("");
                  setClassId("");
                }}
              >
                清除下钻
              </Button>
              {classId && (
                <>
                  <Button
                    variant="subtle"
                    size="sm"
                    icon={<ListChecks size={14} />}
                    onClick={() => onNavigate("records", { classId, gradeId })}
                  >
                    查看该班记录
                  </Button>
                  <Button
                    variant="subtle"
                    size="sm"
                    icon={<TrendingUp size={14} />}
                    onClick={() => onNavigate("reports", { classId })}
                  >
                    班级成长报告
                  </Button>
                </>
              )}
            </div>
          )}

          <SectionTitle
            title="核心指标"
            hint={`${rangeText}${activeTerm ? ` · ${activeTerm.label}` : ""} · 仅统计已生效记录`}
          />
          <div className="grid cols-3">
            <StatCard
              label="学生人数"
              value={formatScore(num(kpis?.studentCount))}
              suffix="人"
              tone="brand"
              icon={<Users size={18} />}
              hint={`覆盖 ${num(kpis?.classCount)} 个班级`}
            />
            <StatCard
              label="人均得分"
              value={formatScore(num(kpis?.avgScore))}
              suffix="分"
              tone="neutral"
              icon={<Gauge size={18} />}
              hint="按学生人数归一化，班级间可直接比较"
            />
            <StatCard
              label="加分合计"
              value={formatScore(num(kpis?.totalAdds))}
              suffix="分"
              tone="add"
              icon={<PlusCircle size={18} />}
              hint="已生效加分记录合计"
            />
            <StatCard
              label="减分合计"
              value={formatScore(num(kpis?.totalDeducts))}
              suffix="分"
              tone="deduct"
              icon={<MinusCircle size={18} />}
              hint="已生效减分记录合计"
            />
            <StatCard
              label="净分"
              value={formatScore(num(kpis?.net))}
              suffix="分"
              tone={num(kpis?.net) >= 0 ? "add" : "deduct"}
              icon={<Scale size={18} />}
              hint="加分合计 − 减分合计"
            />
            <StatCard
              label="记录数"
              value={formatScore(num(kpis?.recordCount))}
              suffix="条"
              tone="neutral"
              icon={<ListChecks size={18} />}
              hint="已生效记录条数"
            />
          </div>

          <SectionTitle title="时间对比" hint={timeComparison?.label || "本期与上一周期对比"} />
          <Card title="本期 vs 上期" subtitle={`${timeComparison?.label || "本期 vs 上期"} · ${rangeText}`}>
            {!timeComparison ? (
              <EmptyState compact title="暂无对比数据" description="当前筛选条件下没有可用于对比的数据。" />
            ) : (
              <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                {comparisonItems.map((item) => {
                  const delta = deltaText(item.current, item.previous);
                  return (
                    <div className="record-card" key={item.key}>
                      <div className="muted text-xs">{item.label}</div>
                      <div className="stat-value" style={{ fontSize: 22, marginTop: 4 }}>
                        {formatScore(item.current)}
                        <small className="stat-suffix" style={{ marginLeft: 3 }}>
                          {item.unit}
                        </small>
                      </div>
                      <div className="muted text-xs">上期：{formatScore(item.previous)} {item.unit}</div>
                      <div
                        className={cn(
                          "text-xs",
                          !delta.neutral && (delta.positive ? "score-add" : "score-deduct"),
                          delta.neutral && "muted",
                        )}
                        style={{ marginTop: 4, fontWeight: 600 }}
                      >
                        {delta.text}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <SectionTitle title="趋势与构成" hint="趋势数据来自已生效记录，按天聚合" />
          <div className="grid cols-2">
            <Card title="加减分趋势" subtitle={`${rangeText} · 单位：分`}>
              {trend.length === 0 ? (
                <EmptyState compact title="暂无趋势数据" description="当前筛选条件下没有已生效积分记录。" />
              ) : (
                <div className="chart-box">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trend} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickFormatter={(value: string) => formatMonthDay(value)}
                        tick={{ fontSize: 11, fill: "#8b96a9" }}
                        tickLine={false}
                        axisLine={{ stroke: "var(--border)" }}
                        minTickGap={18}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: "#8b96a9" }}
                        tickLine={false}
                        axisLine={false}
                        width={44}
                      />
                      <Tooltip content={<ChartTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
                      <Line
                        type="monotone"
                        dataKey="adds"
                        name="加分"
                        stroke="var(--add)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="deducts"
                        name="减分"
                        stroke="var(--deduct)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="net"
                        name="净分"
                        stroke="var(--brand)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>

            <Card title="班级人均得分对比" subtitle={`${rangeText} · 单位：分/人 · 条形长度=人均得分`}>
              {classRows.length === 0 ? (
                <EmptyState compact title="暂无班级对比数据" description="当前筛选条件下没有班级数据。" />
              ) : (
                <>
                  <div style={{ width: "100%", height: Math.min(400, Math.max(200, classRows.length * 38 + 30)) }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={classChartRows}
                        layout="vertical"
                        margin={{ top: 4, right: 16, left: 4, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                        <XAxis
                          type="number"
                          tick={{ fontSize: 11, fill: "#8b96a9" }}
                          tickLine={false}
                          axisLine={{ stroke: "var(--border)" }}
                        />
                        <YAxis
                          type="category"
                          dataKey="chartLabel"
                          width={98}
                          tick={{ fontSize: 11, fill: "#5d6b81" }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip
                          content={
                            <ChartTooltip
                              unit="分/人"
                            />
                          }
                          cursor={{ fill: "rgba(47, 109, 246, 0.06)" }}
                        />
                        <Bar
                          dataKey="avgScore"
                          name="人均得分"
                          radius={[0, 4, 4, 0]}
                          onClick={(entry) => {
                            const datum = entry.payload as { classId?: string } | undefined;
                            if (datum?.classId) drillClass(datum.classId);
                          }}
                        >
                          {classChartRows.map((row) => (
                            <Cell
                              key={row.classId}
                              fill={row.classId === classId ? "var(--brand-strong)" : "var(--brand)"}
                              style={{ cursor: "pointer" }}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="muted text-xs mt-2">点击条形或下方班级行可下钻筛选该班。</div>
                  <div className="list mt-2">
                    {classRows.slice(0, 12).map((row) => (
                      <div className="list-item" key={row.classId}>
                        <div className="list-main">
                          <div className="list-title">
                            {row.gradeName}
                            {row.className}
                            <Badge tone="brand">人均得分 {formatScore(num(row.avgScore))} 分</Badge>
                            <span className="muted text-xs">{num(row.studentCount)} 人</span>
                          </div>
                          <div className="list-sub">
                            加分 {formatScore(num(row.adds))} · 减分 {formatScore(num(row.deducts))}
                          </div>
                        </div>
                        <div className="row nowrap" style={{ gap: 4 }}>
                          <Button size="sm" variant="ghost" onClick={() => drillClass(row.classId)}>
                            筛选
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onNavigate("records", { classId: row.classId })}
                          >
                            记录
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onNavigate("reports", { classId: row.classId })}
                          >
                            报告
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>
          </div>

          <SectionTitle title="年级对比与分类构成" hint="年级对比使用人均得分；分类构成按加减分方向拆分" />
          <div className="grid cols-2">
            <Card title="年级人均得分对比" subtitle={`${rangeText} · 单位：分/人`}>
              {gradeRows.length === 0 ? (
                <EmptyState compact title="暂无年级对比数据" description="当前筛选条件下没有年级数据。" />
              ) : (
                <>
                  <div style={{ width: "100%", height: Math.min(300, Math.max(180, gradeRows.length * 48 + 30)) }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={gradeRows}
                        layout="vertical"
                        margin={{ top: 4, right: 16, left: 4, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                        <XAxis
                          type="number"
                          tick={{ fontSize: 11, fill: "#8b96a9" }}
                          tickLine={false}
                          axisLine={{ stroke: "var(--border)" }}
                        />
                        <YAxis
                          type="category"
                          dataKey="gradeName"
                          width={76}
                          tick={{ fontSize: 11, fill: "#5d6b81" }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip content={<ChartTooltip unit="分/人" />} cursor={{ fill: "rgba(47, 109, 246, 0.06)" }} />
                        <Bar dataKey="avgScore" name="人均得分" radius={[0, 4, 4, 0]} fill="var(--accent)">
                          {gradeRows.map((row) => (
                            <Cell
                              key={row.gradeId}
                              fill={row.gradeId === gradeId ? "var(--brand-strong)" : "var(--accent)"}
                              style={{ cursor: "pointer" }}
                              onClick={() => {
                                setGradeId(row.gradeId);
                                setClassId("");
                              }}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="list mt-2">
                    {gradeRows.map((row) => (
                      <div className="list-item" key={row.gradeId}>
                        <div className="list-main">
                          <div className="list-title">
                            {row.gradeName}
                            <Badge tone="info">人均得分 {formatScore(num(row.avgScore))} 分</Badge>
                            <span className="muted text-xs">{num(row.studentCount)} 人</span>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setGradeId(row.gradeId);
                            setClassId("");
                          }}
                        >
                          筛选该年级
                        </Button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>

            <Card title="加分构成" subtitle={`${rangeText} · 单位：分 · 按分类合计分值排序`}>
              {addCategories.length === 0 ? (
                <EmptyState compact title="暂无加分分类数据" description="当前条件下没有已生效的加分记录。" />
              ) : (
                <div style={{ width: "100%", height: Math.min(320, Math.max(180, addCategories.length * 36 + 30)) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={addCategories}
                      layout="vertical"
                      margin={{ top: 4, right: 20, left: 4, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                      <XAxis
                        type="number"
                        tick={{ fontSize: 11, fill: "#8b96a9" }}
                        tickLine={false}
                        axisLine={{ stroke: "var(--border)" }}
                      />
                      <YAxis
                        type="category"
                        dataKey="categoryName"
                        width={84}
                        tick={{ fontSize: 11, fill: "#5d6b81" }}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip content={<CategoryTooltip />} cursor={{ fill: "rgba(20, 128, 74, 0.06)" }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
                      <Bar dataKey="magnitude" name="加分合计（分）" radius={[0, 4, 4, 0]} fill="var(--add)">
                        {addCategories.map((row) => (
                          <Cell key={row.categoryName} fill="var(--add)" />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
          </div>

          <div className="grid cols-2" style={{ marginTop: 14 }}>
            <Card title="减分构成" subtitle={`${rangeText} · 单位：分 · 按分类合计分值排序`}>
              {deductCategories.length === 0 ? (
                <EmptyState compact title="暂无减分分类数据" description="当前条件下没有已生效的减分记录。" />
              ) : (
                <div style={{ width: "100%", height: Math.min(320, Math.max(180, deductCategories.length * 36 + 30)) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={deductCategories}
                      layout="vertical"
                      margin={{ top: 4, right: 20, left: 4, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                      <XAxis
                        type="number"
                        tick={{ fontSize: 11, fill: "#8b96a9" }}
                        tickLine={false}
                        axisLine={{ stroke: "var(--border)" }}
                      />
                      <YAxis
                        type="category"
                        dataKey="categoryName"
                        width={84}
                        tick={{ fontSize: 11, fill: "#5d6b81" }}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip content={<CategoryTooltip />} cursor={{ fill: "rgba(178, 58, 50, 0.06)" }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
                      <Bar dataKey="magnitude" name="减分合计（分）" radius={[0, 4, 4, 0]} fill="var(--deduct)">
                        {deductCategories.map((row) => (
                          <Cell key={row.categoryName} fill="var(--deduct)" />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>

            <Card
              title="规则排行（加分）"
              subtitle={`${rangeText} · 按合计分值排序，最多展示 10 条`}
            >
              {addRules.length === 0 ? (
                <EmptyState compact title="暂无加分规则数据" description="当前条件下没有已生效的加分记录。" />
              ) : (
                <div className="stack gap-sm">
                  {addRules.map((rule) => (
                    <RuleRankRow key={`add-${rule.ruleName}`} rule={rule} tone="add" max={addRules[0]?.magnitude} />
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div className="grid cols-2" style={{ marginTop: 14 }}>
            <Card title="规则排行（减分）" subtitle={`${rangeText} · 按合计分值排序，最多展示 10 条`}>
              {deductRules.length === 0 ? (
                <EmptyState compact title="暂无减分规则数据" description="当前条件下没有已生效的减分记录。" />
              ) : (
                <div className="stack gap-sm">
                  {deductRules.map((rule) => (
                    <RuleRankRow
                      key={`deduct-${rule.ruleName}`}
                      rule={rule}
                      tone="deduct"
                      max={deductRules[0]?.magnitude}
                    />
                  ))}
                </div>
              )}
            </Card>

            <Card title="下钻指引" subtitle="从分析到明细，再到成长报告">
              <div className="stack gap-sm">
                <div className="record-card">
                  <div className="list-title">
                    <Users size={15} /> 班级下钻
                  </div>
                  <p className="list-sub">
                    点击班级人均分对比中的条形或「筛选」按钮，所有 KPI 与图表会切换到该班范围；使用「记录」进入积分明细。
                  </p>
                </div>
                <div className="record-card">
                  <div className="list-title">
                    <Scale size={15} /> 年级下钻
                  </div>
                  <p className="list-sub">点击年级条形或「筛选该年级」限定年级范围，再继续选择班级。</p>
                </div>
                <div className="record-card">
                  <div className="list-title">
                    <ArrowRight size={15} /> 反馈与报告
                  </div>
                  <p className="list-sub">
                    分析结果用于过程管理与正向引导；学生个人成长报告请前往「成长报告」或从学生详情进入。
                  </p>
                </div>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- subviews */

function RuleRankRow({
  rule,
  tone,
  max,
}: {
  rule: { ruleName: string; recordCount: number; studentCount: number; magnitude: number };
  tone: "add" | "deduct";
  max: number;
}) {
  const magnitude = num(rule.magnitude);
  const width = Math.max(4, Math.round((magnitude / Math.max(1, num(max))) * 100));
  return (
    <div className="bar-row" style={{ gridTemplateColumns: "minmax(88px, 1.2fr) minmax(60px, 2fr) auto" }}>
      <span className="bar-label" title={rule.ruleName}>
        {rule.ruleName}
      </span>
      <div className="bar-track">
        <div className={cn("bar-fill", tone)} style={{ width: `${width}%` }} />
      </div>
      <span className="bar-value no-wrap">
        {formatScore(magnitude)} 分 · {num(rule.recordCount)} 条 · {num(rule.studentCount)} 人
      </span>
    </div>
  );
}
