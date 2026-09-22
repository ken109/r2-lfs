import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { getActivity } from "./-functions.ts";
import { Caption, Failure, formatBytes, formatCount, PageHeader, RouteError, RoutePending } from "./-ui.tsx";

const PERIODS = [
  { hours: 1, label: "Last hour" },
  { hours: 24, label: "Last 24 hours" },
  { hours: 24 * 7, label: "Last 7 days" },
  { hours: 24 * 30, label: "Last 30 days" },
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

function ActivityPage(): ReactNode {
  const { hours } = Route.useSearch();
  const result = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });

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
        <section>
          <div className="table-wrap">
            {result.value.repositories.length === 0 ? (
              <p className="empty">No requests in this period.</p>
            ) : (
              <table>
                <Caption>Requests by repository</Caption>
                <thead>
                  <tr>
                    <th>Repository</th>
                    <th className="num">Requests</th>
                    <th className="num">Through the Worker</th>
                    <th className="num">Server errors</th>
                  </tr>
                </thead>
                <tbody>
                  {result.value.repositories.map((row) => (
                    <tr key={row.repo}>
                      <td className="mono">{row.repo}</td>
                      <td className="num">{formatCount(row.requests)}</td>
                      <td className="num">{formatBytes(row.bytes)}</td>
                      <td className="num">{formatCount(row.errors)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}
    </>
  );
}
