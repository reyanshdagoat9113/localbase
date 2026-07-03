import { QueryBuilder } from "./query-builder.js";
import { createAuthClient, type AuthClient } from "./auth-client.js";
import {
  RealtimeClient,
  type PresenceCallback,
  type RealtimeCallback,
  type SubscribeOptions,
} from "./realtime.js";
import {
  createStorageClient,
  type StorageClient,
  type StorageBucketClient,
  type StorageFile,
  type UploadResult,
  type StorageResponse,
  type CreateSignedUrlOptions,
} from "./storage.js";
import type { StoredSession } from "./auth.js";
import type { RealtimeConfig } from "@localbase/shared";

export interface LocalBaseClient {
  from<T = unknown>(table: string): QueryBuilder<T>;
  auth: AuthClient;
  storage: StorageClient;
  subscribe<T = unknown>(table: string, callback: RealtimeCallback<T>): () => void;
  subscribe<T = unknown>(
    table: string,
    options: SubscribeOptions,
    callback: RealtimeCallback<T>
  ): () => void;
  presence<T = unknown>(
    channel: string,
    key: string,
    metadata: T,
    callback: PresenceCallback<T>
  ): { update(metadata: T): void; leave(): void };
}

export interface CreateClientOptions {
  realtime?: RealtimeConfig;
}

/**
 * Create a LocalBase SDK client.
 *
 * The returned object holds session state in a closure, so `db.auth.signIn`
 * and `db.from(...).select(...)` always see the same token. Persist the
 * session with `db.auth.setSession(...)` to survive page reloads.
 *
 * @example
 * ```ts
 * const db = createClient("http://localhost:5180");
 * await db.auth.signIn({ email, password });
 * const user = await db.auth.getUser();
 * const posts = await db.from("posts").select("*");
 * ```
 */
export function createClient(url: string, options: CreateClientOptions = {}): LocalBaseClient {
  const baseUrl = url.replace(/\/+$/, "");

  // Session state lives in the closure. Both `auth` and the query builder
  // read through the getter, so signIn → query always picks up the new token.
  let session: StoredSession | null = null;
  const getSession = () => session;
  const setSession = (s: StoredSession | null) => {
    session = s;
  };

  const auth = createAuthClient(baseUrl, getSession, setSession);
  const storage = createStorageClient(baseUrl, () => session?.accessToken);
  const realtime = new RealtimeClient(
    baseUrl,
    () => session?.accessToken,
    options.realtime?.path ?? "/realtime",
    options.realtime?.enabled ?? true
  );

  return {
    from<T = unknown>(table: string): QueryBuilder<T> {
      return new QueryBuilder<T>(baseUrl, table, () => session?.accessToken);
    },
    auth,
    storage,
    subscribe<T = unknown>(
      table: string,
      optionsOrCallback: SubscribeOptions | RealtimeCallback<T>,
      maybeCallback?: RealtimeCallback<T>
    ): () => void {
      if (typeof optionsOrCallback === "function") {
        return realtime.subscribe<T>(table, optionsOrCallback);
      }
      return realtime.subscribe<T>(
        table,
        optionsOrCallback,
        maybeCallback as RealtimeCallback<T>
      );
    },
    presence<T = unknown>(
      channel: string,
      key: string,
      metadata: T,
      callback: PresenceCallback<T>
    ): { update(metadata: T): void; leave(): void } {
      return realtime.presence(channel, key, metadata, callback);
    },
  };
}
