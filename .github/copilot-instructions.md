# Copilot Instructions for elegoo-web

## Project Overview

A web frontend + backend service for Elegoo Centauri Carbon 2 (CC2) FDM printers. The Node.js service maintains a single MQTT connection to the printer and exposes state to browsers via WebSocket, REST API, and Prometheus metrics. Integrations: Telegram notifications, AI print monitoring (CLIP + VLM + motion detection), Moonraker/OctoPrint compatibility APIs, MCP server.

## Architecture

- **Build**: Vite + TypeScript (vanilla, no framework)
- **Service**: Node.js backend (`src/server/`) — single MQTT connection shared by all consumers
- **Protocol**: MQTT 3.1.1 via mqtt.js (service connects TCP:1883, browsers connect via WS proxy)
- **State**: Service-side `StateStore` with delta merge; browser-side `PrinterState` hydrated from service
- **Transport**: WebSocket (`/ws`) for real-time state, REST (`/api/*`) for snapshots/actions
- **Rendering**: Direct DOM manipulation with `requestAnimationFrame` batching
- **Layout**: Two-panel dashboard — resizable sidebar + main grid, collapsible cards, drag-to-resize
- **3D Preview**: gcode-preview (Three.js WebGL) for toolpath visualization — on-demand rendering only
- **Charts**: Canvas 2D live charts via `setInterval` (10 FPS) — no `requestAnimationFrame`
- **Styling**: Plain CSS with CSS custom properties (dark theme), responsive breakpoints at 1200/800/480px
- **Tabs**: Dashboard, Tools, Settings, Debug, Help

## Key Files

### Service (Backend)
- `src/server/index.ts` — Service entry point, wires all components together
- `src/server/mqtt-bridge.ts` — Singleton MQTT connection to printer (connect, register, heartbeat, commands)
- `src/server/state-store.ts` — Centralized state with event detection (print events, filament, layers, zones, errors)
- `src/server/ws-transport.ts` — WebSocket server for browser clients (init, status, raw message relay, zone broadcasts)
- `src/server/rest-api.ts` — REST API, camera proxy (MJPEG fan-out), Prometheus metrics, file upload/download proxy, static file serving
- `src/server/config.ts` — Environment-based configuration (`.env`)
- `src/server/logger.ts` — Winston structured logging with rotation
- `src/server/telegram.ts` — Telegram bot notifications (print events, progress, snapshots)
- `src/server/ai-monitor.ts` — AI print monitoring (motion detection, CLIP classification, VLM), zone-aware stall suppression
- `src/server/moonraker-compat.ts` — Moonraker API compatibility layer
- `src/server/moonraker-server.ts` — Moonraker standalone server on port 7125
- `src/server/octoprint-compat.ts` — OctoPrint API compatibility layer
- `src/server/mcp-server.ts` — Model Context Protocol server
- `src/server/state-persistence.ts` — Persist/restore state across restarts
- `src/server/print-report-collector.ts` — Collect print data for PDF reports
- `src/server/print-report-pdf.ts` — Generate PDF print reports

### Client (Frontend)
- `src/main.ts` — Entry point, WsClient connect flow, renders on state change, sidebar resize
- `src/ws-client.ts` — WebSocket client connecting to service (handles init, status, zone_change, etc.)
- `src/types.ts` — TypeScript types for the CC2 protocol (status codes, zone detection, helpers)
- `src/printer-state.ts` — Browser-side state with deep-merge delta updates and subscriber pattern
- `src/log-store.ts` — Ring buffer (500 entries) for MQTT message logging
- `src/chart-store.ts` — Ring-buffer time-series store for chart data
- `src/persistence.ts` — Save/restore chart and layer data to localStorage

