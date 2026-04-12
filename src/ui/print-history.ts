import type { CommandSender } from '../ws-client';
import type { PrinterState } from '../printer-state';
import { $, escapeHtml, formatTime } from './helpers';

let historyClient: CommandSender | null = null;

export function setHistoryClient(client: CommandSender): void {
  historyClient = client;
}

export function requestHistory(): void {
  if (!historyClient) return;
  // Method 1036 takes NO params per CC2 protocol — page/page_size not supported
  historyClient.sendCommand(1036, {});
}

export function renderPrintHistory(state: PrinterState): void {
  const container = $('print-history-entries');
  if (!container) return;

  const items = state.printHistory;
  if (!items || items.length === 0) {
    container.innerHTML = '<div class="file-empty">No print history</div>';
    return;
  }

  const html = items.map(item => {
    const statusClass = item.status === 'completed' ? 'success'
      : item.status === 'failed' ? 'danger'
      : item.status === 'stopped' ? 'warning'
      : '';
    const statusIcon = item.status === 'completed' ? '✅'
      : item.status === 'failed' ? '❌'
      : item.status === 'stopped' ? '⏹'
      : '❓';

    const begin = item.begin_time ? new Date(item.begin_time * 1000).toLocaleString() : '--';
    const end = item.end_time ? new Date(item.end_time * 1000).toLocaleString() : '--';
    const duration = (item.begin_time && item.end_time)
      ? formatTime(item.end_time - item.begin_time)
      : '--';

    return `<div class="history-entry">
      <div class="history-entry-main">
        <span class="history-status ${statusClass}" title="${escapeHtml(item.status)}">${statusIcon}</span>
        <span class="history-filename" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</span>
      </div>
      <div class="history-entry-meta">
        <span title="Start time">🕐 ${escapeHtml(begin)}</span>
        <span title="Duration">⏱ ${escapeHtml(duration)}</span>
      </div>
    </div>`;
  }).join('');

  container.innerHTML = html;

  // Show total count
  const totalEl = $('print-history-total');
  if (totalEl) {
    totalEl.textContent = `${state.printHistoryTotal} prints`;
  }
}

export function bindHistoryControls(): void {
  $('btn-history-refresh').addEventListener('click', () => requestHistory());
}
