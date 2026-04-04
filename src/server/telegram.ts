/**
 * Telegram integration — plugs into the shared StateStore.
 * No own MQTT connection; uses the service's singleton bridge.
 */

import { Bot, InputFile, InputMediaBuilder } from 'grammy';
import type { Context } from 'grammy';
import type { StateStore, PrintEvent } from './state-store.js';
import type { MqttBridge } from './mqtt-bridge.js';
import type { ServiceConfig } from './config.js';
import { getSnapshot } from './rest-api.js';
import { CRITICAL_EXCEPTIONS } from '../types.js';

/** Escape special chars for Telegram MarkdownV2 */
function esc(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function progressBar(pct: number, length = 20): string {
  const filled = Math.round((pct / 100) * length);
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

function formatEvent(event: PrintEvent): { text: string; urgent: boolean } {
  switch (event.type) {
    case 'connected':
      return { text: `🟢 *Connected to printer*\nSN: \`${event.sn}\``, urgent: false };
    case 'disconnected':
      return { text: '🔴 *Printer disconnected*', urgent: true };
    case 'print_started':
      return { text: `🚀 *Print Started*\n📄 ${esc(event.filename)}`, urgent: false };
    case 'print_completed':
      return { text: `✅ *Print Completed\\!*\n📄 ${esc(event.filename)}\n⏱ Duration: ${esc(formatDuration(event.duration))}`, urgent: false };
    case 'print_failed':
      return { text: `❌ *Print Failed/Stopped*\n📄 ${esc(event.filename)}\n💬 ${esc(event.reason)}`, urgent: true };
    case 'print_progress': {
      const bar = progressBar(event.progress);
      const layerStr = event.totalLayers ? `Layer ${event.layer} of ${event.totalLayers}` : `Layer ${event.layer}`;
      const now = new Date();
      const updatedAt = now.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const eta = new Date(now.getTime() + event.remaining * 1000);
      const etaStr = eta.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
      return {
        text: [
          `📊 *Print Progress: ${event.progress}%*`,
          `\`${bar}\``,
          `📄 ${esc(event.filename)}`,
          `📐 ${esc(layerStr)}`,
          `⏱ Remaining: ${esc(formatDuration(event.remaining))}`,
          `🏁 ETA: ${esc(etaStr)}`,
          `🕐 Updated: ${esc(updatedAt)}`,
        ].join('\n'),
        urgent: false,
      };
    }
    case 'error': {
      const hasCritical = event.codes.some(c => CRITICAL_EXCEPTIONS.has(c));
      const lines = event.names.map((name, i) => {
        const code = event.codes[i];
        const icon = CRITICAL_EXCEPTIONS.has(code) ? '🚨' : '⚠️';
        return `${icon} ${esc(name)} \\(${code}\\)`;
      });
      return { text: `${hasCritical ? '🚨' : '⚠️'} *Printer Error*\n${lines.join('\n')}`, urgent: hasCritical };
    }
    case 'filament_runout':
      return { text: '🧵 *Filament Runout Detected\\!*\nPrinter is paused, please load new filament\\.', urgent: true };
    default:
      return { text: '', urgent: false };
  }
}

export class TelegramIntegration {
  private bot: Bot;
  private liveMessageId: number | null = null;
  private eventQueue: Promise<void> = Promise.resolve();

  constructor(
    private store: StateStore,
    private bridge: MqttBridge,
    private config: ServiceConfig,
  ) {
    this.bot = new Bot(config.telegramToken);
    this.registerCommands();

    // Listen for print events — serialized to avoid race conditions
    store.on('print_event', (event: PrintEvent) => {
      console.log(`[Telegram] Event: ${event.type}`);
      this.eventQueue = this.eventQueue
        .then(() => this.handleEvent(event))
        .catch((err) => {
          console.error(`[Telegram] Unhandled error in event handler: ${(err as Error).message}`);
        });
    });
  }

  private registerCommands(): void {
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        '🖨 *Elegoo CC2 Telegram Bot*\n\n' +
        'Commands:\n' +
        '/status — Current printer status\n' +
        '/photo — Camera snapshot\n' +
        '/help — Show this message',
        { parse_mode: 'MarkdownV2' },
      );
    });

    this.bot.command('help', async (ctx) => {
      await ctx.reply(
        '🖨 *Elegoo CC2 Telegram Bot*\n\n' +
        '/status — Current printer status\n' +
        '/photo — Camera snapshot',
        { parse_mode: 'MarkdownV2' },
      );
    });

    this.bot.command('status', async (ctx) => {
      const summary = this.store.getStatusSummary();
      const photo = await getSnapshot(this.config);
      if (photo) {
        await ctx.replyWithPhoto(new InputFile(photo, 'snapshot.jpg'), {
          caption: summary,
          parse_mode: 'MarkdownV2',
        });
      } else {
        await ctx.reply(summary, { parse_mode: 'MarkdownV2' });
      }
    });

    this.bot.command('photo', async (ctx: Context) => {
      if (!this.config.cameraEnabled) {
        await ctx.reply('📷 Camera is disabled in config\\.');
        return;
      }
      const photo = await getSnapshot(this.config);
      if (!photo) {
        await ctx.reply('📷 Could not fetch camera snapshot\\.');
        return;
      }
      await ctx.replyWithPhoto(new InputFile(photo, 'snapshot.jpg'), {
        caption: '📷 Camera snapshot',
      });
    });
  }

  private async handleEvent(event: PrintEvent): Promise<void> {
    const { text, urgent } = formatEvent(event);
    if (!text) return;

    try {
      const wantPhoto = this.config.cameraEnabled && [
        'print_started', 'print_completed', 'print_failed', 'print_progress',
      ].includes(event.type);
      const photo = wantPhoto ? await getSnapshot(this.config) : null;

      // Progress: update live message in place
      if (event.type === 'print_progress') {
        const edited = await this.updateLiveMessage(text, photo);
        if (!edited) {
          this.liveMessageId = await this.sendNew(text, photo, urgent);
        }
        return;
      }

      // Print started: send new live message
      if (event.type === 'print_started') {
        this.liveMessageId = await this.sendNew(text, photo, urgent);
        return;
      }

      // Print ended: final update then clear
      if (event.type === 'print_completed' || event.type === 'print_failed') {
        const edited = await this.updateLiveMessage(text, photo);
        if (!edited) await this.sendNew(text, photo, urgent);
        this.liveMessageId = null;
        return;
      }

      // All other events: new message
      await this.sendNew(text, photo, urgent);
    } catch (err) {
      console.error(`[Telegram] Failed: ${(err as Error).message}`);
    }
  }

  private async sendNew(text: string, photo: Buffer | null, urgent: boolean): Promise<number | null> {
    const chatId = this.config.telegramChatId;
    if (photo) {
      const msg = await this.bot.api.sendPhoto(chatId, new InputFile(photo, `snapshot_${Date.now()}.jpg`), {
        caption: text,
        parse_mode: 'MarkdownV2',
      });
      console.log(`[Telegram] Sent new photo message ${msg.message_id}`);
      return msg.message_id;
    }
    const msg = await this.bot.api.sendMessage(chatId, text, {
      parse_mode: 'MarkdownV2',
      disable_notification: !urgent,
    });
    console.log(`[Telegram] Sent new text message ${msg.message_id}`);
    return msg.message_id;
  }

  private async updateLiveMessage(text: string, photo: Buffer | null): Promise<boolean> {
    if (!this.liveMessageId) return false;
    const chatId = this.config.telegramChatId;
    try {
      if (photo) {
        const media = InputMediaBuilder.photo(new InputFile(photo, `snapshot_${Date.now()}.jpg`), {
          caption: text,
          parse_mode: 'MarkdownV2',
        });
        await this.bot.api.editMessageMedia(chatId, this.liveMessageId, media);
      } else {
        await this.bot.api.editMessageCaption(chatId, this.liveMessageId, {
          caption: text,
          parse_mode: 'MarkdownV2',
        });
      }
      console.log(`[Telegram] Updated live message ${this.liveMessageId}`);
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('message is not modified')) return true;
      console.warn(`[Telegram] Edit failed (msgId=${this.liveMessageId}): ${msg}`);
      // Message might have been deleted — clear tracking so we send a new one
      this.liveMessageId = null;
      return false;
    }
  }

  private _running = false;

  get isRunning(): boolean { return this._running; }

  async start(): Promise<void> {
    console.log('[Telegram] Starting bot...');
    this.bot.start({
      onStart: () => {
        this._running = true;
        console.log('[Telegram] Bot is running ✓');
      },
    });
  }

  stop(): void {
    this._running = false;
    this.bot.stop();
  }
}
