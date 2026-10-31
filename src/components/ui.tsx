// Shared design-system components. Pages must reuse these primitives.
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  X,
} from "lucide-react";

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ Button */
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn("btn", `btn-${variant}`, size !== "md" && `btn-${size}`, className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 size={16} className="spin" aria-hidden /> : icon}
      {children !== undefined && children !== null && <span>{children}</span>}
    </button>
  );
}

/* -------------------------------------------------------------------- Card */
export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  padded = true,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  padded?: boolean;
}) {
  return (
    <section className={cn("card", className)}>
      {(title || actions || subtitle) && (
        <div className="card-header">
          <div className="card-title-group">
            {title && <h3 className="card-title">{title}</h3>}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      <div className={cn("card-body", !padded && "card-body-flush", bodyClassName)}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------- Badge */
export type BadgeTone =
  | "success"
  | "danger"
  | "warning"
  | "info"
  | "brand"
  | "neutral"
  | "add"
  | "deduct";

export function Badge({
  tone = "neutral",
  children,
  className,
  dot = false,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span className={cn("badge", `badge-${tone}`, className)}>
      {dot && <span className="badge-dot" aria-hidden />}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------- Field */
export function Field({
  label,
  required = false,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: React.ReactNode;
  required?: boolean;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("field", className)}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="required-mark" aria-hidden>
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn("input", className)} {...rest} />;
  },
);

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn("select", className)} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn("textarea", className)} {...rest} />;
});

export function Checkbox({
  label,
  className,
  ...rest
}: { label: React.ReactNode } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cn("checkbox", className)}>
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}

/* ------------------------------------------------------------------- Modal */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  closeOnBackdrop = true,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  closeOnBackdrop?: boolean;
}) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const focusable = cardRef.current?.querySelector<HTMLElement>(
        "input, select, textarea, button:not([data-modal-close])",
      );
      focusable?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className={cn("modal-card", `modal-${size}`)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="modal-head">
          <div>
            <h2 id={titleId} className="modal-title">
              {title}
            </h2>
            {description && <p className="modal-desc">{description}</p>}
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="关闭"
            data-modal-close
          >
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  loading = false,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {children}
    </Modal>
  );
}

/* -------------------------------------------------------------- Empty/Load */
export function EmptyState({
  title,
  description,
  action,
  icon,
  compact = false,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn("empty", compact && "empty-compact")}>
      {icon && <div className="empty-icon">{icon}</div>}
      <h4 className="empty-title">{title}</h4>
      {description && <p className="empty-desc">{description}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Loading({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="loading-block" role="status" aria-live="polite">
      <Loader2 size={20} className="spin" />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("skeleton-group", className)} aria-hidden>
      {Array.from({ length: lines }).map((_, index) => (
        <div key={index} className="skeleton" style={{ width: `${92 - index * 12}%` }} />
      ))}
    </div>
  );
}

export function Alert({
  tone = "danger",
  children,
  title,
  onRetry,
}: {
  tone?: "danger" | "warning" | "info" | "success";
  children: React.ReactNode;
  title?: React.ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className={cn("alert", `alert-${tone}`)} role={tone === "danger" ? "alert" : "status"}>
      <span className="alert-icon" aria-hidden>
        {tone === "success" ? <CheckCircle2 size={18} /> : tone === "info" ? <Info size={18} /> : <AlertCircle size={18} />}
      </span>
      <div className="alert-body">
        {title && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
      {onRetry && (
        <button type="button" className="btn btn-sm btn-secondary" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Header */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-heading">
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = "brand",
  suffix,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: "brand" | "add" | "deduct" | "warn" | "neutral";
  suffix?: React.ReactNode;
}) {
  return (
    <div className={cn("stat-card", `stat-${tone}`)}>
      <div className="stat-head">
        <span className="stat-label">{label}</span>
        {icon && <span className="stat-icon">{icon}</span>}
      </div>
      <div className="stat-value">
        {value}
        {suffix && <small className="stat-suffix">{suffix}</small>}
      </div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function SectionTitle({
  title,
  hint,
  actions,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        <h2>{title}</h2>
        {hint && <p className="section-hint">{hint}</p>}
      </div>
      {actions && <div className="section-actions">{actions}</div>}
    </div>
  );
}

/* --------------------------------------------------------------- Segmented */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = "md",
}: {
  value: T;
  options: Array<{ value: T; label: React.ReactNode; count?: number }>;
  onChange: (value: T) => void;
  ariaLabel?: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={cn("segmented", size === "sm" && "segmented-sm")} role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={cn("segmented-item", value === option.value && "is-active")}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && <span className="segmented-count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Pagination */
export function Pagination({
  page,
  totalPages,
  total,
  onChange,
  unit = "条",
}: {
  page: number;
  totalPages: number;
  total: number;
  onChange: (page: number) => void;
  unit?: string;
}) {
  if (total <= 0) return null;
  return (
    <nav className="pagination" aria-label="分页">
      <span className="pagination-total">
        共 {total} {unit}
      </span>
      <div className="pagination-controls">
        <button
          type="button"
          className="icon-btn"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          aria-label="上一页"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="pagination-page">
          {page} / {totalPages}
        </span>
        <button
          type="button"
          className="icon-btn"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
          aria-label="下一页"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------- Toast */
export type ToastTone = "success" | "error" | "info" | "warning";
type ToastItem = { id: number; message: React.ReactNode; tone: ToastTone };
type ToastContextValue = (message: React.ReactNode, tone?: ToastTone) => void;

const ToastContext = createContext<ToastContextValue>(() => {});

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const push = useCallback<ToastContextValue>((message, tone = "info") => {
    counter.current += 1;
    const id = counter.current;
    setItems((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, 4200);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="toast-stack" aria-live="polite" aria-atomic="false">
          {items.map((item) => (
            <div key={item.id} className={cn("toast", `toast-${item.tone}`)} role="status">
              <span className="toast-icon" aria-hidden>
                {item.tone === "success" ? (
                  <CheckCircle2 size={18} />
                ) : item.tone === "error" ? (
                  <AlertCircle size={18} />
                ) : (
                  <Info size={18} />
                )}
              </span>
              <div className="toast-message">{item.message}</div>
              <button
                type="button"
                className="toast-close"
                aria-label="关闭提示"
                onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/* ---------------------------------------------------------------- utilities */
export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="spin" aria-hidden />;
}

/** 用于页面内「小提示」的轻量高亮块。 */
export function Notice({
  children,
  tone = "info",
}: {
  children: React.ReactNode;
  tone?: "info" | "warning" | "danger";
}) {
  return <div className={cn("notice", `notice-${tone}`)}>{children}</div>;
}
