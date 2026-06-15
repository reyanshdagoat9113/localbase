import type { RealtimeFilter } from "@localbase/shared";

/**
 * Check whether a row matches all of the given realtime filters.
 */
export function rowMatchesFilters(
  row: Record<string, unknown>,
  filters: RealtimeFilter[]
): boolean {
  for (const filter of filters) {
    if (!rowMatchesFilter(row, filter)) {
      return false;
    }
  }
  return true;
}

function rowMatchesFilter(
  row: Record<string, unknown>,
  filter: RealtimeFilter
): boolean {
  const actual = row[filter.column];
  const expected = filter.value;

  switch (filter.operator) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "gt":
      return compare(actual, expected) > 0;
    case "lt":
      return compare(actual, expected) < 0;
    case "gte":
      return compare(actual, expected) >= 0;
    case "lte":
      return compare(actual, expected) <= 0;
    case "like": {
      if (typeof expected !== "string" || typeof actual !== "string") {
        return false;
      }
      const regex = new RegExp(
        "^" + expected.replace(/%/g, ".*").replace(/_/g, ".") + "$"
      );
      return regex.test(actual);
    }
    case "in":
      if (!Array.isArray(expected)) return false;
      return expected.includes(actual);
    default:
      return false;
  }
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b);
  }
  return String(a).localeCompare(String(b));
}
