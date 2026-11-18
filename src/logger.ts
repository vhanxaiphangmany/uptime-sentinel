import type { LogLevel } from "./config.ts";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Fields = Record<string, unknown>;

export type Logger = {
  readonly level: LogLevel;
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  child(bindings: Fields): Logger;
};

export type LogSink = (line: string) => void;

const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

function serialiseError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/**
 * Structured JSON logger. One JSON object per line so Loki / CloudWatch / `jq`
 * can parse it without a grok pattern.
 */
export function createLogger(level: LogLevel, bindings: Fields = {}, sink: LogSink = stdoutSink): Logger {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const emit = (entryLevel: LogLevel, message: string, fields?: Fields): void => {
    if (LEVELS[entryLevel] < threshold) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: entryLevel,
      msg: message,
      ...bindings,
    };
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        record[key] = key === "err" ? serialiseError(value) : value;
      }
    }
    sink(JSON.stringify(record));
  };

  return {
    level,
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (extra) => createLogger(level, { ...bindings, ...extra }, sink),
  };
}
