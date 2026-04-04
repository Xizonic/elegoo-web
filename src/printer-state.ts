import type { PrinterAttributes, PrinterStatus, CanvasInfo, FileEntry } from './types';

export type StateListener = () => void;

/** Deep-merge delta updates into base state */
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

export class PrinterState {
  attributes: PrinterAttributes | null = null;
  status: PrinterStatus | null = null;
  canvas: CanvasInfo | null = null;
  files: FileEntry[] = [];
  thumbnail: string | null = null; // base64 PNG
  thumbnailFailed = false; // true when printer returns error (e.g. no embedded thumbnail)
  fileTotalLayers: number | null = null;
  systemInfo: Record<string, unknown> | null = null;
  /** Layer timing: records [layer, durationSec] for each completed layer */
  layerTimes: Array<{ layer: number; duration: number; timestamp: number }> = [];
  private _lastLayer = 0;
  private _lastLayerTime = 0;
  timelapseList: Record<string, unknown>[] = [];
  videoUrl: string | null = null;
  bedMesh: number[][] | null = null;
  private listeners: StateListener[] = [];

  subscribe(listener: StateListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  setAttributes(data: PrinterAttributes): void {
    this.attributes = data;
    this.notify();
  }

  setFullStatus(data: PrinterStatus): void {
    this.status = data;
    this.trackLayerChange(data.print_status?.current_layer);
    this.notify();
  }

  applyDelta(data: Record<string, unknown>): void {
    if (!this.status) {
      this.status = data as unknown as PrinterStatus;
    } else {
      this.status = deepMerge(
        this.status as unknown as Record<string, unknown>,
        data
      ) as unknown as PrinterStatus;
    }

    // Track layer changes for layer-time chart
    const ps = (data as Record<string, unknown>).print_status as Record<string, unknown> | undefined;
    if (ps?.current_layer != null) {
      this.trackLayerChange(ps.current_layer as number);
    }

    // Capture bed mesh data if present
    const meshData = (data.bed_mesh ?? data.bed_level_info) as Record<string, unknown> | undefined;
    if (meshData) {
      const probed = (meshData.probed_matrix ?? meshData.mesh_matrix ?? meshData.data) as number[][] | undefined;
      if (probed && Array.isArray(probed) && probed.length > 0) {
        this.bedMesh = probed;
      }
    }

    this.notify();
  }

  setCanvas(data: CanvasInfo): void {
    this.canvas = data;
    this.notify();
  }

  setFiles(files: FileEntry[]): void {
    this.files = files;
    this.notify();
  }

  /** Handle a method response from the printer */
  handleResponse(method: number, data: Record<string, unknown>): void {
    const result = data.result as Record<string, unknown> | undefined;
    if (!result) return;

    switch (method) {
      case 1001: // GET_ATTRIBUTES
        this.setAttributes(result as unknown as PrinterAttributes);
        break;
      case 1002: // GET_STATUS
        this.setFullStatus(result as unknown as PrinterStatus);
        break;
      case 2005: { // GET_CANVAS_STATUS
        const canvasInfo = result.canvas_info as CanvasInfo | undefined;
        if (canvasInfo) {
          this.setCanvas(canvasInfo);
        }
        break;
      }
      case 1044: { // GET_FILE_LIST
        const fileList = result.file_list as FileEntry[] | undefined;
        if (fileList) {
          this.setFiles(fileList);
        }
        break;
      }
      case 1045: { // GET_FILE_THUMBNAIL
        const errorCode = result.error_code as number | undefined;
        const thumb = result.thumbnail as string | undefined;
        if (thumb && errorCode === 0) {
          this.thumbnail = thumb;
          this.thumbnailFailed = false;
        } else {
          this.thumbnailFailed = true;
        }
        this.notify();
        break;
      }
      case 1046: { // GET_FILE_DETAIL
        const layers = (result.TotalLayers ?? result.layer ?? result.total_layer) as number | undefined;
        if (layers != null) {
          this.fileTotalLayers = layers;
          this.notify();
        }
        break;
      }
      case 1062: { // GET_SYSTEM_INFO
        const errorCode = result.error_code as number | undefined;
        if (errorCode === 0) {
          const info = { ...result };
          delete info.error_code;
          this.systemInfo = info;
          this.notify();
        }
        break;
      }
      case 1050: { // GET_VIDEO_URL
        const errorCode = result.error_code as number | undefined;
        const url = result.url as string | undefined;
        if (errorCode === 0 && url) {
          this.videoUrl = url;
          this.notify();
        }
        break;
      }
      case 1051: { // GET_TIMELAPSE
        const errorCode = result.error_code as number | undefined;
        const list = result.file_list as Record<string, unknown>[] | undefined;
        if (errorCode === 0 && list) {
          this.timelapseList = list;
          this.notify();
        }
        break;
      }
    }
  }

  private trackLayerChange(layer: number | undefined): void {
    if (layer == null || layer <= 0) return;
    const now = Date.now();
    if (layer !== this._lastLayer) {
      if (this._lastLayer > 0 && this._lastLayerTime > 0) {
        const durationSec = (now - this._lastLayerTime) / 1000;
        this.layerTimes.push({ layer: this._lastLayer, duration: durationSec, timestamp: now });
        // Keep max 2000 entries
        if (this.layerTimes.length > 2000) this.layerTimes.shift();
      }
      this._lastLayer = layer;
      this._lastLayerTime = now;
    }
  }

  /** Getters for persistence */
  getLastLayer(): number { return this._lastLayer; }
  getLastLayerTime(): number { return this._lastLayerTime; }

  /** Restore layer data from persistence */
  restoreLayerData(
    layerTimes: Array<{ layer: number; duration: number; timestamp: number }>,
    lastLayer: number,
    lastLayerTime: number,
  ): void {
    this.layerTimes = layerTimes;
    this._lastLayer = lastLayer;
    this._lastLayerTime = lastLayerTime;
  }

  /** Handle a status event (delta update) */
  handleStatusEvent(data: Record<string, unknown>): void {
    const result = data.result as Record<string, unknown> | undefined;
    if (result) {
      this.applyDelta(result);
    }
  }
}
