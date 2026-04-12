/** Service status — compact header badge with click-to-expand dropdown + system info */

import { $, escapeHtml } from './helpers';
import type { PrinterState } from '../printer-state';

export interface ServiceStatus {
  uptime: number;
  mqtt: string;
  mqttRegisterAttempts: number;
  printerSn: string | null;
  printerIp: string;
  wsClients: number;
  telegram: string;
  ai: string;
  camera: string;
}

interface ServiceCheck {
  label: string;
  state: string;
  okValues: string[];
}

let lastStatus: ServiceStatus | null = null;
let dropdownBound = false;

export function updateServiceStatus(data: Record<string, unknown>): void {
  lastStatus = data as unknown as ServiceStatus;
  renderServiceStatus();
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function isOk(state: string, okValues: string[]): boolean {
  return okValues.includes(state);
}

function dotHtml(ok: boolean): string {
  return `<span class="status-dot ${ok ? 'status-dot-ok' : 'status-dot-err'}"></span>`;
}

export function renderServiceStatus(): void {
  const badge = $('svc-header-badge');
  const dotsEl = $('svc-header-dots');
  const countEl = $('svc-header-count');
  const dropdown = $('service-status');

  if (!badge || !dotsEl || !countEl) return;

  // Bind dropdown toggle once
  if (!dropdownBound) {
    dropdownBound = true;
    const wrap = $('svc-header-wrap');
    const dd = $('svc-dropdown');
    if (wrap && dd) {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        dd.classList.toggle('hidden');
      });
      document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target as Node)) dd.classList.add('hidden');
      });
    }
  }

  if (!lastStatus) {
    dotsEl.innerHTML = '';
    countEl.textContent = '--';
    if (dropdown) dropdown.innerHTML = '<div class="svc-loading">Waiting for service...</div>';
    return;
  }

  const s = lastStatus;

  // Define all services for health check
  const checks: ServiceCheck[] = [
    { label: 'MQTT', state: s.mqtt, okValues: ['connected'] },
    { label: 'Telegram', state: s.telegram, okValues: ['running'] },
    { label: 'AI', state: s.ai, okValues: ['monitoring', 'idle'] },
    { label: 'Camera', state: s.camera, okValues: ['available'] },
    { label: 'Printer', state: s.printerSn ? 'ok' : 'err', okValues: ['ok'] },
  ];

  const healthy = checks.filter(c => isOk(c.state, c.okValues)).length;
  const total = checks.length;

  // Header badge: colored dots + count
  const allOk = healthy === total;
  dotsEl.innerHTML = checks.map(c => dotHtml(isOk(c.state, c.okValues))).join('');
  countEl.textContent = `${healthy}/${total}`;
  badge.classList.toggle('svc-all-ok', allOk);
  badge.classList.toggle('svc-has-err', !allOk);

  // Dropdown detail
  if (!dropdown) return;

  let mqttLabel = s.mqtt;
  if (s.mqtt === 'broker_only') mqttLabel = 'registering...';

  const showFirmwareWarning = s.mqtt === 'broker_only' && s.mqttRegisterAttempts >= 3;
  const firmwareBanner = showFirmwareWarning
    ? `<div class="svc-firmware-warning">
        ⚠️ <strong>Firmware not responding</strong> — ${s.mqttRegisterAttempts} registration attempts. Try power-cycling.
      </div>`
    : '';

  dropdown.innerHTML = `
    ${firmwareBanner}
    <div class="svc-list">
      <div class="svc-item">${dotHtml(isOk(s.mqtt, ['connected']))}<span class="svc-label">MQTT</span><span class="svc-value">${mqttLabel}</span></div>
      <div class="svc-item">${dotHtml(isOk(s.telegram, ['running']))}<span class="svc-label">Telegram</span><span class="svc-value">${s.telegram}</span></div>
      <div class="svc-item">${dotHtml(isOk(s.ai, ['monitoring', 'idle']))}<span class="svc-label">AI</span><span class="svc-value">${s.ai}</span></div>
      <div class="svc-item">${dotHtml(isOk(s.camera, ['available']))}<span class="svc-label">Camera</span><span class="svc-value">${s.camera}</span></div>
      <div class="svc-item">${dotHtml(!!s.printerSn)}<span class="svc-label">Printer</span><span class="svc-value">${s.printerSn || 'unknown'}</span></div>
      <div class="svc-item">${dotHtml(true)}<span class="svc-label">WS Clients</span><span class="svc-value">${s.wsClients}</span></div>
      <div class="svc-item">${dotHtml(true)}<span class="svc-label">Uptime</span><span class="svc-value">${formatUptime(s.uptime)}</span></div>
    </div>
  `;
}

/* ─── System Info (rendered into dropdown) ─── */

let lastSysKey = '';

export function renderSystemInfo(state: PrinterState): void {
  const container = $('system-info');
  if (!container) return;

  const attrs = state.attributes;
  const sysInfo = state.systemInfo;

  if (!attrs && !sysInfo) return;

  const key = JSON.stringify([attrs?.sn, attrs?.software_version?.ota_version, sysInfo]);
  if (key === lastSysKey) return;
  lastSysKey = key;

  const rows: [string, string][] = [];

  if (attrs) {
    rows.push(['Hostname', attrs.hostname]);
    rows.push(['Model', attrs.machine_model]);
    rows.push(['Serial', attrs.sn]);
    rows.push(['IP', attrs.ip]);
    if (attrs.software_version) {
      rows.push(['OTA Version', attrs.software_version.ota_version]);
      rows.push(['MCU Version', attrs.software_version.mcu_version]);
      rows.push(['SoC Version', attrs.software_version.soc_version]);
    }
    if (attrs.hardware_version) {
      rows.push(['Hardware', attrs.hardware_version]);
    }
    if (attrs.protocol_version) {
      rows.push(['Protocol', attrs.protocol_version]);
    }
  }

  if (sysInfo) {
    for (const [k, v] of Object.entries(sysInfo)) {
      if (typeof v === 'string' || typeof v === 'number') {
        const label = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        rows.push([label, String(v)]);
      }
    }
  }

  let html = '<div class="svc-list">';
  for (const [label, value] of rows) {
    html += `<div class="svc-item"><span class="svc-label">${escapeHtml(label)}</span><span class="svc-value">${escapeHtml(value)}</span></div>`;
  }
  html += '</div>';

  container.innerHTML = html;
}
