import { Link } from "react-router-dom";
import { useTables } from "@/hooks/useAdmin";
import { ErrorState, LoadingState, PageHeader, Panel } from "@/views/State";

export function TablesView() {
  const { data: tables, isLoading, error } = useTables();

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

  return (
    <>
      <PageHeader
        title="Tables"
        description="Browse tables, open a grid to edit rows, and inspect schema — all without leaving Admin Studio."
      />
      {!tables?.length ? (
        <Panel>No tables found.</Panel>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tables.map((table) => (
            <Link
              key={table.name}
              to={`/tables/${encodeURIComponent(table.name)}`}
              className="rounded-xl border border-border bg-card p-4 transition hover:border-primary/50"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-mono text-sm font-medium">
                  {table.name}
                </span>
                {table.system ? (
                  <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] uppercase text-muted-foreground">
                    system
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {table.rowCount} {table.rowCount === 1 ? "row" : "rows"}
              </p>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
