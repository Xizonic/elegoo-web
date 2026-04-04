/**
 * Elegoo CC2 Service — single MQTT connection shared by all consumers.
 *
 * Architecture:
 *   Printer MQTT ←→ MqttBridge (singleton) ←→ StateStore
 *                                               ↓
 *                            ┌──────────────────┼──────────────────┐
 *                            WebSocket        REST/Camera      Telegram
 *                           (browsers)        (snapshots)       (bot)
 */

import { createServer } from 'http';
import { loadConfig, type ServiceConfig } from './config.js';
import { MqttBridge } from './mqtt-bridge.js';
import { StateStore } from './state-store.js';
import { WebSocketTransport } from './ws-transport.js';
import { createRestRouter } from './rest-api.js';
import { TelegramIntegration } from './telegram.js';

const config = loadConfig();

console.log('🖨  Elegoo CC2 Service');
console.log(`   Printer: ${config.printerIp}`);
console.log(`   Service: http://0.0.0.0:${config.servicePort}`);
console.log(`   Camera:  ${config.cameraEnabled ? config.cameraUrl : 'disabled'}`);
if (config.telegramEnabled) {
  console.log(`   Telegram: enabled (progress every ${config.progressInterval}%)`);
}
console.log('');

// --- MQTT Bridge (singleton connection to printer) ---
const bridge = new MqttBridge(config.printerIp, config.printerPassword);

// --- State Store (shared state for all consumers) ---
const store = new StateStore(bridge, config.progressInterval);

// --- HTTP Server ---
const httpServer = createServer(createRestRouter(store, config));

// --- WebSocket Transport (for browser clients) ---
const wsTransport = new WebSocketTransport(httpServer, store, bridge);

// --- Telegram Bot (optional) ---
let telegram: TelegramIntegration | null = null;
if (config.telegramEnabled) {
  telegram = new TelegramIntegration(store, bridge, config);
}

// Provide service references for status panel
wsTransport.setServices({ telegram });

// --- Startup ---
async function start(): Promise<void> {
  // Start MQTT connection
  bridge.connect();

  // Start HTTP + WebSocket server
  httpServer.listen(config.servicePort, '0.0.0.0', () => {
    console.log(`[Service] Listening on :${config.servicePort}`);
  });

  // Start Telegram bot if configured
  if (telegram) {
    await telegram.start();
  }
}

// Graceful shutdown
function shutdown(): void {
  console.log('\nShutting down...');
  wsTransport.close();
  telegram?.stop();
  bridge.disconnect();
  httpServer.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
