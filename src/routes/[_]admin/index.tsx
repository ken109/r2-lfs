import { createFileRoute, getRouteApi, Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { StorageReport } from "../../app/admin-storage.ts";
import { errorRate, QUOTA_WARNING, quotaShare, sortRows } from "./-format.ts";
import { countStorage, getActivity, getLastStorage } from "./-functions.ts";
import {
  ActionStatus,
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
  Time,
  useAction,
  useSort,
} from "./-ui.tsx";

export const Route = createFileRoute("/_admin/")({
  loader: async () => {
    const [storage, activity] = await Promise.all([
      getLastStorage(),
      // A summary only: the page still works when Analytics Engine does not answer.
      getActivity({ data: { hours: 24 } }).catch((err: unknown) => ({
        ok: false as const,
        status: 502,
        message: err instanceof Error ? err.message : String(err),
      })),
    ]);
    return { storage, activity };
  },
  component: OverviewPage,
  errorComponent: RouteError,
  pendingComponent: RoutePending,
});

const layout = getRouteApi("/_admin");

const limit = (bytes: number | undefined) => (bytes === undefined ? "no limit" : formatBytes(bytes));

function OverviewPage(): ReactNode {
  const overview = layout.useLoaderData();
  const { storage: saved, activity } = Route.useLoaderData();
  const router = useRouter();
  const action = useAction();

  async function count() {
    await action.run("count", async () => ({ ok: true as const, value: await countStorage() }), {
      success: (counted) => `Counted ${formatCount(counted.report.total.objects)} objects`,
      after: () => router.invalidate(),
    });
  }

  const countButton = (
    <button type="button" className={saved ? undefined : "primary"} onClick={count} disabled={action.busy !== undefined}>
      {action.busy === "count" ? "Counting…" : saved ? "Count again" : "Count storage"}
    </button>
  );

  return (
    <>
      <PageHeader title="Overview">How this server is set up, and what its bucket holds.</PageHeader>

      {overview.warnings.map((warning) => (
        <p key={warning} className="notice warn">
          {warning}
        </p>
      ))}

      <section>
        <h2>Settings</h2>
        <div className="panel">
          <dl className="settings">
            <dt>Authentication</dt>
            <dd>
              {overview.authMode}
              {overview.authHost ? <span className="mono"> · {overview.authHost}</span> : null}
            </dd>
            <dt>Repositories</dt>
            <dd className="mono">{overview.allowedRepos.join(", ")}</dd>
            <dt>Storage layout</dt>
            <dd>{overview.storageLayout}</dd>
            <dt>Transfers</dt>
            <dd>
              {overview.transfer}
              {overview.transfer === "presigned" ? ` · uploads ${overview.verifyUploads ? "hash-checked" : "size-checked only"}` : ""}
            </dd>
            <dt>Encryption at rest</dt>
            <dd>{overview.encrypted ? "SSE-C with the server key" : "off"}</dd>
            <dt>Limits</dt>
            <dd>
              {formatBytes(overview.proxyMaxUploadBytes)} per proxied request · {limit(overview.maxObjectBytes)} per object ·{" "}
              {limit(overview.quotaBytes)} per repository
            </dd>
            <dt>GitHub Actions OIDC</dt>
            <dd>
              {overview.actionsOidc ? (
                <>
                  {overview.actionsOidc.permission} · audience <code>{overview.actionsOidc.audience}</code>
                </>
              ) : (
                "off"
              )}
            </dd>
            <dt>Tokens in AUTH_TOKENS</dt>
            <dd>{overview.staticTokens}</dd>
            <dt>Short-lived tokens</dt>
            <dd>
              {overview.endpoints.sessions ? "on" : "off"} · <code>&lt;repository&gt;/r2-lfs/session</code>, used by{" "}
              <code>r2-lfs credential</code>
            </dd>
            <dt>gc through the Worker</dt>
            <dd>
              {overview.endpoints.storage ? "on" : "off, the shared layout needs R2 API credentials"} ·{" "}
              <code>&lt;repository&gt;/r2-lfs/objects</code>
            </dd>
          </dl>
        </div>
      </section>

      {activity.ok && !activity.value.enabled ? null : (
        <section aria-labelledby="day-heading">
          <h2 id="day-heading">Last 24 hours</h2>
          {!activity.ok ? (
            <Failure message={activity.message} />
          ) : activity.value.enabled ? (
            <>
              <div className="stats">
                <Stat label="Requests" value={formatCount(activity.value.total.requests)} />
                <Stat
                  label="Server errors"
                  value={formatCount(activity.value.total.errors)}
                  sub={`${errorRate(activity.value.total.errors, activity.value.total.requests)} of requests`}
                />
                <Stat label="Through the Worker" value={formatBytes(activity.value.total.bytes)} />
                <Stat
                  label="Busiest repository"
                  value={activity.value.repositories[0]?.repo ?? "none"}
                  {...(activity.value.repositories[0] ? { sub: `${formatCount(activity.value.repositories[0].requests)} requests` } : {})}
                />
              </div>
              <div style={{ marginTop: 12 }}>
                <ActivityChart timeline={activity.value.timeline} bucketHours={activity.value.bucketHours} />
              </div>
              <p className="hint">
                <Link to="/_admin/activity" search={{ hours: 24 }}>
                  Requests by repository
                </Link>
              </p>
            </>
          ) : null}
        </section>
      )}

      <section>
        <h2>Storage</h2>
        {saved ? (
          <>
            <div className="inline-actions">
              <span className="hint">
                Last counted <Time iso={saved.countedAt} />. Counting lists the whole bucket, which R2 bills as Class A operations: one per
                1,000 objects.
              </span>
              {countButton}
            </div>
            <StorageView report={saved.report} shared={overview.storageLayout === "shared"} quota={overview.quotaBytes} />
          </>
        ) : (
          <div className="panel">
            <p className="lede" style={{ marginTop: 0 }}>
              Counting lists the whole bucket, which R2 bills as Class A operations: one per 1,000 objects. The result is kept, so this page
              shows it until you count again.
            </p>
            {countButton}
          </div>
        )}
        <ActionStatus action={action} />
      </section>
    </>
  );
}

type Column = "repo" | "objects" | "bytes";

function StorageView({ report, shared, quota }: { report: StorageReport; shared: boolean; quota: number | undefined }): ReactNode {
  const sort = useSort<Column>("bytes");
  const rows = sortRows(report.repositories, sort.key, sort.direction);
  // In the shared layout the quota covers the whole pool, not each repository.
  const perRepoQuota = shared ? undefined : quota;
  const poolShare = shared ? quotaShare(report.total.bytes, quota) : undefined;

  return (
    <>
      {report.truncated ? (
        <p className="notice warn">The bucket has more objects than one count covers; these numbers are a lower bound.</p>
      ) : null}
      <div className="stats">
        <Stat
          label="Stored"
          value={formatBytes(report.total.bytes)}
          sub={`${formatCount(report.total.objects)} objects`}
          share={poolShare}
        />
        <Stat label="Trash" value={formatBytes(report.trash.bytes)} sub={`${formatCount(report.trash.objects)} objects`} />
        <Stat
          label="Unfinished uploads"
          value={formatBytes(report.incoming.bytes)}
          sub={`${formatCount(report.incoming.objects)} objects`}
        />
        <Stat label="Repositories" value={formatCount(report.repositories.length)} />
      </div>
      <div className="table-wrap" style={{ marginTop: 12 }}>
        {report.repositories.length === 0 ? (
          <p className="empty">No objects yet.</p>
        ) : (
          <table>
            <Caption>Storage by repository</Caption>
            <thead>
              <tr>
                <SortHeader sort={sort} column="repo">
                  Repository
                </SortHeader>
                <SortHeader sort={sort} column="objects" numeric>
                  Objects
                </SortHeader>
                <SortHeader sort={sort} column="bytes" numeric>
                  {shared ? "Uploaded (shared)" : "Size"}
                </SortHeader>
                {perRepoQuota ? <th>Of the quota</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((repo) => {
                const share = quotaShare(repo.bytes, perRepoQuota);
                const over = share !== undefined && share > QUOTA_WARNING;
                return (
                  <tr key={repo.repo} className={over ? "over" : undefined}>
                    <td>
                      <RepoLink repo={repo.repo} />
                    </td>
                    <td className="num">{formatCount(repo.objects)}</td>
                    <td className="num">{formatBytes(repo.bytes)}</td>
                    {share === undefined ? null : (
                      <td>
                        <QuotaBar share={share} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function QuotaBar({ share }: { share: number }): ReactNode {
  const over = share > QUOTA_WARNING;
  return (
    <>
      <span className={over ? "bar over" : "bar"} aria-hidden="true">
        <span style={{ width: `${Math.min(share, 1) * 100}%` }} />
      </span>
      {Math.round(share * 100)}%{over ? <strong> nearly full</strong> : null}
    </>
  );
}

function Stat({ label, value, sub, share }: { label: string; value: string; sub?: string; share?: number | undefined }): ReactNode {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
      {share === undefined ? null : (
        <div className="sub">
          <QuotaBar share={share} /> of the quota
        </div>
      )}
    </div>
  );
}
