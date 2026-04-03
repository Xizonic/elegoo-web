import type { PrinterState } from '../printer-state';
import type { CC2MqttClient } from '../mqtt-client';
import { STATUS_NAMES, SUB_STATUS_NAMES } from '../types';
import { $, formatTime, fanPct } from './helpers';

let lastThumbnailFile = '';

function updateFan(prefix: string, speed: number, toggleId: string): void {
  const pct = fanPct(speed);
  ($(`${prefix}-bar`) as HTMLElement).style.width = `${pct}%`;
  $(`${prefix}-value`).textContent = `${pct}%`;
  ($(toggleId) as HTMLInputElement).checked = speed > 0;
}

function updateCamera(hasCamera: boolean, printerIp: string): void {
  const img = $('camera-feed') as HTMLImageElement;
  const overlay = $('camera-overlay');

  if (hasCamera) {
    const src = `http://${printerIp}:8080/?action=stream`;
    if (img.src !== src) {
      img.src = src;
    }
    overlay.classList.add('hidden');
    img.classList.remove('hidden');
  } else {
    img.classList.add('hidden');
    overlay.classList.remove('hidden');
    overlay.textContent = 'Camera not connected';
  }
}

export function renderDashboard(state: PrinterState, client: CC2MqttClient): void {
  const s = state.status;
  if (!s) return;

  const machineStatus = s.machine_status;
  const ps = s.print_status;
  const isPrinting = machineStatus?.status === 2;
  const isPaused = machineStatus?.sub_status === 2502 || machineStatus?.sub_status === 2505;
  const statusName = STATUS_NAMES[machineStatus?.status] ?? 'Unknown';
  const subStatusName = SUB_STATUS_NAMES[machineStatus?.sub_status] ?? '';

  // Thumbnail — request once per file, don't retry on failure
  if (ps?.filename && ps.filename !== lastThumbnailFile) {
    lastThumbnailFile = ps.filename;
    state.thumbnail = null;
    state.thumbnailFailed = false;
    client.sendCommand(1045, { storage_media: 'local', file_name: ps.filename });
    client.sendCommand(1046, { storage_media: 'local', filename: ps.filename });
  }

  // Show thumbnail
  const thumbImg = $('print-thumbnail') as HTMLImageElement;
  const thumbPlaceholder = $('print-thumbnail-placeholder');
  if (state.thumbnail) {
    thumbImg.src = `data:image/png;base64,${state.thumbnail}`;
    thumbImg.classList.remove('hidden');
    thumbPlaceholder.classList.add('hidden');
  } else {
    thumbImg.classList.add('hidden');
    thumbPlaceholder.classList.remove('hidden');
    thumbPlaceholder.textContent = state.thumbnailFailed ? 'No preview' : '🖨️';
  }

  // Print filename
  if (ps?.filename) {
    $('print-filename').textContent = ps.filename;
    $('print-filename').title = ps.filename;
  } else {
    $('print-filename').textContent = statusName + (subStatusName ? ` — ${subStatusName}` : '');
  }

  // Status badge
  const badge = $('print-status-badge');
  if (isPrinting && !isPaused) {
    badge.textContent = '⟳ Printing';
    badge.className = 'print-status-badge badge-printing';
  } else if (isPaused) {
    badge.textContent = '⏸ Paused';
    badge.className = 'print-status-badge badge-paused';
  } else {
    badge.textContent = statusName;
    badge.className = 'print-status-badge badge-idle';
  }

  // Progress
  const progress = machineStatus?.progress ?? 0;
  $('print-progress-text').textContent = isPrinting || isPaused ? `${progress}%` : '';
  ($('print-progress-bar') as HTMLElement).style.width = `${progress}%`;

  // Layer info — use fileTotalLayers from method 1046 or fallback to print_status
  const totalLayer = ps?.total_layer ?? state.fileTotalLayers ?? '??';
  const currentLayer = ps?.current_layer ?? '--';
  $('print-layer').textContent = `Layer Progress: ${currentLayer}/${totalLayer}`;

  // Remaining time with dash prefix like Elegoo app
  const remaining = formatTime(ps?.remaining_time_sec);
  $('print-remaining').textContent = remaining !== '--' ? `—${remaining}` : '--';

  // Print action buttons
  $('btn-pause').classList.toggle('hidden', !isPrinting || isPaused);
  $('btn-resume').classList.toggle('hidden', !isPaused);
  $('btn-stop').classList.toggle('hidden', !isPrinting && !isPaused);

  // Temperatures (show 2 decimal places like Elegoo app)
  const ext = s.extruder;
  if (ext) {
    $('temp-nozzle').textContent = ext.temperature.toFixed(2);
    $('temp-nozzle-target').textContent = Math.round(ext.target).toString();
    const nozzlePct = ext.target > 0 ? Math.min(100, (ext.temperature / ext.target) * 100) : 0;
    ($('temp-nozzle-bar') as HTMLElement).style.width = `${nozzlePct}%`;
    const nozzleBar = $('temp-nozzle-bar') as HTMLElement;
    nozzleBar.classList.toggle('heating', ext.temperature < ext.target - 2 && ext.target > 0);
    nozzleBar.classList.toggle('at-target', Math.abs(ext.temperature - ext.target) <= 2 && ext.target > 0);
  }

  const bed = s.heater_bed;
  if (bed) {
    $('temp-bed').textContent = bed.temperature.toFixed(2);
    $('temp-bed-target').textContent = Math.round(bed.target).toString();
    const bedPct = bed.target > 0 ? Math.min(100, (bed.temperature / bed.target) * 100) : 0;
    ($('temp-bed-bar') as HTMLElement).style.width = `${bedPct}%`;
    const bedBar = $('temp-bed-bar') as HTMLElement;
    bedBar.classList.toggle('heating', bed.temperature < bed.target - 2 && bed.target > 0);
    bedBar.classList.toggle('at-target', Math.abs(bed.temperature - bed.target) <= 2 && bed.target > 0);
  }

  const chamber = s.ztemperature_sensor;
  if (chamber) {
    $('temp-chamber').textContent = chamber.temperature.toFixed(2);
  }

  // Position
  const pos = s.gcode_move;
  if (pos) {
    $('pos-x').textContent = pos.x?.toFixed(1) ?? '--';
    $('pos-y').textContent = pos.y?.toFixed(1) ?? '--';
    $('pos-z').textContent = pos.z?.toFixed(1) ?? '--';
  }

  // Fans — use Elegoo naming (Model/Assistance/Case)
  const fans = s.fans;
  if (fans) {
    updateFan('fan-model', fans.fan?.speed ?? 0, 'fan-model-toggle');
    updateFan('fan-aux', fans.aux_fan?.speed ?? 0, 'fan-aux-toggle');
    updateFan('fan-case', fans.box_fan?.speed ?? 0, 'fan-case-toggle');
  }

  // Speed mode buttons
  const speedMode = pos?.speed_mode ?? 1;
  document.querySelectorAll('.speed-btn').forEach(btn => {
    const mode = parseInt((btn as HTMLElement).dataset.mode ?? '1');
    btn.classList.toggle('active', mode === speedMode);
  });

  // LED toggle
  const ledOn = s.led?.status === 1;
  ($('led-toggle') as HTMLInputElement).checked = ledOn;

  // Camera
  updateCamera(s.external_device?.camera ?? false, client.printerIp);
}

export function renderHeader(state: PrinterState): void {
  const attrs = state.attributes;
  if (attrs) {
    $('printer-name').textContent = `${attrs.hostname} (${attrs.machine_model}) — FW ${attrs.software_version?.ota_version}`;
  }
}
