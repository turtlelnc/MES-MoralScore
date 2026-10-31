// Shared frontend types. Keep in sync with docs/ARCHITECTURE.md API contract.

export type Role = "SYSTEM_ADMIN" | "MORAL_AFFAIRS" | "DUTY_TEACHER";

export interface Permissions {
  manageSchool: boolean;
  manageUsers: boolean;
  manageRoster: boolean;
  manageImports: boolean;
  manageBackups: boolean;
  viewAudit: boolean;
  createRules: boolean;
  approveRules: boolean;
  score: boolean;
  reviewRecords: boolean;
  manageSubmissions: boolean;
  registerAppeals: boolean;
  decideAppeals: boolean;
  revokeRecords: boolean;
  manageShares: boolean;
  viewAnalytics: boolean;
  exportData: boolean;
  manageSystem: boolean;
}

export interface UserScope {
  scope_type: "GRADE" | "CLASS";
  scope_id: string;
  name: string;
}

export interface CurrentTerm {
  id: string;
  name: string;
  academicYearName: string;
  startDate: string;
  endDate: string;
}

export interface SessionUser {
  id: string;
  account: string;
  displayName: string;
  role: Role;
  roleLabel: string;
  schoolId: string;
  schoolName: string;
  schoolCode: string;
  schoolStage: string;
  scopes: UserScope[];
  permissions: Permissions;
  mustChangePassword: boolean;
  currentTerm: CurrentTerm | null;
  status: string;
}

export type ViewKey =
  | "dashboard"
  | "quick-score"
  | "records"
  | "students"
  | "rules"
  | "submissions"
  | "appeals"
  | "analytics"
  | "reports"
  | "admin";

