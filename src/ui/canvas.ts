import type { PrinterState } from '../printer-state';
import type { CommandSender } from '../ws-client';
import { $, escapeHtml, escapeAttr } from './helpers';
import { openFilamentEditor } from './filament-editor';

let canvasClient: CommandSender | null = null;

export function setCanvasClient(client: CommandSender): void {
  canvasClient = client;
}

export function renderCanvas(state: PrinterState): void {
  const container = $('canvas-status');
  const canvas = state.canvas;

  if (!canvas || !canvas.canvas_list?.length) {
    // Show mono filament info if available (printers without Canvas/AMS)
    if (state.monoFilament) {
      renderMonoFilament(container, state.monoFilament);
    } else {
      container.innerHTML = '<div class="canvas-empty">No Canvas/AMS detected</div>';
    }
    return;
  }

  let html = '';
  for (const unit of canvas.canvas_list) {
    const connected = !!unit.connected;
    html += `<div class="canvas-unit ${connected ? '' : 'canvas-disconnected'}">`;
    html += `<div class="canvas-unit-header">Canvas ${unit.canvas_id + 1} ${connected ? '🟢 Connected' : '🔴 Disconnected'}</div>`;

    // Physical layout: 2×2 grid of spools inside a "device" frame
    html += `<div class="canvas-device">`;
    html += `<div class="canvas-hub">`;
    html += `<div class="canvas-hub-label">Canvas</div>`;
    html += `<div class="canvas-hub-tubes">`;
    for (const tray of unit.tray_list) {
      const color = `#${(tray.filament_color || '434343').replace(/^#/, '')}`;
      const isEmpty = tray.status === 0;
      html += `<div class="canvas-tube" style="background: ${isEmpty ? '#434343' : escapeAttr(color)}"></div>`;
    }
    html += `</div></div>`;

    html += `<div class="canvas-spools">`;
    // Physical layout is CCW from top-left: 0=TL, 1=BL, 2=BR, 3=TR
    // CSS grid fills row-major: pos0=TL, pos1=TR, pos2=BL, pos3=BR
    // Reorder: grid[0]=tray0, grid[1]=tray3, grid[2]=tray1, grid[3]=tray2
    const gridOrder = [0, 3, 1, 2];
    const orderedTrays = gridOrder
      .filter(i => i < unit.tray_list.length)
      .map(i => unit.tray_list[i]);
    for (const tray of orderedTrays) {
      const isActive = unit.canvas_id === canvas.active_canvas_id &&
        tray.tray_id === canvas.active_tray_id;
      const isEmpty = tray.status === 0;
      const color = `#${(tray.filament_color || '434343').replace(/^#/, '')}`;
      const statusClass = isActive ? 'spool-active' : isEmpty ? 'spool-empty' : 'spool-loaded';
      const typeLabel = tray.filament_type || (isEmpty ? '' : '?');
      const tempRange = (!isEmpty && tray.min_nozzle_temp) ?
        `${tray.min_nozzle_temp}–${tray.max_nozzle_temp}°C` : '';

      html += `<div class="canvas-spool-slot ${statusClass}" title="${escapeAttr(tray.filament_name || typeLabel)} — click to edit" data-canvas-id="${unit.canvas_id}" data-tray-id="${tray.tray_id}" data-type="${escapeAttr(tray.filament_type || '')}" data-color="${escapeAttr(tray.filament_color || '')}" data-brand="${escapeAttr(tray.brand || 'ELEGOO')}" data-name="${escapeAttr(tray.filament_name || '')}" data-min-temp="${tray.min_nozzle_temp || ''}" data-max-temp="${tray.max_nozzle_temp || ''}">`;
      html += `<div class="spool-number">${tray.tray_id + 1}</div>`;
      html += `<div class="spool-ring" style="border-color: ${isEmpty ? '#434343' : escapeAttr(color)}">`;
      html += `<div class="spool-fill" style="background: ${isEmpty ? 'transparent' : escapeAttr(color)}"></div>`;
      html += `<div class="spool-center"></div>`;
      if (isActive) {
        html += `<div class="spool-active-indicator"></div>`;
      }
      html += `</div>`;
      html += `<div class="spool-label">${escapeHtml(typeLabel)}</div>`;
      if (tempRange) {
        html += `<div class="spool-temp">${tempRange}</div>`;
      }
      html += `<div class="spool-actions">`;
      if (isActive) {
        html += `<button class="btn btn-sm btn-ghost spool-unload-btn" data-canvas-id="${unit.canvas_id}" data-tray-id="${tray.tray_id}">Unload</button>`;
      } else if (!isEmpty) {
        html += `<button class="btn btn-sm btn-primary spool-load-btn" data-canvas-id="${unit.canvas_id}" data-tray-id="${tray.tray_id}">Load</button>`;
      }
      html += `</div>`;
      html += `</div>`;
    }
    html += `</div>`; // canvas-spools

    // Extruder icon
    html += `<div class="canvas-extruder" title="Extruder">`;
    html += `<div class="extruder-icon">⬡</div>`;
    html += `</div>`;

    html += `</div>`; // canvas-device

    // Action bar
    html += `<div class="canvas-actions">`;
    html += `<label class="canvas-meta toggle-inline">Auto-refill: `;
    html += `<label class="toggle"><input type="checkbox" class="auto-refill-toggle" ${canvas.auto_refill ? 'checked' : ''}><span class="toggle-slider"></span></label>`;
    html += `</label>`;
    html += `</div>`;

    html += `</div>`; // canvas-unit
  }

  container.innerHTML = html;

  // Bind auto-refill toggles
  if (canvasClient) {
    container.querySelectorAll('.auto-refill-toggle').forEach(toggle => {
      toggle.addEventListener('change', () => {
        const on = (toggle as HTMLInputElement).checked;
        canvasClient!.sendCommand(2004, { auto_refill: on });
      });
    });

    // Bind spool click for filament editing
    container.querySelectorAll('.canvas-spool-slot').forEach(slot => {
      slot.addEventListener('click', (e) => {
        // Don't open editor when clicking load/unload buttons
        if ((e.target as HTMLElement).closest('.spool-load-btn, .spool-unload-btn')) return;
        const el = slot as HTMLElement;
        const canvasId = parseInt(el.dataset.canvasId ?? '0');
        const trayId = parseInt(el.dataset.trayId ?? '0');
        openFilamentEditor(canvasId, trayId, {
          type: el.dataset.type || 'PLA',
          color: el.dataset.color || '#ffffff',
          name: el.dataset.name || '',
          brand: el.dataset.brand || 'ELEGOO',
          minTemp: parseInt(el.dataset.minTemp || '190'),
          maxTemp: parseInt(el.dataset.maxTemp || '230'),
        }, canvasClient!);
      });
      (slot as HTMLElement).style.cursor = 'pointer';
    });

    // Bind load/unload buttons
    container.querySelectorAll('.spool-load-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const el = btn as HTMLElement;
        const canvasId = parseInt(el.dataset.canvasId ?? '0');
        const trayId = parseInt(el.dataset.trayId ?? '0');
        canvasClient!.sendCommand(2001, { canvas_id: canvasId, tray_id: trayId });
        // Refresh canvas state after a short delay
        setTimeout(() => canvasClient!.sendCommand(2005, {}), 1000);
      });
    });

    container.querySelectorAll('.spool-unload-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const el = btn as HTMLElement;
        const canvasId = parseInt(el.dataset.canvasId ?? '0');
        const trayId = parseInt(el.dataset.trayId ?? '0');
        canvasClient!.sendCommand(2002, { canvas_id: canvasId, tray_id: trayId });
        setTimeout(() => canvasClient!.sendCommand(2005, {}), 1000);
      });
    });
  }
}

