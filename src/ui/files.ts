import type { PrinterState } from '../printer-state';
import type { CC2MqttClient } from '../mqtt-client';
import { $, escapeHtml, escapeAttr, formatTime } from './helpers';

let currentSource: 'local' | 'u_disk' = 'local';

export function renderFiles(state: PrinterState, client: CC2MqttClient): void {
  const container = $('file-list');
  const files = state.files;

  if (!files.length) {
    container.innerHTML = `<div class="file-empty">No files on ${currentSource === 'u_disk' ? 'USB drive' : 'printer'}</div>`;
    return;
  }

  let html = '';
  for (const file of files) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    const timeInfo = file.print_time ? formatTime(file.print_time) : '';
    const layerInfo = file.layer ? `${file.layer} layers` : '';
    const meta = [sizeMB + ' MB', timeInfo, layerInfo].filter(Boolean).join(' · ');
    const isFolder = file.type === 'folder';
    html += `
      <div class="file-item" data-filename="${escapeAttr(file.filename)}" data-type="${isFolder ? 'folder' : 'file'}">
        <div class="file-icon">${isFolder ? '📁' : '📄'}</div>
        <div class="file-details">
          <div class="file-name">${escapeHtml(file.filename)}</div>
          <div class="file-size">${meta}</div>
        </div>
        ${isFolder ? '' : `<button class="btn btn-sm btn-primary file-print-btn">Print</button>`}
      </div>`;
  }

  container.innerHTML = html;

  container.querySelectorAll('.file-print-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.file-item') as HTMLElement;
      const filename = item?.dataset.filename;
      if (filename && confirm(`Start printing ${filename}?`)) {
        client.sendCommand(1020, {
          storage_media: currentSource,
          filename,
          config: {
            delay_video: false,
            printer_check: true,
            print_layout: 'A',
            bedlevel_force: false,
            slot_map: [],
          },
        });
      }
    });
  });
}

let fileControlsBound = false;

export function bindFileControls(client: CC2MqttClient): void {
  if (fileControlsBound) return;
  fileControlsBound = true;

  document.querySelectorAll('.file-source-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const source = (tab as HTMLElement).dataset.source as 'local' | 'u_disk';
      currentSource = source;
      document.querySelectorAll('.file-source-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $('file-list').innerHTML = '<div class="loading">Loading...</div>';
      client.sendCommand(1044, { storage_media: source, dir: '/', offset: 0, limit: 50 });
    });
  });
}
