# MES-MoralScore 架构与协作契约（v0.1.0-rc1）

本文件是团队开发契约。所有模块必须遵循这里的权限、数据、API 与 UI 约定。
版本：`v0.1.0-rc1 (build 26103101)`。

## 1. 技术栈与决策

- Node.js 24、ESM、Express 5、`node:sqlite`（`DatabaseSync`）。
- 前端 React 19 + TypeScript + Vite 6 + Tailwind CSS 4 + lucide-react + recharts。
- 测试 Vitest（服务端单元/集成）+ Playwright（真实浏览器流程）。
- 数据库选择 SQLite：与参考项目 MES-Homework 保持一致，学校内网/单机部署无需
  PostgreSQL 运维；通过 schema.sql + migrations.mjs 管理结构，seed 提供演示数据。
  取舍与升级路径写入 README（已知限制）。
- 积分一律使用整数（最小单位 1 分），禁止浮点计算。记录签名字段
  `signed_points`：加分=+points，减分=-points。

## 2. 目录与文件所有权

| 所有者 | 文件 |
| --- | --- |
| lead | `server/{core,config,app,index,migrations,ledger,evidence,auth,version}.mjs`、`server/schema.sql`、`server/fixtures.mjs`、`server/test-utils.mjs`、`src/{main.tsx,api.ts,types.ts,version.ts,styles.css}`、`src/components/ui.tsx`、`docs/*`、`README*.md`、`.github/*` |
| backend-core | `server/{rules,scoring,submissions,appeals}.mjs`、对应 `server/*.test.ts` |
| backend-data | `server/{roster,imports,analytics,reports,share,admin,backup}.mjs`、`server/*.test.ts`、`tools/ops/backup.mjs` |
| frontend-core | `src/pages/{LoginPage,DashboardPage,QuickScorePage,RecordsPage}.tsx` |
| frontend-ops | `src/pages/{StudentsPage,RulesPage,AdminPage,SharePage,SubmitPage}.tsx` |
| frontend-insight | `src/pages/{SubmissionsPage,AppealsPage,AnalyticsPage,ReportsPage}.tsx` |
| qa | `tests/browser/*`、`server/e2e.test.ts`、`scripts/verify-*.mjs` |

**只写自己名下的文件。** 需要修改共享文件（core/ledger/app/main/styles/ui）时先给 lead 发消息，由 lead 修改，避免覆盖冲突。

### 2.1 跨模块依赖

- `rules.mjs` 导出 `resolveRuleForScoring(db, {ruleId, at, classId, gradeId})`，
  返回 `{rule, version}`；scoring/submissions 直接 import。
- `scoring.mjs` 导出 `createLedgerEntry(ctx, {...})`、`reversalEntry(ctx, {...})`、
  `correctionEntry(ctx, {...})`，appeals 直接 import。
- 计算类查询统一使用 `server/ledger.mjs`（lead 维护），不要自己写 SUM 口径。
- 序列化账本记录统一使用 `ledger.recordViews(db, rows)`。

## 3. 角色、权限矩阵（服务端必须强制）

角色固定三种，不允许新增平级管理角色：

| 能力 | SYSTEM_ADMIN | MORAL_AFFAIRS | DUTY_TEACHER |
| --- | --- | --- | --- |
| 学校资料/学年学期/年级班级/学生/教师 | ✅ | 只读 | 只读（授权范围） |
| 账号与数据范围管理 | ✅ | ❌ | ❌ |
| 指标分类维护 | ✅ | 只读 | 只读 |
| 规则草稿创建/编辑/提交 | ✅ | ✅ | ❌ |
| 规则审核/发布/驳回/归档 | ❌（不可绕过德育处） | ✅ | ❌ |
| 日常记分 | ✅ | ✅ | ✅（仅授权范围） |
| 待复核记录审批/驳回 | ✅ | ✅ | ❌ |
| 撤销/冲正/更正账本 | ✅ | ✅ | ❌ |
| 学生干部申报初审 | ✅ | ✅ | ✅（仅授权范围） |
| 申诉登记 | ✅ | ✅ | ✅（仅授权范围） |
| 申诉裁决 | ❌（必须德育处） | ✅ | ❌ |
| 全校/年级/班级分析 | ✅ | ✅ | 授权范围 |
| 家长分享链接 | ✅ | ✅ | ❌ |
| 批量导入 | ✅ | ❌ | ❌ |
| 备份/审计日志 | ✅ | ❌ | ❌ |
| 成长报告 | ✅ | ✅ | 授权范围 |

