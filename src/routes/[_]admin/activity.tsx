import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { errorRate, sortRows } from "./-format.ts";
import { getActivity } from "./-functions.ts";
import {
  ActivityChart,
  Caption,
  Failure,
  formatBytes,
  formatCount,
  PageHeader,
  RepoLink,
  RouteError,
  RoutePending,
  SortHeader,
  useSort,
} from "./-ui.tsx";

const PERIODS = [
  { hours: 1, label: "Last hour" },
  { hours: 24, label: "Last 24 hours" },
  { hours: 24 * 7, label: "Last 7 days" },
  { hours: 24 * 30, label: "Last 30 days" },
  { hours: 24 * 90, label: "Last 90 days" },
] as const;

export const Route = createFileRoute("/_admin/activity")({
  validateSearch: (search: Record<string, unknown>): { hours: number } => ({
    hours: PERIODS.some((p) => p.hours === Number(search.hours)) ? Number(search.hours) : 24,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getActivity({ data: { hours: deps.hours } }),
  component: ActivityPage,
  errorComponent: RouteError,
  pendingComponent: RoutePending,
});

type Column = "repo" | "requests" | "bytes" | "errors" | "rate";

function ActivityPage(): ReactNode {
  const { hours } = Route.useSearch();
  const result = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  const sort = useSort<Column>("requests");

  return (
    <>
      <PageHeader title="Activity">Git LFS requests by repository, from Workers Analytics Engine.</PageHeader>
      <section>
        <label className="field" style={{ maxWidth: 220 }}>
          Period
          <select value={hours} onChange={(event) => navigate({ search: { hours: Number(event.target.value) } })}>
            {PERIODS.map((period) => (
              <option key={period.hours} value={period.hours}>
                {period.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      {!result.ok ? (
        <Failure message={result.message} />
      ) : !result.value.enabled ? (
        <p className="notice">
          Set the <code>ANALYTICS_API_TOKEN</code> secret to a Cloudflare API token with <em>Account Analytics Read</em>, and{" "}
          <code>R2_ACCOUNT_ID</code> to your account id, to see requests here.
        </p>
      ) : (
        <>
          <section aria-labelledby="timeline-heading">
            <h2 id="timeline-heading">
              {formatCount(result.value.total.requests)} requests · {formatCount(result.value.total.errors)} server errors (
              {errorRate(result.value.total.errors, result.value.total.requests)}) · {formatBytes(result.value.total.bytes)} through the
              Worker
            </h2>
            <ActivityChart timeline={result.value.timeline} bucketHours={result.value.bucketHours} />
          </section>

          <section aria-labelledby="repositories-heading">
            <h2 id="repositories-heading">By repository</h2>
            {result.value.truncated ? (
              <p className="notice warn">
                Only the {formatCount(result.value.repositories.length)} repositories with the most requests are listed; the totals above
                count every repository.
              </p>
            ) : null}
            <div className="table-wrap">
              {result.value.repositories.length === 0 ? (
                <p className="empty">No requests in this period.</p>
              ) : (
                <table>
                  <Caption>Requests by repository</Caption>
                  <thead>
                    <tr>
                      <SortHeader sort={sort} column="repo">
                        Repository
                      </SortHeader>
                      <SortHeader sort={sort} column="requests" numeric>
                        Requests
                      </SortHeader>
                      <SortHeader sort={sort} column="bytes" numeric>
                        Through the Worker<span aria-hidden="true">*</span>
                      </SortHeader>
                      <SortHeader sort={sort} column="errors" numeric>
                        Server errors
                      </SortHeader>
                      <SortHeader sort={sort} column="rate" numeric>
                        Error rate
                      </SortHeader>
                    </tr>
                  </thead>
                  <tbody>
                    {sortRows(
                      result.value.repositories.map((row) => ({ ...row, rate: row.requests ? row.errors / row.requests : 0 })),
                      sort.key,
                      sort.direction,
                    ).map((row) => (
                      <tr key={row.repo}>
                        <td>
                          <RepoLink repo={row.repo} />
                        </td>
                        <td className="num">{formatCount(row.requests)}</td>
                        <td className="num">{formatBytes(row.bytes)}</td>
                        <td className="num">{formatCount(row.errors)}</td>
                        <td className="num">{errorRate(row.errors, row.requests)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <p className="hint">
              * Through the Worker: bytes of uploads and downloads proxied by the Worker, which count toward its request limits. Presigned
              transfers go between git-lfs and R2 directly and are not counted here.
            </p>
          </section>
        </>
      )}
    </>
  );
}
