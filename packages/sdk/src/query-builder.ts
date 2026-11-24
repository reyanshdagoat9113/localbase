type FilterOperator = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "like" | "in";

interface Filter {
  column: string;
  operator: FilterOperator;
  value: unknown;
}

interface OrderBy {
  column: string;
  direction: "asc" | "desc";
}

type QueryMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface ResponseShape<T = unknown> {
  data: T | null;
  error: string | null;
}

export class QueryBuilder<T = unknown> implements PromiseLike<ResponseShape<T>> {
  private _table: string;
  private _baseUrl: string;
  private _method: QueryMethod = "GET";
  private _filters: Filter[] = [];
  private _orderBy: OrderBy[] = [];
  private _limit?: number;
  private _offset?: number;
  private _single = false;
  private _body?: Record<string, unknown>;
  private _getToken: () => string | undefined;

  constructor(
    baseUrl: string,
    table: string,
    getToken: () => string | undefined = () => undefined
  ) {
    this._baseUrl = baseUrl;
    this._table = table;
    this._getToken = getToken;
  }

  select(_columns = "*"): this {
    this._method = "GET";
    return this;
  }

  insert(data: Record<string, unknown>): Promise<ResponseShape<T>> {
    this._method = "POST";
    this._body = data;
    return this._execute();
  }

  update(data: Record<string, unknown>): this {
    this._method = "PATCH";
    this._body = data;
    return this;
  }

  delete(): this {
    this._method = "DELETE";
    return this;
  }

  eq(column: string, value: unknown): this {
    this._filters.push({ column, operator: "eq", value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this._filters.push({ column, operator: "neq", value });
    return this;
  }

  gt(column: string, value: unknown): this {
    this._filters.push({ column, operator: "gt", value });
    return this;
  }

  lt(column: string, value: unknown): this {
    this._filters.push({ column, operator: "lt", value });
    return this;
  }

  gte(column: string, value: unknown): this {
    this._filters.push({ column, operator: "gte", value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this._filters.push({ column, operator: "lte", value });
    return this;
  }

  like(column: string, value: string): this {
    this._filters.push({ column, operator: "like", value });
    return this;
  }

  in(column: string, values: unknown[]): this {
    this._filters.push({ column, operator: "in", value: values });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this._orderBy.push({
      column,
      direction: options?.ascending === false ? "desc" : "asc",
    });
    return this;
  }

  limit(count: number): this {
    this._limit = count;
    return this;
  }

  offset(count: number): this {
    this._offset = count;
    return this;
  }

  single(): Promise<ResponseShape<T>> {
    this._single = true;
    return this._execute();
  }

  then<TResult1 = ResponseShape<T>, TResult2 = never>(
    onfulfilled?: ((value: ResponseShape<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this._execute().then(onfulfilled, onrejected);
  }

  private _buildUrl(): string {
    const base = `${this._baseUrl}/api/${this._table}`;

    if (this._method === "PATCH" || this._method === "DELETE") {
      const idFilter = this._filters.find((f) => f.column === "id" && f.operator === "eq");
      if (idFilter) {
        return `${base}/${encodeURIComponent(String(idFilter.value))}`;
      }
      return base;
    }

    const params = new URLSearchParams();

    for (const filter of this._filters) {
      const value =
        filter.operator === "in"
          ? (filter.value as unknown[]).join(",")
          : String(filter.value);
      params.append(filter.column, `${filter.operator}.${value}`);
    }

    if (this._orderBy.length > 0) {
      params.set(
        "order",
        this._orderBy.map((o) => `${o.column}.${o.direction}`).join(",")
      );
    }

    if (this._limit !== undefined) {
      params.set("limit", String(this._limit));
    } else if (this._single) {
      params.set("limit", "1");
    }

    if (this._offset !== undefined) {
      params.set("offset", String(this._offset));
    }

    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  private _buildOptions(): RequestInit {
    const init: RequestInit = { method: this._method };

    const headers: Record<string, string> = {};
    if (this._body) {
      headers["Content-Type"] = "application/json";
    }

    // Attach Bearer token if a session is active. The token is read
    // lazily on every request, so a `signIn` between two `.from(...)`
    // calls is picked up automatically.
    const token = this._getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    if (Object.keys(headers).length > 0) {
      init.headers = headers;
    }
    if (this._body) {
      init.body = JSON.stringify(this._body);
    }

    return init;
  }

  private async _execute(): Promise<ResponseShape<T>> {
    // The REST API only supports single-row PATCH/DELETE by primary key.
    // Fail fast with an actionable message instead of sending a request the
    // server will reject with a plain-text 404 or silently ignoring extra filters.
    if (this._method === "PATCH" || this._method === "DELETE") {
      const verb = this._method === "PATCH" ? "update" : "delete";
      const hasIdEq = this._filters.some(
        (f) => f.column === "id" && f.operator === "eq"
      );
      if (!hasIdEq) {
        return {
          data: null,
          error: `${verb}() requires .eq("id", value): LocalBase only supports ${verb} by primary key.`,
        };
      }
      if (this._filters.length > 1) {
        return {
          data: null,
          error: `${verb}() only supports a single .eq("id", value) filter; additional filters are not supported.`,
        };
      }
    }

    try {
      const url = this._buildUrl();
      const res = await fetch(url, this._buildOptions());
      const text = await res.text();
      let json: { data?: unknown; error?: string } = {};
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          return {
            data: null,
            error: `Request failed with status ${res.status}: ${text.slice(0, 200)}`,
          };
        }
      }

      if (!res.ok) {
        return {
          data: null,
          error: json.error || `Request failed with status ${res.status}`,
        };
      }

      if (this._single && Array.isArray(json.data)) {
        return { data: (json.data[0] as T) ?? null, error: null };
      }

      return { data: json.data as T, error: null };
    } catch (err) {
      return {
        data: null,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }
}
