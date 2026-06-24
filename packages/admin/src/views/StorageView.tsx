import { useState } from "react";
import { useStorageFiles, useDeleteStorageFile } from "@/hooks/useAdmin";
import { ApiError } from "@/lib/api";
import { ErrorState, LoadingState, PageHeader, Panel } from "@/views/State";

/**
 * Storage browser.
 *
 * Lists files in a bucket via the public `GET /api/storage/:bucket` endpoint
 * (auth attached automatically) and lets an admin delete a file. Bucket names
 * are typed in by the operator — bucket management (create/rename/delete) is
 * out of scope for the first cut; buckets are created on first upload or
 * pre-declared in config.
 */
export function StorageView() {
  const [bucketInput, setBucketInput] = useState("");
  const [bucket, setBucket] = useState("");
  const { data, isLoading, error, refetch } = useStorageFiles(bucket);
  const remove = useDeleteStorageFile(bucket);
  const [confirmDelete, setConfirmDelete] = useState<{
    storedName: string;
    originalName: string;
  } | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const files = data?.files ?? [];

  function openBucket(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBucket(trimmed);
    setBannerError(null);
  }

  async function confirmRemove() {
    if (!confirmDelete) return;
    setBannerError(null);
    try {
      await remove.mutateAsync(confirmDelete.storedName);
      setConfirmDelete(null);
    } catch (err) {
      setBannerError(toMessage(err));
      setConfirmDelete(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Storage"
        description="Browse and delete files in a bucket. Buckets are created on first upload or declared in config."
      />
      <Panel>
        <form
          className="mb-4 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            openBucket(bucketInput);
          }}
        >
          <input
            type="text"
            value={bucketInput}
            onChange={(e) => setBucketInput(e.target.value)}
            placeholder="bucket-name"
            className="min-w-[14rem] flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary"
            // Bucket names: lowercase letters, numbers, hyphens.
            pattern="[a-z0-9-]{1,63}"
            title="Bucket names are 1-63 lowercase letters, numbers, or hyphens."
          />
          <button
            type="submit"
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
          >
            Browse
          </button>
          {bucket ? (
            <span className="text-xs text-muted-foreground">
              viewing <code className="font-mono">{bucket}</code> ·{" "}
              {data?.total ?? files.length}{" "}
              {files.length === 1 ? "file" : "files"}
            </span>
          ) : null}
        </form>

        {bannerError ? (
          <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
            {bannerError}
          </p>
        ) : null}

        {!bucket ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Enter a bucket name to browse its files.
          </p>
        ) : isLoading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Size</th>
                  <th className="py-2 pr-4">Type</th>
                  <th className="py-2 pr-4">Uploaded</th>
                  <th className="py-2 pr-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr
                    key={file.storedName}
                    className="border-b border-border hover:bg-accent/30"
                  >
                    <td className="py-2 pr-4">
                      <span className="font-medium">{file.originalName}</span>
                      <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                        {file.storedName.slice(0, 8)}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {formatSize(file.size)}
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {file.mime ?? "—"}
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {formatDate(file.uploadedAt)}
                    </td>
                    <td className="py-2 pr-4">
                      <div className="flex justify-end gap-2">
                        <a
                          href={`/api/storage/${encodeURIComponent(bucket)}/${encodeURIComponent(file.storedName)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                        >
                          Open
                        </a>
                        <button
                          type="button"
                          onClick={() =>
                            setConfirmDelete({
                              storedName: file.storedName,
                              originalName: file.originalName,
                            })
                          }
                          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {files.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="py-8 text-center text-muted-foreground"
                    >
                      No files in this bucket yet.
                      <button
                        type="button"
                        onClick={() => refetch()}
                        className="ml-2 underline"
                      >
                        Refresh
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {confirmDelete && (
        <ConfirmDeleteDialog
          originalName={confirmDelete.originalName}
          isSubmitting={remove.isPending}
          onConfirm={confirmRemove}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}

function ConfirmDeleteDialog({
  originalName,
  isSubmitting,
  onConfirm,
  onClose,
}: {
  originalName: string;
  isSubmitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-lg font-semibold">Delete file?</h3>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Permanently delete <code>{originalName}</code> from this bucket. This
          cannot be undone.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={onConfirm}
            className="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:opacity-90 disabled:opacity-50"
          >
            {isSubmitting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value?: string): string {
  if (!value) return "—";
  const d = new Date(value.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function toMessage(err: unknown): string {
  return err instanceof ApiError || err instanceof Error
    ? err.message
    : "Request failed";
}
