// OWNER: frontend-ops. 评分规则管理：指标分类维护、规则版本生命周期
// （草稿 → 提交审核 → 审核 → 发布 / 驳回 / 归档）与版本历史。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  CalendarClock,
  CheckCircle2,
  FileText,
  History,
  Pencil,
  Plus,
  RefreshCw,
  Scale,
  Search,
  Send,
  ShieldAlert,
  Tags,
  XCircle,
} from "lucide-react";
import { api, ApiError, json, query } from "../api";
import { dateTimeLocalInput, formatDateTime, toIso } from "../format";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Loading,
  Modal,
  Notice,
  PageHeader,
  Segmented,
  Select,
  Textarea,
  cn,
  useToast,
} from "../components/ui";
import type { BadgeTone } from "../components/ui";
import type { Category, ClassItem, GradeItem, PageProps, RuleSummary, RuleVersion } from "../types";

type TabKey = "rules" | "categories";
type Direction = "ADD" | "DEDUCT";
type TargetScope = "ALL" | "GRADE" | "CLASS";

interface RuleDetailResponse {
  rule: RuleSummary;
  versions: RuleVersion[];
  scopes: {
    grades: Array<{ id: string; name: string }>;
    classes: Array<{ id: string; name: string; gradeId: string; gradeName: string }>;
  };
}

interface RuleFormState {
  id: string;
  categoryId: string;
  name: string;
  direction: Direction;
  points: string;
  minPoints: string;
  maxPoints: string;
  targetScope: TargetScope;
  scopeIds: string[];
  evidenceRequired: boolean;
  requiresReview: boolean;
  description: string;
  examples: string;
  changeNote: string;
  effectiveFrom: string;
  effectiveTo: string;
}

interface CategoryFormState {
  id: string;
  name: string;
  description: string;
  directionScope: "BOTH" | "ADD" | "DEDUCT";
  sortOrder: string;
  isEnabled: boolean;
}

interface PendingConfirm {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  run: () => Promise<void>;
}

const RULE_STATUS_TONE: Record<string, BadgeTone> = {
  DRAFT: "neutral",
  SUBMITTED: "warning",
  APPROVED: "info",
  PUBLISHED: "success",
  REJECTED: "danger",
  ARCHIVED: "neutral",
};

const RULE_STATUS_OPTIONS = [
  { value: "DRAFT", label: "草稿" },
  { value: "SUBMITTED", label: "待审核" },
  { value: "APPROVED", label: "已审核" },
  { value: "PUBLISHED", label: "已发布" },
  { value: "REJECTED", label: "已驳回" },
  { value: "ARCHIVED", label: "已归档" },
];

const TARGET_SCOPE_LABELS: Record<TargetScope, string> = {
  ALL: "全校所有年级班级",
  GRADE: "指定年级",
  CLASS: "指定班级",
};

const DIRECTION_SCOPE_LABELS: Record<string, string> = {
  BOTH: "加分 / 减分均可",
  ADD: "仅加分",
  DEDUCT: "仅减分",
};

/** 把接口错误转换为统一中文提示。 */
function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录状态已失效，请重新登录后再试。";
    if (error.status === 403) return "当前账号无权执行该操作。";
    if (error.status === 404) return "评分规则不存在或已被归档。";
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return "网络异常或服务器错误，请稍后重试。";
}

function emptyRuleForm(categoryId = ""): RuleFormState {
  return {
    id: "",
    categoryId,
    name: "",
    direction: "ADD",
    points: "1",
    minPoints: "",
    maxPoints: "",
    targetScope: "ALL",
    scopeIds: [],
    evidenceRequired: false,
    requiresReview: false,
    description: "",
    examples: "",
    changeNote: "",
    effectiveFrom: "",
    effectiveTo: "",
  };
}

