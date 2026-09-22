import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";

import { getLocks, unlock } from "./-functions.ts";
import { Failure, PageHeader, Time } from "./-ui.tsx";

export const Route = createFileRoute("/_admin/locks")({
  validateSearch: (search: Record<string, unknown>): { repo?: string; cursor?: string } => ({
    ...(typeof search.repo === "string" && search.repo ? { repo: search.repo } : {}),
    ...(typeof search.cursor === "string" && search.cursor ? { cursor: search.cursor } : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) =>
    deps.repo ? getLocks({ data: { repository: deps.repo, ...(deps.cursor ? { cursor: deps.cursor } : {}) } }) : undefined,
  component: LocksPage,
});

function LocksPage(): ReactNode {
  const search = Route.useSearch();
  const result = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const [failure, setFailure] = useState<string>();

  function lookUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const repo = String(new FormData(event.currentTarget).get("repo")).trim();
    void navigate({ search: repo ? { repo } : {} });
  }

  async function release(repository: string, id: string, path: string, owner: string) {
    if (!confirm(`Unlock ${path}, held by ${owner}? Their next push of it may conflict with someone else's work.`)) return;
    setFailure(undefined);
    const outcome = await unlock({ data: { repository, id } });
    if (!outcome.ok) setFailure(outcome.message);
    await router.invalidate();
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

      {failure ? <Failure message={failure} /> : null}

      {result === undefined ? null : result.ok ? (
        <section>
          <h2 className="mono">{result.value.repository}</h2>
          <div className="table-wrap">
            {result.value.locks.length === 0 ? (
              <p className="empty">Nothing is locked.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Path</th>
                    <th>Held by</th>
                    <th>Since</th>
                    <th />
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
                          onClick={() => release(result.value.repository, lock.id, lock.path, lock.owner.name)}
                        >
                          Unlock
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
