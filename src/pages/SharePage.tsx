// OWNER: frontend-ops. 家长分享公开只读页：按分享 token 渲染学生成长报告，
// 不展示班级排名或其他学生信息；支持打印 / 另存 PDF，移动端与打印友好。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Award, Gift, Printer, RefreshCw, ShieldCheck, Sprout, TrendingUp } from "lucide-react";
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
import { api, ApiError } from "../api";
import { formatDate, formatDateTime, formatMonthDay, formatScore } from "../format";
import { Alert, Badge, Button, EmptyState, Loading } from "../components/ui";
import type { StudentReport } from "../types";

interface ShareReport extends StudentReport {
  expiresAt?: string;
  shareLabel?: string;
}

type LoadError = { title: string; description: string; status: number };

const ADD_COLOR = "#14804a";
const DEDUCT_COLOR = "#b23a32";
const NET_COLOR = "#2f6df6";

function loadErrorOf(error: unknown): LoadError {
  if (error instanceof ApiError) {
    if (error.status === 404)
      return {
        status: 404,
        title: "分享链接无效或已过期",
        description: "该链接可能已过期、被学校撤销，或地址输入有误。请联系班主任重新获取成长报告分享链接。",
      };
    if (error.status === 429)
      return {
        status: 429,
        title: "访问过于频繁",
        description: "请稍等一分钟后再刷新本页。",
      };
    return {
      status: error.status,
      title: "报告暂时无法加载",
      description: error.message || "服务器开小差了，请稍后重试。",
    };
  }
  return {
    status: 0,
    title: "网络异常",
    description: "无法连接学校服务器，请检查网络后重试。",
  };
}

