import { useParams } from "react-router-dom";
import { useSchema } from "@/hooks/useAdmin";
import { ErrorState, LoadingState, PageHeader, Panel } from "@/views/State";

export function TableDetailView() {
  const { table: rawTable } = useParams();
  const tableName = rawTable ? decodeURIComponent(rawTable) : "";
  const { data: schema, isLoading, error } = useSchema();

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

  const table = schema?.tables.find((item) => item.name === tableName);

  return (
    <>
      <PageHeader
        title={tableName || "Table"}
        description="Schema detail from /_api/admin/schema. The data grid is the next milestone."
      />
      {!table ? (
        <Panel>Table not found.</Panel>
      ) : (
        <Panel>
          <div className="mb-4 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{table.rowCount} rows</span>
            {table.system ? <span>system table</span> : null}
            {table.virtual ? <span>virtual/read-only</span> : null}
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
        </Panel>
      )}
    </>
  );
}