### UI Modules (`src/ui/`)
- `dashboard.ts` — Thin re-export barrel for all UI modules
- `helpers.ts` — Shared DOM helpers (`$`, `formatTime`, `fanPct`, `escapeHtml`)
- `print-status.ts` — Print status card in sidebar (temps, progress, thumbnail, actions)
- `canvas.ts` — Canvas/AMS spool visualization
- `files.ts` — File browser with thumbnails, popovers, print start
- `controls.ts` — Control event handlers (move, temp, fans, LED, speed)
- `charts.ts` — Canvas 2D live line charts (temps, fans, speed, AI, layers) with zoom/pan
- `gcode-preview.ts` — 3D gcode toolpath visualization (Three.js via gcode-preview library)
- `log.ts` — MQTT log panel with filter, auto-scroll, click-to-expand
- `structured-log.ts` — Structured MQTT log with diff view, pinning, method filtering
- `service-status.ts` — Service health badge (header dropdown) + system info display
- `debug-panel.ts` — Live state tree, change tracking with watched paths, export
- `settings.ts` — Card layout management (sidebar/main/hidden/collapsed), tab switching
- `event-log.ts` — Event log panel (print events, errors, milestones)
- `ai-panel.ts` — AI monitor panel (CLIP scores, VLM results, motion)
- `print-history.ts` — Print history from method 1036
- `print-reports.ts` — Print report viewer (PDF generation)
- `print-dialog.ts` — Print start confirmation dialog with settings
- `maintenance.ts` — Self-check, auto-level, vibration, PID controls (inside toolhead card)
- `timelapse.ts` — Timelapse viewer
- `layer-chart.ts` — Layer time chart
- `filament-editor.ts` — Canvas tray filament editor
- `spool-calc.ts` — Spool calculator (remaining weight/meters)
- `toast.ts` — Toast notification system
- `help.ts` — Help tab with API documentation
- `ui-settings.ts` — UI preference persistence to localStorage
- `styles/main.css` — Full dark theme with two-panel layout, responsive breakpoints

## Dashboard Layout

Two-panel layout with resizable sidebar:
- **Sidebar** (left, 380px default, 260-600px range): Print status, temperatures, canvas, fans, toolhead, speed
- **Main** (right, auto-fill grid): Camera, gcode preview, files, history, reports, timelapse, AI, events, log
- **Header**: Tab navigation, sidebar toggle (◧), service status badge (click for dropdown with system info), connection status
- Cards are collapsible, draggable between sidebar/main, hideable via Settings
- Layout persisted in localStorage as `{sidebar[], main[], hidden[], collapsed[]}`

## CC2 Protocol

The printer runs its own MQTT broker. Communication flow:
1. Connect to `ws://<ip>:9001` with credentials `elegoo`/`123456`
2. Discover SN from status topic wildcard `elegoo/+/api_status`
3. Register: publish `{client_id, request_id}` to `elegoo/<sn>/api_register`
4. Subscribe to `elegoo/<sn>/api_status` (delta updates) and `elegoo/<sn>/<client_id>/api_response`
5. Send commands to `elegoo/<sn>/<client_id>/api_request` as `{id, method, params}`
6. Heartbeat PING every 10 seconds

Key methods: 1001 (attributes), 1002 (full status), 1020-1023 (print control), 1026-1031 (motion/temp/fans), 1044 (file list), 1045 (thumbnail), 1046 (file detail), 2005 (canvas status), 6000 (status event).

**WARNING**: Parameter naming is inconsistent in the CC2 API:
- Method 1045 (thumbnail) requires `file_name` (with underscore)
- Method 1046 (file detail) requires `filename` (no underscore)
- Using the wrong form returns error 1003 (INVALID_PARAMETER)
- This was discovered by comparing against the official Elegoo web interface source (`raw/index-unminified.html`)

**WARNING**: Field names in status updates may differ from documentation:
- `gcode_move` (not `gcode_move_inf` as some docs suggest) — verified via MQTT capture
- Extruder position is `gcode_move.extruder` (not `gcode_move.e`) — verified via MQTT capture
- Code normalizes `gcode_move_inf` → `gcode_move` at ingest for compatibility with older firmware
- Always use the debug capture feature (`POST /api/debug/capture`) to verify actual field names

**WARNING**: Sub-status 1066 is undocumented in the official app but observed on firmware 01.03.01.89 during Canvas filament swaps. It appears between nozzle preheat (1045) and return to printing (2075). We label it 'Filament Change' in `types.ts`.

**WARNING**: Canvas/AMS filament swaps cause false positives:
- The filament sensor reads "empty" during swaps (old filament retracts, new one loads)
- Exception code 1211 (Canvas Filament Runout) fires during normal swaps
- Sub-status stays as machine_status=2 (Printing) throughout the swap — only sub_status changes briefly
- Sub-status flickers to 1045/1066 but spends most time at 2075 (Printing) — `isFilamentChangeSubStatus()` alone is insufficient
- **Primary suppression**: Use `zones.current !== 'print_area'` — toolhead is in cutter/purge area during swaps
- **Secondary suppression**: Use `isFilamentChangeSubStatus()` from `types.ts` for the brief sub-status windows
- Sensor-based filament runout was removed — while `machineStatus === 2`, sensor=0 always means filament change, not runout. Real runouts trigger printer exceptions (109/1211) which are caught and zone-gated.

