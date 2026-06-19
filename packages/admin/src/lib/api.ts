import type { IntrospectedSchema } from "@localbase/shared";

export type UserRole = "user" | "admin";

export interface AuthUser {
  id: number;
  email: string;
  role: UserRole;
  created_at?: string;
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface TableSummary {
  name: string;
  rowCount: number;
  system: boolean;
}

interface ApiEnvelope<T> {
  data: T | null;
  error?: string | null;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const SESSION_KEY = "localbase.admin.session";

let currentSession: AuthSession | null = readSession();

type SessionListener = (session: AuthSession | null) => void;
const listeners = new Set<SessionListener>();

function readSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (
      parsed?.accessToken &&
      parsed.refreshToken &&
      parsed.user?.role === "admin"
    ) {
      return parsed;
    }
  } catch {
    // Corrupt local storage should not block the login page.
  }
  localStorage.removeItem(SESSION_KEY);
  return null;
}

export function subscribeSession(fn: SessionListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSession(): AuthSession | null {
  return currentSession;
}

export function setSession(session: AuthSession | null): void {
  currentSession = session;
  if (session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(SESSION_KEY);
  }
  for (const fn of listeners) fn(currentSession);
}

let refreshInFlight: Promise<AuthSession | null> | null = null;

async function rawFetch(
  path: string,
  init: RequestInit,
  opts: { withAuth: boolean; isRetry?: boolean }
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (opts.withAuth && currentSession) {
    headers.set("Authorization", `Bearer ${currentSession.accessToken}`);
  }
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && opts.withAuth && !opts.isRetry && currentSession) {
    const refreshed = await tryRefresh();
    if (refreshed) return rawFetch(path, init, { ...opts, isRetry: true });
    setSession(null);
  }
  return res;
}

function tryRefresh(): Promise<AuthSession | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refreshToken = currentSession?.refreshToken;
    if (!refreshToken) return null;
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return null;
      const payload = (await res.json()) as ApiEnvelope<AuthSession>;
      if (!payload.data) return null;
      setSession(payload.data);
      return payload.data;
    } catch {
      return null;
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return unwrap<T>(await rawFetch(path, init, { withAuth: true }));
}

async function postAuth<T>(path: string, body: unknown): Promise<T> {
  return unwrap<T>(
    await rawFetch(
      path,
      { method: "POST", body: JSON.stringify(body) },
      { withAuth: false }
    )
  );
}

async function unwrap<T>(res: Response): Promise<T> {
  const text = await res.text();
  let payload: ApiEnvelope<unknown> | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as ApiEnvelope<unknown>;
    } catch {
      // Non-JSON responses fall through to a generic error.
    }
  }

  const envelopeError =
    payload && typeof payload.error === "string" && payload.error.length > 0;
  if (!res.ok || envelopeError) {
    throw new ApiError(
      res.status,
      envelopeError ? payload!.error! : `Request failed (${res.status})`
    );
  }
  return (payload?.data ?? null) as T;
}

export async function signIn(
  email: string,
  password: string
): Promise<AuthSession> {
  const session = await postAuth<AuthSession>("/api/auth/signin", {
    email,
    password,
  });
  setSession(session.user.role === "admin" ? session : null);
  return session;
}

export async function signUp(
  email: string,
  password: string
): Promise<AuthSession> {
  const session = await postAuth<AuthSession>("/api/auth/signup", {
    email,
    password,
  });
  setSession(session.user.role === "admin" ? session : null);
  return session;
}

export async function signOut(): Promise<void> {
  const refreshToken = currentSession?.refreshToken;
  if (refreshToken) {
    try {
      await rawFetch(
        "/api/auth/signout",
        { method: "POST", body: JSON.stringify({ refreshToken }) },
        { withAuth: true }
      );
    } catch {
      // Local sign-out should always complete.
    }
  }
  setSession(null);
}

export function getSchema(): Promise<IntrospectedSchema> {
  return request<IntrospectedSchema>("/_api/admin/schema");
}

export function getTables(): Promise<TableSummary[]> {
  return request<TableSummary[]>("/_api/admin/tables");
}

export interface RowsResponse {
  rows: Record<string, unknown>[];
  total: number;
}

export interface GetRowsParams {
  limit?: number;
  offset?: number;
  order?: string;
  search?: string;
  searchColumn?: string;
}

export function getRows(
  table: string,
  params: GetRowsParams = {}
): Promise<RowsResponse> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.order) qs.set("order", params.order);
  if (params.search && params.searchColumn) {
    qs.set(params.searchColumn, `like.${params.search}`);
  }
  const query = qs.toString();
  return request<RowsResponse>(
    `/_api/admin/tables/${encodeURIComponent(table)}/rows${query ? `?${query}` : ""}`
  );
}

export function createRow(
  table: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(
    `/_api/admin/tables/${encodeURIComponent(table)}/rows`,
    { method: "POST", body: JSON.stringify(data) }
  );
}

export function updateRow(
  table: string,
  id: string | number,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(
    `/_api/admin/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(String(id))}`,
    { method: "PATCH", body: JSON.stringify(data) }
  );
}

export function deleteRow(
  table: string,
  id: string | number
): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(
    `/_api/admin/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(String(id))}`,
    { method: "DELETE" }
  );
}
