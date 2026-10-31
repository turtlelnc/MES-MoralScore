// Fetch wrapper with cookie sessions, JSON errors and session-expiry events.
export class ApiError extends Error {
  status: number;
  retryAfterMs: number;
  issues?: Array<{ path: Array<string | number>; message: string }>;

  constructor(message: string, status: number, retryAfterMs = 0, issues?: ApiError["issues"]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.issues = issues;
  }
}

export async function api<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body instanceof FormData ? {} : { "content-type": "application/json" }),
    ...((options.headers as Record<string, string>) || {}),
  };
  const response = await fetch(`/api${url}`, {
    credentials: "include",
    ...options,
    headers,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000),
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => "");
  if (!response.ok) {
    const payload = (data || {}) as { error?: string; issues?: ApiError["issues"] };
    // 初始 /me 探测返回 401 属于正常“未登录”，不应触发“会话已失效”提示；
    // 其他接口（页面加载/写操作）的 401 才广播全局会话失效事件。
    if (response.status === 401 && !url.startsWith("/auth/login") && url !== "/me") {
      window.dispatchEvent(new CustomEvent("mes-session-expired"));
    }
    throw new ApiError(
      payload.error || `请求失败（${response.status}）`,
      response.status,
      Math.max(0, Number(response.headers.get("retry-after")) || 0) * 1000,
      payload.issues,
    );
  }
  return data as T;
}

export const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const result = search.toString();
  return result ? `?${result}` : "";
}

/** Download an authenticated file (CSV export etc.) as a browser download. */
export async function download(url: string, fallbackName = "export.csv"): Promise<void> {
  const response = await fetch(`/api${url}`, { credentials: "include" });
  if (!response.ok) {
    let message = `下载失败（${response.status}）`;
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch {
      // ignore
    }
    if (response.status === 401) window.dispatchEvent(new CustomEvent("mes-session-expired"));
    throw new ApiError(message, response.status);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const match = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"/.exec(disposition);
  const name = match ? decodeURIComponent(match[1] || match[2]) : fallbackName;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}
