// OWNER: frontend-core. 积分记录：筛选 / 分页 / 详情 / 复核 / 冲正 / 导出 CSV。
// 接口契约见 docs/ARCHITECTURE.md 5.2；高影响操作全部二次确认并展示影响范围。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  Eye,
  FileText,
  FilterX,
  Gavel,
  ListChecks,
  Paperclip,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { api, ApiError, download, json, query } from "../api";
import {
  directionTone,
  formatBytes,
  formatDateTime,
  formatScore,
  formatSignedScore,
  recordStatusTone,
  todayInput,
} from "../format";
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
  Notice,
  PageHeader,
  Pagination,
  Select,
  Textarea,
  useToast,
} from "../components/ui";
import type { PageProps, Paginated, RecordView } from "../types";

const PAGE_SIZE = 20;

type DirectionFilter = "" | "ADD" | "DEDUCT";
type StatusFilter = "" | "EFFECTIVE" | "PENDING_REVIEW" | "REJECTED";

interface Filters {
  termId: string;
  classId: string;
  studentId: string;
  direction: DirectionFilter;
  categoryId: string;
  status: StatusFilter;
  from: string;
  to: string;
  search: string;
}

interface RecordsOptions {
  classes?: Array<{ id: string; name: string; gradeId?: string; gradeName?: string }>;
  categories?: Array<{ id: string; name: string; directionScope?: string }>;
  terms?: Array<{ id: string; name: string; isCurrent?: boolean; academicYearName?: string }>;
}

interface StudentOption {
  id: string;
  name: string;
  studentNo: string;
  classId: string;
  className: string;
  gradeName: string;
}

interface RecordDetailResponse {
  record: RecordView;
  relations?: {
    reversal?: RecordView | null;
    // 服务端关系接口返回数组（可能为空数组），旧契约类型为单条，这里两种都兼容。
    correctedBy?: RecordView[] | RecordView | null;
    corrects?: RecordView | null;
    appeals?: RecordDetailResponseAppeal[];
  };
}

interface RecordDetailResponseAppeal {
  id: string;
  status: string;
  statusLabel: string;
  reason: string;
  submittedByName?: string;
  createdAt?: string;
  decidedAt?: string | null;
  decisionReason?: string;
  conflictFlag?: boolean;
}

function normalizeCorrectedBy(
  value: RecordView[] | RecordView | null | undefined,
): RecordView[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function recordsErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录状态已失效，请重新登录";
    if (error.status === 403) return error.message || "没有权限执行该操作";
    if (error.status === 400) {
      const issues = (error.issues || []).map((issue) => issue.message).filter(Boolean);
      return issues.length > 0 ? issues.join("；") : error.message || fallback;
    }
    if (error.status === 404) return "记录不存在或不属于当前账号的数据范围";
    if (error.status >= 500) return error.message || "服务暂时不可用，请稍后重试";
    return error.message || fallback;
  }
  if (error instanceof DOMException && error.name === "AbortError") return "";
  return error instanceof Error && error.message ? error.message : fallback;
}

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "", label: "全部状态" },
  { value: "EFFECTIVE", label: "已生效" },
  { value: "PENDING_REVIEW", label: "待复核" },
  { value: "REJECTED", label: "已驳回" },
];

function buildQuery(filters: Filters, page: number): string {
  return query({
    termId: filters.termId,
    classId: filters.classId,
    studentId: filters.studentId,
    direction: filters.direction,
    categoryId: filters.categoryId,
    status: filters.status,
    from: filters.from,
    to: filters.to,
    search: filters.search,
    page,
    pageSize: PAGE_SIZE,
  });
}

