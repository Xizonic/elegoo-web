/**
 * Singleton MQTT bridge — single connection to the CC2 printer.
 * Emits raw events for consumers (state store, WebSocket, etc.)
 */

import mqtt from 'mqtt';
import { EventEmitter } from 'events';

export interface MqttBridgeEvents {
  connected: [sn: string];
  disconnected: [];
  /** A method response from api_response topic */
  response: [method: number, data: Record<string, unknown>];
  /** A delta status update from api_status topic */
  status: [data: Record<string, unknown>];
  /** Raw MQTT message (for logging) */
  raw: [direction: 'sent' | 'received', topic: string, data: unknown];
}

export class MqttBridge extends EventEmitter {
  private client: mqtt.MqttClient | null = null;
  private clientId: string;
  private requestId: string;
  private sn = '';
  private commandId = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;

  constructor(
    private printerIp: string,
    private password: string,
  ) {
    super();
    this.clientId = this.generateId(10);
    this.requestId = this.generateId(26);
  }

  private generateId(len: number): string {
    const chars = '0123456789abcdef';
    return Array.from({ length: len }, () => chars[Math.floor(Math.random() * 16)]).join('');
  }

  get isConnected(): boolean { return this._connected; }
  get serialNumber(): string { return this.sn; }
  get ip(): string { return this.printerIp; }

  connect(): void {
    const url = `mqtt://${this.printerIp}:1883`;
    console.log(`[MQTT] Connecting to ${url}...`);

    this.client = mqtt.connect(url, {
      clientId: this.clientId,
      username: 'elegoo',
      password: this.password,
      keepalive: 60,
      clean: true,
      reconnectPeriod: 5000,
      protocolVersion: 4,
    });

    this.client.on('connect', () => {
      console.log('[MQTT] Connected, discovering printer...');
      this.client!.subscribe('elegoo/+/api_status');
      if (this.sn) this.register();
    });

    this.client.on('message', (topic: string, payload: Buffer) => {
      this.handleMessage(topic, payload);
    });

    this.client.on('error', (err) => {
      console.error('[MQTT] Error:', err.message);
    });

    this.client.on('close', () => {
      this._connected = false;
      this.stopHeartbeat();
      this.emit('disconnected');
    });
  }

  private handleMessage(topic: string, payload: Buffer): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload.toString());
    } catch {
      return;
    }

    this.emit('raw', 'received', topic, data);

    // Discover SN
    if (topic.includes('/api_status') && !this.sn) {
      const parts = topic.split('/');
      if (parts.length >= 3) {
        this.sn = parts[1];
        console.log(`[MQTT] Discovered printer SN: ${this.sn}`);
        this.client!.unsubscribe('elegoo/+/api_status');
        this.register();
      }
    }

    if (topic.includes('/register_response')) {
      if (data.error === 'ok') {
        console.log('[MQTT] Registered successfully');
        this._connected = true;
        this.subscribeAll();
        this.startHeartbeat();
        // Request initial data
        this.sendCommand(1001, {}); // GET_ATTRIBUTES
        this.sendCommand(1002, {}); // GET_STATUS
        this.sendCommand(2005, {}); // GET_CANVAS_STATUS
        this.emit('connected', this.sn);
      }
    } else if (topic.includes('/api_response')) {
      const method = data.method as number;
      this.emit('response', method, data);
    } else if (topic.includes('/api_status')) {
      this.emit('status', data);
    }
  }

  private register(): void {
    if (!this.client || !this.sn) return;
    this.client.subscribe(`elegoo/${this.sn}/${this.requestId}/register_response`);
    this.client.publish(
      `elegoo/${this.sn}/api_register`,
      JSON.stringify({ client_id: this.clientId, request_id: this.requestId }),
    );
  }

  private subscribeAll(): void {
    if (!this.client || !this.sn) return;
    this.client.subscribe(`elegoo/${this.sn}/api_status`);
    this.client.subscribe(`elegoo/${this.sn}/${this.clientId}/api_response`);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.client && this.sn) {
        this.client.publish(
          `elegoo/${this.sn}/${this.clientId}/api_request`,
          JSON.stringify({ type: 'PING' }),
        );
      }
    }, 10_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  sendCommand(method: number, params: Record<string, unknown>): void {
    if (!this.client || !this.sn) return;
    this.commandId++;
    const topic = `elegoo/${this.sn}/${this.clientId}/api_request`;
    const msg = { id: this.commandId, method, params };
    this.client.publish(topic, JSON.stringify(msg));
    this.emit('raw', 'sent', topic, msg);
  }

  disconnect(): void {
    this.stopHeartbeat();
    this._connected = false;
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }
}
