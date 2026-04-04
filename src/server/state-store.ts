/**
 * Shared state store — mirrors PrinterState from the frontend,
 * but lives server-side and feeds data to all consumers.
 *
 * Also detects print events for notifications (Telegram, future webhooks).
 */

import { EventEmitter } from 'events';
import type { MqttBridge } from './mqtt-bridge.js';
import type { PrinterAttributes, PrinterStatus, CanvasInfo, FileEntry } from '../types.js';
import {
  STATUS_NAMES, SUB_STATUS_NAMES, SPEED_MODE_NAMES,
  EXCEPTION_NAMES, CRITICAL_EXCEPTIONS,
} from '../types.js';

/** Chart data point — matches the browser ChartStore format */
export interface ChartPoint {
  t: number;
  values: Record<string, number>;
}

const CHART_MAX_POINTS = 3600; // 1 hour at 1 sample/sec
const CHART_SAMPLE_MS = 1000;

/** Deep-merge delta into base */
function deepMerge(base: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(update)) {
    const bVal = result[key];
    const uVal = update[key];
    if (bVal && uVal && typeof bVal === 'object' && typeof uVal === 'object' && !Array.isArray(uVal)) {
      result[key] = deepMerge(bVal as Record<string, unknown>, uVal as Record<string, unknown>);
    } else {
      result[key] = uVal;
    }
  }
  return result;
}

export type PrintEvent =
  | { type: 'connected'; sn: string }
  | { type: 'disconnected' }
  | { type: 'print_started'; filename: string }
  | { type: 'print_completed'; filename: string; duration: number }
  | { type: 'print_failed'; filename: string; reason: string }
  | { type: 'print_progress'; filename: string; progress: number; layer: number; totalLayers: number; remaining: number }
  | { type: 'error'; codes: number[]; names: string[] }
  | { type: 'filament_runout' };

export class StateStore extends EventEmitter {
  // Current state
  attributes: PrinterAttributes | null = null;
  status: PrinterStatus | null = null;
  canvas: CanvasInfo | null = null;
  files: FileEntry[] = [];
  thumbnail: string | null = null;
  thumbnailFailed = false;
  fileTotalLayers: number | null = null;
  systemInfo: Record<string, unknown> | null = null;
  timelapseList: Record<string, unknown>[] = [];
  videoUrl: string | null = null;
  bedMesh: number[][] | null = null;

  // Layer time tracking (server-side, survives browser reloads)
  layerTimes: Array<{ layer: number; duration: number; timestamp: number }> = [];
  private _lastLayer = 0;
  private _lastLayerTime = 0;

  // Chart data ring buffer (server-side, no gaps)
  private chartData: ChartPoint[] = [];
  private chartTimer: ReturnType<typeof setInterval> | null = null;

  // Raw log ring buffer for WS clients that want logs
  private rawLog: Array<{ direction: string; topic: string; data: unknown; ts: number }> = [];
  private readonly maxLogEntries = 500;

  // Event detection state
  private lastMachineStatus = -1;
  private lastSubStatus = -1;
  private lastProgressNotified = -1;
  private lastExceptions: number[] = [];
  private wasFilamentDetected = true;
  private totalLayers = 0;
  /** Baseline is ready only after the first full status (method 1002) is processed */
  private baselineReady = false;

  constructor(private bridge: MqttBridge, private progressInterval: number) {
    super();

    // Wire up MQTT bridge events
    bridge.on('connected', (sn: string) => {
      this.emit('print_event', { type: 'connected', sn } satisfies PrintEvent);
    });

    bridge.on('disconnected', () => {
      this.emit('print_event', { type: 'disconnected' } satisfies PrintEvent);
    });

    bridge.on('response', (method: number, data: Record<string, unknown>) => {
      this.handleResponse(method, data);
      // Forward raw response to WS clients
      this.emit('response', method, data);
    });

    bridge.on('status', (data: Record<string, unknown>) => {
      this.handleStatusEvent(data);
      // Forward raw delta to WS clients
      this.emit('status', data);
    });

    bridge.on('raw', (direction: string, topic: string, data: unknown) => {
      const entry = { direction, topic, data, ts: Date.now() };
      this.rawLog.push(entry);
      if (this.rawLog.length > this.maxLogEntries) this.rawLog.shift();
      this.emit('raw', entry);
    });

    // Sample chart data every second
    this.chartTimer = setInterval(() => this.sampleChart(), CHART_SAMPLE_MS);
  }

