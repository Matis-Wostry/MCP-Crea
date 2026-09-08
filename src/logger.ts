/**
 * Centralised logging, written to `stderr`: `stdout` is reserved for the MCP
 * server's JSON-RPC protocol.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const WEIGHTS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const ALIASES: Record<string, LogLevel> = {
  debug: 'debug',
  verbose: 'debug',
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  silent: 'silent',
  none: 'silent',
};

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase().trim();
  return ALIASES[raw] ?? 'info';
}

const COLORS = {
  grey: '\u001b[90m',
  blue: '\u001b[34m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  reset: '\u001b[0m',
} as const;

const colorsEnabled = process.stderr.isTTY === true && process.env.NO_COLOR === undefined;

function colorize(text: string, color: keyof typeof COLORS): string {
  if (!colorsEnabled) return text;
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function write(level: LogLevel, label: string, color: keyof typeof COLORS, args: unknown[]): void {
  if (WEIGHTS[level] < WEIGHTS[currentLevel()]) return;

  const prefix = `${colorize(timestamp(), 'grey')} ${colorize(label.padEnd(5), color)}`;
  const body = args
    .map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.stack ?? value.message;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');

  process.stderr.write(`${prefix} ${body}\n`);
}

export const logger = {
  debug: (...args: unknown[]): void => write('debug', 'DEBUG', 'grey', args),
  info: (...args: unknown[]): void => write('info', 'INFO', 'blue', args),
  success: (...args: unknown[]): void => write('info', 'OK', 'green', args),
  warn: (...args: unknown[]): void => write('warn', 'WARN', 'yellow', args),
  error: (...args: unknown[]): void => write('error', 'ERR', 'red', args),
};

/** Turns an unknown thrown value into a readable message. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
