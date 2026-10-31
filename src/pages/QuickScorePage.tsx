// OWNER: frontend-core. 快捷记分：移动端优先的三步记分（选学生 → 选规则 → 填说明/证据），
// 支持批量、证据上传与提交前二次确认。接口契约见 docs/ARCHITECTURE.md 5.2。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  Paperclip,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
  Zap,
} from "lucide-react";
import { api, ApiError, json, query } from "../api";
import {
  dateTimeLocalInput,
  formatBytes,
  formatDateTime,
  formatScore,
  formatSignedScore,
  toIso,
} from "../format";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Loading,
  Modal,
  Notice,
  PageHeader,
  Select,
  Segmented,
  Textarea,
  useToast,
} from "../components/ui";
import type { EvidenceRef, PageProps, RecordView, SchoolSettings } from "../types";

const MAX_STUDENTS = 50;
const MAX_NOTE_LENGTH = 500;
type Direction = "ADD" | "DEDUCT";
type DirectionFilter = "ALL" | Direction;

interface QuickClass {
  id: string;
  name: string;
  gradeId: string;
  gradeName: string;
  studentCount?: number;
}

interface QuickCategory {
  id: string;
  name: string;
  directionScope: "BOTH" | "ADD" | "DEDUCT";
  isEnabled?: boolean;
}

interface QuickRule {
  id: string;
  versionId: string;
  version?: number;
  name: string;
  categoryId: string;
  categoryName?: string;
  direction: Direction;
  points: number;
  minPoints?: number | null;
  maxPoints?: number | null;
  targetScope?: "ALL" | "GRADE" | "CLASS";
  scopeIds?: string[];
  evidenceRequired?: boolean;
  requiresReview?: boolean;
  description?: string;
  examples?: string;
  status?: string;
}

interface OptionsResponse {
  grades?: Array<{ id: string; name: string }>;
  classes?: QuickClass[];
  categories?: QuickCategory[];
  publishedRules?: QuickRule[];
  terms?: Array<{ id: string; name: string; isCurrent?: boolean }>;
}

interface StudentOption {
  id: string;
  name: string;
  studentNo: string;
  classId: string;
  className: string;
  gradeName: string;
  gradeId?: string;
}

interface StudentsResponse {
  items?: StudentOption[];
}

interface ScoringResponse {
  record?: RecordView;
  records?: RecordView[];
  summary?: { created?: number; pendingReview?: number };
}

interface SubmitResult {
  records: RecordView[];
  created: number;
  pendingReview: number;
}

interface FieldErrors {
  occurrenceAt?: string;
  note?: string;
  evidence?: string;
}

/** 简单防抖，用于学生搜索。 */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function quickScoreErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录状态已失效，请重新登录";
    if (error.status === 403) return error.message || "没有权限执行该操作";
    if (error.status === 400) {
      const issues = (error.issues || []).map((issue) => issue.message).filter(Boolean);
      return issues.length > 0 ? issues.join("；") : error.message || fallback;
    }
    if (error.status === 413) return error.message || "证据文件超过大小上限";
    if (error.status >= 500) return error.message || "服务暂时不可用，请稍后重试";
    return error.message || fallback;
  }
  if (error instanceof DOMException && error.name === "AbortError") return "";
  return error instanceof Error && error.message ? error.message : fallback;
}

function signedPointsFor(rule: QuickRule): number {
  return rule.direction === "ADD" ? Math.abs(rule.points) : -Math.abs(rule.points);
}