  private sampleChart(): void {
    if (!this.status) return;
    const s = this.status;
    const fanPct = (v: number) => Math.round((v / 255) * 100);
    const point: ChartPoint = {
      t: Date.now(),
      values: {
        nozzle: s.extruder?.temperature ?? 0,
        nozzle_tgt: s.extruder?.target ?? 0,
        bed: s.heater_bed?.temperature ?? 0,
        bed_tgt: s.heater_bed?.target ?? 0,
        chamber: s.ztemperature_sensor?.temperature ?? 0,
        fan_model: fanPct(s.fans?.fan?.speed ?? 0),
        fan_aux: fanPct(s.fans?.aux_fan?.speed ?? 0),
        fan_case: fanPct(s.fans?.box_fan?.speed ?? 0),
      },
    };
    this.chartData.push(point);
    if (this.chartData.length > CHART_MAX_POINTS) {
      this.chartData.shift();
    }
    this.emit('chart_data', point);
  }

  /** Get chart history for new WS clients */
  getChartHistory(): ChartPoint[] {
    return this.chartData;
  }

  /** Clean up timers */
  destroy(): void {
    if (this.chartTimer) clearInterval(this.chartTimer);
  }

  /** Get recent raw log entries */
  getRecentLogs(count = 100): Array<{ direction: string; topic: string; data: unknown; ts: number }> {
    return this.rawLog.slice(-count);
  }

  private handleResponse(method: number, data: Record<string, unknown>): void {
    const result = data.result as Record<string, unknown> | undefined;
    if (!result) return;

    switch (method) {
      case 1001:
        this.attributes = result as unknown as PrinterAttributes;
        break;
      case 1002:
        this.status = result as unknown as PrinterStatus;
        // On first full status, establish baseline without emitting events
        if (!this.baselineReady) {
          this.establishBaseline();
        }
        this.detectEvents();
        break;
      case 2005: {
        const info = result.canvas_info as CanvasInfo | undefined;
        if (info) this.canvas = info;
        break;
      }
      case 1044: {
        const fileList = result.file_list as FileEntry[] | undefined;
        if (fileList) this.files = fileList;
        break;
      }
      case 1045: {
        const errorCode = result.error_code as number | undefined;
        const thumb = result.thumbnail as string | undefined;
        if (thumb && errorCode === 0) {
          this.thumbnail = thumb;
          this.thumbnailFailed = false;
        } else {
          this.thumbnailFailed = true;
        }
        break;
      }
      case 1046: {
        const layers = (result.TotalLayers ?? result.layer ?? result.total_layer) as number | undefined;
        if (layers != null && layers > 0) {
          this.fileTotalLayers = layers;
          this.totalLayers = layers;
        }
        break;
      }
      case 1050: {
        const errorCode = result.error_code as number | undefined;
        const url = result.url as string | undefined;
        if (errorCode === 0 && url) this.videoUrl = url;
        break;
      }
      case 1051: {
        const errorCode = result.error_code as number | undefined;
        const list = result.file_list as Record<string, unknown>[] | undefined;
        if (errorCode === 0 && list) this.timelapseList = list;
        break;
      }
      case 1062: {
        const errorCode = result.error_code as number | undefined;
        if (errorCode === 0) {
          const info = { ...result };
          delete info.error_code;
          this.systemInfo = info;
        }
        break;
      }
    }
  }

  private handleStatusEvent(data: Record<string, unknown>): void {
    const result = data.result as Record<string, unknown> | undefined;
    if (!result) return;

    if (!this.status) {
      this.status = result as unknown as PrinterStatus;
    } else {
      this.status = deepMerge(
        this.status as unknown as Record<string, unknown>,
        result,
      ) as unknown as PrinterStatus;
    }

    // Capture bed mesh data if present
    const meshData = (result.bed_mesh ?? result.bed_level_info) as Record<string, unknown> | undefined;
    if (meshData) {
      const probed = (meshData.probed_matrix ?? meshData.mesh_matrix ?? meshData.data) as number[][] | undefined;
      if (probed && Array.isArray(probed) && probed.length > 0) {
        this.bedMesh = probed;
      }
    }

    this.detectEvents();
  }

