/** Service status panel — shows health of all backend services */

import { $ } from './helpers';

export interface ServiceStatus {
  uptime: number;
  mqtt: string;
  printerSn: string | null;
  printerIp: string;
  wsClients: number;
  telegram: string;
  camera: string;
}

let lastStatus: ServiceStatus | null = null;

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

function statusDot(state: string, okValues: string[]): string {
  const isOk = okValues.includes(state);
  const cls = isOk ? 'status-dot-ok' : 'status-dot-err';
  return `<span class="status-dot ${cls}"></span>`;
}

export function renderServiceStatus(): void {
  const container = $('service-status');
  if (!container) return;

  if (!lastStatus) {
    container.innerHTML = '<div class="svc-loading">Waiting for service...</div>';
    return;
  }

  const s = lastStatus;
  container.innerHTML = `
    <div class="svc-grid">
      <div class="svc-item">
        ${statusDot(s.mqtt, ['connected'])}
        <span class="svc-label">MQTT</span>
        <span class="svc-value">${s.mqtt}</span>
      </div>
      <div class="svc-item">
        ${statusDot(s.telegram, ['running'])}
        <span class="svc-label">Telegram</span>
        <span class="svc-value">${s.telegram}</span>
      </div>
      <div class="svc-item">
        ${statusDot(s.camera, ['available'])}
        <span class="svc-label">Camera</span>
        <span class="svc-value">${s.camera}</span>
      </div>
      <div class="svc-item">
        ${statusDot('ok', ['ok'])}
        <span class="svc-label">WS Clients</span>
        <span class="svc-value">${s.wsClients}</span>
      </div>
      <div class="svc-item">
        ${statusDot('ok', ['ok'])}
        <span class="svc-label">Uptime</span>
        <span class="svc-value">${formatUptime(s.uptime)}</span>
      </div>
      <div class="svc-item">
        ${statusDot(s.printerSn ? 'ok' : 'err', ['ok'])}
        <span class="svc-label">Printer</span>
        <span class="svc-value">${s.printerSn || 'unknown'}</span>
      </div>
    </div>
  `;
}
