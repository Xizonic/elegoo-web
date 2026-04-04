import type { CC2MqttClient } from '../mqtt-client';
import { $ } from './helpers';

let controlsBound = false;

/** Bind all control event handlers */
export function bindControls(client: CC2MqttClient): void {
  if (controlsBound) return;
  controlsBound = true;
  let currentMoveDistance = 10;

  // Print controls
  $('btn-pause').addEventListener('click', () => client.sendCommand(1021, {}));
  $('btn-resume').addEventListener('click', () => client.sendCommand(1023, {}));
  $('btn-stop').addEventListener('click', () => {
    if (confirm('Stop the current print?')) {
      client.sendCommand(1022, {});
    }
  });

  // Temperature controls
  $('btn-set-nozzle').addEventListener('click', () => {
    const val = parseInt(($('set-nozzle-temp') as HTMLInputElement).value);
    if (val >= 0 && val <= 300) {
      client.sendCommand(1028, { extruder: val });
    }
  });
  $('btn-off-nozzle').addEventListener('click', () => {
    client.sendCommand(1028, { extruder: 0 });
  });
  $('btn-set-bed').addEventListener('click', () => {
    const val = parseInt(($('set-bed-temp') as HTMLInputElement).value);
    if (val >= 0 && val <= 120) {
      client.sendCommand(1028, { heater_bed: val });
    }
  });
  $('btn-off-bed').addEventListener('click', () => {
    client.sendCommand(1028, { heater_bed: 0 });
  });

  // Move buttons — XY pad and Z column
  document.querySelectorAll('.move-btn:not(.home-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      const axis = el.dataset.axis;
      const dir = parseInt(el.dataset.dir ?? '1');
      if (axis) {
        client.sendCommand(1027, { axes: axis, distance: currentMoveDistance * dir });
      }
    });
  });

  // Separate home buttons
  $('btn-home-xy').addEventListener('click', () => {
    client.sendCommand(1026, { homed_axes: 'xy' });
  });
  $('btn-home-z').addEventListener('click', () => {
    client.sendCommand(1026, { homed_axes: 'z' });
  });

  // Distance buttons
  document.querySelectorAll('.dist-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentMoveDistance = parseFloat((btn as HTMLElement).dataset.dist ?? '10');
      document.querySelectorAll('.dist-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Speed mode
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = parseInt((btn as HTMLElement).dataset.mode ?? '1');
      client.sendCommand(1031, { mode });
    });
  });

  // Fan toggle controls
  $('fan-model-toggle').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    client.sendCommand(1030, { fan: on ? 166 : 0 }); // ~65% default
  });
  $('fan-aux-toggle').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    client.sendCommand(1030, { aux_fan: on ? 128 : 0 });
  });
  $('fan-case-toggle').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    client.sendCommand(1030, { box_fan: on ? 26 : 0 }); // ~10% default
  });

  // Fan +/- buttons
  document.querySelectorAll('.fan-dec, .fan-inc').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      const fanKey = el.dataset.fan!;
      const step = parseInt(el.dataset.step ?? '13'); // ~5% of 255
      const barId = fanKey === 'fan' ? 'fan-model-bar' : fanKey === 'aux_fan' ? 'fan-aux-bar' : 'fan-case-bar';
      const bar = $(barId) as HTMLElement;
      const currentPct = parseFloat(bar.style.width) || 0;
      const currentVal = Math.round((currentPct / 100) * 255);
      const newVal = Math.max(0, Math.min(255, currentVal + step));
      client.sendCommand(1030, { [fanKey]: newVal });
    });
  });

  // LED toggle
  $('led-toggle').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    client.sendCommand(1029, { power: on ? 1 : 0 });
  });

  // Temperature presets
  document.querySelectorAll('.temp-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      const nozzle = parseInt(el.dataset.nozzle ?? '0');
      const bed = parseInt(el.dataset.bed ?? '0');
      client.sendCommand(1028, { extruder: nozzle, heater_bed: bed });
      ($('set-nozzle-temp') as HTMLInputElement).value = nozzle > 0 ? String(nozzle) : '';
      ($('set-bed-temp') as HTMLInputElement).value = bed > 0 ? String(bed) : '';
    });
  });
}
