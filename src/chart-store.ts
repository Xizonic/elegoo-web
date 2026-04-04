/** Ring-buffer time-series store for live charts */

export interface DataPoint {
  t: number; // timestamp ms
  v: number; // value
}

export interface Series {
  label: string;
  color: string;
  data: DataPoint[];
}

const MAX_POINTS = 3600; // 1 hour at 1 sample/sec
const SAMPLE_INTERVAL = 1000; // ms between stored samples

export class ChartStore {
  private series = new Map<string, Series>();
  private lastSampleTime = 0;
  private listeners: (() => void)[] = [];
  private latestValues: Record<string, number> = {};
  private intervalId: ReturnType<typeof setInterval> | null = null;

  defineSeries(key: string, label: string, color: string): void {
    if (!this.series.has(key)) {
      this.series.set(key, { label, color, data: [] });
    }
  }

  /** Update latest values. Actual recording happens via internal timer. */
  push(values: Record<string, number>): void {
    Object.assign(this.latestValues, values);
    if (!this.intervalId) {
      this.record(); // Record first sample immediately
      this.intervalId = setInterval(() => this.record(), SAMPLE_INTERVAL);
    }
  }

  private record(): void {
    const now = Date.now();
    this.lastSampleTime = now;

    for (const [key, value] of Object.entries(this.latestValues)) {
      const series = this.series.get(key);
      if (!series) continue;
      series.data.push({ t: now, v: value });
      if (series.data.length > MAX_POINTS) {
        series.data.shift();
      }
    }

    for (const fn of this.listeners) fn();
  }

  getSeries(key: string): Series | undefined {
    return this.series.get(key);
  }

  getAllSeries(): Map<string, Series> {
    return this.series;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /** Restore series data from persistence */
  restoreSeries(key: string, data: DataPoint[]): void {
    const series = this.series.get(key);
    if (!series) return;
    // Only restore if series is currently empty (no new data yet)
    if (series.data.length === 0 && data.length > 0) {
      series.data = data;
    }
  }
}
