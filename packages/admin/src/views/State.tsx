import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <header className="mb-6">
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      {description ? (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      ) : null}
    </header>
  );
}

export function Panel({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-border bg-card p-5">{children}</div>;
}

export function LoadingState() {
  return <Panel>Loading...</Panel>;
}

export function ErrorState({ error }: { error: unknown }) {
  return (
    <Panel>
      <p className="font-medium text-destructive-foreground">Request failed</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {error instanceof Error ? error.message : "Unknown error"}
      </p>
    </Panel>
  );
}
