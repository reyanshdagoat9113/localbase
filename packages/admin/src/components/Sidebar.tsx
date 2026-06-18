import { NavLink } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useTables } from "@/hooks/useAdmin";
import { cn } from "@/lib/utils";

const nav = [
  ["Tables", "/tables"],
  ["Schema", "/schema"],
  ["Users", "/users"],
  ["Realtime", "/realtime"],
  ["Storage", "/storage"],
  ["Jobs", "/jobs"],
] as const;

export function Sidebar() {
  const { user, signOut } = useAuth();
  const { data: tables } = useTables();

  return (
    <aside className="hidden w-72 shrink-0 border-r border-border bg-card/70 p-4 md:flex md:flex-col">
      <div>
        <p className="text-sm font-medium text-muted-foreground">LocalBase</p>
        <h1 className="text-xl font-semibold">Admin Studio</h1>
      </div>

      <nav className="mt-8 space-y-1">
        {nav.map(([label, href]) => (
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
            {label}
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
