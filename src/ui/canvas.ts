import type { PrinterState } from '../printer-state';
import { $, escapeHtml, escapeAttr } from './helpers';

export function renderCanvas(state: PrinterState): void {
  const container = $('canvas-status');
  const canvas = state.canvas;

  if (!canvas || !canvas.canvas_list?.length) {
    container.innerHTML = '<div class="canvas-empty">No Canvas/AMS detected</div>';
    return;
  }

  let html = '';
  for (const unit of canvas.canvas_list) {
    html += `<div class="canvas-unit">`;
    html += `<div class="canvas-unit-header">Canvas ${unit.canvas_id + 1} ${unit.connected ? '🟢' : '🔴'}</div>`;
    html += `<div class="tray-list">`;

    for (const tray of unit.tray_list) {
      const isActive = unit.canvas_id === canvas.active_canvas_id &&
        tray.tray_id === canvas.active_tray_id;
      const statusClass = tray.status === 2 ? 'active' : tray.status === 1 ? 'loaded' : 'empty';

      html += `
        <div class="tray-slot ${statusClass} ${isActive ? 'current' : ''}">
          <div class="tray-spool">
            <div class="tray-color" style="background-color: ${escapeAttr(tray.filament_color)}"></div>
            <div class="tray-hole"></div>
          </div>
          <div class="tray-type">${escapeHtml(tray.filament_type)}</div>
          <div class="tray-number">${tray.tray_id + 1}</div>
        </div>`;
    }

    html += `</div></div>`;
  }

  html += `<div class="canvas-meta">Auto-refill: ${canvas.auto_refill ? 'On' : 'Off'}</div>`;
  container.innerHTML = html;
}
