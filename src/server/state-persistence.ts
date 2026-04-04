/**
 * State persistence — periodically saves chart/layer data to disk
 * so the service survives restarts without losing time-series data.
 *
 * Only persists data that cannot be recovered from the printer:
 * - Chart ring buffer (temps, fans over time)
 * - Layer timing data (duration per layer)
 *
 * Printer status, attributes, canvas etc. come fresh from MQTT on reconnect.
 */

import { writeFile, readFile, rename, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import type { StateStore, ChartPoint } from './state-store.js';

const SAVE_INTERVAL_MS = 30_000; // Save every 30 seconds

interface PersistedState {
  version: 1;
  savedAt: number;
  chartData: ChartPoint[];
  layerTimes: Array<{ layer: number; duration: number; timestamp: number }>;
  lastLayer: number;
  lastLayerTime: number;
}

export class StatePersistence {
  private timer: ReturnType<typeof setInterval> | null = null;
  private filePath: string;

  constructor(
    private store: StateStore,
    dataDir: string,
  ) {
    this.filePath = join(dataDir, 'state.json');
  }

  /** Load persisted state from disk into the store */
  async load(): Promise<boolean> {
    try {
      if (!existsSync(this.filePath)) return false;

      const raw = await readFile(this.filePath, 'utf-8');
      const data: PersistedState = JSON.parse(raw);

      if (data.version !== 1) return false;

      // Only restore if data is less than 24 hours old
      const age = Date.now() - data.savedAt;
      if (age > 24 * 60 * 60 * 1000) {
        console.log('[Persistence] Saved state too old (>24h), skipping restore');
        return false;
      }

      this.store.restoreChartData(data.chartData);
      this.store.restoreLayerData(data.layerTimes, data.lastLayer, data.lastLayerTime);

      const chartCount = data.chartData?.length ?? 0;
      const layerCount = data.layerTimes?.length ?? 0;
      console.log(`[Persistence] Restored ${chartCount} chart points, ${layerCount} layer entries (age: ${Math.round(age / 1000)}s)`);
      return true;
    } catch (err) {
      console.warn(`[Persistence] Failed to load: ${(err as Error).message}`);
      return false;
    }
  }

  /** Start periodic saving */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.save(), SAVE_INTERVAL_MS);
    // Also save on process exit signals
    const shutdown = () => {
      this.saveSync();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  /** Stop periodic saving */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Final save
    this.save().catch(() => {});
  }

  private async save(): Promise<void> {
    try {
      const data: PersistedState = {
        version: 1,
        savedAt: Date.now(),
        chartData: this.store.getChartHistory(),
        layerTimes: this.store.layerTimes,
        lastLayer: this.store.getLastLayer(),
        lastLayerTime: this.store.getLastLayerTime(),
      };

      const json = JSON.stringify(data);

      // Ensure directory exists
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      // Atomic write: write to temp file, then rename
      const tmpPath = this.filePath + '.tmp';
      await writeFile(tmpPath, json, 'utf-8');
      await rename(tmpPath, this.filePath);
    } catch (err) {
      console.warn(`[Persistence] Save failed: ${(err as Error).message}`);
    }
  }

  /** Synchronous-ish save for shutdown (best effort) */
  private saveSync(): void {
    this.save().catch(() => {});
  }
}
