import { WsClient } from './ws-client';
import type { CommandSender } from './ws-client';
import { PrinterState } from './printer-state';
import { LogStore } from './log-store';
import { ChartStore } from './chart-store';
import {
  renderDashboard, renderCanvas, renderFiles, renderHeader, bindControls,
  registerChart, initCharts,
  renderStructuredLog, bindStructuredLogControls,
  bindFileControls, toast, setCanvasClient,
  renderSystemInfo,
  renderTimelapse, setTimelapseClient, requestTimelapseList, showTimelapsePlayer,
  renderBedMesh,
  renderGcodePreview,
  renderLayerTimeChart,
  updateServiceStatus,
} from './ui/dashboard';
import { renderLog, bindLogControls } from './ui/log';

const state = new PrinterState();
const logStore = new LogStore();
const chartStore = new ChartStore();
let client: WsClient | null = null;
let renderScheduled = false;

// Define chart series
chartStore.defineSeries('nozzle',     'Nozzle',     '#ef5350');
chartStore.defineSeries('nozzle_tgt', 'Nozzle Tgt', '#ef535080');
chartStore.defineSeries('bed',        'Bed',        '#ffa726');
chartStore.defineSeries('bed_tgt',    'Bed Tgt',    '#ffa72680');
chartStore.defineSeries('chamber',    'Chamber',    '#66bb6a');
chartStore.defineSeries('fan_model',  'Model',      '#4fc3f7');
chartStore.defineSeries('fan_aux',    'Aux',        '#66bb6a');
chartStore.defineSeries('fan_case',   'Case',       '#ffa726');


// Register charts
registerChart({
  canvasId: 'chart-temps',
  seriesKeys: ['nozzle', 'nozzle_tgt', 'bed', 'bed_tgt', 'chamber'],
  yMin: 0,
  yMax: 300,
  unit: '°',
});

registerChart({
  canvasId: 'chart-fans',
  seriesKeys: ['fan_model', 'fan_aux', 'fan_case'],
  yMin: 0,
  yMax: 100,
  unit: '%',
});


function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (client) {
      renderHeader(state);
      renderDashboard(state, client);
      renderCanvas(state);
      renderSystemInfo(state);
      renderTimelapse(state);
      renderBedMesh(state);
      renderGcodePreview(state);
      renderLayerTimeChart(state);
      renderLog(logStore);
      renderStructuredLog(logStore);
    }
  });
}

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function updateConnectionBadge(status: string): void {
  const badge = $('connection-status');
  badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  badge.className = `status-badge ${status}`;
}

// Subscribe to state changes
state.subscribe(scheduleRender);
logStore.subscribe(scheduleRender);

let controlsBound = false;

function onConnected(sn: string): void {
  console.log(`Connected to printer SN: ${sn}`);
  toast(`Connected to printer ${sn}`, 'success');
  $('connect-dialog').classList.add('hidden');
  $('dashboard').classList.remove('hidden');

  if (!controlsBound) {
    controlsBound = true;
    bindControls(client!);
    bindLogControls(logStore);
    bindStructuredLogControls(logStore);
    bindFileControls(client!);
    setCanvasClient(client!);
    setTimelapseClient(client!);
    $('timelapse-refresh').addEventListener('click', () => requestTimelapseList());
    $('timelapse-close').addEventListener('click', () => {
      const player = $('timelapse-player') as HTMLVideoElement;
      player.pause();
      player.src = '';
      $('timelapse-player-wrap').classList.add('hidden');
    });
    initCharts(chartStore);
  }

  // Request data that the service may not have cached yet
  client!.sendCommand(1044, { storage_media: 'local', dir: '/', offset: 0, limit: 50 });
  client!.sendCommand(1062, {});
}

function connectToService(): void {
  // Build WS URL relative to current page (works with Vite proxy and production)
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const serviceUrl = `${wsProtocol}//${location.host}/ws`;

  $('connect-error').textContent = '';
  ($('connect-btn') as HTMLButtonElement).disabled = true;
  ($('connect-btn') as HTMLButtonElement).textContent = 'Connecting...';

  client = new WsClient({
    serviceUrl,
    onStateChange(connState) {
      updateConnectionBadge(connState);

      if (connState === 'disconnected') {
        toast('Connection lost — reconnecting...', 'warning');
      }

      if (connState === 'error') {
        ($('connect-btn') as HTMLButtonElement).disabled = false;
        ($('connect-btn') as HTMLButtonElement).textContent = 'Connect';
        $('connect-error').textContent = 'Cannot reach service. Ensure the elegoo-web service is running.';
        toast('Service connection failed', 'error');
      }
    },
    onRegistered(sn, _printerIp) {
      onConnected(sn);
    },
    onInit(initData) {
      // Hydrate state from service snapshot
      if (initData.status) {
        state.setFullStatus(initData.status as any);
      }
      if (initData.attributes) {
        state.setAttributes(initData.attributes as any);
      }
      if (initData.canvas) {
        state.setCanvas(initData.canvas as any);
      }
      if (initData.files && Array.isArray(initData.files)) {
        state.setFiles(initData.files as any);
      }
      if (initData.thumbnail) {
        state.thumbnail = initData.thumbnail as string;
      }
      if (initData.fileTotalLayers != null) {
        state.fileTotalLayers = initData.fileTotalLayers as number;
      }
      if (initData.systemInfo) {
        state.systemInfo = initData.systemInfo as Record<string, unknown>;
      }
      if (initData.bedMesh) {
        state.bedMesh = initData.bedMesh as number[][];
      }
      if (initData.layerTimes && Array.isArray(initData.layerTimes)) {
        const lt = initData.layerTimes as Array<{ layer: number; duration: number; timestamp: number }>;
        if (lt.length > 0) {
          const lastEntry = lt[lt.length - 1];
          state.restoreLayerData(lt, lastEntry.layer, lastEntry.timestamp);
        }
      }
      if (initData.serviceStatus) {
        updateServiceStatus(initData.serviceStatus as Record<string, unknown>);
      }
      // Load chart history from service (replaces localStorage persistence)
      if (initData.chartHistory && Array.isArray(initData.chartHistory)) {
        chartStore.loadHistory(initData.chartHistory as Array<{ t: number; values: Record<string, number> }>);
      }
      scheduleRender();
    },
    onMessage(method, data) {
      state.handleResponse(method, data as Record<string, unknown>);
      if (method === 1044 && client) {
        requestAnimationFrame(() => renderFiles(state, client!));
      }
      if (method === 1051) {
        requestAnimationFrame(() => renderTimelapse(state));
      }
      if (method === 1050 && state.videoUrl) {
        showTimelapsePlayer(state.videoUrl);
      }
    },
    onStatusEvent(data) {
      state.handleStatusEvent(data as Record<string, unknown>);
    },
    onRawMessage(direction, topic, data) {
      logStore.add(direction, topic, data);
    },
    onServiceStatus(data) {
      updateServiceStatus(data);
    },
    onChartData(t, values) {
      chartStore.pushPoint(t, values);
    },
  });

  client.connect();
}

// Connect button handler — now connects to the local service
$('connect-btn').addEventListener('click', () => {
  connectToService();
});

// Auto-connect on page load
connectToService();

// Register PWA service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // SW registration failed — non-critical
  });
}
