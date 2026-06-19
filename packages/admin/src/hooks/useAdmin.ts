import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getSchema,
  getTables,
  getRows,
  createRow,
  updateRow,
  deleteRow,
  type GetRowsParams,
} from "@/lib/api";

export function useSchema() {
  return useQuery({ queryKey: ["admin", "schema"], queryFn: getSchema });
}

export function useTables() {
  return useQuery({ queryKey: ["admin", "tables"], queryFn: getTables });
}

export function useRows(table: string, params: GetRowsParams = {}) {
  return useQuery({
    queryKey: ["admin", "rows", table, params],
    queryFn: () => getRows(table, params),
    enabled: !!table,
  });
}

export function useCreateRow(table: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => createRow(table, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "rows", table] });
      qc.invalidateQueries({ queryKey: ["admin", "tables"] });
    },
  });
}

export function useUpdateRow(table: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string | number;
      data: Record<string, unknown>;
    }) => updateRow(table, id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "rows", table] });
      qc.invalidateQueries({ queryKey: ["admin", "tables"] });
    },
  });
}

export function useDeleteRow(table: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string | number) => deleteRow(table, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "rows", table] });
      qc.invalidateQueries({ queryKey: ["admin", "tables"] });
    },
  });
}
