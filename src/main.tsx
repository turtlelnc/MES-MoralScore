import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BarChart3,
  ClipboardCheck,
  Gavel,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  PanelLeftClose,
  RefreshCw,
  Scale,
  School,
  Settings,
  Sprout,
  Users,
  X,
  Zap,
} from "lucide-react";
import { api, ApiError } from "./api";
import { ToastProvider, useToast, Button, Badge, Field, Input, Modal, cn } from "./components/ui";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { QuickScorePage } from "./pages/QuickScorePage";
import { RecordsPage } from "./pages/RecordsPage";
import { StudentsPage } from "./pages/StudentsPage";
import { RulesPage } from "./pages/RulesPage";
import { SubmissionsPage } from "./pages/SubmissionsPage";
import { AppealsPage } from "./pages/AppealsPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { AdminPage } from "./pages/AdminPage";
import { SharePage } from "./pages/SharePage";
import { SubmitPage } from "./pages/SubmitPage";
import type { PageProps, SessionUser, ViewKey } from "./types";
import { VERSION_LABEL } from "./version";
import "./styles.css";

type NavItem = {
  key: ViewKey;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  section: string;
  show: (user: SessionUser) => boolean;
};

const NAV_ITEMS: NavItem[] = [
  { key: "dashboard", label: "总览", icon: LayoutDashboard, section: "工作台", show: () => true },
  { key: "quick-score", label: "快捷记分", icon: Zap, section: "工作台", show: (user) => user.permissions.score },
  { key: "records", label: "积分记录", icon: ListChecks, section: "工作台", show: () => true },
  { key: "students", label: "学生与班级", icon: Users, section: "德育管理", show: () => true },
  { key: "rules", label: "评分规则", icon: Scale, section: "德育管理", show: () => true },
  { key: "submissions", label: "待核实申报", icon: ClipboardCheck, section: "德育管理", show: (user) => user.permissions.manageSubmissions },
  { key: "appeals", label: "申诉中心", icon: Gavel, section: "德育管理", show: (user) => user.permissions.registerAppeals },
  { key: "analytics", label: "数据分析", icon: BarChart3, section: "分析与报告", show: (user) => user.permissions.viewAnalytics },
  { key: "reports", label: "成长报告", icon: Sprout, section: "分析与报告", show: () => true },
  { key: "admin", label: "系统管理", icon: Settings, section: "系统", show: (user) => user.permissions.manageSystem },
];

const VIEW_KEYS = new Set<string>([
  "dashboard",
  "quick-score",
  "records",
  "students",
  "rules",
  "submissions",
  "appeals",
  "analytics",
  "reports",
  "admin",
]);

function isPublicRoute(hash: string): { name: "share" | "submit"; token: string } | null {
  const share = /^#\/share\/([A-Za-z0-9_-]+)/.exec(hash);
  if (share) return { name: "share", token: share[1] };
  const submit = /^#\/submit\/([A-Za-z0-9_-]+)/.exec(hash);
  if (submit) return { name: "submit", token: submit[1] };
  return null;
}

function initialView(): ViewKey {
  const hash = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return (VIEW_KEYS.has(hash) ? hash : "dashboard") as ViewKey;
}