- SYSTEM_ADMIN / MORAL_AFFAIRS 数据范围为全校；DUTY_TEACHER 由 `user_scopes`
  （GRADE/CLASS）决定，必须用 `ctx.scope` 系列函数校验，禁止手写 `school_id` 过滤代替。
- 越权一律 403，不存在一律 404；不要在错误信息里泄露其他班级学生姓名。

## 4. 关键业务规则

### 4.1 规则版本
- 生命周期：`DRAFT -> SUBMITTED -> APPROVED -> PUBLISHED -> ARCHIVED`，
  驳回为 `SUBMITTED -> REJECTED -> DRAFT`（重新编辑）。数据库触发器兜底校验。
- `scoring_rules.active_version_id` 指向当前生效版本；`latest_version` 为最大版本号。
- 已发布版本修改必须生成新版本（PATCH 已发布规则时创建 version+1 的 DRAFT）。
- 记分只能使用 `PUBLISHED` 且在 `effective_from..effective_to` 内、适用范围匹配的版本。
- 记录写入时保存 `rule_snapshot_json`（name/categoryName/direction/points/version/description），
  规则后续改版不影响历史记录。

### 4.2 账本
- 只有 `status='EFFECTIVE'` 参与计算。待复核/已驳回不计分。
- `EFFECTIVE` 行禁止 UPDATE/DELETE（数据库触发器）。撤销 = 新增 `REVERSAL` 记录
  （相反方向、相同分值、`reverses_record_id`），更正 = REVERSAL + 新的 `CORRECTION` 记录。
- 同一记录只允许一条生效冲正（数据库唯一索引）。
- 老师录入时若 `rule.requires_review=1` 或 `points >= settings.reviewThreshold`
  或属于特殊荣誉（竞赛荣誉分类加分 >=10），则记录为 `PENDING_REVIEW`；
  德育处/管理员录入默认直接 EFFECTIVE。
- 申诉接受必须走冲正/更正，不得更新原记录。
- 冲正/更正必须写理由并记录审计日志。

### 4.3 学生干部申报
- 公开申报链接 = 班级级 token（只保存 sha256，可撤销、可过期），提交后只创建
  `PENDING_REVIEW` 的 `student_submissions`，绝不直接产生积分记录。
- 学生通过「学号 + 姓名」匹配校验身份；错误信息不区分“学号不存在/姓名不匹配”。
- 值日老师（授权范围）通过后才生成正式积分记录（source=STUDENT_CADRE）；
  驳回/要求补充必须填写理由。

### 4.4 申诉
- 只能对 `EFFECTIVE` 记录发起；同一记录同时只能有一个未结申诉。
- 状态 `SUBMITTED -> UNDER_REVIEW -> ACCEPTED/REJECTED`，裁决必须填写理由。
- 裁决人 == 原记录提交人时记录利益冲突（`conflict_flag=1`）并要求 `conflictReason`，
  写入 `appeal_decisions`（append-only）。
- 接受申诉：`REVOKE`（仅冲正）或 `REPLACE`（冲正 + 更正为新规则/分值/说明）。

### 4.5 分数与统计口径
- 学期得分 = 初始分 + Σ已生效 signed_points，`allow_negative=0` 时下限为 0。
- 班级对比必须用「人均得分」并同时返回学生数；禁止只比较总分。
- 仪表盘/分析/报告全部来自数据库实时聚合，禁止写死数字或假图表。

## 5. API 约定

- Base：`/api`，请求/响应 JSON（导入为 multipart，导出为 CSV）。
- 成功：直接返回对象（列表为 `{items,total,page,pageSize,totalPages}`）。
- 失败：HTTP 4xx/5xx + `{error:"中文提示"}`；校验错误可带 `issues`。
- 分页参数：`page`（从 1）、`pageSize`（默认 20，最大 100）。
- 时间：ISO 8601 字符串（`2026-10-31T08:00:00.000Z`）；日期 `YYYY-MM-DD`。
- 鉴权：`mse_session` HttpOnly Cookie；除 `/api/health`、`/api/capabilities`、
  `/api/public/*` 外全部需要 `ctx.auth`。
