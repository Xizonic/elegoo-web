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

const MAX_POINTS = 300; // ~5 min at 1 sample/sec
const SAMPLE_INTERVAL = 1000; // ms between stored samples

export class ChartStore {
  private series = new Map<string, Series>();
  private lastSampleTime = 0;
  private listeners: (() => void)[] = [];

  defineSeries(key: string, label: string, color: string): void {
    if (!this.series.has(key)) {
      this.series.set(key, { label, color, data: [] });
    }
  }

  /** Push values for multiple series at once. Throttled to SAMPLE_INTERVAL. */
  push(values: Record<string, number>): void {
    const now = Date.now();
    if (now - this.lastSampleTime < SAMPLE_INTERVAL) return;
    this.lastSampleTime = now;

    for (const [key, value] of Object.entries(values)) {
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
}
