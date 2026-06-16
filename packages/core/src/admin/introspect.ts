import type Database from "better-sqlite3";
import type {
  IntrospectedColumn,
  IntrospectedForeignKey,
  IntrospectedIndex,
  IntrospectedSchema,
  IntrospectedTable,
} from "@localbase/shared";
import { isSystemTable } from "./system-tables.js";

/**
 * Raw row shapes returned by SQLite's PRAGMA statements. The better-sqlite3
 * typing for these is `unknown`, so we model them locally and validate by
 * usage (we only read documented columns).
 */
interface PragmaTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number; // 0 | 1
  dflt_value: unknown; // string | null
  pk: number; // 1..N (composite PK ordinal)
}

interface PragmaForeignKeyListRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface PragmaIndexListRow {
  seq: number;
  name: string;
  unique: number; // 0 | 1
  origin: string; // 'c' = CREATE INDEX, 'u' = UNIQUE, 'pk' = PRIMARY KEY
  partial: number; // 0 | 1
}

interface PragmaIndexInfoRow {
  seqno: number;
  cid: number;
  name: string;
}

interface PragmaTableCountRow {
  name: string;
}

/**
 * Introspect the actual schema of a SQLite database.
 *
 * Why this exists
 * ───────────────
 * The admin UI needs to show "what's really in the database", not "what
 * the user said should be in the config". A schema declared in
 * `localbase.config.ts` can drift from reality when:
 *
 *   - The user runs a raw SQL migration
 *   - An older version of the DB is opened with a newer config
 *   - The auth subsystem adds `_users`/`_sessions` after the fact
 *
 * So this queries SQLite's own metadata, not the `DatabaseSchema` object.
 *
 * Cost
 * ────
 * O(tables) PRAGMA calls. SQLite caches these, so this is fast enough
 * to call on every admin page load. We do not memoize at the call site —
 * the admin SPA can cache the result in TanStack Query.
 */
export function introspect(db: Database.Database): IntrospectedSchema {
  const tables = listUserVisibleTables(db);
  const introspected: IntrospectedTable[] = [];

  for (const name of tables) {
    introspected.push(introspectTable(db, name));
  }

  return { tables: introspected };
}

function introspectTable(
  db: Database.Database,
  name: string
): IntrospectedTable {
  const cols = db
    .prepare(`PRAGMA table_info("${name}")`)
    .all() as PragmaTableInfoRow[];

  // Order columns by their `cid` (ordinal position in the table).
  const columns: IntrospectedColumn[] = cols
    .slice()
    .sort((a, b) => a.cid - b.cid)
    .map((c) => {
      // INTEGER PRIMARY KEY (without explicit AUTOINCREMENT) is a
      // rowid alias and is auto-incrementing by definition. With
      // AUTOINCREMENT it's also the rowid. We treat both the same.
      const isInteger = (c.type ?? "").toUpperCase().includes("INTEGER");
      // SQLite's `pragma table_info` reports `notnull` from the
      // *explicit* NOT NULL constraint only. PRIMARY KEY columns are
      // implicitly NOT NULL — a table with `id INTEGER PRIMARY KEY`
      // will have `notnull: 0` here even though you cannot store NULL.
      // We surface the truth to the admin so it doesn't show a
      // misleading "Nullable: yes" on primary keys.
      const primaryKey = c.pk > 0;
      return {
        name: c.name,
        type: (c.type ?? "").toUpperCase() || "TEXT",
        notNull: c.notnull === 1 || primaryKey,
        primaryKey,
        autoIncrement: isInteger && primaryKey,
        defaultValue: c.dflt_value == null ? null : String(c.dflt_value),
      };
    });

  const primaryKey = columns.filter((c) => c.primaryKey).map((c) => c.name);

  const fks = db
    .prepare(`PRAGMA foreign_key_list("${name}")`)
    .all() as PragmaForeignKeyListRow[];

  const foreignKeys: IntrospectedForeignKey[] = fks.map((fk) => ({
    fromColumn: fk.from,
    toTable: fk.table,
    toColumn: fk.to,
  }));

  const idxList = db
    .prepare(`PRAGMA index_list("${name}")`)
    .all() as PragmaIndexListRow[];

  const indexes: IntrospectedIndex[] = [];
  for (const idx of idxList) {
    // Skip auto-created indexes (origin: 'pk' for the implicit primary
    // key index, 'u' for implicit UNIQUE indexes). These aren't useful
    // to surface — the user already sees the underlying constraint on
    // the column.
    if (idx.origin === "pk") continue;

    const idxCols = db
      .prepare(`PRAGMA index_info("${idx.name}")`)
      .all() as PragmaIndexInfoRow[];

    indexes.push({
      name: idx.name,
      unique: idx.unique === 1,
      columns: idxCols
        .slice()
        .sort((a, b) => a.seqno - b.seqno)
        .map((c) => c.name),
    });
  }

  // `SELECT COUNT(*)` is O(n) on SQLite. For a dev/admin tool this is
  // fine — the tables it operates on are small. If we ever need to handle
  // million-row tables, switch to reading `sqlite_stat1` or a cached
  // count updated by triggers.
  const countRow = db
    .prepare(`SELECT COUNT(*) AS name FROM "${name}"`)
    .get() as PragmaTableCountRow;
  const rowCount = Number(countRow.name) || 0;

  return {
    name,
    columns,
    primaryKey,
    foreignKeys,
    indexes,
    rowCount,
    system: isSystemTable(name),
  };
}

/**
 * Returns the names of all tables the admin should surface. This includes
 * LocalBase's own `_`-prefixed tables (so the schema viewer can show them
 * with the `system: true` flag) and skips SQLite's own bookkeeping tables.
 */
function listUserVisibleTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT "name" FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'`
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}
