import { CC2MqttClient } from './mqtt-client';
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
} from './ui/dashboard';
import { renderLog, bindLogControls } from './ui/log';
import { startPersistence, restoreIfMatch } from './persistence';

const state = new PrinterState();
const logStore = new LogStore();
const chartStore = new ChartStore();
let client: CC2MqttClient | null = null;
let renderScheduled = false;
let dataRestored = false;

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

      // Feed chart data from current state
      const s = state.status;
      if (s) {
        const fanPct = (v: number) => Math.round((v / 255) * 100);
        chartStore.push({
          nozzle: s.extruder?.temperature ?? 0,
          nozzle_tgt: s.extruder?.target ?? 0,
          bed: s.heater_bed?.temperature ?? 0,
          bed_tgt: s.heater_bed?.target ?? 0,
          chamber: s.ztemperature_sensor?.temperature ?? 0,
          fan_model: fanPct(s.fans?.fan?.speed ?? 0),
          fan_aux: fanPct(s.fans?.aux_fan?.speed ?? 0),
          fan_case: fanPct(s.fans?.box_fan?.speed ?? 0),
        });
      }
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

// Connect button handler
$('connect-btn').addEventListener('click', () => {
  const ip = ($('printer-ip') as HTMLInputElement).value.trim();
  const password = ($('printer-password') as HTMLInputElement).value || '123456';

  if (!ip) {
    $('connect-error').textContent = 'Please enter a printer IP address';
    return;
  }

  $('connect-error').textContent = '';
  ($('connect-btn') as HTMLButtonElement).disabled = true;
  ($('connect-btn') as HTMLButtonElement).textContent = 'Connecting...';

  client = new CC2MqttClient({
    printerIp: ip,
    password,
    onStateChange(connState) {
      updateConnectionBadge(connState);

      if (connState === 'disconnected') {
        toast('Connection lost — reconnecting...', 'warning');
      }

      if (connState === 'error') {
        ($('connect-btn') as HTMLButtonElement).disabled = false;
        ($('connect-btn') as HTMLButtonElement).textContent = 'Connect';
        $('connect-error').textContent = 'Connection failed. Check IP and ensure printer is in LAN-only mode.';
        toast('Connection failed', 'error');
      }
    },
    onRegistered(sn) {
      console.log(`Registered with printer SN: ${sn}`);
      toast(`Connected to printer ${sn}`, 'success');
      // Show dashboard, hide connect dialog
      $('connect-dialog').classList.add('hidden');
      $('dashboard').classList.remove('hidden');
      // Bind control handlers (idempotent — only binds once)
      bindControls(client!);
      bindLogControls(logStore);
      bindStructuredLogControls(logStore);
      bindFileControls(client!);
      setCanvasClient(client!);
      setTimelapseClient(client!);
      // Timelapse buttons
      $('timelapse-refresh').addEventListener('click', () => requestTimelapseList());
      $('timelapse-close').addEventListener('click', () => {
        const player = $('timelapse-player') as HTMLVideoElement;
        player.pause();
        player.src = '';
        $('timelapse-player-wrap').classList.add('hidden');
      });
      // Init live charts
      initCharts(chartStore);
      // Start data persistence
      startPersistence(state, chartStore);
      // Request file list
      client!.sendCommand(1044, { storage_media: 'local', dir: '/', offset: 0, limit: 50 });
      // Request system info
      client!.sendCommand(1062, {});
    },
    onMessage(method, data) {
      state.handleResponse(method, data as Record<string, unknown>);
      // Restore persisted data after first full status
      if (method === 1002 && !dataRestored) {
        dataRestored = true;
        if (restoreIfMatch(state, chartStore)) {
          toast('Restored session data from previous page load', 'success');
        }
      }
      // Render files when file list arrives
      if (method === 1044 && client) {
        requestAnimationFrame(() => renderFiles(state, client!));
      }
      // Render timelapse list when it arrives
      if (method === 1051) {
        requestAnimationFrame(() => renderTimelapse(state));
      }
      // Show video player when URL arrives
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
  });

  client.connect();
});

// Allow Enter key in IP field
$('printer-ip').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('connect-btn').click();
});

// Register PWA service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // SW registration failed — non-critical
  });
}
