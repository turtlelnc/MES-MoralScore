// OWNER: frontend-ops. 学生与班级管理：年级/班级/学生三级维护、学生详情、
// 新建/编辑学生、批量导入（预览 + 提交）、教师目录（只读）、家长分享链接生成。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookUser,
  CheckCircle2,
  Copy,
  Download,
  FileSpreadsheet,
  FileUp,
  GraduationCap,
  Link2,
  ListChecks,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Sprout,
  Upload,
  UserPlus,
  Users,
} from "lucide-react";
import { api, ApiError, download, json, query } from "../api";
import { formatDate, formatDateTime, formatScore } from "../format";
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
  cn,
  useToast,
} from "../components/ui";
import type {
  ClassItem,
  GradeItem,
  ImportJobItem,
  ImportPreviewRow,
  PageProps,
  Paginated,
  RecordView,
  StudentListItem,
  TeacherItem,
} from "../types";

type TabKey = "students" | "classes" | "teachers";
type ImportKind = "students" | "classes" | "teachers";

const GENDERS = ["男", "女", "其他"];

const STUDENT_STATUS_META: Record<string, { label: string; tone: "success" | "warning" | "neutral" }> = {
  ACTIVE: { label: "在读", tone: "success" },
  ARCHIVED: { label: "毕业", tone: "neutral" },
  TRANSFERRED: { label: "转学", tone: "warning" },
};

const STUDENT_STATUS_OPTIONS = [
  { value: "ACTIVE", label: "在读" },
  { value: "ARCHIVED", label: "毕业" },
  { value: "TRANSFERRED", label: "转学" },
];

const IMPORT_KINDS: Array<{ value: ImportKind; label: string; hint: string }> = [
  { value: "students", label: "学生档案", hint: "列：姓名、学号、年级、班级、性别（可选）、状态（可选）" },
  { value: "classes", label: "班级", hint: "列：年级、班级、班主任工号（可选）" },
  { value: "teachers", label: "教师档案", hint: "列：姓名、工号、学科（可选）、手机号（可选）" },
];

const IMPORT_FIELDS: Record<ImportKind, Array<{ key: string; label: string }>> = {
  students: [
    { key: "name", label: "姓名" },
    { key: "studentNo", label: "学号" },
    { key: "gradeName", label: "年级" },
    { key: "className", label: "班级" },
    { key: "gender", label: "性别" },
    { key: "status", label: "状态" },
  ],
  classes: [
    { key: "gradeName", label: "年级" },
    { key: "className", label: "班级" },
    { key: "headTeacherNo", label: "班主任工号" },
  ],
  teachers: [
    { key: "name", label: "姓名" },
    { key: "employeeNo", label: "工号" },
    { key: "subject", label: "学科" },
    { key: "phone", label: "手机号" },
  ],
};

/** 把接口错误转换为统一中文提示（401/403/404/400/500 都有明确说明）。 */
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

interface StudentDetailResponse {
  student: StudentListItem & { joinedAt?: string };
  score: {
    initialPoints: number;
    adds: number;
    deducts: number;
    net?: number;
    total: number;
    recordCount: number;
  };
  recentRecords: RecordView[];
  term?: { id: string; name: string; academicYearName?: string } | null;
}

interface StudentFormState {
  id: string;
  name: string;
  studentNo: string;
  classId: string;
  gender: string;
  status: string;
  joinedAt: string;
}

interface ClassFormState {
  id: string;
  gradeId: string;
  name: string;
  headTeacherId: string;
  sortOrder: string;
}

interface GradeFormState {
  id: string;
  name: string;
  sortOrder: string;
}

interface ImportPreviewResponse {
  job: ImportJobItem;
  preview: ImportPreviewRow[];
  template?: string[];
}

interface ShareStudentRef {
  id: string;
  name: string;
  className: string;
  gradeName: string;
}

interface CreatedShare {
  id: string;
  token: string;
  url: string;
  expiresAt: string;
  label: string;
  studentName: string;
}

