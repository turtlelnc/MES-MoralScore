// OWNER: frontend-core. 总览仪表盘：真实学期聚合数据、趋势图、分布、异常提醒与最近记录。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  BellRing,
  ChevronRight,
  ClipboardCheck,
  FileCheck2,
  Gavel,
  ListChecks,
  RefreshCw,
  Scale,
  Sparkles,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, ApiError, query } from "../api";
import {
  directionTone,
  formatDate,
  formatDateTime,
  formatMonthDay,
  formatScore,
  formatSignedScore,
  percent,
  recordStatusTone,
} from "../format";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Loading,
  PageHeader,
  Select,
  SectionTitle,
  StatCard,
  useToast,
} from "../components/ui";
import type { DashboardData, PageProps } from "../types";

type TermsResponse = {
  terms?: Array<{ id: string; name: string; academicYearName?: string; isCurrent?: boolean }>;
};

function dashboardErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录状态已失效，请重新登录后查看总览";
    if (error.status === 403) return error.message || "当前账号没有查看该范围数据的权限";
    if (error.status === 400) {
      const issue = error.issues?.[0]?.message;
      return issue || error.message || "筛选条件不正确";
    }
    if (error.status >= 500) return error.message || "服务暂时不可用，请稍后重试";
    return error.message || fallback;
  }
  if (error instanceof DOMException && error.name === "AbortError") return "";
  return error instanceof Error && error.message ? error.message : fallback;
}

function dedupeNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** recharts 自定义 tooltip（单位：分）。 */
function TrendTooltip(props: {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ payload?: DashboardData["trend"][number] }>;
}) {
  const { active, payload, label } = props;
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="chart-tooltip">
      <strong>{formatDate(String(label ?? point.date))}</strong>
      <div>加分：{formatScore(point.adds)} 分</div>
      <div>减分：{formatScore(Math.abs(point.deducts))} 分</div>
      <div>净分：{formatSignedScore(point.net)} 分</div>
    </div>
  );
}

