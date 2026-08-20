export type JsonRequestOptions = RequestInit;

export async function getJson<T>(url: string, options?: JsonRequestOptions): Promise<T> {
  const response = await fetch(url, options);
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null
      ? (payload as { error?: unknown; message?: unknown }).error ?? (payload as { message?: unknown }).message
      : undefined;
    throw new Error(typeof message === "string" ? message : "Request failed");
  }
  return payload as T;
}

export async function getJsonWithTimeout<T>(url: string, options: JsonRequestOptions = {}, timeoutMs = 5000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await getJson<T>(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}
