/** Lightweight canvas-based live line chart — no dependencies */

import type { ChartStore, Series } from '../chart-store';

const PADDING = { top: 10, right: 12, bottom: 24, left: 48 };
const GRID_COLOR = 'rgba(160, 160, 184, 0.12)';
const LABEL_COLOR = '#a0a0b8';
const LABEL_FONT = '10px -apple-system, BlinkMacSystemFont, sans-serif';

interface ChartConfig {
  canvasId: string;
  seriesKeys: string[];
  /** Fixed Y-axis range, or auto-scale if omitted */
  yMin?: number;
  yMax?: number;
  /** Duration shown on x-axis in seconds (default 300 = 5 min) */
  window?: number;
  unit?: string;
}

/** Per-chart zoom/pan state */
interface ChartInteraction {
  panOffset: number; // ms offset (negative = looking at past)
  zoomFactor: number; // 1.0 = normal, >1 = zoomed in
  isDragging: boolean;
  dragStartX: number;
  dragStartOffset: number;
}

const charts = new Map<string, ChartConfig>();
const interactions = new Map<string, ChartInteraction>();
let store: ChartStore | null = null;
let animating = false;
let interactionsBound = false;

export function registerChart(config: ChartConfig): void {
  charts.set(config.canvasId, config);
  interactions.set(config.canvasId, {
    panOffset: 0,
    zoomFactor: 1.0,
    isDragging: false,
    dragStartX: 0,
    dragStartOffset: 0,
  });
}

export function initCharts(chartStore: ChartStore): void {
  store = chartStore;
  bindTimeWindowButtons();
  if (!interactionsBound) {
    interactionsBound = true;
    bindChartInteractions();
  }
  if (!animating) {
    animating = true;
    drawLoop();
  }
}

function bindTimeWindowButtons(): void {
  document.querySelectorAll('.chart-time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      const canvasId = el.dataset.chart!;
      const seconds = parseInt(el.dataset.window!);
      const config = charts.get(canvasId);
      if (config) {
        config.window = seconds;
      }
      // Update active state for this chart's buttons
      const parent = el.parentElement;
      parent?.querySelectorAll('.chart-time-btn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
    });
  });
}

function bindChartInteractions(): void {
  for (const [canvasId] of charts) {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) continue;

    const inter = interactions.get(canvasId)!;

    // Wheel to zoom
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.8 : 1.25; // scroll down = zoom out, up = zoom in
      inter.zoomFactor = Math.max(0.1, Math.min(10, inter.zoomFactor * delta));
    }, { passive: false });

    // Drag to pan
    canvas.addEventListener('mousedown', (e) => {
      inter.isDragging = true;
      inter.dragStartX = e.clientX;
      inter.dragStartOffset = inter.panOffset;
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!inter.isDragging) return;
      const config = charts.get(canvasId)!;
      const rect = canvas.getBoundingClientRect();
      const plotW = rect.width - PADDING.left - PADDING.right;
      const windowSec = (config.window ?? 300) / inter.zoomFactor;
      const msPerPx = (windowSec * 1000) / plotW;
      const dx = e.clientX - inter.dragStartX;
      inter.panOffset = inter.dragStartOffset + dx * msPerPx;
      // Prevent panning into the future
      if (inter.panOffset > 0) inter.panOffset = 0;
    });

    canvas.addEventListener('mouseup', () => {
      inter.isDragging = false;
      canvas.style.cursor = 'default';
    });

    canvas.addEventListener('mouseleave', () => {
      inter.isDragging = false;
      canvas.style.cursor = 'default';
    });

    // Double-click to reset
    canvas.addEventListener('dblclick', () => {
      inter.panOffset = 0;
      inter.zoomFactor = 1.0;
    });
  }
}

function drawLoop(): void {
  for (const [, config] of charts) {
    drawChart(config);
  }
  requestAnimationFrame(drawLoop);
}

