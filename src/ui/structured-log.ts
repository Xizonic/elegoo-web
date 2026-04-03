/** Structured MQTT log viewer with filters, search, pause, and highlighting */

import type { LogStore, LogEntry } from '../log-store';
import { $, escapeHtml } from './helpers';
import { METHOD_NAMES } from './log-methods';

let autoScroll = true;
let paused = false;
let searchText = '';
let directionFilter: 'all' | 'sent' | 'received' = 'all';
let typeFilter: 'all' | 'status' | 'command' | 'response' | 'heartbeat' = 'all';
let expandedEntries = new Set<number>();
let pendingCount = 0;
let lastRenderedTs = '';
let lastRenderedCount = '';

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('nb-NO', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function classifyEntry(entry: LogEntry): 'status' | 'command' | 'response' | 'heartbeat' | 'other' {
  if (entry.type === 'PING' || entry.type === 'PONG') return 'heartbeat';
  if (entry.topic.includes('api_status')) return 'status';
  if (entry.topic.includes('api_request')) return 'command';
  if (entry.topic.includes('api_response')) return 'response';
  if (entry.topic.includes('api_register')) return 'command';
  return 'other';
}

function matchesFilters(entry: LogEntry): boolean {
  // Direction filter
  if (directionFilter !== 'all' && entry.direction !== directionFilter) return false;

  // Type filter
  if (typeFilter !== 'all') {
    const cls = classifyEntry(entry);
    if (typeFilter === 'status' && cls !== 'status') return false;
    if (typeFilter === 'command' && cls !== 'command') return false;
    if (typeFilter === 'response' && cls !== 'response') return false;
    if (typeFilter === 'heartbeat' && cls !== 'heartbeat') return false;
  }

  // Search text
  if (searchText) {
    const lower = searchText.toLowerCase();
    return (
      entry.topic.toLowerCase().includes(lower) ||
      (entry.method != null && String(entry.method).includes(lower)) ||
      (entry.type?.toLowerCase().includes(lower) ?? false) ||
      entry.payload.toLowerCase().includes(lower) ||
      (entry.method != null && (METHOD_NAMES[entry.method] ?? '').toLowerCase().includes(lower))
    );
  }

  return true;
}

function highlightMatch(text: string): string {
  if (!searchText) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const searchEscaped = escapeHtml(searchText);
  const regex = new RegExp(`(${searchEscaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escaped.replace(regex, '<mark class="log-highlight">$1</mark>');
}

function shortTopic(topic: string): string {
  const parts = topic.split('/');
  return parts[parts.length - 1];
}

function methodLabel(entry: LogEntry): string {
  if (entry.type) return entry.type;
  if (entry.method != null) {
    const name = METHOD_NAMES[entry.method];
    return name ? `${entry.method} ${name}` : `M${entry.method}`;
  }
  return '';
}

function typeIcon(entry: LogEntry): string {
  const cls = classifyEntry(entry);
  switch (cls) {
    case 'status': return '📊';
    case 'command': return '📤';
    case 'response': return '📥';
    case 'heartbeat': return '💓';
    default: return '📋';
  }
}

function compactPayload(entry: LogEntry): string {
  if (entry.type === 'PING' || entry.type === 'PONG') return entry.type;
  const raw = entry.raw as Record<string, unknown>;
  if (!raw) return entry.payload;

  // For status events, show key changed fields
  if (classifyEntry(entry) === 'status') {
    const keys = Object.keys(raw);
    const interesting = keys.filter(k => k !== 'method' && k !== 'id');
    if (interesting.length <= 4) return interesting.join(', ');
    return `${interesting.slice(0, 3).join(', ')} +${interesting.length - 3} more`;
  }

  // For responses, show error_code
  if (classifyEntry(entry) === 'response') {
    const result = raw.result as Record<string, unknown> | undefined;
    if (result?.error_code !== undefined) {
      const code = result.error_code as number;
      return code === 0 ? '✅ OK' : `❌ Error ${code}`;
    }
  }

  return entry.payload.slice(0, 200);
}

export function renderStructuredLog(store: LogStore): void {
  if (paused) {
    pendingCount++;
    $('slog-paused-badge').textContent = `PAUSED (${pendingCount} pending)`;
    return;
  }

  const container = $('slog-entries');
  const entries = store.getEntries().filter(matchesFilters);

  const lastEntry = entries[entries.length - 1];
  const tsKey = lastEntry ? String(lastEntry.timestamp) : '';
  const countKey = String(entries.length);
  if (tsKey === lastRenderedTs && countKey === lastRenderedCount) return;
  lastRenderedTs = tsKey;
  lastRenderedCount = countKey;

  let html = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const dirClass = e.direction === 'sent' ? 'slog-sent' : 'slog-recv';
    const typeClass = `slog-type-${classifyEntry(e)}`;
    const isExpanded = expandedEntries.has(e.timestamp);
    const icon = typeIcon(e);
    const method = methodLabel(e);
    const summary = compactPayload(e);

    html += `<div class="slog-row ${dirClass} ${typeClass}" data-ts="${e.timestamp}">`;
    html += `<div class="slog-row-header">`;
    html += `<span class="slog-icon">${icon}</span>`;
    html += `<span class="slog-time">${formatTimestamp(e.timestamp)}</span>`;
    html += `<span class="slog-dir">${e.direction === 'sent' ? '→' : '←'}</span>`;
    html += `<span class="slog-method">${highlightMatch(method)}</span>`;
    html += `<span class="slog-topic">${highlightMatch(shortTopic(e.topic))}</span>`;
    html += `<span class="slog-summary">${highlightMatch(summary)}</span>`;
    html += `<span class="slog-expand">${isExpanded ? '▾' : '▸'}</span>`;
    html += `</div>`;

    if (isExpanded) {
      html += `<pre class="slog-detail">${escapeHtml(JSON.stringify(e.raw, null, 2))}</pre>`;
    }

    html += `</div>`;
  }

  container.innerHTML = html;
  $('slog-count').textContent = `${entries.length} messages`;

  // Click to expand/collapse
  container.querySelectorAll('.slog-row').forEach(row => {
    row.addEventListener('click', () => {
      const ts = parseInt((row as HTMLElement).dataset.ts ?? '0');
      if (expandedEntries.has(ts)) expandedEntries.delete(ts);
      else expandedEntries.add(ts);
      // Disable auto-scroll so the user can inspect the entry
      autoScroll = false;
      ($('slog-autoscroll') as HTMLInputElement).checked = false;
      // Force re-render
      lastRenderedTs = '';
      renderStructuredLog(store);
    });
  });

  if (autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

export function bindStructuredLogControls(store: LogStore): void {
  // Tab switching
  document.querySelectorAll('.log-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.log-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const tabName = (tab as HTMLElement).dataset.tab;
      $('log-tab-structured').classList.toggle('hidden', tabName !== 'structured');
      $('log-tab-raw').classList.toggle('hidden', tabName !== 'raw');
    });
  });

  // Search
  $('slog-search').addEventListener('input', (e) => {
    searchText = (e.target as HTMLInputElement).value;
    lastRenderedTs = '';
    renderStructuredLog(store);
  });

  // Direction filter
  $('slog-direction-filter').addEventListener('change', (e) => {
    directionFilter = (e.target as HTMLSelectElement).value as typeof directionFilter;
    lastRenderedTs = '';
    renderStructuredLog(store);
  });

  // Type filter
  $('slog-type-filter').addEventListener('change', (e) => {
    typeFilter = (e.target as HTMLSelectElement).value as typeof typeFilter;
    lastRenderedTs = '';
    renderStructuredLog(store);
  });

  // Auto-scroll
  $('slog-autoscroll').addEventListener('change', (e) => {
    autoScroll = (e.target as HTMLInputElement).checked;
  });

  // Pause
  $('slog-pause').addEventListener('click', () => {
    paused = !paused;
    $('slog-pause').textContent = paused ? '▶' : '⏸';
    $('slog-paused-badge').classList.toggle('hidden', !paused);
    if (!paused) {
      pendingCount = 0;
      $('slog-paused-badge').textContent = 'PAUSED';
      lastRenderedTs = '';
      renderStructuredLog(store);
    }
  });

  // Clear
  $('slog-clear').addEventListener('click', () => {
    store.clear();
    expandedEntries.clear();
    lastRenderedTs = '';
    lastRenderedCount = '';
  });
}
