import winston from 'winston';
import path from 'path';
import { mkdirSync } from 'fs';

const { combine, timestamp, printf, colorize, json } = winston.format;

let logger: winston.Logger;

const prettyConsole = printf(({ level, message, timestamp: ts, module: mod, ...rest }) => {
  const prefix = mod ? `[${mod}]` : '';
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
  return `${ts} ${level} ${prefix} ${message}${extra}`;
});

export function initLogger(dataDir: string): winston.Logger {
  const logDir = path.join(dataDir, 'logs');
  mkdirSync(logDir, { recursive: true });

  logger = winston.createLogger({
    level: 'info',
    format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' })),
    transports: [
      new winston.transports.Console({
        format: combine(colorize(), prettyConsole),
      }),
      new winston.transports.File({
        filename: path.join(logDir, 'service.log'),
        format: combine(json()),
        maxsize: 5 * 1024 * 1024, // 5 MB
        maxFiles: 5,
        tailable: true,
      }),
      new winston.transports.File({
        filename: path.join(logDir, 'error.log'),
        level: 'error',
        format: combine(json()),
        maxsize: 2 * 1024 * 1024, // 2 MB
        maxFiles: 3,
        tailable: true,
      }),
    ],
  });

  return logger;
}

export function getLogger(module?: string): winston.Logger {
  if (!logger) {
    // Fallback: create a console-only logger if initLogger hasn't been called
    logger = winston.createLogger({
      level: 'info',
      format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' })),
      transports: [
        new winston.transports.Console({
          format: combine(colorize(), prettyConsole),
        }),
      ],
    });
  }
  return module ? logger.child({ module }) : logger;
}
