# elegoo-web

A web frontend + backend service for Elegoo Centauri Carbon 2 (CC2) FDM printers. The Node.js service maintains a single MQTT connection to the printer and exposes state to browsers via WebSocket, REST API, and Prometheus metrics.

## Features

- **Two-panel dashboard**: Resizable sidebar + main grid, collapsible/reorderable cards, responsive breakpoints
- **Print status**: Progress with thumbnail, temperatures, fan speeds, toolhead position, active filament
- **3D gcode preview**: Three.js toolpath visualization with layer follow mode and nozzle tracking
- **Live charts**: Temperature, fan speed, print speed, AI confidence, and layer time graphs with zoom/pan
- **Canvas/AMS display**: Spool-style filament slots with colors, types, filament editing, load/unload
- **Camera feed**: Live MJPEG stream with single-upstream fan-out proxy, snapshot button, fullscreen overlay
- **Printer control**: Temperature presets, fans, speed mode, LED toggle, XY/Z movement, emergency stop
- **Print management**: File browser with thumbnails/popovers, start dialog, pause/resume/stop, USB support
- **Zone detection**: Server-side toolhead zone tracking (print area, cutter, purge) for AI/event suppression
- **AI print monitoring**: Motion detection, CLIP/SigLIP classification, VLM analysis, zone-aware stall suppression
- **Telegram notifications**: Print events, progress updates, camera snapshots
- **MQTT Log**: Real-time structured log with diff view, method filtering, pinning
- **Debug panel**: Live state tree with change tracking, watched paths, export
- **Event log**: Print events, errors, milestones with timestamps and severity
- **Print history**: Method 1036 history with auto-load on connect
- **Print reports**: PDF generation with stats, charts, snapshots
- **Timelapse viewer**: Download/play timelapse videos
- **Bed mesh**: Heatmap/3D visualization of auto-leveling data
- **Spool calculator**: Remaining weight/meters from measured thickness
- **Moonraker/OctoPrint compatibility**: API layers for Mainsail/Fluidd/KlipperScreen and OctoPrint clients
- **MCP server**: Model Context Protocol for AI agent integration
- **Prometheus metrics**: `/api/metrics/prometheus` endpoint for monitoring
- **PWA support**: Installable app with manifest + service worker
- **Dark theme**: Modern UI with CSS custom properties, responsive at 1200/800/480px breakpoints

## How It Works

The Node.js backend service (`src/server/`) connects to the printer's MQTT broker over TCP:1883 and acts as a bridge:
- **WebSocket** (`/ws`): Real-time state updates pushed to all connected browsers
- **REST API** (`/api/*`): Snapshots, file operations, camera proxy, commands
- **Static files**: Serves the built `dist/` frontend in production (SPA fallback to `index.html`)
- **Prometheus** (`/api/metrics`): Printer telemetry for monitoring

The CC2 printer runs its own MQTT broker on two ports:
- **Port 1883** — MQTT over TCP (used by the service)
- **Port 9001** — MQTT over WebSocket (legacy direct-connect mode)

### Protocol

Communication uses the CC2 MQTT protocol:
1. **Discovery**: UDP broadcast on port 52700 (not available from browser — IP entered manually)
2. **Connect**: MQTT 3.1.1 over WebSocket, auth `elegoo`/`123456` (or access code)
3. **Register**: Publish to `elegoo/<sn>/api_register`
4. **Subscribe**: `elegoo/<sn>/api_status` for delta status updates
5. **Commands**: Publish to `elegoo/<sn>/<client_id>/api_request`
6. **Heartbeat**: PING every 10 seconds to maintain connection

