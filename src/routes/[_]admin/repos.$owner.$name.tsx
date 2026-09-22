import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import type { Activity } from "../../app/admin-activity.ts";
import { MAX_STORAGE_CHANGES, type StorageAction, type StorageChanges, type StorageListing } from "../../shared/contract.ts";
import { chunks, countOutcomes, errorRate } from "./-format.ts";
import { changeObjects, getActivity, getLocks, getObjects } from "./-functions.ts";
import {
  ActionStatus,
  ActivityChart,
  Caption,
  Failure,
  formatBytes,
  formatCount,
  type Outcome,
  PageHeader,
  RouteError,
  RoutePending,
  Time,
  useAction,
  useConfirm,
  useReadOnly,
} from "./-ui.tsx";

interface Search {
  /** Absent means the live objects. */
  in?: "trash";
  cursor?: string;
  /** The cursors of the pages before this one, `""` for the first, so Previous can go back. */
  prev?: string[];
}

const ACTIVITY_HOURS = 24 * 7;

export const Route = createFileRoute("/_admin/repos/$owner/$name")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ...(search.in === "trash" ? { in: "trash" as const } : {}),
    ...(typeof search.cursor === "string" && search.cursor ? { cursor: search.cursor } : {}),
    ...(Array.isArray(search.prev) && search.prev.every((c) => typeof c === "string") && search.prev.length > 0
      ? { prev: search.prev as string[] }
      : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) => {
    const repository = `${params.owner}/${params.name}`;
    const [objects, locks, activity] = await Promise.all([
      getObjects({ data: { repository, in: deps.in ?? "live", ...(deps.cursor ? { cursor: deps.cursor } : {}) } }),
      getLocks({ data: { repository } }),
      getActivity({ data: { hours: ACTIVITY_HOURS, repository } }),
    ]);
    return { repository: repository.toLowerCase(), objects, locks, activity };
  },
  component: RepositoryPage,
  errorComponent: RouteError,
  pendingComponent: RoutePending,
});

