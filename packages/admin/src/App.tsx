import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { LoginView } from "@/components/LoginView";
import { Sidebar } from "@/components/Sidebar";
import { TablesView } from "@/views/TablesView";
import { SchemaView } from "@/views/SchemaView";
import { TableDetailView } from "@/views/TableDetailView";
import { UsersView } from "@/views/UsersView";
import { AdminRequestsView } from "@/views/AdminRequestsView";
import { StorageView } from "@/views/StorageView";
import { StubView } from "@/views/StubView";
import { JobsView } from "@/views/Jobs";

export default function App() {
  return (
    <Routes>
      <Route path="login" element={<LoginView />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="tables" replace />} />
          <Route path="tables" element={<TablesView />} />
          <Route path="tables/:table" element={<TableDetailView />} />
          <Route path="schema" element={<SchemaView />} />
          <Route path="users" element={<UsersView />} />
          <Route path="admin-requests" element={<AdminRequestsView />} />
          <Route
            path="realtime"
            element={
              <StubView
                title="Realtime inspector"
                badge="P2"
                description="Phase 8 realtime is available; the inspector is a later admin UI view."
              />
            }
          />
          <Route path="storage" element={<StorageView />} />
          <Route path="jobs" element={<JobsView />} />
          <Route path="*" element={<StubView title="Not found" />} />
        </Route>
      </Route>
    </Routes>
  );
}

function ProtectedRoute() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <Outlet /> : <Navigate to="/login" replace />;
}

function Shell() {
  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <Sidebar />
      <main className="min-w-0 flex-1 px-5 py-6 md:px-8">
        <div className="mx-auto w-full max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
