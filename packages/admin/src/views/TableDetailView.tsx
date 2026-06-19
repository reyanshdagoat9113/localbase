import { useMemo, useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table";
import type { IntrospectedTable, IntrospectedColumn } from "@localbase/shared";
import {
  useSchema,
  useRows,
  useCreateRow,
  useUpdateRow,
  useDeleteRow,
} from "@/hooks/useAdmin";
import { ErrorState, LoadingState, PageHeader, Panel } from "@/views/State";
import { cn } from "@/lib/utils";

type RowRecord = Record<string, unknown>;

function getPkColumn(table: IntrospectedTable | undefined): string | null {
  if (!table) return null;
  if (table.primaryKey.length !== 1) return null;
  return table.primaryKey[0];
}

function isEditable(table: IntrospectedTable | undefined): boolean {
  if (!table) return false;
  if (table.system) return false;
  if (table.virtual) return false;
  if (table.primaryKey.length !== 1) return false;
  const pkCol = table.columns.find((c) => c.primaryKey);
  if (!pkCol) return false;
  const type = pkCol.type.toUpperCase();
  if (type !== "INTEGER" && type !== "TEXT") return false;
  return true;
}

function getSearchColumn(table: IntrospectedTable | undefined): string | null {
  if (!table) return null;
  const textCol = table.columns.find(
    (c) =>
      c.type.toUpperCase() === "TEXT" && !c.primaryKey && !c.autoIncrement
  );
  if (textCol) return textCol.name;
  const pk = getPkColumn(table);
  if (pk) return pk;
  return table.columns[0]?.name ?? null;
}

function formatCellValue(value: unknown): string {
  if (value === null) return "NULL";
  if (value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function parseInputValue(
  value: string,
  col: IntrospectedColumn
): string | number | boolean | null {
  if (value === "" && !col.notNull) return null;
  const t = col.type.toUpperCase();
  if (t === "INTEGER" || t === "BIGINT") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : value;
  }
  if (t === "REAL") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

export function TableDetailView() {
  const { table: rawTable } = useParams();
  const tableName = rawTable ? decodeURIComponent(rawTable) : "";
  const { data: schema, isLoading: schemaLoading, error: schemaError } = useSchema();
  const table = schema?.tables.find((t) => t.name === tableName);

  const [activeTab, setActiveTab] = useState<"data" | "schema">("data");

  if (schemaLoading) return <LoadingState />;
  if (schemaError) return <ErrorState error={schemaError} />;

  return (
    <>
      <PageHeader
        title={tableName || "Table"}
        description={
          table
            ? `${table.rowCount} rows${table.system ? " · system" : ""}${
                table.virtual ? " · read-only" : ""
              }${isEditable(table) ? "" : " · not editable"}`
            : undefined
        }
      />
      {!table ? (
        <Panel>Table not found.</Panel>
      ) : (
        <>
          <div className="mb-4 flex gap-2">
            <button
              type="button"
              onClick={() => setActiveTab("data")}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm",
                activeTab === "data"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              )}
            >
              Data
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("schema")}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm",
                activeTab === "schema"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              )}
            >
              Schema
            </button>
          </div>
          {activeTab === "data" ? (
            <DataTab table={table} tableName={tableName} />
          ) : (
            <SchemaTab table={table} />
          )}
        </>
      )}
    </>
  );
}

