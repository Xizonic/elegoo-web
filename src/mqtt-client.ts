import mqtt from 'mqtt';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface MqttClientOptions {
  printerIp: string;
  password: string;
  onStateChange: (state: ConnectionState) => void;
  onRegistered: (sn: string) => void;
  onMessage: (method: number, data: unknown) => void;
  onStatusEvent: (data: unknown) => void;
  onRawMessage?: (direction: 'sent' | 'received', topic: string, data: unknown) => void;
}

export class CC2MqttClient {
  private client: mqtt.MqttClient | null = null;
  private clientId: string;
  private requestId: string;
  private sn = '';
  private commandId = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;
  private registered = false;
  private heartbeatMissed = 0;
  private opts: MqttClientOptions;

  constructor(opts: MqttClientOptions) {
    this.opts = opts;
    this.clientId = this.generateClientId();
    this.requestId = this.generateRequestId();
  }

  private generateClientId(): string {
    const tsHex = Math.floor(Date.now()).toString(16).slice(-5);
    const rndHex = Math.floor(Math.random() * 4096).toString(16);
    return `0cli${tsHex}${rndHex}`.slice(0, 10);
  }

  private generateRequestId(): string {
    const uuid = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join(
      '',
    );
    const tsHex = Date.now().toString(16);
    return `${uuid}${tsHex}`;
  }

  async discover(): Promise<string> {
    // Discovery is UDP — can't do from browser.
    // We do a direct MQTT connect and get SN from attributes.
    return '';
  }

  connect(): void {
    const { printerIp, password } = this.opts;
    this.opts.onStateChange('connecting');

    const url = `ws://${printerIp}:9001`;
    this.client = mqtt.connect(url, {
      clientId: this.clientId,
      username: 'elegoo',
      password,
      keepalive: 60,
      clean: true,
      reconnectPeriod: 5000,
      protocolVersion: 4, // MQTT 3.1.1
    });

    this.client.on('connect', () => {
      this.opts.onStateChange('connected');
      this.reconnectDelay = 1000; // Reset backoff on successful connect
      // We don't know SN yet — subscribe to wildcard to discover it
      this.client!.subscribe('elegoo/+/api_status', { qos: 1 });
      // Also try registration if we already know the SN
      if (this.sn) {
        this.register();
      }
    });

    this.client.on('message', (topic: string, payload: Buffer) => {
      this.handleMessage(topic, payload);
    });

    this.client.on('error', () => {
      this.opts.onStateChange('error');
    });

    this.client.on('close', () => {
      this.stopHeartbeat();
      this.registered = false;
      this.opts.onStateChange('disconnected');
      this.scheduleReconnect();
    });
  }

  private handleMessage(topic: string, payload: Buffer): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload.toString());
    } catch {
      return;
    }

    this.opts.onRawMessage?.('received', topic, data);

    // Any message from the printer resets the heartbeat miss counter
    this.heartbeatMissed = 0;

    // Discover SN from status topic
    if (topic.includes('/api_status') && !this.sn) {
      const parts = topic.split('/');
      if (parts.length >= 3) {
        this.sn = parts[1];
        // Now register properly
        this.client!.unsubscribe('elegoo/+/api_status');
        this.register();
      }
    }

    if (topic.includes('/register_response')) {
      const error = data.error as string;
      const code = data.code as number | undefined;
      if (error === 'ok') {
        this.registered = true;
        this.opts.onRegistered(this.sn);
        this.subscribeAll();
        this.startHeartbeat();
        // Request initial data
        this.sendCommand(1001, {}); // GET_ATTRIBUTES
        this.sendCommand(1002, {}); // GET_STATUS
        this.sendCommand(2005, {}); // GET_CANVAS_STATUS
      } else if (code === 3) {
        // Too many clients — printer only allows 2 concurrent connections
        this.opts.onStateChange('error');
        console.error(
          'Registration rejected: too many clients (max 2). Disconnect another client and retry.',
        );
      }
    } else if (topic.includes('/api_response')) {
      const method = data.method as number;
      this.opts.onMessage(method, data);
    } else if (topic.includes('/api_status')) {
      this.opts.onStatusEvent(data);
    }
  }

  private register(): void {
    if (!this.client || !this.sn) return;
    this.client.subscribe(`elegoo/${this.sn}/${this.requestId}/register_response`, { qos: 1 });
    this.client.publish(
      `elegoo/${this.sn}/api_register`,
      JSON.stringify({ client_id: this.clientId, request_id: this.requestId }),
    );
  }

  private subscribeAll(): void {
    if (!this.client || !this.sn) return;
    this.client.subscribe(`elegoo/${this.sn}/api_status`, { qos: 1 });
    this.client.subscribe(`elegoo/${this.sn}/${this.clientId}/api_response`, { qos: 1 });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatMissed = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.client && this.sn) {
        this.heartbeatMissed++;
        if (this.heartbeatMissed >= 2) {
          // 2 consecutive heartbeats with no response — reconnect
          console.warn('Heartbeat timeout — reconnecting...');
          this.stopHeartbeat();
          this.registered = false;
          this.client?.end(true);
          return;
        }
        this.client.publish(
          `elegoo/${this.sn}/${this.clientId}/api_request`,
          JSON.stringify({ type: 'PING' }),
        );
      }
    }, 30_000);
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
    this.opts.onRawMessage?.('sent', topic, msg);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      this.client.end();
      this.client = null;
    }
    this.sn = '';
    this.registered = false;
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) return;
      console.log(`[MQTT] Reconnecting in ${this.reconnectDelay}ms...`);
      this.opts.onStateChange('connecting');
      this.connect();
      // Exponential backoff
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }, this.reconnectDelay);
  }

  get serialNumber(): string {
    return this.sn;
  }

  get printerIp(): string {
    return this.opts.printerIp;
  }
}