## Toolhead Zone Detection

Server-side zone tracking based on `gcode_move.x/y` coordinates. Zones are checked in order, first match wins.

| Zone | Center | Boundary | Purpose |
|------|--------|----------|---------|
| `cutter_area` | X=254, Y≈3.5 | X:245-265, Y:-5-15 | Filament cutter, front-right |
| `purge_area` | X=52.5, Y=264 | X:40-65, Y:257-275 | Purge/poop, back-left |
| `print_area` | — | X:0-256, Y:0-256 | Normal printable bed |
| `outside` | — | everything else | Fallback |

- Defined in `types.ts` as `ZONE_DEFINITIONS` with `detectZone(x, y)` helper
- Tracked in `state-store.ts` via `trackZone()` — runs on every status delta (including pre-baseline)
- Broadcast to clients via `zone_change` WebSocket message and included in `init` snapshot
- Client state: `state.zones.current`, `state.zones.previous`, `state.zones.enteredAt`, `state.zones.history`
- Visible in Debug tab live state tree under `zones.*`
- Used by AI monitor to suppress stall detection when toolhead is outside print area
- Used by state-store to suppress filament runout exceptions when toolhead is outside print area

## Camera / Snapshot Architecture

- Single upstream MJPEG connection to printer camera (port 8080), fan-out to all browser clients
- Each extracted JPEG frame is cached in `cachedSnapshot` (5s TTL)
- `getSnapshot()` returns the cached frame if fresh — zero-cost for AI analysis, Telegram, and `/api/snapshot`
- Only falls back to a dedicated HTTP fetch if no active MJPEG stream or stale cache
- Camera can be unreliable during multi-color prints — 503 is expected when camera is unavailable
- **Firmware camera architecture**: The `ai_camera` daemon (separate process) manages UVC camera (`/dev/video0`) and serves MJPEG on port 8080 (15 FPS, max 4 clients, max 300KB/frame). Auto-starts on daemon boot, auto-restarts on IP changes or crashes.
- **Method 1054 (CTRL_LIVE_STREAM)**: `{ Enable: 1 }` enables video streaming, `{ Enable: 0 }` disables. Official Elegoo app sends this via SDCP WebSocket (Cmd 386) on every connect. Response includes `VideoUrl`. Our service currently does NOT send this — it directly connects to port 8080.

