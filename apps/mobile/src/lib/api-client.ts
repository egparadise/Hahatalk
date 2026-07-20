import type {
  InitiateMediaUploadInput,
  MediaUploadSessionView,
  MobileAuthView,
  MobileLoginInput,
  MobilePlatform,
  ShareMediaAssetInput
} from "@hahatalk/contracts";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { File } from "expo-file-system";
import { Platform } from "react-native";

type JsonBody = Record<string, unknown> | readonly unknown[];
type ApiRequest = {
  body?: JsonBody;
  headers?: Record<string, string>;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  retryAuth?: boolean;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function configuredApiUrl() {
  const fromConfig = Constants.expoConfig?.extra?.apiUrl;
  const raw = process.env.EXPO_PUBLIC_API_URL ?? (typeof fromConfig === "string" ? fromConfig : "");
  const normalized = raw.trim().replace(/\/$/, "");
  if (!/^https:\/\//i.test(normalized) && !(__DEV__ && /^http:\/\/(127\.0\.0\.1|10\.0\.2\.2|localhost|192\.168\.|10\.)/i.test(normalized))) {
    throw new Error("HahaTalk API URL must use HTTPS outside local development.");
  }
  return normalized;
}

function platform(): MobilePlatform {
  return Platform.OS === "ios" ? "ios" : "android";
}

function appVersion() {
  return Application.nativeApplicationVersion ?? "0.19.0";
}

async function responsePayload(response: Response) {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return response.json();
  return response.text();
}

function messageFromError(payload: unknown, status: number) {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string") return message;
    if (Array.isArray(message)) return message.filter((item): item is string => typeof item === "string").join(" ");
  }
  return `HahaTalk request failed (${status}).`;
}

class MobileApiClient {
  private session: MobileAuthView | null = null;
  private installationId = "";
  private refreshPromise: Promise<MobileAuthView> | null = null;
  private sessionListener: ((session: MobileAuthView | null) => Promise<void> | void) | null = null;

  configure(
    session: MobileAuthView | null,
    installationId: string,
    onSessionChange: (session: MobileAuthView | null) => Promise<void> | void
  ) {
    this.session = session;
    this.installationId = installationId;
    this.sessionListener = onSessionChange;
  }

  currentSession() {
    return this.session;
  }

  baseUrl() {
    return configuredApiUrl();
  }

  async login(email: string, password: string) {
    const input: MobileLoginInput = {
      appVersion: appVersion(),
      email: email.trim().toLowerCase(),
      installationId: this.installationId,
      password,
      platform: platform()
    };
    const session = await this.publicRequest<MobileAuthView>("/auth/mobile/login", {
      body: input as unknown as JsonBody,
      method: "POST"
    });
    await this.replaceSession(session);
    return session;
  }

  async logout() {
    try {
      if (this.session) await this.request<{ ok: boolean }>("/auth/logout", { body: {}, method: "POST", retryAuth: false });
    } finally {
      await this.replaceSession(null);
    }
  }

  async request<T>(path: string, options: ApiRequest = {}): Promise<T> {
    if (!this.session) throw new ApiError("Sign in is required.", 401);
    const response = await this.fetchJson(path, options, this.session.accessToken);
    if (response.ok) return response.body as T;
    if (response.status === 401 && options.retryAuth !== false) {
      await this.refresh();
      const retried = await this.fetchJson(path, { ...options, retryAuth: false }, this.session!.accessToken);
      if (retried.ok) return retried.body as T;
      throw new ApiError(messageFromError(retried.body, retried.status), retried.status, retried.body);
    }
    throw new ApiError(messageFromError(response.body, response.status), response.status, response.body);
  }

  async contentUrl(assetId: string, variant: "preview" | "original" = "preview") {
    if (!this.session) throw new ApiError("Sign in is required.", 401);
    return `${this.baseUrl()}/media/assets/${encodeURIComponent(assetId)}/content?variant=${variant}`;
  }

