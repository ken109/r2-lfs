import type { ActivitySource } from "../app/ports.ts";
import { METRICS_DATASET } from "../shared/contract.ts";
import type { Fetcher } from "./host-permissions.ts";

interface Row {
  repo: string;
  requests: number | string;
  bytes: number | string;
  errors: number | string;
}

/**
 * Reads what AnalyticsEngineMetrics writes, through Cloudflare's SQL API. Analytics Engine samples at high
 * volume, so every sum is weighted by `_sample_interval`.
 */
export class AnalyticsSqlActivity implements ActivitySource {
  private readonly fetcher: Fetcher;
  private readonly accountId: string;
  private readonly apiToken: string;

  constructor(fetcher: Fetcher, settings: { accountId: string; apiToken: string }) {
    this.fetcher = fetcher;
    this.accountId = settings.accountId;
    this.apiToken = settings.apiToken;
  }

  async byRepository(hours: number) {
    const sql = `SELECT blob1 AS repo, SUM(_sample_interval) AS requests, SUM(_sample_interval * double1) AS bytes,
  SUM(IF(double2 >= 500, _sample_interval, 0)) AS errors
FROM ${METRICS_DATASET}
WHERE timestamp > NOW() - INTERVAL '${Math.floor(hours)}' HOUR
GROUP BY repo ORDER BY requests DESC LIMIT 200
FORMAT JSON`;
    const res = await this.fetcher(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/analytics_engine/sql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}` },
      body: sql,
    });
    if (!res.ok) throw new Error(`Analytics Engine SQL API answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: Row[] };
    return (body.data ?? []).map((row) => ({
      repo: row.repo,
      requests: Number(row.requests),
      bytes: Number(row.bytes),
      errors: Number(row.errors),
    }));
  }
}
