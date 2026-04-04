import 'dotenv/config';

export interface ServiceConfig {
  // Printer
  printerIp: string;
  printerPassword: string;

  // Service
  servicePort: number;

  // Camera
  cameraEnabled: boolean;
  cameraUrl: string;

  // Telegram (optional)
  telegramEnabled: boolean;
  telegramToken: string;
  telegramChatId: string;
  progressInterval: number;
}

function env(key: string, fallback = ''): string {
  return process.env[key] || fallback;
}

export function loadConfig(): ServiceConfig {
  const printerIp = env('PRINTER_IP', '172.20.100.236');
  const telegramToken = env('TELEGRAM_BOT_TOKEN');
  const telegramChatId = env('TELEGRAM_CHAT_ID');

  return {
    printerIp,
    printerPassword: env('PRINTER_PASSWORD', '123456'),
    servicePort: parseInt(env('SERVICE_PORT', '8088'), 10),
    cameraEnabled: env('CAMERA_ENABLED') !== 'false',
    cameraUrl: env('CAMERA_URL') || `http://${printerIp}:8080`,
    telegramEnabled: !!(telegramToken && telegramChatId),
    telegramToken,
    telegramChatId,
    progressInterval: parseInt(env('PROGRESS_INTERVAL', '25'), 10) || 25,
  };
}