- 所有写接口必须 `ctx.parseBody(zodSchema, req.body)` 校验并写 `ctx.audit.record`。
- 不允许把 `password_hash`、`salt`、token 原文写入响应/日志/审计。

### 5.1 已由 lead 实现
- `GET /api/health` → `{ok,version,build,versionLabel,storage,time}`
- `GET /api/capabilities` → `{stages,publicRegistration:false,studentAccounts:false}`
- `POST /api/auth/login` `{account,password}` → `{user}`（限流、审计）
- `POST /api/auth/logout` → `{ok}`
- `GET /api/me` → `{user}`；`POST /api/auth/password` `{currentPassword,newPassword}`
- user 结构：`{id,account,displayName,role,roleLabel,schoolId,schoolName,schoolCode,schoolStage,scopes:[{scope_type,scope_id,name}],permissions:{...},mustChangePassword,currentTerm:{id,name,academicYearName,startDate,endDate}|null}`
- `POST /api/evidence` (multipart `file`, body `studentId|classId`) → `{evidence:{id,name,mime,sizeBytes}}`
- `GET /api/evidence/:id` → 文件流（授权）

### 5.2 backend-core 必须实现的接口
**规则（rules.mjs）**
- `GET /api/categories` → `{items:[{id,name,description,directionScope,sortOrder,isEnabled}]}`（全角色）
- `POST /api/categories` / `PATCH /api/categories/:id`（admin）
- `GET /api/rules?status=&categoryId=&direction=&search=` → `{items:[ruleSummary]}`
  - ruleSummary：`{id,versionId,version,name,categoryId,categoryName,direction,points,minPoints,maxPoints,targetScope,scopeIds,evidenceRequired,requiresReview,status,statusLabel,description,examples,changeNote,effectiveFrom,effectiveTo,createdAt,updatedAt,publishedAt,archived:boolean}`
  - 值日老师只能看到 `PUBLISHED` 且当前有效版本（列表用于记分选择）。
- `GET /api/rules/:id` → `{rule:ruleSummary, versions:[...], scopes:{grades,classes}}`（staff）
- `POST /api/rules`（admin/moral）→ 创建 rule + DRAFT v1，返回 `{rule}`
- `PATCH /api/rules/:id`（admin/moral）→ 草稿原地改；已发布/已审核则生成新 DRAFT 版本
- `POST /api/rules/:id/submit`（admin/moral）→ `{rule}`
- `POST /api/rules/:id/approve`（仅 moral）→ 状态 APPROVED
- `POST /api/rules/:id/publish`（仅 moral）`{effectiveFrom,effectiveTo?,note?}` → PUBLISHED，
  旧 PUBLISHED 版本自动 ARCHIVED，`active_version_id` 指向新版本
- `POST /api/rules/:id/reject`（仅 moral）`{reason}` → REJECTED
- `POST /api/rules/:id/archive`（仅 moral）→ ARCHIVED
- 导出 `resolveRuleForScoring(db,{ruleId,at,classId,gradeId})`

**记分/账本（scoring.mjs）**
- `POST /api/scoring`（staff）`{ruleId,studentId,occurrenceAt,note,evidenceIds?}` → `{record}`
- `POST /api/scoring/batch`（staff）`{ruleId,studentIds[],occurrenceAt,note,evidenceIds?}`
  → 事务全有或全无，返回 `{records:[...], summary:{created,pendingReview}}`
- `GET /api/records?studentId=&classId=&gradeId=&categoryId=&direction=&status=&from=&to=&search=&termId=&page=` → `{items:[recordView],...}`
- `GET /api/records/:id` → `{record,relations:{reversal,correctedBy,corrects,appeals}}`
- `POST /api/records/:id/revoke`（admin/moral）`{reason}` → `{reversal,record}`
- `POST /api/records/:id/correct`（admin/moral）`{reason,ruleId?,points?,note?}` → `{reversal,correction,record}`
- `POST /api/records/:id/approve`（admin/moral）`{note?}` → `{record}`
- `POST /api/records/:id/reject`（admin/moral）`{reason}` → `{record}`
- `GET /api/records/export.csv?同筛选` → CSV（UTF-8 BOM）
- 导出 `createLedgerEntry(ctx,{...})`、`reversalEntry`、`correctionEntry`

