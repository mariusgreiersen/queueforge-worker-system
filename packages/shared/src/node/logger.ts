import { pino, type Logger, type LoggerOptions } from 'pino';

export interface LoggerConfig {
  service: string;
  level: string;
  pretty: boolean;
  base?: Record<string, unknown>;
}

const REDACT_PATHS = [
  'password',
  '*.password',
  'redis.password',
  'req.headers.authorization',
  'req.headers.cookie',
];

export function loggerOptions(config: LoggerConfig): LoggerOptions {
  return {
    level: config.level,
    base: { service: config.service, ...config.base },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: { level: (label) => ({ level: label }) },
    ...(config.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}

export function createLogger(config: LoggerConfig): Logger {
  return pino(loggerOptions(config));
}

export type { Logger };