  /**
   * Establish baseline from the first full status (method 1002).
   * Sets all tracking state from authoritative data, then enables event detection.
   */
  private establishBaseline(): void {
    if (!this.status) return;
    const ms = this.status.machine_status;
    const ps = this.status.print_status;
    const ext = this.status.extruder;

    this.lastMachineStatus = ms?.status ?? -1;
    this.lastSubStatus = ms?.sub_status ?? -1;
    this.lastExceptions = [...(ms?.exception_status ?? [])];
    this.wasFilamentDetected = !!ext?.filament_detected;

    if (this.lastMachineStatus === 2) {
      const progress = ms.progress ?? 0;
      this.lastProgressNotified = Math.floor(progress / this.progressInterval) * this.progressInterval;
      this.totalLayers = ps?.total_layer ?? 0;
      if (ps?.filename) {
        this.bridge.sendCommand(1046, { filename: ps.filename });
      }
      console.log(`[StateStore] Baseline from full status — printing at ${progress}%, no false events`);
    } else {
      console.log(`[StateStore] Baseline from full status — idle (status ${this.lastMachineStatus})`);
    }

    this.trackLayerChange(ps?.current_layer);
    this.baselineReady = true;
  }

  /** Update tracking state silently (before baseline is ready) */
  private updateTrackingState(): void {
    if (!this.status) return;
    const ms = this.status.machine_status;
    const ps = this.status.print_status;
    // Just track layer changes, don't emit any events
    this.trackLayerChange(ps?.current_layer);
  }

  /** Detect state transitions and emit print events */
  private detectEvents(): void {
    if (!this.status || !this.baselineReady) {
      // Before baseline is ready, just silently update tracking state
      this.updateTrackingState();
      return;
    }

    const ms = this.status.machine_status;
    const ps = this.status.print_status;
    const ext = this.status.extruder;

    const machineStatus = ms?.status ?? -1;
    const subStatus = ms?.sub_status ?? -1;

    let printEnded = false;

    // Print started
    if (machineStatus === 2 && this.lastMachineStatus !== 2) {
      this.lastProgressNotified = -1;
      this.totalLayers = ps?.total_layer ?? 0;
      // Reset layer tracking for new print
      this.layerTimes = [];
      this._lastLayer = 0;
      this._lastLayerTime = 0;
      if (ps?.filename) {
        this.bridge.sendCommand(1046, { filename: ps.filename });
      }
      this.emit('print_event', {
        type: 'print_started',
        filename: ps?.filename ?? 'unknown',
      } satisfies PrintEvent);
    }

    // Print completed
    if (subStatus === 2077 && this.lastSubStatus !== 2077) {
      this.emit('print_event', {
        type: 'print_completed',
        filename: ps?.filename ?? 'unknown',
        duration: ps?.print_duration ?? 0,
      } satisfies PrintEvent);
      this.lastProgressNotified = -1;
      printEnded = true;
    }

    // Print stopped/failed
    if ((subStatus === 2503 || subStatus === 2504) &&
        this.lastSubStatus !== 2503 && this.lastSubStatus !== 2504) {
      const reason = SUB_STATUS_NAMES[subStatus] || `Sub-status ${subStatus}`;
      this.emit('print_event', {
        type: 'print_failed',
        filename: ps?.filename ?? 'unknown',
        reason,
      } satisfies PrintEvent);
      this.lastProgressNotified = -1;
      printEnded = true;
    }

    // Progress at configured intervals (skip if print just ended this cycle)
    if (!printEnded && machineStatus === 2 && ps) {
      const progress = ms.progress ?? 0;
      const nextThreshold = this.lastProgressNotified + this.progressInterval;
      if (progress >= nextThreshold && progress < 100) {
        const notifyAt = Math.floor(progress / this.progressInterval) * this.progressInterval;
        if (notifyAt > this.lastProgressNotified) {
          console.log(`[StateStore] Progress ${progress}% → notify at ${notifyAt}% (next threshold was ${nextThreshold}%)`);
          this.lastProgressNotified = notifyAt;
          this.emit('print_event', {
            type: 'print_progress',
            filename: ps.filename ?? 'unknown',
            progress: notifyAt,
            layer: ps.current_layer ?? 0,
            totalLayers: this.totalLayers || ps.total_layer || 0,
            remaining: ps.remaining_time_sec ?? 0,
          } satisfies PrintEvent);
        }
      }
    }

    // Exceptions
    const exceptions = ms?.exception_status ?? [];
    const newExceptions = exceptions.filter((e: number) => !this.lastExceptions.includes(e));
    if (newExceptions.length > 0) {
      const names = newExceptions.map((code: number) => EXCEPTION_NAMES[code] || `Unknown (${code})`);
      this.emit('print_event', { type: 'error', codes: newExceptions, names } satisfies PrintEvent);

      if (newExceptions.includes(109) || newExceptions.includes(1211)) {
        this.emit('print_event', { type: 'filament_runout' } satisfies PrintEvent);
      }
    }

    // Filament runout from sensor
    if (ext && ext.filament_detect_enable) {
      if (!ext.filament_detected && this.wasFilamentDetected) {
        this.emit('print_event', { type: 'filament_runout' } satisfies PrintEvent);
      }
      this.wasFilamentDetected = !!ext.filament_detected;
    }

    this.lastMachineStatus = machineStatus;
    this.lastSubStatus = subStatus;
    this.lastExceptions = [...exceptions];

    // Track layer changes for layer time chart
    this.trackLayerChange(ps?.current_layer);
  }

