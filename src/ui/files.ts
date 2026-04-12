import type { PrinterState } from '../printer-state';
import type { CommandSender } from '../ws-client';
import type { FileEntry } from '../types';
import { $, escapeHtml, escapeAttr, formatTime, applyDarkThumbnailCheck } from './helpers';
import { requestPrintDialog } from './print-dialog';

let currentSource: 'local' | 'u-disk' = 'local';
let currentDir = '/';

/** Set of full file paths that are cached on the server */
let cachedFiles = new Set<string>();
/** Map of full file path → base64 thumbnail */
const thumbnailCache = new Map<string, string>();
/** Queue of file paths waiting for thumbnail fetch */
let thumbnailQueue: string[] = [];
/** Currently fetching thumbnail for this file */
let thumbnailFetching: string | null = null;
export function currentFileSource(): string { return currentSource; }
export function currentFileDir(): string { return currentDir; }

/** Fetch which files are cached on the server and update markers */
let _fetchingCached = false;
async function fetchCachedStatus(files: { filename: string; type?: string }[], client: CommandSender): Promise<void> {
  if (_fetchingCached) return;
  const gcodeFiles = files
    .filter(f => f.type !== 'folder' && f.filename.toLowerCase().endsWith('.gcode'))
    .map(f => currentDir === '/' ? f.filename : currentDir.replace(/^\//, '') + '/' + f.filename);
  if (!gcodeFiles.length) { cachedFiles = new Set(); return; }
  _fetchingCached = true;
  try {
    const params = gcodeFiles.map(f => `file=${encodeURIComponent(f)}`).join('&');
    const resp = await fetch(`/api/files/cached?${params}`);
    if (resp.ok) {
      const data = await resp.json() as { cached: string[] };
      const newCached = new Set(data.cached);
      const changed = newCached.size !== cachedFiles.size || [...newCached].some(f => !cachedFiles.has(f));
      cachedFiles = newCached;
      if (changed && cachedFiles.size > 0 && _lastState) {
        // Re-render to show cache markers in HTML
        renderFiles(_lastState, client);
      }
    }
  } catch { /* ignore */ }
  _fetchingCached = false;
}

let _lastState: PrinterState | null = null;

/** Fetch inline thumbnails for visible gcode files (serialized via queue) */
let _thumbClient: CommandSender | null = null;
function fetchInlineThumbnails(files: { filename: string; type?: string }[], client: CommandSender): void {
  _thumbClient = client;
  for (const file of files) {
    if (file.type === 'folder') continue;
    if (!file.filename.toLowerCase().endsWith('.gcode')) continue;
    const fullPath = currentDir === '/' ? file.filename : currentDir.replace(/^\//, '') + '/' + file.filename;
    if (thumbnailCache.has(fullPath) || thumbnailQueue.includes(fullPath) || thumbnailFetching === fullPath) continue;
    thumbnailQueue.push(fullPath);
  }
  fetchNextThumbnail();
}

function fetchNextThumbnail(): void {
  if (thumbnailFetching || !_thumbClient) return;
  const next = thumbnailQueue.shift();
  if (!next) return;
  thumbnailFetching = next;
  // Method 1045 uses file_name (with underscore!)
  _lastState?.thumbnailRequestQueue.push('inline');
  _thumbClient.sendCommand(1045, { storage_media: currentSource, file_name: next });
}

/** Called when a thumbnail response arrives — update inline preview if applicable */
export function handleInlineThumbnail(base64: string | null): void {
  const fullPath = thumbnailFetching;
  thumbnailFetching = null;
  if (fullPath && base64) {
    thumbnailCache.set(fullPath, base64);
    // Find the DOM element and insert thumbnail
    document.querySelectorAll('.file-item[data-type="file"]').forEach(el => {
      const fn = (el as HTMLElement).dataset.filename;
      if (!fn) return;
      const fp = currentDir === '/' ? fn : currentDir.replace(/^\//, '') + '/' + fn;
      if (fp !== fullPath) return;
      const iconEl = el.querySelector('.file-icon');
      if (iconEl && !iconEl.querySelector('img')) {
        const img = document.createElement('img');
        img.src = `data:image/png;base64,${base64}`;
        img.alt = 'Thumbnail';
        img.className = 'file-inline-thumb';
        applyDarkThumbnailCheck(img, iconEl as HTMLElement);
        iconEl.textContent = '';
        iconEl.appendChild(img);
      }
    });
  }
  // Fetch next in queue
  fetchNextThumbnail();
}

// ── File detail popover on thumbnail hover ──────────────────────
let filePopover: HTMLElement | null = null;
let popoverTimeout: ReturnType<typeof setTimeout> | null = null;
/** Map filename → FileEntry for popover data lookup */
let _fileMap = new Map<string, FileEntry>();
let _popoverClient: CommandSender | null = null;

/** Try to extract filament info from ECC2 slicer filename pattern */
function parseFilamentFromName(filename: string): { types: string[]; count: number } | null {
  // Pattern: ECC2_nozzle_name_FilamentType_layerHeight_time.gcode
  // May have multiple filament segments separated by +
  // Examples: "Elegoo PLA " or "Elegoo PLA + Elegoo PETG "
  const base = filename.replace(/\.gcode$/i, '');
  const parts = base.split('_');
  // Find filament-like segments (contain known type keywords)
  const typeKeywords = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'PA', 'PC', 'HIPS', 'PVA', 'Nylon'];
  const found: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (typeKeywords.some(kw => trimmed.toUpperCase().includes(kw))) {
      // Split on + for multi-filament
      trimmed.split('+').forEach(seg => {
        const s = seg.trim();
        if (s) found.push(s);
      });
    }
  }
  if (found.length === 0) return null;
  return { types: [...new Set(found)], count: found.length };
}

function showFilePopover(file: FileEntry, anchor: HTMLElement): void {
  closeFilePopover();
  const fullPath = currentDir === '/' ? file.filename : currentDir.replace(/^\//, '') + '/' + file.filename;
  const thumb = thumbnailCache.get(fullPath);
  const isCached = cachedFiles.has(fullPath);
  const filamentInfo = parseFilamentFromName(file.filename);

  const el = document.createElement('div');
  el.className = 'file-popover';

  let html = '<div class="file-popover-inner">';
  if (thumb) {
    html += `<img class="file-popover-thumb" src="data:image/png;base64,${thumb}" alt="Preview">`;
  }
  html += '<div class="file-popover-details">';
  html += `<div class="file-popover-name">${escapeHtml(file.filename)}</div>`;
  html += '<table class="file-popover-table">';
  html += `<tr><td>Size</td><td>${formatBytes(file.size)}</td></tr>`;
  if (file.print_time) html += `<tr><td>Print time</td><td>${formatTime(file.print_time)}</td></tr>`;
  if (file.layer) html += `<tr><td>Layers</td><td>${file.layer}</td></tr>`;
  if (file.total_filament_used) html += `<tr><td>Filament</td><td>${file.total_filament_used.toFixed(1)}g</td></tr>`;
  if (filamentInfo) {
    html += `<tr><td>Material</td><td>${escapeHtml(filamentInfo.types.join(', '))}`;
    if (filamentInfo.count > 1) html += ` (${filamentInfo.count} filaments)`;
    html += `</td></tr>`;
  }
  if (file.create_time) {
    const d = new Date(file.create_time * 1000);
    html += `<tr><td>Created</td><td>${d.toLocaleDateString()} ${d.toLocaleTimeString()}</td></tr>`;
  }
  if (isCached) html += `<tr><td>Cache</td><td>⚡ Cached on server</td></tr>`;
  html += '</table>';

  // Action buttons
  html += '<div class="file-popover-actions">';
  html += `<button class="btn btn-sm btn-ghost file-popover-preview" title="Full preview">🖼️ Preview</button>`;
  html += `<button class="btn btn-sm btn-ghost file-popover-download" title="Download">📥 Download</button>`;
  html += `<button class="btn btn-sm btn-ghost file-popover-delete" title="Delete">🗑️ Delete</button>`;
  html += '</div>';

  html += '</div></div>';
  el.innerHTML = html;

  document.body.appendChild(el);

  // Bind popover action buttons
  const source = currentSource === 'u-disk' ? 'u-disk' : 'local';
  el.querySelector('.file-popover-preview')?.addEventListener('click', () => {
    closeFilePopover();
    pendingThumbnailFile = fullPath;
    pendingThumbnailAnchor = anchor;
    _lastState?.thumbnailRequestQueue.push('popup');
    _popoverClient?.sendCommand(1045, { storage_media: currentSource, file_name: fullPath });
  });
  el.querySelector('.file-popover-download')?.addEventListener('click', () => {
    closeFilePopover();
    const a = document.createElement('a');
    a.href = `/api/files/download?file=${encodeURIComponent(fullPath)}&source=${encodeURIComponent(source)}`;
    a.download = file.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  el.querySelector('.file-popover-delete')?.addEventListener('click', () => {
    closeFilePopover();
    if (confirm(`Delete ${file.filename}?`)) {
      _popoverClient?.sendCommand(1047, { storage_media: currentSource, file_path: [fullPath] });
      setTimeout(() => {
        _popoverClient?.sendCommand(1044, { storage_media: currentSource, dir: currentDir, offset: 0, limit: 200 });
        _popoverClient?.sendCommand(1048, { storage_media: currentSource });
      }, 500);
    }
  });

  // Position relative to anchor
  const rect = anchor.getBoundingClientRect();
  const popW = 320;
  const popH = el.offsetHeight || 200;
  let left = rect.right + 8;
  let top = rect.top;
  // Keep within viewport
  if (left + popW > window.innerWidth) left = rect.left - popW - 8;
  if (top + popH > window.innerHeight) top = Math.max(8, window.innerHeight - popH - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  // Apply dark thumbnail check if we have an image
  const img = el.querySelector('.file-popover-thumb') as HTMLImageElement | null;
  if (img) applyDarkThumbnailCheck(img, el);

  filePopover = el;

  // Close when mouse leaves the popover (with delay for moving back)
  el.addEventListener('mouseleave', () => {
    closePopoverTimeout = setTimeout(() => closeFilePopover(), 150);
  });
  el.addEventListener('mouseenter', () => {
    if (closePopoverTimeout) { clearTimeout(closePopoverTimeout); closePopoverTimeout = null; }
  });
}

function closeFilePopover(): void {
  if (popoverTimeout) { clearTimeout(popoverTimeout); popoverTimeout = null; }
  if (filePopover) { filePopover.remove(); filePopover = null; }
}

let closePopoverTimeout: ReturnType<typeof setTimeout> | null = null;

function bindFilePopovers(container: HTMLElement): void {
  container.querySelectorAll('.file-item[data-type="file"]').forEach(item => {
    const fn = (item as HTMLElement).dataset.filename;
    if (!fn) return;
    const file = _fileMap.get(fn);
    if (!file) return;

    item.addEventListener('mouseenter', (e) => {
      // Don't trigger on print button
      if ((e.target as HTMLElement).closest('.file-print-btn')) return;
      // Cancel any pending close
      if (closePopoverTimeout) { clearTimeout(closePopoverTimeout); closePopoverTimeout = null; }
      if (popoverTimeout) { clearTimeout(popoverTimeout); popoverTimeout = null; }
      // If popover is already open for a different file, update immediately
      if (filePopover) {
        showFilePopover(file, item as HTMLElement);
      } else {
        popoverTimeout = setTimeout(() => showFilePopover(file, item as HTMLElement), 300);
      }
    });
    item.addEventListener('mouseleave', () => {
      if (popoverTimeout) { clearTimeout(popoverTimeout); popoverTimeout = null; }
      // Delay closing to allow mouse to move to next item or popover
      closePopoverTimeout = setTimeout(() => {
        if (filePopover && !filePopover.matches(':hover')) closeFilePopover();
      }, 150);
    });
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function renderBreadcrumb(client: CommandSender): string {
  if (currentDir === '/') return '';
  const parts = currentDir.split('/').filter(Boolean);
  let html = '<div class="file-breadcrumb">';
  html += `<button class="btn btn-sm btn-ghost file-nav-btn" data-dir="/">🏠 Root</button>`;
  let path = '';
  for (let i = 0; i < parts.length; i++) {
    path += '/' + parts[i];
    const isLast = i === parts.length - 1;
    html += `<span class="breadcrumb-sep">/</span>`;
    if (isLast) {
      html += `<span class="breadcrumb-current">${escapeHtml(parts[i])}</span>`;
    } else {
      html += `<button class="btn btn-sm btn-ghost file-nav-btn" data-dir="${escapeAttr(path)}">${escapeHtml(parts[i])}</button>`;
    }
  }
  html += '</div>';
  return html;
}

function renderCapacityBar(state: PrinterState): string {
  const cap = state.storageCapacity;
  if (!cap || cap.total === 0) return '';
  const usedPct = Math.min(100, Math.round((cap.used / cap.total) * 100));
  const warn = usedPct > 90 ? ' capacity-warn' : usedPct > 75 ? ' capacity-high' : '';
  return `<div class="storage-capacity">
    <div class="capacity-bar"><div class="capacity-fill${warn}" style="width:${usedPct}%"></div></div>
    <span class="capacity-text">${formatBytes(cap.used)} / ${formatBytes(cap.total)} (${usedPct}%)</span>
  </div>`;
}

// Thumbnail popup state
let thumbnailPopup: HTMLElement | null = null;

function showThumbnailPopup(base64: string, anchor: HTMLElement): void {
  closeThumbnailPopup();
  const popup = document.createElement('div');
  popup.className = 'file-thumbnail-popup';
  const img = document.createElement('img');
  img.src = `data:image/png;base64,${base64}`;
  img.alt = 'Thumbnail';
  popup.appendChild(img);
  applyDarkThumbnailCheck(img, popup);
  document.body.appendChild(popup);

  // Position near anchor
  const rect = anchor.getBoundingClientRect();
  popup.style.left = `${rect.left}px`;
  popup.style.top = `${Math.max(8, rect.top - 180)}px`;
  thumbnailPopup = popup;
}

function closeThumbnailPopup(): void {
  if (thumbnailPopup) {
    thumbnailPopup.remove();
    thumbnailPopup = null;
  }
}

// Close thumbnail popup on click outside
document.addEventListener('click', (e) => {
  if (thumbnailPopup && !(e.target as HTMLElement).closest('.file-thumbnail-btn') && !(e.target as HTMLElement).closest('.file-thumbnail-popup')) {
    closeThumbnailPopup();
  }
});

let pendingThumbnailFile: string | null = null;
let pendingThumbnailAnchor: HTMLElement | null = null;

export function handleThumbnailResponse(thumbnail: string | null): void {
  if (thumbnail && pendingThumbnailFile && pendingThumbnailAnchor) {
    showThumbnailPopup(thumbnail, pendingThumbnailAnchor);
    pendingThumbnailFile = null;
    pendingThumbnailAnchor = null;
  }
}

export function renderFiles(state: PrinterState, client: CommandSender): void {
  _lastState = state;
  const container = $('file-list');
  const files = state.files;

  let html = renderCapacityBar(state);

  // Show USB not-connected warning
  if (currentSource === 'u-disk' && !state.status?.external_device?.u_disk) {
    html += '<div class="file-empty">⚠️ No USB drive detected</div>';
  }

  html += renderBreadcrumb(client);

  if (!files.length) {
    html += `<div class="file-empty">No files ${currentDir === '/' ? '' : 'in this folder '}on ${currentSource === 'u-disk' ? 'USB drive' : 'printer'}</div>`;
    container.innerHTML = html;
    bindBreadcrumbNav(container, client);
    return;
  }

  // Sort: folders first, then by name
  const sorted = [...files].sort((a, b) => {
    if (a.type === 'folder' && b.type !== 'folder') return -1;
    if (a.type !== 'folder' && b.type === 'folder') return 1;
    return a.filename.localeCompare(b.filename);
  });

  for (const file of sorted) {
    const isFolder = file.type === 'folder';
    const sizeMB = isFolder ? '' : (file.size / (1024 * 1024)).toFixed(1);
    const timeInfo = file.print_time ? formatTime(file.print_time) : '';
    const layerInfo = file.layer ? `${file.layer} layers` : '';
    const filamentInfo = file.total_filament_used ? `${file.total_filament_used.toFixed(1)}g filament` : '';
    const meta = isFolder ? 'Folder' : [sizeMB + ' MB', timeInfo, layerInfo, filamentInfo].filter(Boolean).join(' · ');

    const fullPath = currentDir === '/' ? file.filename : currentDir.replace(/^\//, '') + '/' + file.filename;
    const isCached = cachedFiles.has(fullPath);
    const cachedThumb = thumbnailCache.get(fullPath);
    const cacheMarker = isCached ? ' <span class="file-cache-marker" title="Cached on server">⚡</span>' : '';

    let iconHtml: string;
    if (isFolder) {
      iconHtml = '📁';
    } else if (cachedThumb) {
      iconHtml = `<img src="data:image/png;base64,${cachedThumb}" alt="Thumb" class="file-inline-thumb">`;
    } else {
      iconHtml = '📄';
    }

    html += `
      <div class="file-item ${isFolder ? 'file-item-folder' : ''}" data-filename="${escapeAttr(file.filename)}" data-type="${isFolder ? 'folder' : 'file'}">
        <div class="file-name-row">
          <span class="file-name">${escapeHtml(file.filename)}</span>${cacheMarker}
        </div>
        <div class="file-item-body">
          <div class="file-icon">${iconHtml}</div>
          <div class="file-details">
            <div class="file-size">${meta}</div>
          </div>
          <div class="file-actions">
            ${isFolder ? '' : `<button class="btn btn-sm btn-primary file-print-btn" title="Print">▶</button>`}
          </div>
        </div>
      </div>`;
  }

  container.innerHTML = html;
  bindBreadcrumbNav(container, client);

  // Build file map for popover lookups
  _fileMap = new Map(sorted.filter(f => f.type !== 'folder').map(f => [f.filename, f]));
  _popoverClient = client;

  // Fetch cached status and inline thumbnails asynchronously
  void fetchCachedStatus(sorted, client);
  fetchInlineThumbnails(sorted, client);

  // Bind thumbnail hover popovers
  bindFilePopovers(container);

  // Folder click → navigate
  container.querySelectorAll('.file-item-folder').forEach(item => {
    item.addEventListener('click', () => {
      const dirname = (item as HTMLElement).dataset.filename;
      if (!dirname) return;
      currentDir = currentDir === '/' ? '/' + dirname : currentDir + '/' + dirname;
      thumbnailQueue = [];
      thumbnailFetching = null;
      container.innerHTML = '<div class="loading">Loading...</div>';
      client.sendCommand(1044, { storage_media: currentSource, dir: currentDir, offset: 0, limit: 200 });
    });
  });

  // Print button
  container.querySelectorAll('.file-print-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = (e.target as HTMLElement).closest('.file-item') as HTMLElement;
      const filename = item?.dataset.filename;
      if (filename) {
        const fullPath = currentDir === '/' ? filename : currentDir.replace(/^\//, '') + '/' + filename;
        requestPrintDialog(filename, fullPath, client, state);
      }
    });
  });
}

function bindBreadcrumbNav(container: HTMLElement, client: CommandSender): void {
  container.querySelectorAll('.file-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = (btn as HTMLElement).dataset.dir;
      if (dir == null) return;
      currentDir = dir;
      thumbnailQueue = [];
      thumbnailFetching = null;
      container.innerHTML = '<div class="loading">Loading...</div>';
      client.sendCommand(1044, { storage_media: currentSource, dir: currentDir, offset: 0, limit: 200 });
    });
  });
}

let fileControlsBound = false;

export function bindFileControls(client: CommandSender): void {
  if (fileControlsBound) return;
  fileControlsBound = true;

  document.querySelectorAll('.file-source-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const source = (tab as HTMLElement).dataset.source as 'local' | 'u-disk';
      currentSource = source;
      currentDir = '/';
      thumbnailQueue = [];
      thumbnailFetching = null;
      document.querySelectorAll('.file-source-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $('file-list').innerHTML = '<div class="loading">Loading...</div>';
      client.sendCommand(1044, { storage_media: source, dir: '/', offset: 0, limit: 200 });
      client.sendCommand(1048, { storage_media: source });
    });
  });

  // Upload handler
  const uploadInput = document.getElementById('file-upload-input') as HTMLInputElement | null;
  if (uploadInput) {
    uploadInput.addEventListener('change', () => {
      const file = uploadInput.files?.[0];
      if (!file) return;
      uploadInput.value = ''; // reset so same file can be re-selected
      uploadFile(file, client);
    });
  }
}

const ALLOWED_EXTENSIONS = ['.gcode', '.3mf'];
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB

async function uploadFile(file: File, client: CommandSender): Promise<void> {
  const progressEl = document.getElementById('upload-progress');
  const fillEl = document.getElementById('upload-progress-fill');
  const textEl = document.getElementById('upload-progress-text');
  const labelEl = document.getElementById('file-upload-label');
  if (!progressEl || !fillEl || !textEl) return;

  // Client-side validation
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    progressEl.classList.remove('hidden');
    progressEl.classList.add('upload-error');
    fillEl.style.width = '0%';
    textEl.textContent = `✗ Invalid file type "${ext}" — only .gcode and .3mf allowed`;
    return;
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    progressEl.classList.remove('hidden');
    progressEl.classList.add('upload-error');
    fillEl.style.width = '0%';
    textEl.textContent = `✗ File too large (${(file.size / 1024 / 1024).toFixed(0)} MB) — max 500 MB`;
    return;
  }

  progressEl.classList.remove('hidden');
  fillEl.style.width = '0%';
  textEl.textContent = `Uploading ${file.name}...`;
  if (labelEl) labelEl.classList.add('disabled');

  const formData = new FormData();
  formData.append('file', file);

  const source = currentSource === 'u-disk' ? 'u-disk' : 'local';

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files/upload?source=${encodeURIComponent(source)}`);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        fillEl.style.width = pct + '%';
        textEl.textContent = `Uploading ${file.name}... ${pct}% (${formatBytes(e.loaded)} / ${formatBytes(e.total)})`;
      }
    });

    await new Promise<void>((resolve, reject) => {
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          let msg = `Upload failed (HTTP ${xhr.status})`;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* ignore */ }
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(formData);
    });

    fillEl.style.width = '100%';
    textEl.textContent = `✓ ${file.name} uploaded`;
    // Refresh file list
    client.sendCommand(1044, { storage_media: currentSource, dir: currentDir, offset: 0, limit: 200 });
    client.sendCommand(1048, { storage_media: currentSource });
  } catch (err) {
    textEl.textContent = `✗ ${(err as Error).message}`;
    fillEl.style.width = '0%';
    progressEl.classList.add('upload-error');
  } finally {
    if (labelEl) labelEl.classList.remove('disabled');
    // Auto-hide progress after 4 seconds on success
    setTimeout(() => {
      if (!progressEl.classList.contains('upload-error')) {
        progressEl.classList.add('hidden');
      }
    }, 4000);
  }
}
