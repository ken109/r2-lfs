import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import type { StorageReport } from "../../app/admin-storage.ts";
import { getStorage } from "./-functions.ts";
import { Caption, Failure, formatBytes, formatCount, PageHeader } from "./-ui.tsx";

export const Route = createFileRoute("/_admin/")({
  component: OverviewPage,
});

const layout = getRouteApi("/_admin");

const limit = (bytes: number | undefined) => (bytes === undefined ? "no limit" : formatBytes(bytes));

function OverviewPage(): ReactNode {
  const overview = layout.useLoaderData();
  const [storage, setStorage] = useState<StorageReport | "loading" | undefined>();
  const [failure, setFailure] = useState<string>();

  async function countStorage() {
    setStorage("loading");
    setFailure(undefined);
    try {
      setStorage(await getStorage());
    } catch (err) {
      setStorage(undefined);
      setFailure(err instanceof Error ? err.message : String(err));
    }
  }

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
          </dl>
        </div>
      </section>

      <section>
        <h2>Storage</h2>
        {storage === undefined || storage === "loading" ? (
          <div className="panel">
            <p className="lede" style={{ marginTop: 0 }}>
              Counting lists the whole bucket, which R2 bills as Class A operations: one per 1,000 objects.
            </p>
            <button type="button" className="primary" onClick={countStorage} disabled={storage === "loading"}>
              {storage === "loading" ? "Counting…" : "Count storage"}
            </button>
            {failure ? <Failure message={failure} /> : null}
          </div>
        ) : (
          <StorageView report={storage} shared={overview.storageLayout === "shared"} />
        )}
      </section>
    </>
  );
}

function StorageView({ report, shared }: { report: StorageReport; shared: boolean }): ReactNode {
  return (
    <>
      {report.truncated ? (
        <p className="notice warn">The bucket has more objects than one count covers; these numbers are a lower bound.</p>
      ) : null}
      <div className="stats">
        <Stat label="Stored" value={formatBytes(report.total.bytes)} sub={`${formatCount(report.total.objects)} objects`} />
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
                <th>Repository</th>
                <th className="num">Objects</th>
                <th className="num">{shared ? "Uploaded (shared)" : "Size"}</th>
              </tr>
            </thead>
            <tbody>
              {report.repositories.map((repo) => (
                <tr key={repo.repo}>
                  <td className="mono">{repo.repo}</td>
                  <td className="num">{formatCount(repo.objects)}</td>
                  <td className="num">{formatBytes(repo.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
