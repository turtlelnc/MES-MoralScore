// OWNER: frontend-insight. 申诉中心：登记申诉、状态流转、德育处裁决（冲正/更正）。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  ClipboardList,
  FileText,
  Gavel,
  Paperclip,
  PlayCircle,
  Plus,
  RefreshCw,
  Scale,
  ShieldAlert,
  Trash2,
  XCircle,
} from "lucide-react";
import { api, query, ApiError } from "../api";
import { formatBytes, formatDate, formatDateTime, formatScore, formatSignedScore } from "../format";
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
  cn,
  useToast,
} from "../components/ui";
import type { BadgeTone } from "../components/ui";
import type {
  AppealDecision,
  AppealView,
  EvidenceRef,
  OptionsData,
  PageProps,
  Paginated,
  RecordView,
  RuleSummary,
} from "../types";

/* ------------------------------------------------------------------ helpers */

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录状态已失效，请重新登录";
    if (error.status === 403) return "没有权限执行该操作，请联系德育处或管理员";
    if (error.status === 404) return error.message || "数据不存在或已被处理";
    if (error.status === 413) return "文件超过大小上限（单个证据不超过 8MB）";
    if (error.status === 400) return error.message || "提交内容不符合要求";
    if (error.status >= 500) return "服务暂时不可用，请稍后重试";
    return error.message;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") return "请求超时，请稍后重试";
  return "网络异常，请检查网络后重试";
}

/* 证据上传限制：与后端 evidenceMaxMb / validateEvidenceIds 对齐。 */
const MAX_EVIDENCE_COUNT = 5;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const EVIDENCE_ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";
const EVIDENCE_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const EVIDENCE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".pdf"];

function evidenceMimeLabel(mime: string): string {
  if (mime === "image/png") return "PNG 图片";
  if (mime === "image/jpeg") return "JPG 图片";
  if (mime === "image/webp") return "WebP 图片";
  if (mime === "application/pdf") return "PDF 文档";
  return mime || "文件";
}

function isAllowedEvidenceType(file: File): boolean {
  if (file.type && EVIDENCE_TYPES.includes(file.type)) return true;
  const name = file.name.toLowerCase();
  return EVIDENCE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

const STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  SUBMITTED: { label: "待受理", tone: "warning" },
  UNDER_REVIEW: { label: "处理中", tone: "info" },
  ACCEPTED: { label: "已接受", tone: "success" },
  REJECTED: { label: "已驳回", tone: "danger" },
};

const DECISION_META: Record<string, { label: string; tone: BadgeTone }> = {
  UNDER_REVIEW: { label: "受理申诉", tone: "info" },
  ACCEPTED: { label: "接受申诉", tone: "success" },
  REJECTED: { label: "驳回申诉", tone: "danger" },
};

