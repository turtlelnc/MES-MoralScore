// OWNER: frontend-insight. 待核实申报：初审队列、通过/驳回/要求补充、申报链接管理。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Inbox,
  Link2,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  XCircle,
} from "lucide-react";
import { api, query, ApiError } from "../api";
import { dateTimeLocalInput, formatDate, formatDateTime, formatScore, formatSignedScore, toIso } from "../format";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  Segmented,
  Select,
  Textarea,
  useToast,
} from "../components/ui";
import type { BadgeTone } from "../components/ui";
import type {
  ClassItem,
  OptionsData,
  PageProps,
  Paginated,
  RecordView,
  RuleSummary,
  SubmissionView,
} from "../types";

/* ------------------------------------------------------------------ helpers */

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录状态已失效，请重新登录";
    if (error.status === 403) return "没有权限执行该操作，请联系德育处或管理员";
    if (error.status === 404) return error.message || "数据不存在或已被处理";
    if (error.status === 400) return error.message || "提交内容不符合要求";
    if (error.status >= 500) return "服务暂时不可用，请稍后重试";
    return error.message;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") return "请求超时，请稍后重试";
  return "网络异常，请检查网络后重试";
}

const STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  PENDING_REVIEW: { label: "待核实", tone: "warning" },
  APPROVED: { label: "已通过", tone: "success" },
  REJECTED: { label: "已驳回", tone: "danger" },
  NEEDS_INFO: { label: "需补充", tone: "info" },
};

const SOURCE_LABEL: Record<string, string> = {
  CADRE_LINK: "学生干部申报",
  TEACHER: "教师登记",
};

const TABS: Array<{ value: string; label: string }> = [
  { value: "PENDING_REVIEW", label: "待核实" },
  { value: "APPROVED", label: "已通过" },
  { value: "REJECTED", label: "已驳回" },
  { value: "NEEDS_INFO", label: "需补充" },
];

function statusMeta(status: string, statusLabel?: string) {
  return STATUS_META[status] || { label: statusLabel || status, tone: "neutral" as BadgeTone };
}

function directionLabel(direction: "ADD" | "DEDUCT") {
  return direction === "ADD" ? "加分" : "减分";
}

function directionTone(direction: "ADD" | "DEDUCT"): BadgeTone {
  return direction === "ADD" ? "add" : "deduct";
}

/** 已发布规则按学生班级/年级过滤适用范围。 */
function applicableRules(rules: RuleSummary[], submission: SubmissionView, classes: ClassItem[]): RuleSummary[] {
  const classInfo = classes.find((item) => item.id === submission.classId);
  return rules.filter((rule) => {
    if (rule.archived) return false;
    if (rule.direction !== submission.direction) return false;
    if (rule.targetScope === "ALL") return true;
    if (rule.targetScope === "GRADE") return Boolean(classInfo && rule.scopeIds.includes(classInfo.gradeId));
    if (rule.targetScope === "CLASS") return rule.scopeIds.includes(submission.classId);
    return false;
  });
}

