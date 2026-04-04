/**
 * WebSocket transport — serves browser clients.
 *
 * Protocol (JSON messages):
 *
 * Server → Client:
 *   { type: "init", sn, attributes, status, canvas, files, ... , serviceStatus }
 *   { type: "response", method, data }     // forwarded from printer api_response
 *   { type: "status", data }               // forwarded from printer api_status (delta)
 *   { type: "raw", direction, topic, data } // MQTT raw log entry
 *   { type: "connection", connected }       // printer connection state
 *   { type: "service_status", ... }         // periodic service health
 *
 * Client → Server:
 *   { type: "command", method, params }     // forwarded to printer api_request
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { StateStore } from './state-store.js';
import type { MqttBridge } from './mqtt-bridge.js';
import type { TelegramIntegration } from './telegram.js';

export interface ServiceStatusProvider {
  telegram: TelegramIntegration | null;
}

export class WebSocketTransport {
  private wss: WebSocketServer;
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private services: ServiceStatusProvider = { telegram: null };
  private startTime = Date.now();

  constructor(server: Server, private store: StateStore, private bridge: MqttBridge) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      console.log(`[WS] Client connected (total: ${this.wss.clients.size})`);

      // Send current state snapshot on connect
      this.sendInit(ws);

      ws.on('message', (raw) => {
        this.handleClientMessage(ws, raw.toString());
      });

      ws.on('close', () => {
        console.log(`[WS] Client disconnected (total: ${this.wss.clients.size})`);
      });
    });

    // Forward events from state store to all WS clients
    store.on('response', (method: number, data: Record<string, unknown>) => {
      this.broadcast({ type: 'response', method, data });
    });

    store.on('status', (data: Record<string, unknown>) => {
      this.broadcast({ type: 'status', data });
    });

    store.on('raw', (entry: { direction: string; topic: string; data: unknown; ts: number }) => {
      this.broadcast({ type: 'raw', ...entry });
    });

    store.on('chart_data', (point: { t: number; values: Record<string, number> }) => {
      this.broadcast({ type: 'chart_data', ...point });
    });

    bridge.on('connected', () => {
      this.broadcast({ type: 'connection', connected: true, sn: bridge.serialNumber });
      // Re-send full init to all clients after reconnect
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          this.sendInit(client);
        }
      }
    });

    bridge.on('disconnected', () => {
      this.broadcast({ type: 'connection', connected: false });
    });

    // Broadcast service status every 5 seconds
    this.statusInterval = setInterval(() => {
      this.broadcast({ type: 'service_status', ...this.getServiceStatus() });
    }, 5000);
  }

  /** Provide references to optional services for status reporting */
  setServices(services: ServiceStatusProvider): void {
    this.services = services;
  }

  private getServiceStatus(): Record<string, unknown> {
    return {
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      mqtt: this.bridge.isConnected ? 'connected' : 'disconnected',
      printerSn: this.bridge.serialNumber || null,
      printerIp: this.bridge.ip,
      wsClients: this.wss.clients.size,
      telegram: this.services.telegram
        ? (this.services.telegram.isRunning ? 'running' : 'stopped')
        : 'disabled',
      camera: this.store.status?.external_device?.camera ? 'available' : 'unavailable',
    };
  }

  private sendInit(ws: WebSocket): void {
    const msg = {
      type: 'init',
      connected: this.bridge.isConnected,
      sn: this.bridge.serialNumber,
      printerIp: this.bridge.ip,
      attributes: this.store.attributes,
      status: this.store.status,
      canvas: this.store.canvas,
      files: this.store.files,
      thumbnail: this.store.thumbnail,
      thumbnailFailed: this.store.thumbnailFailed,
      fileTotalLayers: this.store.fileTotalLayers,
      systemInfo: this.store.systemInfo,
      timelapseList: this.store.timelapseList,
      videoUrl: this.store.videoUrl,
      bedMesh: this.store.bedMesh,
      layerTimes: this.store.layerTimes,
      chartHistory: this.store.getChartHistory(),
      serviceStatus: this.getServiceStatus(),
    };
    ws.send(JSON.stringify(msg));
  }

  private handleClientMessage(_ws: WebSocket, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'command') {
      const method = msg.method as number;
      const params = (msg.params as Record<string, unknown>) ?? {};
      if (typeof method === 'number') {
        this.bridge.sendCommand(method, params);
      }
    }
  }

  private broadcast(data: unknown): void {
    const json = JSON.stringify(data);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  close(): void {
    if (this.statusInterval) clearInterval(this.statusInterval);
    this.wss.close();
  }
}