**学生干部申报（submissions.mjs）**
- `POST /api/submission-tokens`（admin/moral）`{classId,expiresInDays,label?}` → `{token,url,expiresAt,id}`
- `GET /api/submission-tokens?classId=`（admin/moral）→ `{items}`
- `POST /api/submission-tokens/:id/revoke`（admin/moral）
- `GET /api/submissions?status=&classId=&page=`（staff，范围过滤）→ `{items:[submissionView],...}`
- `GET /api/submissions/:id`（staff，范围过滤）→ `{submission}`
- `POST /api/submissions/:id/approve`（staff，范围过滤）`{ruleId,occurrenceAt?,note?}` → `{submission,record}`
- `POST /api/submissions/:id/reject`（staff）`{reason}`；`/request-info` `{reason}`
- `POST /api/submissions`（staff）人工登记申报（source=TEACHER）
- `GET /api/public/submission/:token` → `{class:{id,name,gradeName},categories:[{id,name,directionScope}],expiresAt}`
- `POST /api/public/submission/:token` `{studentNo,name,categoryId,direction,description}` → `{ok:true,message}`（IP 限流，审计）
- submissionView：`{id,studentId,studentName,studentNo,classId,className,gradeName,categoryId,categoryName,direction,description,status,statusLabel,source,createdAt,reviewedAt,reviewerName,reviewNote,scoreRecordId}`
- token 原文只在创建时返回一次；库里只存 sha256。

**申诉（appeals.mjs）**
- `GET /api/appeals?status=&page=`（staff，范围过滤）→ `{items:[appealView],...}`
- `POST /api/appeals`（staff，范围过滤）`{recordId,reason,evidenceIds?}` → `{appeal}`
- `GET /api/appeals/:id` → `{appeal,record,decisions:[{id,decision,reason,actorName,conflictFlag,conflictReason,reversalRecordId,correctionRecordId,createdAt}]}`
- `POST /api/appeals/:id/start-review`（moral）`{note?}` → `{appeal}`
- `POST /api/appeals/:id/decide`（仅 moral）`{decision:'ACCEPTED'|'REJECTED',reason,conflictReason?,correction?:{mode:'REVOKE'|'REPLACE',ruleId?,points?,note?}}` → `{appeal,reversal?,correction?}`
- appealView：`{id,recordId,studentId,studentName,classId,className,status,statusLabel,reason,submittedByName,createdAt,decidedAt,decisionReason,conflictFlag,handlerName}`

### 5.3 backend-data 必须实现的接口
**基础资料（roster.mjs）**
- `GET /api/school`（staff）→ `{school,settings:{initialPoints,allowNegative,reviewThreshold}}`
- `PATCH /api/school`（admin）`{name?,address?,contact?,stage?}`
- `GET /api/periods`（staff）→ `{years:[{id,name,startDate,endDate,isCurrent,terms:[{id,name,startDate,endDate,isCurrent}]}],currentTermId}`
- `POST /api/academic-years`（admin）`{name,startDate,endDate}`；`POST /api/terms`（admin）`{academicYearId,name,startDate,endDate}`
- `POST /api/terms/:id/current`（admin）→ 切换当前学期
- `GET /api/grades`（staff）→ `{items:[{id,name,sortOrder,classCount,studentCount}]}`
- `POST /api/grades` / `PATCH /api/grades/:id`（admin）
- `GET /api/classes?gradeId=&search=`（staff）→ `{items:[{id,name,gradeId,gradeName,headTeacherId,headTeacherName,studentCount}]}`
- `POST /api/classes` / `PATCH /api/classes/:id`（admin）
- `GET /api/students?classId=&gradeId=&search=&status=&page=`（staff，范围过滤）→ `{items:[{id,name,studentNo,gender,classId,className,gradeId,gradeName,status,termScore?}],...}`
- `POST /api/students` / `PATCH /api/students/:id`（admin）
- `GET /api/students/:id`（staff，范围过滤）→ `{student,score:{initialPoints,adds,deducts,total,recordCount},recentRecords:[recordView]}`
- `GET /api/teachers?search=`（admin/moral）→ `{items:[{id,name,employeeNo,subject,phone,status,account,userId,role}]}`
- `POST /api/teachers` / `PATCH /api/teachers/:id`（admin）
- `GET /api/options`（staff）→ `{grades,classes,categories,publishedRules:[ruleSummary],terms}`（本班范围）
- `GET /api/options/students?classId=&search=`（staff）→ 学生选择器数据