async function copyToClipboard(text: string): Promise<boolean> {
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

/* -------------------------------------------------------------------- page */

export function SubmissionsPage({ user, onNavigate, params }: PageProps) {
  const toast = useToast();
  const canManage = user.permissions.manageSubmissions;
  const canManageLinks =
    canManage && (user.role === "SYSTEM_ADMIN" || user.role === "MORAL_AFFAIRS");

  const [status, setStatus] = useState(() =>
    TABS.some((tab) => tab.value === params.status) ? params.status : "PENDING_REVIEW",
  );
  const [classId, setClassId] = useState("");
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [list, setList] = useState<Paginated<SubmissionView> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [tokensOpen, setTokensOpen] = useState(false);

  const [options, setOptions] = useState<OptionsData | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [optionsLoading, setOptionsLoading] = useState(true);

  const loadOptions = useCallback(async () => {
    setOptionsLoading(true);
    setOptionsError("");
    try {
      const data = await api<OptionsData>("/options");
      setOptions(data);
    } catch (requestError) {
      setOptionsError(errorText(requestError));
    } finally {
      setOptionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  useEffect(() => {
    if (!canManage) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<Paginated<SubmissionView>>(
      `/submissions${query({ status, classId: classId || undefined, page })}`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setList(data);
      })
      .catch((requestError) => {
        if (controller.signal.aborted) return;
        setError(errorText(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [canManage, status, classId, page, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const items = list?.items ?? [];
  const total = list?.total ?? 0;

  const classOptions = options?.classes ?? [];

  if (!canManage) {
    return (
      <div className="page">
        <PageHeader title="待核实申报" description="学生干部申报的教师初审队列。" />
        <Card>
          <EmptyState
            title="无权查看待核实申报"
            description="当前账号没有申报审核权限（manageSubmissions），请联系德育处或系统管理员分配权限。"
            icon={<ShieldAlert size={22} />}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="待核实申报"
        description="学生干部申报需经授权教师核实后才能生成积分记录；驳回或要求补充必须填写理由。"
        actions={
          <>
            <Button
              variant="secondary"
              icon={<RefreshCw size={16} />}
              onClick={reload}
              loading={loading}
            >
              刷新
            </Button>
            {canManageLinks && (
              <Button variant="secondary" icon={<Link2 size={16} />} onClick={() => setTokensOpen(true)}>
                申报链接管理
              </Button>
            )}
          </>
        }
      />

      <Card title="申报队列" subtitle="待核实申报不直接产生积分，通过后才会写入积分账本。">
        <div className="filters" style={{ marginBottom: 10 }}>
          <Segmented
            value={status}
            options={TABS}
            onChange={(next) => {
              setStatus(next);
              setPage(1);
            }}
            ariaLabel="申报状态"
            size="sm"
          />
        </div>
        <div className="filters" style={{ marginBottom: 12 }}>
          <Select
            value={classId}
            aria-label="按班级筛选"
            onChange={(event) => {
              setClassId(event.target.value);
              setPage(1);
            }}
            style={{ maxWidth: 220 }}
          >
            <option value="">全部班级</option>
            {classOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.gradeName} · {item.name}
              </option>
            ))}
          </Select>
          {optionsLoading && <span className="muted text-xs">正在加载班级列表…</span>}
          {optionsError && (
            <span className="muted text-xs">
              班级列表加载失败：
              <button type="button" className="link" onClick={() => void loadOptions()}>
                重试
              </button>
            </span>
          )}
        </div>

        {error && (
          <Alert tone="danger" title="申报列表加载失败" onRetry={reload}>
            {error}
          </Alert>
        )}

        {!error && loading && <Loading label="正在加载申报队列…" />}

        {!error && !loading && items.length === 0 && (
          <EmptyState
            icon={<Inbox size={22} />}
            title={status === "PENDING_REVIEW" ? "暂无待核实申报" : "该状态下暂无申报"}
            description={
              status === "PENDING_REVIEW"
                ? "学生通过申报链接提交后会自动出现在这里，通过后才生成正式积分记录。"
                : "切换上方状态标签查看其他申报。"
            }
          />
        )}

        {!error && !loading && items.length > 0 && (
          <>
            <div className="table-wrap table-responsive">
              <table className="table">
                <thead>
                  <tr>
                    <th>学生</th>
                    <th>班级</th>
                    <th>分类</th>
                    <th>方向</th>
                    <th>描述</th>
                    <th>提交时间</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const meta = statusMeta(item.status, item.statusLabel);
                    return (
                      <tr key={item.id}>
                        <td className="cell-strong">
                          {item.studentName}
                          <div className="muted text-xs">{item.studentNo}</div>
                        </td>
                        <td>
                          {item.gradeName} {item.className}
                        </td>
                        <td>{item.categoryName || "—"}</td>
                        <td>
                          <Badge tone={directionTone(item.direction)}>
                            {directionLabel(item.direction)}
                          </Badge>
                        </td>
                        <td style={{ maxWidth: 260 }}>
                          <div className="truncate" title={item.description}>
                            {item.description}
                          </div>
                        </td>
                        <td className="no-wrap">{formatDateTime(item.createdAt)}</td>
                        <td>
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                        </td>
                        <td>
                          <Button size="sm" variant="secondary" onClick={() => setDetailId(item.id)}>
                            详情
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 移动端卡片列表 */}
            <div className="table-card">
              {items.map((item) => {
                const meta = statusMeta(item.status, item.statusLabel);
                return (
                  <div className="record-card" key={`card-${item.id}`}>
                    <div className="record-card-head">
                      <div>
                        <div className="record-card-name">
                          {item.studentName}{" "}
                          <span className="muted text-xs mono">{item.studentNo}</span>
                        </div>
                        <div className="record-card-meta">
                          {item.gradeName} {item.className} · {item.categoryName || "未分类"}
                        </div>
                      </div>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </div>
                    <div className="row" style={{ marginTop: 8 }}>
                      <Badge tone={directionTone(item.direction)}>{directionLabel(item.direction)}</Badge>
                      <span className="muted text-xs">{SOURCE_LABEL[item.source] || item.source}</span>
                      <span className="muted text-xs">{formatDateTime(item.createdAt)}</span>
                    </div>
                    <p className="list-sub">{item.description}</p>
                    <div className="form-actions between">
                      <span className="muted text-xs">
                        {item.reviewerName ? `审核人：${item.reviewerName}` : "尚未审核"}
                      </span>
                      <Button size="sm" variant="secondary" onClick={() => setDetailId(item.id)}>
                        查看详情
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            <Pagination
              page={list?.page ?? page}
              totalPages={list?.totalPages ?? 1}
              total={total}
              unit="条申报"
              onChange={setPage}
            />
          </>
        )}
      </Card>

      {detailId && (
        <SubmissionDetailModal
          submissionId={detailId}
          options={options}
          optionsError={optionsError}
          onRetryOptions={() => void loadOptions()}
          canManage={canManage}
          onClose={() => setDetailId(null)}
          onChanged={reload}
          onNavigate={onNavigate}
        />
      )}

      {tokensOpen && (
        <TokenManagerModal
          options={options}
          optionsError={optionsError}
          onRetryOptions={() => void loadOptions()}
          onClose={() => setTokensOpen(false)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------- submission detail */

function SubmissionDetailModal({
  submissionId,
  options,
  optionsError,
  onRetryOptions,
  canManage,
  onClose,
  onChanged,
  onNavigate,
}: {
  submissionId: string;
  options: OptionsData | null;
  optionsError: string;
  onRetryOptions: () => void;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
  onNavigate: PageProps["onNavigate"];
}) {
  const toast = useToast();
  const [submission, setSubmission] = useState<SubmissionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [approveOpen, setApproveOpen] = useState(false);
  const [reasonAction, setReasonAction] = useState<"reject" | "request-info" | null>(null);
  const [approvedRecord, setApprovedRecord] = useState<RecordView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ submission: SubmissionView }>(`/submissions/${submissionId}`);
      setSubmission(data.submission);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setLoading(false);
    }
  }, [submissionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const meta = submission ? statusMeta(submission.status, submission.statusLabel) : null;
  const actionable = Boolean(submission && (submission.status === "PENDING_REVIEW" || submission.status === "NEEDS_INFO"));

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="申报详情"
        description={submission ? `${submission.studentName} · ${submission.className}` : "正在读取申报详情…"}
        size="lg"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={onClose}>
              关闭
            </Button>
            {actionable && canManage && (
              <>
                <Button
                  variant="secondary"
                  icon={<MessageSquarePlus size={15} />}
                  onClick={() => setReasonAction("request-info")}
                >
                  要求补充
                </Button>
                <Button
                  variant="danger"
                  icon={<XCircle size={15} />}
                  onClick={() => setReasonAction("reject")}
                >
                  驳回
                </Button>
                <Button icon={<CheckCircle2 size={15} />} onClick={() => setApproveOpen(true)}>
                  通过并生成积分
                </Button>
              </>
            )}
          </div>
        }
      >
        {loading && <Loading label="正在读取申报详情…" />}
        {!loading && error && (
          <Alert tone="danger" title="申报详情加载失败" onRetry={() => void load()}>
            {error}
          </Alert>
        )}

        {!loading && !error && submission && (
          <div className="stack gap-lg">
            {approvedRecord && (
              <Alert tone="success" title="已通过并生成积分记录">
                <div>
                  {approvedRecord.studentName} · {approvedRecord.ruleName} ·{" "}
                  <strong className={approvedRecord.direction === "ADD" ? "score-add" : "score-deduct"}>
                    {formatSignedScore(approvedRecord.signedPoints)} 分
                  </strong>{" "}
                  · {formatDateTime(approvedRecord.occurrenceAt)} · 状态：{approvedRecord.statusLabel}
                </div>
                <div className="row mt-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<ExternalLink size={14} />}
                    onClick={() =>
                      onNavigate("records", {
                        studentId: submission.studentId ?? "",
                        classId: submission.classId,
                      })
                    }
                  >
                    查看积分记录
                  </Button>
                </div>
              </Alert>
            )}

            <div className="row" style={{ gap: 8 }}>
              {meta && <Badge tone={meta.tone}>{meta.label}</Badge>}
              <Badge tone={directionTone(submission.direction)}>{directionLabel(submission.direction)}</Badge>
              <Badge tone="neutral">{SOURCE_LABEL[submission.source] || submission.source}</Badge>
              <Badge tone="brand">{submission.categoryName || "未分类"}</Badge>
            </div>

            <dl className="kv">
              <dt>学生</dt>
              <dd>
                {submission.studentName}{" "}
                <span className="muted mono text-xs">{submission.studentNo}</span>
              </dd>
              <dt>班级</dt>
              <dd>
                {submission.gradeName} {submission.className}
              </dd>
              <dt>提交时间</dt>
              <dd>{formatDateTime(submission.createdAt)}</dd>
              <dt>审核人</dt>
              <dd>{submission.reviewerName || "尚未审核"}</dd>
              <dt>审核时间</dt>
              <dd>{formatDateTime(submission.reviewedAt)}</dd>
              <dt>审核意见</dt>
              <dd>{submission.reviewNote || "—"}</dd>
            </dl>

            <div>
              <div className="field-label">申报描述</div>
              <div className="record-card mt-2" style={{ whiteSpace: "pre-wrap" }}>
                {submission.description}
              </div>
            </div>

            {submission.scoreRecordId && (
              <div className="notice notice-info">
                该申报已生成正式积分记录（记录编号 <span className="mono">{submission.scoreRecordId}</span>）。
              </div>
            )}
          </div>
        )}
      </Modal>

      {approveOpen && submission && (
        <ApproveDialog
          submission={submission}
          options={options}
          optionsError={optionsError}
          onRetryOptions={onRetryOptions}
          onClose={() => setApproveOpen(false)}
          onSuccess={(record) => {
            setApproveOpen(false);
            setApprovedRecord(record);
            toast("申报已通过，已生成积分记录", "success");
            onChanged();
            void load();
          }}
        />
      )}

      {reasonAction && (
        <ReasonDialog
          submissionId={submissionId}
          action={reasonAction}
          onClose={() => setReasonAction(null)}
          onSuccess={() => {
            setReasonAction(null);
            toast(reasonAction === "reject" ? "申报已驳回" : "已要求申报人补充材料", "success");
            onChanged();
            void load();
          }}
        />
      )}
    </>
  );
}

/* -------------------------------------------------------------- approve dialog */

function ApproveDialog({
  submission,
  options,
  optionsError,
  onRetryOptions,
  onClose,
  onSuccess,
}: {
  submission: SubmissionView;
  options: OptionsData | null;
  optionsError: string;
  onRetryOptions: () => void;
  onClose: () => void;
  onSuccess: (record: RecordView) => void;
}) {
  const rules = useMemo(
    () => (options ? applicableRules(options.publishedRules, submission, options.classes) : []),
    [options, submission],
  );
  const categoryNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const category of options?.categories ?? []) map.set(category.id, category.name);
    return map;
  }, [options]);
  const categoryNameOf = useCallback(
    (rule: RuleSummary) =>
      rule.categoryName || (rule.categoryId ? categoryNames.get(rule.categoryId) : "") || "未分类",
    [categoryNames],
  );
  const sortedRules = useMemo(() => {
    return [...rules].sort((a, b) => {
      const aSame = a.categoryId === submission.categoryId ? 0 : 1;
      const bSame = b.categoryId === submission.categoryId ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });
  }, [rules, submission.categoryId]);

  const grouped = useMemo(() => {
    const map = new Map<string, RuleSummary[]>();
    for (const rule of sortedRules) {
      const key = categoryNameOf(rule);
      const list = map.get(key) || [];
      list.push(rule);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [sortedRules, categoryNameOf]);

  const [ruleId, setRuleId] = useState(sortedRules[0]?.id ?? "");
  const [occurrenceAt, setOccurrenceAt] = useState(dateTimeLocalInput(submission.createdAt));
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const selectedRule = sortedRules.find((rule) => rule.id === ruleId) || null;

  function startConfirm() {
    setFormError("");
    if (!ruleId) {
      setFormError("请选择一条已发布的评分规则");
      return;
    }
    if (!occurrenceAt) {
      setFormError("请填写发生时间");
      return;
    }
    setConfirming(true);
  }

  async function submit() {
    setSaving(true);
    try {
      const data = await api<{ submission: SubmissionView; record: RecordView }>(
        `/submissions/${submission.id}/approve`,
        {
          method: "POST",
          body: JSON.stringify({
            ruleId,
            occurrenceAt: toIso(occurrenceAt),
            note: note.trim() || undefined,
          }),
        },
      );
      setConfirming(false);
      onSuccess(data.record);
    } catch (requestError) {
      setConfirming(false);
      setFormError(errorText(requestError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="通过申报并生成积分"
        description={`${submission.studentName} · ${submission.gradeName} ${submission.className} · ${submission.categoryName || "未分类"}`}
        size="md"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button icon={<CheckCircle2 size={15} />} onClick={startConfirm} disabled={sortedRules.length === 0}>
              下一步：确认生成
            </Button>
          </div>
        }
      >
        <div className="stack">
          <div className="notice notice-info">
            通过后将为该学生生成正式积分记录（来源：学生干部申报）。若规则要求复核或分值超过阈值，记录可能进入待复核状态。
          </div>

          {optionsError && (
            <Alert tone="danger" title="规则选项加载失败" onRetry={onRetryOptions}>
              {optionsError}
            </Alert>
          )}

          {!optionsError && options && sortedRules.length === 0 && (
            <EmptyState
              compact
              title="没有匹配的已发布规则"
              description="当前学生所在班级/年级没有与该申报方向匹配的已发布规则。请先由德育处发布规则，或选择驳回/要求补充。"
            />
          )}

          {sortedRules.length > 0 && (
            <>
              <Field
                label="评分规则"
                required
                hint="仅列出已发布且适用于该学生班级/年级、方向一致的规则；同分类规则优先展示。"
              >
                <Select value={ruleId} onChange={(event) => setRuleId(event.target.value)}>
                  {grouped.map(([categoryName, groupRules]) => (
                    <optgroup key={categoryName} label={categoryName}>
                      {groupRules.map((rule) => (
                        <option key={rule.id} value={rule.id}>
                          {rule.name}（{rule.direction === "ADD" ? "+" : "-"}
                          {formatScore(rule.points)} 分）
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </Field>

              {selectedRule && (
                <div className="notice notice-info">
                  <strong>{selectedRule.name}</strong> · {categoryNameOf(selectedRule)} ·{" "}
                  <Badge tone={directionTone(selectedRule.direction)}>
                    {directionLabel(selectedRule.direction)}{" "}
                    {formatScore(selectedRule.points)} 分
                  </Badge>
                  {selectedRule.effectiveFrom && (
                    <span className="muted text-xs">
                      {" "}
                      （生效：{formatDate(selectedRule.effectiveFrom)}
                      {selectedRule.effectiveTo ? ` 至 ${formatDate(selectedRule.effectiveTo)}` : " 起"}）
                    </span>
                  )}
                </div>
              )}

              <Field label="发生时间" required>
                <Input
                  type="datetime-local"
                  value={occurrenceAt}
                  onChange={(event) => setOccurrenceAt(event.target.value)}
                />
              </Field>

              <Field label="核实说明" hint="可选，会写入积分记录备注，便于后续追溯。">
                <Textarea
                  rows={3}
                  maxLength={500}
                  placeholder="例如：已向班主任核实，学生确实参与了志愿服务。"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </Field>
            </>
          )}

          {formError && <div className="alert alert-danger">{formError}</div>}
        </div>
      </Modal>

      {confirming && selectedRule && (
        <ConfirmDialog
          open
          title="确认通过该申报？"
          description="通过后将立即生成一条正式积分记录，操作会写入审计日志。"
          confirmLabel="确认通过"
          loading={saving}
          onConfirm={() => void submit()}
          onClose={() => setConfirming(false)}
        >
          <dl className="kv">
            <dt>学生</dt>
            <dd>
              {submission.studentName}（{submission.className}）
            </dd>
            <dt>规则</dt>
            <dd>{selectedRule.name}</dd>
            <dt>分值</dt>
            <dd>
              {directionLabel(selectedRule.direction)} {formatScore(selectedRule.points)} 分
            </dd>
            <dt>发生时间</dt>
            <dd>{formatDateTime(occurrenceAt)}</dd>
          </dl>
        </ConfirmDialog>
      )}
    </>
  );
}

/* --------------------------------------------------------------- reason dialog */

function ReasonDialog({
  submissionId,
  action,
  onClose,
  onSuccess,
}: {
  submissionId: string;
  action: "reject" | "request-info";
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const isReject = action === "reject";
  const title = isReject ? "驳回申报" : "要求补充材料";

  function startConfirm() {
    setFormError("");
    if (reason.trim().length < 2) {
      setFormError("请填写至少 2 个字的原因");
      return;
    }
    setConfirming(true);
  }

  async function submit() {
    setSaving(true);
    try {
      await api(`/submissions/${submissionId}/${isReject ? "reject" : "request-info"}`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      });
      setConfirming(false);
      onSuccess();
    } catch (requestError) {
      setConfirming(false);
      setFormError(errorText(requestError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={title}
        description={isReject ? "驳回后该申报不会产生积分，申报人可看到驳回理由。" : "要求补充后申报人会看到原因，并可重新提交说明。"}
        size="sm"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button variant={isReject ? "danger" : "primary"} onClick={startConfirm}>
              下一步：确认{isReject ? "驳回" : "要求补充"}
            </Button>
          </div>
        }
      >
        <div className="stack">
          <Field
            label={isReject ? "驳回原因" : "补充要求"}
            required
            hint="至少 2 个字；会展示给申报人与审核记录。"
            error={formError}
          >
            <Textarea
              rows={4}
              maxLength={500}
              autoFocus
              placeholder={isReject ? "例如：描述与事实不符，未提供可核实信息。" : "例如：请补充参与活动的时间与证明人。"}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <div className="muted text-xs">{reason.trim().length} / 500 字</div>
        </div>
      </Modal>

      {confirming && (
        <ConfirmDialog
          open
          title={`确认${isReject ? "驳回" : "要求补充"}该申报？`}
          description="操作会立即生效并写入审计日志。"
          confirmLabel={`确认${isReject ? "驳回" : "要求补充"}`}
          danger={isReject}
          loading={saving}
          onConfirm={() => void submit()}
          onClose={() => setConfirming(false)}
        >
          <p style={{ whiteSpace: "pre-wrap" }}>{reason.trim()}</p>
        </ConfirmDialog>
      )}
    </>
  );
}

/* ------------------------------------------------------------- token manager */

interface SubmissionTokenItem {
  id: string;
  classId?: string;
  className?: string;
  gradeName?: string;
  label?: string;
  expiresAt: string;
  createdAt?: string;
  revokedAt?: string | null;
  status?: string;
  statusLabel?: string;
  useCount?: number;
  submissionCount?: number;
  lastUsedAt?: string | null;
  createdByName?: string;
}

interface CreatedToken {
  id?: string;
  token?: string;
  url?: string;
  expiresAt?: string;
}

function tokenStatus(token: SubmissionTokenItem): { label: string; tone: BadgeTone } {
  const status = (token.status || "").toUpperCase();
  if (status === "REVOKED" || token.revokedAt) {
    return { label: token.statusLabel || "已撤销", tone: "danger" };
  }
  if (status === "EXPIRED") return { label: token.statusLabel || "已过期", tone: "neutral" };
  if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) {
    return { label: "已过期", tone: "neutral" };
  }
  if (status === "ACTIVE" || !status) {
    return { label: token.statusLabel || "有效", tone: "success" };
  }
  return { label: token.statusLabel || status, tone: "neutral" };
}

function TokenManagerModal({
  options,
  optionsError,
  onRetryOptions,
  onClose,
}: {
  options: OptionsData | null;
  optionsError: string;
  onRetryOptions: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const classes = options?.classes ?? [];

  const [items, setItems] = useState<SubmissionTokenItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [classId, setClassId] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [created, setCreated] = useState<{ link: string; expiresAt: string } | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<SubmissionTokenItem | null>(null);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<{ items: SubmissionTokenItem[] }>("/submission-tokens", { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setItems(data.items || []);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(errorText(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    if (!classId && classes.length > 0) setClassId(classes[0].id);
  }, [classId, classes]);

  async function createToken() {
    setCreateError("");
    if (!classId) {
      setCreateError("请选择班级");
      return;
    }
    const days = Number(expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setCreateError("有效期需为 1～365 天的整数");
      return;
    }
    setCreating(true);
    try {
      const data = await api<CreatedToken>("/submission-tokens", {
        method: "POST",
        body: JSON.stringify({
          classId,
          expiresInDays: days,
          label: label.trim() || undefined,
        }),
      });
      const link = data.token
        ? `${window.location.origin}/#/submit/${data.token}`
        : data.url
          ? new URL(data.url, window.location.origin).href
          : "";
      setCreated({ link, expiresAt: data.expiresAt || "" });
      toast("申报链接已创建，请及时复制保存", "success");
      setReloadKey((key) => key + 1);
    } catch (requestError) {
      setCreateError(errorText(requestError));
    } finally {
      setCreating(false);
    }
  }

  async function revoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await api(`/submission-tokens/${revokeTarget.id}/revoke`, { method: "POST", body: "{}" });
      toast("申报链接已撤销", "success");
      setRevokeTarget(null);
      setReloadKey((key) => key + 1);
    } catch (requestError) {
      toast(errorText(requestError), "error");
    } finally {
      setRevoking(false);
    }
  }

  async function copyCreated() {
    if (!created) return;
    const ok = await copyToClipboard(created.link);
    if (ok) toast("链接已复制", "success");
    else toast("复制失败，请手动选择链接复制", "error");
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="学生干部申报链接管理"
        description="申报链接按班级生成，只能提交待核实申报，不会直接产生积分。"
        size="xl"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={onClose}>
              关闭
            </Button>
          </div>
        }
      >
        <div className="stack gap-lg">
          <div className="notice notice-warning">
            链接原文只在创建成功时显示一次（数据库只保存哈希），请立即复制并妥善保存；可随时撤销。
          </div>

          {created && (
            <Alert tone="success" title="申报链接创建成功">
              <div className="stack gap-sm">
                <div className="code-block" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                  {created.link}
                </div>
                <div className="row">
                  <Button size="sm" variant="secondary" icon={<Copy size={14} />} onClick={() => void copyCreated()}>
                    复制链接
                  </Button>
                  {created.expiresAt && (
                    <span className="muted text-xs">有效期至 {formatDateTime(created.expiresAt)}</span>
                  )}
                </div>
                <div className="text-xs muted">
                  访问方式：浏览器打开该链接后，学生填写学号 + 姓名校验身份并提交申报。
                </div>
              </div>
            </Alert>
          )}

          <div className="form-section">
            <div className="form-section-title">
              <Plus size={14} style={{ display: "inline", marginRight: 5 }} />
              创建新的班级申报链接
            </div>
            {optionsError ? (
              <Alert tone="danger" title="班级列表加载失败" onRetry={onRetryOptions}>
                {optionsError}
              </Alert>
            ) : (
              <div className="form-grid cols-2">
                <Field label="班级" required>
                  <Select value={classId} onChange={(event) => setClassId(event.target.value)}>
                    {classes.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.gradeName} · {item.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="有效期（天）" required hint="1～365 天，过期后链接自动失效。">
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    inputMode="numeric"
                    value={expiresInDays}
                    onChange={(event) => setExpiresInDays(event.target.value)}
                  />
                </Field>
                <Field label="备注标签" className="span-2" hint="可选，例如「七年级1班 10 月申报」。">
                  <Input
                    maxLength={60}
                    placeholder="选填，便于区分链接用途"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </Field>
              </div>
            )}
            {createError && <div className="alert alert-danger">{createError}</div>}
            <div className="form-actions">
              <Button icon={<Link2 size={15} />} loading={creating} onClick={() => void createToken()}>
                生成申报链接
              </Button>
            </div>
          </div>

          <div>
            <div className="form-section-title" style={{ marginBottom: 8 }}>
              已创建的申报链接
            </div>
            {loading && <Loading label="正在加载申报链接…" />}
            {!loading && error && (
              <Alert tone="danger" title="申报链接加载失败" onRetry={() => setReloadKey((key) => key + 1)}>
                {error}
              </Alert>
            )}
            {!loading && !error && items.length === 0 && (
              <EmptyState compact title="暂无申报链接" description="为班级创建链接后，学生即可通过链接提交待核实申报。" />
            )}
            {!loading && !error && items.length > 0 && (
              <div className="table-wrap">
                <table className="table" style={{ minWidth: 560 }}>
                  <thead>
                    <tr>
                      <th>班级</th>
                      <th>备注</th>
                      <th>有效期</th>
                      <th>使用次数</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((token) => {
                      const status = tokenStatus(token);
                      const cls = classes.find((item) => item.id === token.classId);
                      return (
                        <tr key={token.id}>
                          <td className="cell-strong">
                            {token.className || (cls ? `${cls.gradeName} · ${cls.name}` : "—")}
                          </td>
                          <td>{token.label || "—"}</td>
                          <td className="no-wrap">
                            {formatDateTime(token.expiresAt)}
                            {token.createdAt && (
                              <div className="muted text-xs">创建于 {formatDate(token.createdAt)}</div>
                            )}
                          </td>
                          <td>
                            {token.useCount ?? 0} 次
                            {typeof token.submissionCount === "number" && (
                              <div className="muted text-xs">申报 {token.submissionCount} 条</div>
                            )}
                          </td>
                          <td>
                            <Badge tone={status.tone}>{status.label}</Badge>
                          </td>
                          <td>
                            {status.label === "有效" ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                icon={<Trash2 size={13} />}
                                onClick={() => setRevokeTarget(token)}
                              >
                                撤销
                              </Button>
                            ) : (
                              <span className="muted text-xs">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </Modal>

      {revokeTarget && (
        <ConfirmDialog
          open
          title="确认撤销该申报链接？"
          description="撤销后学生将无法再通过该链接提交申报，已提交的申报不受影响。"
          confirmLabel="确认撤销"
          danger
          loading={revoking}
          onConfirm={() => void revoke()}
          onClose={() => setRevokeTarget(null)}
        >
          <p>
            {revokeTarget.className || "该班级"} · {revokeTarget.label || "无备注"}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

