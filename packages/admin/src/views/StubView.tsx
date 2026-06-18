import { PageHeader, Panel } from "@/views/State";

export function StubView({
  title,
  badge,
  description,
}: {
  title: string;
  badge?: string;
  description?: string;
}) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <Panel>
        {badge ? (
          <span className="rounded-full bg-accent px-2 py-1 text-xs text-muted-foreground">
            {badge}
          </span>
        ) : null}
        <p className="mt-3 text-sm text-muted-foreground">
          This route is intentionally present in the shell but not implemented yet.
        </p>
      </Panel>
    </>
  );
}