**导入（imports.mjs）**
- `POST /api/imports/preview`（admin，multipart `file` + body `kind=students|classes|teachers`）
  → `{job:{id,kind,filename,status,totalRows,validRows,errorRows},preview:[{rowNumber,ok,data,errors:[{column,message}]}]}`
- `POST /api/imports/:id/commit`（admin）→ `{job,inserted}`（事务全有或全无）
- `GET /api/imports?kind=&page=`（admin）→ `{items:[job],...}`
- `GET /api/imports/:id/errors.csv`（admin）→ CSV
- `GET /api/imports/template.csv?kind=`（admin）→ 模板 CSV
- 限制：文件 ≤ 2MB、≤ 2000 行、CSV only；错误行明细入库 import_errors。
- students 列：`姓名,学号,年级,班级,性别(可选),状态(可选)`；classes：`年级,班级,班主任工号(可选)`；teachers：`姓名,工号,学科(可选),手机号(可选)`

**分析（analytics.mjs）**
- `GET /api/dashboard?termId=`（staff，范围过滤）→
  `{term,kpis:{studentCount,classCount,avgScore,totalAdds,totalDeducts,net,recordCount,pendingReviewCount,pendingSubmissionCount,openAppealCount},trend:[{date,adds,deducts,net}],classDistribution:[{classId,className,gradeName,avgScore,studentCount,adds,deducts}],gradeDistribution:[{gradeId,gradeName,avgScore,studentCount}],categories:[{categoryName,direction,recordCount,magnitude,net}],topPositiveRules:[{ruleName,recordCount,magnitude}],alerts:[{id,level,title,description,count}],recentRecords:[recordView]}`
- `GET /api/analytics/overview?termId=&from=&to=&gradeId=&classId=` → `{kpis,trend,categories,rules,classComparison,gradeComparison,timeComparison:{current:{adds,deducts,net,recordCount},previous:{...},label}}`
- `GET /api/analytics/students/:id?termId=` → 学生详情分析 `{student,score,categories,trend,recentRecords}`
- `GET /api/analytics/export.csv?type=classes|records|students&...` → CSV（范围过滤）
- 只允许返回授权范围内的数据；异常提醒基于真实查询（例如 24h 内减分 ≥ 3 的学生、单条 |points| ≥ 10 的记录、7 天无记录班级等，最多 5 条）。

**成长报告（reports.mjs）**
- `GET /api/reports/student/:studentId?period=week|month|term&date=YYYY-MM-DD`（staff，范围过滤）→
  `{student:{id,name,studentNo,className,gradeName},period:{type,label,from,to},score:{initialPoints,adds,deducts,net,total,recordCount},composition:[{categoryName,direction,recordCount,magnitude}],trend:[{date,adds,deducts,net}],highlights:[{ruleName,points,note,occurrenceAt,categoryName}],attention:[{categoryName,recordCount,magnitude}],ruleExplanations:[{name,description,examples,direction,points}],honors:[{name,description,eligible:boolean,reason}],rewards:[{name,description,pointsCost,affordable}],narrative:[string],privacyNote:string}`
- `GET /api/reports/class/:classId?termId=`（staff，范围过滤）→ `{class:{id,name,gradeName,studentCount},avgScore,adds,deducts,categories:[...],trend:[...],students:[{id,name,studentNo,total,adds,deducts,recordCount}],topPositiveRules,attentionRules}`
- `GET /api/reports/student/:studentId/export.csv?period=...` → CSV
- 荣誉：`honor_rules`（min_points/min_positive_records）满足即 eligible；兑换：`reward_items`（points_cost ≤ total 则 affordable），只展示参考结果，不自动兑换。
- narrative 由确定性模板生成，客观中性，禁止标签化/羞辱措辞。

