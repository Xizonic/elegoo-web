import type { PrinterState } from '../printer-state';
import type { CC2MqttClient } from '../mqtt-client';
import { $, escapeHtml, escapeAttr } from './helpers';

export function renderFiles(state: PrinterState, client: CC2MqttClient): void {
  const container = $('file-list');
  const files = state.files;

  if (!files.length) {
    container.innerHTML = '<div class="file-empty">No files on printer</div>';
    return;
  }

  let html = '';
  for (const file of files) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    html += `
      <div class="file-item" data-filename="${escapeAttr(file.name)}">
        <div class="file-icon">📄</div>
        <div class="file-details">
          <div class="file-name">${escapeHtml(file.name)}</div>
          <div class="file-size">${sizeMB} MB</div>
        </div>
        <button class="btn btn-sm btn-primary file-print-btn">Print</button>
      </div>`;
  }

  container.innerHTML = html;

  container.querySelectorAll('.file-print-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.file-item') as HTMLElement;
      const filename = item?.dataset.filename;
      if (filename && confirm(`Start printing ${filename}?`)) {
        client.sendCommand(1020, {
          storage_media: 'local',
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