  authorizationHeaders() {
    if (!this.session) return { "X-HahaTalk-Client": "mobile-v1" };
    return {
      Authorization: `Bearer ${this.session.accessToken}`,
      "X-HahaTalk-Client": "mobile-v1"
    };
  }

  async ensureFreshAccess(minValidityMs = 120_000) {
    if (!this.session) throw new ApiError("Sign in is required.", 401);
    const remainingMs = Date.parse(this.session.accessExpiresAt) - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= minValidityMs) await this.refresh();
    return this.session!;
  }

  async uploadFile(file: File, input: InitiateMediaUploadInput): Promise<MediaUploadSessionView> {
    const upload = await this.request<MediaUploadSessionView>("/media/uploads", {
      body: input as unknown as JsonBody,
      method: "POST"
    });
    try {
      for (let partNumber = 1; partNumber <= upload.partCount; partNumber += 1) {
        const start = (partNumber - 1) * upload.partSizeBytes;
        const end = Math.min(file.size, start + upload.partSizeBytes);
        const body = file.slice(start, end);
        const part = await this.fetchBinary(`/media/uploads/${upload.id}/parts/${partNumber}`, body);
        if (!part.ok) throw new ApiError(messageFromError(part.body, part.status), part.status, part.body);
      }
      return this.request<MediaUploadSessionView>(`/media/uploads/${upload.id}/complete`, {
        body: {},
        method: "POST"
      });
    } catch (error) {
      await this.request(`/media/uploads/${upload.id}`, { method: "DELETE", retryAuth: false }).catch(() => undefined);
      throw error;
    }
  }

  shareAsset(assetId: string, input: ShareMediaAssetInput) {
    return this.request(`/media/assets/${assetId}/share`, {
      body: input as unknown as JsonBody,
      method: "POST"
    });
  }

  private async publicRequest<T>(path: string, options: ApiRequest): Promise<T> {
    const result = await this.fetchJson(path, options);
    if (!result.ok) throw new ApiError(messageFromError(result.body, result.status), result.status, result.body);
    return result.body as T;
  }

  private async fetchJson(path: string, options: ApiRequest, accessToken?: string) {
    const response = await fetch(`${this.baseUrl()}${path}`, {
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      headers: {
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        "X-HahaTalk-Client": "mobile-v1",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...options.headers
      },
      method: options.method ?? "GET"
    });
    return { body: await responsePayload(response), ok: response.ok, status: response.status };
  }

  private async fetchBinary(path: string, body: Blob) {
    if (!this.session) throw new ApiError("Sign in is required.", 401);
    let response = await fetch(`${this.baseUrl()}${path}`, {
      body,
      headers: {
        Authorization: `Bearer ${this.session.accessToken}`,
        "Content-Type": "application/octet-stream",
        "X-HahaTalk-Client": "mobile-v1"
      },
      method: "PUT"
    });
    if (response.status === 401) {
      await this.refresh();
      response = await fetch(`${this.baseUrl()}${path}`, {
        body,
        headers: {
          Authorization: `Bearer ${this.session!.accessToken}`,
          "Content-Type": "application/octet-stream",
          "X-HahaTalk-Client": "mobile-v1"
        },
        method: "PUT"
      });
    }
    return { body: await responsePayload(response), ok: response.ok, status: response.status };
  }

  private refresh() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.rotateRefreshToken().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async rotateRefreshToken() {
    const current = this.session;
    if (!current) throw new ApiError("Sign in is required.", 401);
    try {
      const next = await this.publicRequest<MobileAuthView>("/auth/mobile/refresh", {
        body: {
          appVersion: appVersion(),
          installationId: this.installationId,
          platform: platform(),
          refreshToken: current.refreshToken
        },
        method: "POST"
      });
      await this.replaceSession(next);
      return next;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        await this.replaceSession(null);
      }
      throw error;
    }
  }

  private async replaceSession(session: MobileAuthView | null) {
    this.session = session;
    await this.sessionListener?.(session);
  }
}

export const mobileApi = new MobileApiClient();