export function DashboardPage({ user, onNavigate, params }: PageProps) {
  const toast = useToast();
  const [termId, setTermId] = useState(() => params.termId || user.currentTerm?.id || "");
  const [terms, setTerms] = useState<TermsResponse["terms"]>([]);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [attention, setAttention] = useState<string[]>([]);

  /* ------------------------------------------------------------- 数据加载 */
  useEffect(() => {
    let cancelled = false;
    api<TermsResponse>("/options")
      .then((response) => {
        if (!cancelled) setTerms(response.terms || []);
      })
      .catch(() => {
        // 学期列表只用于切换，失败时仍使用当前学期展示，不阻塞主数据。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    (async () => {
      try {
        const response = await api<DashboardData>(`/dashboard${query({ termId })}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setData(response);
        if (response.term?.id && response.term.id !== termId) setTermId(response.term.id);
      } catch (requestError) {
        if (controller.signal.aborted) return;
        setError(dashboardErrorText(requestError, "加载总览数据失败，请稍后重试"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [termId, reloadToken]);

  /* ------------------------------------------- 异常提醒的本机关注标记（不改账本） */
  const attentionKey = `mes.dashboard.attention.${user.id}.${termId || "current"}`;
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(attentionKey);
      const parsed = raw ? JSON.parse(raw) : [];
      setAttention(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      setAttention([]);
    }
  }, [attentionKey]);

  function toggleAttention(alertId: string) {
    const isMarked = attention.includes(alertId);
    const next = isMarked ? attention.filter((id) => id !== alertId) : [...attention, alertId];
    setAttention(next);
    try {
      window.localStorage.setItem(attentionKey, JSON.stringify(next));
    } catch {
      // 浏览器禁用本地存储时仍允许临时标记，只是不持久化。
    }
    toast(
      isMarked ? "已取消关注标记" : "已在本机标记关注（仅提示自己，不会修改积分记录）",
      "info",
    );
  }

  /* ---------------------------------------------------------------- 派生数据 */
  const kpis = data?.kpis;
  const trend = data?.trend ?? [];
  const classRows = useMemo(
    () =>
      [...(data?.classDistribution ?? [])]
        .sort((left, right) => dedupeNumber(right.avgScore) - dedupeNumber(left.avgScore))
        .slice(0, 8),
    [data],
  );
  const maxClassAvg = useMemo(
    () => Math.max(1, ...classRows.map((row) => Math.abs(dedupeNumber(row.avgScore)))),
    [classRows],
  );
  const gradeRows = data?.gradeDistribution ?? [];
  const maxGradeAvg = useMemo(
    () => Math.max(1, ...gradeRows.map((row) => Math.abs(dedupeNumber(row.avgScore)))),
    [gradeRows],
  );
  const categories = data?.categories ?? [];
  const categoryRows = useMemo(
    () =>
      [...categories]
        .sort((left, right) => dedupeNumber(right.recordCount) - dedupeNumber(left.recordCount))
        .slice(0, 10),
    [categories],
  );
  const totalCategoryRecords = useMemo(
    () => Math.max(1, categories.reduce((sum, item) => sum + dedupeNumber(item.recordCount), 0)),
    [categories],
  );
  const maxCategoryMagnitude = useMemo(
    () => Math.max(1, ...categoryRows.map((item) => Math.abs(dedupeNumber(item.magnitude)))),
    [categoryRows],
  );
  const topPositiveRules = data?.topPositiveRules ?? [];
  const alerts = data?.alerts ?? [];
  const recentRecords = data?.recentRecords ?? [];
  const term = data?.term ?? user.currentTerm ?? null;

  const rangeText =
    trend.length > 0
      ? `${formatDate(trend[0].date)} 至 ${formatDate(trend[trend.length - 1].date)}`
      : term
        ? `${formatDate(term.startDate)} 至 ${formatDate(term.endDate)}`
        : "本学期";

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const showFirstLoad = loading && !data;

  return (
    <div
      className="page"
     
    >
      <PageHeader
        eyebrow="工作台"
        title="总览仪表盘"
        description={
          term
            ? `${term.academicYearName ? `${term.academicYearName} · ` : ""}${term.name}（${formatDate(
                term.startDate,
              )} 至 ${formatDate(term.endDate)}）· 数据口径：仅统计已生效记录`
            : "数据来自学校实时账本聚合"
        }
        actions={
          <>
            {terms && terms.length > 0 && (
              <Select
                aria-label="切换学期"
                value={termId}
                onChange={(event) => {
                  setTermId(event.target.value);
                  toast("正在切换学期数据…", "info");
                }}
                style={{ minWidth: 180, width: "auto" }}
              >
                {termId === "" && <option value="">当前学期</option>}
                {terms.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.academicYearName ? `${item.academicYearName} · ${item.name}` : item.name}
                    {item.isCurrent ? "（当前）" : ""}
                  </option>
                ))}
              </Select>
            )}
            <Button
              variant="secondary"
              icon={<RefreshCw size={15} />}
              loading={loading}
              onClick={refresh}
            >
              刷新
            </Button>
            {user.permissions.score && (
              <Button icon={<Zap size={16} />} onClick={() => onNavigate("quick-score")}>
                快捷记分
              </Button>
            )}
          </>
        }
      />

      {showFirstLoad && (
        <Card>
          <Loading label="正在汇总本学期德育数据…" />
        </Card>
      )}

      {!showFirstLoad && error && !data && (
        <Card>
          <Alert
            tone="danger"
            title="总览数据加载失败"
            onRetry={refresh}
          >
            {error}
          </Alert>
        </Card>
      )}

      {error && data && (
        <div className="mt-2" style={{ marginBottom: 14 }}>
          <Alert tone="warning" title="刷新失败，以下为上次加载的数据" onRetry={refresh}>
            {error}
          </Alert>
        </div>
      )}

      {data && (
        <>
          {/* ------------------------------------------------------------- KPI */}
          <div className="stat-grid">
            <StatCard
              label="学生数"
              value={formatScore(kpis?.studentCount)}
              suffix="人"
              tone="brand"
              icon={<Users size={17} />}
              hint={`覆盖 ${formatScore(kpis?.classCount)} 个班级`}
            />
            <StatCard
              label="学期平均分"
              value={formatScore(kpis?.avgScore)}
              suffix="分"
              tone="brand"
              icon={<TrendingUp size={17} />}
              hint="人均得分 = 学期总分 ÷ 学生数"
            />
            <StatCard
              label="加分总量"
              value={formatScore(kpis?.totalAdds)}
              suffix="分"
              tone="add"
              icon={<ArrowUpRight size={17} />}
              hint="本学期累计（已生效）"
            />
            <StatCard
              label="减分总量"
              value={formatScore(kpis?.totalDeducts)}
              suffix="分"
              tone="deduct"
              icon={<ArrowDownRight size={17} />}
              hint="本学期累计（已生效）"
            />
            <StatCard
              label="净分变化"
              value={formatSignedScore(dedupeNumber(kpis?.net))}
              suffix="分"
              tone="neutral"
              icon={<Scale size={17} />}
              hint={`共 ${formatScore(kpis?.recordCount)} 条记录`}
            />
            <StatCard
              label="待复核记录"
              value={formatScore(kpis?.pendingReviewCount)}
              suffix="条"
              tone="warn"
              icon={<ClipboardCheck size={17} />}
              hint={user.permissions.reviewRecords ? "建议前往积分记录复核" : "由德育处复核"}
            />
            <StatCard
              label="待核实申报"
              value={formatScore(kpis?.pendingSubmissionCount)}
              suffix="条"
              tone="warn"
              icon={<FileCheck2 size={17} />}
              hint={user.permissions.manageSubmissions ? "学生干部申报待处理" : "无处理权限"}
            />
            <StatCard
              label="未结申诉"
              value={formatScore(kpis?.openAppealCount)}
              suffix="条"
              tone="neutral"
              icon={<Gavel size={17} />}
              hint={user.permissions.registerAppeals ? "可前往申诉中心查看" : "无处理权限"}
            />
          </div>

          {/* --------------------------------------------------------- 快捷入口 */}
          <div className="mt-4">
            <Card title="快捷入口" subtitle="按当前账号权限提供；所有入口都会跳转到真实页面">
              <div className="row">
                {user.permissions.score && (
                  <Button
                    variant="subtle"
                    size="sm"
                    icon={<Zap size={15} />}
                    onClick={() => onNavigate("quick-score")}
                  >
                    发起记分
                  </Button>
                )}
                {user.permissions.reviewRecords && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<ClipboardCheck size={15} />}
                    onClick={() => onNavigate("records", { status: "PENDING_REVIEW" })}
                  >
                    查看待复核（{formatScore(kpis?.pendingReviewCount)}）
                  </Button>
                )}
                {user.permissions.manageSubmissions && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<FileCheck2 size={15} />}
                    onClick={() => onNavigate("submissions")}
                  >
                    待核实申报（{formatScore(kpis?.pendingSubmissionCount)}）
                  </Button>
                )}
                {user.permissions.registerAppeals && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Gavel size={15} />}
                    onClick={() => onNavigate("appeals")}
                  >
                    申诉中心（{formatScore(kpis?.openAppealCount)}）
                  </Button>
                )}
                {user.permissions.viewAnalytics && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<BarChart3 size={15} />}
                    onClick={() => onNavigate("analytics")}
                  >
                    数据分析
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<ListChecks size={15} />}
                  onClick={() => onNavigate("records")}
                >
                  全部积分记录
                </Button>
              </div>
            </Card>
          </div>

          {/* --------------------------------------------------------- 趋势图 */}
          <div className="mt-4">
            <Card
              title="加减分趋势"
              subtitle={`单位：分 · 统计范围：${rangeText} · 仅统计已生效记录`}
              actions={
                <div className="chart-legend" aria-hidden>
                  <span>
                    <i className="legend-dot" style={{ background: "#14804a" }} />
                    加分
                  </span>
                  <span>
                    <i className="legend-dot" style={{ background: "#b23a32" }} />
                    减分
                  </span>
                  <span>
                    <i className="legend-dot" style={{ background: "#2f6df6" }} />
                    净分
                  </span>
                </div>
              }
            >
              {trend.length === 0 ? (
                <EmptyState
                  compact
                  icon={<Activity size={20} />}
                  title="暂无趋势数据"
                  description="当前学期还没有已生效的积分记录。完成记分并通过审核后，这里会按日期展示加分、减分与净分走势。"
                  action={
                    user.permissions.score ? (
                      <Button size="sm" variant="subtle" onClick={() => onNavigate("quick-score")}>
                        去快捷记分
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="chart-box tall" role="img" aria-label={`加减分趋势，${rangeText}`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={trend} margin={{ top: 8, right: 10, bottom: 0, left: 2 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eef2f8" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickFormatter={(value) => formatMonthDay(String(value))}
                        tickLine={false}
                        axisLine={{ stroke: "#e5eaf2" }}
                        minTickGap={18}
                      />
                      <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                      <Tooltip content={<TrendTooltip />} cursor={{ stroke: "#d5dce8" }} />
                      <Area
                        type="monotone"
                        dataKey="adds"
                        name="加分"
                        stroke="#14804a"
                        fill="#14804a"
                        fillOpacity={0.12}
                        strokeWidth={2}
                        dot={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="deducts"
                        name="减分"
                        stroke="#b23a32"
                        fill="#b23a32"
                        fillOpacity={0.1}
                        strokeWidth={2}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="net"
                        name="净分"
                        stroke="#2f6df6"
                        strokeWidth={2.2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
          </div>

          {/* --------------------------------------------- 班级 / 年级 分布对比 */}
          <div className="grid cols-2" style={{ marginTop: 16 }}>
            <Card
              title="班级人均分对比"
              subtitle="人均得分（分/人），按人均分从高到低；附班级学生数"
              actions={
                user.permissions.viewAnalytics ? (
                  <Button variant="ghost" size="sm" onClick={() => onNavigate("analytics")}>
                    查看完整对比
                  </Button>
                ) : undefined
              }
            >
              {classRows.length === 0 ? (
                <EmptyState compact title="暂无班级数据" description="本学期还没有可对比的班级记录。" />
              ) : (
                <>
                  <div className="list">
                    {classRows.map((row) => {
                      const avg = dedupeNumber(row.avgScore);
                      const width = Math.max(4, Math.round((Math.abs(avg) / maxClassAvg) * 100));
                      return (
                        <div className="list-item" key={row.classId}>
                          <div className="list-main">
                            <div className="list-title">
                              {row.className}
                              <span className="muted text-xs">{row.gradeName}</span>
                            </div>
                            <div className="list-sub">
                              {formatScore(row.studentCount)} 名学生 · 加分 {formatScore(row.adds)} / 减分{" "}
                              {formatScore(row.deducts)}
                            </div>
                            <div className="bar-track" style={{ marginTop: 6 }}>
                              <div className="bar-fill" style={{ width: `${width}%` }} />
                            </div>
                          </div>
                          <div className="list-side">
                            <div className="score-value">{formatScore(avg)}</div>
                            <div className="text-xs muted">人均得分（分）</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {(data.classDistribution?.length ?? 0) > classRows.length && (
                    <p className="text-xs muted mt-2">
                      仅显示人均分前 {classRows.length} 个班级，完整对比请前往数据分析。
                    </p>
                  )}
                </>
              )}
            </Card>

            <Card title="年级分布" subtitle="各年级人均得分与在册学生数">
              {gradeRows.length === 0 ? (
                <EmptyState compact title="暂无年级数据" description="当前范围内还没有年级统计。" />
              ) : (
                <div className="list">
                  {gradeRows.map((row) => {
                    const avg = dedupeNumber(row.avgScore);
                    const width = Math.max(4, Math.round((Math.abs(avg) / maxGradeAvg) * 100));
                    return (
                      <div className="list-item" key={row.gradeId}>
                        <div className="list-main">
                          <div className="list-title">{row.gradeName}</div>
                          <div className="list-sub">{formatScore(row.studentCount)} 名学生</div>
                          <div className="bar-track" style={{ marginTop: 6 }}>
                            <div className="bar-fill" style={{ width: `${width}%` }} />
                          </div>
                        </div>
                        <div className="list-side">
                          <div className="score-value">{formatScore(avg)}</div>
                          <div className="text-xs muted">人均得分（分）</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>

          {/* ------------------------------------------------- 分类占比 / 异常提醒 */}
          <div className="grid cols-2" style={{ marginTop: 16 }}>
            <Card title="分类占比" subtitle="按记录条数占比，附累计分值（分值单位：分）">
              {categories.length === 0 ? (
                <EmptyState compact title="暂无分类数据" description="本学期还没有按分类聚合的记录。" />
              ) : (
                <>
                  <div className="list">
                    {categoryRows.map((item, index) => {
                      const count = dedupeNumber(item.recordCount);
                      const share = percent(count, totalCategoryRecords);
                      const width = Math.max(3, Math.round((Math.abs(dedupeNumber(item.magnitude)) / maxCategoryMagnitude) * 100));
                      return (
                        <div
                          className="list-item"
                          key={`${item.categoryName || "uncategorized"}-${item.direction}-${index}`}
                        >
                          <div className="list-main">
                            <div className="list-title">
                              {item.categoryName || "未分类"}
                              <Badge tone={directionTone(item.direction)}>
                                {item.direction === "ADD" ? "加分" : "减分"}
                              </Badge>
                            </div>
                            <div className="list-sub">
                              {formatScore(count)} 条记录 · 累计 {formatScore(item.magnitude)} 分 · 占比 {share}%
                            </div>
                            <div className="bar-track" style={{ marginTop: 6 }}>
                              <div
                                className={`bar-fill ${item.direction === "ADD" ? "add" : "deduct"}`}
                                style={{ width: `${width}%` }}
                              />
                            </div>
                          </div>
                          <div className="list-side">
                            <div className="score-value">{share}%</div>
                            <div className="text-xs muted">记录占比</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {categories.length > categoryRows.length && (
                    <p className="text-xs muted mt-2">
                      仅显示记录数前 {categoryRows.length} 个分类（共 {categories.length} 个），完整分类分析见数据分析。
                    </p>
                  )}
                  {topPositiveRules.length > 0 && (
                    <>
                      <div className="divider" style={{ margin: "14px 0 10px" }} />
                      <SectionTitle title="优秀表现规则 Top 5" hint="按累计加分数排序（加分口径）" />
                      <div className="stack gap-sm">
                        {topPositiveRules.slice(0, 5).map((rule, index) => (
                          <div key={`${rule.ruleName}-${index}`} className="list-item">
                            <span className="avatar-sm">{index + 1}</span>
                            <div className="list-main">
                              <div className="list-title">{rule.ruleName}</div>
                              <div className="list-sub">{formatScore(rule.recordCount)} 条记录</div>
                            </div>
                            <div className="list-side">
                              <div className="score-value score-add">+{formatScore(rule.magnitude)}</div>
                              <div className="text-xs muted">累计加分</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </Card>

            <Card
              title="异常提醒"
              subtitle="基于真实记录的规则化聚合，最多 5 条；关注标记仅保存在本机"
              actions={<BellRing size={16} className="muted" />}
            >
              {alerts.length === 0 ? (
                <EmptyState
                  compact
                  icon={<Sparkles size={20} />}
                  title="暂无异常提醒"
                  description="系统会关注近 24 小时减分集中、单条大额分值、长时间无记录等情况；当前范围内一切正常。"
                />
              ) : (
                <div className="stack">
                  {alerts.map((alert) => {
                    const marked = attention.includes(alert.id);
                    return (
                      <div className="list-item" key={alert.id}>
                        <span
                          className={
                            alert.level === "warn" ? "badge badge-warning" : "badge badge-info"
                          }
                          aria-hidden
                        >
                          <AlertTriangle size={12} /> {alert.level === "warn" ? "需关注" : "提示"}
                        </span>
                        <div className="list-main">
                          <div className="list-title">
                            {alert.title}
                            {typeof alert.count === "number" && alert.count > 0 && (
                              <Badge tone="neutral">{formatScore(alert.count)} 条</Badge>
                            )}
                          </div>
                          <div className="list-sub">{alert.description}</div>
                        </div>
                        <div className="list-side">
                          <Button
                            variant={marked ? "subtle" : "ghost"}
                            size="sm"
                            onClick={() => toggleAttention(alert.id)}
                            aria-pressed={marked}
                          >
                            {marked ? "已关注" : "标记关注"}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>

          {/* --------------------------------------------------------- 最近记录 */}
          <div className="mt-4">
            <Card
              title="最近记录"
              subtitle="最新 8 条记录（含待复核），点击可打开记录详情"
              actions={
                <Button variant="ghost" size="sm" onClick={() => onNavigate("records")}>
                  查看全部记录 <ChevronRight size={15} />
                </Button>
              }
            >
              {recentRecords.length === 0 ? (
                <EmptyState
                  compact
                  icon={<ListChecks size={20} />}
                  title="暂无积分记录"
                  description="当前学期还没有记录。值日老师可通过快捷记分录入加减分。"
                  action={
                    user.permissions.score ? (
                      <Button size="sm" variant="subtle" onClick={() => onNavigate("quick-score")}>
                        去记分
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="list">
                  {recentRecords.slice(0, 8).map((record) => (
                    <div
                      key={record.id}
                      className="list-item"
                      role="button"
                      tabIndex={0}
                      onClick={() => onNavigate("records", { recordId: record.id })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onNavigate("records", { recordId: record.id });
                        }
                      }}
                      aria-label={`查看 ${record.studentName} 的积分记录详情`}
                    >
                      <div className="list-main">
                        <div className="list-title">
                          {record.studentName}
                          <Badge tone={directionTone(record.direction)}>
                            {record.directionLabel} {formatScore(record.points)} 分
                          </Badge>
                          <Badge tone={recordStatusTone(record.status, record.reversed)}>
                            {record.statusLabel}
                          </Badge>
                        </div>
                        <div className="list-sub truncate">
                          {record.className} · {record.ruleName}
                          {record.note ? ` · ${record.note}` : ""}
                        </div>
                        <div className="list-sub">
                          发生时间 {formatDateTime(record.occurrenceAt)} · 提交人{" "}
                          {record.submitterName || "—"}
                        </div>
                      </div>
                      <div className="list-side">
                        <span
                          className={
                            record.direction === "ADD"
                              ? "score-pill add"
                              : "score-pill deduct"
                          }
                        >
                          {formatSignedScore(record.signedPoints)}
                          <small>分</small>
                        </span>
                        <div className="text-xs muted" style={{ marginTop: 4 }}>
                          {record.sourceLabel}
                        </div>
                      </div>
                      <ChevronRight size={16} className="muted" aria-hidden />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <p className="text-xs muted mt-4">
            数据说明：学期得分 = 初始分 + Σ已生效 signed_points；待复核/已驳回记录不计入统计。
            平均分按学生数计算，图表数据与上方学期筛选一致。
          </p>
        </>
      )}
    </div>
  );
}


