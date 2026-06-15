export { createClient } from "./client.js";
export type { CreateClientOptions, LocalBaseClient } from "./client.js";
export { QueryBuilder } from "./query-builder.js";
export type { ResponseShape } from "./query-builder.js";
export { createAuthClient } from "./auth-client.js";
export type { AuthClient } from "./auth-client.js";
export { RealtimeClient } from "./realtime.js";
export type {
  RealtimeCallback,
  SubscribeOptions,
} from "./realtime.js";
export type {
  AuthUser,
  AuthSession,
  AuthResponse,
  SignInResponse,
  StoredSession,
} from "./auth.js";
export { VERSION } from "@localbase/shared";
