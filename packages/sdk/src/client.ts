import { QueryBuilder } from "./query-builder.js";

export interface LocalBaseClient {
  from<T = unknown>(table: string): QueryBuilder<T>;
}

export function createClient(url: string): LocalBaseClient {
  const baseUrl = url.replace(/\/+$/, "");

  return {
    from<T = unknown>(table: string): QueryBuilder<T> {
      return new QueryBuilder<T>(baseUrl, table);
    },
  };
}