See [CC2 Protocol Documentation](https://github.com/danielcherubini/elegoo-homeassistant/blob/main/docs/CC2_PROTOCOL.md) for the full protocol reference.

## Prerequisites

- Node.js 20+
- pnpm
- An Elegoo CC2 printer on the same network, set to **LAN-only mode**

## Quick Start

```bash
pnpm install
pnpm dev
```

This starts both the backend service and Vite dev server. Open `http://localhost:5173`.

## Build

```bash
pnpm build
```

Production output goes to `dist/`. The service serves it automatically on port 8088.

## Production Deployment

Install as a systemd service:

```bash
pnpm build
sudo bash contrib/install.sh
```

This creates:
- Service user `elegooweb`
- Installation at `/opt/elegooweb/`
- systemd unit `elegooweb.service` (auto-start on boot)
- Default `.env` config at `/opt/elegooweb/.env`

Edit `/opt/elegooweb/.env` to configure printer IP, Telegram, AI monitoring, etc.

```bash
sudo systemctl status elegooweb       # Check status
sudo journalctl -u elegooweb -f       # Tail logs
sudo systemctl restart elegooweb      # Restart after config changes
sudo bash contrib/uninstall.sh        # Uninstall
```

Web UI: `http://<host>:8088`

## Project Structure

```
src/
├── main.ts              # Entry point, WsClient, render loop, sidebar resize
├── ws-client.ts         # WebSocket client (connects to service, not printer)
├── types.ts             # CC2 protocol types, status codes, zone detection
├── printer-state.ts     # Browser-side state with delta merge + zones
├── log-store.ts         # Ring buffer (500 entries) for MQTT log
├── chart-store.ts       # Ring-buffer time-series store for charts
├── persistence.ts       # Save/restore chart + layer data to localStorage
├── server/
│   ├── index.ts             # Service entry point
│   ├── mqtt-bridge.ts       # Singleton MQTT connection to printer
│   ├── state-store.ts       # Centralized state, event detection, zone tracking
│   ├── ws-transport.ts      # WebSocket server for browsers
│   ├── rest-api.ts          # REST API, MJPEG fan-out proxy, Prometheus
│   ├── config.ts            # Environment-based configuration (.env)
│   ├── logger.ts            # Winston structured logging with rotation
│   ├── telegram.ts          # Telegram bot notifications
│   ├── ai-monitor.ts        # AI print monitoring (CLIP + VLM + motion)
│   ├── moonraker-compat.ts  # Moonraker API compatibility
│   ├── moonraker-server.ts  # Moonraker standalone server (:7125)
│   ├── octoprint-compat.ts  # OctoPrint API compatibility
│   ├── mcp-server.ts        # Model Context Protocol server
│   ├── state-persistence.ts # Persist/restore state across restarts
│   ├── print-report-collector.ts  # Collect print data for reports
│   └── print-report-pdf.ts       # PDF report generation
├── ui/
│   ├── dashboard.ts       # Re-export barrel for all UI modules
│   ├── helpers.ts         # Shared DOM/formatting utilities
│   ├── print-status.ts    # Print status sidebar card
│   ├── service-status.ts  # Header badge + dropdown (service health + system info)
│   ├── canvas.ts          # Canvas/AMS spool visualization
│   ├── files.ts           # File browser with popovers
│   ├── controls.ts        # Control event handlers
│   ├── charts.ts          # Canvas 2D live charts with zoom/pan
│   ├── gcode-preview.ts   # 3D gcode toolpath (Three.js)
│   ├── log.ts             # MQTT log panel
│   ├── structured-log.ts  # Structured log with diff/pin/filter
│   ├── debug-panel.ts     # Live state tree, change tracking, export
│   ├── settings.ts        # Card layout + tab management
│   ├── event-log.ts       # Print event log
│   ├── ai-panel.ts        # AI monitor panel
│   ├── print-history.ts   # Print history
│   ├── print-reports.ts   # PDF print reports
│   ├── print-dialog.ts    # Print start confirmation dialog
│   ├── maintenance.ts     # Self-check, auto-level, vibration, PID
│   ├── bed-mesh.ts        # Bed mesh visualization
│   ├── timelapse.ts       # Timelapse viewer
│   ├── layer-chart.ts     # Layer time chart
│   ├── filament-editor.ts # Canvas filament editor
│   ├── spool-calc.ts      # Spool calculator
│   ├── toast.ts           # Toast notifications
│   ├── help.ts            # Help tab / API docs
│   └── ui-settings.ts    # UI preference persistence
└── styles/
    └── main.css           # Dark theme, two-panel layout, responsive
```

## Supported Printers

- Elegoo Centauri Carbon 2
- Other CC2-protocol printers (Elegoo Cura, etc.)

Resin printers (Mars, Saturn) use a different protocol (SDCP over WebSocket) and are not currently supported.

## Limitations

- **Max 2 MQTT connections**: The printer limits concurrent MQTT clients. The service uses one slot.
- **No UDP discovery**: Browsers can't send UDP — printer IP must be configured in `.env`.
- **Camera CORS**: The MJPEG stream on port 8080 is proxied through the service to avoid CORS issues.
- **LAN-only**: Cloud mode is not supported.

## Protocol Quirks

- Method 1045 (thumbnail) requires `file_name` (with underscore), but 1046 (file detail) requires `filename` (no underscore). Using the wrong form returns error 1003.
- `total_layer` is often missing from delta status updates — fetched separately via method 1046.
- Fan speed is PWM 0-255, not percentage. Convert: `pct = Math.round(speed / 255 * 100)`.
- `gcode_move` (not `gcode_move_inf`) — code normalizes the old name at ingest for firmware compat.
- Sub-status 1066 is undocumented but observed during Canvas filament swaps (firmware 01.03.01.89).
- Canvas filament swaps: sub_status mostly stays at 2075 (Printing) with brief flickers to 1045/1066; `zones.current` is the reliable indicator (toolhead moves to cutter/purge areas).
- Sensor-based filament runout (`filament_detected` 1→0) during `machineStatus === 2` always means filament change, never actual runout. Real runouts trigger exception codes 109/1211.

## Zone Detection

Server-side toolhead zone tracking based on `gcode_move.x/y` coordinates:

| Zone | Center | Boundary | Purpose |
|------|--------|----------|---------|
| `cutter_area` | X=254, Y≈3.5 | X:245-265, Y:-5-15 | Filament cutter |
| `purge_area` | X=52.5, Y=264 | X:40-65, Y:257-275 | Purge/poop area |
| `print_area` | — | X:0-256, Y:0-256 | Normal printing |
| `outside` | — | everything else | Fallback |

Used to suppress false AI stall alerts and filament runout events during Canvas filament changes.

## Credits

- [gcode-preview](https://github.com/remcoder/gcode-preview) — Three.js gcode toolpath visualization
- [elegoo-link](https://github.com/ELEGOO-3D/elegoo-link) — Elegoo's official C++ SDK
- [elegoo-homeassistant](https://github.com/danielcherubini/elegoo-homeassistant) — CC2 protocol documentation
- [Fluidd](https://github.com/fluidd-core/fluidd) — UI design inspiration
- [mqtt.js](https://github.com/mqttjs/MQTT.js) — MQTT client library

## License

MIT