export interface PageProps {
  user: SessionUser;
  onNavigate: (view: ViewKey, params?: Record<string, string>) => void;
  params: Record<string, string>;
  onRefreshUser: () => Promise<void>;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface Category {
  id: string;
  name: string;
  description: string;
  directionScope: "BOTH" | "ADD" | "DEDUCT";
  sortOrder: number;
  isEnabled: boolean;
}

export interface RuleSummary {
  id: string;
  versionId: string;
  version: number;
  name: string;
  categoryId: string;
  categoryName: string;
  direction: "ADD" | "DEDUCT";
  points: number;
  minPoints: number | null;
  maxPoints: number | null;
  targetScope: "ALL" | "GRADE" | "CLASS";
  scopeIds: string[];
  evidenceRequired: boolean;
  requiresReview: boolean;
  status: string;
  statusLabel: string;
  description: string;
  examples: string;
  changeNote: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  archived: boolean;
  active?: boolean;
}

export interface RuleVersion {
  id: string;
  version: number;
  status: string;
  statusLabel: string;
  name: string;
  description: string;
  examples: string;
  direction: "ADD" | "DEDUCT";
  points: number;
  categoryId: string;
  categoryName: string;
  targetScope: string;
  scopeIds: string[];
  evidenceRequired: boolean;
  requiresReview: boolean;
  changeNote: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
  createdByName?: string;
  approvedByName?: string;
}

export interface EvidenceRef {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
}

export interface RecordView {
  id: string;
  studentId: string;
  studentName: string;
  studentNo: string;
  classId: string;
  className: string;
  gradeName: string;
  ruleId: string | null;
  ruleVersionId: string | null;
  ruleName: string;
  categoryId: string | null;
  categoryName: string;
  direction: "ADD" | "DEDUCT";
  directionLabel: string;
  points: number;
  signedPoints: number;
  recordKind: "STANDARD" | "REVERSAL" | "CORRECTION";
  recordKindLabel: string;
  status: "EFFECTIVE" | "PENDING_REVIEW" | "REJECTED";
  statusLabel: string;
  reversed: boolean;
  reversalRecordId: string | null;
  occurrenceAt: string;
  note: string;
  evidence: EvidenceRef[];
  source: string;
  sourceLabel: string;
  submitterId: string;
  submitterName: string;
  reviewerName: string;
  reviewedAt: string | null;
  reviewNote: string;
  submissionId: string | null;
  reversesRecordId: string | null;
  correctsRecordId: string | null;
  batchId: string | null;
  createdAt: string;
  effectiveAt: string | null;
}

export interface RecordRelations {
  reversal: RecordView | null;
  correctedBy: RecordView | null;
  corrects: RecordView | null;
  appeals: AppealView[];
}

export interface StudentListItem {
  id: string;
  name: string;
  studentNo: string;
  gender: string;
  status: string;
  classId: string;
  className: string;
  gradeId: string;
  gradeName: string;
  termScore?: number;
  adds?: number;
  deducts?: number;
  recordCount?: number;
}

export interface StudentDetail {
  student: StudentListItem;
  score: {
    initialPoints: number;
    adds: number;
    deducts: number;
    net: number;
    recordCount: number;
    total: number;
  };
  recentRecords: RecordView[];
}

export interface GradeItem {
  id: string;
  name: string;
  sortOrder: number;
  classCount?: number;
  studentCount?: number;
}

export interface ClassItem {
  id: string;
  name: string;
  gradeId: string;
  gradeName: string;
  headTeacherId: string | null;
  headTeacherName: string;
  studentCount?: number;
}

export interface TeacherItem {
  id: string;
  name: string;
  employeeNo: string;
  subject: string;
  phone: string;
  status: string;
  account: string;
  userId: string | null;
  role: string;
}

export interface SubmissionView {
  id: string;
  studentId: string | null;
  studentName: string;
  studentNo: string;
  classId: string;
  className: string;
  gradeName: string;
  categoryId: string | null;
  categoryName: string;
  direction: "ADD" | "DEDUCT";
  description: string;
  status: "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "NEEDS_INFO";
  statusLabel: string;
  source: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewerName: string;
  reviewNote: string;
  scoreRecordId: string | null;
}

export interface AppealDecision {
  id: string;
  decision: "UNDER_REVIEW" | "ACCEPTED" | "REJECTED";
  decisionLabel?: string;
  reason: string;
  actorName: string;
  conflictFlag: boolean;
  conflictReason: string;
  reversalRecordId: string | null;
  correctionRecordId: string | null;
  createdAt: string;
}

export interface AppealView {
  id: string;
  recordId: string;
  studentId: string;
  studentName: string;
  studentNo?: string;
  classId: string;
  className: string;
  status: "SUBMITTED" | "UNDER_REVIEW" | "ACCEPTED" | "REJECTED";
  statusLabel: string;
  reason: string;
  evidence?: EvidenceRef[];
  submittedByName: string;
  createdAt: string;
  decidedAt: string | null;
  decisionReason: string;
  conflictFlag: boolean;
  handlerName: string;
}

export interface DashboardData {
  term: CurrentTerm & { id: string };
  kpis: {
    studentCount: number;
    classCount: number;
    avgScore: number;
    totalAdds: number;
    totalDeducts: number;
    net: number;
    recordCount: number;
    pendingReviewCount: number;
    pendingSubmissionCount: number;
    openAppealCount: number;
  };
  trend: Array<{ date: string; adds: number; deducts: number; net: number }>;
  classDistribution: Array<{
    classId: string;
    className: string;
    gradeName: string;
    avgScore: number;
    studentCount: number;
    adds: number;
    deducts: number;
  }>;
  gradeDistribution: Array<{ gradeId: string; gradeName: string; avgScore: number; studentCount: number }>;
  categories: Array<{
    categoryId: string;
    categoryName: string;
    direction: "ADD" | "DEDUCT";
    recordCount: number;
    magnitude: number;
    net: number;
  }>;
  topPositiveRules: Array<{ ruleName: string; recordCount: number; magnitude: number }>;
  alerts: Array<{ id: string; level: "warn" | "info"; title: string; description: string; count: number }>;
  recentRecords: RecordView[];
}

export interface AnalyticsOverview {
  kpis: DashboardData["kpis"];
  trend: DashboardData["trend"];
  categories: DashboardData["categories"];
  rules: Array<{ ruleName: string; recordCount: number; studentCount: number; magnitude: number; direction: "ADD" | "DEDUCT" }>;
  classComparison: DashboardData["classDistribution"];
  gradeComparison: DashboardData["gradeDistribution"];
  timeComparison: {
    label: string;
    current: { adds: number; deducts: number; net: number; recordCount: number };
    previous: { adds: number; deducts: number; net: number; recordCount: number };
  };
}

export interface StudentReport {
  student: { id: string; name: string; studentNo: string; className: string; gradeName: string };
  period: { type: "week" | "month" | "term"; label: string; from: string; to: string };
  score: {
    initialPoints: number;
    adds: number;
    deducts: number;
    net: number;
    total: number;
    recordCount: number;
  };
  composition: Array<{ categoryName: string; direction: "ADD" | "DEDUCT"; recordCount: number; magnitude: number }>;
  trend: Array<{ date: string; adds: number; deducts: number; net: number }>;
  highlights: Array<{
    ruleName: string;
    categoryName: string;
    points: number;
    note: string;
    occurrenceAt: string;
  }>;
  attention: Array<{ categoryName: string; recordCount: number; magnitude: number; direction?: "DEDUCT" }>;
  ruleExplanations: Array<{ name: string; description: string; examples: string; direction: "ADD" | "DEDUCT"; points: number }>;
  honors: Array<{ name: string; description: string; eligible: boolean; reason: string }>;
  rewards: Array<{ name: string; description: string; pointsCost: number; affordable: boolean }>;
  narrative: string[];
  privacyNote: string;
}

export interface ClassReport {
  class: { id: string; name: string; gradeName: string; studentCount: number };
  term: CurrentTerm;
  avgScore: number;
  adds: number;
  deducts: number;
  categories: DashboardData["categories"];
  trend: DashboardData["trend"];
  students: Array<{ id: string; name: string; studentNo: string; total: number; adds: number; deducts: number; recordCount: number }>;
  topPositiveRules: Array<{ ruleName: string; recordCount: number; magnitude: number }>;
  attentionRules: Array<{ ruleName: string; recordCount: number; magnitude: number }>;
}

export interface ShareItem {
  id: string;
  studentId: string;
  studentName: string;
  className: string;
  label: string;
  status: "active" | "expired" | "revoked";
  statusLabel: string;
  expiresAt: string;
  createdAt: string;
  createdByName: string;
  accessCount: number;
  lastAccessedAt: string | null;
}

export interface PublicShareView extends StudentReport {
  expiresAt: string;
  shareLabel: string;
}

export interface AdminUser {
  id: string;
  account: string;
  displayName: string;
  role: Role;
  roleLabel: string;
  status: string;
  teacherId: string | null;
  teacherName: string;
  scopes: Array<{ scopeType: "GRADE" | "CLASS"; scopeId: string; name: string }>;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AuditLogItem {
  id: string;
  actorAccount: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  summary: string;
  result: string;
  ip: string;
  createdAt: string;
}

export interface BackupItem {
  id: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  filePath: string;
  fileName: string;
  sizeBytes: number;
  error: string;
  startedAt: string;
  finishedAt: string | null;
  createdByName: string;
}

export interface ImportJobItem {
  id: string;
  kind: "students" | "classes" | "teachers";
  kindLabel: string;
  filename: string;
  status: "PREVIEW" | "COMMITTED" | "FAILED";
  statusLabel: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  resultSummary: string;
  createdByName?: string;
  createdAt: string;
  committedAt: string | null;
}

export interface ImportPreviewRow {
  rowNumber: number;
  ok: boolean;
  data: Record<string, string>;
  errors: Array<{ column: string; message: string }>;
}

export interface ImportPreview {
  job: ImportJobItem;
  preview: ImportPreviewRow[];
  headers: string[];
}

export interface OptionsData {
  grades: GradeItem[];
  classes: ClassItem[];
  categories: Category[];
  publishedRules: RuleSummary[];
  terms: Array<{ id: string; name: string; isCurrent: boolean; startDate: string; endDate: string }>;
  teachers: TeacherItem[];
}

export interface SchoolSettings {
  initialPoints: number;
  allowNegative: boolean;
  reviewThreshold: number;
}

export interface SchoolInfo {
  id: string;
  name: string;
  code: string;
  stage: string;
  address: string;
  contact: string;
}

export interface PeriodsData {
  years: Array<{
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    isCurrent: boolean;
    terms: Array<{ id: string; name: string; startDate: string; endDate: string; isCurrent: boolean }>;
  }>;
  currentTermId: string;
}

export interface HonorRule {
  id: string;
  name: string;
  description: string;
  minPoints: number;
  minPositiveRecords: number;
  isEnabled: boolean;
  sortOrder: number;
}

export interface RewardItem {
  id: string;
  name: string;
  description: string;
  pointsCost: number;
  isEnabled: boolean;
  sortOrder: number;
}