function drawChart(config: ChartConfig): void {
  if (!store) return;
  const canvas = document.getElementById(config.canvasId) as HTMLCanvasElement | null;
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;

  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }

  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const plotW = w - PADDING.left - PADDING.right;
  const plotH = h - PADDING.top - PADDING.bottom;
  const inter = interactions.get(config.canvasId);
  const zoomFactor = inter?.zoomFactor ?? 1.0;
  const panOffset = inter?.panOffset ?? 0;
  const windowSec = (config.window ?? 300) / zoomFactor;
  const now = Date.now();
  const tMax = now + panOffset;
  const tMin = tMax - windowSec * 1000;

  // Collect all series
  const allSeries: Series[] = [];
  for (const key of config.seriesKeys) {
    const s = store.getSeries(key);
    if (s) allSeries.push(s);
  }

  // Y-axis range
  let yMin = config.yMin ?? Infinity;
  let yMax = config.yMax ?? -Infinity;
  if (yMin === Infinity || yMax === -Infinity) {
    for (const s of allSeries) {
      for (const p of s.data) {
        if (p.t >= tMin) {
          if (p.v < yMin) yMin = p.v;
          if (p.v > yMax) yMax = p.v;
        }
      }
    }
    if (yMin === Infinity) { yMin = 0; yMax = 100; }
    const padding = (yMax - yMin) * 0.1 || 10;
    yMin = Math.max(0, yMin - padding);
    yMax = yMax + padding;
  }

  const xMap = (t: number) => PADDING.left + ((t - tMin) / (tMax - tMin)) * plotW;
  const yMap = (v: number) => PADDING.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Grid lines (Y)
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  const ySteps = 5;
  const yStep = (yMax - yMin) / ySteps;
  ctx.font = LABEL_FONT;
  ctx.fillStyle = LABEL_COLOR;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= ySteps; i++) {
    const val = yMin + i * yStep;
    const y = yMap(val);
    ctx.beginPath();
    ctx.moveTo(PADDING.left, y);
    ctx.lineTo(w - PADDING.right, y);
    ctx.stroke();
    const label = val >= 1000 ? `${(val / 1000).toFixed(1)}k` : Math.round(val).toString();
    ctx.fillText(label + (config.unit ?? ''), PADDING.left - 4, y);
  }

  // Grid lines (X) — time labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xGridCount = Math.min(6, Math.floor(plotW / 60));
  for (let i = 0; i <= xGridCount; i++) {
    const t = tMin + (i / xGridCount) * (tMax - tMin);
    const x = xMap(t);
    ctx.beginPath();
    ctx.moveTo(x, PADDING.top);
    ctx.lineTo(x, PADDING.top + plotH);
    ctx.stroke();
    const d = new Date(t);
    ctx.fillText(
      `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`,
      x, PADDING.top + plotH + 4
    );
  }

  // Draw each series
  for (const s of allSeries) {
    const visible = s.data.filter(p => p.t >= tMin);
    if (visible.length < 2) continue;

    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();

    let started = false;
    for (const p of visible) {
      const x = xMap(p.t);
      const y = yMap(p.v);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Current value label at the right end
    const last = visible[visible.length - 1];
    if (last) {
      ctx.fillStyle = s.color;
      ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        `${s.label}: ${last.v.toFixed(1)}`,
        xMap(last.t) + 4,
        yMap(last.v)
      );
    }
  }

  // Show zoom/pan indicator if not at defaults
  if (inter && (inter.zoomFactor !== 1.0 || inter.panOffset !== 0)) {
    ctx.fillStyle = 'rgba(33, 150, 243, 0.3)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const zoomLabel = `${inter.zoomFactor.toFixed(1)}x`;
    const panLabel = inter.panOffset !== 0 ? ` pan:${(inter.panOffset / 1000).toFixed(0)}s` : '';
    ctx.fillText(`🔍 ${zoomLabel}${panLabel} (dblclick to reset)`, PADDING.left + 4, PADDING.top + 2);
  }
}