Reference: [CC2_PROTOCOL.md](https://github.com/danielcherubini/elegoo-homeassistant/blob/main/docs/CC2_PROTOCOL.md)

## Reference Data (`data/`)

- `data/raw/index-unminified.html` — Deobfuscated official Elegoo web interface (Vue.js app). Source of truth for MQTT method IDs, state enums, and command payload structures.
- `data/CC2_PROTOCOL_REFERENCE.md` — Complete protocol reference extracted from the official app + firmware source: method IDs, state/event/error enums, command payloads, SDCP protocol, file upload mechanism.
- `data/CC2-OFFICIAL-APP-PATTERNS.md` — Patterns observed in the official app behavior.
- `data/GAPS-AND-ISSUES.md` — Known protocol gaps and firmware quirks.

## CC2 Firmware Source (`data/CentauriCarbon2/`)

The CC2 firmware source (Klipper fork by Elegoo) is cloned locally for reference. This is in `.gitignore` — NOT shipped. Key files for protocol work:

### Protocol & API
- `elegoo/common/method.h` — All MQTT method ID definitions (1001–6008)
- `elegoo/common/exception_handler.h` — Hardware exception codes (101–1302) with severity levels
- `elegoo/common/event_handler.h/.cpp` — Event dispatch (print start/stop/pause, filament, errors)
- `elegoo/webhooks.cpp` — Klipper webhooks server (port 34952, closed on stock firmware). Defines `objects/query` with queryable objects including `bed_mesh`.

### Motion & Position
- `elegoo/extras/gcode_move.h/.cpp` — `GCodeMove` class with `get_status()` returning position data (`gcode_move.x/y/z/extruder`). Source of zone detection coordinates.
- `elegoo/extras/homing.h/.cpp` — Homing implementation, `homed_axes` state
- `elegoo/extras/force_move.h/.cpp` — Manual axis movement

### Temperature & Heaters
- `elegoo/extras/heaters.h/.cpp` — Heater manager, temperature control
- `elegoo/extras/heater_bed.h/.cpp` — Bed heater with `get_status()` (temperature, target, power)
- `elegoo/extras/pid_calibrate.h/.cpp` — PID auto-tune (method 1034)
- `elegoo/extras/verify_heater.h/.cpp` — Thermal runaway protection

### Filament & Canvas
- `elegoo/extras/filament_switch_sensor.h/.cpp` — Filament presence detection (`filament_detected`)
- `elegoo/extras/filament_motion_sensor.h/.cpp` — Filament motion/flow sensor
- `elegoo/extras/canvas_dev.h/.cpp` — Canvas/AMS multi-material unit communication
- `elegoo/extras/filament_load_unload.h/.cpp` — Feed/retract filament operations

### Bed & Leveling
- `elegoo/extras/bedmesh/bed_mesh.h` — `ZMesh` class with `get_mesh_matrix()`, `get_probed_matrix()`, `get_mesh_params()`. Bed mesh data exists in Klipper but is NOT exposed via MQTT on stock firmware.
- `elegoo/extras/z_compensation.h/.cpp` — Z compensation / bed mesh application

### Fans & Output
- `elegoo/extras/fan.h/.cpp` — Part/model fan control
- `elegoo/extras/fan_generic.h/.cpp` — Generic fan (aux, chassis)
- `elegoo/extras/controller_fan.h/.cpp` — Controller board fan
- `elegoo/extras/heater_fan.h/.cpp` — Hotend heatbreak fan
- `elegoo/extras/cavity_fan.h/.cpp` — Enclosure fan with temperature control
- `elegoo/extras/led.h/.cpp` — LED light control
- `elegoo/extras/output_pin.h/.cpp` — GPIO output pins

### Print Management
- `elegoo/extras/print_stats.h/.cpp` — Print statistics, `get_status()` returns `machine_status`, `sub_status`, progress, filament used. Only exposes `bed_mesh_detected` (boolean), not mesh point data.
- `elegoo/extras/virtual_sdcard.h/.cpp` — G-code file streaming from storage
- `elegoo/extras/pause_resume.h/.cpp` — Print pause/resume state machine
- `elegoo/extras/idle_timeout.h/.cpp` — Idle timeout handler

### Camera
- `elegoo/extras/ai_camera/module/camera/ai_camera.h/.cpp` — `ai_camera` daemon: UVC camera management, MJPEG streaming on port 8080 (15 FPS, max 4 clients, 300KB/frame max)
- `elegoo/extras/ai_camera/module/camera/aiCamera_cmd.h` — Camera command definitions
- `elegoo/extras/ai_camera/module/camera/aiCamera_status.h` — Camera status codes

### System
- `elegoo/extras/por.h/.cpp` — Power-off recovery, triggers `system("reboot")`
- `elegoo/extras/resonance_tester.h/.cpp` — Input shaper / vibration compensation (method 1033)
- `elegoo/extras/input_shaper.h/.cpp` — Input shaper algorithm
- `elegoo/extras/auto_detect.h/.cpp` — Auto-detection / self-check (method 1035)
- `elegoo/extras/statistics.h/.cpp` — Runtime statistics
- `elegoo/gcode.h/.cpp` — G-code parser, `RESTART`/`FIRMWARE_RESTART` commands

### Important Limitations
- **No arbitrary G-code via MQTT**: The MQTT service is a proprietary layer that only exposes predefined method IDs. Klipper's full G-code interface is not accessible.
- **No bed mesh data via MQTT**: `bed_mesh.get_status()` exists internally but the MQTT service only passes `bed_mesh_detected` (boolean) through `print_stats`.
- **Webhooks port closed**: Klipper's webhooks (port 34952) could expose `objects/query` with full `bed_mesh` data, but the port is firewalled on stock firmware.
- **Camera daemon is separate**: `ai_camera` runs as its own process, independent of the Klipper host. Camera failures don't affect printing.

## Reboot / Restart

- **No MQTT method exists** for rebooting or shutting down the printer. The full method enum (`elegoo/common/method.h`) has no reboot/shutdown command.
- **OTA auto-reboot**: After successful OTA firmware update (method 1039), firmware calls `system("reboot")` (in `update_ota.cpp`).
- **Power-off recovery**: POR circuit triggers `system("reboot")` automatically (in `extras/por.cpp`).
- **GCode RESTART/FIRMWARE_RESTART**: Available via Moonraker REST endpoints on the printer (`POST /printer/restart`). Restarts the Klipper host software only — NOT the Linux system. Defined in `gcode.cpp` → `request_restart()` → `printer->request_exit()`.
- Our Moonraker compat stubs (`moonraker-server.ts`) respond with `ok` but don't proxy to the printer's actual endpoints.

## MQTT Bridge Pitfalls

- **Registration code 3**: Printer allows max 2 MQTT clients. If both slots are taken (e.g. Elegoo Slicer + another client), registration is rejected. The bridge retries on a slow 30s interval until a slot opens.
- **mqtt.js `client.end(true)`**: Permanently destroys the client — no auto-reconnect. For forced reconnects, tear down the old client entirely and call `connect()` again to create a fresh one.
- **Health check accuracy**: Use `bridge.isConnected` / `bridge.brokerConnected` for real MQTT state. Never use `store.attributes` presence as a proxy — persisted state survives disconnects.

## Client Performance Pitfalls

**WARNING**: The `gcode-preview` library (WebGLPreview) runs an internal 60fps `animate()` loop via `requestAnimationFrame` that calls `renderer.render(scene, camera)` every frame. With a loaded gcode model, this leaks ~23 MB/s of heap memory that GC can't reclaim fast enough, causing OOM crashes within minutes.
- After calling `processGCode()`, immediately cancel the animate loop: access `(preview as any).animationFrameId`, call `cancelAnimationFrame()`, and override `animate` to a no-op
- Render on-demand only: orbit controls `change` event for user interaction, throttled `render()` (≤2 FPS) for layer/nozzle updates
- The library's `render()` rebuilds geometry (expensive) — for position-only changes (nozzle), use `renderer.render(scene, camera)` directly

**WARNING**: Event listeners in render functions cause memory leaks:
- Never add `addEventListener` inside functions called on every state update (e.g. `renderFiles()`, `renderStructuredLog()`, `renderCanvas()`)
- Use event delegation: one listener on the container, dispatch via `e.target.closest('.selector')`
- Guard with a `let bound = false` flag or bind in a one-time `init` function

**WARNING**: `requestAnimationFrame` loops and Vite HMR don't mix:
- HMR hot-reloads reset module-level `let animating = false` guards, creating duplicate rAF loops
- Use `setInterval` with a stored timer handle instead — `clearInterval(handle)` works reliably across HMR
- For the chart draw loop: `setInterval(drawAllCharts, 100)` (10 FPS) is plenty for 1 Hz sensor data

## Conventions

- Vanilla TypeScript only — no React/Vue/Svelte
- No unnecessary abstractions — keep it simple and direct
- Use pnpm as package manager
- CSS custom properties for theming (all in `--var` format)
- DOM IDs for element references (no virtual DOM)
- State changes trigger `requestAnimationFrame` render batching
- Use conventional commits (`feat:`, `fix:`, `chore:`, etc.)

## Development

```bash
pnpm install
pnpm dev        # Start Vite dev server on :5173 + backend service
pnpm build      # TypeScript check + Vite production build
```

## Production Deployment

```bash
pnpm build
sudo bash contrib/install.sh
```

- Installs to `/opt/elegooweb/` as systemd service `elegooweb`
- Service user: `elegooweb`, config: `/opt/elegooweb/.env`
- Single port (default 8088): serves frontend, API, WebSocket, and camera proxy
- `contrib/install.sh` handles user creation, file copy, dependency install, systemd setup, and **restarts the service**
- `contrib/uninstall.sh` reverses the installation
- `tsx` must be in `dependencies` (not devDependencies) — required at runtime to execute TypeScript

## Printer Details for Testing

- Printer IP: `172.20.100.236`
- Model: Centauri Carbon 2
- SN: `F01U3UD3798YT8K`
- Firmware: `01.03.01.89`
- MQTT port: 1883 (TCP), 9001 (WebSocket)
- Camera: port 8080 (MJPEG)
- Auth: `elegoo`/`123456` (no access code set)
- Mode: LAN-only (`lan_status: 1`)
