// OWNER: frontend-ops. 学生干部公开申报页：按班级级 token 提交表现申报，
// 只创建待核实申报、绝不直接产生积分；学号/姓名不匹配时统一提示。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ClipboardCheck, RefreshCw, ShieldCheck } from "lucide-react";
import { api, ApiError } from "../api";
import { formatDateTime } from "../format";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Loading,
  Notice,
  Segmented,
  Select,
  Textarea,
} from "../components/ui";

interface PublicCategory {
  id: string;
  name: string;
  directionScope: "BOTH" | "ADD" | "DEDUCT";
}

interface SubmissionMeta {
  class: { id: string; name: string; gradeName: string };
  categories: PublicCategory[];
  expiresAt?: string;
}

type Direction = "ADD" | "DEDUCT";

const IDENTITY_ERROR =
  "学号或姓名与班级名册不匹配，请核对后重新提交。（为保护学生隐私，系统不会提示具体哪一项有误）";

function directionScopeLabel(scope: string): string {
  if (scope === "ADD") return "仅加分";
  if (scope === "DEDUCT") return "仅减分";
  return "可加分或减分";
}

function loadErrorOf(error: unknown): { title: string; description: string; invalid: boolean } {
  if (error instanceof ApiError) {
    if (error.status === 404)
      return {
        invalid: true,
        title: "申报链接无效或已过期",
        description: "该链接可能已过期或被学校撤销。请联系班主任获取新的学生干部申报链接。",
      };
    if (error.status === 429)
      return { invalid: false, title: "访问过于频繁", description: "请稍等一分钟后再刷新本页。" };
    return {
      invalid: false,
      title: "申报页面暂时无法加载",
      description: error.message || "服务器开小差了，请稍后重试。",
    };
  }
  return { invalid: false, title: "网络异常", description: "无法连接学校服务器，请检查网络后重试。" };
}

function submitErrorOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return "申报链接无效或已过期，请联系班主任获取新链接。";
    if (error.status === 429) return error.message || "提交过于频繁，请稍后再试。";
    const message = error.message || "";
    if (error.status === 400 || error.status === 403 || error.status === 422) {
      if (/学号|姓名|名册|匹配|身份|学生不存在/.test(message)) return IDENTITY_ERROR;
      return message || "提交失败，请检查填写内容后重试。";
    }
    return message || "提交失败，请稍后重试。";
  }
  return "网络异常，提交失败，请稍后重试。";
}

