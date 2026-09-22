import { createFileRoute, getRouteApi, useNavigate, useRouter } from "@tanstack/react-router";
import type { FormEvent, ReactNode } from "react";

import { olderThan, repositoryChoices } from "./-format.ts";
import { getLastStorage, getLocks, unlock } from "./-functions.ts";
import {
  ActionStatus,
  Caption,
  Failure,
  formatCount,
  PageHeader,
  RepoLink,
  RouteError,
  RoutePending,
  Time,
  useAction,
  useConfirm,
  useReadOnly,
} from "./-ui.tsx";

interface Search {
  repo?: string;
  /** Only the lock of this exact path. */
  path?: string;
  cursor?: string;
  /** The cursors of the pages before this one, `""` for the first, so Previous can go back. */
  prev?: string[];
}

/** Locks held longer than this are marked, since they are the ones most likely forgotten. */
const STALE_DAYS = 7;

export const Route = createFileRoute("/_admin/locks")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ...(typeof search.repo === "string" && search.repo ? { repo: search.repo } : {}),
    ...(typeof search.path === "string" && search.path ? { path: search.path } : {}),
    ...(typeof search.cursor === "string" && search.cursor ? { cursor: search.cursor } : {}),
    ...(Array.isArray(search.prev) && search.prev.length > 0 && search.prev.every((c) => typeof c === "string")
      ? { prev: search.prev as string[] }
      : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const [locks, storage] = await Promise.all([
      deps.repo
        ? getLocks({
            data: {
              repository: deps.repo,
              ...(deps.cursor ? { cursor: deps.cursor } : {}),
              ...(deps.path ? { path: deps.path } : {}),
            },
          })
        : undefined,
      // Only for suggestions: a page that cannot read the last count still works.
      getLastStorage().catch(() => undefined),
    ]);
    return { locks, counted: storage?.report.repositories.map((r) => r.repo) ?? [] };
  },
  component: LocksPage,
  errorComponent: RouteError,
  pendingComponent: RoutePending,
});

const layout = getRouteApi("/_admin");

function LocksPage(): ReactNode {
  const search = Route.useSearch();
  const { locks: result, counted } = Route.useLoaderData();
  const { allowedRepos } = layout.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const action = useAction();
  const readOnly = useReadOnly();
  const { confirm, dialog } = useConfirm();
  const choices = repositoryChoices(allowedRepos, counted);
  const page = (search.prev?.length ?? 0) + 1;

  function lookUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const repo = String(fields.get("repo")).trim();
    const path = String(fields.get("path")).trim();
    void navigate({ search: repo ? { repo, ...(path ? { path } : {}) } : {} });
  }

  async function release(repository: string, id: string, path: string, owner: string) {
    const confirmed = await confirm({
      title: "Unlock file",
      body: (
        <p>
          <strong className="mono">{path}</strong> is locked by <strong>{owner}</strong>. Their next push of it may conflict with someone
          else's work.
        </p>
      ),
      action: `Unlock ${path}`,
      danger: true,
    });
    if (!confirmed) return;
    await action.run(id, () => unlock({ data: { repository, id } }), {
      success: (lock) => `Unlocked ${lock.path}`,
      after: () => router.invalidate(),
    });
  }

  const base = { ...(search.repo ? { repo: search.repo } : {}), ...(search.path ? { path: search.path } : {}) };

  return (
    <>
      <PageHeader title="Locks">
        File locks of a repository, taken with git lfs lock. Unlocking here works like git lfs unlock --force.
      </PageHeader>

      <section>
        {/* Keyed by the search so the fields follow Back and Forward. */}
        <form className="inline" onSubmit={lookUp} key={`${search.repo ?? ""}\n${search.path ?? ""}`}>
          <label className="field">
            Repository
            <input
              name="repo"
              defaultValue={search.repo ?? ""}
              placeholder="owner/name"
              className="mono"
              required
              autoComplete="off"
              list="repositories"
            />
          </label>
          <datalist id="repositories">
            {choices.map((repo) => (
              <option key={repo} value={repo} />
            ))}
          </datalist>
          <label className="field">
            Path (optional)
            <input name="path" defaultValue={search.path ?? ""} placeholder="assets/scene.blend" className="mono" autoComplete="off" />
          </label>
          <button type="submit" className="primary">
            Show locks
          </button>
        </form>
      </section>

      <ActionStatus action={action} />
      {dialog}

      {result === undefined ? null : result.ok ? (
        <section>
          <h2>
            <RepoLink repo={result.value.repository} />
            {search.path ? (
              <>
                {" "}
                · <span className="mono">{search.path}</span>
              </>
            ) : null}
          </h2>
          <div className="table-wrap">
            {result.value.locks.length === 0 ? (
              <p className="empty">{search.path ? "That path is not locked." : "Nothing is locked."}</p>
            ) : (
              <table>
                <Caption>
                  Locks in {result.value.repository}, page {page}
                </Caption>
                <thead>
                  <tr>
                    <th>Path</th>
                    <th>Held by</th>
                    <th>Since</th>
                    <th>
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.value.locks.map((lock) => {
                    const stale = olderThan(lock.locked_at, STALE_DAYS, Date.now());
                    return (
                      <tr key={lock.id} className={stale ? "stale" : undefined}>
                        <td className="mono">{lock.path}</td>
                        <td>{lock.owner.name}</td>
                        <td>
                          <Time iso={lock.locked_at} />
                          {stale ? <span className="badge warn">over {formatCount(STALE_DAYS)} days</span> : null}
                        </td>
                        <td className="num">
                          <button
                            type="button"
                            className="danger"
                            aria-label={`Unlock ${lock.path}`}
                            disabled={action.busy !== undefined || readOnly !== undefined}
                            title={readOnly}
                            onClick={() => release(result.value.repository, lock.id, lock.path, lock.owner.name)}
                          >
                            {action.busy === lock.id ? "Unlocking…" : "Unlock"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
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
                  search: { ...base, ...(cursor ? { cursor } : {}), ...(prev.length > 1 ? { prev: prev.slice(0, -1) } : {}) },
                });
              }}
            >
              Previous
            </button>
            <span className="hint">Page {page}</span>
            <button
              type="button"
              disabled={!result.value.nextCursor}
              onClick={() =>
                navigate({
                  search: {
                    ...base,
                    ...(result.value.nextCursor ? { cursor: result.value.nextCursor } : {}),
                    prev: [...(search.prev ?? []), search.cursor ?? ""],
                  },
                })
              }
            >
              Next
            </button>
          </div>
        </section>
      ) : (
        <Failure message={result.message} />
      )}
    </>
  );
}
