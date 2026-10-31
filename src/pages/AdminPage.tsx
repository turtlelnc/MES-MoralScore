// OWNER: frontend-ops. 系统管理：仅 permissions.manageSystem 可进入。
// 账号与数据范围、系统参数与学年学期、家长分享、荣誉与兑换、审计日志、真实备份任务。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  Copy,
  DatabaseBackup,
  KeyRound,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  ShieldAlert,
  ShieldCheck,
  UserPlus,
  Users,
  XCircle,
} from "lucide-react";
import { api, ApiError, json, query } from "../api";
import { formatBytes, formatDate, formatDateTime, relativeTime } from "../format";
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
  Pagination,
  Segmented,
  Select,
  StatCard,
  Textarea,
  useToast,
} from "../components/ui";
import type {
  AdminUser,
  AuditLogItem,
  BackupItem,
  ClassItem,
  GradeItem,
  HonorRule,
  PageProps,
  Paginated,
  PeriodsData,
  RewardItem,
  Role,
  SchoolInfo,
  SchoolSettings,
  ShareItem,
  TeacherItem,
} from "../types";

type TabKey = "accounts" | "system" | "rewards" | "shares" | "audit" | "backups";


interface SystemResponse {
  settings: SchoolSettings;
  school: SchoolInfo;
  periods: PeriodsData;
  backupDirConfigured: boolean;
}

interface ScopeDraft {
  scopeType: "GRADE" | "CLASS";
  scopeId: string;
}

interface UserFormState {
  id: string;
  account: string;
  displayName: string;
  password: string;
  confirmPassword: string;
  role: Role;
  teacherId: string;
  scopes: ScopeDraft[];
}

interface HonorFormState {
  id: string;
  name: string;
  description: string;
  minPoints: string;
  minPositiveRecords: string;
  sortOrder: string;
  isEnabled: boolean;
}

interface RewardFormState {
  id: string;
  name: string;
  description: string;
  pointsCost: string;
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

interface CreatedShare {
  id: string;
  token: string;
  url: string;
  expiresAt: string;
  label: string;
  studentName: string;
}

interface ShareRow extends ShareItem {
  gradeName?: string;
}

interface StudentOption {
  id: string;
  name: string;
  studentNo: string;
  classId: string;
  className: string;
  gradeId: string;
  gradeName: string;
}

interface YearFormState {
  name: string;
  startDate: string;
  endDate: string;
}

interface TermFormState {
  academicYearId: string;
  name: string;
  startDate: string;
  endDate: string;
}

/** 分享链接：优先使用服务端返回的 url（相对路径补齐 origin），否则按 token 拼接。 */
function buildShareUrl(token: string, url?: string): string {
  const origin = window.location.origin;
  if (url && /^https?:\/\//i.test(url)) return url;
  if (url) return `${origin}${url.startsWith("/") ? "" : "/"}${url}`;
  return `${origin}/#/share/${token}`;
}

const SHARE_STATUS_META: Record<
  string,
  { label: string; tone: "success" | "neutral" | "danger" | "warning" }
> = {
  ACTIVE: { label: "有效", tone: "success" },
  EXPIRED: { label: "已过期", tone: "neutral" },
  REVOKED: { label: "已撤销", tone: "danger" },
};

const ROLE_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: "SYSTEM_ADMIN", label: "系统管理员" },
  { value: "MORAL_AFFAIRS", label: "德育处" },
  { value: "DUTY_TEACHER", label: "值日老师" },
];

const ROLE_TONES: Record<string, "info" | "warning" | "brand"> = {
  SYSTEM_ADMIN: "info",
  MORAL_AFFAIRS: "warning",
  DUTY_TEACHER: "brand",
};

const WEAK_PASSWORDS = new Set([
  "1234567890",
  "123456789a",
  "password123",
  "abc1234567",
  "qwerty12345",
  "admin12345",
  "1111111111",
]);

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录状态已失效，请重新登录后再试。";
    if (error.status === 403) return "当前账号无权执行该操作。";
    if (error.status === 404) return "请求的数据不存在或已被删除。";
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return "网络异常或服务器错误，请稍后重试。";
}

/** 与 server/core.mjs assertPasswordPolicy 保持一致的客户端预校验。 */
function validatePassword(password: string, confirmPassword: string, account: string): string {
  if (password.length < 10) return "密码至少需要 10 个字符";
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return "密码必须同时包含字母和数字";
  if (account && password.toLowerCase().includes(account.toLowerCase())) return "密码不能包含账号名";
  if (WEAK_PASSWORDS.has(password.toLowerCase())) return "该密码过于常见，请更换";
  if (password !== confirmPassword) return "两次输入的密码不一致";
  return "";
}

function scopeSummaryOf(adminUser: AdminUser): string {
  if (adminUser.role !== "DUTY_TEACHER") return "全校";
  if (!adminUser.scopes || adminUser.scopes.length === 0) return "未授权";
  return adminUser.scopes.map((scope) => scope.name || scope.scopeId).join("、");
}

function emptyUserForm(): UserFormState {
  return {
    id: "",
    account: "",
    displayName: "",
    password: "",
    confirmPassword: "",
    role: "DUTY_TEACHER",
    teacherId: "",
    scopes: [],
  };
}

export function AdminPage({ user, onRefreshUser }: PageProps) {
  const toast = useToast();

  if (!user.permissions.manageSystem) {
    return (
      <div className="page">
        <PageHeader title="系统管理" description="账号、数据范围、系统参数、审计与备份。" />
        <Card>
          <EmptyState
            icon={<ShieldAlert size={24} />}
            title="无权访问系统管理"
            description="系统管理仅对系统管理员开放；如确需调整账号或系统参数，请联系学校系统管理员。"
          />
        </Card>
      </div>
    );
  }

  return <AdminConsole user={user} onRefreshUser={onRefreshUser} />;
}