export function QuickScorePage({ user, onNavigate, params }: PageProps) {
  const toast = useToast();
  const canScore = user.permissions.score;

  /* ---------------------------------------------------------------- 基础数据 */
  const [options, setOptions] = useState<OptionsResponse | null>(null);
  const [settings, setSettings] = useState<SchoolSettings | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(canScore);
  const [optionsError, setOptionsError] = useState("");
  const [optionsReload, setOptionsReload] = useState(0);

  useEffect(() => {
    if (!canScore) return;
    const controller = new AbortController();
    setOptionsLoading(true);
    setOptionsError("");
    (async () => {
      try {
        const [optionsResponse, schoolResponse] = await Promise.all([
          api<OptionsResponse>("/options", { signal: controller.signal }),
          api<{ settings?: SchoolSettings }>("/school", { signal: controller.signal }).catch(() => null),
        ]);
        if (controller.signal.aborted) return;
        setOptions(optionsResponse);
        setSettings(schoolResponse?.settings ?? null);
      } catch (requestError) {
        if (controller.signal.aborted) return;
        setOptionsError(quickScoreErrorText(requestError, "加载记分基础数据失败，请稍后重试"));
      } finally {
        if (!controller.signal.aborted) setOptionsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [canScore, optionsReload]);

  const classes = options?.classes ?? [];
  const categories = options?.categories ?? [];
  const publishedRules = useMemo(() => options?.publishedRules ?? [], [options]);
  const classMap = useMemo(() => {
    const map = new Map<string, QuickClass>();
    for (const item of classes) map.set(item.id, item);
    return map;
  }, [classes]);
  const categoryNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of categories) map.set(item.id, item.name);
    return map;
  }, [categories]);

  /* ---------------------------------------------------------------- 流程状态 */
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [result, setResult] = useState<SubmitResult | null>(null);

  /* 第 1 步：选择学生 */
  const [classFilter, setClassFilter] = useState(() => params.classId || "");
  const [studentQuery, setStudentQuery] = useState("");
  const debouncedQuery = useDebouncedValue(studentQuery, 320);
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [studentsLoading, setStudentsLoading] = useState(false);
  const [studentsError, setStudentsError] = useState("");
  const [visibleStudents, setVisibleStudents] = useState(40);
  const [selected, setSelected] = useState<Record<string, StudentOption>>({});

  // 切换班级/搜索词时回到首屏条数，避免一次渲染几百条学生。
  useEffect(() => {
    setVisibleStudents(40);
  }, [classFilter, debouncedQuery]);

  useEffect(() => {
    if (!canScore) return;
    const controller = new AbortController();
    setStudentsLoading(true);
    setStudentsError("");
    (async () => {
      try {
        const response = await api<StudentsResponse>(
          `/options/students${query({ classId: classFilter, search: debouncedQuery.trim() })}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setStudents(response.items ?? []);
      } catch (requestError) {
        if (controller.signal.aborted) return;
        setStudentsError(quickScoreErrorText(requestError, "加载学生列表失败"));
      } finally {
        if (!controller.signal.aborted) setStudentsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [canScore, classFilter, debouncedQuery]);

  const selectedList = useMemo(
    () =>
      Object.values(selected).map((student) => ({
        ...student,
        gradeId: student.gradeId || classMap.get(student.classId)?.gradeId || "",
      })),
    [selected, classMap],
  );
  const selectedCount = selectedList.length;
  const batchMode = selectedCount > 1;
  const selectedClassIds = useMemo(
    () => [...new Set(selectedList.map((student) => student.classId))],
    [selectedList],
  );
  const mixedClasses = selectedClassIds.length > 1;

  function toggleStudent(student: StudentOption) {
    const isSelected = Boolean(selected[student.id]);
    if (!isSelected && selectedCount >= MAX_STUDENTS) {
      toast(`单次最多选择 ${MAX_STUDENTS} 名学生`, "warning");
      return;
    }
    setSelected((current) => {
      const next = { ...current };
      if (next[student.id]) {
        delete next[student.id];
      } else {
        next[student.id] = {
          ...student,
          gradeId: student.gradeId || classMap.get(student.classId)?.gradeId || "",
        };
      }
      return next;
    });
  }

  function selectAllVisible() {
    const next = { ...selected };
    let truncated = false;
    for (const student of students) {
      if (Object.keys(next).length >= MAX_STUDENTS) {
        truncated = true;
        break;
      }
      if (!next[student.id]) {
        next[student.id] = {
          ...student,
          gradeId: student.gradeId || classMap.get(student.classId)?.gradeId || "",
        };
      }
    }
    setSelected(next);
    if (truncated) toast(`最多选择 ${MAX_STUDENTS} 名学生，已按当前结果自动截断`, "warning");
  }

  /* 第 2 步：选择规则 */
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("ALL");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [ruleId, setRuleId] = useState("");

  function ruleAppliesToStudent(rule: QuickRule, student: StudentOption): boolean {
    if (!rule.targetScope || rule.targetScope === "ALL") return true;
    const scopeIds = Array.isArray(rule.scopeIds) ? rule.scopeIds : [];
    if (scopeIds.length === 0) return true;
    const gradeId = student.gradeId || classMap.get(student.classId)?.gradeId || "";
    if (rule.targetScope === "GRADE") return scopeIds.includes(gradeId);
    if (rule.targetScope === "CLASS") return scopeIds.includes(student.classId);
    return true;
  }

  const applicableRules = useMemo(() => {
    return publishedRules
      .filter((rule) => directionFilter === "ALL" || rule.direction === directionFilter)
      .filter((rule) => !categoryFilter || rule.categoryId === categoryFilter)
      .filter((rule) => selectedList.every((student) => ruleAppliesToStudent(rule, student)));
  }, [publishedRules, directionFilter, categoryFilter, selectedList, classMap]);

  const rule = useMemo(
    () => publishedRules.find((item) => item.id === ruleId) ?? null,
    [publishedRules, ruleId],
  );

  useEffect(() => {
    if (!ruleId) return;
    const stillApplicable = applicableRules.some((item) => item.id === ruleId);
    if (!stillApplicable) {
      setRuleId("");
      toast("所选学生已变化，原规则不再适用，请重新选择规则", "warning");
    }
  }, [applicableRules, ruleId, toast]);

  const directionCounts = useMemo(() => {
    let add = 0;
    let deduct = 0;
    for (const item of publishedRules) {
      if (item.direction === "ADD") add += 1;
      else deduct += 1;
    }
    return { add, deduct, all: publishedRules.length };
  }, [publishedRules]);

  /* 第 3 步：时间 / 说明 / 证据 */
  const [occurrenceAt, setOccurrenceAt] = useState(() => dateTimeLocalInput());
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState<EvidenceRef | null>(null);
  const [evidenceBoundTo, setEvidenceBoundTo] = useState("");
  const [evidenceError, setEvidenceError] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  // 批量同班 → 班级级证据；单条 → 学生级证据；跨班批次无法挂班级级证据。
  const evidenceTarget = useMemo(() => {
    if (selectedCount === 0) return "";
    if (selectedCount === 1) return `student:${selectedList[0].id}`;
    if (mixedClasses) return "";
    return `class:${selectedClassIds[0]}`;
  }, [selectedCount, mixedClasses, selectedList, selectedClassIds]);

  useEffect(() => {
    if (!evidence) return;
    if (evidenceBoundTo !== evidenceTarget) {
      setEvidence(null);
      setEvidenceBoundTo("");
      setEvidenceError("");
    }
  }, [evidence, evidenceBoundTo, evidenceTarget]);

  async function uploadEvidence(file: File) {
    if (uploading || !evidenceTarget) return;
    setUploading(true);
    setEvidenceError("");
    try {
      const form = new FormData();
      form.append("file", file);
      if (selectedCount === 1) {
        form.append("studentId", selectedList[0].id);
        form.append("classId", selectedList[0].classId);
      } else {
        form.append("classId", selectedClassIds[0]);
      }
      const response = await api<{ evidence: EvidenceRef }>("/evidence", {
        method: "POST",
        body: form,
      });
      setEvidence(response.evidence);
      setEvidenceBoundTo(evidenceTarget);
      setFieldErrors((current) => ({ ...current, evidence: undefined }));
      toast(`证据已上传：${response.evidence.name}`, "success");
    } catch (requestError) {
      setEvidenceError(quickScoreErrorText(requestError, "证据上传失败，请重试"));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeEvidence() {
    if (uploading) return;
    setEvidence(null);
    setEvidenceBoundTo("");
    setEvidenceError("");
  }

  /* ---------------------------------------------------------------- 提交确认 */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const needsReview = Boolean(
    rule &&
      (rule.requiresReview ||
        (settings && Number(settings.reviewThreshold) > 0 && Math.abs(rule.points) >= settings.reviewThreshold)),
  );

  function validateStep3(): string | null {
    const errors: FieldErrors = {};
    if (!occurrenceAt) {
      errors.occurrenceAt = "请选择发生时间";
    } else if (Number.isNaN(new Date(occurrenceAt).getTime())) {
      errors.occurrenceAt = "发生时间格式不正确";
    }
    if (!note.trim()) {
      errors.note = "记分说明为必填项，不能为空";
    } else if (note.trim().length > MAX_NOTE_LENGTH) {
      errors.note = `记分说明最多 ${MAX_NOTE_LENGTH} 个字符`;
    }
    if (rule?.evidenceRequired && !evidence) {
      errors.evidence = "该评分规则要求上传证据，请先上传图片或 PDF";
    }
    if (rule?.evidenceRequired && mixedClasses) {
      errors.evidence = "批量记分且规则要求证据时，请选择同一班级的学生后再上传班级级证据";
    }
    setFieldErrors(errors);
    const first = Object.values(errors).find(Boolean);
    return first || null;
  }

  function openConfirm() {
    if (uploading) {
      toast("证据正在上传，请稍候再提交", "warning");
      return;
    }
    const message = validateStep3();
    if (message) {
      toast(message, "error");
      return;
    }
    setSubmitError("");
    setConfirmOpen(true);
  }

  function goToStep2() {
    if (selectedCount === 0) return;
    setFieldErrors({});
    setStep(2);
  }

  function goToStep3() {
    if (!rule) return;
    setFieldErrors({});
    setStep(3);
  }

  async function submitScoring() {
    if (!rule || submitting) return;
    const payload = {
      ruleId: rule.id,
      ...(batchMode ? { studentIds: selectedList.map((student) => student.id) } : { studentId: selectedList[0].id }),
      occurrenceAt: toIso(occurrenceAt),
      note: note.trim(),
      ...(evidence ? { evidenceIds: [evidence.id] } : {}),
    };
    setSubmitting(true);
    setSubmitError("");
    try {
      const response = batchMode
        ? await api<ScoringResponse>("/scoring/batch", json("POST", payload))
        : await api<ScoringResponse>("/scoring", json("POST", payload));
      const records = response.records ?? (response.record ? [response.record] : []);
      const pendingReview =
        response.summary?.pendingReview ??
        records.filter((item) => item.status === "PENDING_REVIEW").length;
      const created = response.summary?.created ?? records.length;
      setResult({ records, created, pendingReview });
      setConfirmOpen(false);
      toast(created > 1 ? `已提交 ${created} 条记分记录` : "记分已提交", "success");
    } catch (requestError) {
      setSubmitError(quickScoreErrorText(requestError, "提交记分失败，请稍后重试"));
    } finally {
      setSubmitting(false);
    }
  }

  function resetForContinue() {
    setResult(null);
    setStep(1);
    setSelected({});
    setStudentQuery("");
    setRuleId("");
    setDirectionFilter("ALL");
    setCategoryFilter("");
    setOccurrenceAt(dateTimeLocalInput());
    setNote("");
    setEvidence(null);
    setEvidenceBoundTo("");
    setEvidenceError("");
    setFieldErrors({});
    setSubmitError("");
    setConfirmOpen(false);
  }

  /* ---------------------------------------------------------------- 无权限态 */
  if (!canScore) {
    return (
      <div className="page">
        <PageHeader eyebrow="工作台" title="快捷记分" description="移动端优先的日常加减分录入" />
        <Card>
          <EmptyState
            icon={<ShieldCheck size={22} />}
            title="当前账号没有记分权限"
            description="记分权限仅授予系统管理员、德育处与授权范围内的值日老师。如需记分请联系学校管理员开通权限。"
            action={
              <Button variant="secondary" onClick={() => onNavigate("records")}>
                查看积分记录
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  /* ---------------------------------------------------------------- 提交成功 */
  if (result) {
    const pendingFromRecords = result.records.filter((item) => item.status === "PENDING_REVIEW");
    return (
      <div className="page">
        <PageHeader eyebrow="工作台" title="快捷记分" description="记分结果已写入账本（待复核记录审核通过后才计入积分）" />
        <Card>
          <div className="submit-success">
            <div className="submit-success-icon">
              <CheckCircle2 size={30} />
            </div>
            <h2>记分已提交</h2>
            <p className="muted">
              {result.created > 1 ? `已批量提交 ${result.created} 条记录` : "已提交 1 条记录"}
              {result.pendingReview > 0
                ? `，其中 ${result.pendingReview} 条进入待复核。`
                : "，已直接生效。"}
            </p>
            <div className="row" style={{ marginTop: 8 }}>
              <Button icon={<Zap size={16} />} onClick={resetForContinue}>
                继续记分
              </Button>
              <Button variant="secondary" icon={<ClipboardCheck size={16} />} onClick={() => onNavigate("records")}>
                查看积分记录
              </Button>
              <Button variant="ghost" onClick={() => onNavigate("dashboard")}>
                返回总览
              </Button>
            </div>
          </div>
          {result.pendingReview > 0 && (
            <div className="mt-2" style={{ marginBottom: 14 }}>
              <Notice tone="warning">
                有 {result.pendingReview} 条记录处于「待复核」状态，需要德育处审核通过后才会计入学期积分；
                可在「积分记录」中按状态筛选跟进。
              </Notice>
            </div>
          )}
          {result.records.length > 0 && (
            <div className="list">
              {result.records.map((record) => (
                <div className="list-item" key={record.id}>
                  <div className="list-main">
                    <div className="list-title">
                      {record.studentName}
                      <Badge tone={record.direction === "ADD" ? "add" : "deduct"}>
                        {record.directionLabel} {formatScore(record.points)} 分
                      </Badge>
                      <Badge
                        tone={
                          record.status === "EFFECTIVE"
                            ? "success"
                            : record.status === "PENDING_REVIEW"
                              ? "warning"
                              : "danger"
                        }
                      >
                        {record.statusLabel}
                      </Badge>
                    </div>
                    <div className="list-sub">
                      {record.className} · {record.ruleName} · 发生时间 {formatDateTime(record.occurrenceAt)}
                    </div>
                  </div>
                  <div className="list-side">
                    <span className={record.direction === "ADD" ? "score-pill add" : "score-pill deduct"}>
                      {formatSignedScore(record.signedPoints)}
                      <small>分</small>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {pendingFromRecords.length === 0 && result.pendingReview > 0 && (
            <p className="text-xs muted mt-2">服务端返回的待复核数量为 {result.pendingReview} 条。</p>
          )}
        </Card>
      </div>
    );
  }

  /* ---------------------------------------------------------------- 主流程 */
  const header = (
    <PageHeader
      eyebrow="工作台"
      title="快捷记分"
      description="三步完成一次记分：选择学生 → 选择规则 → 填写说明与证据。提交前会二次确认，批量记分事务全有或全无。"
      actions={
        <Button variant="secondary" size="sm" icon={<ClipboardCheck size={15} />} onClick={() => onNavigate("records")}>
          积分记录
        </Button>
      }
    />
  );

  const stepper = (
    <div className="row" style={{ gap: 6, marginBottom: 14 }} aria-label="记分步骤">
      {(
        [
          { value: 1 as const, label: "选择学生" },
          { value: 2 as const, label: "选择规则" },
          { value: 3 as const, label: "填写说明" },
        ] as const
      ).map((item, index) => (
        <React.Fragment key={item.value}>
          <Badge tone={step >= item.value ? "brand" : "neutral"}>
            {step === item.value ? "当前 " : step > item.value ? "✓ " : ""}
            {item.value}. {item.label}
          </Badge>
          {index < 2 && <span className="muted text-xs">→</span>}
        </React.Fragment>
      ))}
    </div>
  );

  if (optionsLoading) {
    return (
      <div className="page">
        {header}
        <Card>
          <Loading label="正在加载班级、规则与学生数据…" />
        </Card>
      </div>
    );
  }

  if (optionsError && !options) {
    return (
      <div className="page">
        {header}
        <Card>
          <Alert
            tone="danger"
            title="记分基础数据加载失败"
            onRetry={() => setOptionsReload((token) => token + 1)}
          >
            {optionsError}
          </Alert>
        </Card>
      </div>
    );
  }

  return (
    <div className="page">
      {header}
      {stepper}

      {step === 1 && (
        <Card
          title="第 1 步 · 选择学生"
          subtitle="按班级筛选并搜索，可多选批量记分（单次最多 50 人）"
          actions={
            <>
              <Badge tone={selectedCount > 0 ? "brand" : "neutral"}>已选 {selectedCount} 人</Badge>
              <Button
                size="sm"
                icon={<ArrowRight size={15} />}
                disabled={selectedCount === 0}
                onClick={goToStep2}
              >
                下一步
              </Button>
            </>
          }
        >
          <div className="filters" style={{ marginBottom: 12 }}>
            <Select
              aria-label="按班级筛选学生"
              value={classFilter}
              onChange={(event) => setClassFilter(event.target.value)}
            >
              <option value="">全部班级</option>
              {classes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.gradeName ? `（${item.gradeName}）` : ""}
                </option>
              ))}
            </Select>
            <div className="search-box">
              <Search size={15} />
              <Input
                aria-label="搜索学生姓名或学号"
                placeholder="搜索姓名 / 学号"
                value={studentQuery}
                onChange={(event) => setStudentQuery(event.target.value)}
              />
            </div>
            <Button variant="secondary" size="sm" onClick={selectAllVisible} disabled={students.length === 0}>
              全选当前结果（{students.length}）
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={selectedCount === 0}
              onClick={() => setSelected({})}
            >
              清空已选
            </Button>
          </div>

          {selectedCount > 0 && (
            <Notice tone="info">
              <div className="row between">
                <span className="text-sm truncate">
                  已选：{selectedList.slice(0, 8).map((student) => `${student.name}（${student.className}）`).join("、")}
                  {selectedCount > 8 ? ` 等 ${selectedCount} 人` : ""}
                </span>
                <Button variant="ghost" size="sm" icon={<X size={14} />} onClick={() => setSelected({})}>
                  清空
                </Button>
              </div>
            </Notice>
          )}

          <div className="mt-2" style={{ marginTop: 12 }}>
            {studentsLoading && <Loading label="正在加载学生…" />}
            {!studentsLoading && studentsError && (
              <Alert tone="danger" title="学生列表加载失败">
                {studentsError}
              </Alert>
            )}
            {!studentsLoading && !studentsError && students.length === 0 && (
              <EmptyState
                icon={<Users size={22} />}
                title="没有匹配的学生"
                description={
                  classes.length === 0
                    ? "当前账号没有可记分的学生范围，请联系系统管理员配置授权范围。"
                    : "请调整班级筛选或搜索关键词后重试。"
                }
              />
            )}
            {!studentsLoading && !studentsError && students.length > 0 && (
              <>
                <div className="list">
                  {students.slice(0, visibleStudents).map((student) => {
                    const isSelected = Boolean(selected[student.id]);
                    const disabled = !isSelected && selectedCount >= MAX_STUDENTS;
                    return (
                      <Checkbox
                        key={student.id}
                        className="list-item"
                        checked={isSelected}
                        disabled={disabled}
                        onChange={() => toggleStudent(student)}
                        label={
                          <span className="list-main">
                            <span className="list-title">
                              {student.name}
                              <span className="muted text-xs mono">{student.studentNo}</span>
                            </span>
                            <span className="list-sub">
                              {student.className} · {student.gradeName}
                            </span>
                          </span>
                        }
                      />
                    );
                  })}
                </div>
                <div className="row between mt-2">
                  <span className="text-xs muted">
                    已显示 {Math.min(visibleStudents, students.length)} / {students.length} 名学生；可用班级筛选或搜索缩小范围
                  </span>
                  {students.length > visibleStudents && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setVisibleStudents((count) => count + 40)}
                    >
                      显示更多（剩余 {students.length - visibleStudents} 人）
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="form-actions between" style={{ paddingTop: 14 }}>
            <span className="text-xs muted">
              {selectedCount === 0
                ? "请至少选择 1 名学生"
                : `已选 ${selectedCount} 人${mixedClasses ? "（跨班级，将生成多条记录）" : ""}`}
            </span>
            <Button
              icon={<ArrowRight size={16} />}
              disabled={selectedCount === 0}
              onClick={goToStep2}
            >
              下一步：选择规则
            </Button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card
          title="第 2 步 · 选择规则"
          subtitle="仅显示已发布且当前有效的规则；规则范围会按所选学生过滤"
          actions={
            <>
              <Button variant="ghost" size="sm" icon={<ArrowLeft size={15} />} onClick={() => setStep(1)}>
                上一步
              </Button>
              <Button
                size="sm"
                icon={<ArrowRight size={15} />}
                disabled={!rule}
                onClick={goToStep3}
              >
                下一步
              </Button>
            </>
          }
        >
          <div className="filters" style={{ marginBottom: 12 }}>
            <Segmented<DirectionFilter>
              ariaLabel="按方向筛选规则"
              size="sm"
              value={directionFilter}
              onChange={setDirectionFilter}
              options={[
                { value: "ALL", label: "全部", count: directionCounts.all },
                { value: "ADD", label: "加分", count: directionCounts.add },
                { value: "DEDUCT", label: "减分", count: directionCounts.deduct },
              ]}
            />
            <Select
              aria-label="按分类筛选规则"
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
            >
              <option value="">全部分类</option>
              {categories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
            <span className="text-xs muted">可选择 {applicableRules.length} 条规则</span>
          </div>

          {publishedRules.length === 0 && (
            <EmptyState
              icon={<FileText size={22} />}
              title="当前没有可用的评分规则"
              description="需要德育处先发布生效中的评分规则，值日老师才能使用。请联系德育处处理。"
              action={
                user.permissions.createRules ? (
                  <Button variant="secondary" size="sm" onClick={() => onNavigate("rules")}>
                    前往评分规则
                  </Button>
                ) : undefined
              }
            />
          )}

          {publishedRules.length > 0 && applicableRules.length === 0 && (
            <EmptyState
              icon={<AlertTriangle size={22} />}
              title="当前所选学生没有共同适用的规则"
              description="可按方向/分类调整筛选，或返回上一步重新选择学生（规则可能只适用于指定年级或班级）。"
              action={
                <Button variant="secondary" size="sm" onClick={() => setStep(1)}>
                  重新选择学生
                </Button>
              }
            />
          )}

          {applicableRules.length > 0 && (
            <div className="list">
              {applicableRules.map((item) => {
                const checked = ruleId === item.id;
                return (
                  <label key={item.id} className="list-item" style={{ cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="rule"
                      checked={checked}
                      onChange={() => setRuleId(item.id)}
                      style={{ marginTop: 4, accentColor: "var(--brand)" }}
                    />
                    <span className="list-main">
                      <span className="list-title">
                        {item.name}
                        <Badge tone={item.direction === "ADD" ? "add" : "deduct"}>
                          {item.direction === "ADD" ? "加分" : "减分"} {formatScore(item.points)} 分
                        </Badge>
                        <span className="muted text-xs">
                          {item.categoryName || categoryNameMap.get(item.categoryId) || "未分类"}
                        </span>
                        {item.evidenceRequired && <Badge tone="warning">需证据</Badge>}
                        {item.requiresReview && <Badge tone="info">需复核</Badge>}
                      </span>
                      {item.description && <span className="list-sub">{item.description}</span>}
                      {item.examples && <span className="list-sub">示例：{item.examples}</span>}
                      {checked && (
                        <span
                          className="notice notice-info"
                          style={{ display: "block", marginTop: 8 }}
                        >
                          已选：{formatScore(item.points)} 分 / 人 · 证据
                          {item.evidenceRequired ? "必填（图片或 PDF）" : "可选"} · 复核
                          {item.requiresReview || (settings && Math.abs(item.points) >= settings.reviewThreshold)
                            ? "：可能进入待复核"
                            : "：按当前策略可能直接生效"}
                          {" · "}本次共 {selectedCount} 人，预计
                          {formatSignedScore(signedPointsFor(item) * selectedCount)} 分
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          <div className="form-actions between" style={{ paddingTop: 14 }}>
            <span className="text-xs muted">
              {rule
                ? `已选：${rule.name}（${formatSignedScore(signedPointsFor(rule))} 分 / 人）`
                : "请选择一条评分规则"}
            </span>
            <Button
              icon={<ArrowRight size={16} />}
              disabled={!rule}
              onClick={goToStep3}
            >
              下一步：填写说明
            </Button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <div className="stack gap-lg">
          <Card
            title="第 3 步 · 填写说明与证据"
            subtitle="发生时间默认当前时间；记分说明必填，提交前会再次确认"
            actions={
              <Button variant="ghost" size="sm" icon={<ArrowLeft size={15} />} onClick={() => setStep(2)}>
                上一步
              </Button>
            }
          >
            <div className="form-grid">
              <Field label="发生时间" required htmlFor="score-occurrence" error={fieldErrors.occurrenceAt}>
                <div className="row nowrap">
                  <Input
                    id="score-occurrence"
                    type="datetime-local"
                    value={occurrenceAt}
                    onChange={(event) => {
                      setOccurrenceAt(event.target.value);
                      setFieldErrors((current) => ({ ...current, occurrenceAt: undefined }));
                    }}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setOccurrenceAt(dateTimeLocalInput());
                      setFieldErrors((current) => ({ ...current, occurrenceAt: undefined }));
                    }}
                  >
                    现在
                  </Button>
                </div>
              </Field>

              <Field
                label="记分说明"
                required
                htmlFor="score-note"
                error={fieldErrors.note}
                hint={
                  fieldErrors.note
                    ? undefined
                    : `必填，最多 ${MAX_NOTE_LENGTH} 字；建议写明具体表现或事由（${note.trim().length}/${MAX_NOTE_LENGTH}）`
                }
              >
                <Textarea
                  id="score-note"
                  placeholder="例如：主动帮助同学补习功课，连续一周坚持整理班级图书角。"
                  value={note}
                  maxLength={MAX_NOTE_LENGTH}
                  rows={4}
                  onChange={(event) => {
                    setNote(event.target.value);
                    setFieldErrors((current) => ({ ...current, note: undefined }));
                  }}
                />
              </Field>

              <Field
                label={rule?.evidenceRequired ? "证据（必填）" : "证据（可选）"}
                required={Boolean(rule?.evidenceRequired)}
                error={fieldErrors.evidence || evidenceError}
                hint={
                  rule?.evidenceRequired
                    ? "该规则要求证据：仅支持 PNG / JPG / WebP 图片或 PDF，单个文件大小以服务端限制为准。"
                    : "可选上传现场照片或 PDF 作为佐证。"
                }
              >
                <div className="stack gap-sm">
                  {!evidenceTarget && (
                    <Notice tone="warning">
                      批量跨班级时无法挂接班级级证据，请选择同一班级的学生，或改选无需证据的规则。
                    </Notice>
                  )}
                  {evidence ? (
                    <div className="list-item">
                      <span className="avatar-sm">
                        <Paperclip size={15} />
                      </span>
                      <div className="list-main">
                        <div className="list-title truncate">{evidence.name}</div>
                        <div className="list-sub">
                          {formatBytes(evidence.sizeBytes)} · {evidence.mime}
                        </div>
                      </div>
                      <div className="list-side row" style={{ gap: 4 }}>
                        <Badge tone="success">已上传</Badge>
                        <a
                          className="link text-sm"
                          href={`/api/evidence/${evidence.id}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          预览
                        </a>
                        <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={removeEvidence}>
                          移除
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="row">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Upload size={15} />}
                        loading={uploading}
                        disabled={!evidenceTarget}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        {uploading ? "正在上传…" : "选择证据文件"}
                      </Button>
                      <span className="text-xs muted">
                        {evidenceTarget ? "支持 PNG / JPG / WebP / PDF" : "当前选择无法上传证据"}
                      </span>
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="sr-only"
                    accept="image/png,image/jpeg,image/webp,application/pdf"
                    aria-label="上传证据文件"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void uploadEvidence(file);
                    }}
                  />
                </div>
              </Field>
            </div>

            <div className="form-actions between" style={{ paddingTop: 16 }}>
              <Button variant="ghost" size="sm" icon={<ArrowLeft size={15} />} onClick={() => setStep(2)}>
                上一步
              </Button>
              <Button
                icon={<Send size={16} />}
                onClick={openConfirm}
                disabled={uploading || selectedCount === 0 || !rule}
              >
                提交前确认
              </Button>
            </div>
          </Card>

          <Card title="本次记分摘要" subtitle="请核对学生、规则与分值；如需修改可返回上一步">
            <dl className="kv">
              <dt>学生</dt>
              <dd>
                {selectedList.map((student) => `${student.name}（${student.className}）`).join("、")}
                <span className="muted"> · 共 {selectedCount} 人</span>
              </dd>
              <dt>规则</dt>
              <dd>
                {rule?.name}（{rule?.direction === "ADD" ? "加分" : "减分"} {formatScore(rule?.points)} 分 / 人）
              </dd>
              <dt>预计积分变化</dt>
              <dd>
                <span className={rule?.direction === "ADD" ? "score-add" : "score-deduct"}>
                  {formatSignedScore(signedPointsFor(rule ?? { points: 0, direction: "ADD" } as QuickRule))} 分 / 人
                </span>
                {batchMode ? `，合计约 ${formatSignedScore(signedPointsFor(rule ?? { points: 0, direction: "ADD" } as QuickRule) * selectedCount)} 分` : ""}
                {needsReview ? "（规则需复核，审核通过后才计入）" : ""}
              </dd>
              <dt>批量策略</dt>
              <dd>{batchMode ? "批量事务：全部成功或全部失败" : "单条记录提交"}</dd>
            </dl>
          </Card>
        </div>
      )}

      <Modal
        open={confirmOpen}
        onClose={() => {
          if (!submitting) setConfirmOpen(false);
        }}
        title="确认提交记分"
        description="提交后将写入积分账本（高影响操作，请核对以下信息）"
        size="md"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={submitting}>
              返回修改
            </Button>
            <Button loading={submitting} onClick={() => void submitScoring()} icon={<CheckCircle2 size={16} />}>
              确认提交
            </Button>
          </div>
        }
      >
        <div className="stack">
          {submitError && (
            <Alert tone="danger" title="提交失败，表单内容已保留">
              {submitError}
            </Alert>
          )}
          <dl className="kv">
            <dt>记分规则</dt>
            <dd>
              {rule?.name}（{rule?.direction === "ADD" ? "加分" : "减分"} {formatScore(rule?.points)} 分）
            </dd>
            <dt>学生名单</dt>
            <dd>
              {selectedList.map((student) => `${student.name}（${student.className}）`).join("、")}
            </dd>
            <dt>人数</dt>
            <dd>{selectedCount} 人{batchMode ? " · 批量事务" : ""}</dd>
            <dt>发生时间</dt>
            <dd>{formatDateTime(toIso(occurrenceAt))}</dd>
            <dt>记分说明</dt>
            <dd>{note.trim()}</dd>
            <dt>证据</dt>
            <dd>
              {evidence ? (
                <span>
                  {evidence.name}（{formatBytes(evidence.sizeBytes)}）
                </span>
              ) : rule?.evidenceRequired ? (
                "缺少必填证据"
              ) : (
                "未上传"
              )}
            </dd>
            <dt>预计积分变化</dt>
            <dd>
              <span className={rule?.direction === "ADD" ? "score-add" : "score-deduct"}>
                {formatSignedScore(signedPointsFor(rule ?? { points: 0, direction: "ADD" } as QuickRule))} 分 / 人
              </span>
              {batchMode
                ? `，每人一条记录，共 ${selectedCount} 条`
                : "，生成 1 条记录"}
            </dd>
          </dl>
          <Notice tone={needsReview ? "warning" : "info"}>
            {needsReview
              ? "该规则或分值可能触发复核：记录进入「待复核」后需要德育处审核通过才计入学期积分（以服务端返回状态为准）。"
              : "是否需要复核由规则设置与服务端审核策略决定，最终状态以提交结果为准。"}
          </Notice>
          <p className="text-xs muted">
            <Sparkles size={12} style={{ display: "inline", marginRight: 4 }} />
            提交后如需撤销，只能由德育处/管理员通过「冲正」并填写理由完成，原记录不会被删除。
          </p>
        </div>
      </Modal>
    </div>
  );
}


