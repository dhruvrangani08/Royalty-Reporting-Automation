import { LOG_LEVELS, type LogLevel } from '../config/schema.js';
import { redact } from './redact.js';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface CreateLoggerOptions {
  level: LogLevel;
  /** Credential values to scrub from every line. See credentialValues(). */
  secrets?: readonly string[];
  /** Sink override; defaults to stderr so stdout stays machine-readable. */
  write?: (line: string) => void;
}

/**
 * A minimal structured logger that scrubs known credentials from every line.
 *
 * Deliberately dependency-free and sink-injectable: the redaction guarantee is
 * only worth something if it cannot be bypassed by a transport that formats
 * fields itself.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const threshold = LEVEL_RANK[options.level];
  const secrets = options.secrets ?? [];
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));

  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_RANK[level] < threshold) return;
    const payload = {
      level,
      msg: message,
      ...(fields ?? {}),
    };
    write(redact(safeStringify(payload), secrets));
  };

  const logger = {} as Record<LogLevel, Logger[LogLevel]>;
  for (const level of LOG_LEVELS) {
    logger[level] = (message: string, fields?: Record<string, unknown>) =>
      emit(level, message, fields);
  }
  return logger;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, replaceUnserialisable);
  } catch {
    return JSON.stringify({ level: 'error', msg: 'log payload could not be serialised' });
  }
}

function replaceUnserialisable(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}
