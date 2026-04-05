/**
 * Singleton MQTT bridge — single connection to the CC2 printer.
 * Emits raw events for consumers (state store, WebSocket, etc.)
 */

import mqtt from 'mqtt';
import { EventEmitter } from 'events';
import { getLogger } from './logger.js';

const log = getLogger('MQTT');

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
  private registerTimer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;
  private _brokerConnected = false;
  private _registerAttempts = 0;

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
  get brokerConnected(): boolean { return this._brokerConnected; }
  get registerAttempts(): number { return this._registerAttempts; }
  get serialNumber(): string { return this.sn; }
  get ip(): string { return this.printerIp; }

  connect(): void {
    const url = `mqtt://${this.printerIp}:1883`;
    log.info(`Connecting to ${url}...`);

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
      log.info('Connected, discovering printer...');
      this._brokerConnected = true;
      // Subscribe broadly for SN discovery — printer may not publish
      // api_status until a client registers, so catch any elegoo topic
      this.client!.subscribe('elegoo/#');
      if (this.sn) this.register();
    });

    this.client.on('message', (topic: string, payload: Buffer) => {
      this.handleMessage(topic, payload);
    });

    this.client.on('error', (err) => {
      log.error(`Error: ${err.message}`);
    });

    this.client.on('close', () => {
      this._connected = false;
      this._brokerConnected = false;
      this._registerAttempts = 0;
      this.stopHeartbeat();
      this.stopRegisterRetry();
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

    // Discover SN from any elegoo/<sn>/... topic
    if (!this.sn && topic.startsWith('elegoo/')) {
      const parts = topic.split('/');
      if (parts.length >= 3 && parts[1].length > 0) {
        this.sn = parts[1];
        log.info(`Discovered printer SN: ${this.sn}`);
        this.client!.unsubscribe('elegoo/#');
        this.register();
      }
    }

    if (topic.includes('/register_response')) {
      if (data.error === 'ok') {
        log.info('Registered successfully');
        this._connected = true;
        this._registerAttempts = 0;
        this.stopRegisterRetry();
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
    this.sendRegister();
    // Retry registration every 5 seconds until successful
    this.stopRegisterRetry();
    this.registerTimer = setInterval(() => {
      if (this._connected) {
        this.stopRegisterRetry();
        return;
      }
      log.info('Retrying registration...');
      this._registerAttempts++;
      this.sendRegister();
    }, 5000);
  }

  private sendRegister(): void {
    if (!this.client || !this.sn) return;
    this.client.publish(
      `elegoo/${this.sn}/api_register`,
      JSON.stringify({ client_id: this.clientId, request_id: this.requestId }),
    );
  }

  private stopRegisterRetry(): void {
    if (this.registerTimer) {
      clearInterval(this.registerTimer);
      this.registerTimer = null;
    }
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
    this.stopRegisterRetry();
    this._connected = false;
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }
}
