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
  getUsers,
  createUser,
  resetUserPassword,
  setUserRole,
  getAdminRequests,
  approveAdminRequest,
  rejectAdminRequest,
  listStorageFiles,
  deleteStorageFile,
  getJobs,
  getJobRuns,
  runJob,
  type AuthUser,
  type UserRole,
  type GetRowsParams,
  type StorageFile,
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

// ─── Auth Manager ──────────────────────────────────────────────
//
// Mutations also invalidate the tables/schema queries because `_users` shows
// up there (row count, system flag) — promoting or creating users changes it.

export function useUsers() {
  return useQuery({ queryKey: ["admin", "users"], queryFn: getUsers });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      createUser(email, password),
    onSuccess: () => invalidateUserData(qc),
  });
}

export function useResetUserPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      resetUserPassword(id, password),
    onSuccess: () => invalidateUserData(qc),
  });
}

export function useSetUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }: { id: number; role: UserRole }) =>
      setUserRole(id, role),
    onSuccess: () => invalidateUserData(qc),
  });
}

export function useAdminRequests(enabled: boolean) {
  return useQuery({
    queryKey: ["admin", "admin-requests"],
    queryFn: getAdminRequests,
    enabled,
  });
}

export function useApproveAdminRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => approveAdminRequest(id),
    onSuccess: () => {
      invalidateUserData(qc);
      qc.invalidateQueries({ queryKey: ["admin", "admin-requests"] });
    },
  });
}

export function useRejectAdminRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => rejectAdminRequest(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "admin-requests"] });
      qc.invalidateQueries({ queryKey: ["admin", "tables"] });
    },
  });
}

function invalidateUserData(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["admin", "users"] });
  qc.invalidateQueries({ queryKey: ["admin", "tables"] });
  qc.invalidateQueries({ queryKey: ["admin", "schema"] });
}

// ─── Storage browser ───────────────────────────────────────────

export function useStorageFiles(bucket: string) {
  return useQuery({
    queryKey: ["admin", "storage", bucket],
    queryFn: () => listStorageFiles(bucket),
    enabled: bucket.length > 0,
  });
}

export function useDeleteStorageFile(bucket: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (storedName: string) => deleteStorageFile(bucket, storedName),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "storage", bucket] });
    },
  });
}

// ─── Scheduled jobs ───────────────────────────────────────────

export function useJobs() {
  return useQuery({ queryKey: ["admin", "jobs"], queryFn: getJobs });
}

export function useJobRuns(name: string, limit: number, offset: number) {
  return useQuery({
    queryKey: ["admin", "jobs", name, "runs", { limit, offset }],
    queryFn: () => getJobRuns(name, limit, offset),
    enabled: name.length > 0,
  });
}

export function useRunJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: runJob,
    onSuccess: (_result, name) => {
      qc.invalidateQueries({ queryKey: ["admin", "jobs"] });
      qc.invalidateQueries({ queryKey: ["admin", "jobs", name, "runs"] });
    },
  });
}

export type { AuthUser, UserRole, StorageFile };
