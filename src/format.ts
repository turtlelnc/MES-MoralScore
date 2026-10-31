// Display formatting helpers shared by pages.
export const CN_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDate(value?: string | Date | null): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(value?: string | Date | null): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatMonthDay(value?: string | Date | null): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayInput(): string {
  const date = new Date();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dateTimeLocalInput(value?: string | Date | null): string {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function toIso(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const number = Number(value);
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

export function formatSignedScore(value: number): string {
  return `${value > 0 ? "+" : ""}${formatScore(value)}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function relativeTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDate(date);
}

export function percent(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

export function roleTone(role: string): "brand" | "warning" | "info" {
  if (role === "SYSTEM_ADMIN") return "info";
  if (role === "MORAL_AFFAIRS") return "warning";
  return "brand";
}

export function recordStatusTone(status: string, reversed = false): "success" | "warning" | "danger" | "neutral" {
  if (reversed) return "neutral";
  if (status === "EFFECTIVE") return "success";
  if (status === "PENDING_REVIEW") return "warning";
  if (status === "REJECTED") return "danger";
  return "neutral";
}

export function directionTone(direction: "ADD" | "DEDUCT"): "add" | "deduct" {
  return direction === "ADD" ? "add" : "deduct";
}

export function periodLabel(period: string): string {
  if (period === "week") return "本周";
  if (period === "month") return "本月";
  return "本学期";
}