function renderMonoFilament(container: HTMLElement, info: Record<string, unknown>): void {
  const type = (info.filament_type ?? info.type ?? '') as string;
  const color = (info.filament_color ?? info.color ?? '') as string;
  const name = (info.filament_name ?? info.name ?? '') as string;
  const minTemp = (info.min_nozzle_temp ?? info.minTemp ?? 0) as number;
  const maxTemp = (info.max_nozzle_temp ?? info.maxTemp ?? 0) as number;
  const brand = (info.brand ?? '') as string;

  const colorHex = color ? `#${color.replace(/^#/, '')}` : '#666';
  const label = name || type || 'Unknown';
  const tempRange = (minTemp && maxTemp) ? `${minTemp}–${maxTemp}°C` : '';
  const brandLabel = brand ? escapeHtml(brand) + ' ' : '';

  let html = '<div class="mono-filament">';
  html += '<div class="mono-filament-header">Direct Drive Filament</div>';
  html += '<div class="mono-filament-spool">';
  html += `<div class="spool-ring mono-spool-ring" style="border-color: ${escapeAttr(colorHex)}">`;
  html += `<div class="spool-fill" style="background: ${escapeAttr(colorHex)}"></div>`;
  html += `<div class="spool-center"></div>`;
  html += '</div>';
  html += `<div class="mono-filament-info">`;
  html += `<div class="mono-filament-type">${brandLabel}${escapeHtml(label)}</div>`;
  if (tempRange) html += `<div class="mono-filament-temp">${tempRange}</div>`;
  html += `</div>`;
  html += '</div>';

  // Show raw fields if we got unexpected structure (helps debug)
  const knownKeys = new Set(['filament_type', 'type', 'filament_color', 'color', 'filament_name', 'name', 'min_nozzle_temp', 'minTemp', 'max_nozzle_temp', 'maxTemp', 'brand', 'error_code']);
  const extra = Object.entries(info).filter(([k]) => !knownKeys.has(k));
  if (extra.length > 0 && !type && !name) {
    html += '<div class="mono-filament-raw">';
    for (const [k, v] of extra) {
      html += `<div class="mono-raw-field"><span>${escapeHtml(k)}:</span> ${escapeHtml(String(v))}</div>`;
    }
    html += '</div>';
  }

  html += '</div>';
  container.innerHTML = html;
}
