import type { CommandSender } from '../ws-client';
import type { PrinterState } from '../printer-state';
import { $, escapeHtml, formatTime } from './helpers';

let historyClient: CommandSender | null = null;
let currentPage = 1;
const PAGE_SIZE = 20;

export function setHistoryClient(client: CommandSender): void {
  historyClient = client;
}

export function requestHistory(page = 1): void {
  if (!historyClient) return;
  currentPage = page;
  historyClient.sendCommand(1036, { page, page_size: PAGE_SIZE });
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

  // Pagination
  const totalEl = $('print-history-total');
  if (totalEl) {
    const total = state.printHistoryTotal;
    const pages = Math.ceil(total / PAGE_SIZE);
    if (pages > 1) {
      let paginationHtml = '<div class="history-pagination">';
      if (currentPage > 1) {
        paginationHtml += `<button class="btn btn-sm btn-ghost history-page-btn" data-page="${currentPage - 1}">◀</button>`;
      }
      paginationHtml += `<span class="history-page-info">${currentPage} / ${pages}</span>`;
      if (currentPage < pages) {
        paginationHtml += `<button class="btn btn-sm btn-ghost history-page-btn" data-page="${currentPage + 1}">▶</button>`;
      }
      paginationHtml += '</div>';
      totalEl.innerHTML = paginationHtml;

      // Bind page buttons
      totalEl.querySelectorAll('.history-page-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const page = parseInt((btn as HTMLElement).dataset.page ?? '1');
          requestHistory(page);
        });
      });
    } else {
      totalEl.innerHTML = '';
    }
  }
}

export function bindHistoryControls(): void {
  $('btn-history-refresh').addEventListener('click', () => requestHistory(1));
}
