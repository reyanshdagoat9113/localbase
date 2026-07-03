import { Link } from "react-router-dom";
import { useSchema } from "@/hooks/useAdmin";
import { ErrorState, LoadingState, PageHeader, Panel } from "@/views/State";

export function SchemaView() {
  const { data: schema, isLoading, error } = useSchema();

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

  return (
    <>
      <PageHeader
        title="Schema"
        description="The actual SQLite schema as reported by Database.introspect()."
      />
      <div className="space-y-3">
        {schema?.tables.map((table) => (
          <Panel key={table.name}>
            <div className="flex items-center justify-between gap-4">
              <Link
                to={`/tables/${encodeURIComponent(table.name)}`}
                className="font-mono text-sm font-semibold hover:underline"
              >
                {table.name}
              </Link>
              <span className="text-xs text-muted-foreground">
                {table.columns.length} columns
              </span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {table.columns.map((column) => column.name).join(", ")}
            </p>
          </Panel>
        ))}
      </div>
    </>
  );
}