function RepositoryPage(): ReactNode {
  const { repository, objects, locks, activity } = Route.useLoaderData();
  const search = Route.useSearch();

  return (
    <>
      <PageHeader title={repository}>Objects, file locks and requests of this repository.</PageHeader>

      <section aria-labelledby="objects-heading">
        <h2 id="objects-heading">Objects</h2>
        <nav className="tabs" aria-label="Objects">
          <Link to="." search={{}} className="tab" aria-current={search.in === undefined ? "page" : undefined}>
            Live
          </Link>
          <Link to="." search={{ in: "trash" }} className="tab" aria-current={search.in === "trash" ? "page" : undefined}>
            Trash
          </Link>
        </nav>
        {objects.ok ? (
          // A new page or tab starts with nothing selected.
          <ObjectsTable key={JSON.stringify(search)} repository={repository} listing={objects.value} where={search.in ?? "live"} />
        ) : objects.status === 409 ? (
          <p className="notice warn">{objects.message}. The admin UI can list and change objects in the per-repo layout only.</p>
        ) : (
          <Failure message={objects.message} />
        )}
      </section>

      <section aria-labelledby="locks-heading">
        <h2 id="locks-heading">File locks</h2>
        {locks.ok ? (
          <div className="table-wrap">
            {locks.value.locks.length === 0 ? (
              <p className="empty">Nothing is locked.</p>
            ) : (
              <table>
                <Caption>File locks in {repository}</Caption>
                <thead>
                  <tr>
                    <th>Path</th>
                    <th>Held by</th>
                    <th>Since</th>
                  </tr>
                </thead>
                <tbody>
                  {locks.value.locks.map((lock) => (
                    <tr key={lock.id}>
                      <td className="mono">{lock.path}</td>
                      <td>{lock.owner.name}</td>
                      <td>
                        <Time iso={lock.locked_at} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <Failure message={locks.message} />
        )}
        <p className="hint">
          <Link to="/_admin/locks" search={{ repo: repository }}>
            Manage the locks of {repository}
          </Link>
          {locks.ok && locks.value.nextCursor ? " (more than shown here)" : ""}
        </p>
      </section>

      <section aria-labelledby="activity-heading">
        <h2 id="activity-heading">Requests in the last 7 days</h2>
        {!activity.ok ? (
          <Failure message={activity.message} />
        ) : !activity.value.enabled ? (
          <p className="notice">
            Set <code>ANALYTICS_API_TOKEN</code> and <code>R2_ACCOUNT_ID</code> to see requests here.
          </p>
        ) : (
          <ActivitySummary activity={activity.value} />
        )}
      </section>
    </>
  );
}

function ActivitySummary({ activity }: { activity: Extract<Activity, { enabled: true }> }): ReactNode {
  const { total } = activity;
  return (
    <>
      <div className="stats">
        <Stat label="Requests" value={formatCount(total.requests)} />
        <Stat label="Through the Worker" value={formatBytes(total.bytes)} />
        <Stat label="Server errors" value={formatCount(total.errors)} sub={`${errorRate(total.errors, total.requests)} of requests`} />
      </div>
      <div style={{ marginTop: 12 }}>
        <ActivityChart timeline={activity.timeline} bucketHours={activity.bucketHours} />
      </div>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): ReactNode {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

const VERB: Record<StorageAction, { label: string; running: string; done: string }> = {
  trash: { label: "Move to trash", running: "Moving to the trash", done: "trashed" },
  restore: { label: "Restore", running: "Restoring", done: "restored" },
  tier: { label: "Move to Infrequent Access", running: "Moving to Infrequent Access", done: "tiered" },
};

interface Run {
  action: StorageAction;
  results: StorageChanges["results"];
  /** Set when a request failed part way, so the results cover only the objects before it. */
  stopped?: string;
}

function ObjectsTable({ repository, listing, where }: { repository: string; listing: StorageListing; where: "live" | "trash" }): ReactNode {
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  const action = useAction();
  const readOnly = useReadOnly();
  const { confirm, dialog } = useConfirm();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<{ action: StorageAction; done: number; total: number }>();
  const [run, setRun] = useState<Run>();

  const all = listing.objects.map((o) => o.oid);
  const allSelected = all.length > 0 && all.every((oid) => selected.has(oid));
  const toggle = (oid: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(oid)) next.add(oid);
      return next;
    });

  /** Sends the objects in requests of MAX_STORAGE_CHANGES, the most one request may change, and reports as it goes. */
  async function apply(kind: StorageAction, oids: string[]) {
    const results: StorageChanges["results"] = [];
    await action.run(
      kind,
      async (): Promise<Outcome<Run>> => {
        setRun(undefined);
        setProgress({ action: kind, done: 0, total: oids.length });
        try {
          for (const batch of chunks(oids, MAX_STORAGE_CHANGES)) {
            const outcome = await changeObjects({ data: { repository, action: kind, oids: batch } });
            if (!outcome.ok) {
              setRun({ action: kind, results, stopped: outcome.message });
              return outcome;
            }
            results.push(...outcome.value.results);
            setProgress({ action: kind, done: results.length, total: oids.length });
          }
        } catch (err) {
          setRun({ action: kind, results, stopped: err instanceof Error ? err.message : String(err) });
          throw err;
        } finally {
          setProgress(undefined);
        }
        return { ok: true, value: { action: kind, results } };
      },
      {
        success: (value) => {
          const done = value.results.filter((r) => r.outcome === VERB[kind].done).length;
          return `${formatCount(done)} of ${formatCount(value.results.length)} objects ${VERB[kind].done}`;
        },
        after: async (value) => {
          setRun(value);
          setSelected(new Set());
          await router.invalidate();
        },
      },
    );
  }

  async function start(kind: StorageAction) {
    const oids = all.filter((oid) => selected.has(oid));
    const count = `${formatCount(oids.length)} ${oids.length === 1 ? "object" : "objects"}`;
    const confirmed = await confirm(
      kind === "trash"
        ? {
            title: "Move to trash",
            body: (
              <p>
                <strong>{count}</strong> of <strong className="mono">{repository}</strong> leave the repository: git-lfs can no longer
                download them. They stay in the trash until its lifecycle rule expires them, and can be restored until then.
              </p>
            ),
            action: `Trash ${count}`,
            danger: true,
            typeToConfirm: repository,
          }
        : kind === "tier"
          ? {
              title: "Move to Infrequent Access",
              body: (
                <p>
                  <strong>{count}</strong> of <strong className="mono">{repository}</strong> move to R2 Infrequent Access: cheaper to store,
                  billed per download, and kept for at least 30 days.
                </p>
              ),
              action: `Tier ${count}`,
            }
          : {
              title: "Restore",
              body: (
                <p>
                  <strong>{count}</strong> go back to <strong className="mono">{repository}</strong>.
                </p>
              ),
              action: `Restore ${count}`,
            },
    );
    if (confirmed) await apply(kind, oids);
  }

  const trashed = run?.action === "trash" ? run.results.filter((r) => r.outcome === "trashed").map((r) => r.oid) : [];
  const page = (search.prev?.length ?? 0) + 1;

  return (
    <>
      <div className="toolbar">
        <span className="hint" aria-live="polite">
          {selected.size ? `${formatCount(selected.size)} selected` : "Select objects to change them"}
        </span>
        {where === "live" ? (
          <>
            <button
              type="button"
              className="danger"
              disabled={!selected.size || action.busy !== undefined || readOnly !== undefined}
              title={readOnly}
              onClick={() => start("trash")}
            >
              {VERB.trash.label}
            </button>
            <button
              type="button"
              disabled={!selected.size || action.busy !== undefined || readOnly !== undefined}
              title={readOnly}
              onClick={() => start("tier")}
            >
              {VERB.tier.label}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={!selected.size || action.busy !== undefined || readOnly !== undefined}
            title={readOnly}
            onClick={() => start("restore")}
          >
            {VERB.restore.label}
          </button>
        )}
      </div>

      {progress ? (
        <div className="progress" role="status">
          <label>
            {VERB[progress.action].running}: {formatCount(progress.done)} of {formatCount(progress.total)}
            <progress value={progress.done} max={progress.total} />
          </label>
        </div>
      ) : null}

      <ActionStatus action={action} />
      {dialog}

      {run ? (
        <RunReport
          run={run}
          undo={
            trashed.length && action.busy === undefined
              ? {
                  count: trashed.length,
                  onClick: () => apply("restore", trashed),
                }
              : undefined
          }
        />
      ) : null}

      <div className="table-wrap">
        {listing.objects.length === 0 ? (
          <p className="empty">{where === "live" ? "No objects." : "The trash is empty."}</p>
        ) : (
          <table>
            <Caption>
              {where === "live" ? "Objects" : "Trashed objects"} of {repository}, page {page}
            </Caption>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select every object on this page"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(all))}
                  />
                </th>
                <th>OID</th>
                <th className="num">Size</th>
                <th>{where === "live" ? "Uploaded" : "Trashed"}</th>
                <th>Storage class</th>
              </tr>
            </thead>
            <tbody>
              {listing.objects.map((object) => (
                <tr key={object.oid} className={selected.has(object.oid) ? "selected" : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${object.oid}`}
                      checked={selected.has(object.oid)}
                      onChange={() => toggle(object.oid)}
                    />
                  </td>
                  <td className="mono">{object.oid}</td>
                  <td className="num">{formatBytes(object.size)}</td>
                  <td>
                    <Time iso={object.uploaded} />
                  </td>
                  <td>
                    <span className="badge">{object.storage_class === "STANDARD_IA" ? "Infrequent Access" : "Standard"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="pager">
        <button
          type="button"
          disabled={!search.prev?.length}
          onClick={() => {
            const prev = search.prev ?? [];
            const cursor = prev.at(-1);
            void navigate({
              search: {
                ...(search.in ? { in: search.in } : {}),
                ...(cursor ? { cursor } : {}),
                ...(prev.length > 1 ? { prev: prev.slice(0, -1) } : {}),
              },
            });
          }}
        >
          Previous
        </button>
        <span className="hint">Page {page}</span>
        <button
          type="button"
          disabled={!listing.cursor}
          onClick={() =>
            navigate({
              search: {
                ...(search.in ? { in: search.in } : {}),
                ...(listing.cursor ? { cursor: listing.cursor } : {}),
                prev: [...(search.prev ?? []), search.cursor ?? ""],
              },
            })
          }
        >
          Next
        </button>
      </div>
    </>
  );
}

function RunReport({ run, undo }: { run: Run; undo: { count: number; onClick: () => void } | undefined }): ReactNode {
  const problems = run.results.filter((r) => r.outcome === "locked" || r.outcome === "missing" || r.outcome === "failed");
  return (
    <div className="panel report">
      <p>
        {countOutcomes(run.results)
          .map(({ outcome, count }) => `${formatCount(count)} ${outcome}`)
          .join(" · ") || "Nothing changed"}
        {undo ? (
          <>
            {" "}
            <button type="button" onClick={undo.onClick}>
              Undo: restore {formatCount(undo.count)}
            </button>
          </>
        ) : null}
      </p>
      {run.stopped ? <Failure message={`Stopped after ${formatCount(run.results.length)} objects: ${run.stopped}`} /> : null}
      {problems.length ? (
        <table>
          <Caption>Objects that did not change</Caption>
          <thead>
            <tr>
              <th>OID</th>
              <th>Outcome</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {problems.map((r) => (
              <tr key={r.oid}>
                <td className="mono">{r.oid}</td>
                <td>
                  <span className="badge">{r.outcome}</span>
                </td>
                <td>{r.message ?? OUTCOME_REASON[r.outcome]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

const OUTCOME_REASON: Record<string, string> = {
  locked: "A bucket lock rule still protects it",
  missing: "It was not there any more",
  failed: "R2 refused the change",
};