**家长分享（share.mjs）**
- `POST /api/shares`（admin/moral）`{studentId,expiresInDays,label?}` → `{share:{id,token,url,expiresAt,label,studentName}}`（token 只返回一次）
- `GET /api/shares?studentId=&page=`（admin/moral）→ `{items:[{id,studentName,className,label,status,statusLabel,expiresAt,createdAt,createdByName,accessCount,lastAccessedAt}]}`
- `POST /api/shares/:id/revoke`（admin/moral）
- `GET /api/public/share/:token` → 学生报告视图（同 reports 学生报告结构，另加 `{student,expiresAt,privacyNote}`）；过期/撤销/不存在一律 404
  `{error:"分享链接无效或已过期"}`；每次访问写 parent_share_access_log 并更新 access_count；
  不得返回班级排名、其他学生信息、学生学号（可返回脱敏学号）。
- 分享 URL：`/#/share/<token>`（相对路径）。

**系统管理（admin.mjs）**
- `GET /api/admin/users?role=&search=&status=&page=`（admin）→ `{items:[{id,account,displayName,role,roleLabel,status,teacherId,teacherName,scopes,lastLoginAt,createdAt}]}`
- `POST /api/admin/users`（admin）`{account,displayName,password,role,teacherId?,scopes?:[{scopeType,scopeId}]}` → `{user}`
- `PATCH /api/admin/users/:id`（admin）`{displayName?,status?,role?,scopes?}`；不能停用/降级自己
- `POST /api/admin/users/:id/reset-password`（admin）`{password}` → 置 must_change_password=1
- `GET /api/admin/system`（admin）→ `{settings,school,periods,backupDirConfigured}`
- `PATCH /api/admin/system`（admin）`{initialPoints?,allowNegative?,reviewThreshold?}` → `{settings}`
- `GET/POST/PATCH /api/admin/honors`；`GET/POST/PATCH /api/admin/rewards`（admin）
- `GET /api/admin/audit-logs?action=&actorId=&from=&to=&page=`（admin）→ `{items:[{id,actorAccount,actorRole,action,targetType,targetId,summary,result,ip,createdAt}]}`
- `GET /api/admin/backups`（admin）→ `{items:[{id,status,filePath,fileName,sizeBytes,error,startedAt,finishedAt,createdByName}],backupDirConfigured}`
- `POST /api/admin/backups`（admin）→ 真实执行 `VACUUM INTO` 备份到 BACKUP_DIR，记录 backup_jobs；未配置/目录不可写返回 400/500 并写明原因

## 6. 前端契约

### 6.1 类型与页面接口（`src/types.ts` 由 lead 维护）
```ts
export type ViewKey = "dashboard"|"quick-score"|"records"|"students"|"rules"|"submissions"|"appeals"|"analytics"|"reports"|"admin";
export interface PageProps {
  user: SessionUser;
  onNavigate: (view: ViewKey, params?: Record<string, string>) => void;
  params: Record<string, string>;
  onRefreshUser: () => Promise<void>;
}
```
每个页面文件导出：`export function XxxPage({ user, onNavigate, params, onRefreshUser }: PageProps) { ... }`。
页面自己用 `api()` 拉数据、自己管理 loading/error/empty 状态。

### 6.2 共享 UI（`src/components/ui.tsx`）
必须复用，不要自行发明按钮/弹窗样式：
`cn`、`Button`（variant: primary/secondary/ghost/danger/subtle；size: sm/md/lg；loading；icon）、
`Card`、`Badge`（tone: success/danger/warning/info/brand/neutral）、`Field`、`Input`、`Select`、`Textarea`、
`Modal`（移动端自动底部抽屉）、`EmptyState`、`Loading`、`PageHeader`、`StatCard`、`SectionTitle`、
`Segmented`、`Pagination`、`useToast()`（`toast(message, tone?)`）。