export function RulesPage({ user, params }: PageProps) {
  const toast = useToast();
  const canCreate = user.permissions.createRules;
  const canApprove = user.permissions.approveRules;
  const isSysAdmin = user.role === "SYSTEM_ADMIN";
  const isTeacher = user.role === "DUTY_TEACHER";

  const [tab, setTab] = useState<TabKey>("rules");

  // 元数据
  const [categories, setCategories] = useState<Category[]>([]);
  const [grades, setGrades] = useState<GradeItem[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState("");

  // 规则列表
  const [statusFilter, setStatusFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [directionFilter, setDirectionFilter] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [rules, setRules] = useState<RuleSummary[]>([]);
  const [rulesLoading, setRulesLoading] = useState(true);
  const [rulesError, setRulesError] = useState("");

  // 规则详情
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RuleDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  // 规则表单
  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [ruleForm, setRuleForm] = useState<RuleFormState>(emptyRuleForm());
  const [ruleFormError, setRuleFormError] = useState("");
  const [ruleSaving, setRuleSaving] = useState(false);

  // 分类表单
  const [categoryFormOpen, setCategoryFormOpen] = useState(false);
  const [categoryForm, setCategoryForm] = useState<CategoryFormState>({
    id: "",
    name: "",
    description: "",
    directionScope: "BOTH",
    sortOrder: "",
    isEnabled: true,
  });
  const [categoryFormError, setCategoryFormError] = useState("");
  const [categorySaving, setCategorySaving] = useState(false);

  // 发布 / 驳回 / 通用确认
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishFrom, setPublishFrom] = useState("");
  const [publishTo, setPublishTo] = useState("");
  const [publishNote, setPublishNote] = useState("");
  const [publishError, setPublishError] = useState("");
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);

  const loadMeta = useCallback(async () => {
    setMetaLoading(true);
    setMetaError("");
    try {
      const [categoryData, gradeData, classData] = await Promise.all([
        api<{ items: Category[] }>("/categories"),
        api<{ items: GradeItem[] }>("/grades"),
        api<{ items: ClassItem[] }>("/classes"),
      ]);
      setCategories(categoryData.items ?? []);
      setGrades(gradeData.items ?? []);
      setClasses(classData.items ?? []);
    } catch (error) {
      setMetaError(errorMessage(error));
    } finally {
      setMetaLoading(false);
    }
  }, []);

  const loadRules = useCallback(async () => {
    setRulesLoading(true);
    setRulesError("");
    try {
      const data = await api<{ items: RuleSummary[] }>(
        `/rules${query({
          status: statusFilter,
          categoryId: categoryFilter,
          direction: directionFilter,
          search: debouncedSearch,
        })}`,
      );
      setRules(data.items ?? []);
    } catch (error) {
      setRules([]);
      setRulesError(errorMessage(error));
    } finally {
      setRulesLoading(false);
    }
  }, [statusFilter, categoryFilter, directionFilter, debouncedSearch]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const loadDetail = useCallback(async (ruleId: string) => {
    setDetailLoading(true);
    setDetailError("");
    try {
      const data = await api<RuleDetailResponse>(`/rules/${ruleId}`);
      setDetail(data);
    } catch (error) {
      setDetail(null);
      setDetailError(errorMessage(error));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const openDetail = useCallback(
    (ruleId: string) => {
      setDetailId(ruleId);
      setDetail(null);
      void loadDetail(ruleId);
    },
    [loadDetail],
  );

  const initialRuleId = params.ruleId || "";
  useEffect(() => {
    if (initialRuleId) openDetail(initialRuleId);
    // 仅在首次挂载时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --------------------------------------------------------------- 辅助展示 */
  const gradeNameMap = useMemo(() => new Map(grades.map((item) => [item.id, item.name])), [grades]);
  const classNameMap = useMemo(
    () => new Map(classes.map((item) => [item.id, `${item.gradeName}${item.name}`])),
    [classes],
  );

  function scopeSummary(rule: RuleSummary, scopes?: RuleDetailResponse["scopes"]): string {
    if (rule.targetScope === "ALL") return "全校";
    const ids = rule.scopeIds ?? [];
    if (!ids.length) return "未设置范围";
    if (!scopes) return `${rule.targetScope === "GRADE" ? "指定年级" : "指定班级"}（${ids.length} 项）`;
    const names = ids
      .map((id) =>
        rule.targetScope === "GRADE"
          ? scopes.grades.find((grade) => grade.id === id)?.name
          : scopes.classes.find((klass) => klass.id === id)?.gradeName
            ? `${scopes.classes.find((klass) => klass.id === id)?.gradeName ?? ""}${scopes.classes.find((klass) => klass.id === id)?.name ?? ""}`
            : undefined,
      )
      .filter(Boolean);
    return names.length ? names.join("、") : `${ids.length} 项`;
  }

  function scopeSummaryForForm(form: RuleFormState): string {
    if (form.targetScope === "GRADE") {
      const names = form.scopeIds.filter(Boolean).map((id) => gradeNameMap.get(id) ?? id);
      return names.length ? names.join("、") : "未选择";
    }
    if (form.targetScope === "CLASS") {
      const names = form.scopeIds.filter(Boolean).map((id) => classNameMap.get(id) ?? id);
      return names.length ? names.join("、") : "未选择";
    }
    return "全校";
  }

  /* --------------------------------------------------------------- 规则表单 */
  function openRuleCreate() {
    setRuleForm(emptyRuleForm(categories[0]?.id ?? ""));
    setRuleFormError("");
    setRuleFormOpen(true);
  }

  function openRuleEdit(rule: RuleSummary) {
    setRuleForm({
      id: rule.id,
      categoryId: rule.categoryId,
      name: rule.name,
      direction: rule.direction,
      points: String(rule.points),
      minPoints: rule.minPoints === null || rule.minPoints === undefined ? "" : String(rule.minPoints),
      maxPoints: rule.maxPoints === null || rule.maxPoints === undefined ? "" : String(rule.maxPoints),
      targetScope: rule.targetScope,
      scopeIds: rule.scopeIds ?? [],
      evidenceRequired: Boolean(rule.evidenceRequired),
      requiresReview: Boolean(rule.requiresReview),
      description: rule.description || "",
      examples: rule.examples || "",
      changeNote: rule.changeNote || "",
      effectiveFrom: rule.effectiveFrom ? dateTimeLocalInput(rule.effectiveFrom) : "",
      effectiveTo: rule.effectiveTo ? dateTimeLocalInput(rule.effectiveTo) : "",
    });
    setRuleFormError("");
    setRuleFormOpen(true);
  }

  function toggleScopeId(scopeId: string) {
    setRuleForm((current) => ({
      ...current,
      scopeIds: current.scopeIds.includes(scopeId)
        ? current.scopeIds.filter((id) => id !== scopeId)
        : [...current.scopeIds, scopeId],
    }));
  }

  async function submitRuleForm() {
    const name = ruleForm.name.trim();
    if (!ruleForm.categoryId) return setRuleFormError("请选择指标分类");
    if (name.length < 2) return setRuleFormError("规则名称至少需要 2 个字符");
    if (name.length > 80) return setRuleFormError("规则名称不能超过 80 个字符");
    const points = Number(ruleForm.points);
    if (!Number.isSafeInteger(points) || points < 1 || points > 1000)
      return setRuleFormError("分值必须为 1 到 1000 之间的整数");
    const minPoints = ruleForm.minPoints.trim() === "" ? null : Number(ruleForm.minPoints);
    const maxPoints = ruleForm.maxPoints.trim() === "" ? null : Number(ruleForm.maxPoints);
    if (minPoints !== null && (!Number.isSafeInteger(minPoints) || minPoints < 1 || minPoints > 1000))
      return setRuleFormError("单次分值下限必须为 1 到 1000 之间的整数");
    if (maxPoints !== null && (!Number.isSafeInteger(maxPoints) || maxPoints < 1 || maxPoints > 1000))
      return setRuleFormError("单次分值上限必须为 1 到 1000 之间的整数");
    if (minPoints !== null && maxPoints !== null && minPoints > maxPoints)
      return setRuleFormError("单次分值下限不能大于上限");
    if (minPoints !== null && points < minPoints) return setRuleFormError("规则分值不能小于单次分值下限");
    if (maxPoints !== null && points > maxPoints) return setRuleFormError("规则分值不能大于单次分值上限");
    if (ruleForm.targetScope !== "ALL" && ruleForm.scopeIds.length === 0)
      return setRuleFormError(
        ruleForm.targetScope === "GRADE" ? "请选择适用范围的具体年级" : "请选择适用范围的具体班级",
      );
    if (ruleForm.effectiveFrom && ruleForm.effectiveTo && ruleForm.effectiveTo <= ruleForm.effectiveFrom)
      return setRuleFormError("失效时间必须晚于生效时间");

    setRuleFormError("");
    setRuleSaving(true);
    try {
      const body: Record<string, unknown> = {
        categoryId: ruleForm.categoryId,
        name,
        direction: ruleForm.direction,
        points,
        minPoints,
        maxPoints,
        targetScope: ruleForm.targetScope,
        scopeIds: ruleForm.targetScope === "ALL" ? [] : ruleForm.scopeIds,
        evidenceRequired: ruleForm.evidenceRequired,
        requiresReview: ruleForm.requiresReview,
        description: ruleForm.description.trim(),
        examples: ruleForm.examples.trim(),
        changeNote: ruleForm.changeNote.trim(),
        effectiveFrom: ruleForm.effectiveFrom ? toIso(ruleForm.effectiveFrom) : "",
        effectiveTo: ruleForm.effectiveTo ? toIso(ruleForm.effectiveTo) : "",
      };
      if (ruleForm.id) {
        const data = await api<{ rule: RuleSummary }>(`/rules/${ruleForm.id}`, json("PATCH", body));
        toast("规则已保存；已发布规则会自动生成新草稿版本", "success");
        setRuleFormOpen(false);
        await loadRules();
        if (data.rule?.id) {
          if (detailId === data.rule.id) await loadDetail(data.rule.id);
          else openDetail(data.rule.id);
        }
      } else {
        const data = await api<{ rule: RuleSummary }>("/rules", json("POST", body));
        toast("评分规则草稿已创建，可继续编辑后提交审核", "success");
        setRuleFormOpen(false);
        await loadRules();
        if (data.rule?.id) openDetail(data.rule.id);
      }
    } catch (error) {
      setRuleFormError(errorMessage(error));
    } finally {
      setRuleSaving(false);
    }
  }

  /* --------------------------------------------------------------- 规则工作流 */
  async function runRuleAction(action: string, body: Record<string, unknown>, successMessage: string) {
    if (!detail) return;
    setActionLoading(true);
    try {
      await api(`/rules/${detail.rule.id}/${action}`, json("POST", body));
      toast(successMessage, "success");
      await loadRules();
      await loadDetail(detail.rule.id);
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setActionLoading(false);
      setPendingConfirm(null);
    }
  }

  function confirmSubmit() {
    setPendingConfirm({
      title: "提交规则审核？",
      description: "提交后规则进入待审核状态，等待德育处审核；审核通过后还需要德育处发布才会生效。",
      confirmLabel: "提交审核",
      run: () => runRuleAction("submit", {}, "已提交审核，等待德育处处理"),
    });
  }

  function confirmApprove() {
    setPendingConfirm({
      title: "审核通过该规则？",
      description: "审核通过仅表示内容通过审核，不会立即生效；需要德育处填写生效日期后发布，才会用于记分。",
      confirmLabel: "审核通过",
      run: () => runRuleAction("approve", {}, "审核通过，等待发布"),
    });
  }

  function confirmArchive() {
    setPendingConfirm({
      title: "归档该规则？",
      description: "归档后该规则不再可用于记分；历史积分记录与规则快照不受影响。",
      confirmLabel: "确认归档",
      danger: true,
      run: () => runRuleAction("archive", {}, "规则已归档"),
    });
  }

  function openPublish() {
    if (!detail) return;
    setPublishFrom(dateTimeLocalInput());
    setPublishTo(detail.rule.effectiveTo ? dateTimeLocalInput(detail.rule.effectiveTo) : "");
    setPublishNote(detail.rule.changeNote || "");
    setPublishError("");
    setPublishOpen(true);
  }

  function reviewPublish() {
    if (!publishFrom) {
      setPublishError("请填写生效时间");
      return;
    }
    if (publishTo && publishTo <= publishFrom) {
      setPublishError("失效时间必须晚于生效时间");
      return;
    }
    setPublishError("");
    setPublishConfirmOpen(true);
  }

  async function executePublish() {
    if (!detail) return;
    setPublishConfirmOpen(false);
    setPublishOpen(false);
    setActionLoading(true);
    try {
      await api(
        `/rules/${detail.rule.id}/publish`,
        json("POST", {
          effectiveFrom: toIso(publishFrom),
          effectiveTo: publishTo ? toIso(publishTo) : "",
          note: publishNote.trim() || undefined,
        }),
      );
      toast("规则已发布；旧的已发布版本已自动归档", "success");
      await loadRules();
      await loadDetail(detail.rule.id);
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setActionLoading(false);
    }
  }

  async function executeReject() {
    if (!detail) return;
    if (rejectReason.trim().length < 2) {
      setRejectError("请填写驳回理由（至少 2 个字符）");
      return;
    }
    setRejectError("");
    setActionLoading(true);
    try {
      await api(`/rules/${detail.rule.id}/reject`, json("POST", { reason: rejectReason.trim() }));
      toast("规则已驳回，创建人可修改后重新提交", "success");
      setRejectOpen(false);
      setRejectReason("");
      await loadRules();
      await loadDetail(detail.rule.id);
    } catch (error) {
      setRejectError(errorMessage(error));
    } finally {
      setActionLoading(false);
    }
  }

  /* --------------------------------------------------------------- 分类表单 */
  function openCategoryCreate() {
    setCategoryForm({
      id: "",
      name: "",
      description: "",
      directionScope: "BOTH",
      sortOrder: String((categories.at(-1)?.sortOrder ?? 0) + 1),
      isEnabled: true,
    });
    setCategoryFormError("");
    setCategoryFormOpen(true);
  }

  function openCategoryEdit(category: Category) {
    setCategoryForm({
      id: category.id,
      name: category.name,
      description: category.description || "",
      directionScope: category.directionScope || "BOTH",
      sortOrder: String(category.sortOrder ?? ""),
      isEnabled: Boolean(category.isEnabled),
    });
    setCategoryFormError("");
    setCategoryFormOpen(true);
  }

  async function submitCategoryForm() {
    const name = categoryForm.name.trim();
    if (!name) return setCategoryFormError("请填写分类名称");
    if (name.length > 40) return setCategoryFormError("分类名称不能超过 40 个字符");
    setCategoryFormError("");
    setCategorySaving(true);
    try {
      const body: Record<string, unknown> = {
        name,
        description: categoryForm.description.trim(),
        directionScope: categoryForm.directionScope,
        isEnabled: categoryForm.isEnabled,
      };
      if (categoryForm.sortOrder.trim()) body.sortOrder = Number(categoryForm.sortOrder);
      if (categoryForm.id) await api(`/categories/${categoryForm.id}`, json("PATCH", body));
      else await api("/categories", json("POST", body));
      toast(categoryForm.id ? "分类已更新" : "分类已创建", "success");
      setCategoryFormOpen(false);
      await loadMeta();
      await loadRules();
    } catch (error) {
      setCategoryFormError(errorMessage(error));
    } finally {
      setCategorySaving(false);
    }
  }

  /* --------------------------------------------------------------- 渲染 */
  const detailRule = detail?.rule;
  const canEditDetail =
    canCreate &&
    detailRule !== undefined &&
    ["DRAFT", "REJECTED", "SUBMITTED", "APPROVED", "PUBLISHED", "ARCHIVED"].includes(detailRule.status);

  const pendingCount = rules.filter((item) => item.status === "SUBMITTED").length;

  return (
    <div className="page">
      <PageHeader
        title="评分规则"
        description={
          isTeacher
            ? "仅展示当前已发布、可用于记分的规则版本。"
            : "指标分类与规则版本管理：草稿→审核→发布，发布后按生效时间用于记分。"
        }
        actions={
          <div className="toolbar">
            {canCreate && tab === "rules" && (
              <Button icon={<Plus size={16} />} onClick={openRuleCreate}>
                新建规则
              </Button>
            )}
          </div>
        }
      />

      <div className="stack">
        <div className="toolbar between">
          <Segmented<TabKey>
            value={tab}
            ariaLabel="规则视图"
            options={[
              { value: "rules", label: "规则列表", count: rules.length },
              { value: "categories", label: "指标分类", count: categories.length },
            ]}
            onChange={setTab}
          />
          <div className="toolbar">
            {isSysAdmin && (
              <Badge tone="info">系统管理员：可创建/提交规则，审核与发布需德育处完成</Badge>
            )}
            {isTeacher && <Badge tone="neutral">值日老师：只读已发布规则</Badge>}
          </div>
        </div>

        {metaError && (
          <Alert tone="danger" title="基础资料加载失败" onRetry={() => void loadMeta()}>
            {metaError}
          </Alert>
        )}

        {tab === "rules" && (
          <>
            {pendingCount > 0 && canApprove && (
              <Notice tone="warning">
                有 {pendingCount} 条规则版本等待审核。审核通过后需填写生效日期并发布才会用于记分。
              </Notice>
            )}

            <Card padded={false}>
              <div className="toolbar filters" style={{ padding: "12px 14px" }}>
                {canCreate && (
                  <Select
                    aria-label="按状态筛选"
                    style={{ flex: "1 1 140px", minWidth: 0 }}
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value)}
                  >
                    <option value="">全部状态</option>
                    {RULE_STATUS_OPTIONS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </Select>
                )}
                <Select
                  aria-label="按分类筛选"
                  style={{ flex: "1 1 140px", minWidth: 0 }}
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
                <Select
                  aria-label="按方向筛选"
                  style={{ flex: "1 1 140px", minWidth: 0 }}
                  value={directionFilter}
                  onChange={(event) => setDirectionFilter(event.target.value)}
                >
                  <option value="">加减分不限</option>
                  <option value="ADD">加分</option>
                  <option value="DEDUCT">减分</option>
                </Select>
                <div className="search-box">
                  <Search size={16} />
                  <Input
                    aria-label="搜索规则"
                    placeholder="搜索规则名称 / 说明"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void loadRules()}>
                  刷新
                </Button>
              </div>

              {rulesError ? (
                <div style={{ padding: 14 }}>
                  <Alert tone="danger" title="规则列表加载失败" onRetry={() => void loadRules()}>
                    {rulesError}
                  </Alert>
                </div>
              ) : rulesLoading ? (
                <Loading label="正在加载评分规则…" />
              ) : rules.length === 0 ? (
                <EmptyState
                  title={isTeacher ? "当前没有已发布的规则" : "还没有评分规则"}
                  description={
                    isTeacher
                      ? "请联系德育处发布评分规则后再进行记分。"
                      : "新建规则草稿，填写指标分类、分值、适用范围，提交德育处审核后发布。"
                  }
                  icon={<Scale size={22} />}
                  action={
                    canCreate ? (
                      <Button size="sm" icon={<Plus size={15} />} onClick={openRuleCreate}>
                        新建规则
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>规则名称</th>
                        <th>指标分类</th>
                        <th>方向 / 分值</th>
                        <th>适用范围</th>
                        <th>状态</th>
                        <th>版本</th>
                        <th>生效时间</th>
                        <th>最近更新</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rules.map((rule) => (
                        <tr key={rule.id}>
                          <td>
                            <button
                              type="button"
                              className="link"
                              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "left" }}
                              onClick={() => openDetail(rule.id)}
                            >
                              {rule.name}
                            </button>
                            {rule.evidenceRequired && (
                              <Badge tone="neutral">
                                需证据
                              </Badge>
                            )}
                            {rule.requiresReview && (
                              <Badge tone="warning">
                                需复核
                              </Badge>
                            )}
                          </td>
                          <td>{rule.categoryName || "—"}</td>
                          <td>
                            <Badge tone={rule.direction === "ADD" ? "add" : "deduct"}>
                              {rule.direction === "ADD" ? "加分" : "减分"}
                            </Badge>{" "}
                            <strong className="amount">{rule.points}</strong>
                            <span className="muted text-xs"> 分</span>
                            {(rule.minPoints !== null || rule.maxPoints !== null) && (
                              <div className="muted text-xs">
                                单次 {rule.minPoints ?? "?"}–{rule.maxPoints ?? "?"} 分
                              </div>
                            )}
                          </td>
                          <td>
                            <div>{TARGET_SCOPE_LABELS[rule.targetScope] || rule.targetScope}</div>
                            <div className="muted text-xs">{scopeSummary(rule)}</div>
                          </td>
                          <td>
                            <Badge tone={RULE_STATUS_TONE[rule.status] || "neutral"}>
                              {rule.statusLabel || rule.status}
                            </Badge>
                          </td>
                          <td className="mono">v{rule.version}</td>
                          <td>{rule.effectiveFrom ? formatDateTime(rule.effectiveFrom) : <span className="muted">未发布</span>}</td>
                          <td>{formatDateTime(rule.updatedAt)}</td>
                          <td>
                            <Button size="sm" variant="ghost" icon={<FileText size={13} />} onClick={() => openDetail(rule.id)}>
                              详情
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}

        {tab === "categories" && (
          <Card
            title="指标分类"
            subtitle={
              isSysAdmin
                ? "分类用于规则分组与统计口径；停用分类不影响历史记录。"
                : "指标分类由系统管理员维护，德育处只读。"
            }
            actions={
              isSysAdmin ? (
                <Button size="sm" icon={<Plus size={14} />} onClick={openCategoryCreate}>
                  新建分类
                </Button>
              ) : undefined
            }
            padded={false}
          >
            {metaLoading ? (
              <Loading label="正在加载指标分类…" />
            ) : categories.length === 0 ? (
              <EmptyState
                title="还没有指标分类"
                description="先创建分类（如 纪律规范、学业表现、志愿服务），再创建评分规则。"
                icon={<Tags size={22} />}
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>分类名称</th>
                      <th>说明</th>
                      <th>方向范围</th>
                      <th>排序</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categories.map((category) => (
                      <tr key={category.id}>
                        <td className="cell-strong">{category.name}</td>
                        <td>
                          <span className="truncate" style={{ display: "inline-block", maxWidth: 280 }}>
                            {category.description || "—"}
                          </span>
                        </td>
                        <td>{DIRECTION_SCOPE_LABELS[category.directionScope] || category.directionScope}</td>
                        <td>{category.sortOrder}</td>
                        <td>
                          <Badge tone={category.isEnabled ? "success" : "neutral"}>
                            {category.isEnabled ? "启用" : "已停用"}
                          </Badge>
                        </td>
                        <td>
                          {isSysAdmin ? (
                            <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => openCategoryEdit(category)}>
                              编辑
                            </Button>
                          ) : (
                            <span className="muted text-xs">只读</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>

      {/* ------------------------------------------------------------ 规则详情 */}
      <Modal
        open={detailId !== null}
        onClose={() => {
          setDetailId(null);
          setDetail(null);
          setDetailError("");
        }}
        title={detailRule ? detailRule.name : "规则详情"}
        description={
          detailRule
            ? `v${detailRule.version} · ${detailRule.statusLabel || detailRule.status} · ${detailRule.categoryName || "未分类"}`
            : undefined
        }
        size="lg"
        footer={
          <div className="modal-actions">
            <Button
              variant="secondary"
              onClick={() => {
                setDetailId(null);
                setDetail(null);
              }}
            >
              关闭
            </Button>
            {detailRule && (
              <>
                {canEditDetail && (
                  <Button variant="secondary" icon={<Pencil size={15} />} onClick={() => openRuleEdit(detailRule)}>
                    {detailRule.status === "PUBLISHED" ? "编辑（生成新版本）" : "编辑"}
                  </Button>
                )}
                {canCreate && (detailRule.status === "DRAFT" || detailRule.status === "REJECTED") && (
                  <Button icon={<Send size={15} />} onClick={confirmSubmit}>
                    提交审核
                  </Button>
                )}
                {canApprove && detailRule.status === "SUBMITTED" && (
                  <>
                    <Button variant="danger" icon={<XCircle size={15} />} onClick={() => setRejectOpen(true)}>
                      驳回
                    </Button>
                    <Button icon={<CheckCircle2 size={15} />} onClick={confirmApprove}>
                      审核通过
                    </Button>
                  </>
                )}
                {canApprove && detailRule.status === "APPROVED" && (
                  <>
                    <Button variant="danger" icon={<XCircle size={15} />} onClick={() => setRejectOpen(true)}>
                      驳回
                    </Button>
                    <Button icon={<CalendarClock size={15} />} onClick={openPublish}>
                      发布规则
                    </Button>
                  </>
                )}
                {canApprove && detailRule.status === "PUBLISHED" && (
                  <Button variant="danger" icon={<Archive size={15} />} onClick={confirmArchive}>
                    归档
                  </Button>
                )}
                {isSysAdmin && detailRule.status === "APPROVED" && (
                  <Button variant="secondary" disabled icon={<CalendarClock size={15} />}>
                    发布（需德育处）
                  </Button>
                )}
              </>
            )}
          </div>
        }
      >
        {detailLoading ? (
          <Loading label="正在加载规则详情…" />
        ) : detailError ? (
          <Alert tone="danger" title="规则详情加载失败" onRetry={() => detailId && void loadDetail(detailId)}>
            {detailError}
          </Alert>
        ) : detail && detailRule ? (
          <div className="stack">
            {isSysAdmin && (detailRule.status === "SUBMITTED" || detailRule.status === "APPROVED") && (
              <Notice tone="warning">
                <ShieldAlert size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                系统管理员不能审核或发布规则：审核与发布必须由德育处完成，管理员不可绕过审核流程。当前版本
                {detailRule.status === "SUBMITTED" ? "待德育处审核" : "已通过审核，等待德育处填写生效日期后发布"}。
              </Notice>
            )}
            {isTeacher && <Notice tone="info">值日老师仅能查看已发布规则，不能创建、修改或发布规则。</Notice>}

            <div className="kv">
              <dt>指标分类</dt>
              <dd>{detailRule.categoryName || "—"}</dd>
              <dt>加减分方向</dt>
              <dd>
                <Badge tone={detailRule.direction === "ADD" ? "add" : "deduct"}>
                  {detailRule.direction === "ADD" ? "加分" : "减分"}
                </Badge>
              </dd>
              <dt>分值</dt>
              <dd>
                <strong className="amount">{detailRule.points}</strong> 分
                {detailRule.minPoints !== null && detailRule.minPoints !== undefined && (
                  <span className="muted text-xs"> · 单次下限 {detailRule.minPoints} 分</span>
                )}
                {detailRule.maxPoints !== null && detailRule.maxPoints !== undefined && (
                  <span className="muted text-xs"> · 单次上限 {detailRule.maxPoints} 分</span>
                )}
              </dd>
              <dt>适用范围</dt>
              <dd>
                {TARGET_SCOPE_LABELS[detailRule.targetScope] || detailRule.targetScope}
                <div className="muted text-xs" style={{ marginTop: 2 }}>
                  {scopeSummary(detailRule, detail.scopes)}
                </div>
              </dd>
              <dt>证据要求</dt>
              <dd>{detailRule.evidenceRequired ? "记分时必须上传证据附件" : "无需强制上传证据"}</dd>
              <dt>复核要求</dt>
              <dd>{detailRule.requiresReview ? "录入后进入待复核，由德育处/管理员确认后生效" : "按默认阈值判断是否需要复核"}</dd>
              <dt>生效时间</dt>
              <dd>{detailRule.effectiveFrom ? formatDateTime(detailRule.effectiveFrom) : "尚未设置（需发布时填写）"}</dd>
              <dt>失效时间</dt>
              <dd>{detailRule.effectiveTo ? formatDateTime(detailRule.effectiveTo) : "长期有效"}</dd>
              <dt>版本</dt>
              <dd>
                v{detailRule.version}
                {detailRule.publishedAt && (
                  <span className="muted text-xs"> · 发布于 {formatDateTime(detailRule.publishedAt)}</span>
                )}
              </dd>
            </div>

            {detailRule.description && (
              <div>
                <div className="report-section-title">规则说明</div>
                <p className="text-sm" style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.7 }}>
                  {detailRule.description}
                </p>
              </div>
            )}

            {detailRule.examples && (
              <div>
                <div className="report-section-title">适用示例</div>
                <p className="text-sm" style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.7 }}>
                  {detailRule.examples}
                </p>
              </div>
            )}

            <div>
              <div className="report-section-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <History size={14} />
                版本历史与变更说明
              </div>
              {detail.versions.length === 0 ? (
                <EmptyState compact title="暂无版本记录" />
              ) : (
                <div className="timeline">
                  {detail.versions.map((version) => (
                    <div
                      className={cn("timeline-item", version.version !== detailRule.version && "is-muted")}
                      key={version.id}
                    >
                      <div className="timeline-dot" />
                      <div className="timeline-title">
                        v{version.version} · {version.statusLabel || version.status}
                        {version.version === detailRule.version && (
                          <Badge tone="brand">
                            当前
                          </Badge>
                        )}
                      </div>
                      <div className="timeline-meta">
                        创建 {formatDateTime(version.createdAt)}
                        {version.publishedAt ? ` · 发布 ${formatDateTime(version.publishedAt)}` : ""}
                        {version.effectiveFrom ? ` · 生效 ${formatDateTime(version.effectiveFrom)}` : ""}
                        {version.effectiveTo ? ` · 失效 ${formatDateTime(version.effectiveTo)}` : ""}
                      </div>
                      <div className="timeline-body">
                        {version.changeNote || <span className="muted">无变更说明</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ------------------------------------------------------------ 规则表单 */}
      <Modal
        open={ruleFormOpen}
        onClose={() => setRuleFormOpen(false)}
        title={ruleForm.id ? "编辑评分规则" : "新建评分规则"}
        description={
          ruleForm.id && detailRule?.status === "PUBLISHED"
            ? "已发布规则的修改会生成 v+1 的新草稿版本，旧版本继续生效直到新版本发布。"
            : "保存后为草稿状态；提交德育处审核通过并发布后才会用于记分。"
        }
        size="lg"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setRuleFormOpen(false)} disabled={ruleSaving}>
              取消
            </Button>
            <Button loading={ruleSaving} onClick={() => void submitRuleForm()}>
              {ruleForm.id ? "保存规则" : "创建草稿"}
            </Button>
          </div>
        }
      >
        <div className="form-grid cols-2">
          <Field label="指标分类" required>
            <Select
              value={ruleForm.categoryId}
              onChange={(event) => setRuleForm({ ...ruleForm, categoryId: event.target.value })}
            >
              <option value="">请选择分类</option>
              {categories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="规则名称" required hint="2–80 个字符，面向师生展示">
            <Input
              value={ruleForm.name}
              maxLength={80}
              onChange={(event) => setRuleForm({ ...ruleForm, name: event.target.value })}
              placeholder="如 主动帮助同学"
            />
          </Field>
          <Field label="加减分方向" required>
            <Select
              value={ruleForm.direction}
              onChange={(event) => setRuleForm({ ...ruleForm, direction: event.target.value as Direction })}
            >
              <option value="ADD">加分</option>
              <option value="DEDUCT">减分</option>
            </Select>
          </Field>
          <Field label="分值（分）" required hint="1–1000 的整数">
            <Input
              type="number"
              min={1}
              max={1000}
              value={ruleForm.points}
              onChange={(event) => setRuleForm({ ...ruleForm, points: event.target.value })}
            />
          </Field>
          <Field label="单次分值下限（可选）" hint="留空则不限；用于可调整幅度的规则">
            <Input
              type="number"
              min={1}
              max={1000}
              value={ruleForm.minPoints}
              onChange={(event) => setRuleForm({ ...ruleForm, minPoints: event.target.value })}
            />
          </Field>
          <Field label="单次分值上限（可选）" hint="留空则不限">
            <Input
              type="number"
              min={1}
              max={1000}
              value={ruleForm.maxPoints}
              onChange={(event) => setRuleForm({ ...ruleForm, maxPoints: event.target.value })}
            />
          </Field>
          <Field label="适用范围" required>
            <Select
              value={ruleForm.targetScope}
              onChange={(event) => {
                const next = event.target.value as TargetScope;
                setRuleForm({ ...ruleForm, targetScope: next, scopeIds: next === "ALL" ? [] : ruleForm.scopeIds });
              }}
            >
              <option value="ALL">全校所有年级班级</option>
              <option value="GRADE">指定年级</option>
              <option value="CLASS">指定班级</option>
            </Select>
          </Field>
          <Field label="适用范围明细" hint={scopeSummaryForForm(ruleForm)}>
            {ruleForm.targetScope === "ALL" ? (
              <div className="muted text-sm" style={{ paddingTop: 8 }}>
                全校生效
              </div>
            ) : (
              <div
                className="scroll-x"
                style={{ maxHeight: 160, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10, padding: 8 }}
              >
                {ruleForm.targetScope === "GRADE" ? (
                  grades.length === 0 ? (
                    <span className="muted text-sm">暂无年级数据</span>
                  ) : (
                    <div className="grid cols-2" style={{ gap: 4 }}>
                      {grades.map((grade) => (
                        <Checkbox
                          key={grade.id}
                          label={grade.name}
                          checked={ruleForm.scopeIds.includes(grade.id)}
                          onChange={() => toggleScopeId(grade.id)}
                        />
                      ))}
                    </div>
                  )
                ) : classes.length === 0 ? (
                  <span className="muted text-sm">暂无班级数据</span>
                ) : (
                  <div className="grid cols-2" style={{ gap: 4 }}>
                    {classes.map((klass) => (
                      <Checkbox
                        key={klass.id}
                        label={`${klass.gradeName}${klass.name}`}
                        checked={ruleForm.scopeIds.includes(klass.id)}
                        onChange={() => toggleScopeId(klass.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </Field>
          <Field label="生效时间（可选）" hint="发布时会再次确认；留空则在发布时填写">
            <Input
              type="datetime-local"
              value={ruleForm.effectiveFrom}
              onChange={(event) => setRuleForm({ ...ruleForm, effectiveFrom: event.target.value })}
            />
          </Field>
          <Field label="失效时间（可选）" hint="留空表示长期有效">
            <Input
              type="datetime-local"
              value={ruleForm.effectiveTo}
              onChange={(event) => setRuleForm({ ...ruleForm, effectiveTo: event.target.value })}
            />
          </Field>
          <div className="span-2">
            <Field label="证据与复核">
              <div className="toolbar" style={{ gap: 18 }}>
                <Checkbox
                  label="记分时必须上传证据"
                  checked={ruleForm.evidenceRequired}
                  onChange={(event) => setRuleForm({ ...ruleForm, evidenceRequired: event.target.checked })}
                />
                <Checkbox
                  label="录入后需复核才生效"
                  checked={ruleForm.requiresReview}
                  onChange={(event) => setRuleForm({ ...ruleForm, requiresReview: event.target.checked })}
                />
              </div>
            </Field>
          </div>
          <div className="span-2">
            <Field label="规则说明" hint="面向师生的解释，建议说明判断标准，避免模糊表述">
              <Textarea
                rows={3}
                maxLength={1000}
                value={ruleForm.description}
                onChange={(event) => setRuleForm({ ...ruleForm, description: event.target.value })}
                placeholder="如：主动帮助同学解决学习困难，经老师确认后加分。"
              />
            </Field>
          </div>
          <div className="span-2">
            <Field label="适用示例（可选）" hint="可举 1–3 个具体场景，帮助值日老师判断">
              <Textarea
                rows={2}
                maxLength={1000}
                value={ruleForm.examples}
                onChange={(event) => setRuleForm({ ...ruleForm, examples: event.target.value })}
                placeholder="如：课间主动捡起走廊垃圾并分类投放。"
              />
            </Field>
          </div>
          <div className="span-2">
            <Field label="变更说明（可选）" hint="记录在版本历史中，便于追溯本次修改原因">
              <Input
                maxLength={300}
                value={ruleForm.changeNote}
                onChange={(event) => setRuleForm({ ...ruleForm, changeNote: event.target.value })}
                placeholder="如：根据德育处会议调整分值"
              />
            </Field>
          </div>
        </div>
        {ruleFormError && (
          <div className="mt-4">
            <Alert tone="danger">{ruleFormError}</Alert>
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------------------ 分类表单 */}
      <Modal
        open={categoryFormOpen}
        onClose={() => setCategoryFormOpen(false)}
        title={categoryForm.id ? "编辑指标分类" : "新建指标分类"}
        description="分类决定规则的统计分组；方向范围用于限制该分类下的规则是加分还是减分。"
        size="md"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setCategoryFormOpen(false)} disabled={categorySaving}>
              取消
            </Button>
            <Button loading={categorySaving} onClick={() => void submitCategoryForm()}>
              {categoryForm.id ? "保存修改" : "创建分类"}
            </Button>
          </div>
        }
      >
        <div className="stack">
          <Field label="分类名称" required>
            <Input
              value={categoryForm.name}
              maxLength={40}
              onChange={(event) => setCategoryForm({ ...categoryForm, name: event.target.value })}
              placeholder="如 纪律规范、学业表现、志愿服务"
            />
          </Field>
          <Field label="分类说明" hint="可选，说明该分类覆盖的德育维度">
            <Textarea
              rows={2}
              maxLength={500}
              value={categoryForm.description}
              onChange={(event) => setCategoryForm({ ...categoryForm, description: event.target.value })}
            />
          </Field>
          <div className="inline-fields">
            <Field label="方向范围">
              <Select
                value={categoryForm.directionScope}
                onChange={(event) =>
                  setCategoryForm({
                    ...categoryForm,
                    directionScope: event.target.value as CategoryFormState["directionScope"],
                  })
                }
              >
                <option value="BOTH">加分 / 减分均可</option>
                <option value="ADD">仅加分</option>
                <option value="DEDUCT">仅减分</option>
              </Select>
            </Field>
            <Field label="排序号" hint="数字越小越靠前">
              <Input
                type="number"
                min={0}
                max={9999}
                value={categoryForm.sortOrder}
                onChange={(event) => setCategoryForm({ ...categoryForm, sortOrder: event.target.value })}
              />
            </Field>
          </div>
          <Checkbox
            label="启用该分类"
            checked={categoryForm.isEnabled}
            onChange={(event) => setCategoryForm({ ...categoryForm, isEnabled: event.target.checked })}
          />
          {categoryFormError && <Alert tone="danger">{categoryFormError}</Alert>}
        </div>
      </Modal>

      {/* ------------------------------------------------------------ 发布弹窗 */}
      <Modal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        title="发布评分规则"
        description={detailRule ? `即将发布「${detailRule.name}」v${detailRule.version}；发布后立即进入记分选项。` : undefined}
        size="md"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setPublishOpen(false)} disabled={actionLoading}>
              取消
            </Button>
            <Button icon={<CalendarClock size={15} />} onClick={reviewPublish} disabled={actionLoading}>
              下一步：确认发布
            </Button>
          </div>
        }
      >
        <div className="stack">
          <Field label="生效时间" required hint="发布后，从该时间起的新记录可以使用此规则">
            <Input
              type="datetime-local"
              value={publishFrom}
              onChange={(event) => setPublishFrom(event.target.value)}
            />
          </Field>
          <Field label="失效时间（可选）" hint="留空表示长期有效">
            <Input type="datetime-local" value={publishTo} onChange={(event) => setPublishTo(event.target.value)} />
          </Field>
          <Field label="发布说明（可选）" hint="会写入版本变更说明">
            <Input
              maxLength={300}
              value={publishNote}
              onChange={(event) => setPublishNote(event.target.value)}
            />
          </Field>
          {publishError && <Alert tone="danger">{publishError}</Alert>}
          <Notice tone="warning">
            发布后，该规则旧的已发布版本会自动归档；历史积分记录仍按原规则快照展示，不受影响。
          </Notice>
        </div>
      </Modal>

      <ConfirmDialog
        open={publishConfirmOpen}
        title="确认发布该规则？"
        description="发布是高风险操作：规则将立即按生效时间用于全校/指定范围的记分，请再次确认生效时间与适用范围。"
        confirmLabel="确认发布"
        loading={actionLoading}
        onConfirm={() => void executePublish()}
        onClose={() => setPublishConfirmOpen(false)}
      >
        <div className="kv">
          <dt>规则</dt>
          <dd>{detailRule?.name || "—"}</dd>
          <dt>版本</dt>
          <dd>v{detailRule?.version ?? "—"}</dd>
          <dt>生效时间</dt>
          <dd>{publishFrom ? formatDateTime(new Date(publishFrom).toISOString()) : "—"}</dd>
          <dt>适用范围</dt>
          <dd>{detailRule ? `${TARGET_SCOPE_LABELS[detailRule.targetScope] || detailRule.targetScope}（${scopeSummary(detailRule, detail?.scopes)}）` : "—"}</dd>
        </div>
      </ConfirmDialog>

      {/* ------------------------------------------------------------ 驳回弹窗 */}
      <Modal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="驳回规则版本"
        description="驳回理由会记录在版本变更说明中，创建人可修改后重新提交。"
        size="sm"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setRejectOpen(false)} disabled={actionLoading}>
              取消
            </Button>
            <Button variant="danger" loading={actionLoading} onClick={() => void executeReject()}>
              确认驳回
            </Button>
          </div>
        }
      >
        <div className="stack">
          <Field label="驳回理由" required hint="至少 2 个字符，请说明需要修改的内容">
            <Textarea
              rows={3}
              maxLength={300}
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="如：分值偏高，请参考同类规则调整后再提交"
            />
          </Field>
          {rejectError && <Alert tone="danger">{rejectError}</Alert>}
        </div>
      </Modal>

      {/* ------------------------------------------------------------ 通用确认 */}
      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.title || ""}
        description={pendingConfirm?.description}
        confirmLabel={pendingConfirm?.confirmLabel}
        danger={pendingConfirm?.danger}
        loading={actionLoading}
        onConfirm={() => {
          const run = pendingConfirm?.run;
          if (run) void run();
        }}
        onClose={() => {
          if (!actionLoading) setPendingConfirm(null);
        }}
      />

      {/* metaLoading 用于首屏加载提示，避免空列表误判 */}
      {metaLoading && rules.length === 0 && categories.length === 0 && !metaError && (
        <span className="sr-only" role="status">
          正在加载规则基础资料
        </span>
      )}
    </div>
  );
}
