import type { ActivitySource } from "../app/ports.ts";
import { METRICS_DATASET } from "../shared/contract.ts";
import type { Fetcher } from "./host-permissions.ts";

interface Totals {
  requests: number | string;
  bytes: number | string;
  errors: number | string;
}

/** Sums weighted by `_sample_interval`, since Analytics Engine samples at high volume. */
const SUMS = `SUM(_sample_interval) AS requests, SUM(_sample_interval * double1) AS bytes,
  SUM(IF(double2 >= 500, _sample_interval, 0)) AS errors`;

const totals = (row: Totals) => ({ requests: Number(row.requests), bytes: Number(row.bytes), errors: Number(row.errors) });

/** Reads what AnalyticsEngineMetrics writes, through Cloudflare's SQL API. */
export class AnalyticsSqlActivity implements ActivitySource {
  private readonly fetcher: Fetcher;
  private readonly accountId: string;
  private readonly apiToken: string;

  constructor(fetcher: Fetcher, settings: { accountId: string; apiToken: string }) {
    this.fetcher = fetcher;
    this.accountId = settings.accountId;
    this.apiToken = settings.apiToken;
  }

  private async query<T>(sql: string): Promise<T[]> {
    const res = await this.fetcher(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/analytics_engine/sql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}` },
      body: sql,
    });
    if (!res.ok) throw new Error(`Analytics Engine SQL API answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: T[] };
    return body.data ?? [];
  }

  private where(hours: number, repo: string | undefined): string {
    // Callers pass a parsed owner/name, which has no quotes; they are escaped all the same.
    const only = repo === undefined ? "" : ` AND blob1 = '${repo.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
    return `WHERE timestamp > NOW() - INTERVAL '${Math.floor(hours)}' HOUR${only}`;
  }

  async byRepository(hours: number, repo?: string, limit = 200) {
    const rows = await this.query<Totals & { repo: string }>(`SELECT blob1 AS repo, ${SUMS}
FROM ${METRICS_DATASET}
${this.where(hours, repo)}
GROUP BY repo ORDER BY requests DESC LIMIT ${Math.floor(limit)}
FORMAT JSON`);
    return rows.map((row) => ({ repo: row.repo, ...totals(row) }));
  }

  async timeline(hours: number, bucketHours: number, repo?: string) {
    const rows = await this.query<
      Totals & { t: string }
    >(`SELECT toStartOfInterval(timestamp, INTERVAL '${Math.floor(bucketHours)}' HOUR) AS t, ${SUMS}
FROM ${METRICS_DATASET}
${this.where(hours, repo)}
GROUP BY t ORDER BY t
FORMAT JSON`);
    // The SQL API answers times as `2026-09-14 08:00:00`, in UTC.
    return rows.map((row) => ({ start: new Date(`${row.t.replace(" ", "T")}Z`).toISOString(), ...totals(row) }));
  }
}
