type HahaTalkDesktopBridge = {
  apiBaseUrl?: string;
  isDesktop: boolean;
  platform: string;
  version?: string;
};

const desktopBridge = typeof window === "undefined"
  ? undefined
  : (window as Window & { hahaTalkDesktop?: HahaTalkDesktopBridge }).hahaTalkDesktop;

export const apiBaseUrl = desktopBridge?.apiBaseUrl
  ?? process.env.NEXT_PUBLIC_API_BASE_URL
  ?? "http://127.0.0.1:4000";

export async function requestJson<TResponse>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  payload?: Record<string, unknown>
): Promise<TResponse> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    credentials: "include",
    headers: {
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      "X-HahaTalk-Client": "web-v1"
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return response.json() as Promise<TResponse>;
}

export function postJson<TResponse>(path: string, payload: Record<string, unknown>): Promise<TResponse> {
  return requestJson<TResponse>(path, "POST", payload);
}

export async function getJson<TResponse>(path: string): Promise<TResponse> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    credentials: "include"
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return response.json() as Promise<TResponse>;
}

export async function putBinary<TResponse>(
  path: string,
  content: Blob,
  sha256Hex: string,
  signal?: AbortSignal
): Promise<TResponse> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    body: content,
    credentials: "include",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-HahaTalk-Client": "web-v1",
      "X-HahaTalk-Part-Sha256": sha256Hex
    },
    method: "PUT",
    ...(signal ? { signal } : {})
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json() as Promise<TResponse>;
}

export async function fetchBinary(path: string, signal?: AbortSignal) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    credentials: "include",
    ...(signal ? { signal } : {})
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response;
}

export function resolveApiUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

async function readApiError(response: Response) {
  try {
    const body = await response.json() as { message?: string | string[]; error?: string };
    const message = Array.isArray(body.message) ? body.message.join(" ") : body.message;
    return message ?? body.error ?? `요청 실패 (${response.status})`;
  } catch {
    return `요청 실패 (${response.status})`;
  }
}