export function SharePage({ token }: { token: string }) {
  const [report, setReport] = useState<ShareReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<ShareReport>(`/public/share/${encodeURIComponent(token)}`);
      setReport(data);
    } catch (error) {
      setReport(null);
      setLoadError(loadErrorOf(error));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.title = "成长报告 · MES-MoralScore";
    return () => {
      document.title = "MES-MoralScore";
    };
  }, []);

  const narrativeLines = useMemo(() => {
    if (!report) return [];
    if (Array.isArray(report.narrative)) return report.narrative.filter(Boolean);
    return report.narrative ? [String(report.narrative)] : [];
  }, [report]);

  const trend = useMemo(() => report?.trend ?? [], [report]);
  const composition = useMemo(() => report?.composition ?? [], [report]);
  const maxComposition = useMemo(
    () => composition.reduce((max, item) => Math.max(max, Math.abs(item.magnitude || 0)), 0),
    [composition],
  );

  return (
    <div className="public-page">
      <div className="public-container">
        <div className="public-brand no-print">
          <div className="public-brand-left">
            <div className="brand-mark">MES</div>
            <div>
              <div className="public-brand-name">MES-MoralScore</div>
              <div className="public-brand-sub">校园德育量化 · 家长成长报告</div>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<Printer size={15} />}
            onClick={() => window.print()}
            disabled={!report}
          >
            打印 / 另存 PDF
          </Button>
        </div>

        {loading ? (
          <div className="public-card">
            <Loading label="正在加载成长报告…" />
          </div>
        ) : loadError ? (
          <div className="public-card">
            <EmptyState
              icon={<ShieldCheck size={24} />}
              title={loadError.title}
              description={loadError.description}
              action={
                loadError.status !== 404 ? (
                  <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => void load()}>
                    重新加载
                  </Button>
                ) : undefined
              }
            />
            <div className="privacy-foot">
              本页面仅通过学校签发的一次性分享链接访问；为保护学生隐私，链接撤销或过期后将无法查看，
              也不会展示任何其他学生信息。
            </div>
          </div>
        ) : report ? (
          <article className="report-sheet">
            <header className="report-head">
              <div>
                <div className="report-student-name">{report.student.name}</div>
                <div className="report-meta">
                  {report.student.gradeName}
                  {report.student.className} · {report.period?.label || "成长报告"}
                </div>
                <div className="report-meta">
                  {report.period?.from ? `${formatDate(report.period.from)} 至 ${formatDate(report.period.to)}` : ""}
                  {report.shareLabel ? ` · ${report.shareLabel}` : ""}
                </div>
                <div className="report-meta">生成时间：{formatDateTime(new Date())}</div>
              </div>
              <div className="report-score-block">
                <div className="big">{formatScore(report.score.total)}</div>
                <div className="sub">
                  当前总分（初始分 {formatScore(report.score.initialPoints)} + 净变动{" "}
                  {report.score.net > 0 ? "+" : ""}
                  {formatScore(report.score.net)}）
                </div>
              </div>
            </header>

            <div className="report-grid">
              <div className="report-stat">
                <div className="report-stat-label">本期加分</div>
                <div className="report-stat-value score-add">+{formatScore(report.score.adds)}</div>
              </div>
              <div className="report-stat">
                <div className="report-stat-label">本期减分</div>
                <div className="report-stat-value score-deduct">-{formatScore(report.score.deducts)}</div>
              </div>
              <div className="report-stat">
                <div className="report-stat-label">净变动</div>
                <div className="report-stat-value">
                  {report.score.net > 0 ? "+" : ""}
                  {formatScore(report.score.net)}
                </div>
              </div>
              <div className="report-stat">
                <div className="report-stat-label">有效记录</div>
                <div className="report-stat-value">{formatScore(report.score.recordCount)} 条</div>
              </div>
            </div>

            {narrativeLines.length > 0 && (
              <section className="report-section">
                <h2 className="report-section-title">成长概述</h2>
                <div className="report-narrative">
                  {narrativeLines.map((line, index) => (
                    <p key={index} style={{ margin: 0 }}>
                      {line}
                    </p>
                  ))}
                </div>
              </section>
            )}

            <section className="report-section">
              <h2 className="report-section-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <TrendingUp size={14} />
                本期加减分趋势（单位：分）
              </h2>
              {trend.length === 0 ? (
                <EmptyState compact title="本期暂无趋势数据" description="老师录入积分后，这里会按日期展示变化。" />
              ) : (
                <div className="chart-box" style={{ height: 240 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trend} margin={{ top: 8, right: 10, left: -18, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e6ebf3" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickFormatter={(value: string) => formatMonthDay(value)}
                        tick={{ fontSize: 11, fill: "#77839a" }}
                        tickMargin={6}
                      />
                      <YAxis tick={{ fontSize: 11, fill: "#77839a" }} width={42} />
                      <Tooltip
                        contentStyle={{ borderRadius: 10, borderColor: "#dbe3ee", fontSize: 12 }}
                        labelFormatter={(value) => `日期：${formatDate(String(value))}`}
                        formatter={(value, name) => [`${value ?? "—"} 分`, name]}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Line type="monotone" dataKey="adds" name="加分" stroke={ADD_COLOR} strokeWidth={2} dot={false} />
                      <Line
                        type="monotone"
                        dataKey="deducts"
                        name="减分"
                        stroke={DEDUCT_COLOR}
                        strokeWidth={2}
                        dot={false}
                      />
                      <Line type="monotone" dataKey="net" name="净变动" stroke={NET_COLOR} strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>

            <section className="report-section">
              <h2 className="report-section-title">分类构成</h2>
              {composition.length === 0 ? (
                <EmptyState compact title="本期暂无分类数据" />
              ) : (
                <div className="stack gap-sm">
                  {composition.map((item) => (
                    <div className="bar-row" key={`${item.categoryName}-${item.direction}`}>
                      <span className="bar-label" title={`${item.categoryName}（${item.direction === "ADD" ? "加分" : "减分"}）`}>
                        {item.categoryName}
                        <span className="muted text-xs"> · {item.direction === "ADD" ? "加分" : "减分"}</span>
                      </span>
                      <div className="bar-track">
                        <div
                          className={`bar-fill ${item.direction === "ADD" ? "add" : "deduct"}`}
                          style={{
                            width: `${maxComposition ? Math.max(4, Math.round((Math.abs(item.magnitude) / maxComposition) * 100)) : 0}%`,
                          }}
                        />
                      </div>
                      <span className="bar-value">
                        {item.magnitude} 分 · {item.recordCount} 条
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="report-section">
              <h2 className="report-section-title">本期亮点</h2>
              {(report.highlights ?? []).length === 0 ? (
                <EmptyState compact title="本期还没有记录亮点" description="持续的正向表现会在这里展示。" />
              ) : (
                <div className="list">
                  {(report.highlights ?? []).map((item, index) => (
                    <div className="list-item" key={`${item.ruleName}-${index}`}>
                      <div className="list-main">
                        <div className="list-title">
                          {item.ruleName}
                          <Badge tone="add">+{formatScore(item.points)} 分</Badge>
                          {item.categoryName && <Badge tone="neutral">{item.categoryName}</Badge>}
                        </div>
                        <div className="list-sub">
                          {formatDate(item.occurrenceAt)}
                          {item.note ? ` · ${item.note}` : ""}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {(report.attention ?? []).length > 0 && (
              <section className="report-section">
                <h2 className="report-section-title">需要关注</h2>
                <div className="list">
                  {(report.attention ?? []).map((item, index) => (
                    <div className="list-item" key={`${item.categoryName}-${index}`}>
                      <div className="list-main">
                        <div className="list-title">
                          {item.categoryName}
                          <Badge tone="warning">减分 {item.magnitude} 分</Badge>
                        </div>
                        <div className="list-sub">
                          本期共 {item.recordCount} 条记录，建议家校共同关注并帮助孩子改进。
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {(report.honors ?? []).length > 0 && (
              <section className="report-section">
                <h2 className="report-section-title">荣誉参考</h2>
                <div className="stack gap-sm">
                  {(report.honors ?? []).map((honor, index) => (
                    <div className={`report-honor ${honor.eligible ? "eligible" : ""}`} key={`${honor.name}-${index}`}>
                      <span className="report-honor-icon">
                        <Award size={17} />
                      </span>
                      <div className="list-main">
                        <div className="list-title">
                          {honor.name}
                          <Badge tone={honor.eligible ? "success" : "neutral"}>
                            {honor.eligible ? "已满足参评条件" : "暂未满足"}
                          </Badge>
                        </div>
                        <div className="list-sub">{honor.reason || honor.description}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {(report.rewards ?? []).length > 0 && (
              <section className="report-section">
                <h2 className="report-section-title">成长兑换参考</h2>
                <div className="list">
                  {(report.rewards ?? []).map((reward, index) => (
                    <div className="list-item" key={`${reward.name}-${index}`}>
                      <div className="list-main">
                        <div className="list-title">
                          {reward.name}
                          <Badge tone={reward.affordable ? "success" : "neutral"}>
                            {reward.affordable ? "积分已足够（参考）" : "积分暂不足（参考）"}
                          </Badge>
                        </div>
                        <div className="list-sub">
                          所需 {reward.pointsCost} 分{reward.description ? ` · ${reward.description}` : ""}
                        </div>
                      </div>
                      <span className="list-side muted">
                        <Gift size={16} />
                      </span>
                    </div>
                  ))}
                </div>
                <p className="muted text-xs" style={{ marginTop: 8 }}>
                  兑换仅为参考展示，不会自动扣分或核销，具体以学校德育处安排为准。
                </p>
              </section>
            )}

            {(report.ruleExplanations ?? []).length > 0 && (
              <section className="report-section">
                <h2 className="report-section-title">评分依据说明</h2>
                <div className="stack gap-sm">
                  {(report.ruleExplanations ?? []).map((rule, index) => (
                    <details
                      key={`${rule.name}-${index}`}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        padding: "9px 12px",
                        background: "var(--surface-2)",
                      }}
                    >
                      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                        {rule.name}
                        <span className="muted text-xs">
                          {" "}
                          · {rule.direction === "ADD" ? "加分" : "减分"} {rule.points} 分
                        </span>
                      </summary>
                      <div className="impact-detail text-sm muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
                        {rule.description}
                        {rule.examples ? (
                          <div style={{ marginTop: 4 }}>
                            <strong>示例：</strong>
                            {rule.examples}
                          </div>
                        ) : null}
                      </div>
                    </details>
                  ))}
                </div>
              </section>
            )}

            <div className="privacy-foot">
              <div>
                <ShieldCheck size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                {report.privacyNote || "本报告仅用于家校沟通，不展示班级排名与其他学生信息。"}
              </div>
              <div style={{ marginTop: 4 }}>
                本页仅展示学生个人的成长信息，不含班级排名、其他学生信息或完整学号；链接由学校签发，
                可随时撤销或到期。
                {report.expiresAt ? ` 当前链接有效期至 ${formatDateTime(report.expiresAt)}。` : ""}
              </div>
              <div style={{ marginTop: 4 }}>
                <Sprout size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                MES-MoralScore · 校园德育量化 · 家长只读入口
              </div>
            </div>
          </article>
        ) : (
          <div className="public-card">
            <Alert tone="info" title="报告暂无内容">
              请稍后刷新页面重试。
            </Alert>
          </div>
        )}

        <div className="no-print" style={{ textAlign: "center", marginTop: 16 }}>
          <span className="muted text-xs">
            本页面为只读页面，不会修改学生任何信息。如链接失效，请联系班主任重新生成。
          </span>
        </div>
      </div>
    </div>
  );
}