/** 分享链接：优先使用服务端返回的 url（相对路径补齐 origin），否则按 token 拼接。 */
function buildShareUrl(token: string, url?: string): string {
  const origin = window.location.origin;
  if (url && /^https?:\/\//i.test(url)) return url;
  if (url) return `${origin}${url.startsWith("/") ? "" : "/"}${url}`;
  return `${origin}/#/share/${token}`;
}

function emptyStudentForm(classId = ""): StudentFormState {
  return { id: "", name: "", studentNo: "", classId, gender: "其他", status: "ACTIVE", joinedAt: "" };
}

function emptyClassForm(gradeId = ""): ClassFormState {
  return { id: "", gradeId, name: "", headTeacherId: "", sortOrder: "" };
}

function emptyGradeForm(): GradeFormState {
  return { id: "", name: "", sortOrder: "" };
}

export function StudentsPage({ user, onNavigate, params }: PageProps) {
  const toast = useToast();
  const canManage = user.permissions.manageRoster;
  const canImport = user.permissions.manageImports;
  const canViewTeachers = user.role === "SYSTEM_ADMIN" || user.role === "MORAL_AFFAIRS";

  const [tab, setTab] = useState<TabKey>("students");

  // 基础资料（年级 / 班级 / 教师目录）
  const [grades, setGrades] = useState<GradeItem[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [teachers, setTeachers] = useState<TeacherItem[]>([]);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState("");
  const [teachersError, setTeachersError] = useState("");

  // 学生筛选与列表
  const [gradeId, setGradeId] = useState(params.gradeId || "");
  const [classId, setClassId] = useState(params.classId || "");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [studentsData, setStudentsData] = useState<Paginated<StudentListItem> | null>(null);
  const [studentsLoading, setStudentsLoading] = useState(true);
  const [studentsError, setStudentsError] = useState("");
  const studentRequestRef = useRef(0);

  // 学生详情
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StudentDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  // 表单弹窗
  const [studentFormOpen, setStudentFormOpen] = useState(false);
  const [studentForm, setStudentForm] = useState<StudentFormState>(emptyStudentForm());
  const [studentFormError, setStudentFormError] = useState("");
  const [studentSaving, setStudentSaving] = useState(false);

  const [classFormOpen, setClassFormOpen] = useState(false);
  const [classForm, setClassForm] = useState<ClassFormState>(emptyClassForm());
  const [classFormError, setClassFormError] = useState("");
  const [classSaving, setClassSaving] = useState(false);

  const [gradeFormOpen, setGradeFormOpen] = useState(false);
  const [gradeForm, setGradeForm] = useState<GradeFormState>(emptyGradeForm());
  const [gradeFormError, setGradeFormError] = useState("");
  const [gradeSaving, setGradeSaving] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [classSearch, setClassSearch] = useState("");
  const [teacherSearch, setTeacherSearch] = useState("");

  // 家长分享链接（一次性展示）
  const canShare = user.permissions.manageShares;
  const [shareOpen, setShareOpen] = useState(false);
  const [shareStudent, setShareStudent] = useState<ShareStudentRef | null>(null);
  const [shareExpiresInDays, setShareExpiresInDays] = useState("30");
  const [shareLabel, setShareLabel] = useState("");
  const [shareError, setShareError] = useState("");
  const [shareSaving, setShareSaving] = useState(false);
  const [createdShare, setCreatedShare] = useState<CreatedShare | null>(null);

  const loadMeta = useCallback(async () => {
    setMetaLoading(true);
    setMetaError("");
    try {
      const [gradeData, classData] = await Promise.all([
        api<{ items: GradeItem[] }>("/grades"),
        api<{ items: ClassItem[] }>("/classes"),
      ]);
      setGrades(gradeData.items ?? []);
      setClasses(classData.items ?? []);
    } catch (error) {
      setMetaError(errorMessage(error));
    } finally {
      setMetaLoading(false);
    }
  }, []);

  const loadTeachers = useCallback(async () => {
    if (!canViewTeachers) return;
    setTeachersError("");
    try {
      const data = await api<{ items: TeacherItem[] }>("/teachers");
      setTeachers(data.items ?? []);
    } catch (error) {
      setTeachersError(errorMessage(error));
    }
  }, [canViewTeachers]);

  useEffect(() => {
    void loadMeta();
    void loadTeachers();
  }, [loadMeta, loadTeachers]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [gradeId, classId, status, debouncedSearch]);

  const loadStudents = useCallback(async () => {
    const sequence = ++studentRequestRef.current;
    setStudentsLoading(true);
    setStudentsError("");
    try {
      const data = await api<Paginated<StudentListItem>>(
        `/students${query({
          gradeId,
          classId,
          status,
          search: debouncedSearch,
          page,
          pageSize: 20,
        })}`,
      );
      if (sequence === studentRequestRef.current) setStudentsData(data);
    } catch (error) {
      if (sequence === studentRequestRef.current) {
        setStudentsData(null);
        setStudentsError(errorMessage(error));
      }
    } finally {
      if (sequence === studentRequestRef.current) setStudentsLoading(false);
    }
  }, [gradeId, classId, status, debouncedSearch, page]);

  useEffect(() => {
    void loadStudents();
  }, [loadStudents]);

  const openDetail = useCallback(
    async (studentId: string) => {
      setDetailId(studentId);
      setDetail(null);
      setDetailError("");
      setDetailLoading(true);
      try {
        const data = await api<StudentDetailResponse>(`/students/${studentId}`);
        setDetail(data);
      } catch (error) {
        setDetailError(errorMessage(error));
      } finally {
        setDetailLoading(false);
      }
    },
    [],
  );

  // 从其它页面带 studentId 进入时直接打开详情。
  const initialStudentId = params.studentId || "";
  useEffect(() => {
    if (initialStudentId) void openDetail(initialStudentId);
    // 仅在首次挂载时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const classesForGrade = useMemo(
    () => (gradeId ? classes.filter((item) => item.gradeId === gradeId) : classes),
    [classes, gradeId],
  );

  const visibleClasses = useMemo(() => {
    const needle = classSearch.trim().toLowerCase();
    return classes.filter((item) => {
      if (gradeId && item.gradeId !== gradeId) return false;
      if (!needle) return true;
      return (
        item.name.toLowerCase().includes(needle) ||
        `${item.gradeName}${item.name}`.toLowerCase().includes(needle)
      );
    });
  }, [classes, gradeId, classSearch]);

  const visibleTeachers = useMemo(() => {
    const needle = teacherSearch.trim().toLowerCase();
    if (!needle) return teachers;
    return teachers.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) ||
        item.employeeNo.toLowerCase().includes(needle) ||
        (item.subject || "").toLowerCase().includes(needle),
    );
  }, [teachers, teacherSearch]);

  function classLabel(classIdValue: string): string {
    const item = classes.find((entry) => entry.id === classIdValue);
    return item ? `${item.gradeName}${item.name}` : "—";
  }

  function openStudentCreate() {
    setStudentForm(emptyStudentForm(classId || classes[0]?.id || ""));
    setStudentFormError("");
    setStudentFormOpen(true);
  }

  function openStudentEdit(student: StudentListItem) {
    setStudentForm({
      id: student.id,
      name: student.name,
      studentNo: student.studentNo,
      classId: student.classId,
      gender: student.gender || "其他",
      status: student.status || "ACTIVE",
      joinedAt: "",
    });
    setStudentFormError("");
    setStudentFormOpen(true);
  }

  async function submitStudentForm() {
    if (!studentForm.name.trim()) return setStudentFormError("请填写学生姓名");
    if (!studentForm.studentNo.trim()) return setStudentFormError("请填写学号");
    if (!studentForm.classId) return setStudentFormError("请选择班级");
    setStudentFormError("");
    setStudentSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: studentForm.name.trim(),
        studentNo: studentForm.studentNo.trim(),
        classId: studentForm.classId,
        gender: studentForm.gender,
        status: studentForm.status,
      };
      if (studentForm.joinedAt) body.joinedAt = studentForm.joinedAt;
      if (studentForm.id) await api(`/students/${studentForm.id}`, json("PATCH", body));
      else await api("/students", json("POST", body));
      toast(studentForm.id ? "学生档案已更新" : "学生档案已创建", "success");
      setStudentFormOpen(false);
      await loadMeta();
      await loadStudents();
      if (detailId === studentForm.id) void openDetail(studentForm.id);
    } catch (error) {
      setStudentFormError(errorMessage(error));
    } finally {
      setStudentSaving(false);
    }
  }

  function openClassCreate() {
    setClassForm(emptyClassForm(gradeId || grades[0]?.id || ""));
    setClassFormError("");
    setClassFormOpen(true);
  }

  function openClassEdit(item: ClassItem) {
    setClassForm({
      id: item.id,
      gradeId: item.gradeId,
      name: item.name,
      headTeacherId: item.headTeacherId || "",
      sortOrder: "",
    });
    setClassFormError("");
    setClassFormOpen(true);
  }

  async function submitClassForm() {
    if (!classForm.gradeId) return setClassFormError("请选择年级");
    if (!classForm.name.trim()) return setClassFormError("请填写班级名称");
    setClassFormError("");
    setClassSaving(true);
    try {
      const body: Record<string, unknown> = {
        gradeId: classForm.gradeId,
        name: classForm.name.trim(),
        headTeacherId: classForm.headTeacherId,
      };
      if (classForm.sortOrder.trim()) body.sortOrder = Number(classForm.sortOrder);
      if (classForm.id) await api(`/classes/${classForm.id}`, json("PATCH", body));
      else await api("/classes", json("POST", body));
      toast(classForm.id ? "班级信息已更新" : "班级已创建", "success");
      setClassFormOpen(false);
      await loadMeta();
      await loadStudents();
    } catch (error) {
      setClassFormError(errorMessage(error));
    } finally {
      setClassSaving(false);
    }
  }

  function openGradeCreate() {
    setGradeForm(emptyGradeForm());
    setGradeFormError("");
    setGradeFormOpen(true);
  }

  function openGradeEdit(item: GradeItem) {
    setGradeForm({ id: item.id, name: item.name, sortOrder: String(item.sortOrder ?? "") });
    setGradeFormError("");
    setGradeFormOpen(true);
  }

  async function submitGradeForm() {
    if (!gradeForm.name.trim()) return setGradeFormError("请填写年级名称");
    setGradeFormError("");
    setGradeSaving(true);
    try {
      const body: Record<string, unknown> = { name: gradeForm.name.trim() };
      if (gradeForm.sortOrder.trim()) body.sortOrder = Number(gradeForm.sortOrder);
      if (gradeForm.id) await api(`/grades/${gradeForm.id}`, json("PATCH", body));
      else await api("/grades", json("POST", body));
      toast(gradeForm.id ? "年级信息已更新" : "年级已创建", "success");
      setGradeFormOpen(false);
      await loadMeta();
    } catch (error) {
      setGradeFormError(errorMessage(error));
    } finally {
      setGradeSaving(false);
    }
  }

  /* ------------------------------------------------------------- 家长分享 */
  function openShareFor(student: { id: string; name: string; className: string; gradeName: string }) {
    setShareStudent({
      id: student.id,
      name: student.name,
      className: student.className,
      gradeName: student.gradeName,
    });
    setShareExpiresInDays("30");
    setShareLabel("");
    setShareError("");
    setCreatedShare(null);
    setShareOpen(true);
  }

  async function submitShareForm() {
    if (!shareStudent) return setShareError("请选择学生");
    const days = Number(shareExpiresInDays);
    if (!Number.isSafeInteger(days) || days < 1 || days > 90)
      return setShareError("有效期必须为 1–90 天的整数");
    if (shareLabel.trim().length > 100) return setShareError("备注不能超过 100 个字符");
    setShareError("");
    setShareSaving(true);
    try {
      const data = await api<{ share: CreatedShare }>(
        "/shares",
        json("POST", { studentId: shareStudent.id, expiresInDays: days, label: shareLabel.trim() }),
      );
      setCreatedShare({ ...data.share, url: buildShareUrl(data.share.token, data.share.url) });
      toast("家长分享链接已生成，请立即复制发送给家长", "success");
    } catch (error) {
      setShareError(errorMessage(error));
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

  const termLabel = user.currentTerm ? `${user.currentTerm.academicYearName} · ${user.currentTerm.name}` : "当前学期";

  return (
    <div className="page">
      <PageHeader
        title="学生与班级"
        description={`学生档案、年级班级维护与批量导入。${termLabel}`}
        actions={
          <div className="toolbar">
            {canImport && (
              <Button variant="secondary" icon={<Upload size={15} />} onClick={() => setImportOpen(true)}>
                批量导入
              </Button>
            )}
            {canManage && tab === "students" && (
              <Button icon={<UserPlus size={16} />} onClick={openStudentCreate}>
                新建学生
              </Button>
            )}
            {canManage && tab === "classes" && (
              <>
                <Button variant="secondary" icon={<Plus size={15} />} onClick={openGradeCreate}>
                  新建年级
                </Button>
                <Button icon={<Plus size={16} />} onClick={openClassCreate}>
                  新建班级
                </Button>
              </>
            )}
          </div>
        }
      />

      <div className="stack">
        <div className="toolbar between">
          <Segmented<TabKey>
            value={tab}
            ariaLabel="学生与班级视图"
            options={[
              { value: "students", label: "学生档案" },
              { value: "classes", label: "班级与年级" },
              ...(canViewTeachers ? [{ value: "teachers" as TabKey, label: "教师目录" }] : []),
            ]}
            onChange={setTab}
          />
          {!canManage && (
            <span className="muted text-sm">当前角色为只读，修改学生/班级请联系系统管理员。</span>
          )}
        </div>

        {metaError && (
          <Alert tone="danger" title="基础资料加载失败" onRetry={() => void loadMeta()}>
            {metaError}
          </Alert>
        )}

        {tab === "students" && (
          <>
            {canManage && (
              <div className="stat-grid">
                <StatCard
                  label="当前筛选学生"
                  value={studentsData ? studentsData.total : "—"}
                  suffix="人"
                  tone="brand"
                  icon={<Users size={18} />}
                  hint="按当前年级/班级/关键词统计"
                />
                <StatCard
                  label="年级"
                  value={grades.length}
                  suffix="个"
                  tone="neutral"
                  icon={<GraduationCap size={18} />}
                />
                <StatCard
                  label="班级"
                  value={classes.length}
                  suffix="个"
                  tone="neutral"
                  icon={<BookUser size={18} />}
                />
                <StatCard
                  label="教师档案"
                  value={canViewTeachers ? teachers.length : "—"}
                  suffix={canViewTeachers ? "人" : ""}
                  tone="add"
                  icon={<Users size={18} />}
                  hint={canViewTeachers ? "只读目录，账号在系统管理中创建" : "当前角色不可查看教师目录"}
                />
              </div>
            )}

            <Card padded={false}>
              <div className="toolbar filters" style={{ padding: "12px 14px" }}>
                <Select
                  aria-label="按年级筛选"
                  style={{ flex: "1 1 140px", minWidth: 0 }}
                  value={gradeId}
                  onChange={(event) => {
                    const nextGrade = event.target.value;
                    setGradeId(nextGrade);
                    if (classId && !classes.some((item) => item.id === classId && item.gradeId === nextGrade))
                      setClassId("");
                  }}
                >
                  <option value="">全部年级</option>
                  {grades.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
                <Select aria-label="按班级筛选" style={{ flex: "1 1 140px", minWidth: 0 }} value={classId} onChange={(event) => setClassId(event.target.value)}>
                  <option value="">全部班级</option>
                  {classesForGrade.map((item) => (
                    <option key={item.id} value={item.id}>
                      {gradeId ? item.name : `${item.gradeName}${item.name}`}
                    </option>
                  ))}
                </Select>
                <Select aria-label="按状态筛选" style={{ flex: "1 1 140px", minWidth: 0 }} value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="">全部状态</option>
                  {STUDENT_STATUS_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </Select>
                <div className="search-box">
                  <Search size={16} />
                  <Input
                    aria-label="搜索学生"
                    placeholder="搜索姓名 / 学号"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void loadStudents()}>
                  刷新
                </Button>
              </div>
              {studentsError ? (
                <div style={{ padding: 14 }}>
                  <Alert tone="danger" title="学生列表加载失败" onRetry={() => void loadStudents()}>
                    {studentsError}
                  </Alert>
                </div>
              ) : studentsLoading ? (
                <Loading label="正在加载学生档案…" />
              ) : !studentsData || studentsData.items.length === 0 ? (
                <EmptyState
                  title="没有符合条件的学生"
                  description="可调整年级、班级或关键词；若名册为空，请先新建班级并添加学生，或使用批量导入。"
                  icon={<Users size={22} />}
                  action={
                    canManage ? (
                      <Button size="sm" onClick={openStudentCreate} icon={<UserPlus size={15} />}>
                        新建学生
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>学号</th>
                          <th>姓名</th>
                          <th>班级</th>
                          <th>性别</th>
                          <th>当前学期积分</th>
                          <th>状态</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {studentsData.items.map((item) => {
                          const statusMeta = STUDENT_STATUS_META[item.status] || {
                            label: item.status,
                            tone: "neutral" as const,
                          };
                          return (
                            <tr key={item.id}>
                              <td className="mono">{item.studentNo}</td>
                              <td>
                                <button
                                  type="button"
                                  className="link"
                                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                                  onClick={() => void openDetail(item.id)}
                                >
                                  {item.name}
                                </button>
                              </td>
                              <td>
                                {item.gradeName}
                                {item.className}
                              </td>
                              <td>{item.gender || "—"}</td>
                              <td>
                                <strong className="amount">{formatScore(item.termScore)}</strong>
                                <span className="muted text-xs"> 分</span>
                              </td>
                              <td>
                                <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                              </td>
                              <td>
                                <div className="toolbar" style={{ gap: 4 }}>
                                  <Button size="sm" variant="ghost" onClick={() => void openDetail(item.id)}>
                                    详情
                                  </Button>
                                  {canManage && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      icon={<Pencil size={13} />}
                                      onClick={() => openStudentEdit(item)}
                                    >
                                      编辑
                                    </Button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ padding: "0 14px 12px" }}>
                    <Pagination
                      page={studentsData.page}
                      totalPages={studentsData.totalPages}
                      total={studentsData.total}
                      onChange={setPage}
                      unit="名学生"
                    />
                  </div>
                </>
              )}
            </Card>
          </>
        )}

        {tab === "classes" && (
          <>
            <Card
              title="年级"
              subtitle="年级下可维护班级；删除受历史数据保护，当前仅支持新建与重命名。"
              actions={
                canManage ? (
                  <Button size="sm" icon={<Plus size={14} />} onClick={openGradeCreate}>
                    新建年级
                  </Button>
                ) : undefined
              }
              padded={false}
            >
              {metaLoading ? (
                <Loading label="正在加载年级…" />
              ) : grades.length === 0 ? (
                <EmptyState title="还没有年级" description="请先创建年级，再创建班级和学生。" icon={<GraduationCap size={22} />} />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>年级</th>
                        <th>班级数</th>
                        <th>在读学生</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grades.map((item) => (
                        <tr key={item.id}>
                          <td className="cell-strong">{item.name}</td>
                          <td>{item.classCount ?? "—"}</td>
                          <td>{item.studentCount ?? "—"}</td>
                          <td>
                            {canManage ? (
                              <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => openGradeEdit(item)}>
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

            <Card
              title="班级"
              subtitle={`共 ${classes.length} 个班级`}
              actions={
                <div className="toolbar">
                  <div className="search-box">
                    <Search size={15} />
                    <Input
                      aria-label="搜索班级"
                      placeholder="搜索班级"
                      value={classSearch}
                      onChange={(event) => setClassSearch(event.target.value)}
                      style={{ minWidth: 150 }}
                    />
                  </div>
                  {canManage && (
                    <Button size="sm" icon={<Plus size={14} />} onClick={openClassCreate}>
                      新建班级
                    </Button>
                  )}
                </div>
              }
              padded={false}
            >
              <div className="toolbar filters" style={{ padding: "10px 14px 0" }}>
                <Select aria-label="按年级筛选班级" value={gradeId} onChange={(event) => setGradeId(event.target.value)}>
                  <option value="">全部年级</option>
                  {grades.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </div>
              {metaLoading ? (
                <Loading label="正在加载班级…" />
              ) : visibleClasses.length === 0 ? (
                <EmptyState
                  title="没有符合条件的班级"
                  description="可切换年级筛选，或新建班级。"
                  icon={<BookUser size={22} />}
                  action={
                    canManage ? (
                      <Button size="sm" onClick={openClassCreate} icon={<Plus size={14} />}>
                        新建班级
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>班级</th>
                        <th>年级</th>
                        <th>班主任</th>
                        <th>在读学生</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleClasses.map((item) => (
                        <tr key={item.id}>
                          <td className="cell-strong">{item.name}</td>
                          <td>{item.gradeName}</td>
                          <td>{item.headTeacherName || "—"}</td>
                          <td>{item.studentCount ?? "—"}</td>
                          <td>
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<Users size={13} />}
                              onClick={() => {
                                setClassId(item.id);
                                setGradeId(item.gradeId);
                                setTab("students");
                              }}
                            >
                              查看学生
                            </Button>
                            {canManage && (
                              <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => openClassEdit(item)}>
                                编辑
                              </Button>
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

        {tab === "teachers" && canViewTeachers && (
          <Card
            title="教师目录"
            subtitle="只读档案；教师登录账号请在「系统管理 → 账号与范围」中创建和授权。"
            actions={
              <div className="toolbar">
                <div className="search-box">
                  <Search size={15} />
                  <Input
                    aria-label="搜索教师"
                    placeholder="搜索姓名 / 工号 / 学科"
                    value={teacherSearch}
                    onChange={(event) => setTeacherSearch(event.target.value)}
                    style={{ minWidth: 170 }}
                  />
                </div>
                <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void loadTeachers()}>
                  刷新
                </Button>
              </div>
            }
            padded={false}
          >
            {teachersError ? (
              <div style={{ padding: 14 }}>
                <Alert tone="danger" title="教师目录加载失败" onRetry={() => void loadTeachers()}>
                  {teachersError}
                </Alert>
              </div>
            ) : visibleTeachers.length === 0 ? (
              <EmptyState
                title={teacherSearch ? "没有匹配的教师" : "教师目录为空"}
                description={
                  teacherSearch ? "请调整关键词后重试。" : "可通过批量导入教师档案，或由系统管理员在后续版本中录入。"
                }
                icon={<Users size={22} />}
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>姓名</th>
                      <th>工号</th>
                      <th>学科</th>
                      <th>手机号</th>
                      <th>登录账号</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTeachers.map((item) => (
                      <tr key={item.id}>
                        <td className="cell-strong">{item.name}</td>
                        <td className="mono">{item.employeeNo}</td>
                        <td>{item.subject || "—"}</td>
                        <td className="mono">{item.phone || "—"}</td>
                        <td>{item.account || <span className="muted">未开通</span>}</td>
                        <td>
                          <Badge tone={item.status === "ACTIVE" ? "success" : "neutral"}>
                            {item.status === "ACTIVE" ? "在职" : "已归档"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {canImport && !canManage && (
          <Notice tone="warning">批量导入仅系统管理员可用，当前账号没有导入权限。</Notice>
        )}
      </div>

      {/* ------------------------------------------------------------ 学生详情 */}
      <Modal
        open={detailId !== null}
        onClose={() => {
          setDetailId(null);
          setDetail(null);
          setDetailError("");
        }}
        title={detail ? `${detail.student.name} · 学生详情` : "学生详情"}
        description={detail ? `${detail.student.gradeName}${detail.student.className} · 学号 ${detail.student.studentNo}` : undefined}
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
            {detail && (
              <>
                <Button
                  variant="secondary"
                  icon={<ListChecks size={15} />}
                  onClick={() => {
                    setDetailId(null);
                    onNavigate("records", { studentId: detail.student.id });
                  }}
                >
                  查看积分记录
                </Button>
                {canShare && (
                  <Button
                    variant="secondary"
                    icon={<Share2 size={15} />}
                    onClick={() =>
                      openShareFor({
                        id: detail.student.id,
                        name: detail.student.name,
                        className: detail.student.className,
                        gradeName: detail.student.gradeName,
                      })
                    }
                  >
                    家长分享
                  </Button>
                )}
                <Button
                  icon={<Sprout size={15} />}
                  onClick={() => {
                    setDetailId(null);
                    onNavigate("reports", { studentId: detail.student.id });
                  }}
                >
                  去成长报告
                </Button>
              </>
            )}
          </div>
        }
      >
        {detailLoading ? (
          <Loading label="正在加载学生详情…" />
        ) : detailError ? (
          <Alert tone="danger" title="学生详情加载失败" onRetry={() => detailId && void openDetail(detailId)}>
            {detailError}
          </Alert>
        ) : detail ? (
          <div className="stack">
            <div className="report-grid">
              <div className="report-stat">
                <div className="report-stat-label">初始分</div>
                <div className="report-stat-value">{formatScore(detail.score.initialPoints)}</div>
              </div>
              <div className="report-stat">
                <div className="report-stat-label">累计加分</div>
                <div className="report-stat-value score-add">+{formatScore(detail.score.adds)}</div>
              </div>
              <div className="report-stat">
                <div className="report-stat-label">累计减分</div>
                <div className="report-stat-value score-deduct">-{formatScore(detail.score.deducts)}</div>
              </div>
              <div className="report-stat">
                <div className="report-stat-label">当前学期总分</div>
                <div className="report-stat-value">{formatScore(detail.score.total)}</div>
              </div>
            </div>
            <div className="row between">
              <span className="muted text-sm">
                本学期共 {detail.score.recordCount} 条记录 · {detail.term?.name || termLabel}
              </span>
              <span className="muted text-xs">完成于 {formatDateTime(new Date())}</span>
            </div>

            <div>
              <div className="report-section-title">最近积分记录</div>
              {detail.recentRecords.length === 0 ? (
                <EmptyState compact title="本学期暂无积分记录" description="记分后这里会显示最近 10 条记录。" />
              ) : (
                <div className="list">
                  {detail.recentRecords.map((record) => (
                    <div className="list-item" key={record.id}>
                      <div className="list-main">
                        <div className="list-title">
                          {record.ruleName}
                          <Badge tone={record.direction === "ADD" ? "add" : "deduct"}>
                            {record.direction === "ADD" ? "加分" : "减分"}
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
                          {record.categoryName} · {formatDateTime(record.occurrenceAt)} · {record.submitterName}
                          {record.note ? ` · ${record.note}` : ""}
                        </div>
                      </div>
                      <div className={cn("list-side", "score-value", record.direction === "ADD" ? "score-add" : "score-deduct")}>
                        <span>{record.direction === "ADD" ? "+" : "-"}</span>
                        {formatScore(record.points)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="row between">
              {canManage ? (
                <Button size="sm" variant="secondary" icon={<Pencil size={14} />} onClick={() => openStudentEdit(detail.student)}>
                  编辑学生档案
                </Button>
              ) : (
                <span className="muted text-xs">学生档案为只读，如需修改请联系系统管理员。</span>
              )}
              <span className="muted text-xs">历史记录按规则快照展示，规则改版不影响已发生记录。</span>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ------------------------------------------------------------ 学生表单 */}
      <Modal
        open={studentFormOpen}
        onClose={() => setStudentFormOpen(false)}
        title={studentForm.id ? "编辑学生档案" : "新建学生"}
        description={studentForm.id ? "学号在全校范围内唯一。" : "学生创建后即可参与记分，可在详情中查看成长记录。"}
        size="md"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setStudentFormOpen(false)} disabled={studentSaving}>
              取消
            </Button>
            <Button loading={studentSaving} onClick={() => void submitStudentForm()}>
              {studentForm.id ? "保存修改" : "创建学生"}
            </Button>
          </div>
        }
      >
        <div className="form-grid cols-2">
          <Field label="姓名" required>
            <Input
              value={studentForm.name}
              maxLength={50}
              onChange={(event) => setStudentForm({ ...studentForm, name: event.target.value })}
              placeholder="学生姓名"
            />
          </Field>
          <Field label="学号" required hint="全校唯一，建议使用学籍号">
            <Input
              value={studentForm.studentNo}
              maxLength={40}
              onChange={(event) => setStudentForm({ ...studentForm, studentNo: event.target.value })}
              placeholder="如 2026001"
            />
          </Field>
          <Field label="班级" required>
            <Select
              value={studentForm.classId}
              onChange={(event) => setStudentForm({ ...studentForm, classId: event.target.value })}
            >
              <option value="">请选择班级</option>
              {classes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.gradeName}
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="性别">
            <Select
              value={studentForm.gender}
              onChange={(event) => setStudentForm({ ...studentForm, gender: event.target.value })}
            >
              {GENDERS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="学籍状态">
            <Select
              value={studentForm.status}
              onChange={(event) => setStudentForm({ ...studentForm, status: event.target.value })}
            >
              {STUDENT_STATUS_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="入学日期" hint="可选，格式 YYYY-MM-DD">
            <Input
              type="date"
              value={studentForm.joinedAt}
              onChange={(event) => setStudentForm({ ...studentForm, joinedAt: event.target.value })}
            />
          </Field>
        </div>
        {studentFormError && (
          <div className="mt-4">
            <Alert tone="danger">{studentFormError}</Alert>
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------------------ 班级表单 */}
      <Modal
        open={classFormOpen}
        onClose={() => setClassFormOpen(false)}
        title={classForm.id ? "编辑班级" : "新建班级"}
        description="班级隶属于年级，学生只能在班级之间流转。"
        size="md"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setClassFormOpen(false)} disabled={classSaving}>
              取消
            </Button>
            <Button loading={classSaving} onClick={() => void submitClassForm()}>
              {classForm.id ? "保存修改" : "创建班级"}
            </Button>
          </div>
        }
      >
        <div className="form-grid cols-2">
          <Field label="年级" required>
            <Select
              value={classForm.gradeId}
              onChange={(event) => setClassForm({ ...classForm, gradeId: event.target.value })}
            >
              <option value="">请选择年级</option>
              {grades.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="班级名称" required hint="如 1班 / 二班">
            <Input
              value={classForm.name}
              maxLength={30}
              onChange={(event) => setClassForm({ ...classForm, name: event.target.value })}
              placeholder="如 1班"
            />
          </Field>
          <Field label="班主任" hint="从教师目录中选择，可留空">
            <Select
              value={classForm.headTeacherId}
              onChange={(event) => setClassForm({ ...classForm, headTeacherId: event.target.value })}
              disabled={!canViewTeachers}
            >
              <option value="">暂不指定</option>
              {teachers
                .filter((item) => item.status === "ACTIVE")
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}（{item.employeeNo}）
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="排序号" hint="可选，数字越小越靠前">
            <Input
              type="number"
              min={0}
              max={9999}
              value={classForm.sortOrder}
              onChange={(event) => setClassForm({ ...classForm, sortOrder: event.target.value })}
            />
          </Field>
        </div>
        {classFormError && (
          <div className="mt-4">
            <Alert tone="danger">{classFormError}</Alert>
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------------------ 年级表单 */}
      <Modal
        open={gradeFormOpen}
        onClose={() => setGradeFormOpen(false)}
        title={gradeForm.id ? "编辑年级" : "新建年级"}
        description="年级名称需与导入文件中的「年级」列保持一致。"
        size="sm"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setGradeFormOpen(false)} disabled={gradeSaving}>
              取消
            </Button>
            <Button loading={gradeSaving} onClick={() => void submitGradeForm()}>
              {gradeForm.id ? "保存修改" : "创建年级"}
            </Button>
          </div>
        }
      >
        <div className="stack">
          <Field label="年级名称" required>
            <Input
              value={gradeForm.name}
              maxLength={30}
              onChange={(event) => setGradeForm({ ...gradeForm, name: event.target.value })}
              placeholder="如 七年级"
            />
          </Field>
          <Field label="排序号" hint="可选，数字越小越靠前">
            <Input
              type="number"
              min={0}
              max={9999}
              value={gradeForm.sortOrder}
              onChange={(event) => setGradeForm({ ...gradeForm, sortOrder: event.target.value })}
            />
          </Field>
          {gradeFormError && <Alert tone="danger">{gradeFormError}</Alert>}
        </div>
      </Modal>

      {/* ------------------------------------------------------------ 家长分享 */}
      <Modal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        title={createdShare ? "分享链接已生成" : "生成家长分享链接"}
        description={
          createdShare
            ? "完整链接只在本弹窗展示一次，请立即复制并妥善保存。"
            : shareStudent
              ? `${shareStudent.gradeName}${shareStudent.className} · ${shareStudent.name}`
              : undefined
        }
        size="md"
        footer={
          createdShare ? (
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setShareOpen(false)}>
                关闭
              </Button>
              <Button icon={<Copy size={15} />} onClick={() => void copyShareLink(createdShare.url)}>
                复制链接
              </Button>
            </div>
          ) : (
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setShareOpen(false)} disabled={shareSaving}>
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
            <Alert tone="success" title="家长分享链接已生成">
              请立即复制链接并发送给家长；关闭弹窗后将无法再次查看完整链接，只能重新生成。
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
            {shareError && <Alert tone="danger">{shareError}</Alert>}
            <Notice tone="info">
              家长通过链接只读查看该学生的成长报告；系统不展示班级排名与其他学生信息。请仅通过安全渠道发送给已核验身份的家长，
              链接到期或被撤销后立即失效。
            </Notice>
          </div>
        )}
      </Modal>

      {canImport && (
        <ImportModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={async () => {
            await loadMeta();
            await loadStudents();
          }}
        />
      )}
    </div>
  );
}

/* ======================================================================== 批量导入 */
function ImportModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<ImportKind>("students");
  const [file, setFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<ImportPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState("");
  const [committed, setCommitted] = useState<{ job: ImportJobItem; inserted: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setKind("students");
    setFile(null);
    setPreviewData(null);
    setCommitted(null);
    setError("");
    setPreviewing(false);
    setCommitting(false);
    setConfirmOpen(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [open]);

  const kindMeta = IMPORT_KINDS.find((item) => item.value === kind) ?? IMPORT_KINDS[0];

  async function handleDownloadTemplate() {
    try {
      await download(`/imports/template.csv?kind=${kind}`, `导入模板-${kindMeta.label}.csv`);
    } catch (downloadError) {
      toast(errorMessage(downloadError), "error");
    }
  }

  async function handleDownloadErrors() {
    if (!previewData) return;
    try {
      await download(`/imports/${previewData.job.id}/errors.csv`, `导入错误-${previewData.job.id}.csv`);
    } catch (downloadError) {
      toast(errorMessage(downloadError), "error");
    }
  }

  async function handlePreview() {
    setError("");
    setCommitted(null);
    if (!file) {
      setError("请选择需要导入的 CSV 文件");
      return;
    }
    if (!/\.csv$/i.test(file.name)) {
      setError("仅支持 .csv 文件，请另存为 UTF-8 CSV 后重试");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("文件不能超过 2MB，请拆分后重试");
      return;
    }
    setPreviewing(true);
    try {
      const formData = new FormData();
      formData.append("kind", kind);
      formData.append("file", file);
      const data = await api<ImportPreviewResponse>("/imports/preview", { method: "POST", body: formData });
      setPreviewData(data);
      if (data.job.errorRows > 0) toast(`预览完成：${data.job.errorRows} 行存在错误，请修正后重新上传`, "warning");
      else toast(`预览完成：${data.job.validRows} 行可导入`, "success");
    } catch (previewError) {
      setError(errorMessage(previewError));
      setPreviewData(null);
    } finally {
      setPreviewing(false);
    }
  }

  async function handleCommit() {
    if (!previewData) return;
    setConfirmOpen(false);
    setCommitting(true);
    setError("");
    try {
      const data = await api<{ job: ImportJobItem; inserted: number }>(`/imports/${previewData.job.id}/commit`, {
        method: "POST",
        body: "{}",
      });
      setCommitted({ job: data.job, inserted: Number(data.inserted) || 0 });
      setPreviewData({ ...previewData, job: data.job });
      toast(`导入成功：${data.inserted} 条${kindMeta.label}`, "success");
      await onImported();
    } catch (commitError) {
      setError(errorMessage(commitError));
      toast("导入失败，事务已回滚，未产生半批数据", "error");
    } finally {
      setCommitting(false);
    }
  }

  const canCommit = Boolean(previewData && previewData.job.errorRows === 0 && previewData.job.status === "PREVIEW" && !committed);

  return (
    <>
      <Modal
        open={open}
        onClose={() => {
          if (committing) return;
          onClose();
        }}
        title="批量导入"
        description="先上传 CSV 预览逐行校验，确认后一次性事务提交；任何错误都会整体回滚。"
        size="xl"
        footer={
          <div className="modal-actions">
            <Button variant="secondary" onClick={onClose} disabled={committing}>
              {committed ? "完成" : "取消"}
            </Button>
            {previewData && previewData.job.errorRows > 0 && (
              <Button variant="secondary" icon={<Download size={15} />} onClick={() => void handleDownloadErrors()}>
                下载错误明细
              </Button>
            )}
            <Button
              loading={previewing}
              variant={previewData ? "secondary" : "primary"}
              icon={<FileUp size={15} />}
              onClick={() => void handlePreview()}
              disabled={previewing || committing || !file}
            >
              上传预览
            </Button>
            {canCommit && (
              <Button loading={committing} icon={<CheckCircle2 size={15} />} onClick={() => setConfirmOpen(true)}>
                确认导入 {previewData?.job.validRows} 行
              </Button>
            )}
          </div>
        }
      >
        <div className="stack">
          <div className="form-grid cols-2">
            <Field label="导入类型" required hint={kindMeta.hint}>
              <Select
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as ImportKind);
                  setPreviewData(null);
                  setCommitted(null);
                  setError("");
                }}
              >
                {IMPORT_KINDS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="CSV 文件" required hint="UTF-8 编码（可带 BOM），不超过 2MB、2000 行">
              <div className="inline-fields">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="input"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setPreviewData(null);
                    setCommitted(null);
                    setError("");
                  }}
                />
                <Button variant="secondary" size="sm" icon={<Download size={14} />} onClick={() => void handleDownloadTemplate()}>
                  下载模板
                </Button>
              </div>
            </Field>
          </div>

          {file && (
            <div className="muted text-sm">
              <FileSpreadsheet size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
              {file.name} · {(file.size / 1024).toFixed(1)} KB
            </div>
          )}

          {error && <Alert tone="danger">{error}</Alert>}

          {committed && (
            <Alert tone="success" title="导入完成">
              已成功导入 {committed.inserted} 条{kindMeta.label}，导入任务状态：{committed.job.statusLabel}。
              如需继续导入，请重新选择文件上传预览。
            </Alert>
          )}

          {previewData && (
            <>
              <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
                <div className="toolbar">
                  <Badge tone="info">共 {previewData.job.totalRows} 行</Badge>
                  <Badge tone="success">可导入 {previewData.job.validRows} 行</Badge>
                  <Badge tone={previewData.job.errorRows > 0 ? "danger" : "neutral"}>
                    错误 {previewData.job.errorRows} 行
                  </Badge>
                  <span className="muted text-xs">{previewData.job.filename}</span>
                </div>
                {previewData.job.errorRows > 0 && (
                  <span className="muted text-xs">存在错误行时禁止提交，请修正后重新上传。</span>
                )}
              </div>

              <div className="table-wrap" style={{ maxHeight: 380, overflowY: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>行号</th>
                      <th>校验</th>
                      {IMPORT_FIELDS[kind].map((field) => (
                        <th key={field.key}>{field.label}</th>
                      ))}
                      <th>错误明细</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.preview.map((row) => (
                      <tr key={row.rowNumber}>
                        <td className="mono">{row.rowNumber}</td>
                        <td>
                          {row.ok ? <Badge tone="success">通过</Badge> : <Badge tone="danger">错误</Badge>}
                        </td>
                        {IMPORT_FIELDS[kind].map((field) => (
                          <td key={field.key}>{String((row.data as Record<string, unknown>)?.[field.key] ?? "—")}</td>
                        ))}
                        <td>
                          {row.errors.length === 0 ? (
                            <span className="muted">—</span>
                          ) : (
                            <div className="stack" style={{ gap: 2 }}>
                              {row.errors.map((item, index) => (
                                <span key={index} className="text-xs" style={{ color: "var(--deduct)" }}>
                                  {item.column}：{item.message}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted text-xs" style={{ margin: 0 }}>
                预览只做校验，不会写入正式数据；确认导入时全部有效行一起提交，任一行失败将整体回滚。
              </p>
            </>
          )}

          {!previewData && !error && (
            <Notice tone="info">
              1. 选择导入类型并下载模板；2. 按模板填写并保存为 UTF-8 CSV；3. 上传预览并修正错误；
              4. 确认导入。教师导入只创建教师档案，不会自动生成登录账号。
            </Notice>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmOpen}
        title="确认执行批量导入？"
        description={`将一次性导入 ${previewData?.job.validRows ?? 0} 条${kindMeta.label}数据。提交后不可撤销，若数据库写入失败将整体回滚。`}
        confirmLabel="确认导入"
        loading={committing}
        onConfirm={() => void handleCommit()}
        onClose={() => setConfirmOpen(false)}
      >
        <div className="stack">
          <div className="kv">
            <dt>导入类型</dt>
            <dd>{kindMeta.label}</dd>
            <dt>文件</dt>
            <dd>{previewData?.job.filename || "—"}</dd>
            <dt>有效行数</dt>
            <dd>{previewData?.job.validRows ?? 0} 行</dd>
          </div>
          <Notice tone="warning">导入为全有或全无：任何一行失败都会回滚整批数据。</Notice>
        </div>
      </ConfirmDialog>
    </>
  );
}
