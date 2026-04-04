import 'dotenv/config';

export interface BotConfig {
  telegramToken: string;
  chatId: string;
  printerIp: string;
  printerPassword: string;
  cameraEnabled: boolean;
  cameraUrl: string;
  progressInterval: number;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`Missing required env var: ${key}`);
    console.error('Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }
  return value;
}

export function loadConfig(): BotConfig {
  const printerIp = process.env['PRINTER_IP'] || '172.20.100.236';
  return {
    telegramToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    chatId: requireEnv('TELEGRAM_CHAT_ID'),
    printerIp,
    printerPassword: process.env['PRINTER_PASSWORD'] || '123456',
    cameraEnabled: process.env['CAMERA_ENABLED'] !== 'false',
    cameraUrl: process.env['CAMERA_URL'] || `http://${printerIp}:8080`,
    progressInterval: parseInt(process.env['PROGRESS_INTERVAL'] || '25', 10) || 25,
  };
}
