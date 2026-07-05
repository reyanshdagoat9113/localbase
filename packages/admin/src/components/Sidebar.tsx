import { NavLink } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useAdminRequests, useTables } from "@/hooks/useAdmin";
import { cn } from "@/lib/utils";

const nav = [
  { label: "Tables", href: "/tables", ownerOnly: false },
  { label: "Schema", href: "/schema", ownerOnly: false },
  { label: "Users", href: "/users", ownerOnly: false },
  { label: "Admin Requests", href: "/admin-requests", ownerOnly: true },
  { label: "Realtime", href: "/realtime", ownerOnly: false },
  { label: "Storage", href: "/storage", ownerOnly: false },
  { label: "Jobs", href: "/jobs", ownerOnly: false },
] as const;

export function Sidebar() {
  const { user, signOut } = useAuth();
  const { data: tables } = useTables();
  const isOwner = user?.role === "owner";
  const { data: requests } = useAdminRequests(isOwner);

  return (
    <aside className="hidden w-72 shrink-0 border-r border-border bg-card/70 p-4 md:flex md:flex-col">
      <div>
        <p className="text-sm font-medium text-muted-foreground">LocalBase</p>
        <h1 className="text-xl font-semibold">Admin Studio</h1>
      </div>

      <nav className="mt-8 space-y-1">
        {nav.filter((item) => !item.ownerOnly || isOwner).map(({ label, href }) => (
          <NavLink
            key={href}
            to={href}
            className={({ isActive }) =>
              cn(
                "block rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                isActive && "bg-accent text-foreground"
              )
            }
          >
            <span className="flex items-center justify-between gap-2">
              {label}
              {href === "/admin-requests" && requests?.total ? (
                <span className="min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] font-semibold text-primary-foreground">
                  {requests.total}
                </span>
              ) : null}
            </span>
          </NavLink>
        ))}
      </nav>

      <div className="mt-8 min-h-0 flex-1 overflow-y-auto">
        <p className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Tables
        </p>
        <div className="mt-2 space-y-1">
          {tables?.slice(0, 20).map((table) => (
            <NavLink
              key={table.name}
              to={`/tables/${encodeURIComponent(table.name)}`}
              className={({ isActive }) =>
                cn(
                  "block truncate rounded-md px-3 py-1.5 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
                  isActive && "bg-accent text-foreground"
                )
              }
            >
              {table.name}
            </NavLink>
          ))}
        </div>
      </div>

      <div className="mt-6 border-t border-border pt-4 text-sm">
        <p className="truncate text-muted-foreground">{user?.email}</p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
