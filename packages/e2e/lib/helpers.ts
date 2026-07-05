import { expect, type APIRequestContext } from "@playwright/test";

export interface AuthSession {
  user: { id: number; email: string; role: "user" | "admin" | "owner"; created_at?: string };
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Counter so unique values stay unique within a single test run. */
let counter = 0;
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** POST /api/auth/signin → session. Throws via expect if it fails. */
export async function signIn(
  request: APIRequestContext,
  baseUrl: string,
  email: string,
  password: string
): Promise<AuthSession> {
  const res = await request.post(`${baseUrl}/api/auth/signin`, {
    data: { email, password },
  });
  const body = await res.json();
  expect(body.data, `signin failed for ${email}: ${body.error ?? res.status()}`).toBeTruthy();
  return body.data as AuthSession;
}

/** Build an Authorization header from a session. */
export function bearer(session: AuthSession): { Authorization: string } {
  return { Authorization: `Bearer ${session.accessToken}` };
}

/** Insert a row through the admin API and return it. */
export async function adminInsert(
  request: APIRequestContext,
  baseUrl: string,
  session: AuthSession,
  table: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await request.post(`${baseUrl}/_api/admin/tables/${table}/rows`, {
    headers: bearer(session),
    data,
  });
  const body = await res.json();
  expect(body.data, `admin insert into ${table} failed: ${body.error ?? res.status()}`).toBeTruthy();
  return body.data as Record<string, unknown>;
}

/** Fetch a single row by id through the admin API. */
export async function adminGet(
  request: APIRequestContext,
  baseUrl: string,
  session: AuthSession,
  table: string,
  id: string | number
): Promise<Record<string, unknown> | null> {
  const res = await request.get(
    `${baseUrl}/_api/admin/tables/${table}/rows?${encodeURIComponent("id")}=${encodeURIComponent(`eq.${id}`)}`,
    { headers: bearer(session) }
  );
  const body = await res.json();
  const rows = (body.data?.rows ?? []) as Record<string, unknown>[];
  return rows.find((r) => String(r.id) === String(id)) ?? null;
}

/** Upload a file to a storage bucket (multipart) through the storage API. */
export async function uploadFile(
  request: APIRequestContext,
  baseUrl: string,
  session: AuthSession,
  bucket: string,
  filename: string,
  content: string
): Promise<{ storedName: string; originalName: string }> {
  const buffer = Buffer.from(content, "utf8");
  const res = await request.post(`${baseUrl}/api/storage/${bucket}`, {
    headers: bearer(session),
    multipart: { file: { name: filename, mimeType: "text/plain", buffer } },
  });
  const body = await res.json();
  expect(body.data, `upload to ${bucket} failed: ${body.error ?? res.status()}`).toBeTruthy();
  return { storedName: body.data.storedName, originalName: body.data.originalName };
}
