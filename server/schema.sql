-- MES-MoralScore schema. SQLite (node:sqlite DatabaseSync), applied idempotently.
-- 账本不可篡改、规则版本不可静默覆盖、审计日志不可修改均由触发器在数据库层兜底。
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS app_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 三大核心角色固定，不允许新增平级管理角色。
CREATE TABLE IF NOT EXISTS roles(
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO roles(code,name,description) VALUES
  ('SYSTEM_ADMIN','系统管理员','学校基础资料、账号与数据范围、导入导出、备份与审计；不直接发布德育评分标准'),
  ('MORAL_AFFAIRS','德育处/政教处','评分标准审核发布、全校数据看板、积分复核、申诉裁决与报表导出'),
  ('DUTY_TEACHER','值日老师','授权范围内的日常记分、学生干部申报初审、学生档案与积分查询');

CREATE TABLE IF NOT EXISTS schools(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL DEFAULT '初中' CHECK(stage IN('小学','初中','高中')),
  address TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS academic_years(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN(0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(school_id,name)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_years_current ON academic_years(school_id) WHERE is_current=1;

CREATE TABLE IF NOT EXISTS terms(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id TEXT NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN(0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(academic_year_id,name)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_terms_current ON terms(school_id) WHERE is_current=1;

CREATE TABLE IF NOT EXISTS grades(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(school_id,name)
);

CREATE TABLE IF NOT EXISTS teachers(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  employee_no TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','ARCHIVED')),
  created_at TEXT NOT NULL,
  UNIQUE(school_id,employee_no)
);

CREATE TABLE IF NOT EXISTS classes(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  grade_id TEXT NOT NULL REFERENCES grades(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  head_teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(school_id,grade_id,name)
);

CREATE TABLE IF NOT EXISTS students(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  grade_id TEXT NOT NULL REFERENCES grades(id),
  class_id TEXT NOT NULL REFERENCES classes(id),
  student_no TEXT NOT NULL,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT '其他' CHECK(gender IN('男','女','其他')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','ARCHIVED','TRANSFERRED')),
  joined_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(school_id,student_no)
);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id,status);
CREATE INDEX IF NOT EXISTS idx_students_name ON students(school_id,name);
CREATE INDEX IF NOT EXISTS idx_students_no ON students(school_id,student_no);

CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  account TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL REFERENCES roles(code),
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','DISABLED')),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN(0,1)),
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS user_scopes(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK(scope_type IN('GRADE','CLASS')),
  scope_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id,scope_type,scope_id)
);
CREATE INDEX IF NOT EXISTS idx_user_scopes_user ON user_scopes(user_id);

CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS scoring_categories(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  direction_scope TEXT NOT NULL DEFAULT 'BOTH' CHECK(direction_scope IN('BOTH','ADD','DEDUCT')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK(is_enabled IN(0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(school_id,name)
);

CREATE TABLE IF NOT EXISTS scoring_rules(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  active_version_id TEXT,
  latest_version INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_school ON scoring_rules(school_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS scoring_rule_versions(
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES scoring_rules(id) ON DELETE CASCADE,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','SUBMITTED','APPROVED','PUBLISHED','REJECTED','ARCHIVED')),
  category_id TEXT NOT NULL REFERENCES scoring_categories(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  examples TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL CHECK(direction IN('ADD','DEDUCT')),
  points INTEGER NOT NULL CHECK(points>0),
  min_points INTEGER,
  max_points INTEGER,
  target_scope TEXT NOT NULL DEFAULT 'ALL' CHECK(target_scope IN('ALL','GRADE','CLASS')),
  scope_json TEXT NOT NULL DEFAULT '[]',
  evidence_required INTEGER NOT NULL DEFAULT 0 CHECK(evidence_required IN(0,1)),
  requires_review INTEGER NOT NULL DEFAULT 0 CHECK(requires_review IN(0,1)),
  change_note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  submitted_by TEXT REFERENCES users(id),
  submitted_at TEXT,
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  published_at TEXT,
  effective_from TEXT,
  effective_to TEXT,
  UNIQUE(rule_id,version)
);
CREATE INDEX IF NOT EXISTS idx_rule_versions_rule ON scoring_rule_versions(rule_id,version DESC);
CREATE INDEX IF NOT EXISTS idx_rule_versions_status ON scoring_rule_versions(school_id,status);

-- 已提交/已发布版本的规则内容不可静默覆盖：修改必须生成新版本。
CREATE TRIGGER IF NOT EXISTS trg_rule_version_no_delete
BEFORE DELETE ON scoring_rule_versions
WHEN OLD.status IN ('SUBMITTED','APPROVED','PUBLISHED','ARCHIVED')
BEGIN SELECT RAISE(ABORT,'已提交或已发布的规则版本不可删除'); END;

CREATE TRIGGER IF NOT EXISTS trg_rule_version_no_content_update
BEFORE UPDATE ON scoring_rule_versions
WHEN OLD.status IN ('APPROVED','PUBLISHED','ARCHIVED')
 AND (
   NEW.rule_id IS NOT OLD.rule_id OR NEW.version IS NOT OLD.version
   OR NEW.category_id IS NOT OLD.category_id OR NEW.name IS NOT OLD.name
   OR NEW.description IS NOT OLD.description OR NEW.examples IS NOT OLD.examples
   OR NEW.direction IS NOT OLD.direction OR NEW.points IS NOT OLD.points
   OR NEW.min_points IS NOT OLD.min_points OR NEW.max_points IS NOT OLD.max_points
   OR NEW.target_scope IS NOT OLD.target_scope OR NEW.scope_json IS NOT OLD.scope_json
   OR NEW.evidence_required IS NOT OLD.evidence_required OR NEW.requires_review IS NOT OLD.requires_review
 )
BEGIN SELECT RAISE(ABORT,'已审核/已发布的规则版本不可修改，请创建新版本'); END;

-- 生效时间只允许在审核→发布时写入一次；发布后不可再改。
CREATE TRIGGER IF NOT EXISTS trg_rule_version_windows_immutable
BEFORE UPDATE ON scoring_rule_versions
WHEN OLD.status IN ('PUBLISHED','ARCHIVED')
 AND (NEW.effective_from IS NOT OLD.effective_from OR NEW.effective_to IS NOT OLD.effective_to)
BEGIN SELECT RAISE(ABORT,'已发布规则的生效时间不可修改'); END;

CREATE TRIGGER IF NOT EXISTS trg_rule_version_status_transition
BEFORE UPDATE OF status ON scoring_rule_versions
WHEN NOT (
  (OLD.status='DRAFT' AND NEW.status IN('DRAFT','SUBMITTED'))
  OR (OLD.status='SUBMITTED' AND NEW.status IN('SUBMITTED','APPROVED','DRAFT','REJECTED'))
  OR (OLD.status='APPROVED' AND NEW.status IN('APPROVED','PUBLISHED','REJECTED'))
  OR (OLD.status='PUBLISHED' AND NEW.status IN('PUBLISHED','ARCHIVED'))
  OR (OLD.status='REJECTED' AND NEW.status IN('REJECTED','DRAFT'))
  OR (OLD.status='ARCHIVED' AND NEW.status='ARCHIVED')
)
BEGIN SELECT RAISE(ABORT,'非法的规则版本状态流转'); END;

CREATE TABLE IF NOT EXISTS evidence_files(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id TEXT REFERENCES students(id),
  class_id TEXT REFERENCES classes(id),
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_student ON evidence_files(student_id,created_at);

-- 积分账本：只追加。EFFECTIVE 之后禁止 UPDATE/DELETE；错误通过冲正/更正记录处理。
CREATE TABLE IF NOT EXISTS score_records(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id TEXT NOT NULL REFERENCES academic_years(id),
  term_id TEXT NOT NULL REFERENCES terms(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  class_id TEXT NOT NULL REFERENCES classes(id),
  grade_id TEXT NOT NULL REFERENCES grades(id),
  rule_id TEXT REFERENCES scoring_rules(id),
  rule_version_id TEXT REFERENCES scoring_rule_versions(id),
  rule_snapshot_json TEXT NOT NULL DEFAULT '{}',
  category_id TEXT REFERENCES scoring_categories(id),
  category_name TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL CHECK(direction IN('ADD','DEDUCT')),
  points INTEGER NOT NULL CHECK(points>0),
  signed_points INTEGER NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'STANDARD' CHECK(record_kind IN('STANDARD','REVERSAL','CORRECTION')),
  status TEXT NOT NULL DEFAULT 'EFFECTIVE' CHECK(status IN('PENDING_REVIEW','EFFECTIVE','REJECTED')),
  occurrence_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'TEACHER' CHECK(source IN('TEACHER','MORAL_AFFAIRS','STUDENT_CADRE','IMPORT','APPEAL')),
  submitter_id TEXT NOT NULL REFERENCES users(id),
  reviewer_id TEXT REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  submission_id TEXT,
  reverses_record_id TEXT REFERENCES score_records(id),
  corrects_record_id TEXT REFERENCES score_records(id),
  batch_id TEXT,
  created_at TEXT NOT NULL,
  effective_at TEXT,
  CHECK((direction='ADD' AND signed_points=points) OR (direction='DEDUCT' AND signed_points=-points)),
  CHECK(record_kind<>'REVERSAL' OR reverses_record_id IS NOT NULL),
  CHECK(record_kind<>'CORRECTION' OR corrects_record_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_score_reversal_unique
  ON score_records(reverses_record_id) WHERE reverses_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_records_student_term ON score_records(student_id,term_id,status);
CREATE INDEX IF NOT EXISTS idx_records_class_term ON score_records(class_id,term_id,status);
CREATE INDEX IF NOT EXISTS idx_records_term_time ON score_records(term_id,occurrence_at);
CREATE INDEX IF NOT EXISTS idx_records_status ON score_records(school_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_records_category ON score_records(category_id,occurrence_at);
CREATE INDEX IF NOT EXISTS idx_records_submitter ON score_records(submitter_id,created_at);
CREATE INDEX IF NOT EXISTS idx_records_submission ON score_records(submission_id);
CREATE INDEX IF NOT EXISTS idx_records_batch ON score_records(batch_id);

CREATE TRIGGER IF NOT EXISTS trg_score_record_update_guard
BEFORE UPDATE ON score_records
WHEN OLD.status<>'PENDING_REVIEW'
BEGIN SELECT RAISE(ABORT,'已生效或已驳回的积分记录不可修改，请使用冲正/更正'); END;

CREATE TRIGGER IF NOT EXISTS trg_score_record_delete_guard
BEFORE DELETE ON score_records
WHEN OLD.status<>'PENDING_REVIEW'
BEGIN SELECT RAISE(ABORT,'积分账本记录不可删除，请使用冲正/更正'); END;

CREATE TABLE IF NOT EXISTS submission_tokens(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_submission_tokens_class ON submission_tokens(class_id,created_at DESC);

CREATE TABLE IF NOT EXISTS student_submissions(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL REFERENCES classes(id),
  student_id TEXT REFERENCES students(id),
  student_no_snapshot TEXT NOT NULL DEFAULT '',
  student_name_snapshot TEXT NOT NULL DEFAULT '',
  category_id TEXT REFERENCES scoring_categories(id),
  category_name_snapshot TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT 'ADD' CHECK(direction IN('ADD','DEDUCT')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK(status IN('PENDING_REVIEW','APPROVED','REJECTED','NEEDS_INFO')),
  source TEXT NOT NULL DEFAULT 'CADRE_LINK' CHECK(source IN('CADRE_LINK','TEACHER')),
  token_id TEXT REFERENCES submission_tokens(id),
  submitter_ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  score_record_id TEXT REFERENCES score_records(id)
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON student_submissions(school_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_class ON student_submissions(class_id,created_at DESC);

CREATE TABLE IF NOT EXISTS appeals(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES score_records(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  class_id TEXT NOT NULL REFERENCES classes(id),
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK(status IN('SUBMITTED','UNDER_REVIEW','ACCEPTED','REJECTED')),
  submitted_by TEXT NOT NULL REFERENCES users(id),
  handler_id TEXT REFERENCES users(id),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  decision_reason TEXT NOT NULL DEFAULT '',
  conflict_flag INTEGER NOT NULL DEFAULT 0,
  conflict_reason TEXT NOT NULL DEFAULT '',
  reversal_record_id TEXT REFERENCES score_records(id),
  correction_record_id TEXT REFERENCES score_records(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(school_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appeals_record ON appeals(record_id);
CREATE INDEX IF NOT EXISTS idx_appeals_student ON appeals(student_id,created_at DESC);

CREATE TABLE IF NOT EXISTS appeal_decisions(
  id TEXT PRIMARY KEY,
  appeal_id TEXT NOT NULL REFERENCES appeals(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK(decision IN('UNDER_REVIEW','ACCEPTED','REJECTED')),
  reason TEXT NOT NULL DEFAULT '',
  conflict_flag INTEGER NOT NULL DEFAULT 0,
  conflict_reason TEXT NOT NULL DEFAULT '',
  reversal_record_id TEXT,
  correction_record_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appeal_decisions ON appeal_decisions(appeal_id,created_at);
CREATE TRIGGER IF NOT EXISTS trg_appeal_decision_no_update
BEFORE UPDATE ON appeal_decisions
BEGIN SELECT RAISE(ABORT,'申诉裁决记录不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_appeal_decision_no_delete
BEFORE DELETE ON appeal_decisions
BEGIN SELECT RAISE(ABORT,'申诉裁决记录不可删除'); END;

CREATE TABLE IF NOT EXISTS parent_shares(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shares_student ON parent_shares(student_id,created_at DESC);

CREATE TABLE IF NOT EXISTS parent_share_access_log(
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES parent_shares(id) ON DELETE CASCADE,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_access ON parent_share_access_log(share_id,created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs(
  id TEXT PRIMARY KEY,
  school_id TEXT REFERENCES schools(id) ON DELETE SET NULL,
  actor_id TEXT,
  actor_account TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  before_json TEXT,
  after_json TEXT,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT 'SUCCESS' CHECK(result IN('SUCCESS','FAILURE')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_school_time ON audit_logs(school_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action,created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT,'审计日志不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT,'审计日志不可删除'); END;

CREATE TABLE IF NOT EXISTS import_jobs(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('students','classes','teachers')),
  filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PREVIEW' CHECK(status IN('PREVIEW','COMMITTED','FAILED')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  valid_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '[]',
  result_summary TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  committed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_imports_school ON import_jobs(school_id,created_at DESC);

CREATE TABLE IF NOT EXISTS import_errors(
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  column_name TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_import_errors_job ON import_errors(job_id,row_number);

CREATE TABLE IF NOT EXISTS backup_jobs(
  id TEXT PRIMARY KEY,
  school_id TEXT REFERENCES schools(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(status IN('RUNNING','SUCCEEDED','FAILED')),
  file_path TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_backups_time ON backup_jobs(started_at DESC);

CREATE TABLE IF NOT EXISTS honor_rules(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  min_points INTEGER NOT NULL DEFAULT 0,
  min_positive_records INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK(is_enabled IN(0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_honors_school ON honor_rules(school_id,sort_order);

CREATE TABLE IF NOT EXISTS reward_items(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  points_cost INTEGER NOT NULL CHECK(points_cost>0),
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK(is_enabled IN(0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rewards_school ON reward_items(school_id,sort_order);

CREATE TABLE IF NOT EXISTS system_settings(
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(school_id,key)
);