const TABS: Array<{ value: string; label: string }> = [
  { value: "", label: "全部" },
  { value: "SUBMITTED", label: "待受理" },
  { value: "UNDER_REVIEW", label: "处理中" },
  { value: "ACCEPTED", label: "已接受" },
  { value: "REJECTED", label: "已驳回" },
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

/** 有效记录快照里选择新规则时使用的已发布规则列表。 */
function publishedRulesOf(rules: RuleSummary[]): RuleSummary[] {
  return rules.filter((rule) => !rule.archived);
}

interface StudentOption {
  id: string;
  name: string;
  studentNo?: string;
  className?: string;
  classId?: string;
}

interface AppealDetail {
  appeal: AppealView;
  record: RecordView;
  decisions: AppealDecision[];
}

/* -------------------------------------------------------------------- page */

export function AppealsPage({ user, onNavigate, params }: PageProps) {
  const toast = useToast();
  const canRegister = user.permissions.registerAppeals;
  const canDecide = user.permissions.decideAppeals;

  const [status, setStatus] = useState("SUBMITTED");
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [list, setList] = useState<Paginated<AppealView> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detailId, setDetailId] = useState<string | null>(params.appealId || null);
  const [registerOpen, setRegisterOpen] = useState(() => Boolean(params.recordId));

  const [options, setOptions] = useState<OptionsData | null>(null);
  const [optionsError, setOptionsError] = useState("");

  const loadOptions = useCallback(async () => {
    setOptionsError("");
    try {
      const data = await api<OptionsData>("/options");
      setOptions(data);
    } catch (requestError) {
      setOptionsError(errorText(requestError));
    }
  }, []);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  useEffect(() => {
    if (!canRegister) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<Paginated<AppealView>>(
      `/appeals${query({ status: status || undefined, page })}`,
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
  }, [canRegister, status, page, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  const items = list?.items ?? [];

  if (!canRegister) {
    return (
      <div className="page">
        <PageHeader title="申诉中心" description="申诉登记、状态流转与德育处裁决。" />
        <Card>
          <EmptyState
            title="无权访问申诉中心"
            description="当前账号没有申诉登记权限（registerAppeals），请联系德育处或系统管理员分配权限。"
            icon={<ShieldAlert size={22} />}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="申诉中心"
        description="申诉只针对已生效积分记录登记；德育处必须填写理由后裁决，接受申诉通过冲正/更正账本处理，不修改原记录。"
        actions={
          <>
            <Button variant="secondary" icon={<RefreshCw size={16} />} onClick={reload} loading={loading}>
              刷新
            </Button>
            <Button icon={<Plus size={16} />} onClick={() => setRegisterOpen(true)}>
              登记申诉
            </Button>
          </>
        }
      />

      <Card title="申诉列表" subtitle="同一积分记录同时只能有一个未结申诉。">
        <div className="filters" style={{ marginBottom: 10 }}>
          <Segmented
            value={status}
            options={TABS}
            onChange={(next) => {
              setStatus(next);
              setPage(1);
            }}
            ariaLabel="申诉状态"
            size="sm"
          />
        </div>
        {error && (
          <Alert tone="danger" title="申诉列表加载失败" onRetry={reload}>
            {error}
          </Alert>
        )}
        {!error && loading && <Loading label="正在加载申诉列表…" />}
        {!error && !loading && items.length === 0 && (
          <EmptyState
            icon={<Gavel size={22} />}
            title={status === "SUBMITTED" ? "暂无待受理申诉" : "该状态下暂无申诉"}
            description={
              status === "SUBMITTED"
                ? "在「登记申诉」中选择一条已生效积分记录，填写理由后提交。"
                : "切换上方状态标签查看其他申诉；已接受的申诉会显示冲正/更正记录关联。"
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
                    <th>申诉理由</th>
                    <th>提交人</th>
                    <th>提交时间</th>
                    <th>状态</th>
                    <th>处理人</th>
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
                          <div className="muted text-xs mono">记录 {item.recordId.slice(0, 8)}…</div>
                        </td>
                        <td>{item.className}</td>
                        <td style={{ maxWidth: 260 }}>
                          <div className="truncate" title={item.reason}>
                            {item.reason}
                          </div>
                        </td>
                        <td>{item.submittedByName || "—"}</td>
                        <td className="no-wrap">{formatDateTime(item.createdAt)}</td>
                        <td>
                          <div className="row nowrap" style={{ gap: 4 }}>
                            <Badge tone={meta.tone}>{meta.label}</Badge>
                            {item.conflictFlag && (
                              <Badge tone="warning">
                                <AlertTriangle size={11} /> 利益冲突
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td>{item.handlerName || "—"}</td>
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

            <div className="table-card">
              {items.map((item) => {
                const meta = statusMeta(item.status, item.statusLabel);
                return (
                  <div className="record-card" key={`card-${item.id}`}>
                    <div className="record-card-head">
                      <div>
                        <div className="record-card-name">{item.studentName}</div>
                        <div className="record-card-meta">
                          {item.className} · {item.submittedByName || "—"} 提交
                        </div>
                      </div>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </div>
                    <p className="list-sub">{item.reason}</p>
                    <div className="row" style={{ marginTop: 6 }}>
                      <span className="muted text-xs">{formatDateTime(item.createdAt)}</span>
                      {item.conflictFlag && <Badge tone="warning">利益冲突</Badge>}
                    </div>
                    <div className="form-actions between">
                      <span className="muted text-xs">处理人：{item.handlerName || "—"}</span>
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
              total={list?.total ?? 0}
              unit="条申诉"
              onChange={setPage}
            />
          </>
        )}
      </Card>

      {registerOpen && (
        <RegisterAppealModal
          options={options}
          optionsError={optionsError}
          initialRecordId={params.recordId || ""}
          onRetryOptions={() => void loadOptions()}
          onClose={() => setRegisterOpen(false)}
          onCreated={(appeal) => {
            setRegisterOpen(false);
            toast("申诉已登记，等待德育处受理", "success");
            reload();
            if (appeal?.id) {
              setDetailId(appeal.id);
            } else if (params.recordId) {
              setStatus("SUBMITTED");
              setPage(1);
            }
          }}
        />
      )}

      {detailId && (
        <AppealDetailModal
          appealId={detailId}
          user={user}
          canDecide={canDecide}
          options={options}
          onClose={() => setDetailId(null)}
          onChanged={reload}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------- register appeal */

function RegisterAppealModal({
  options,
  optionsError,
  initialRecordId,
  onRetryOptions,
  onClose,
  onCreated,
}: {
  options: OptionsData | null;
  optionsError: string;
  initialRecordId?: string;
  onRetryOptions: () => void;
  onClose: () => void;
  onCreated: (appeal: AppealView | null) => void;
}) {
  const [classId, setClassId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [studentsLoading, setStudentsLoading] = useState(false);
  const [studentsError, setStudentsError] = useState("");

  const [records, setRecords] = useState<RecordView[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState("");
  const [recordId, setRecordId] = useState("");
  const [prefetched, setPrefetched] = useState<RecordView | null>(null);
  const [prefetchError, setPrefetchError] = useState("");
  const prefetchedRef = useRef<RecordView | null>(null);

  const [reason, setReason] = useState("");
  const [extra, setExtra] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const [evidenceItems, setEvidenceItems] = useState<EvidenceRef[]>([]);
  const [evidenceError, setEvidenceError] = useState("");
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const recordIdRef = useRef(recordId);

  const classes = options?.classes ?? [];

  useEffect(() => {
    recordIdRef.current = recordId;
  }, [recordId]);

  // 更换原记录时清空已上传证据，避免证据与学生不匹配（服务端同样会校验）。
  useEffect(() => {
    setEvidenceItems([]);
    setEvidenceError("");
  }, [recordId]);

  // 从积分记录页「去登记申诉」跳转时，按 params.recordId 预填原记录。
  useEffect(() => {
    if (!initialRecordId) return;
    const controller = new AbortController();
    setPrefetchError("");
    api<{ record: RecordView }>(`/records/${initialRecordId}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        const record = data.record;
        if (!record) return;
        prefetchedRef.current = record;
        setPrefetched(record);
        setClassId(record.classId);
        setStudentId("");
        setRecordId(record.id);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) setPrefetchError(errorText(requestError));
      });
    return () => controller.abort();
  }, [initialRecordId]);

  useEffect(() => {
    if (!classId) {
      setStudents([]);
      setStudentId("");
      return;
    }
    const controller = new AbortController();
    setStudentsLoading(true);
    setStudentsError("");
    api<{ items: StudentOption[] }>(`/options/students${query({ classId })}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setStudents(data.items || []);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) setStudentsError(errorText(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setStudentsLoading(false);
      });
    return () => controller.abort();
  }, [classId]);

  useEffect(() => {
    if (!classId && !studentId) {
      setRecords([]);
      if (!prefetchedRef.current) setRecordId("");
      return;
    }
    const controller = new AbortController();
    setRecordsLoading(true);
    setRecordsError("");
    api<Paginated<RecordView>>(
      `/records${query({
        classId: classId || undefined,
        studentId: studentId || undefined,
        status: "EFFECTIVE",
        page: 1,
        pageSize: 50,
      })}`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        // 已冲正的记录不能再发起申诉（服务端会拒绝），直接从前端候选中排除。
        const selectable = (data.items || []).filter((item) => !item.reversed);
        setRecords(selectable);
        setRecordId((current) => {
          if (!current) return "";
          if (selectable.some((item) => item.id === current)) return current;
          return prefetchedRef.current?.id === current ? current : "";
        });
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) setRecordsError(errorText(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setRecordsLoading(false);
      });
    return () => controller.abort();
  }, [classId, studentId]);

  const filteredStudents = useMemo(() => {
    const keyword = studentSearch.trim();
    if (!keyword) return students;
    return students.filter(
      (item) => item.name.includes(keyword) || (item.studentNo || "").includes(keyword),
    );
  }, [students, studentSearch]);

  const displayRecords = useMemo(() => {
    if (prefetched && !records.some((item) => item.id === prefetched.id)) {
      return [prefetched, ...records];
    }
    return records;
  }, [records, prefetched]);

  const selectedRecord = displayRecords.find((item) => item.id === recordId) || null;

  async function handleEvidenceFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!selectedRecord) {
      setEvidenceError("请先选择积分记录后再上传证据");
      return;
    }
    if (uploadingEvidence) return;
    const remaining = MAX_EVIDENCE_COUNT - evidenceItems.length;
    if (remaining <= 0) {
      setEvidenceError("单条申诉最多关联 5 个证据文件，请先移除已选文件");
      return;
    }
    setEvidenceError("");
    setUploadingEvidence(true);
    const targetRecordId = selectedRecord.id;
    const added: EvidenceRef[] = [];
    const chosen = Array.from(files).slice(0, remaining);
    try {
      for (const file of chosen) {
        if (file.size > MAX_EVIDENCE_BYTES) {
          setEvidenceError(`「${file.name}」超过 8MB 上限，请压缩后重试`);
          continue;
        }
        if (!isAllowedEvidenceType(file)) {
          setEvidenceError(`「${file.name}」格式不支持，仅支持 PNG/JPG/WebP/PDF`);
          continue;
        }
        try {
          const form = new FormData();
          form.append("file", file);
          form.append("studentId", selectedRecord.studentId);
          form.append("classId", selectedRecord.classId);
          const data = await api<{ evidence: EvidenceRef }>("/evidence", {
            method: "POST",
            body: form,
          });
          if (data.evidence) added.push(data.evidence);
        } catch (requestError) {
          setEvidenceError(`「${file.name}」上传失败：${errorText(requestError)}`);
        }
      }
      if (added.length > 0 && recordIdRef.current === targetRecordId) {
        setEvidenceItems((current) => [...current, ...added].slice(0, MAX_EVIDENCE_COUNT));
      }
    } finally {
      setUploadingEvidence(false);
    }
  }

  function removeEvidence(evidenceId: string) {
    setEvidenceItems((current) => current.filter((item) => item.id !== evidenceId));
  }

  async function submit() {
    if (saving) return;
    setFormError("");
    if (!recordId) {
      setFormError("请选择一条已生效的积分记录");
      return;
    }
    if (reason.trim().length < 2) {
      setFormError("请填写至少 2 个字的申诉理由");
      return;
    }
    if (uploadingEvidence) {
      setFormError("证据正在上传，请稍候再提交");
      return;
    }
    const fullReason = extra.trim()
      ? `${reason.trim()}\n补充说明：${extra.trim()}`
      : reason.trim();
    setSaving(true);
    try {
      const data = await api<{ appeal: AppealView }>("/appeals", {
        method: "POST",
        body: JSON.stringify({
          recordId,
          reason: fullReason,
          evidenceIds: evidenceItems.length > 0 ? evidenceItems.map((item) => item.id) : undefined,
        }),
      });
      onCreated(data.appeal ?? null);
    } catch (requestError) {
      setFormError(errorText(requestError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="登记申诉"
      description="教师可代为登记申诉；申诉不会自动改分，须由德育处填写理由后裁决。"
      size="lg"
      footer={
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            icon={<ClipboardList size={15} />}
            loading={saving}
            disabled={uploadingEvidence}
            onClick={() => void submit()}
          >
            提交申诉
          </Button>
        </div>
      }
    >
      <div className="stack gap-lg">
        {prefetchError && (
          <Alert tone="warning" title="无法自动带入要申诉的积分记录">
            {prefetchError}。请在下方的班级与学生筛选中手动选择记录。
          </Alert>
        )}
        {prefetched && (
          <div className="notice notice-info">
            已从积分记录页带入记录：{prefetched.studentName} · {prefetched.ruleName} ·{" "}
            {directionLabel(prefetched.direction)} {formatScore(prefetched.points)} 分，请确认后填写申诉理由。
          </div>
        )}

        {optionsError && (
          <Alert tone="danger" title="基础选项加载失败" onRetry={onRetryOptions}>
            {optionsError}
          </Alert>
        )}

        <div className="form-section">
          <div className="form-section-title">1. 选择原积分记录</div>
          <div className="form-grid cols-2">
            <Field label="班级" required>
              <Select
                value={classId}
                onChange={(event) => {
                  setClassId(event.target.value);
                  setStudentSearch("");
                  setRecordId("");
                }}
              >
                <option value="">请选择班级</option>
                {classes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.gradeName} · {item.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="学生" hint="选填；不选则显示该班全部有效记录。">
              <Select
                value={studentId}
                disabled={!classId || studentsLoading}
                onChange={(event) => {
                  setStudentId(event.target.value);
                  setRecordId("");
                }}
              >
                <option value="">{studentsLoading ? "正在加载学生…" : "全部学生"}</option>
                {filteredStudents.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.studentNo ? `（${item.studentNo}）` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            {classId && (
              <Field label="按姓名/学号过滤" className="span-2">
                <Input
                  placeholder="输入姓名或学号缩小学生范围"
                  value={studentSearch}
                  onChange={(event) => setStudentSearch(event.target.value)}
                />
              </Field>
            )}
          </div>

          {studentsError && <div className="alert alert-danger">{studentsError}</div>}

          {!classId && (
            <div className="notice notice-info">请先选择班级，再选择要申诉的有效积分记录。</div>
          )}

          {classId && recordsLoading && <Loading label="正在加载有效积分记录…" />}
          {classId && recordsError && (
            <Alert tone="danger" title="积分记录加载失败">
              {recordsError}
            </Alert>
          )}
          {classId && !recordsLoading && !recordsError && displayRecords.length === 0 && (
            <EmptyState
              compact
              title="没有可申诉的有效记录"
              description="只能对已生效（EFFECTIVE）且未被撤销的积分记录发起申诉。"
            />
          )}
          {classId && !recordsLoading && !recordsError && displayRecords.length > 0 && (
            <div className="list" style={{ maxHeight: 260, overflowY: "auto", paddingRight: 2 }}>
              {displayRecords.map((record) => {
                const selected = record.id === recordId;
                return (
                  <label
                    key={record.id}
                    className={cn("list-item", selected && "is-selected")}
                    style={{
                      cursor: "pointer",
                      borderColor: selected ? "var(--brand)" : undefined,
                      background: selected ? "var(--brand-soft)" : undefined,
                    }}
                  >
                    <input
                      type="radio"
                      name="appeal-record"
                      checked={selected}
                      onChange={() => setRecordId(record.id)}
                      style={{ marginTop: 3, accentColor: "var(--brand)" }}
                    />
                    <div className="list-main">
                      <div className="list-title">
                        {record.ruleName}
                        <Badge tone={directionTone(record.direction)}>
                          {directionLabel(record.direction)} {formatScore(record.points)} 分
                        </Badge>
                        {record.reversed && <Badge tone="neutral">已冲正</Badge>}
                      </div>
                      <div className="list-sub">
                        {record.studentName} · {record.className} · {record.categoryName || "未分类"} ·{" "}
                        {formatDateTime(record.occurrenceAt)}
                        {record.note ? ` · ${record.note}` : ""}
                      </div>
                    </div>
                    <span className="list-side muted text-xs">{record.submitterName}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div className="form-section">
          <div className="form-section-title">2. 填写申诉信息</div>
          {selectedRecord && (
            <div className="notice notice-info">
              已选记录：{selectedRecord.studentName} · {selectedRecord.ruleName} ·{" "}
              {directionLabel(selectedRecord.direction)} {formatScore(selectedRecord.points)} 分 ·{" "}
              {formatDateTime(selectedRecord.occurrenceAt)}
            </div>
          )}
          <Field label="申诉理由" required hint="至少 2 个字；会记录在申诉档案中并展示给裁决人。">
            <Textarea
              rows={3}
              maxLength={500}
              placeholder="例如：该记录发生时间有误，学生当天请假未到校。"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <Field label="补充说明" hint="可选，例如证据来源、联系方式等。">
            <Textarea
              rows={2}
              maxLength={500}
              placeholder="选填"
              value={extra}
              onChange={(event) => setExtra(event.target.value)}
            />
          </Field>
          <Field
            label={
              <span className="row" style={{ gap: 6 }}>
                <Paperclip size={14} /> 证据材料（可选）
              </span>
            }
            hint="支持 PNG/JPG/WebP/PDF，单个不超过 8MB，最多 5 个；仅登记人与授权范围内人员可见。"
          >
            <div className="stack gap-sm">
              {selectedRecord ? (
                <input
                  type="file"
                  className="input"
                  multiple
                  accept={EVIDENCE_ACCEPT}
                  aria-label="上传申诉证据"
                  disabled={uploadingEvidence || evidenceItems.length >= MAX_EVIDENCE_COUNT}
                  onChange={(event) => {
                    void handleEvidenceFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
              ) : (
                <div className="muted text-xs">请先在上方选择积分记录，再上传与该记录学生相关的证据。</div>
              )}
              <div className="muted text-xs">
                已上传 {evidenceItems.length}/{MAX_EVIDENCE_COUNT} 个
                {uploadingEvidence ? " · 正在上传…" : ""}
              </div>
              {evidenceItems.length > 0 && (
                <div className="list">
                  {evidenceItems.map((item) => (
                    <div className="list-item" key={item.id}>
                      <FileText size={16} className="muted" style={{ marginTop: 2, flex: "none" }} />
                      <div className="list-main">
                        <div className="list-title truncate" title={item.name}>
                          {item.name}
                        </div>
                        <div className="list-sub">
                          {evidenceMimeLabel(item.mime)} · {formatBytes(item.sizeBytes)}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Trash2 size={13} />}
                        aria-label={`移除证据 ${item.name}`}
                        onClick={() => removeEvidence(item.id)}
                      >
                        移除
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {evidenceError && <div className="alert alert-danger">{evidenceError}</div>}
            </div>
          </Field>
          {formError && <div className="alert alert-danger">{formError}</div>}
          <div className="notice notice-warning">
            提交后申诉进入「待受理」，不会立即改变积分；处理结果以德育处裁决为准。
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------- appeal detail */

function AppealDetailModal({
  appealId,
  user,
  canDecide,
  options,
  onClose,
  onChanged,
  onNavigate,
}: {
  appealId: string;
  user: PageProps["user"];
  canDecide: boolean;
  options: OptionsData | null;
  onClose: () => void;
  onChanged: () => void;
  onNavigate: PageProps["onNavigate"];
}) {
  const toast = useToast();
  const [detail, setDetail] = useState<AppealDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [decideOpen, setDecideOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [decisionResult, setDecisionResult] = useState<{
    accepted: boolean;
    reversal?: RecordView;
    correction?: RecordView;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api<AppealDetail>(`/appeals/${appealId}`);
      setDetail(data);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setLoading(false);
    }
  }, [appealId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function startReview() {
    setStarting(true);
    try {
      await api(`/appeals/${appealId}/start-review`, { method: "POST", body: "{}" });
      toast("申诉已受理，进入处理中", "success");
      onChanged();
      await load();
    } catch (requestError) {
      toast(errorText(requestError), "error");
    } finally {
      setStarting(false);
    }
  }

  const appeal = detail?.appeal ?? null;
  const record = detail?.record ?? null;
  const decisions = detail?.decisions ?? [];
  const evidence = detail?.appeal?.evidence ?? [];
  const meta = appeal ? statusMeta(appeal.status, appeal.statusLabel) : null;
  const open = Boolean(appeal && (appeal.status === "SUBMITTED" || appeal.status === "UNDER_REVIEW"));
  const conflict = Boolean(record && user.id === record.submitterId);

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="申诉详情"
        description={appeal ? `${appeal.studentName} · ${appeal.className}` : "正在读取申诉详情…"}
        size="lg"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={onClose}>
              关闭
            </Button>
            {open && canDecide && appeal?.status === "SUBMITTED" && (
              <Button
                variant="secondary"
                icon={<PlayCircle size={15} />}
                loading={starting}
                onClick={() => void startReview()}
              >
                受理申诉
              </Button>
            )}
            {open && canDecide && (
              <Button icon={<Scale size={15} />} onClick={() => setDecideOpen(true)}>
                裁决
              </Button>
            )}
          </div>
        }
      >
        {loading && <Loading label="正在读取申诉详情…" />}
        {!loading && error && (
          <Alert tone="danger" title="申诉详情加载失败" onRetry={() => void load()}>
            {error}
          </Alert>
        )}

        {!loading && !error && appeal && record && (
          <div className="stack gap-lg">
            {decisionResult && (
              <Alert
                tone={decisionResult.accepted ? "success" : "info"}
                title={decisionResult.accepted ? "申诉已接受，账本已处理" : "申诉已驳回"}
              >
                <div className="stack gap-sm">
                  {decisionResult.reversal && (
                    <div>
                      冲正记录：{decisionResult.reversal.ruleName} ·{" "}
                      <strong className={decisionResult.reversal.direction === "ADD" ? "score-add" : "score-deduct"}>
                        {formatSignedScore(decisionResult.reversal.signedPoints)} 分
                      </strong>{" "}
                      · {formatDateTime(decisionResult.reversal.occurrenceAt)} ·{" "}
                      <span className="mono text-xs">{decisionResult.reversal.id.slice(0, 8)}…</span>
                    </div>
                  )}
                  {decisionResult.correction && (
                    <div>
                      更正记录：{decisionResult.correction.ruleName} ·{" "}
                      <strong className={decisionResult.correction.direction === "ADD" ? "score-add" : "score-deduct"}>
                        {formatSignedScore(decisionResult.correction.signedPoints)} 分
                      </strong>{" "}
                      · {formatDateTime(decisionResult.correction.occurrenceAt)} ·{" "}
                      <span className="mono text-xs">{decisionResult.correction.id.slice(0, 8)}…</span>
                    </div>
                  )}
                  <div className="row">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<ArrowRightLeft size={14} />}
                      onClick={() =>
                        onNavigate("records", {
                          studentId: appeal.studentId,
                          classId: appeal.classId,
                        })
                      }
                    >
                      查看积分记录
                    </Button>
                  </div>
                </div>
              </Alert>
            )}

            <div className="row" style={{ gap: 8 }}>
              {meta && <Badge tone={meta.tone}>{meta.label}</Badge>}
              {appeal.conflictFlag && (
                <Badge tone="warning">
                  <AlertTriangle size={11} /> 存在利益冲突记录
                </Badge>
              )}
              <Badge tone="neutral">{formatDateTime(appeal.createdAt)} 提交</Badge>
            </div>

            <dl className="kv">
              <dt>学生</dt>
              <dd>
                {appeal.studentName}
                {appeal.studentNo ? `（${appeal.studentNo}）` : ""}
              </dd>
              <dt>班级</dt>
              <dd>{appeal.className}</dd>
              <dt>申诉人</dt>
              <dd>{appeal.submittedByName || "—"}</dd>
              <dt>处理人</dt>
              <dd>{appeal.handlerName || "—"}</dd>
              <dt>裁决时间</dt>
              <dd>{formatDateTime(appeal.decidedAt)}</dd>
              <dt>裁决理由</dt>
              <dd>{appeal.decisionReason || "—"}</dd>
            </dl>

            <div>
              <div className="field-label">申诉理由</div>
              <div className="record-card mt-2" style={{ whiteSpace: "pre-wrap" }}>
                {appeal.reason}
              </div>
            </div>

            <div>
              <div className="section-title" style={{ margin: "0 0 10px" }}>
                <h2 style={{ fontSize: 15 }}>证据材料</h2>
              </div>
              {evidence.length === 0 ? (
                <p className="muted text-xs">未上传证据</p>
              ) : (
                <div className="stack gap-sm">
                  {evidence.map((item) => (
                    <div className="list-item" key={item.id}>
                      <FileText size={16} className="muted" style={{ marginTop: 2, flex: "none" }} />
                      <div className="list-main">
                        <div className="list-title truncate" title={item.name}>
                          {item.name}
                        </div>
                        <div className="list-sub">
                          {evidenceMimeLabel(item.mime)} · {formatBytes(item.sizeBytes)}
                        </div>
                      </div>
                      <a
                        className="btn btn-sm btn-secondary"
                        href={`/api/evidence/${item.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        查看
                      </a>
                    </div>
                  ))}
                </div>
              )}
              <div className="muted text-xs mt-2">证据文件仅对登记人与授权范围内人员可见，按权限校验后下载。</div>
            </div>

            <div>
              <div className="section-title" style={{ margin: "0 0 10px" }}>
                <h2 style={{ fontSize: 15 }}>原积分记录快照</h2>
              </div>
              <div className="record-card">
                <div className="record-card-head">
                  <div>
                    <div className="record-card-name">{record.ruleName}</div>
                    <div className="record-card-meta">
                      {record.categoryName || "未分类"} · {record.studentName} · {formatDateTime(record.occurrenceAt)}
                    </div>
                  </div>
                  <div className="row nowrap" style={{ gap: 6 }}>
                    <Badge tone={directionTone(record.direction)}>
                      {directionLabel(record.direction)} {formatScore(record.points)} 分
                    </Badge>
                    {record.reversed ? (
                      <Badge tone="neutral">已冲正</Badge>
                    ) : (
                      <Badge tone="success">{record.statusLabel || "已生效"}</Badge>
                    )}
                  </div>
                </div>
                <dl className="kv mt-2">
                  <dt>记录说明</dt>
                  <dd>{record.note || "—"}</dd>
                  <dt>提交人</dt>
                  <dd>{record.submitterName || "—"}</dd>
                  <dt>来源</dt>
                  <dd>{record.sourceLabel || record.source}</dd>
                  <dt>记录编号</dt>
                  <dd className="mono text-xs">{record.id}</dd>
                </dl>
                <div className="muted text-xs mt-2">
                  账本不可修改：接受申诉时系统通过冲正/更正生成新记录，原记录保留可追溯。
                </div>
              </div>
            </div>

            <div>
              <div className="section-title" style={{ margin: "0 0 10px" }}>
                <h2 style={{ fontSize: 15 }}>处理时间线</h2>
              </div>
              {decisions.length === 0 ? (
                <EmptyState compact title="尚未产生处理记录" description="等待德育处受理并裁决。" />
              ) : (
                <div className="timeline">
                  <div className="timeline-item">
                    <span className="timeline-dot" />
                    <div className="timeline-title">申诉提交</div>
                    <div className="timeline-meta">
                      {appeal.submittedByName || "—"} · {formatDateTime(appeal.createdAt)}
                    </div>
                    <div className="timeline-body" style={{ whiteSpace: "pre-wrap" }}>
                      {appeal.reason}
                    </div>
                  </div>
                  {decisions.map((decision) => {
                    const decisionMeta = DECISION_META[decision.decision] || {
                      label: decision.decisionLabel || decision.decision,
                      tone: "neutral" as BadgeTone,
                    };
                    return (
                      <div className="timeline-item" key={decision.id}>
                        <span className="timeline-dot" />
                        <div className="timeline-title">
                          {decisionMeta.label}{" "}
                          <Badge tone={decisionMeta.tone}>{decisionMeta.label}</Badge>
                        </div>
                        <div className="timeline-meta">
                          {decision.actorName || "—"} · {formatDateTime(decision.createdAt)}
                        </div>
                        <div className="timeline-body">
                          {decision.reason ? <div style={{ whiteSpace: "pre-wrap" }}>{decision.reason}</div> : null}
                          {decision.conflictFlag && (
                            <div className="notice notice-warning mt-2">
                              利益冲突已记录：{decision.conflictReason || "未填写说明"}
                            </div>
                          )}
                          {(decision.reversalRecordId || decision.correctionRecordId) && (
                            <div className="row mt-2" style={{ gap: 6 }}>
                              {decision.reversalRecordId && <Badge tone="neutral">已生成冲正记录</Badge>}
                              {decision.correctionRecordId && <Badge tone="neutral">已生成更正记录</Badge>}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {open && !canDecide && (
              <div className="notice notice-info">当前账号没有裁决权限，申诉需由德育处受理与裁决。</div>
            )}
            {conflict && (
              <Alert tone="warning" title="利益冲突提示">
                你是该积分记录的原提交人，裁决时需要填写利益冲突说明并记录在案。
              </Alert>
            )}
          </div>
        )}
      </Modal>

      {decideOpen && appeal && record && (
        <DecideDialog
          appeal={appeal}
          record={record}
          user={user}
          options={options}
          conflict={conflict}
          onClose={() => setDecideOpen(false)}
          onSuccess={(result) => {
            setDecideOpen(false);
            setDecisionResult(result);
            toast(result.accepted ? "申诉已接受，已生成冲正/更正记录" : "申诉已驳回", "success");
            onChanged();
            void load();
          }}
        />
      )}
    </>
  );
}

/* --------------------------------------------------------------- decision */

function DecideDialog({
  appeal,
  record,
  user,
  options,
  conflict,
  onClose,
  onSuccess,
}: {
  appeal: AppealView;
  record: RecordView;
  user: PageProps["user"];
  options: OptionsData | null;
  conflict: boolean;
  onClose: () => void;
  onSuccess: (result: { accepted: boolean; reversal?: RecordView; correction?: RecordView }) => void;
}) {
  const [decision, setDecision] = useState<"ACCEPTED" | "REJECTED">("ACCEPTED");
  const [reason, setReason] = useState("");
  const [conflictReason, setConflictReason] = useState("");
  const [mode, setMode] = useState<"REVOKE" | "REPLACE">("REVOKE");
  const [replaceMethod, setReplaceMethod] = useState<"rule" | "points">("rule");
  const [ruleId, setRuleId] = useState("");
  const [points, setPoints] = useState(String(record.points));
  const [correctionNote, setCorrectionNote] = useState("");
  const [formError, setFormError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const rules = publishedRulesOf(options?.publishedRules ?? []);
  const selectedRule = rules.find((rule) => rule.id === ruleId) || null;

  function startConfirm() {
    setFormError("");
    if (reason.trim().length < 2) {
      setFormError("请填写至少 2 个字的裁决理由");
      return;
    }
    if (conflict && conflictReason.trim().length < 2) {
      setFormError("你与原记录提交人相同，请填写利益冲突说明（至少 2 个字）");
      return;
    }
    if (decision === "ACCEPTED" && mode === "REPLACE") {
      if (replaceMethod === "rule" && !ruleId) {
        setFormError("请选择用于更正的已发布规则");
        return;
      }
      const value = Number(points);
      if (replaceMethod === "points" && (!Number.isInteger(value) || value < 1 || value > 100)) {
        setFormError("更正分值需为 1～100 的整数");
        return;
      }
    }
    setConfirming(true);
  }

  async function submit() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        decision,
        reason: reason.trim(),
        conflictReason: conflict ? conflictReason.trim() : undefined,
      };
      if (decision === "ACCEPTED") {
        body.correction =
          mode === "REVOKE"
            ? { mode: "REVOKE" }
            : {
                mode: "REPLACE",
                ruleId: replaceMethod === "rule" ? ruleId : undefined,
                points: replaceMethod === "points" ? Number(points) : undefined,
                note: correctionNote.trim() || undefined,
              };
      }
      const data = await api<{
        appeal: AppealView;
        reversal?: RecordView;
        correction?: RecordView;
      }>(`/appeals/${appeal.id}/decide`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setConfirming(false);
      onSuccess({
        accepted: decision === "ACCEPTED",
        reversal: data.reversal,
        correction: data.correction,
      });
    } catch (requestError) {
      setConfirming(false);
      setFormError(errorText(requestError));
    } finally {
      setSaving(false);
    }
  }

  const directionText = directionLabel(record.direction);

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="裁决申诉"
        description={`${appeal.studentName} · ${appeal.className} · 原记录：${record.ruleName}（${directionText} ${formatScore(record.points)} 分）`}
        size="lg"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button
              variant={decision === "ACCEPTED" ? "primary" : "danger"}
              icon={decision === "ACCEPTED" ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              onClick={startConfirm}
            >
              下一步：确认裁决
            </Button>
          </div>
        }
      >
        <div className="stack gap-lg">
          {conflict && (
            <Alert tone="warning" title="利益冲突提示">
              你正是该积分记录的原提交人（{record.submitterName}），按规定应尽量由其他德育处人员裁决；
              如确需处理，请填写利益冲突说明，系统会记录在案。
            </Alert>
          )}

          <Field label="裁决结果" required>
            <div className="stack gap-sm">
              <label className="checkbox">
                <input
                  type="radio"
                  name="appeal-decision"
                  checked={decision === "ACCEPTED"}
                  onChange={() => setDecision("ACCEPTED")}
                />
                <span>
                  接受申诉（<strong>ACCEPTED</strong>）：通过冲正/更正调整积分
                </span>
              </label>
              <label className="checkbox">
                <input
                  type="radio"
                  name="appeal-decision"
                  checked={decision === "REJECTED"}
                  onChange={() => setDecision("REJECTED")}
                />
                <span>
                  驳回申诉（<strong>REJECTED</strong>）：维持原积分记录
                </span>
              </label>
            </div>
          </Field>

          <Field label="裁决理由" required hint="至少 2 个字；会写入不可修改的裁决记录。">
            <Textarea
              rows={3}
              maxLength={500}
              placeholder="例如：经核对监控与班主任说明，原记录发生时间有误，申诉成立。"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>

          {conflict && (
            <Field
              label="利益冲突说明"
              required
              hint="说明为何需要由你（原提交人）裁决，以及是否有其他人员复核。"
            >
              <Textarea
                rows={2}
                maxLength={300}
                placeholder="例如：德育处其他人员外出，经电话请示后由本人处理，事后由张老师复核。"
                value={conflictReason}
                onChange={(event) => setConflictReason(event.target.value)}
              />
            </Field>
          )}

          {decision === "ACCEPTED" && (
            <div className="form-section">
              <div className="form-section-title">账本处理方式</div>
              <Field label="处理方式" required>
                <div className="stack gap-sm">
                  <label className="checkbox">
                    <input
                      type="radio"
                      name="correction-mode"
                      checked={mode === "REVOKE"}
                      onChange={() => setMode("REVOKE")}
                    />
                    <span>撤销原记录（REVOKE）：仅生成冲正记录</span>
                  </label>
                  <label className="checkbox">
                    <input
                      type="radio"
                      name="correction-mode"
                      checked={mode === "REPLACE"}
                      onChange={() => setMode("REPLACE")}
                    />
                    <span>更正为新规则/分值（REPLACE）：冲正后生成更正记录</span>
                  </label>
                </div>
              </Field>

              {mode === "REPLACE" && (
                <>
                  <div className="row" style={{ gap: 14 }}>
                    <label className="checkbox">
                      <input
                        type="radio"
                        name="replace-method"
                        checked={replaceMethod === "rule"}
                        onChange={() => setReplaceMethod("rule")}
                      />
                      <span>选择已发布规则</span>
                    </label>
                    <label className="checkbox">
                      <input
                        type="radio"
                        name="replace-method"
                        checked={replaceMethod === "points"}
                        onChange={() => setReplaceMethod("points")}
                      />
                      <span>直接指定分值</span>
                    </label>
                  </div>

                  {replaceMethod === "rule" ? (
                    <Field label="更正规则" required hint="仅可选择已发布规则；方向由规则决定。">
                      <Select value={ruleId} onChange={(event) => setRuleId(event.target.value)}>
                        <option value="">请选择规则</option>
                        {rules.map((rule) => (
                          <option key={rule.id} value={rule.id}>
                            {rule.name}（{rule.direction === "ADD" ? "+" : "-"}
                            {formatScore(rule.points)} 分 · {rule.categoryName}）
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : (
                    <Field
                      label="更正分值"
                      required
                      hint={`方向沿用原记录（${directionText}），填写 1～100 的整数分值。`}
                    >
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        inputMode="numeric"
                        value={points}
                        onChange={(event) => setPoints(event.target.value)}
                      />
                    </Field>
                  )}

                  {selectedRule && (
                    <div className="notice notice-info">
                      将更正为：{selectedRule.name} ·{" "}
                      {directionLabel(selectedRule.direction)} {formatScore(selectedRule.points)} 分
                    </div>
                  )}

                  <Field label="更正说明" hint="可选，会写入更正记录说明。">
                    <Textarea
                      rows={2}
                      maxLength={300}
                      placeholder="例如：分值适用错误，按低一档规则更正。"
                      value={correctionNote}
                      onChange={(event) => setCorrectionNote(event.target.value)}
                    />
                  </Field>
                </>
              )}
            </div>
          )}

          <div className="notice notice-warning">
            裁决提交后不可撤销：接受申诉会立即生成冲正（及更正）记录，裁决记录不可修改或删除。
          </div>

          {formError && <div className="alert alert-danger">{formError}</div>}
        </div>
      </Modal>

      {confirming && (
        <ConfirmDialog
          open
          title={decision === "ACCEPTED" ? "确认接受该申诉？" : "确认驳回该申诉？"}
          description={
            decision === "ACCEPTED"
              ? "将生成冲正/更正记录并立即影响学生积分；原记录保留可追溯。"
              : "将维持原积分记录不变，裁决理由会记录在案。"
          }
          confirmLabel="确认提交裁决"
          danger={decision === "REJECTED"}
          loading={saving}
          onConfirm={() => void submit()}
          onClose={() => setConfirming(false)}
        >
          <dl className="kv">
            <dt>裁决结果</dt>
            <dd>{decision === "ACCEPTED" ? "接受申诉（ACCEPTED）" : "驳回申诉（REJECTED）"}</dd>
            <dt>学生</dt>
            <dd>
              {appeal.studentName}（{appeal.className}）
            </dd>
            <dt>原记录</dt>
            <dd>
              {record.ruleName} · {formatSignedScore(record.signedPoints)} 分
            </dd>
            {decision === "ACCEPTED" && (
              <dt>处理方式</dt>
            )}
            {decision === "ACCEPTED" && (
              <dd>
                {mode === "REVOKE"
                  ? "撤销原记录（REVOKE）"
                  : `更正（REPLACE）为 ${
                      replaceMethod === "rule"
                        ? selectedRule
                          ? `${selectedRule.name}（${directionLabel(selectedRule.direction)} ${formatScore(
                              selectedRule.points,
                            )} 分）`
                          : "已发布规则"
                        : `${directionText} ${formatScore(Number(points))} 分`
                    }`}
              </dd>
            )}
            {conflict && (
              <>
                <dt>利益冲突说明</dt>
                <dd>{conflictReason.trim()}</dd>
              </>
            )}
          </dl>
          <p className="mt-2" style={{ whiteSpace: "pre-wrap" }}>
            <span className="muted">裁决理由：</span>
            {reason.trim()}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
