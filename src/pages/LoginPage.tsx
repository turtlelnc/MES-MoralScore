// OWNER: frontend-core. 登录页：账号密码登录、错误/限流提示、演示账号快捷填充。
// 登录前没有 SessionUser，因此本页 props 由 main.tsx 直接传入（不是 PageProps）。
import React, { useEffect, useRef, useState } from "react";
import { KeyRound, ShieldCheck, Sparkles } from "lucide-react";
import { api, ApiError } from "../api";
import { Button, Checkbox, Field, Input, useToast } from "../components/ui";
import type { SessionUser } from "../types";

const DEMO_HINTS = [
  ["admin", "Admin@MES2026", "系统管理员", "全校数据与系统管理"],
  ["moral", "Moral@MES2026", "德育处", "规则发布、复核与申诉裁决"],
  ["teacher1", "Teacher@MES2026", "值日老师", "七年级 1/2 班记分（演示）"],
] as const;

function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return error.message || "登录尝试过于频繁，请稍后再试";
    if (error.status === 403) return error.message || "该账号已被停用，请联系系统管理员";
    if (error.status === 400) {
      const issue = error.issues?.[0]?.message;
      return issue || error.message || "请检查账号和密码是否填写完整";
    }
    if (error.status === 401) return "账号或密码不正确，请重新输入";
    if (error.status >= 500) return error.message || "服务暂时不可用，请稍后重试";
    return error.message || "登录失败，请稍后重试";
  }
  if (error instanceof DOMException && error.name === "AbortError") return "";
  return error instanceof Error && error.message ? error.message : "网络异常，请检查网络后重试";
}

export function LoginPage({
  onLogin,
  versionLabel,
}: {
  onLogin: (user: SessionUser) => void;
  versionLabel: string;
}) {
  const toast = useToast();
  const accountRef = useRef<HTMLInputElement>(null);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    accountRef.current?.focus();
  }, []);

  // 429 限流后按 Retry-After 倒计时，避免用户连续点击造成更长时间封禁。
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => {
      setCooldown((current) => (current <= 1 ? 0 : current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (loading || cooldown > 0) return;
    const nextAccount = account.trim();
    if (!nextAccount) {
      setError("请填写账号");
      accountRef.current?.focus();
      return;
    }
    if (!password) {
      setError("请填写密码");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const data = await api<{ user: SessionUser }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ account: nextAccount, password }),
      });
      toast(`欢迎回来，${data.user.displayName}`, "success");
      onLogin(data.user);
    } catch (requestError) {
      setError(loginErrorMessage(requestError));
      if (requestError instanceof ApiError && requestError.status === 429) {
        setCooldown(Math.max(3, Math.ceil(requestError.retryAfterMs / 1000)));
      }
    } finally {
      setLoading(false);
    }
  }

  function fillDemo(demoAccount: string, demoPassword: string) {
    if (loading) return;
    setAccount(demoAccount);
    setPassword(demoPassword);
    setError("");
    toast("已填入演示账号，确认后点击登录（演示账号仅用于虚构数据）", "info");
  }

  const submitDisabled = loading || cooldown > 0;

  return (
    <div className="login-page">
      <section className="login-hero">
        <div className="login-hero-inner">
          <div className="login-brand">
            <div className="brand-mark">MES</div>
            <div>
              <div className="brand-name">MES-MoralScore</div>
              <div className="brand-sub">校园德育量化</div>
            </div>
          </div>
          <div className="hero-kicker">Transparent · Traceable · Encouraging</div>
          <h1 className="hero-title">
            让每一份成长
            <br />
            <span>被公平记录</span>
          </h1>
          <p className="hero-sub">
            面向中小学德育处、值日教师与班主任的量化管理平台：规则有版本、积分有账本、申诉有回音、成长有报告。
          </p>
          <div className="hero-points">
            <div className="hero-point">
              <strong>规则可解释</strong>
              <p>评分标准版本化发布，记录保留规则快照，历史可追溯。</p>
            </div>
            <div className="hero-point">
              <strong>账本不可篡改</strong>
              <p>生效记录只能冲正与更正，操作全程留痕，杜绝暗改。</p>
            </div>
            <div className="hero-point">
              <strong>移动端高效</strong>
              <p>手机三步完成记分，巡查现场即可录入与核实。</p>
            </div>
            <div className="hero-point">
              <strong>正向激励</strong>
              <p>成长报告与荣誉参考，帮助学校做过程管理与积极引导。</p>
            </div>
          </div>
        </div>
        <div className="hero-foot">
          {versionLabel} · 数据仅用于学校德育管理，请妥善保管账号
        </div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <div className="login-mobile-brand">
            <div className="brand-mark">MES</div>
            <div>
              <div className="brand-name" style={{ color: "var(--text)" }}>
                MES-MoralScore
              </div>
              <div className="brand-sub">校园德育量化</div>
            </div>
          </div>
          <div className="login-head">
            <h1>登录校园德育工作台</h1>
            <p>请使用学校管理员分配的账号登录</p>
          </div>

          <form
            className="login-form"
            onSubmit={(event) => void submit(event)}
            aria-busy={loading}
            noValidate
          >
            <Field label="账号" required htmlFor="login-account">
              <Input
                ref={accountRef}
                id="login-account"
                name="account"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="请输入账号"
                value={account}
                disabled={loading}
                onChange={(event) => {
                  setAccount(event.target.value);
                  if (error) setError("");
                }}
              />
            </Field>
            <Field
              label="密码"
              required
              htmlFor="login-password"
              hint={cooldown > 0 ? `登录尝试过于频繁，请 ${cooldown} 秒后重试` : undefined}
            >
              <Input
                id="login-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="请输入密码"
                value={password}
                disabled={loading}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (error) setError("");
                }}
              />
            </Field>
            <Checkbox
              label="显示密码明文"
              checked={showPassword}
              onChange={(event) => setShowPassword(event.target.checked)}
            />

            {error && (
              <div className="alert alert-danger login-error" role="alert">
                <span className="alert-icon" aria-hidden>
                  <KeyRound size={17} />
                </span>
                <div className="alert-body">{error}</div>
              </div>
            )}

            <Button
              type="submit"
              className="login-submit btn-lg"
              loading={loading}
              disabled={submitDisabled}
              icon={<KeyRound size={17} />}
            >
              {loading ? "正在登录…" : cooldown > 0 ? `${cooldown} 秒后可重试` : "登录"}
            </Button>
          </form>

          <details className="demo-accounts">
            <summary>
              <Sparkles size={13} style={{ display: "inline", marginRight: 5 }} />
              演示账号（仅用于虚构演示数据）
            </summary>
            <div className="demo-list">
              {DEMO_HINTS.map(([demoAccount, demoPassword, role, scope]) => (
                <Button
                  key={demoAccount}
                  type="button"
                  variant="secondary"
                  size="sm"
                  title={`${role} · ${scope}（点击填充，仅供演示）`}
                  onClick={() => fillDemo(demoAccount, demoPassword)}
                  disabled={loading}
                >
                  {role}：{demoAccount}
                </Button>
              ))}
            </div>
            <p className="text-xs muted mt-2">
              以上账号密码属于演示数据，仅用于本地演示；正式使用时请由系统管理员创建账号并修改初始密码。
            </p>
          </details>

          <div className="login-foot">
            <div className="row" style={{ gap: 6 }}>
              <ShieldCheck size={14} /> 会话 Cookie 仅在登录后签发，密码仅保存安全哈希
            </div>
            <div style={{ marginTop: 6 }}>
              {versionLabel} · 不提供自助注册，如需开通账号请联系学校系统管理员
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