function AdminConsole({ user, onRefreshUser }: { user: PageProps["user"]; onRefreshUser: PageProps["onRefreshUser"] }) {
  const toast = useToast();
  const isSysAdmin = user.role === "SYSTEM_ADMIN";
  const canManageShares = user.permissions.manageShares;

  const [tab, setTab] = useState<TabKey>("accounts");

  // 元数据（年级/班级/教师）
  const [grades, setGrades] = useState<GradeItem[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [teachers, setTeachers] = useState<TeacherItem[]>([]);
  const [metaError, setMetaError] = useState("");

  // 账号
  const [usersData, setUsersData] = useState<Paginated<AdminUser> | null>(null);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [usersPage, setUsersPage] = useState(1);
  const [userFormOpen, setUserFormOpen] = useState(false);
  const [userForm, setUserForm] = useState<UserFormState>(emptyUserForm());
  const [userFormError, setUserFormError] = useState("");
  const [userSaving, setUserSaving] = useState(false);
  const [scopeDraftType, setScopeDraftType] = useState<"GRADE" | "CLASS">("GRADE");
  const [scopeDraftId, setScopeDraftId] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetError, setResetError] = useState("");
  const [resetSaving, setResetSaving] = useState(false);

  // 系统参数
  const [systemData, setSystemData] = useState<SystemResponse | null>(null);
  const [systemLoading, setSystemLoading] = useState(false);
  const [systemError, setSystemError] = useState("");
  const [settingsForm, setSettingsForm] = useState({ initialPoints: "", allowNegative: false, reviewThreshold: "" });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");

  // 荣誉与兑换
  const [honors, setHonors] = useState<HonorRule[]>([]);
  const [rewards, setRewards] = useState<RewardItem[]>([]);
  const [honorsError, setHonorsError] = useState("");
  const [rewardsError, setRewardsError] = useState("");
  const [honorsLoading, setHonorsLoading] = useState(false);
  const [honorFormOpen, setHonorFormOpen] = useState(false);
  const [honorForm, setHonorForm] = useState<HonorFormState>({
    id: "",
    name: "",
    description: "",
    minPoints: "0",
    minPositiveRecords: "0",
    sortOrder: "",
    isEnabled: true,
  });
  const [honorFormError, setHonorFormError] = useState("");
  const [honorSaving, setHonorSaving] = useState(false);
  const [rewardFormOpen, setRewardFormOpen] = useState(false);
  const [rewardForm, setRewardForm] = useState<RewardFormState>({
    id: "",
    name: "",
    description: "",
    pointsCost: "",
    sortOrder: "",
    isEnabled: true,
  });
  const [rewardFormError, setRewardFormError] = useState("");
  const [rewardSaving, setRewardSaving] = useState(false);

  // 审计日志
  const [auditData, setAuditData] = useState<Paginated<AuditLogItem> | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState("");
  const [auditAction, setAuditAction] = useState("");
  const [auditAppliedAction, setAuditAppliedAction] = useState("");
  const [auditPage, setAuditPage] = useState(1);

  // 备份
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [backupDirConfigured, setBackupDirConfigured] = useState(false);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backupsError, setBackupsError] = useState("");
  const [backupRunning, setBackupRunning] = useState(false);

  // 学年学期
  const [periodsData, setPeriodsData] = useState<PeriodsData | null>(null);
  const [periodsLoading, setPeriodsLoading] = useState(false);
  const [periodsError, setPeriodsError] = useState("");
  const [yearFormOpen, setYearFormOpen] = useState(false);
  const [yearForm, setYearForm] = useState<YearFormState>({ name: "", startDate: "", endDate: "" });
  const [yearFormError, setYearFormError] = useState("");
  const [yearSaving, setYearSaving] = useState(false);
  const [termFormOpen, setTermFormOpen] = useState(false);
  const [termForm, setTermForm] = useState<TermFormState>({
    academicYearId: "",
    name: "",
    startDate: "",
    endDate: "",
  });
  const [termFormError, setTermFormError] = useState("");
  const [termSaving, setTermSaving] = useState(false);

  // 家长分享
  const [sharesData, setSharesData] = useState<Paginated<ShareRow> | null>(null);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [sharesError, setSharesError] = useState("");
  const [sharesPage, setSharesPage] = useState(1);
  const [shareStudentFilter, setShareStudentFilter] = useState("");
  const [filterStudents, setFilterStudents] = useState<StudentOption[]>([]);
  const [shareFormOpen, setShareFormOpen] = useState(false);
  const [shareStudent, setShareStudent] = useState<StudentOption | null>(null);
  const [shareExpiresInDays, setShareExpiresInDays] = useState("30");
  const [shareLabel, setShareLabel] = useState("");
  const [shareFormError, setShareFormError] = useState("");
  const [shareSaving, setShareSaving] = useState(false);
  const [createdShare, setCreatedShare] = useState<CreatedShare | null>(null);
  const [shareSearchQuery, setShareSearchQuery] = useState("");
  const [shareSearchResults, setShareSearchResults] = useState<StudentOption[]>([]);
  const [shareSearchLoading, setShareSearchLoading] = useState(false);

  // 通用确认
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  /* ------------------------------------------------------------- 元数据加载 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [gradeData, classData, teacherData] = await Promise.all([
          api<{ items: GradeItem[] }>("/grades"),
          api<{ items: ClassItem[] }>("/classes"),
          api<{ items: TeacherItem[] }>("/teachers"),
        ]);
        if (cancelled) return;
        setGrades(gradeData.items ?? []);
        setClasses(classData.items ?? []);
        setTeachers(teacherData.items ?? []);
        setMetaError("");
      } catch (error) {
        if (!cancelled) setMetaError(errorMessage(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setUsersPage(1);
  }, [roleFilter, statusFilter, debouncedSearch]);

  /* ------------------------------------------------------------- 账号列表 */
  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setUsersError("");
    try {
      const data = await api<Paginated<AdminUser>>(
        `/admin/users${query({
          role: roleFilter,
          status: statusFilter,
          search: debouncedSearch,
          page: usersPage,
          pageSize: 20,
        })}`,
      );
      setUsersData(data);
    } catch (error) {
      setUsersData(null);
      setUsersError(errorMessage(error));
    } finally {
      setUsersLoading(false);
    }
  }, [roleFilter, statusFilter, debouncedSearch, usersPage]);

  useEffect(() => {
    if (tab === "accounts") void loadUsers();
  }, [tab, loadUsers]);

  /* ------------------------------------------------------------- 系统参数 */
  const loadSystem = useCallback(async () => {
    setSystemLoading(true);
    setSystemError("");
    try {
      const data = await api<SystemResponse>("/admin/system");
      setSystemData(data);
      setSettingsForm({
        initialPoints: String(data.settings?.initialPoints ?? ""),
        allowNegative: Boolean(data.settings?.allowNegative),
        reviewThreshold: String(data.settings?.reviewThreshold ?? ""),
      });
    } catch (error) {
      setSystemData(null);
      setSystemError(errorMessage(error));
    } finally {
      setSystemLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "system") void loadSystem();
  }, [tab, loadSystem]);

  async function saveSettings() {
    const initialPoints = Number(settingsForm.initialPoints);
    const reviewThreshold = Number(settingsForm.reviewThreshold);
    if (!Number.isSafeInteger(initialPoints) || initialPoints < 0 || initialPoints > 1000) {
      setSettingsError("初始分必须为 0 到 1000 之间的整数");
      return;
    }
    if (!Number.isSafeInteger(reviewThreshold) || reviewThreshold < 1 || reviewThreshold > 1000) {
      setSettingsError("复核阈值必须为 1 到 1000 之间的整数");
      return;
    }
    setSettingsError("");
    setSettingsSaving(true);
    try {
      await api(
        "/admin/system",
        json("PATCH", { initialPoints, allowNegative: settingsForm.allowNegative, reviewThreshold }),
      );
      toast("系统参数已保存，新的记分记录将按新参数计算", "success");
      await loadSystem();
    } catch (error) {
      setSettingsError(errorMessage(error));
    } finally {
      setSettingsSaving(false);
    }
  }

  /* ------------------------------------------------------------- 荣誉/兑换 */
  const loadRewardConfig = useCallback(async () => {
    setHonorsLoading(true);
    setHonorsError("");
    setRewardsError("");
    try {
      const [honorData, rewardData] = await Promise.all([
        api<{ items: HonorRule[] }>("/admin/honors"),
        api<{ items: RewardItem[] }>("/admin/rewards"),
      ]);
      setHonors(Array.isArray(honorData) ? honorData : (honorData.items ?? []));
      setRewards(Array.isArray(rewardData) ? rewardData : (rewardData.items ?? []));
    } catch (error) {
      const message = errorMessage(error);
      setHonorsError(message);
      setRewardsError(message);
    } finally {
      setHonorsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "rewards") void loadRewardConfig();
  }, [tab, loadRewardConfig]);

  async function submitHonorForm() {
    const name = honorForm.name.trim();
    if (!name) return setHonorFormError("请填写荣誉名称");
    const minPoints = Number(honorForm.minPoints || 0);
    const minPositiveRecords = Number(honorForm.minPositiveRecords || 0);
    if (!Number.isSafeInteger(minPoints) || minPoints < 0) return setHonorFormError("最低积分必须为非负整数");
    if (!Number.isSafeInteger(minPositiveRecords) || minPositiveRecords < 0)
      return setHonorFormError("最少正向记录数必须为非负整数");
    if (honorForm.sortOrder.trim() && !Number.isSafeInteger(Number(honorForm.sortOrder)))
      return setHonorFormError("排序号必须为整数");
    setHonorFormError("");
    setHonorSaving(true);
    try {
      const body: Record<string, unknown> = {
        name,
        description: honorForm.description.trim(),
        minPoints,
        minPositiveRecords,
        isEnabled: honorForm.isEnabled,
      };
      if (honorForm.sortOrder.trim()) body.sortOrder = Number(honorForm.sortOrder);
      if (honorForm.id) await api(`/admin/honors/${honorForm.id}`, json("PATCH", body));
      else await api("/admin/honors", json("POST", body));
      toast(honorForm.id ? "荣誉条件已更新" : "荣誉条件已创建", "success");
      setHonorFormOpen(false);
      await loadRewardConfig();
    } catch (error) {
      setHonorFormError(errorMessage(error));
    } finally {
      setHonorSaving(false);
    }
  }

  async function submitRewardForm() {
    const name = rewardForm.name.trim();
    if (!name) return setRewardFormError("请填写兑换名称");
    const pointsCost = Number(rewardForm.pointsCost);
    if (!Number.isSafeInteger(pointsCost) || pointsCost < 1)
      return setRewardFormError("所需积分必须为大于 0 的整数");
    if (rewardForm.sortOrder.trim() && !Number.isSafeInteger(Number(rewardForm.sortOrder)))
      return setRewardFormError("排序号必须为整数");
    setRewardFormError("");
    setRewardSaving(true);
    try {
      const body: Record<string, unknown> = {
        name,
        description: rewardForm.description.trim(),
        pointsCost,
        isEnabled: rewardForm.isEnabled,
      };
      if (rewardForm.sortOrder.trim()) body.sortOrder = Number(rewardForm.sortOrder);
      if (rewardForm.id) await api(`/admin/rewards/${rewardForm.id}`, json("PATCH", body));
      else await api("/admin/rewards", json("POST", body));
      toast(rewardForm.id ? "兑换项已更新" : "兑换项已创建", "success");
      setRewardFormOpen(false);
      await loadRewardConfig();
    } catch (error) {
      setRewardFormError(errorMessage(error));
    } finally {
      setRewardSaving(false);
    }
  }

  async function toggleHonorEnabled(honor: HonorRule) {
    try {
      await api(`/admin/honors/${honor.id}`, json("PATCH", { isEnabled: !honor.isEnabled }));
      toast(honor.isEnabled ? "荣誉条件已停用" : "荣誉条件已启用", "success");
      await loadRewardConfig();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  async function toggleRewardEnabled(reward: RewardItem) {
    try {
      await api(`/admin/rewards/${reward.id}`, json("PATCH", { isEnabled: !reward.isEnabled }));
      toast(reward.isEnabled ? "兑换项已停用" : "兑换项已启用", "success");
      await loadRewardConfig();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  /* ------------------------------------------------------------- 审计日志 */
  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    setAuditError("");
    try {
      const data = await api<Paginated<AuditLogItem>>(
        `/admin/audit-logs${query({ action: auditAppliedAction, page: auditPage, pageSize: 20 })}`,
      );
      setAuditData(data);
    } catch (error) {
      setAuditData(null);
      setAuditError(errorMessage(error));
    } finally {
      setAuditLoading(false);
    }
  }, [auditAppliedAction, auditPage]);

  useEffect(() => {
    if (tab === "audit") void loadAudit();
  }, [tab, loadAudit]);

  /* ------------------------------------------------------------- 备份 */
  const loadBackups = useCallback(async () => {
    setBackupsLoading(true);
    setBackupsError("");
    try {
      const data = await api<{ items: BackupItem[]; backupDirConfigured: boolean }>("/admin/backups");
      setBackups(data.items ?? []);
      setBackupDirConfigured(Boolean(data.backupDirConfigured));
      return data;
    } catch (error) {
      setBackupsError(errorMessage(error));
      return null;
    } finally {
      setBackupsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "backups") void loadBackups();
  }, [tab, loadBackups]);

  async function runBackup() {
    setBackupRunning(true);
    try {
      await api("/admin/backups", { method: "POST", body: "{}" });
      const data = await loadBackups();
      const latest = data?.items?.[0];
      if (latest?.status === "FAILED") toast(`备份失败：${latest.error || "请检查备份目录是否可写"}`, "error");
      else if (latest?.status === "RUNNING") toast("备份任务已启动，正在生成数据库快照", "info");
      else toast(`备份完成：${latest?.fileName || "快照文件已生成"}`, "success");
    } catch (error) {
      toast(errorMessage(error), "error");
      await loadBackups();
    } finally {
      setBackupRunning(false);
    }
  }

  /* ------------------------------------------------------------- 学年学期 */
  const loadPeriods = useCallback(async () => {
    setPeriodsLoading(true);
    setPeriodsError("");
    try {
      const data = await api<PeriodsData>("/periods");
      setPeriodsData(data);
    } catch (error) {
      setPeriodsData(null);
      setPeriodsError(errorMessage(error));
    } finally {
      setPeriodsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "system") void loadPeriods();
  }, [tab, loadPeriods]);

  function openYearForm() {
    setYearForm({ name: "", startDate: "", endDate: "" });
    setYearFormError("");
    setYearFormOpen(true);
  }

  async function submitYearForm() {
    const name = yearForm.name.trim();
    if (name.length < 2) return setYearFormError("学年名称至少需要 2 个字符");
    if (!yearForm.startDate || !yearForm.endDate) return setYearFormError("请填写学年的开始日期与结束日期");
    if (yearForm.startDate >= yearForm.endDate) return setYearFormError("结束日期必须晚于开始日期");
    setYearFormError("");
    setYearSaving(true);
    try {
      await api("/academic-years", json("POST", { name, startDate: yearForm.startDate, endDate: yearForm.endDate }));
      toast("学年已创建，可继续为该学年添加学期", "success");
      setYearFormOpen(false);
      await loadPeriods();
    } catch (error) {
      setYearFormError(errorMessage(error));
    } finally {
      setYearSaving(false);
    }
  }

  function openTermForm(academicYearId?: string) {
    const yearId =
      academicYearId ||
      periodsData?.years.find((year) => year.isCurrent)?.id ||
      periodsData?.years[0]?.id ||
      "";
    setTermForm({ academicYearId: yearId, name: "", startDate: "", endDate: "" });
    setTermFormError("");
    setTermFormOpen(true);
  }

  async function submitTermForm() {
    if (!termForm.academicYearId) return setTermFormError("请选择所属学年");
    const name = termForm.name.trim();
    if (name.length < 2) return setTermFormError("学期名称至少需要 2 个字符");
    if (!termForm.startDate || !termForm.endDate) return setTermFormError("请填写学期的开始日期与结束日期");
    if (termForm.startDate >= termForm.endDate) return setTermFormError("结束日期必须晚于开始日期");
    setTermFormError("");
    setTermSaving(true);
    try {
      await api(
        "/terms",
        json("POST", {
          academicYearId: termForm.academicYearId,
          name,
          startDate: termForm.startDate,
          endDate: termForm.endDate,
        }),
      );
      toast("学期已创建", "success");
      setTermFormOpen(false);
      await loadPeriods();
    } catch (error) {
      setTermFormError(errorMessage(error));
    } finally {
      setTermSaving(false);
    }
  }

  function confirmSwitchTerm(termId: string, termName: string, yearName: string) {
    setPendingConfirm({
      title: "切换当前学期？",
      description: `将把「${yearName} · ${termName}」设为当前学期。切换后仪表盘、分析与报告的默认统计周期会随之改变；历史记录不会删除，也不影响已生效的积分。`,
      confirmLabel: "确认切换",
      run: async () => {
        setConfirmLoading(true);
        try {
          await api(`/terms/${termId}/current`, { method: "POST", body: "{}" });
          toast("当前学期已切换，统计周期已更新（顶部学期标签将在刷新页面后同步）", "success");
          await loadPeriods();
          await loadSystem();
        } catch (error) {
          toast(errorMessage(error), "error");
        } finally {
          setConfirmLoading(false);
          setPendingConfirm(null);
        }
      },
    });
  }

  /* ------------------------------------------------------------- 家长分享 */
  const loadShares = useCallback(async () => {
    setSharesLoading(true);
    setSharesError("");
    try {
      const data = await api<Paginated<ShareRow>>(
        `/shares${query({ studentId: shareStudentFilter, page: sharesPage, pageSize: 20 })}`,
      );
      setSharesData(data);
    } catch (error) {
      setSharesData(null);
      setSharesError(errorMessage(error));
    } finally {
      setSharesLoading(false);
    }
  }, [sharesPage, shareStudentFilter]);

  useEffect(() => {
    if (tab === "shares") void loadShares();
  }, [tab, loadShares]);

  useEffect(() => {
    if (tab !== "shares") return;
    let cancelled = false;
    void api<{ items: StudentOption[] }>("/options/students")
      .then((data) => {
        if (!cancelled) setFilterStudents(data.items ?? []);
      })
      .catch(() => {
        // 学生筛选下拉不可用不影响列表本身
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  useEffect(() => {
    if (!shareFormOpen) return;
    const needle = shareSearchQuery.trim();
    if (!needle) {
      setShareSearchResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setShareSearchLoading(true);
      try {
        const data = await api<{ items: StudentOption[] }>(`/options/students${query({ search: needle })}`);
        if (!cancelled) setShareSearchResults(data.items ?? []);
      } catch (error) {
        if (!cancelled) {
          setShareSearchResults([]);
          setShareFormError(errorMessage(error));
        }
      } finally {
        if (!cancelled) setShareSearchLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [shareSearchQuery, shareFormOpen]);

  function openShareCreate() {
    setShareStudent(null);
    setShareExpiresInDays("30");
    setShareLabel("");
    setShareFormError("");
    setCreatedShare(null);
    setShareSearchQuery("");
    setShareSearchResults([]);
    setShareFormOpen(true);
  }

  async function submitShareForm() {
    if (!shareStudent) return setShareFormError("请选择需要分享的学生");
    const days = Number(shareExpiresInDays);
    if (!Number.isSafeInteger(days) || days < 1 || days > 90)
      return setShareFormError("有效期必须为 1–90 天的整数");
    if (shareLabel.trim().length > 100) return setShareFormError("备注不能超过 100 个字符");
    setShareFormError("");
    setShareSaving(true);
    try {
      const data = await api<{ share: CreatedShare }>(
        "/shares",
        json("POST", { studentId: shareStudent.id, expiresInDays: days, label: shareLabel.trim() }),
      );
      setCreatedShare({ ...data.share, url: buildShareUrl(data.share.token, data.share.url) });
      toast("分享链接已生成，请立即复制发送给家长", "success");
      await loadShares();
    } catch (error) {
      setShareFormError(errorMessage(error));
    } finally {
      setShareSaving(false);
    }
  }

  async function copyShareLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      toast("链接已复制，请仅发送给已核验身份的家长", "success");
    } catch {
      toast("浏览器阻止了自动复制，请手动选中链接后复制", "warning");
    }
  }

  function confirmRevokeShare(share: ShareItem) {
    setPendingConfirm({
      title: "撤销家长分享链接？",
      description: `撤销后「${share.studentName}」的该链接会立即失效，家长将无法继续查看报告；如需恢复分享请重新生成新链接。`,
      confirmLabel: "确认撤销",
      danger: true,
      run: async () => {
        setConfirmLoading(true);
        try {
          await api(`/shares/${share.id}/revoke`, { method: "POST", body: "{}" });
          toast("分享链接已撤销", "success");
          await loadShares();
        } catch (error) {
          toast(errorMessage(error), "error");
        } finally {
          setConfirmLoading(false);
          setPendingConfirm(null);
        }
      },
    });
  }

  /* ------------------------------------------------------------- 账号表单 */
  function openUserCreate() {
    setUserForm(emptyUserForm());
    setUserFormError("");
    setScopeDraftType("GRADE");
    setScopeDraftId("");
    setUserFormOpen(true);
  }

  function openUserEdit(target: AdminUser) {
    setUserForm({
      id: target.id,
      account: target.account,
      displayName: target.displayName,
      password: "",
      confirmPassword: "",
      role: target.role,
      teacherId: target.teacherId || "",
      scopes: (target.scopes ?? []).map((scope) => ({ scopeType: scope.scopeType, scopeId: scope.scopeId })),
    });
    setUserFormError("");
    setScopeDraftType("GRADE");
    setScopeDraftId("");
    setUserFormOpen(true);
  }

  function addScopeDraft() {
    if (!scopeDraftId) return;
    if (userForm.scopes.some((scope) => scope.scopeType === scopeDraftType && scope.scopeId === scopeDraftId)) {
      setUserFormError("该数据范围已添加");
      return;
    }
    setUserFormError("");
    setUserForm((current) => ({
      ...current,
      scopes: [...current.scopes, { scopeType: scopeDraftType, scopeId: scopeDraftId }],
    }));
    setScopeDraftId("");
  }

  function scopeName(scope: ScopeDraft): string {
    if (scope.scopeType === "GRADE") return grades.find((grade) => grade.id === scope.scopeId)?.name || scope.scopeId;
    const klass = classes.find((item) => item.id === scope.scopeId);
    return klass ? `${klass.gradeName}${klass.name}` : scope.scopeId;
  }

  async function submitUserForm() {
    const displayName = userForm.displayName.trim();
    if (!displayName) return setUserFormError("请填写姓名");
    if (displayName.length > 50) return setUserFormError("姓名不能超过 50 个字符");
    if (!userForm.id) {
      const account = userForm.account.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/.test(account))
        return setUserFormError("账号需为 3–32 位字母、数字、下划线、点或短横线，且以字母或数字开头");
      const passwordError = validatePassword(userForm.password, userForm.confirmPassword, account);
      if (passwordError) return setUserFormError(passwordError);
    }
    if (userForm.role === "DUTY_TEACHER" && userForm.scopes.length === 0)
      return setUserFormError("值日老师至少需要选择一个年级或班级的数据范围");
    if (userForm.role !== "DUTY_TEACHER" && userForm.scopes.length > 0) {
      // 全校角色不需要数据范围，提交时清空即可
    }
    setUserFormError("");
    setUserSaving(true);
    try {
      const scopes = userForm.role === "DUTY_TEACHER" ? userForm.scopes : [];
      if (userForm.id) {
        await api(
          `/admin/users/${userForm.id}`,
          json("PATCH", {
            displayName,
            role: userForm.role,
            scopes,
            teacherId: userForm.teacherId || null,
          }),
        );
        toast("账号信息已更新", "success");
      } else {
        await api(
          "/admin/users",
          json("POST", {
            account: userForm.account.trim(),
            displayName,
            password: userForm.password,
            role: userForm.role,
            teacherId: userForm.teacherId || undefined,
            scopes,
          }),
        );
        toast("账号已创建，请将初始账号密码线下告知老师，并提醒首次登录修改密码", "success");
      }
      setUserFormOpen(false);
      await loadUsers();
    } catch (error) {
      setUserFormError(errorMessage(error));
    } finally {
      setUserSaving(false);
    }
  }

  async function toggleUserStatus(target: AdminUser) {
    if (target.id === user.id) {
      toast("不能停用当前登录的账号", "warning");
      return;
    }
    const nextStatus = target.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    setPendingConfirm({
      title: nextStatus === "DISABLED" ? "停用该账号？" : "启用该账号？",
      description:
        nextStatus === "DISABLED"
          ? `停用后「${target.displayName}（${target.account}）」将立即无法登录，已产生的积分记录不受影响。`
          : `启用后「${target.displayName}（${target.account}）」可以重新登录使用系统。`,
      confirmLabel: nextStatus === "DISABLED" ? "确认停用" : "确认启用",
      danger: nextStatus === "DISABLED",
      run: async () => {
        setConfirmLoading(true);
        try {
          await api(`/admin/users/${target.id}`, json("PATCH", { status: nextStatus }));
          toast(nextStatus === "DISABLED" ? "账号已停用" : "账号已启用", "success");
          await loadUsers();
        } catch (error) {
          toast(errorMessage(error), "error");
        } finally {
          setConfirmLoading(false);
          setPendingConfirm(null);
        }
      },
    });
  }

  function openResetPassword(target: AdminUser) {
    setResetTarget(target);
    setResetPassword("");
    setResetConfirm("");
    setResetError("");
    setResetOpen(true);
  }

  async function submitResetPassword() {
    if (!resetTarget) return;
    const passwordError = validatePassword(resetPassword, resetConfirm, resetTarget.account);
    if (passwordError) {
      setResetError(passwordError);
      return;
    }
    setResetError("");
    setResetSaving(true);
    try {
      await api(`/admin/users/${resetTarget.id}/reset-password`, json("POST", { password: resetPassword }));
      toast("密码已重置，该账号下次登录后需立即修改密码", "success");
      setResetOpen(false);
    } catch (error) {
      setResetError(errorMessage(error));
    } finally {
      setResetSaving(false);
    }
  }

  /* ------------------------------------------------------------- 渲染辅助 */
  const auditActionInput = auditAction;
  const currentTerm = periodsData?.years
    ?.flatMap((year) => year.terms.map((term) => ({ ...term, yearName: year.name })))
    .find((term) => term.isCurrent);

  const disabledUserCount = useMemo(
    () => (usersData?.items ?? []).filter((item) => item.status !== "ACTIVE").length,
    [usersData],
  );

  return (
    <div className="page">
      <PageHeader
        title="系统管理"
        description="账号与数据范围、系统参数与学年学期、家长分享、荣誉与兑换配置、审计日志与数据库备份。"
        actions={
          <div className="toolbar">
            {tab === "accounts" && (
              <Button icon={<UserPlus size={16} />} onClick={openUserCreate}>
                新建账号
              </Button>
            )}
            {tab === "shares" && canManageShares && (
              <Button icon={<Share2 size={16} />} onClick={openShareCreate}>
                生成分享链接
              </Button>
            )}
            {tab === "rewards" && (
              <Button icon={<Plus size={16} />} onClick={() => setHonorFormOpen(true)}>
                新建荣誉条件
              </Button>
            )}
            {tab === "backups" && (
              <Button
                icon={<DatabaseBackup size={16} />}
                loading={backupRunning}
                onClick={() => void runBackup()}
                disabled={backupRunning}
                title={backupDirConfigured ? "立即执行真实数据库备份" : "未配置 BACKUP_DIR，点击可查看服务端返回的具体原因"}
              >
                立即备份
              </Button>
            )}
          </div>
        }
      />

      <div className="stack">
        <Segmented<TabKey>
          value={tab}
          ariaLabel="系统管理视图"
          options={[
            { value: "accounts", label: "账号与范围" },
            { value: "system", label: "系统参数" },
            ...(canManageShares ? [{ value: "shares" as TabKey, label: "家长分享" }] : []),
            { value: "rewards", label: "荣誉与兑换" },
            { value: "audit", label: "审计日志" },
            { value: "backups", label: "备份" },
          ]}
          onChange={setTab}
        />

        {metaError && tab === "accounts" && (
          <Alert tone="warning" title="年级/班级/教师资料加载失败">
            {metaError} 账号列表仍可查看，但数据范围选择可能不完整。
          </Alert>
        )}

        {/* --------------------------------------------------------- 账号与范围 */}
        {tab === "accounts" && (
          <>
            <div className="stat-grid">
              <StatCard
                label="账号总数"
                value={usersData?.total ?? "—"}
                suffix="个"
                tone="brand"
                icon={<Users size={18} />}
                hint="按当前筛选"
              />
              <StatCard
                label="当前页停用账号"
                value={disabledUserCount}
                suffix="个"
                tone={disabledUserCount > 0 ? "warn" : "neutral"}
                icon={<ShieldCheck size={18} />}
              />
              <StatCard
                label="值日老师"
                value={usersData?.items.filter((item) => item.role === "DUTY_TEACHER").length ?? "—"}
                suffix="个"
                tone="neutral"
                hint="按数据范围授权"
              />
              <StatCard
                label="德育处 / 管理员"
                value={usersData?.items.filter((item) => item.role !== "DUTY_TEACHER").length ?? "—"}
                suffix="个"
                tone="neutral"
                hint="全校数据范围"
              />
            </div>

            <Card padded={false}>
              <div className="toolbar filters" style={{ padding: "12px 14px" }}>
                <Select aria-label="按角色筛选" style={{ flex: "1 1 140px", minWidth: 0 }} value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
                  <option value="">全部角色</option>
                  {ROLE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="按状态筛选"
                  style={{ flex: "1 1 140px", minWidth: 0 }}
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                >
                  <option value="">全部状态</option>
                  <option value="ACTIVE">启用</option>
                  <option value="DISABLED">停用</option>
                </Select>
                <div className="search-box">
                  <Search size={16} />
                  <Input
                    aria-label="搜索账号"
                    placeholder="搜索账号 / 姓名"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void loadUsers()}>
                  刷新
                </Button>
              </div>

              {usersError ? (
                <div style={{ padding: 14 }}>
                  <Alert tone="danger" title="账号列表加载失败" onRetry={() => void loadUsers()}>
                    {usersError}
                  </Alert>
                </div>
              ) : usersLoading ? (
                <Loading label="正在加载账号列表…" />
              ) : !usersData || usersData.items.length === 0 ? (
                <EmptyState
                  title="没有符合条件的账号"
                  description="调整筛选条件，或新建账号并分配角色与数据范围。"
                  icon={<Users size={22} />}
                  action={
                    <Button size="sm" icon={<UserPlus size={15} />} onClick={openUserCreate}>
                      新建账号
                    </Button>
                  }
                />
              ) : (
                <>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>姓名</th>
                          <th>账号</th>
                          <th>角色</th>
                          <th>数据范围</th>
                          <th>状态</th>
                          <th>最近登录</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usersData.items.map((item) => (
                          <tr key={item.id}>
                            <td className="cell-strong">
                              {item.displayName}
                              {item.id === user.id && <Badge tone="brand">当前账号</Badge>}
                              {item.teacherName && (
                                <div className="muted text-xs">关联教师：{item.teacherName}</div>
                              )}
                            </td>
                            <td className="mono">{item.account}</td>
                            <td>
                              <Badge tone={ROLE_TONES[item.role] || "neutral"}>{item.roleLabel || item.role}</Badge>
                            </td>
                            <td>
                              <span className="truncate" style={{ display: "inline-block", maxWidth: 220 }}>
                                {scopeSummaryOf(item)}
                              </span>
                            </td>
                            <td>
                              <Badge tone={item.status === "ACTIVE" ? "success" : "neutral"}>
                                {item.status === "ACTIVE" ? "启用" : "停用"}
                              </Badge>
                            </td>
                            <td>{item.lastLoginAt ? relativeTime(item.lastLoginAt) : "从未登录"}</td>
                            <td>
                              <div className="toolbar" style={{ gap: 2 }}>
                                <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => openUserEdit(item)}>
                                  编辑
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  icon={<KeyRound size={13} />}
                                  onClick={() => openResetPassword(item)}
                                >
                                  重置密码
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={item.id === user.id}
                                  title={item.id === user.id ? "不能停用当前登录账号" : undefined}
                                  icon={item.status === "ACTIVE" ? <Archive size={13} /> : <CheckCircle2 size={13} />}
                                  onClick={() => void toggleUserStatus(item)}
                                >
                                  {item.status === "ACTIVE" ? "停用" : "启用"}
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ padding: "0 14px 12px" }}>
                    <Pagination
                      page={usersData.page}
                      totalPages={usersData.totalPages}
                      total={usersData.total}
                      onChange={setUsersPage}
                      unit="个账号"
                    />
                  </div>
                </>
              )}
            </Card>
            <Notice tone="info">
              数据范围说明：系统管理员与德育处为全校范围；值日老师必须分配年级或班级范围，越权请求会被服务端拒绝（403）。
            </Notice>
          </>
        )}

        {/* --------------------------------------------------------- 系统参数 */}
        {tab === "system" && (
          <>
            {systemError ? (
              <Alert tone="danger" title="系统参数加载失败" onRetry={() => void loadSystem()}>
                {systemError}
              </Alert>
            ) : systemLoading ? (
              <Loading label="正在加载系统参数…" />
            ) : systemData ? (
              <>
                <div className="grid cols-2">
                  <Card
                    title="积分与复核参数"
                    subtitle="修改后立即对新记录生效；历史记录按规则快照保留，不回算。"
                  >
                    <div className="form-grid">
                      <Field label="初始分（分）" required hint="每位学生每学期期初的基础分，0–1000 的整数">
                        <Input
                          type="number"
                          min={0}
                          max={1000}
                          value={settingsForm.initialPoints}
                          onChange={(event) => setSettingsForm({ ...settingsForm, initialPoints: event.target.value })}
                        />
                      </Field>
                      <Field label="复核阈值（分）" required hint="单条记录分值达到该阈值时进入待复核，1–1000">
                        <Input
                          type="number"
                          min={1}
                          max={1000}
                          value={settingsForm.reviewThreshold}
                          onChange={(event) => setSettingsForm({ ...settingsForm, reviewThreshold: event.target.value })}
                        />
                      </Field>
                      <Field label="允许负分">
                        <Checkbox
                          label="允许学生学期总分低于 0 分（关闭时最低为 0 分）"
                          checked={settingsForm.allowNegative}
                          onChange={(event) =>
                            setSettingsForm({ ...settingsForm, allowNegative: event.target.checked })
                          }
                        />
                      </Field>
                      {settingsError && <Alert tone="danger">{settingsError}</Alert>}
                      <div className="form-actions">
                        <Button variant="secondary" onClick={() => void loadSystem()} disabled={settingsSaving}>
                          重置
                        </Button>
                        <Button loading={settingsSaving} onClick={() => void saveSettings()}>
                          保存系统参数
                        </Button>
                      </div>
                    </div>
                  </Card>

                  <Card
                    title="学校与学年学期"
                    subtitle="切换当前学期会改变仪表盘/分析/报告的默认统计周期；历史记录不会删除。"
                    actions={
                      <div className="toolbar">
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<CalendarPlus size={14} />}
                          onClick={openYearForm}
                          disabled={!isSysAdmin}
                        >
                          新建学年
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<CalendarDays size={14} />}
                          onClick={() => openTermForm()}
                          disabled={!isSysAdmin || (periodsData?.years.length ?? 0) === 0}
                        >
                          新建学期
                        </Button>
                      </div>
                    }
                  >
                    <dl className="kv">
                      <dt>学校名称</dt>
                      <dd>{systemData.school?.name || "—"}</dd>
                      <dt>学校编码</dt>
                      <dd className="mono">{systemData.school?.code || "—"}</dd>
                      <dt>学段</dt>
                      <dd>{systemData.school?.stage || "—"}</dd>
                      <dt>地址</dt>
                      <dd>{systemData.school?.address || "—"}</dd>
                      <dt>联系方式</dt>
                      <dd>{systemData.school?.contact || "—"}</dd>
                      <dt>当前学期</dt>
                      <dd>{currentTerm ? `${currentTerm.yearName} · ${currentTerm.name}` : "未设置"}</dd>
                    </dl>
                    <div className="divider" />
                    {periodsLoading ? (
                      <Loading label="正在加载学年学期…" />
                    ) : periodsError ? (
                      <Alert tone="danger" title="学年学期加载失败" onRetry={() => void loadPeriods()}>
                        {periodsError}
                      </Alert>
                    ) : (
                      <div className="list">
                        {(periodsData?.years ?? []).map((year) => (
                          <div className="list-item" key={year.id}>
                            <div className="list-main">
                              <div className="list-title">
                                {year.name}
                                {year.isCurrent && <Badge tone="brand">当前学年</Badge>}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  icon={<Plus size={13} />}
                                  onClick={() => openTermForm(year.id)}
                                >
                                  在该学年新建学期
                                </Button>
                              </div>
                              <div className="list-sub">
                                {formatDate(year.startDate)} 至 {formatDate(year.endDate)}
                              </div>
                              <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                                {year.terms.length === 0 ? (
                                  <span className="muted text-sm">该学年还没有学期</span>
                                ) : (
                                  year.terms.map((term) => (
                                    <div className="row between" key={term.id} style={{ gap: 8, flexWrap: "wrap" }}>
                                      <div>
                                        <span className="text-strong text-sm">{term.name}</span>{" "}
                                        {term.isCurrent && <Badge tone="success">当前学期</Badge>}
                                        <div className="muted text-xs">
                                          {formatDate(term.startDate)} 至 {formatDate(term.endDate)}
                                        </div>
                                      </div>
                                      <div className="toolbar" style={{ gap: 4 }}>
                                        {term.isCurrent ? (
                                          <Button size="sm" variant="secondary" disabled>
                                            当前学期
                                          </Button>
                                        ) : (
                                          <Button
                                            size="sm"
                                            variant="secondary"
                                            onClick={() => confirmSwitchTerm(term.id, term.name, year.name)}
                                          >
                                            设为当前学期
                                          </Button>
                                        )}
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                        {(periodsData?.years ?? []).length === 0 && (
                          <span className="muted text-sm">暂无学年学期数据，请先新建学年。</span>
                        )}
                      </div>
                    )}
                  </Card>
                </div>
                <Notice tone="warning">
                  系统参数属于高风险配置：初始分与复核阈值会影响后续记分与复核判断，请与德育处确认后修改。所有修改都会写入审计日志。
                </Notice>
              </>
            ) : null}
          </>
        )}

        {/* --------------------------------------------------------- 家长分享 */}
        {tab === "shares" && canManageShares && (
          <>
            {sharesError && (
              <Alert tone="danger" title="家长分享列表加载失败" onRetry={() => void loadShares()}>
                {sharesError}
              </Alert>
            )}
            <Card
              title="家长分享链接"
              subtitle="家长通过分享链接只读查看学生成长报告；链接可随时撤销、到期自动失效，不展示班级排名与其他学生信息。"
              actions={
                <div className="toolbar">
                  <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void loadShares()}>
                    刷新
                  </Button>
                  <Button size="sm" icon={<Share2 size={14} />} onClick={openShareCreate}>
                    生成分享链接
                  </Button>
                </div>
              }
              padded={false}
            >
              <div className="toolbar filters" style={{ padding: "12px 14px" }}>
                <Select
                  aria-label="按学生筛选分享"
                  style={{ flex: "1 1 220px", minWidth: 0 }}
                  value={shareStudentFilter}
                  onChange={(event) => {
                    setShareStudentFilter(event.target.value);
                    setSharesPage(1);
                  }}
                >
                  <option value="">全部学生</option>
                  {filterStudents.map((student) => (
                    <option key={student.id} value={student.id}>
                      {student.gradeName}
                      {student.className} · {student.name}（{student.studentNo}）
                    </option>
                  ))}
                </Select>
                {shareStudentFilter && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setShareStudentFilter("");
                      setSharesPage(1);
                    }}
                  >
                    清除筛选
                  </Button>
                )}
              </div>
              {sharesLoading ? (
                <Loading label="正在加载家长分享链接…" />
              ) : !sharesData || sharesData.items.length === 0 ? (
                <EmptyState
                  title="还没有分享链接"
                  description="为需要了解孩子成长情况的家长生成只读链接；链接只能查看一名学生的报告，且可随时撤销。"
                  icon={<Share2 size={22} />}
                  action={
                    <Button size="sm" icon={<Share2 size={15} />} onClick={openShareCreate}>
                      生成分享链接
                    </Button>
                  }
                />
              ) : (
                <>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>学生</th>
                          <th>备注</th>
                          <th>状态</th>
                          <th>有效期至</th>
                          <th>访问次数</th>
                          <th>最近访问</th>
                          <th>创建</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sharesData.items.map((share) => {
                          const statusKey = String(share.status || "").toUpperCase();
                          const meta = SHARE_STATUS_META[statusKey] || {
                            label: share.statusLabel || share.status,
                            tone: "neutral" as const,
                          };
                          return (
                            <tr key={share.id}>
                              <td className="cell-strong">
                                {share.studentName}
                                <div className="muted text-xs">
                                  {share.gradeName || ""}
                                  {share.className}
                                </div>
                              </td>
                              <td>{share.label || <span className="muted">—</span>}</td>
                              <td>
                                <Badge tone={meta.tone}>{meta.label}</Badge>
                              </td>
                              <td>{formatDateTime(share.expiresAt)}</td>
                              <td>{share.accessCount ?? 0} 次</td>
                              <td>{share.lastAccessedAt ? relativeTime(share.lastAccessedAt) : "从未访问"}</td>
                              <td>
                                {share.createdByName || "—"}
                                <div className="muted text-xs">{formatDateTime(share.createdAt)}</div>
                              </td>
                              <td>
                                {statusKey === "REVOKED" ? (
                                  <span className="muted text-xs">已撤销</span>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    icon={<XCircle size={13} />}
                                    onClick={() => confirmRevokeShare(share)}
                                  >
                                    撤销
                                  </Button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ padding: "0 14px 12px" }}>
                    <Pagination
                      page={sharesData.page}
                      totalPages={sharesData.totalPages}
                      total={sharesData.total}
                      onChange={setSharesPage}
                      unit="条链接"
                    />
                  </div>
                </>
              )}
            </Card>
            <Notice tone="info">
              分享链接是一次性令牌：系统只保存令牌哈希、无法找回原文。请仅通过已核验身份的渠道发送给家长本人，
              并提醒家长不要转发到班级群或公开渠道；链接撤销或到期后立即失效。
            </Notice>
          </>
        )}

        {/* --------------------------------------------------------- 荣誉与兑换 */}
        {tab === "rewards" && (
          <>
            {honorsError && (
              <Alert tone="danger" title="荣誉/兑换配置加载失败" onRetry={() => void loadRewardConfig()}>
                {honorsError}
              </Alert>
            )}
            {honorsLoading ? (
              <Loading label="正在加载荣誉与兑换配置…" />
            ) : (
              <div className="grid cols-2">
                <Card
                  title="荣誉条件"
                  subtitle="成长报告中满足条件即展示「可参评」，仅作参考，不自动授予。"
                  actions={
                    <Button
                      size="sm"
                      icon={<Plus size={14} />}
                      onClick={() => {
                        setHonorForm({
                          id: "",
                          name: "",
                          description: "",
                          minPoints: "0",
                          minPositiveRecords: "0",
                          sortOrder: String(honors.length + 1),
                          isEnabled: true,
                        });
                        setHonorFormError("");
                        setHonorFormOpen(true);
                      }}
                    >
                      新建
                    </Button>
                  }
                  padded={false}
                >
                  {honors.length === 0 ? (
                    <EmptyState compact title="还没有荣誉条件" description="创建后成长报告会按条件展示参考荣誉。" />
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>名称</th>
                            <th>条件</th>
                            <th>状态</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {honors.map((honor) => (
                            <tr key={honor.id}>
                              <td className="cell-strong">
                                {honor.name}
                                {honor.description && <div className="muted text-xs">{honor.description}</div>}
                              </td>
                              <td className="text-sm">
                                总分 ≥ {honor.minPoints} 分
                                <div className="muted text-xs">正向记录 ≥ {honor.minPositiveRecords} 条</div>
                              </td>
                              <td>
                                <Badge tone={honor.isEnabled ? "success" : "neutral"}>
                                  {honor.isEnabled ? "启用" : "停用"}
                                </Badge>
                              </td>
                              <td>
                                <div className="toolbar" style={{ gap: 2 }}>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    icon={<Pencil size={13} />}
                                    onClick={() => {
                                      setHonorForm({
                                        id: honor.id,
                                        name: honor.name,
                                        description: honor.description || "",
                                        minPoints: String(honor.minPoints),
                                        minPositiveRecords: String(honor.minPositiveRecords),
                                        sortOrder: String(honor.sortOrder ?? ""),
                                        isEnabled: honor.isEnabled,
                                      });
                                      setHonorFormError("");
                                      setHonorFormOpen(true);
                                    }}
                                  >
                                    编辑
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => void toggleHonorEnabled(honor)}>
                                    {honor.isEnabled ? "停用" : "启用"}
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>

                <Card
                  title="兑换参考"
                  subtitle="成长报告按学生积分展示「可兑换参考」，不会自动扣分或核销。"
                  actions={
                    <Button
                      size="sm"
                      icon={<Plus size={14} />}
                      onClick={() => {
                        setRewardForm({
                          id: "",
                          name: "",
                          description: "",
                          pointsCost: "",
                          sortOrder: String(rewards.length + 1),
                          isEnabled: true,
                        });
                        setRewardFormError("");
                        setRewardFormOpen(true);
                      }}
                    >
                      新建
                    </Button>
                  }
                  padded={false}
                >
                  {rewardsError ? (
                    <Alert tone="danger">{rewardsError}</Alert>
                  ) : rewards.length === 0 ? (
                    <EmptyState compact title="还没有兑换项" description="如「与校长共进午餐」「图书借阅特权」等。" />
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>名称</th>
                            <th>所需积分</th>
                            <th>状态</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rewards.map((reward) => (
                            <tr key={reward.id}>
                              <td className="cell-strong">
                                {reward.name}
                                {reward.description && <div className="muted text-xs">{reward.description}</div>}
                              </td>
                              <td className="amount">{reward.pointsCost} 分</td>
                              <td>
                                <Badge tone={reward.isEnabled ? "success" : "neutral"}>
                                  {reward.isEnabled ? "启用" : "停用"}
                                </Badge>
                              </td>
                              <td>
                                <div className="toolbar" style={{ gap: 2 }}>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    icon={<Pencil size={13} />}
                                    onClick={() => {
                                      setRewardForm({
                                        id: reward.id,
                                        name: reward.name,
                                        description: reward.description || "",
                                        pointsCost: String(reward.pointsCost),
                                        sortOrder: String(reward.sortOrder ?? ""),
                                        isEnabled: reward.isEnabled,
                                      });
                                      setRewardFormError("");
                                      setRewardFormOpen(true);
                                    }}
                                  >
                                    编辑
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => void toggleRewardEnabled(reward)}>
                                    {reward.isEnabled ? "停用" : "启用"}
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              </div>
            )}
          </>
        )}

        {/* --------------------------------------------------------- 审计日志 */}
        {tab === "audit" && (
          <Card
            title="审计日志"
            subtitle="只读记录；包含登录、导入、规则发布、账号与系统参数变更等敏感操作。"
            actions={
              <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void loadAudit()}>
                刷新
              </Button>
            }
            padded={false}
          >
            <div className="toolbar filters" style={{ padding: "12px 14px" }}>
              <div className="search-box">
                <Search size={16} />
                <Input
                  aria-label="按动作筛选"
                  placeholder="动作筛选，如 RULE_PUBLISH、IMPORT_COMMIT"
                  value={auditActionInput}
                  onChange={(event) => setAuditAction(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      setAuditAppliedAction(auditAction.trim());
                      setAuditPage(1);
                    }
                  }}
                />
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setAuditAppliedAction(auditAction.trim());
                  setAuditPage(1);
                }}
              >
                筛选
              </Button>
              {auditAppliedAction && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAuditAction("");
                    setAuditAppliedAction("");
                    setAuditPage(1);
                  }}
                >
                  清除筛选
                </Button>
              )}
            </div>
            {auditError ? (
              <div style={{ padding: 14 }}>
                <Alert tone="danger" title="审计日志加载失败" onRetry={() => void loadAudit()}>
                  {auditError}
                </Alert>
              </div>
            ) : auditLoading ? (
              <Loading label="正在加载审计日志…" />
            ) : !auditData || auditData.items.length === 0 ? (
              <EmptyState
                title="没有审计日志"
                description={auditAppliedAction ? "当前动作筛选下没有记录，可清除筛选查看全部。" : "敏感操作发生后会在这里留痕。"}
                icon={<ShieldCheck size={22} />}
              />
            ) : (
              <>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>操作者</th>
                        <th>角色</th>
                        <th>动作</th>
                        <th>对象</th>
                        <th>摘要</th>
                        <th>结果</th>
                        <th>IP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditData.items.map((log) => (
                        <tr key={log.id}>
                          <td className="mono no-wrap">{formatDateTime(log.createdAt)}</td>
                          <td>{log.actorAccount || "—"}</td>
                          <td>{log.actorRole || "—"}</td>
                          <td className="mono">{log.action}</td>
                          <td>
                            {log.targetType || "—"}
                            {log.targetId && <div className="muted text-xs mono">{log.targetId}</div>}
                          </td>
                          <td>
                            <span className="truncate" style={{ display: "inline-block", maxWidth: 320 }}>
                              {log.summary || "—"}
                            </span>
                          </td>
                          <td>
                            <Badge tone={log.result === "SUCCESS" ? "success" : "danger"}>
                              {log.result === "SUCCESS" ? "成功" : "失败"}
                            </Badge>
                          </td>
                          <td className="mono">{log.ip || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ padding: "0 14px 12px" }}>
                  <Pagination
                    page={auditData.page}
                    totalPages={auditData.totalPages}
                    total={auditData.total}
                    onChange={setAuditPage}
                    unit="条日志"
                  />
                </div>
              </>
            )}
          </Card>
        )}

        {/* --------------------------------------------------------- 备份 */}
        {tab === "backups" && (
          <>
            {backupsError ? (
              <Alert tone="danger" title="备份状态加载失败" onRetry={() => void loadBackups()}>
                {backupsError}
              </Alert>
            ) : null}
            {!backupsLoading && !backupDirConfigured && (
              <Notice tone="warning">
                尚未配置备份目录（环境变量 <span className="mono">BACKUP_DIR</span>）：服务端无法执行数据库备份，
                点击「立即备份」会被拒绝并提示原因，系统不会伪造成功状态。请联系学校运维在
                <span className="mono"> .env </span>中配置备份目录并重启服务后再试。
              </Notice>
            )}
            {backupDirConfigured && (
              <Notice tone="info">
                备份使用 SQLite <span className="mono">VACUUM INTO</span> 生成一致性快照并记录真实文件大小；
                请在部署服务器上妥善保管备份目录，避免未授权下载。
              </Notice>
            )}
            <Card
              title="数据库备份"
              subtitle="每次备份的结果（状态、文件大小、错误原因）都来自真实任务记录。"
              actions={
                <div className="toolbar">
                  <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void loadBackups()}>
                    刷新
                  </Button>
                  <Button
                    size="sm"
                    icon={<DatabaseBackup size={14} />}
                    loading={backupRunning}
                    disabled={backupRunning}
                    onClick={() => void runBackup()}
                  >
                    立即备份
                  </Button>
                </div>
              }
              padded={false}
            >
              {backupsLoading ? (
                <Loading label="正在加载备份记录…" />
              ) : backups.length === 0 ? (
                <EmptyState
                  title="还没有备份记录"
                  description={
                    backupDirConfigured
                      ? "点击「立即备份」生成第一份数据库快照。"
                      : "配置 BACKUP_DIR 后即可执行真实备份。"
                  }
                  icon={<DatabaseBackup size={22} />}
                />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>状态</th>
                        <th>文件名</th>
                        <th>文件大小</th>
                        <th>开始时间</th>
                        <th>完成时间</th>
                        <th>操作者</th>
                        <th>错误信息</th>
                      </tr>
                    </thead>
                    <tbody>
                      {backups.map((backup) => (
                        <tr key={backup.id}>
                          <td>
                            <Badge
                              tone={
                                backup.status === "SUCCEEDED"
                                  ? "success"
                                  : backup.status === "RUNNING"
                                    ? "warning"
                                    : "danger"
                              }
                            >
                              {backup.status === "SUCCEEDED" ? "成功" : backup.status === "RUNNING" ? "进行中" : "失败"}
                            </Badge>
                          </td>
                          <td className="mono">{backup.fileName || "—"}</td>
                          <td>{backup.sizeBytes ? formatBytes(backup.sizeBytes) : "—"}</td>
                          <td>{formatDateTime(backup.startedAt)}</td>
                          <td>{backup.finishedAt ? formatDateTime(backup.finishedAt) : "—"}</td>
                          <td>{backup.createdByName || "系统任务"}</td>
                          <td>
                            {backup.error ? (
                              <span style={{ color: "var(--deduct)" }}>{backup.error}</span>
                            ) : (
                              <span className="muted">—</span>
                            )}
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
      </div>

      {/* ------------------------------------------------------------ 账号表单 */}
      <Modal
        open={userFormOpen}
        onClose={() => setUserFormOpen(false)}
        title={userForm.id ? "编辑账号" : "新建账号"}
        description={
          userForm.id
            ? "账号名不可修改；如需更换请停用后重新创建。不能停用或降级当前登录的账号。"
            : "账号由管理员线下告知老师；首次登录会要求修改初始密码。"
        }
        size="lg"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setUserFormOpen(false)} disabled={userSaving}>
              取消
            </Button>
            <Button loading={userSaving} onClick={() => void submitUserForm()}>
              {userForm.id ? "保存修改" : "创建账号"}
            </Button>
          </div>
        }
      >
        <div className="form-grid cols-2">
          <Field label="账号" required={!userForm.id} hint="3–32 位字母/数字/下划线/点，创建后不可修改">
            <Input
              value={userForm.account}
              readOnly={Boolean(userForm.id)}
              maxLength={32}
              onChange={(event) => setUserForm({ ...userForm, account: event.target.value })}
              placeholder="如 teacher4"
            />
          </Field>
          <Field label="姓名" required>
            <Input
              value={userForm.displayName}
              maxLength={50}
              onChange={(event) => setUserForm({ ...userForm, displayName: event.target.value })}
              placeholder="教师真实姓名"
            />
          </Field>
          {!userForm.id && (
            <>
              <Field label="初始密码" required hint="至少 10 位，同时含字母和数字，不能包含账号名">
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={userForm.password}
                  onChange={(event) => setUserForm({ ...userForm, password: event.target.value })}
                />
              </Field>
              <Field label="确认初始密码" required>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={userForm.confirmPassword}
                  onChange={(event) => setUserForm({ ...userForm, confirmPassword: event.target.value })}
                />
              </Field>
            </>
          )}
          <Field label="角色" required hint={userForm.id === user.id ? "不能修改当前登录账号的角色" : "角色决定系统权限边界"}>
            <Select
              value={userForm.role}
              disabled={userForm.id === user.id}
              onChange={(event) =>
                setUserForm({
                  ...userForm,
                  role: event.target.value as Role,
                  scopes: event.target.value === "DUTY_TEACHER" ? userForm.scopes : [],
                })
              }
            >
              {ROLE_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="关联教师档案" hint="可选；用于展示与记分归属">
            <Select
              value={userForm.teacherId}
              onChange={(event) => setUserForm({ ...userForm, teacherId: event.target.value })}
            >
              <option value="">不关联</option>
              {teachers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}（{item.employeeNo}）
                </option>
              ))}
            </Select>
          </Field>
          {userForm.role === "DUTY_TEACHER" && (
            <div className="span-2">
              <Field
                label="数据范围"
                required
                hint="值日老师仅能访问授权年级/班级的学生与记录；至少选择一项"
              >
                <div className="stack gap-sm">
                  <div className="inline-fields">
                    <Select
                      aria-label="范围类型"
                      value={scopeDraftType}
                      onChange={(event) => {
                        setScopeDraftType(event.target.value as "GRADE" | "CLASS");
                        setScopeDraftId("");
                      }}
                    >
                      <option value="GRADE">年级</option>
                      <option value="CLASS">班级</option>
                    </Select>
                    <Select
                      aria-label="数据范围"
                      value={scopeDraftId}
                      onChange={(event) => setScopeDraftId(event.target.value)}
                    >
                      <option value="">请选择{scopeDraftType === "GRADE" ? "年级" : "班级"}</option>
                      {scopeDraftType === "GRADE"
                        ? grades.map((grade) => (
                            <option key={grade.id} value={grade.id}>
                              {grade.name}
                            </option>
                          ))
                        : classes.map((klass) => (
                            <option key={klass.id} value={klass.id}>
                              {klass.gradeName}
                              {klass.name}
                            </option>
                          ))}
                    </Select>
                    <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={addScopeDraft} disabled={!scopeDraftId}>
                      添加范围
                    </Button>
                  </div>
                  {userForm.scopes.length === 0 ? (
                    <span className="muted text-sm">尚未授权任何数据范围</span>
                  ) : (
                    <div className="tag-list">
                      {userForm.scopes.map((scope) => (
                        <Badge key={`${scope.scopeType}:${scope.scopeId}`} tone="brand">
                          {scope.scopeType === "GRADE" ? "年级" : "班级"} · {scopeName(scope)}
                          <button
                            type="button"
                            aria-label="移除范围"
                            style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", padding: "0 0 0 4px" }}
                            onClick={() =>
                              setUserForm((current) => ({
                                ...current,
                                scopes: current.scopes.filter(
                                  (item) => !(item.scopeType === scope.scopeType && item.scopeId === scope.scopeId),
                                ),
                              }))
                            }
                          >
                            ×
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </Field>
            </div>
          )}
        </div>
        {userFormError && (
          <div className="mt-4">
            <Alert tone="danger">{userFormError}</Alert>
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------------------ 重置密码 */}
      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="重置账号密码"
        description={resetTarget ? `为「${resetTarget.displayName}（${resetTarget.account}）」设置新的初始密码。` : undefined}
        size="sm"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setResetOpen(false)} disabled={resetSaving}>
              取消
            </Button>
            <Button variant="danger" loading={resetSaving} onClick={() => void submitResetPassword()}>
              确认重置
            </Button>
          </div>
        }
      >
        <div className="stack">
          <Field label="新密码" required hint="至少 10 位，同时包含字母和数字；重置后下次登录需修改">
            <Input
              type="password"
              autoComplete="new-password"
              value={resetPassword}
              onChange={(event) => setResetPassword(event.target.value)}
            />
          </Field>
          <Field label="确认新密码" required>
            <Input
              type="password"
              autoComplete="new-password"
              value={resetConfirm}
              onChange={(event) => setResetConfirm(event.target.value)}
            />
          </Field>
          {resetError && <Alert tone="danger">{resetError}</Alert>}
          <Notice tone="warning">重置密码会使该账号现有登录会话失效，请通过线下安全渠道告知新密码。</Notice>
        </div>
      </Modal>

      {/* ------------------------------------------------------------ 荣誉表单 */}
      <Modal
        open={honorFormOpen}
        onClose={() => setHonorFormOpen(false)}
        title={honorForm.id ? "编辑荣誉条件" : "新建荣誉条件"}
        description="成长报告按「学期总分 ≥ 最低积分」且「正向记录 ≥ 最少条数」展示可参评参考。"
        size="md"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setHonorFormOpen(false)} disabled={honorSaving}>
              取消
            </Button>
            <Button loading={honorSaving} onClick={() => void submitHonorForm()}>
              {honorForm.id ? "保存修改" : "创建荣誉条件"}
            </Button>
          </div>
        }
      >
        <div className="form-grid cols-2">
          <Field label="荣誉名称" required>
            <Input
              value={honorForm.name}
              maxLength={50}
              onChange={(event) => setHonorForm({ ...honorForm, name: event.target.value })}
              placeholder="如 校级德育之星"
            />
          </Field>
          <Field label="排序号" hint="可选，数字越小越靠前">
            <Input
              type="number"
              value={honorForm.sortOrder}
              onChange={(event) => setHonorForm({ ...honorForm, sortOrder: event.target.value })}
            />
          </Field>
          <Field label="最低学期总分（分）" required>
            <Input
              type="number"
              min={0}
              value={honorForm.minPoints}
              onChange={(event) => setHonorForm({ ...honorForm, minPoints: event.target.value })}
            />
          </Field>
          <Field label="最少正向记录（条）" required>
            <Input
              type="number"
              min={0}
              value={honorForm.minPositiveRecords}
              onChange={(event) => setHonorForm({ ...honorForm, minPositiveRecords: event.target.value })}
            />
          </Field>
          <div className="span-2">
            <Field label="说明">
              <Textarea
                rows={2}
                maxLength={500}
                value={honorForm.description}
                onChange={(event) => setHonorForm({ ...honorForm, description: event.target.value })}
              />
            </Field>
          </div>
          <div className="span-2">
            <Checkbox
              label="启用该荣誉条件"
              checked={honorForm.isEnabled}
              onChange={(event) => setHonorForm({ ...honorForm, isEnabled: event.target.checked })}
            />
          </div>
        </div>
        {honorFormError && (
          <div className="mt-4">
            <Alert tone="danger">{honorFormError}</Alert>
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------------------ 兑换表单 */}
      <Modal
        open={rewardFormOpen}
        onClose={() => setRewardFormOpen(false)}
        title={rewardForm.id ? "编辑兑换项" : "新建兑换项"}
        description="兑换项仅用于成长报告中的参考展示，不会自动扣减积分。"
        size="md"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setRewardFormOpen(false)} disabled={rewardSaving}>
              取消
            </Button>
            <Button loading={rewardSaving} onClick={() => void submitRewardForm()}>
              {rewardForm.id ? "保存修改" : "创建兑换项"}
            </Button>
          </div>
        }
      >
        <div className="form-grid cols-2">
          <Field label="兑换名称" required>
            <Input
              value={rewardForm.name}
              maxLength={50}
              onChange={(event) => setRewardForm({ ...rewardForm, name: event.target.value })}
              placeholder="如 图书借阅特权"
            />
          </Field>
          <Field label="所需积分（分）" required hint="大于 0 的整数">
            <Input
              type="number"
              min={1}
              value={rewardForm.pointsCost}
              onChange={(event) => setRewardForm({ ...rewardForm, pointsCost: event.target.value })}
            />
          </Field>
          <Field label="排序号" hint="可选，数字越小越靠前">
            <Input
              type="number"
              value={rewardForm.sortOrder}
              onChange={(event) => setRewardForm({ ...rewardForm, sortOrder: event.target.value })}
            />
          </Field>
          <div className="span-2">
            <Field label="说明">
              <Textarea
                rows={2}
                maxLength={500}
                value={rewardForm.description}
                onChange={(event) => setRewardForm({ ...rewardForm, description: event.target.value })}
              />
            </Field>
          </div>
          <div className="span-2">
            <Checkbox
              label="启用该兑换项"
              checked={rewardForm.isEnabled}
              onChange={(event) => setRewardForm({ ...rewardForm, isEnabled: event.target.checked })}
            />
          </div>
        </div>
        {rewardFormError && (
          <div className="mt-4">
            <Alert tone="danger">{rewardFormError}</Alert>
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------------------ 家长分享生成 */}
      <Modal
        open={shareFormOpen}
        onClose={() => setShareFormOpen(false)}
        title={createdShare ? "分享链接已生成" : "生成家长分享链接"}
        description={
          createdShare
            ? "完整链接只在本弹窗展示一次，请立即复制并妥善保存。"
            : "选择学生与有效期后生成只读链接；家长凭链接查看该学生的成长报告。"
        }
        size="md"
        footer={
          createdShare ? (
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setShareFormOpen(false)}>
                关闭
              </Button>
              <Button icon={<Copy size={15} />} onClick={() => void copyShareLink(createdShare.url)}>
                复制链接
              </Button>
            </div>
          ) : (
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setShareFormOpen(false)} disabled={shareSaving}>
                取消
              </Button>
              <Button loading={shareSaving} icon={<Link2 size={15} />} onClick={() => void submitShareForm()}>
                生成分享链接
              </Button>
            </div>
          )
        }
      >
        {createdShare ? (
          <div className="stack">
            <Alert tone="success" title="分享链接已生成">
              请立即复制链接并通过安全渠道发送给家长；关闭弹窗后将无法再次查看完整链接，只能重新生成。
            </Alert>
            <div className="kv">
              <dt>学生</dt>
              <dd>{createdShare.studentName}</dd>
              <dt>有效期至</dt>
              <dd>{formatDateTime(createdShare.expiresAt)}</dd>
              <dt>备注</dt>
              <dd>{createdShare.label || "—"}</dd>
            </div>
            <Field label="家长分享链接" required hint="只展示一次，请勿发到班级群等公开渠道">
              <Input
                readOnly
                value={createdShare.url}
                onFocus={(event) => event.currentTarget.select()}
                aria-label="家长分享链接"
              />
            </Field>
            <Notice tone="warning">
              安全提示：仅发送给已核验身份的学生家长本人；链接到期或被撤销后立即失效；系统只保存令牌哈希，无法找回原文。
              分享页面只展示该学生个人成长信息，不含班级排名与其他学生信息。
            </Notice>
          </div>
        ) : (
          <div className="stack">
            <Field label="学生" required hint="输入姓名或学号搜索，再点击选择学生">
              {shareStudent && (
                <div className="tag-list">
                  <Badge tone="brand">
                    {shareStudent.gradeName}
                    {shareStudent.className} · {shareStudent.name}
                  </Badge>
                </div>
              )}
              <div className="search-box">
                <Search size={16} />
                <Input
                  aria-label="搜索需要分享的学生"
                  placeholder="输入学生姓名或学号搜索"
                  value={shareSearchQuery}
                  onChange={(event) => setShareSearchQuery(event.target.value)}
                />
              </div>
              {shareSearchLoading ? (
                <span className="muted text-xs">正在搜索学生…</span>
              ) : shareSearchResults.length > 0 ? (
                <div
                  style={{
                    maxHeight: 200,
                    overflowY: "auto",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                  }}
                >
                  <div className="table-wrap">
                    <table className="table">
                      <tbody>
                        {shareSearchResults.slice(0, 30).map((student) => (
                          <tr key={student.id}>
                            <td>
                              <button
                                type="button"
                                className="link"
                                style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                                onClick={() => {
                                  setShareStudent(student);
                                  setShareSearchResults([]);
                                  setShareSearchQuery("");
                                  setShareFormError("");
                                }}
                              >
                                {student.name}
                              </button>
                            </td>
                            <td>
                              {student.gradeName}
                              {student.className}
                            </td>
                            <td className="mono">{student.studentNo}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : shareSearchQuery.trim() ? (
                <span className="muted text-xs">没有匹配的学生，请检查姓名或学号</span>
              ) : null}
            </Field>
            <div className="inline-fields">
              <Field label="有效期（天）" required hint="1–90 天，默认 30 天">
                <Input
                  type="number"
                  min={1}
                  max={90}
                  value={shareExpiresInDays}
                  onChange={(event) => setShareExpiresInDays(event.target.value)}
                />
              </Field>
              <Field label="备注（可选）" hint="如：期中家长会 / 学生本人">
                <Input
                  maxLength={100}
                  value={shareLabel}
                  onChange={(event) => setShareLabel(event.target.value)}
                />
              </Field>
            </div>
            {shareFormError && <Alert tone="danger">{shareFormError}</Alert>}
            <Notice tone="info">
              分享链接为公开只读页面（凭链接访问），仅展示该学生个人成长报告，不含班级排名与其他学生信息；
              请仅发送给已核验身份的家长本人，并提醒家长不要转发。
            </Notice>
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------------------ 新建学年 */}
      <Modal
        open={yearFormOpen}
        onClose={() => setYearFormOpen(false)}
        title="新建学年"
        description="学年通常覆盖两个学期；结束日期需晚于开始日期。"
        size="md"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setYearFormOpen(false)} disabled={yearSaving}>
              取消
            </Button>
            <Button loading={yearSaving} onClick={() => void submitYearForm()}>
              创建学年
            </Button>
          </div>
        }
      >
        <div className="form-grid cols-2">
          <Field label="学年名称" required hint="如 2026-2027 学年">
            <Input
              value={yearForm.name}
              maxLength={50}
              onChange={(event) => setYearForm({ ...yearForm, name: event.target.value })}
              placeholder="如 2026-2027 学年"
            />
          </Field>
          <div />
          <Field label="开始日期" required>
            <Input
              type="date"
              value={yearForm.startDate}
              onChange={(event) => setYearForm({ ...yearForm, startDate: event.target.value })}
            />
          </Field>
          <Field label="结束日期" required>
            <Input
              type="date"
              value={yearForm.endDate}
              onChange={(event) => setYearForm({ ...yearForm, endDate: event.target.value })}
            />
          </Field>
        </div>
        {yearFormError && (
          <div className="mt-4">
            <Alert tone="danger">{yearFormError}</Alert>
          </div>
        )}
        <div className="mt-4">
          <Notice tone="info">如果是第一个学年，系统会自动将其设为当前学年；学期需在学年下单独创建。</Notice>
        </div>
      </Modal>

      {/* ------------------------------------------------------------ 新建学期 */}
      <Modal
        open={termFormOpen}
        onClose={() => setTermFormOpen(false)}
        title="新建学期"
        description="同一学年内学期名称不可重复；结束日期需晚于开始日期。"
        size="md"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setTermFormOpen(false)} disabled={termSaving}>
              取消
            </Button>
            <Button loading={termSaving} onClick={() => void submitTermForm()}>
              创建学期
            </Button>
          </div>
        }
      >
        <div className="form-grid cols-2">
          <Field label="所属学年" required>
            <Select
              value={termForm.academicYearId}
              onChange={(event) => setTermForm({ ...termForm, academicYearId: event.target.value })}
            >
              <option value="">请选择学年</option>
              {(periodsData?.years ?? []).map((year) => (
                <option key={year.id} value={year.id}>
                  {year.name}
                  {year.isCurrent ? "（当前学年）" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="学期名称" required hint="如 第一学期 / 2026 秋季学期">
            <Input
              value={termForm.name}
              maxLength={50}
              onChange={(event) => setTermForm({ ...termForm, name: event.target.value })}
              placeholder="如 第一学期"
            />
          </Field>
          <Field label="开始日期" required>
            <Input
              type="date"
              value={termForm.startDate}
              onChange={(event) => setTermForm({ ...termForm, startDate: event.target.value })}
            />
          </Field>
          <Field label="结束日期" required>
            <Input
              type="date"
              value={termForm.endDate}
              onChange={(event) => setTermForm({ ...termForm, endDate: event.target.value })}
            />
          </Field>
        </div>
        {termFormError && (
          <div className="mt-4">
            <Alert tone="danger">{termFormError}</Alert>
          </div>
        )}
        <div className="mt-4">
          <Notice tone="info">新建学期不会自动切换当前学期；如需启用请在学年学期列表中点击「设为当前学期」。</Notice>
        </div>
      </Modal>

      {/* ------------------------------------------------------------ 通用确认 */}
      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.title || ""}
        description={pendingConfirm?.description}
        confirmLabel={pendingConfirm?.confirmLabel}
        danger={pendingConfirm?.danger}
        loading={confirmLoading}
        onConfirm={() => {
          const run = pendingConfirm?.run;
          if (run) void run();
        }}
        onClose={() => {
          if (!confirmLoading) setPendingConfirm(null);
        }}
      />

      {!isSysAdmin && <span className="sr-only">当前账号不是系统管理员</span>}
    </div>
  );
}