export function RecordsPage({ user, onNavigate, params }: PageProps) {
  const toast = useToast();

  const initialFilters = useMemo<Filters>(() => {
    const directionParam = params.direction;
    const statusParam = params.status;
    return {
      termId: params.termId || user.currentTerm?.id || "",
      classId: params.classId || "",
      studentId: params.studentId || "",
      direction: directionParam === "ADD" || directionParam === "DEDUCT" ? directionParam : "",
      categoryId: params.categoryId || "",
      status:
        statusParam === "EFFECTIVE" || statusParam === "PENDING_REVIEW" || statusParam === "REJECTED"
          ? statusParam
          : "",
      from: params.from || "",
      to: params.to || "",
      search: params.search || "",
    };
    // 仅在页面挂载时根据路由参数初始化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------------------------------------- 列表数据 */
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [keyword, setKeyword] = useState(initialFilters.search);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<RecordView> | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setListError("");
    (async () => {
      try {
        const response = await api<Paginated<RecordView>>(`/records${buildQuery(filters, page)}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setData({
          items: response.items ?? [],
          total: response.total ?? 0,
          page: response.page ?? page,
          pageSize: response.pageSize ?? PAGE_SIZE,
          totalPages: response.totalPages ?? 1,
        });
      } catch (requestError) {
        if (controller.signal.aborted) return;
        setListError(recordsErrorText(requestError, "加载积分记录失败，请稍后重试"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [filters, page, reloadToken]);

  // 关键词输入防抖，避免每输入一个字符就请求。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = keyword.trim();
      setFilters((current) => (current.search === next ? current : { ...current, search: next }));
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const updateFilters = useCallback((patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  }, []);

  /* ---------------------------------------------------------------- 选项数据 */
  const [options, setOptions] = useState<RecordsOptions | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [optionsReload, setOptionsReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setOptionsError("");
    api<RecordsOptions>("/options", { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setOptions(response);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setOptionsError(recordsErrorText(requestError, "加载筛选选项失败"));
        }
      });
    return () => controller.abort();
  }, [optionsReload]);

  const [studentOptions, setStudentOptions] = useState<StudentOption[]>([]);
  const [studentsLoading, setStudentsLoading] = useState(false);
  const [studentsError, setStudentsError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setStudentsLoading(true);
    setStudentsError("");
    api<{ items?: StudentOption[] }>(`/options/students${query({ classId: filters.classId })}`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!controller.signal.aborted) setStudentOptions(response.items ?? []);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setStudentOptions([]);
          setStudentsError(recordsErrorText(requestError, "加载学生选项失败"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setStudentsLoading(false);
      });
    return () => controller.abort();
  }, [filters.classId]);

  const classes = options?.classes ?? [];
  const categories = options?.categories ?? [];
  const terms = options?.terms ?? [];

  /* ---------------------------------------------------------------- 详情数据 */
  const [detailId, setDetailId] = useState(params.recordId || "");
  const [detailStack, setDetailStack] = useState<string[]>([]);
  const [detail, setDetail] = useState<RecordDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(Boolean(params.recordId));
  const [detailError, setDetailError] = useState("");
  const [detailReload, setDetailReload] = useState(0);

  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      setDetailError("");
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError("");
    (async () => {
      try {
        const response = await api<RecordDetailResponse>(`/records/${detailId}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setDetail(response);
      } catch (requestError) {
        if (controller.signal.aborted) return;
        setDetailError(recordsErrorText(requestError, "加载记录详情失败"));
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    })();
    return () => controller.abort();
  }, [detailId, detailReload]);

  function openDetail(recordId: string) {
    if (detailId && detailId !== recordId) {
      setDetailStack((current) => [...current, detailId]);
    }
    setDetailLoading(true);
    setDetailId(recordId);
  }

  function closeDetail() {
    setDetailId("");
    setDetailStack([]);
    setDetail(null);
    setDetailError("");
    setDetailLoading(false);
    setActionKind(null);
  }

  function goBackDetail() {
    const next = [...detailStack];
    const previous = next.pop() || "";
    setDetailStack(next);
    setDetailLoading(Boolean(previous));
    setDetailId(previous);
  }

  /* -------------------------------------------------------- 复核 / 冲正操作 */
  type ActionKind = "approve" | "reject" | "revoke";
  const [actionKind, setActionKind] = useState<ActionKind | null>(null);
  const [actionNote, setActionNote] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  function startAction(kind: ActionKind) {
    setActionKind(kind);
    setActionNote("");
    setActionError("");
  }

  const actionTitle =
    actionKind === "approve"
      ? "确认通过该记录？"
      : actionKind === "reject"
        ? "驳回该待复核记录"
        : "冲正该积分记录";

  async function runAction() {
    if (!actionKind || !detailId || actionLoading) return;
    const reason = actionNote.trim();
    if (actionKind === "reject" || actionKind === "revoke") {
      if (!reason) {
        setActionError(
          actionKind === "reject" ? "请填写驳回理由（会写入审计日志）" : "请填写冲正理由（会写入审计日志）",
        );
        return;
      }
      if (reason.length < 2) {
        setActionError("理由至少需要 2 个字符");
        return;
      }
    }
    setActionLoading(true);
    setActionError("");
    try {
      if (actionKind === "approve") {
        await api(`/records/${detailId}/approve`, json("POST", reason ? { note: reason } : {}));
        toast("复核通过，记录已生效并计入积分", "success");
      } else if (actionKind === "reject") {
        await api(`/records/${detailId}/reject`, json("POST", { reason }));
        toast("记录已驳回，未计入积分", "success");
      } else {
        await api(`/records/${detailId}/revoke`, json("POST", { reason }));
        toast("已生成冲正记录，原记录保留但不再计入积分", "success");
      }
      setActionKind(null);
      setActionNote("");
      setReloadToken((token) => token + 1);
      setDetailReload((token) => token + 1);
    } catch (requestError) {
      setActionError(recordsErrorText(requestError, "操作失败，请稍后重试"));
    } finally {
      setActionLoading(false);
    }
  }

  /* ---------------------------------------------------------------- 导出 CSV */
  const [exporting, setExporting] = useState(false);
  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      await download(
        `/records/export.csv${query({
          termId: filters.termId,
          classId: filters.classId,
          studentId: filters.studentId,
          direction: filters.direction,
          categoryId: filters.categoryId,
          status: filters.status,
          from: filters.from,
          to: filters.to,
          search: filters.search,
        })}`,
        `积分记录-${todayInput()}.csv`,
      );
      toast("CSV 导出已开始下载", "success");
    } catch (requestError) {
      toast(recordsErrorText(requestError, "导出失败，请稍后重试"), "error");
    } finally {
      setExporting(false);
    }
  }

  const items = data?.items ?? [];
  const hasActiveFilters = Boolean(
    filters.classId ||
      filters.studentId ||
      filters.direction ||
      filters.categoryId ||
      filters.status ||
      filters.from ||
      filters.to ||
      filters.search,
  );

  function resetFilters() {
    setKeyword("");
    setFilters({
      termId: user.currentTerm?.id || "",
      classId: "",
      studentId: "",
      direction: "",
      categoryId: "",
      status: "",
      from: "",
      to: "",
      search: "",
    });
    setPage(1);
  }

  const currentRecord = detail?.record ?? null;
  const relations = detail?.relations;
  const correctedByList = normalizeCorrectedBy(relations?.correctedBy);
  const appealList = relations?.appeals ?? [];
  const canReview = user.permissions.reviewRecords;
  const canRevoke = user.permissions.revokeRecords;
  const canAppeal = user.permissions.registerAppeals;

  const actionImpact =
    actionKind === "approve"
      ? "通过后该记录即刻生效并计入学生学期积分；操作会写入审计日志。"
      : actionKind === "reject"
        ? "驳回后该记录不计入积分，学生与提交人可看到驳回理由。"
        : "冲正不会删除原记录，而是新增一条相反方向的冲正记录，原记录失去计分效力；该操作不可撤销，必须填写理由并写入审计日志。";

  const actionPlaceholder =
    actionKind === "approve"
      ? "可填写复核备注（可选）"
      : actionKind === "reject"
        ? "请填写驳回理由（必填，会写入审计日志）"
        : "请填写冲正理由（必填，会写入审计日志）";

  const actionConfirmLabel =
    actionKind === "approve" ? "确认通过" : actionKind === "reject" ? "确认驳回" : "确认冲正";

  /* ------------------------------------------------------------------- 渲染 */
  return (
    <div
      className="page"
     
    >
      <PageHeader
        eyebrow="工作台"
        title="积分记录"
        description="德育账本明细：支持按学期、班级、学生、方向、分类、状态、日期与关键词筛选，点击行查看规则快照、证据与冲正/申诉关联。"
        actions={
          <>
            <Button
              variant="secondary"
              icon={<RefreshCw size={15} />}
              loading={loading}
              onClick={() => setReloadToken((token) => token + 1)}
            >
              刷新
            </Button>
            {user.permissions.exportData && (
              <Button
                variant="secondary"
                icon={<Download size={15} />}
                loading={exporting}
                onClick={() => void exportCsv()}
              >
                导出 CSV
              </Button>
            )}
          </>
        }
      />

      {/* ------------------------------------------------------------- 筛选区 */}
      <Card
        title="筛选记录"
        subtitle="筛选条件变化会立即刷新列表；时间范围按发生时间筛选"
        actions={
          <Button variant="ghost" size="sm" icon={<FilterX size={14} />} onClick={resetFilters}>
            重置筛选
          </Button>
        }
      >
        <div className="inline-fields">
          <Field label="学期">
            <Select
              aria-label="按学期筛选"
              value={filters.termId}
              onChange={(event) => updateFilters({ termId: event.target.value })}
            >
              <option value="">全部学期</option>
              {filters.termId && !terms.some((item) => item.id === filters.termId) && (
                <option value={filters.termId}>{user.currentTerm?.name || "当前学期"}</option>
              )}
              {terms.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.academicYearName ? `${item.academicYearName} · ${item.name}` : item.name}
                  {item.isCurrent ? "（当前）" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="班级">
            <Select
              aria-label="按班级筛选"
              value={filters.classId}
              onChange={(event) => updateFilters({ classId: event.target.value, studentId: "" })}
            >
              <option value="">全部班级</option>
              {classes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.gradeName ? `（${item.gradeName}）` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="学生">
            <Select
              aria-label="按学生筛选"
              value={filters.studentId}
              disabled={studentsLoading}
              onChange={(event) => updateFilters({ studentId: event.target.value })}
            >
              <option value="">全部学生</option>
              {filters.studentId && !studentOptions.some((item) => item.id === filters.studentId) && (
                <option value={filters.studentId}>已选学生</option>
              )}
              {studentOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}（{item.className}）
                </option>
              ))}
            </Select>
          </Field>
          <Field label="方向">
            <Select
              aria-label="按方向筛选"
              value={filters.direction}
              onChange={(event) =>
                updateFilters({ direction: event.target.value as DirectionFilter })
              }
            >
              <option value="">全部方向</option>
              <option value="ADD">加分</option>
              <option value="DEDUCT">减分</option>
            </Select>
          </Field>
          <Field label="分类">
            <Select
              aria-label="按分类筛选"
              value={filters.categoryId}
              onChange={(event) => updateFilters({ categoryId: event.target.value })}
            >
              <option value="">全部分类</option>
              {categories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="状态">
            <Select
              aria-label="按状态筛选"
              value={filters.status}
              onChange={(event) => updateFilters({ status: event.target.value as StatusFilter })}
            >
              {STATUS_OPTIONS.map((item) => (
                <option key={item.value || "all"} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="开始日期">
            <Input
              aria-label="开始日期"
              type="date"
              value={filters.from}
              max={filters.to || undefined}
              onChange={(event) => updateFilters({ from: event.target.value })}
            />
          </Field>
          <Field label="结束日期">
            <Input
              aria-label="结束日期"
              type="date"
              value={filters.to}
              min={filters.from || undefined}
              onChange={(event) => updateFilters({ to: event.target.value })}
            />
          </Field>
          <Field label="关键词" hint="学生姓名 / 学号 / 说明">
            <div className="search-box">
              <Search size={15} />
              <Input
                aria-label="关键词搜索"
                placeholder="搜索学生、学号或说明"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </div>
          </Field>
        </div>
        {studentsError && (
          <p className="text-xs mt-2" style={{ color: "var(--deduct)" }}>
            {studentsError}
          </p>
        )}
        {optionsError && (
          <p className="text-xs mt-2" style={{ color: "var(--warn)" }}>
            {optionsError}{" "}
            <Button variant="ghost" size="sm" onClick={() => setOptionsReload((token) => token + 1)}>
              重试
            </Button>
          </p>
        )}
        {hasActiveFilters && (
          <p className="text-xs muted mt-2">
            已应用筛选：{[
              filters.classId && "班级",
              filters.studentId && "学生",
              filters.direction && "方向",
              filters.categoryId && "分类",
              filters.status && "状态",
              (filters.from || filters.to) && "日期范围",
              filters.search && "关键词",
            ]
              .filter(Boolean)
              .join("、")}
          </p>
        )}
      </Card>

      {listError && data && (
        <div className="mt-2" style={{ marginBottom: 12 }}>
          <Alert tone="warning" title="列表刷新失败，以下为上次加载的数据" onRetry={() => setReloadToken((token) => token + 1)}>
            {listError}
          </Alert>
        </div>
      )}

      {/* --------------------------------------------------------------- 列表 */}
      <div className="mt-4" style={{ marginTop: 16 }}>
        <Card
          title="积分记录明细"
          subtitle={
            data
              ? `共 ${data.total} 条 · 第 ${data.page} / ${Math.max(1, data.totalPages)} 页 · 仅显示当前账号授权范围`
              : "正在汇总账本数据"
          }
          actions={<Badge tone="brand">账本只追加 · 生效记录不可修改</Badge>}
          padded={false}
        >
          {loading ? (
            <Loading label="正在加载积分记录…" />
          ) : listError && !data ? (
            <div className="card-body">
              <Alert tone="danger" title="积分记录加载失败" onRetry={() => setReloadToken((token) => token + 1)}>
                {listError}
              </Alert>
            </div>
          ) : items.length === 0 ? (
            <div className="card-body">
              <EmptyState
                icon={<ListChecks size={22} />}
                title="暂无积分记录"
                description={
                  hasActiveFilters
                    ? "当前筛选条件下没有记录，可调整或重置筛选条件。"
                    : "当前学期还没有任何记录。值日老师可通过快捷记分录入。"
                }
                action={
                  hasActiveFilters ? (
                    <Button variant="secondary" size="sm" onClick={resetFilters}>
                      重置筛选
                    </Button>
                  ) : user.permissions.score ? (
                    <Button size="sm" onClick={() => onNavigate("quick-score")}>
                      去记分
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <>
              <div className="table-wrap table-responsive">
                <table className="table">
                  <thead>
                    <tr>
                      <th>发生时间</th>
                      <th>学生</th>
                      <th>班级</th>
                      <th>规则 / 分类</th>
                      <th>方向 / 分值</th>
                      <th>状态</th>
                      <th>提交人</th>
                      <th aria-label="操作" />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((record) => (
                      <tr
                        key={record.id}
                        onClick={() => openDetail(record.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            openDetail(record.id);
                          }
                        }}
                        tabIndex={0}
                        aria-label={`查看 ${record.studentName} 的记录详情`}
                        style={{ cursor: "pointer" }}
                      >
                        <td className="no-wrap">{formatDateTime(record.occurrenceAt)}</td>
                        <td>
                          <div className="cell-strong">{record.studentName}</div>
                          <div className="text-xs muted mono">{record.studentNo}</div>
                        </td>
                        <td>
                          <div>{record.className}</div>
                          <div className="text-xs muted">{record.gradeName}</div>
                        </td>
                        <td>
                          <div className="truncate" style={{ maxWidth: 220 }}>
                            {record.ruleName || "—"}
                          </div>
                          <div className="text-xs muted">{record.categoryName || "未分类"}</div>
                        </td>
                        <td>
                          <div className="row nowrap" style={{ gap: 6 }}>
                            <Badge tone={directionTone(record.direction)}>{record.directionLabel}</Badge>
                            <span
                              className={
                                record.direction === "ADD"
                                  ? "score-value score-add"
                                  : "score-value score-deduct"
                              }
                            >
                              {formatSignedScore(record.signedPoints)}
                            </span>
                          </div>
                          {record.recordKind !== "STANDARD" && (
                            <div className="text-xs muted">{record.recordKindLabel}</div>
                          )}
                        </td>
                        <td>
                          <Badge tone={recordStatusTone(record.status, record.reversed)}>
                            {record.statusLabel}
                          </Badge>
                        </td>
                        <td>
                          <div>{record.submitterName || "—"}</div>
                          <div className="text-xs muted">{record.sourceLabel}</div>
                        </td>
                        <td>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<Eye size={14} />}
                            onClick={(event) => {
                              event.stopPropagation();
                              openDetail(record.id);
                            }}
                          >
                            详情
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 移动端卡片化列表 */}
              <div className="table-card" style={{ padding: "0 14px 14px" }}>
                {items.map((record) => (
                  <div
                    key={record.id}
                    className="record-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => openDetail(record.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openDetail(record.id);
                      }
                    }}
                    aria-label={`查看 ${record.studentName} 的记录详情`}
                  >
                    <div className="record-card-head">
                      <div>
                        <div className="record-card-name">
                          {record.studentName}
                          <span className="muted text-xs"> · {record.className}</span>
                        </div>
                        <div className="record-card-meta">
                          {formatDateTime(record.occurrenceAt)} · {record.submitterName || "—"}
                        </div>
                      </div>
                      <span
                        className={
                          record.direction === "ADD" ? "score-pill add" : "score-pill deduct"
                        }
                      >
                        {formatSignedScore(record.signedPoints)}
                        <small>分</small>
                      </span>
                    </div>
                    <div className="row between" style={{ marginTop: 8 }}>
                      <span className="text-sm truncate">{record.ruleName || "—"}</span>
                      <Badge tone={recordStatusTone(record.status, record.reversed)}>
                        {record.statusLabel}
                      </Badge>
                    </div>
                    <div className="row between" style={{ marginTop: 8 }}>
                      <span className="text-xs muted">
                        {record.categoryName || "未分类"}
                        {record.recordKind !== "STANDARD" ? ` · ${record.recordKindLabel}` : ""}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Eye size={14} />}
                        onClick={(event) => {
                          event.stopPropagation();
                          openDetail(record.id);
                        }}
                      >
                        详情
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ padding: "0 18px 14px" }}>
                <Pagination
                  page={data?.page ?? page}
                  totalPages={Math.max(1, data?.totalPages ?? 1)}
                  total={data?.total ?? 0}
                  onChange={(nextPage) => {
                    setPage(nextPage);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                />
              </div>
            </>
          )}
        </Card>
      </div>

      {/* ------------------------------------------------------------- 详情弹窗 */}
      <Modal
        open={Boolean(detailId)}
        onClose={closeDetail}
        title={
          detail
            ? `${detail.record.studentName} · ${detail.record.directionLabel} ${formatScore(detail.record.points)} 分`
            : "记录详情"
        }
        description={
          detail
            ? `${detail.record.className} · ${formatDateTime(detail.record.occurrenceAt)} · 记录号 ${detail.record.id}`
            : "正在读取规则快照与关联记录"
        }
        size="lg"
        footer={
          <div className="modal-actions">
            {detailStack.length > 0 && (
              <Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={goBackDetail}>
                返回上一记录
              </Button>
            )}
            <Button
              variant="ghost"
              icon={<ListChecks size={15} />}
              disabled={!currentRecord}
              onClick={() => {
                if (!currentRecord) return;
                closeDetail();
                setKeyword("");
                setFilters({
                  termId: user.currentTerm?.id || "",
                  classId: "",
                  studentId: currentRecord.studentId,
                  direction: "",
                  categoryId: "",
                  status: "",
                  from: "",
                  to: "",
                  search: "",
                });
                setPage(1);
              }}
            >
              查看该生全部记录
            </Button>
            <Button variant="secondary" onClick={closeDetail} disabled={actionLoading}>
              关闭
            </Button>
            {currentRecord && currentRecord.status === "EFFECTIVE" &&
              !currentRecord.reversed &&
              canAppeal && (
                <Button
                  variant="secondary"
                  icon={<Gavel size={15} />}
                  onClick={() => onNavigate("appeals", { recordId: currentRecord.id })}
                >
                  登记申诉
                </Button>
              )}
            {currentRecord &&
              currentRecord.status === "EFFECTIVE" &&
              !currentRecord.reversed &&
              canRevoke &&
              currentRecord.recordKind === "STANDARD" && (
                <Button variant="danger" icon={<RotateCcw size={15} />} onClick={() => startAction("revoke")}>
                  冲正
                </Button>
              )}
            {currentRecord && currentRecord.status === "PENDING_REVIEW" && canReview && (
              <>
                <Button variant="danger" icon={<XCircle size={15} />} onClick={() => startAction("reject")}>
                  驳回
                </Button>
                <Button icon={<CheckCircle2 size={15} />} onClick={() => startAction("approve")}>
                  通过复核
                </Button>
              </>
            )}
          </div>
        }
      >
        {detailLoading && <Loading label="正在加载记录详情…" />}
        {!detailLoading && detailError && (
          <Alert
            tone="danger"
            title="记录详情加载失败"
            onRetry={() => setDetailReload((token) => token + 1)}
          >
            {detailError}
          </Alert>
        )}
        {!detailLoading && detail && currentRecord && (
          <div className="stack gap-lg">
            {currentRecord.reversed && (
              <Notice tone="warning">
                该记录已被冲正，不再计入学生积分；冲正记录与原因见下方「关联记录」。
              </Notice>
            )}
            {currentRecord.status === "PENDING_REVIEW" && (
              <Notice tone="warning">
                该记录处于待复核状态，尚未计入学生积分。{canReview ? "可在弹窗底部通过或驳回。" : "需由德育处/管理员复核。"}
              </Notice>
            )}

            <section>
              <dl className="kv">
                <dt>学生</dt>
                <dd>
                  {currentRecord.studentName}（{currentRecord.studentNo || "无学号"}）· {currentRecord.className}
                  {currentRecord.gradeName ? ` · ${currentRecord.gradeName}` : ""}
                </dd>
                <dt>方向 / 分值</dt>
                <dd>
                  <Badge tone={directionTone(currentRecord.direction)}>
                    {currentRecord.directionLabel} {formatScore(currentRecord.points)} 分
                  </Badge>{" "}
                  <span
                    className={
                      currentRecord.direction === "ADD" ? "score-value score-add" : "score-value score-deduct"
                    }
                  >
                    {formatSignedScore(currentRecord.signedPoints)} 分
                  </span>
                </dd>
                <dt>状态</dt>
                <dd>
                  <Badge tone={recordStatusTone(currentRecord.status, currentRecord.reversed)}>
                    {currentRecord.statusLabel}
                  </Badge>{" "}
                  <span className="muted text-sm">{currentRecord.recordKindLabel}</span>
                </dd>
                <dt>发生时间</dt>
                <dd>{formatDateTime(currentRecord.occurrenceAt)}</dd>
                <dt>提交人</dt>
                <dd>
                  {currentRecord.submitterName || "—"} · {currentRecord.sourceLabel} ·{" "}
                  {formatDateTime(currentRecord.createdAt)}
                </dd>
                <dt>复核信息</dt>
                <dd>
                  {currentRecord.reviewerName
                    ? `${currentRecord.reviewerName} · ${formatDateTime(currentRecord.reviewedAt)}`
                    : "尚未复核"}
                  {currentRecord.reviewNote ? ` · 备注：${currentRecord.reviewNote}` : ""}
                </dd>
                <dt>记分说明</dt>
                <dd>{currentRecord.note || "—"}</dd>
                {currentRecord.batchId && <dt>批次</dt>}
                {currentRecord.batchId && <dd className="mono text-xs">{currentRecord.batchId}</dd>}
              </dl>
            </section>

            <section>
              <h3 className="card-title" style={{ marginBottom: 8 }}>
                规则快照
              </h3>
              <dl className="kv">
                <dt>规则名称</dt>
                <dd>{currentRecord.ruleName || "—"}</dd>
                <dt>分类</dt>
                <dd>{currentRecord.categoryName || "未分类"}</dd>
                <dt>方向</dt>
                <dd>{currentRecord.directionLabel}</dd>
                <dt>分值</dt>
                <dd>{formatScore(currentRecord.points)} 分</dd>
                <dt>快照说明</dt>
                <dd className="text-sm muted">
                  记录保存提交时的规则名称、分类、方向与分值，评分规则后续改版不会影响历史记录。
                </dd>
              </dl>
            </section>

            <section>
              <h3 className="card-title" style={{ marginBottom: 8 }}>
                证据（{currentRecord.evidence.length}）
              </h3>
              {currentRecord.evidence.length === 0 ? (
                <p className="text-sm muted">该记录没有关联证据文件。</p>
              ) : (
                <div className="list">
                  {currentRecord.evidence.map((file) => (
                    <div className="list-item" key={file.id}>
                      <span className="avatar-sm">
                        {file.mime.startsWith("image/") ? <Paperclip size={15} /> : <FileText size={15} />}
                      </span>
                      <div className="list-main">
                        <div className="list-title truncate">{file.name}</div>
                        <div className="list-sub">
                          {formatBytes(file.sizeBytes)} · {file.mime}
                        </div>
                      </div>
                      <div className="list-side row" style={{ gap: 6 }}>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Eye size={14} />}
                          onClick={() => window.open(`/api/evidence/${file.id}`, "_blank", "noopener")}
                        >
                          预览
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Download size={14} />}
                          onClick={() => {
                            void download(`/evidence/${file.id}`, file.name).catch((requestError) => {
                              toast(recordsErrorText(requestError, "下载证据失败"), "error");
                            });
                          }}
                        >
                          下载
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h3 className="card-title" style={{ marginBottom: 8 }}>
                关联记录与申诉
              </h3>
              <div className="stack gap-sm">
                {!relations?.reversal &&
                  correctedByList.length === 0 &&
                  !relations?.corrects &&
                  appealList.length === 0 && (
                    <p className="text-sm muted">暂无冲正、更正或申诉关联。</p>
                  )}
                {relations?.reversal && (
                  <RelationRow
                    label="被冲正记录"
                    record={relations.reversal}
                    onOpen={() => openDetail(relations.reversal!.id)}
                  />
                )}
                {correctedByList.map((record) => (
                  <RelationRow
                    key={record.id}
                    label="更正记录"
                    record={record}
                    onOpen={() => openDetail(record.id)}
                  />
                ))}
                {relations?.corrects && (
                  <RelationRow
                    label="本条更正了"
                    record={relations.corrects}
                    onOpen={() => openDetail(relations.corrects!.id)}
                  />
                )}
                {appealList.map((appeal) => (
                  <div className="list-item" key={appeal.id}>
                    <span className="avatar-sm">
                      <Gavel size={15} />
                    </span>
                    <div className="list-main">
                      <div className="list-title">
                        申诉 {appeal.statusLabel}
                        {appeal.conflictFlag && <Badge tone="warning">利益冲突</Badge>}
                      </div>
                      <div className="list-sub">
                        理由：{appeal.reason || "—"} · 提交人 {appeal.submittedByName || "—"} ·{" "}
                        {formatDateTime(appeal.createdAt)}
                      </div>
                      {appeal.decisionReason && (
                        <div className="list-sub">裁决理由：{appeal.decisionReason}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </Modal>

      {/* --------------------------------------------------------- 高影响操作确认 */}
      <Modal
        open={actionKind !== null}
        onClose={() => {
          if (!actionLoading) setActionKind(null);
        }}
        title={actionTitle}
        description={
          currentRecord
            ? `${currentRecord.studentName} · ${currentRecord.className} · ${currentRecord.directionLabel} ${formatScore(currentRecord.points)} 分`
            : "请确认操作"
        }
        size="sm"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setActionKind(null)} disabled={actionLoading}>
              取消
            </Button>
            <Button
              variant={actionKind === "approve" ? "primary" : "danger"}
              loading={actionLoading}
              onClick={() => void runAction()}
            >
              {actionConfirmLabel}
            </Button>
          </div>
        }
      >
        <div className="stack">
          {actionError && (
            <Alert tone="danger" title="操作未完成">
              {actionError}
            </Alert>
          )}
          <Notice tone={actionKind === "approve" ? "info" : "danger"}>{actionImpact}</Notice>
          {currentRecord && (
            <dl className="kv">
              <dt>学生</dt>
              <dd>
                {currentRecord.studentName}（{currentRecord.className}）
              </dd>
              <dt>规则</dt>
              <dd>
                {currentRecord.ruleName || "—"} · {currentRecord.directionLabel}{" "}
                {formatScore(currentRecord.points)} 分
              </dd>
              <dt>发生时间</dt>
              <dd>{formatDateTime(currentRecord.occurrenceAt)}</dd>
              <dt>当前状态</dt>
              <dd>{currentRecord.statusLabel}</dd>
            </dl>
          )}
          <Field
            label={actionKind === "approve" ? "复核备注（可选）" : actionKind === "reject" ? "驳回理由" : "冲正理由"}
            required={actionKind !== "approve"}
            hint={
              actionKind === "approve"
                ? "备注会记录在复核信息中"
                : "理由将写入审计日志，学生与提交人可查看"
            }
          >
            <Textarea
              value={actionNote}
              maxLength={actionKind === "approve" ? 500 : 300}
              rows={3}
              placeholder={actionPlaceholder}
              onChange={(event) => {
                setActionNote(event.target.value);
                if (actionError) setActionError("");
              }}
            />
          </Field>
          <p className="text-xs muted">
            <ShieldCheck size={12} style={{ display: "inline", marginRight: 4 }} />
            该操作会立即写入账本/审计日志，提交后不可撤销。
          </p>
        </div>
      </Modal>
    </div>
  );
}

/** 关联记录行（只读 + 跳转查看）。 */
function RelationRow({
  label,
  record,
  onOpen,
}: {
  label: string;
  record: RecordView;
  onOpen: () => void;
}) {
  return (
    <div className="list-item">
      <span className="avatar-sm">
        <RotateCcw size={15} />
      </span>
      <div className="list-main">
        <div className="list-title">
          {label}
          <Badge tone={directionTone(record.direction)}>
            {record.directionLabel} {formatScore(record.points)} 分
          </Badge>
          <Badge tone={recordStatusTone(record.status, record.reversed)}>{record.statusLabel}</Badge>
        </div>
        <div className="list-sub">
          {record.studentName} · {record.className} · 发生时间 {formatDateTime(record.occurrenceAt)}
          {record.note ? ` · ${record.note}` : ""}
        </div>
      </div>
      <div className="list-side">
        <Button variant="secondary" size="sm" icon={<Eye size={14} />} onClick={onOpen}>
          查看
        </Button>
      </div>
    </div>
  );
}

