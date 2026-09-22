import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { getAudit } from "./-functions.ts";
import { Caption, Failure, PageHeader, RouteError, RoutePending, Time } from "./-ui.tsx";

interface Search {
  cursor?: string;
  /** The cursors of the pages before this one, `""` for the first, so Newer can go back. */
  prev?: string[];
}

export const Route = createFileRoute("/_admin/audit")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ...(typeof search.cursor === "string" && search.cursor ? { cursor: search.cursor } : {}),
    ...(Array.isArray(search.prev) && search.prev.length > 0 && search.prev.every((c) => typeof c === "string")
      ? { prev: search.prev as string[] }
      : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAudit({ data: deps.cursor ? { cursor: deps.cursor } : {} }),
  component: AuditPage,
  errorComponent: RouteError,
  pendingComponent: RoutePending,
});

const layout = getRouteApi("/_admin");

const OUTCOME_CLASS = { done: "badge", failed: "badge error", refused: "badge warn" } as const;

function AuditPage(): ReactNode {
  const result = Route.useLoaderData();
  const search = Route.useSearch();
  const { access } = layout.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  const page = (search.prev?.length ?? 0) + 1;

  return (
    <>
      <PageHeader title="Audit">
        Changes made in this admin UI, newest first: who made them, when, and how they ended. They are kept in <code>_meta/audit/</code> in
        the bucket.
      </PageHeader>
      {access.canChange && !access.limited ? (
        <p className="notice">
          Everyone Cloudflare Access lets in may change things. Set <code>ADMIN_EMAILS</code> to let only some of them.
        </p>
      ) : null}

      {!result.ok ? (
        <Failure message={result.message} />
      ) : (
        <section>
          <div className="table-wrap">
            {result.value.entries.length === 0 ? (
              <p className="empty">{page === 1 ? "No changes yet." : "No older changes."}</p>
            ) : (
              <table>
                <Caption>Changes, page {page}</Caption>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>What</th>
                    <th>Target</th>
                    <th>Outcome</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {result.value.entries.map((entry, i) => (
                    <tr key={`${i}:${entry.at}`}>
                      <td>
                        <Time iso={entry.at} />
                      </td>
                      <td>{entry.email}</td>
                      <td className="mono">{entry.action}</td>
                      <td className="mono">{entry.target}</td>
                      <td>
                        <span className={OUTCOME_CLASS[entry.outcome]}>{entry.outcome}</span>
                      </td>
                      <td className="wrap">{entry.detail ?? ""}</td>
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
                void navigate({ search: { ...(cursor ? { cursor } : {}), ...(prev.length > 1 ? { prev: prev.slice(0, -1) } : {}) } });
              }}
            >
              Newer
            </button>
            <span className="hint">Page {page}</span>
            <button
              type="button"
              disabled={!result.value.cursor}
              onClick={() =>
                navigate({
                  search: {
                    ...(result.value.cursor ? { cursor: result.value.cursor } : {}),
                    prev: [...(search.prev ?? []), search.cursor ?? ""],
                  },
                })
              }
            >
              Older
            </button>
          </div>
        </section>
      )}
    </>
  );
}