  private trackLayerChange(layer: number | undefined): void {
    if (layer == null || layer <= 0) return;
    const now = Date.now();
    if (layer !== this._lastLayer) {
      if (this._lastLayer > 0 && this._lastLayerTime > 0) {
        const durationSec = (now - this._lastLayerTime) / 1000;
        this.layerTimes.push({ layer: this._lastLayer, duration: durationSec, timestamp: now });
        if (this.layerTimes.length > 2000) this.layerTimes.shift();
      }
      this._lastLayer = layer;
      this._lastLayerTime = now;
    }
  }

  /** Get human-readable status summary (used by Telegram) */
  getStatusSummary(): string {
    const esc = (text: string) => text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
    const s = this.status;
    if (!s) return 'Printer status unknown \\(not connected\\)';

    const ms = s.machine_status;
    const ps = s.print_status;

    const statusName = STATUS_NAMES[ms?.status ?? 0] || 'Unknown';
    const subName = SUB_STATUS_NAMES[ms?.sub_status ?? 0] || '';
    const speedName = SPEED_MODE_NAMES[s.gcode_move?.speed_mode ?? 1] || '';

    let summary = `*Status:* ${esc(statusName)}`;
    if (subName) summary += ` — ${esc(subName)}`;
    summary += '\n';

    summary += `🌡 *Nozzle:* ${s.extruder?.temperature ?? '?'}°C`;
    if (s.extruder?.target) summary += ` → ${s.extruder.target}°C`;
    summary += '\n';
    summary += `🌡 *Bed:* ${s.heater_bed?.temperature ?? '?'}°C`;
    if (s.heater_bed?.target) summary += ` → ${s.heater_bed.target}°C`;
    summary += '\n';
    if (s.ztemperature_sensor?.temperature) {
      summary += `🌡 *Chamber:* ${s.ztemperature_sensor.temperature}°C\n`;
    }

    if (ms?.status === 2 && ps) {
      const progress = ms.progress ?? 0;
      const remaining = ps.remaining_time_sec ?? 0;
      const h = Math.floor(remaining / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      const tl = this.totalLayers || ps.total_layer || 0;
      summary += `\n📄 *File:* ${esc(ps.filename || '?')}\n`;
      summary += `📊 *Progress:* ${progress}%\n`;
      summary += `📐 *Layer:* ${ps.current_layer ?? '?'}`;
      if (tl) summary += ` of ${tl}`;
      summary += '\n';
      summary += `⏱ *Remaining:* ${h}h ${m}m\n`;
      summary += `⚡ *Speed:* ${esc(speedName)}\n`;
    }

    if (s.fans) {
      const partFan = Math.round((s.fans.fan?.speed ?? 0) / 255 * 100);
      const auxFan = Math.round((s.fans.aux_fan?.speed ?? 0) / 255 * 100);
      summary += `\n🌀 *Part fan:* ${partFan}%  *Aux fan:* ${auxFan}%\n`;
    }

    const exceptions = ms?.exception_status ?? [];
    if (exceptions.length > 0) {
      const names = exceptions.map((c: number) => EXCEPTION_NAMES[c] || `Code ${c}`);
      summary += `\n⚠️ *Errors:* ${esc(names.join(', '))}\n`;
    }

    return summary;
  }
}