function DataTab({
  table,
  tableName,
}: {
  table: IntrospectedTable;
  tableName: string;
}) {
  const editable = isEditable(table);
  const pkColumn = getPkColumn(table);
  const searchColumn = getSearchColumn(table);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pageSize, setPageSize] = useState(25);
  const [pageIndex, setPageIndex] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPageIndex(0);
  }, [debouncedSearch]);

  const orderBy = useMemo(() => {
    if (sorting.length === 0) return undefined;
    return sorting
      .map((s) => `${s.id}.${s.desc ? "desc" : "asc"}`)
      .join(",");
  }, [sorting]);

  const params = useMemo(
    () => ({
      limit: pageSize,
      offset: pageIndex * pageSize,
      order: orderBy,
      search: debouncedSearch || undefined,
      searchColumn: debouncedSearch ? (searchColumn ?? undefined) : undefined,
    }),
    [pageSize, pageIndex, orderBy, debouncedSearch, searchColumn]
  );

  const {
    data: rowsData,
    isLoading: rowsLoading,
    error: rowsError,
  } = useRows(tableName, params);

  const createRow = useCreateRow(tableName);
  const updateRow = useUpdateRow(tableName);
  const deleteRow = useDeleteRow(tableName);

  const [editingCell, setEditingCell] = useState<{
    rowId: string | number;
    column: string;
  } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addForm, setAddForm] = useState<Record<string, string>>({});
  const [addError, setAddError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | number | null>(null);

  const columns = useMemo<ColumnDef<RowRecord>[]>(
    () =>
      table.columns.map((col) => ({
        id: col.name,
        accessorFn: (row) => row[col.name],
        header: () => (
          <span className="flex items-center gap-1">
            {col.name}
            {col.primaryKey ? (
              <span className="text-[10px] text-muted-foreground">PK</span>
            ) : null}
          </span>
        ),
        cell: ({ row, column, getValue }) => {
          const value = getValue();
          const isEditing =
            editingCell?.rowId === row.original[pkColumn!] &&
            editingCell?.column === column.id;

          if (isEditing) {
            const colMeta = table.columns.find((c) => c.name === column.id)!;
            return (
              <CellEditor
                value={editValue}
                onChange={setEditValue}
                onSubmit={async () => {
                  try {
                    setEditError(null);
                    const parsed = parseInputValue(editValue, colMeta);
                    await updateRow.mutateAsync({
                      id: row.original[pkColumn!] as string | number,
                      data: { [column.id]: parsed },
                    });
                    setEditingCell(null);
                  } catch (err) {
                    setEditError(
                      err instanceof Error ? err.message : "Update failed"
                    );
                  }
                }}
                onCancel={() => {
                  setEditingCell(null);
                  setEditError(null);
                }}
                error={editError}
                inputType={
                  colMeta.type.toUpperCase() === "INTEGER" ||
                  colMeta.type.toUpperCase() === "BIGINT" ||
                  colMeta.type.toUpperCase() === "REAL"
                    ? "number"
                    : "text"
                }
              />
            );
          }

          const isNull = value === null;
          return (
            <span
              className={cn(
                "block cursor-pointer select-none rounded px-1 py-0.5",
                editable && "hover:bg-accent",
                isNull && "italic text-muted-foreground"
              )}
              onDoubleClick={() => {
                if (!editable) return;
                setEditError(null);
                setEditValue(formatCellValue(value));
                setEditingCell({
                  rowId: row.original[pkColumn!] as string | number,
                  column: column.id,
                });
              }}
              title={editable ? "Double-click to edit" : undefined}
            >
              {formatCellValue(value)}
            </span>
          );
        },
      })),
    [table.columns, pkColumn, editingCell, editValue, editable, updateRow]
  );

  const reactTable = useReactTable({
    data: rowsData?.rows ?? [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    manualSorting: true,
    manualPagination: true,
  });

  const totalRows = rowsData?.total ?? 0;
  const pageCount = Math.ceil(totalRows / pageSize);

  const handleAddSubmit = async () => {
    try {
      setAddError(null);
      const body: Record<string, unknown> = {};
      for (const col of table.columns) {
        if (col.primaryKey && col.autoIncrement) continue;
        const val = addForm[col.name];
        if (val === undefined || val === "") {
          if (col.notNull && col.defaultValue === null) {
            throw new Error(`Column "${col.name}" is required`);
          }
          if (!col.notNull) body[col.name] = null;
          continue;
        }
        body[col.name] = parseInputValue(val, col);
      }
      await createRow.mutateAsync(body);
      setShowAddDialog(false);
      setAddForm({});
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Create failed");
    }
  };

  const handleDelete = async (id: string | number) => {
    try {
      await deleteRow.mutateAsync(id);
      setDeletingId(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed");
    }
  };

  return (
    <>
      <Panel>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            type="text"
            placeholder={searchColumn ? `Search ${searchColumn}…` : "Search…"}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary"
          />
          {editable && (
            <button
              type="button"
              onClick={() => {
                setAddForm({});
                setAddError(null);
                setShowAddDialog(true);
              }}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
            >
              + New row
            </button>
          )}
          <div className="ml-auto text-xs text-muted-foreground">
            {totalRows > 0
              ? `Showing ${pageIndex * pageSize + 1}–${Math.min(
                  (pageIndex + 1) * pageSize,
                  totalRows
                )} of ${totalRows}`
              : "No rows"}
          </div>
        </div>

        {rowsError ? (
          <ErrorState error={rowsError} />
        ) : rowsLoading ? (
          <LoadingState />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-muted-foreground">
                {reactTable.getHeaderGroups().map((hg) => (
                  <tr key={hg.id} className="border-b border-border">
                    {editable && <th className="w-10 py-2 pr-2" />}
                    {hg.headers.map((header) => (
                      <th
                        key={header.id}
                        className="cursor-pointer py-2 pr-4 select-none"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                        {header.column.getIsSorted() === "asc" ? " ↑" : null}
                        {header.column.getIsSorted() === "desc" ? " ↓" : null}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {reactTable.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border hover:bg-accent/30"
                  >
                    {editable && pkColumn && (
                      <td className="py-1 pr-2">
                        <button
                          type="button"
                          onClick={() =>
                            setDeletingId(row.original[pkColumn] as string | number)
                          }
                          className="rounded px-1.5 py-0.5 text-xs text-destructive-foreground hover:bg-destructive/20"
                          title="Delete row"
                        >
                          ×
                        </button>
                      </td>
                    )}
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="py-1 pr-4">
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
                {reactTable.getRowModel().rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={table.columns.length + (editable ? 1 : 0)}
                      className="py-8 text-center text-muted-foreground"
                    >
                      No rows found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {pageCount > 1 && (
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
              className="rounded-md border border-border px-3 py-1 text-sm disabled:opacity-40 hover:bg-accent"
            >
              Previous
            </button>
            <span className="text-xs text-muted-foreground">
              Page {pageIndex + 1} of {pageCount}
            </span>
            <button
              type="button"
              disabled={pageIndex >= pageCount - 1}
              onClick={() =>
                setPageIndex((p) => Math.min(pageCount - 1, p + 1))
              }
              className="rounded-md border border-border px-3 py-1 text-sm disabled:opacity-40 hover:bg-accent"
            >
              Next
            </button>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPageIndex(0);
              }}
              className="ml-auto rounded-md border border-border bg-background px-2 py-1 text-xs"
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </select>
          </div>
        )}
      </Panel>

      {showAddDialog && (
        <AddRowDialog
          table={table}
          form={addForm}
          setForm={setAddForm}
          error={addError}
          onSubmit={handleAddSubmit}
          onClose={() => setShowAddDialog(false)}
          isSubmitting={createRow.isPending}
        />
      )}

      {deletingId !== null && (
        <DeleteConfirmDialog
          id={deletingId}
          onConfirm={() => handleDelete(deletingId)}
          onCancel={() => setDeletingId(null)}
          isDeleting={deleteRow.isPending}
        />
      )}
    </>
  );
}

function CellEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  error,
  inputType,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  error: string | null;
  inputType: string;
}) {
  useEffect(() => {
    const el = document.getElementById("cell-editor-input") as HTMLInputElement | null;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  return (
    <div className="relative">
      <input
        id="cell-editor-input"
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={onSubmit}
        className={cn(
          "w-full rounded border px-1 py-0.5 text-sm outline-none",
          error
            ? "border-destructive bg-destructive/10"
            : "border-primary bg-background"
        )}
      />
      {error ? (
        <span className="absolute left-0 top-full z-10 mt-1 whitespace-nowrap rounded bg-destructive px-2 py-1 text-xs text-destructive-foreground">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function AddRowDialog({
  table,
  form,
  setForm,
  error,
  onSubmit,
  onClose,
  isSubmitting,
}: {
  table: IntrospectedTable;
  form: Record<string, string>;
  setForm: (f: Record<string, string>) => void;
  error: string | null;
  onSubmit: () => void;
  onClose: () => void;
  isSubmitting: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-lg">
        <h3 className="text-lg font-semibold">New row in {table.name}</h3>
        {error ? (
          <p className="mt-2 text-sm text-destructive-foreground">{error}</p>
        ) : null}
        <div className="mt-4 space-y-3">
          {table.columns.map((col) => {
            if (col.primaryKey && col.autoIncrement) return null;
            const val = form[col.name] ?? "";
            return (
              <div key={col.name}>
                <label className="block text-xs font-medium text-muted-foreground">
                  {col.name}
                  {col.notNull && col.defaultValue === null ? (
                    <span className="text-destructive-foreground">*</span>
                  ) : null}
                </label>
                <input
                  type={
                    col.type.toUpperCase() === "INTEGER" ||
                    col.type.toUpperCase() === "BIGINT" ||
                    col.type.toUpperCase() === "REAL"
                      ? "number"
                      : "text"
                  }
                  value={val}
                  placeholder={
                    col.defaultValue !== null
                      ? `default: ${col.defaultValue}`
                      : col.notNull
                      ? "required"
                      : "null allowed"
                  }
                  onChange={(e) =>
                    setForm({ ...form, [col.name]: e.target.value })
                  }
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary"
                />
              </div>
            );
          })}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={onSubmit}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {isSubmitting ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirmDialog({
  id,
  onConfirm,
  onCancel,
  isDeleting,
}: {
  id: string | number;
  onConfirm: () => void;
  onCancel: () => void;
  isDeleting: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-lg">
        <h3 className="text-lg font-semibold">Delete row?</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          This will permanently delete the row with ID <code>{String(id)}</code>.
          This action cannot be undone.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isDeleting}
            onClick={onConfirm}
            className="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:opacity-90 disabled:opacity-50"
          >
            {isDeleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SchemaTab({ table }: { table: IntrospectedTable }) {
  return (
    <Panel>
      <div className="mb-4 flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>{table.rowCount} rows</span>
        {table.system ? <span>system table</span> : null}
        {table.virtual ? <span>virtual/read-only</span> : null}
        {table.primaryKey.length > 1 ? (
          <span>composite PK</span>
        ) : table.primaryKey.length === 0 ? (
          <span>no PK</span>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr>
              <th className="py-2 pr-4">Column</th>
              <th className="py-2 pr-4">Type</th>
              <th className="py-2 pr-4">Flags</th>
              <th className="py-2 pr-4">Default</th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map((column) => (
              <tr key={column.name} className="border-t border-border">
                <td className="py-2 pr-4 font-mono">{column.name}</td>
                <td className="py-2 pr-4">{column.type}</td>
                <td className="py-2 pr-4 text-muted-foreground">
                  {[
                    column.primaryKey ? "pk" : null,
                    column.autoIncrement ? "auto" : null,
                    column.notNull ? "not null" : "nullable",
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </td>
                <td className="py-2 pr-4 text-muted-foreground">
                  {column.defaultValue ?? "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {table.foreignKeys.length > 0 && (
        <div className="mt-6">
          <h4 className="text-sm font-semibold">Foreign Keys</h4>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4">Column</th>
                  <th className="py-2 pr-4">References</th>
                </tr>
              </thead>
              <tbody>
                {table.foreignKeys.map((fk, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="py-2 pr-4 font-mono">{fk.fromColumn}</td>
                    <td className="py-2 pr-4">
                      {fk.toTable}.{fk.toColumn}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {table.indexes.length > 0 && (
        <div className="mt-6">
          <h4 className="text-sm font-semibold">Indexes</h4>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Unique</th>
                  <th className="py-2 pr-4">Columns</th>
                </tr>
              </thead>
              <tbody>
                {table.indexes.map((idx) => (
                  <tr key={idx.name} className="border-t border-border">
                    <td className="py-2 pr-4 font-mono">{idx.name}</td>
                    <td className="py-2 pr-4">{idx.unique ? "Yes" : "No"}</td>
                    <td className="py-2 pr-4">
                      {idx.columns.join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}