export function SubmitPage({ token }: { token: string }) {
  const [meta, setMeta] = useState<SubmissionMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ title: string; description: string; invalid: boolean } | null>(null);

  const [studentNo, setStudentNo] = useState("");
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [direction, setDirection] = useState<Direction>("ADD");
  const [description, setDescription] = useState("");

  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<{ at: string; categoryName: string; direction: Direction } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<SubmissionMeta>(`/public/submission/${encodeURIComponent(token)}`);
      setMeta(data);
      if (data.categories?.length) {
        const first = data.categories[0];
        setCategoryId((current) => (current && data.categories.some((item) => item.id === current) ? current : first.id));
      }
    } catch (error) {
      setMeta(null);
      setLoadError(loadErrorOf(error));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.title = "学生干部申报 · MES-MoralScore";
    return () => {
      document.title = "MES-MoralScore";
    };
  }, []);

  const categories = meta?.categories ?? [];
  const selectedCategory = useMemo(
    () => categories.find((item) => item.id === categoryId) ?? null,
    [categories, categoryId],
  );

  // 分类的方向范围决定可选方向；切换分类时自动纠正方向。
  useEffect(() => {
    if (!selectedCategory) return;
    if (selectedCategory.directionScope === "ADD" && direction !== "ADD") setDirection("ADD");
    if (selectedCategory.directionScope === "DEDUCT" && direction !== "DEDUCT") setDirection("DEDUCT");
  }, [selectedCategory, direction]);

  const directionLocked = selectedCategory
    ? selectedCategory.directionScope === "ADD" || selectedCategory.directionScope === "DEDUCT"
    : false;
  const directionOptions = useMemo(() => {
    if (!selectedCategory || selectedCategory.directionScope === "BOTH") {
      return [
        { value: "ADD" as Direction, label: "加分申报" },
        { value: "DEDUCT" as Direction, label: "减分申报" },
      ];
    }
    return selectedCategory.directionScope === "ADD"
      ? [{ value: "ADD" as Direction, label: "加分申报" }]
      : [{ value: "DEDUCT" as Direction, label: "减分申报" }];
  }, [selectedCategory]);

  function resetForm() {
    setStudentNo("");
    setName("");
    setDescription("");
    setDirection("ADD");
    setFieldErrors({});
    setFormError("");
    setSubmitError("");
    setSuccess(null);
    const first = categories[0];
    if (first) {
      setCategoryId(first.id);
      if (first.directionScope === "DEDUCT") setDirection("DEDUCT");
      else setDirection("ADD");
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError("");
    setSubmitError("");
    const errors: Record<string, string> = {};
    if (!studentNo.trim()) errors.studentNo = "请填写学号";
    if (!name.trim()) errors.name = "请填写姓名";
    if (!categoryId) errors.categoryId = "请选择表现分类";
    if (!description.trim()) errors.description = "请填写现象描述";
    else if (description.trim().length < 5) errors.description = "现象描述至少需要 5 个字，请写清时间、地点与经过";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    if (submitting) return;

    setSubmitting(true);
    try {
      await api(`/public/submission/${encodeURIComponent(token)}`, {
        method: "POST",
        body: JSON.stringify({
          studentNo: studentNo.trim(),
          name: name.trim(),
          categoryId,
          direction,
          description: description.trim(),
        }),
      });
      setSuccess({
        at: formatDateTime(new Date()),
        categoryName: selectedCategory?.name || "表现申报",
        direction,
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setSubmitError(submitErrorOf(error));
    } finally {
      setSubmitting(false);
    }
  }

  const className = meta ? `${meta.class.gradeName}${meta.class.name}` : "";

  return (
    <div className="public-page">
      <div className="public-container">
        <div className="public-brand">
          <div className="public-brand-left">
            <div className="brand-mark">MES</div>
            <div>
              <div className="public-brand-name">MES-MoralScore</div>
              <div className="public-brand-sub">校园德育量化 · 学生干部申报</div>
            </div>
          </div>
          {meta && <Badge tone="brand">{className}</Badge>}
        </div>

        {loading ? (
          <div className="public-card">
            <Loading label="正在加载申报入口…" />
          </div>
        ) : loadError ? (
          <div className="public-card">
            <EmptyState
              icon={<ShieldCheck size={24} />}
              title={loadError.title}
              description={loadError.description}
              action={
                !loadError.invalid ? (
                  <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => void load()}>
                    重新加载
                  </Button>
                ) : undefined
              }
            />
            <div className="privacy-foot">
              本入口由学校为班级签发，仅用于学生干部登记表现申报；链接撤销或过期后将无法提交。
            </div>
          </div>
        ) : success ? (
          <div className="public-card">
            <div className="submit-success">
              <div className="submit-success-icon">
                <CheckCircle2 size={30} />
              </div>
              <h1 style={{ fontSize: 20, fontWeight: 720 }}>已提交，等待老师核实</h1>
              <p className="muted" style={{ maxWidth: 460, lineHeight: 1.7, fontSize: 13 }}>
                你的申报已记录到「{className}」，<strong style={{ color: "var(--text)" }}>不会直接改变积分</strong>。
                老师核实通过后才会产生正式积分记录，请耐心等待。
              </p>
            </div>
            <div className="kv" style={{ maxWidth: 420, margin: "0 auto" }}>
              <dt>申报班级</dt>
              <dd>{className}</dd>
              <dt>表现分类</dt>
              <dd>{success.categoryName}</dd>
              <dt>申报方向</dt>
              <dd>{success.direction === "ADD" ? "加分申报" : "减分申报"}</dd>
              <dt>提交时间</dt>
              <dd>{success.at}</dd>
              <dt>当前状态</dt>
              <dd>
                <Badge tone="warning">待老师核实</Badge>
              </dd>
            </div>
            <div className="form-actions" style={{ justifyContent: "center", marginTop: 18 }}>
              <Button variant="secondary" onClick={resetForm}>
                再填一份
              </Button>
            </div>
            <div className="privacy-foot" style={{ textAlign: "center" }}>
              同一现象请勿重复提交；如填写有误，请联系班主任说明情况。
            </div>
          </div>
        ) : meta ? (
          <div className="public-card">
            <div className="submit-hero">
              <h1>学生干部表现申报</h1>
              <p>
                {className} · 请如实填写学号、姓名与表现情况，提交后由老师核实，不会直接改变积分。
              </p>
            </div>

            <form onSubmit={(event) => void handleSubmit(event)}>
              <div className="form-section">
                <div className="form-section-title">身份核对</div>
                <div className="form-grid cols-2">
                  <Field label="学号" required htmlFor="submit-student-no" error={fieldErrors.studentNo}>
                    <Input
                      id="submit-student-no"
                      value={studentNo}
                      maxLength={40}
                      autoComplete="off"
                      placeholder="请输入学号"
                      onChange={(event) => {
                        setStudentNo(event.target.value);
                        setFieldErrors((current) => ({ ...current, studentNo: "" }));
                      }}
                    />
                  </Field>
                  <Field label="姓名" required htmlFor="submit-student-name" error={fieldErrors.name}>
                    <Input
                      id="submit-student-name"
                      value={name}
                      maxLength={50}
                      autoComplete="off"
                      placeholder="请输入姓名"
                      onChange={(event) => {
                        setName(event.target.value);
                        setFieldErrors((current) => ({ ...current, name: "" }));
                      }}
                    />
                  </Field>
                </div>
                <p className="field-hint" style={{ margin: 0 }}>
                  系统会按班级名册核验学号与姓名；为保护隐私，核验失败时不会提示具体哪一项有误。
                </p>
              </div>

              <div className="form-section">
                <div className="form-section-title">申报内容</div>
                <Field
                  label="表现分类"
                  required
                  htmlFor="submit-category"
                  error={fieldErrors.categoryId}
                  hint="不同分类可能只支持加分或只支持减分"
                >
                  <Select
                    id="submit-category"
                    value={categoryId}
                    onChange={(event) => {
                      setCategoryId(event.target.value);
                      setFieldErrors((current) => ({ ...current, categoryId: "" }));
                    }}
                  >
                    {categories.length === 0 && <option value="">班级暂未配置分类</option>}
                    {categories.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}（{directionScopeLabel(item.directionScope)}）
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field
                  label="申报方向"
                  required
                  hint={directionLocked ? "该分类仅支持一种方向" : "请选择本次申报是加分还是减分"}
                >
                  <Segmented<Direction>
                    value={direction}
                    options={directionOptions}
                    onChange={(value) => {
                      if (directionLocked) return;
                      setDirection(value);
                    }}
                    ariaLabel="申报方向"
                  />
                </Field>

                <Field
                  label="现象描述"
                  required
                  htmlFor="submit-description"
                  error={fieldErrors.description}
                  hint="请客观描述时间、地点、事情经过（至少 5 个字）"
                >
                  <Textarea
                    id="submit-description"
                    rows={4}
                    maxLength={500}
                    value={description}
                    placeholder="例如：10 月 30 日课间，在走廊主动帮助同学捡起散落的作业本并整理。"
                    onChange={(event) => {
                      setDescription(event.target.value);
                      setFieldErrors((current) => ({ ...current, description: "" }));
                    }}
                  />
                </Field>
                <div className="muted text-xs" style={{ textAlign: "right" }}>
                  {description.trim().length} / 500 字
                </div>
              </div>

              {formError && <Alert tone="danger">{formError}</Alert>}
              {submitError && <Alert tone="danger" title="提交未成功">{submitError}</Alert>}

              <div className="form-section" style={{ borderBottom: "none" }}>
                <Notice tone="info">
                  提交后只创建「待核实」申报，老师核实通过才会产生正式积分记录；申报不会直接改变任何学生积分。
                </Notice>
                <Button
                  type="submit"
                  size="lg"
                  className="w-full"
                  loading={submitting}
                  icon={<ClipboardCheck size={17} />}
                  disabled={submitting || categories.length === 0}
                >
                  {submitting ? "正在提交…" : "提交申报"}
                </Button>
                <p className="muted text-xs" style={{ textAlign: "center", margin: 0 }}>
                  提交即表示你确认所填信息真实，并同意学校用于德育核实与成长记录。
                </p>
              </div>
            </form>

            <div className="privacy-foot">
              本页面为公开申报入口，不展示任何其他学生信息，也不会直接修改积分。
              {meta.expiresAt ? ` 当前链接有效期至 ${formatDateTime(meta.expiresAt)}。` : ""}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
