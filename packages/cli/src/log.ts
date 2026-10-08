import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const LOG_FILE = join(homedir(), '.pilot', 'log.jsonl');

type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
}

function writeLog(level: LogLevel, msg: string): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, msg };
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    // Best-effort — never crash on failed logging.
  }
}

export function logInfo(msg: string): void {
  writeLog('info', msg);
}

export function logWarn(msg: string): void {
  writeLog('warn', msg);
}

export function logError(msg: string): void {
  writeLog('error', msg);
}

export function logFilePath(): string {
  return LOG_FILE;
}
