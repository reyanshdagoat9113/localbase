import type { DatabaseSchema, PoliciesConfig } from "@localbase/shared";
import type { Filter } from "./query.js";

/**
 * A validated, ready-to-use RLS policy. Produced by {@link resolvePolicies} from
 * the user-declared {@link PoliciesConfig} and consulted by the `/api/:table`
 * handlers in `api.ts` to scope requests to the owning user.
 */
export interface ResolvedPolicy {
  table: string;
  ownerColumn: string;
  /** When true, admin-role users skip owner scoping on this table. */
  adminBypass: boolean;
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate the user-declared policies and resolve them into a fast lookup map
 * keyed by table name. Throws on misconfiguration (unknown table or owner
 * column) so the error surfaces loudly at startup rather than silently
 * exposing data. Called once per server.
 *
 * Note: this validates against the *user* schema only. Auth system tables
 * (`_users`, `_sessions`) are never policy targets — they are managed through
 * the typed auth/admin surfaces, never the public `/api/:table` route.
 */
export function resolvePolicies(
  policies: PoliciesConfig | undefined,
  schema: DatabaseSchema
): Map<string, ResolvedPolicy> {
  const map = new Map<string, ResolvedPolicy>();
  if (!policies) return map;

  for (const [table, policy] of Object.entries(policies)) {
    const tableSchema = schema[table];
    if (!tableSchema) {
      throw new Error(`RLS policy references unknown table "${table}"`);
    }

    const ownerColumn = policy?.ownerColumn;
    if (typeof ownerColumn !== "string" || !IDENT.test(ownerColumn)) {
      throw new Error(
        `RLS policy for "${table}" has an invalid ownerColumn "${String(
          ownerColumn
        )}". Must be a valid identifier.`
      );
    }
    if (!(ownerColumn in tableSchema)) {
      throw new Error(
        `RLS policy for "${table}" references unknown column "${ownerColumn}".`
      );
    }

    map.set(table, {
      table,
      ownerColumn,
      adminBypass: policy.adminBypass === true,
    });
  }

  return map;
}

/**
 * The `Filter` that scopes a read/update/delete to the calling user. ANDed into
 * the query alongside any user-supplied filters by `buildWhereClause`.
 */
export function ownerFilter(policy: ResolvedPolicy, userId: number): Filter {
  return { column: policy.ownerColumn, operator: "eq", value: userId };
}

/**
 * Stamp the owner column onto an insert body, overriding any client-supplied
 * value so a request can never create a row owned by another user. Mutates
 * `body` in place.
 */
export function stampOwner(
  policy: ResolvedPolicy,
  body: Record<string, unknown>,
  userId: number
): void {
  body[policy.ownerColumn] = userId;
}