### 6.3 CSS 设计系统（`src/styles.css` 由 lead 维护）
页面直接使用下列类名与 CSS 变量，避免各页样式分裂：
- 布局：`.app-shell`/`.app-sidebar`/`.app-main`/`.app-topbar`/`.page`/`.page-header`/`.grid`/`.row`/`.stack`
- 卡片：`.card`/`.card-header`/`.card-body`/`.stat-card`/`.stat-value`/`.stat-label`
- 表格：`.table-wrap`/`.table`/`.table th`/`.table td`/`.table-empty`（<768px 自动卡片化）
- 表单：`.form-grid`/`.field`/`.field-label`/`.field-hint`/`.input`/`.select`/`.textarea`/`.form-actions`
- 徽章：`.badge`+`.badge-add`/`.badge-deduct`/`.badge-pending`/`.badge-effective`/`.badge-rejected`/`.badge-neutral`
- 其他：`.toolbar`/`.filters`/`.tabs`/`.empty`/`.alert`/`.alert-danger`/`.alert-warn`/`.muted`/`.mono`/`.truncate`/`.sr-only`/`.print-only`/`.no-print`
- 主色变量：`--brand`、`--brand-strong`、`--add`、`--deduct`、`--warn`、`--text`、`--muted`、`--border`、`--surface`、`--bg`
- 页面必须写响应式：<768px 单列、表格横向滚动或卡片化、弹窗全屏/底部抽屉、无整页横向溢出。

### 6.4 交互要求
- 表单必须有必填提示、校验错误、提交中状态、成功/失败 toast、防重复提交。
- 删除/撤销/冲正/批量记分/规则发布/申诉裁决等高风险操作必须二次确认并展示影响范围。
- 列表有 loading、空状态、错误状态与分页。
- 图表必须有标题、单位、时间范围、图例和空数据状态；使用 recharts。
- 不生成无行为的假按钮；未实现能力明确标注「本版本暂未提供」。
- 默认简体中文；分数字段带「分」；时间格式 `YYYY-MM-DD HH:mm`。

## 7. 测试与验证

- `npm test`：Vitest。后端模块测试放在 `server/<module>.test.ts`，使用
  `server/test-utils.mjs` 的 `createTestServer()` 获得隔离临时库和已登录 cookie helper。
- 必测：权限/数据范围隔离、申报不直接改分、账本不可改与冲正、规则版本、申诉理由、
  批量记分边界、班级平均分口径、报告聚合、分享过期/撤销。
- `npm run build`：`tsc -b && vite build` 必须零错误。
- `npm run test:browser`：Playwright 真实浏览器（桌面 1440 与手机 390 视口）。
- 交付前 lead 会跑完整验证；每个 teammate 完成自测后必须报告：改了哪些文件、
  测试命令与结果、遗留问题。

## 8. 代码规范

- 中文用户提示；代码注释简洁中文/英文均可。
- 服务端所有金额/分值用整数；日期用 ISO 字符串；SQL 全部参数化。
- 不引入新依赖（需要时先问 lead）；不修改 `package.json`。
- 不写 `console.log` 调试残留；不提交 `data/`、`dist/`、`.env`。
- 复用 `ctx` 提供的 helpers，不重复实现 format/parse。
- 错误用 `throw ctx.httpError(status, "中文提示")`；Express 5 会自动进入错误处理中间件。

## 9. 演示数据（seed）

`npm run seed:demo` 会创建虚构的「云杉实验学校」演示数据，账号：

| 角色 | 账号 | 密码 |
| --- | --- | --- |
| 系统管理员 | `admin` | `Admin@MES2026` |
| 德育处 | `moral` | `Moral@MES2026` |
| 值日老师（七年级1/2班） | `teacher1` | `Teacher@MES2026` |
| 值日老师（八年级1/2班） | `teacher2` | `Teacher@MES2026` |
| 值日老师（九年级1班） | `teacher3` | `Teacher@MES2026` |

演示分享 token：`demo-parent-share-2026`（访问 `/#/share/demo-parent-share-2026`）；
演示干部申报 token：`demo-cadre-link-2026`（访问 `/#/submit/demo-cadre-link-2026`），
七年级1班学生可提交。所有数据均为虚构，仅用于演示。
