import type { MetricPoint, Metrics } from "../app/ports.ts";

/**
 * Writes one data point per LFS request: blobs are repository, endpoint, method and status class;
 * doubles are bytes and the status; the index is the repository.
 */
export class AnalyticsEngineMetrics implements Metrics {
  private readonly dataset: AnalyticsEngineDataset | undefined;

  constructor(dataset: AnalyticsEngineDataset | undefined) {
    this.dataset = dataset;
  }

  record(point: MetricPoint): void {
    this.dataset?.writeDataPoint({
      indexes: [point.repo],
      blobs: [point.repo, point.endpoint, point.method, `${Math.floor(point.status / 100)}xx`],
      doubles: [point.bytes, point.status],
    });
  }
}
