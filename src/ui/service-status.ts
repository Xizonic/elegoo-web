/** Service status panel — shows health of all backend services */

import { $ } from './helpers';

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

  // MQTT display value
  let mqttLabel = s.mqtt;
  if (s.mqtt === 'broker_only') mqttLabel = 'registering...';

  // Printer firmware unresponsive banner
  const showFirmwareWarning = s.mqtt === 'broker_only' && s.mqttRegisterAttempts >= 3;
  const firmwareBanner = showFirmwareWarning
    ? `<div class="svc-firmware-warning">
        ⚠️ <strong>Printer firmware is not responding.</strong>
        MQTT broker is reachable but the printer won't accept registration
        (${s.mqttRegisterAttempts} attempts). Try power-cycling the printer.
      </div>`
    : '';

  container.innerHTML = `
    ${firmwareBanner}
    <div class="svc-grid">
      <div class="svc-item">
        ${statusDot(s.mqtt, ['connected'])}
        <span class="svc-label">MQTT</span>
        <span class="svc-value">${mqttLabel}</span>
      </div>
      <div class="svc-item">
        ${statusDot(s.telegram, ['running'])}
        <span class="svc-label">Telegram</span>
        <span class="svc-value">${s.telegram}</span>
      </div>
      <div class="svc-item">
        ${statusDot(s.ai, ['monitoring', 'idle'])}
        <span class="svc-label">AI</span>
        <span class="svc-value">${s.ai}</span>
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