function App() {
  const toast = useToast();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [meError, setMeError] = useState("");
  const [view, setView] = useState<ViewKey>(initialView);
  const [params, setParams] = useState<Record<string, string>>({});
  const [publicRoute, setPublicRoute] = useState(() => isPublicRoute(window.location.hash));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const loadMe = useCallback(async () => {
    if (isPublicRoute(window.location.hash)) {
      setChecking(false);
      return;
    }
    setChecking(true);
    try {
      const data = await api<{ user: SessionUser }>("/me");
      setUser(data.user);
      setMeError("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setUser(null);
        setMeError("");
      } else {
        setMeError(error instanceof Error ? error.message : "无法读取登录状态");
      }
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      setChecking(false);
      toast("登录状态已失效，请重新登录", "warning");
    };
    window.addEventListener("mes-session-expired", onExpired);
    return () => window.removeEventListener("mes-session-expired", onExpired);
  }, [toast]);

  useEffect(() => {
    const onHashChange = () => {
      const route = isPublicRoute(window.location.hash);
      setPublicRoute(route);
      if (!route) {
        const next = window.location.hash.replace(/^#\/?/, "").split("?")[0];
        if (VIEW_KEYS.has(next)) setView(next as ViewKey);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    document.title =
      view === "dashboard"
        ? "总览 · MES-MoralScore"
        : `${NAV_ITEMS.find((item) => item.key === view)?.label || "MES-MoralScore"} · MES-MoralScore`;
  }, [view]);

  const navigate = useCallback((next: ViewKey, nextParams: Record<string, string> = {}) => {
    setView(next);
    setParams(nextParams);
    setDrawerOpen(false);
    setMenuOpen(false);
    if (window.location.hash !== `#/${next}`) window.location.hash = `#/${next}`;
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  const handleLoggedIn = useCallback(
    (nextUser: SessionUser) => {
      setUser(nextUser);
      setMeError("");
      setPublicRoute(null);
      window.location.hash = "#/dashboard";
      setView("dashboard");
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST", body: "{}" });
    } catch {
      // 即使网络失败也回到登录页，服务端 Cookie 过期后不会恢复会话。
    }
    setUser(null);
    setMenuOpen(false);
    window.location.hash = "";
    toast("已退出登录", "success");
  }, [toast]);

  if (publicRoute?.name === "share") return <SharePage token={publicRoute.token} />;
  if (publicRoute?.name === "submit") return <SubmitPage token={publicRoute.token} />;

  if (checking) {
    return (
      <div className="boot-screen">
        <div className="boot-logo">MES</div>
        <div>正在读取登录状态…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <>
        {meError && (
          <div className="session-banner">
            <span>暂时无法读取登录状态：{meError}</span>
            <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void loadMe()}>
              重试登录状态
            </Button>
          </div>
        )}
        <LoginPage onLogin={handleLoggedIn} versionLabel={VERSION_LABEL} />
      </>
    );
  }

  const visibleNav = NAV_ITEMS.filter((item) => item.show(user));
  const sections = [...new Set(visibleNav.map((item) => item.section))];
  const currentItem = NAV_ITEMS.find((item) => item.key === view) || NAV_ITEMS[0];
  const pageProps: PageProps = {
    user,
    onNavigate: navigate,
    params,
    onRefreshUser: loadMe,
  };

  function renderPage() {
    switch (view) {
      case "dashboard":
        return <DashboardPage {...pageProps} />;
      case "quick-score":
        return <QuickScorePage {...pageProps} />;
      case "records":
        return <RecordsPage {...pageProps} />;
      case "students":
        return <StudentsPage {...pageProps} />;
      case "rules":
        return <RulesPage {...pageProps} />;
      case "submissions":
        return <SubmissionsPage {...pageProps} />;
      case "appeals":
        return <AppealsPage {...pageProps} />;
      case "analytics":
        return <AnalyticsPage {...pageProps} />;
      case "reports":
        return <ReportsPage {...pageProps} />;
      case "admin":
        return <AdminPage {...pageProps} />;
      default:
        return <DashboardPage {...pageProps} />;
    }
  }

  const navList = (
    <nav className="sidebar-nav" aria-label="主导航">
      {sections.map((section) => (
        <React.Fragment key={section}>
          <div className="nav-section-label">{section}</div>
          {visibleNav
            .filter((item) => item.section === section)
            .map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={cn("nav-item", view === item.key && "is-active")}
                  onClick={() => navigate(item.key)}
                  aria-current={view === item.key ? "page" : undefined}
                >
                  <Icon size={19} className="nav-icon" />
                  <span className="nav-label">{item.label}</span>
                </button>
              );
            })}
        </React.Fragment>
      ))}
    </nav>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">MES</div>
          <div className="brand-text">
            <div className="brand-name">MES-MoralScore</div>
            <div className="brand-sub">校园德育量化</div>
          </div>
        </div>
        {navList}
        <div className="sidebar-foot">
          <div>{user.schoolName}</div>
          <div>
            <strong>{VERSION_LABEL}</strong>
          </div>
        </div>
      </aside>

      {drawerOpen && (
        <>
          <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />
          <aside className="drawer" role="dialog" aria-modal="true" aria-label="导航菜单">
            <div className="drawer-head">
              <div className="sidebar-brand" style={{ padding: 0, border: "none", marginBottom: 0 }}>
                <div className="brand-mark">MES</div>
                <div className="brand-text">
                  <div className="brand-name">MES-MoralScore</div>
                  <div className="brand-sub">校园德育量化</div>
                </div>
              </div>
              <button type="button" className="icon-btn" onClick={() => setDrawerOpen(false)} aria-label="关闭菜单">
                <X size={19} />
              </button>
            </div>
            {navList}
            <div className="sidebar-foot">
              <div>{user.schoolName}</div>
              <div>{user.displayName} · {user.roleLabel}</div>
              <div>{VERSION_LABEL}</div>
            </div>
          </aside>
        </>
      )}

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="icon-btn mobile-menu-btn"
              onClick={() => setDrawerOpen(true)}
              aria-label="打开导航菜单"
            >
              <Menu size={20} />
            </button>
            <div className="topbar-title">{currentItem.label}</div>
            <div className="topbar-meta">{user.schoolName}</div>
          </div>
          <div className="topbar-actions">
            {user.currentTerm && (
              <span className="term-chip">
                <School size={14} />
                {user.currentTerm.academicYearName} · {user.currentTerm.name}
              </span>
            )}
            <div className="menu-wrap">
              <button
                type="button"
                className="user-chip"
                onClick={() => setMenuOpen((open) => !open)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
              >
                <span className="avatar">{user.displayName.slice(0, 1)}</span>
                <span className="user-chip-text">
                  <span className="user-chip-name">{user.displayName}</span>
                  <span className="user-chip-role">{user.roleLabel}</span>
                </span>
              </button>
              {menuOpen && (
                <>
                  <div
                    style={{ position: "fixed", inset: 0, zIndex: 55 }}
                    onClick={() => setMenuOpen(false)}
                    aria-hidden
                  />
                  <div className="menu-popover" role="menu">
                    <div className="menu-head">
                      <div className="menu-head-name">{user.displayName}</div>
                      <div className="menu-head-sub">
                        {user.account} · {user.roleLabel}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="menu-item"
                      role="menuitem"
                      onClick={() => {
                        setPasswordOpen(true);
                        setMenuOpen(false);
                      }}
                    >
                      <KeyRound size={16} /> 修改密码
                    </button>
                    <div className="menu-sep" />
                    <button type="button" className="menu-item" role="menuitem" onClick={() => void logout()}>
                      <LogOut size={16} /> 退出登录
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {user.mustChangePassword && (
          <div className="session-banner">
            <span>当前使用的是初始密码，请尽快修改，避免账号被他人使用。</span>
            <Button size="sm" variant="secondary" onClick={() => setPasswordOpen(true)}>
              修改密码
            </Button>
          </div>
        )}

        <main className="content fade-in" key={view}>
          {renderPage()}
        </main>

        <nav className="bottom-nav" aria-label="底部导航">
          {[
            { key: "dashboard" as ViewKey, label: "总览", icon: LayoutDashboard, show: true },
            {
              key: (user.permissions.score ? "quick-score" : "students") as ViewKey,
              label: user.permissions.score ? "记分" : "学生",
              icon: user.permissions.score ? Zap : Users,
              show: true,
            },
            { key: "records" as ViewKey, label: "记录", icon: ListChecks, show: true },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                className={cn("bottom-nav-item", view === item.key && "is-active")}
                onClick={() => navigate(item.key)}
              >
                <span className="bottom-nav-icon">
                  <Icon size={20} />
                </span>
                {item.label}
              </button>
            );
          })}
          <button type="button" className="bottom-nav-item" onClick={() => setDrawerOpen(true)}>
            <span className="bottom-nav-icon">
              <Menu size={20} />
            </span>
            更多
          </button>
        </nav>
      </div>

      <ChangePasswordModal
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        onSuccess={async () => {
          await loadMe();
          toast("密码已更新，其他设备的登录已失效", "success");
        }}
      />
    </div>
  );
}

function ChangePasswordModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setError("");
    }
  }, [open]);

  async function submit() {
    setError("");
    if (newPassword.length < 10) {
      setError("新密码至少需要 10 个字符");
      return;
    }
    if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setError("新密码必须同时包含字母和数字");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    setSaving(true);
    try {
      await api("/auth/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      await onSuccess();
      onClose();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "修改密码失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="修改密码"
      description="密码至少 10 位，需同时包含字母和数字；修改后其他设备需要重新登录。"
      size="sm"
      footer={
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button loading={saving} onClick={() => void submit()}>
            保存
          </Button>
        </div>
      }
    >
      <div className="stack">
        <Field label="当前密码" required>
          <Input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </Field>
        <Field label="新密码" required hint="至少 10 位，包含字母和数字">
          <Input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </Field>
        <Field label="确认新密码" required>
          <Input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </Field>
        {error && <div className="alert alert-danger">{error}</div>}
      </div>
    </Modal>
  );
}

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
);
