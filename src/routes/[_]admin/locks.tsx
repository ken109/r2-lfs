import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import type { FormEvent, ReactNode } from "react";

import { getLocks, unlock } from "./-functions.ts";
import { ActionStatus, Caption, Failure, PageHeader, RouteError, RoutePending, Time, useAction, useConfirm } from "./-ui.tsx";

export const Route = createFileRoute("/_admin/locks")({
  validateSearch: (search: Record<string, unknown>): { repo?: string; cursor?: string } => ({
    ...(typeof search.repo === "string" && search.repo ? { repo: search.repo } : {}),
    ...(typeof search.cursor === "string" && search.cursor ? { cursor: search.cursor } : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) =>
    deps.repo ? getLocks({ data: { repository: deps.repo, ...(deps.cursor ? { cursor: deps.cursor } : {}) } }) : undefined,
  component: LocksPage,
  errorComponent: RouteError,
  pendingComponent: RoutePending,
});

function LocksPage(): ReactNode {
  const search = Route.useSearch();
  const result = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const action = useAction();
  const { confirm, dialog } = useConfirm();

  function lookUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const repo = String(new FormData(event.currentTarget).get("repo")).trim();
    void navigate({ search: repo ? { repo } : {} });
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

  return (
    <>
      <PageHeader title="Locks">
        File locks of a repository, taken with git lfs lock. Unlocking here works like git lfs unlock --force.
      </PageHeader>

      <section>
        <form className="inline" onSubmit={lookUp}>
          <label className="field">
            Repository
            <input name="repo" defaultValue={search.repo ?? ""} placeholder="owner/name" className="mono" required autoComplete="off" />
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
          <h2 className="mono">{result.value.repository}</h2>
          <div className="table-wrap">
            {result.value.locks.length === 0 ? (
              <p className="empty">Nothing is locked.</p>
            ) : (
              <table>
                <Caption>Locks in {result.value.repository}</Caption>
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
                  {result.value.locks.map((lock) => (
                    <tr key={lock.id}>
                      <td className="mono">{lock.path}</td>
                      <td>{lock.owner.name}</td>
                      <td>
                        <Time iso={lock.locked_at} />
                      </td>
                      <td className="num">
                        <button
                          type="button"
                          className="danger"
                          aria-label={`Unlock ${lock.path}`}
                          disabled={action.busy !== undefined}
                          onClick={() => release(result.value.repository, lock.id, lock.path, lock.owner.name)}
                        >
                          {action.busy === lock.id ? "Unlocking…" : "Unlock"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {result.value.nextCursor ? (
            <p>
              <button type="button" onClick={() => navigate({ search: { ...search, cursor: result.value.nextCursor } })}>
                Next page
              </button>
            </p>
          ) : null}
        </section>
      ) : (
        <Failure message={result.message} />
      )}
    </>
  );
}
