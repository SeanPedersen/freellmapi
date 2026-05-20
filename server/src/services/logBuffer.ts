import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE_PATH = path.resolve(__dirname, '../../data/server.log');

const V1_MAX_ENTRIES = 5000;
const OTHER_MAX_ENTRIES = 500;

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  message: string;
}

let nextId = 1;
const v1Buffer: LogEntry[] = [];
const otherBuffer: LogEntry[] = [];

function isV1Entry(message: string): boolean {
  return message.includes('/v1/')
    || message.startsWith('[Model Response]')
    || message.startsWith('[Proxy]')
    || message.startsWith('[Request]');
}

function appendToDisk(entry: LogEntry): void {
  try {
    const dataDir = path.dirname(LOG_FILE_PATH);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(LOG_FILE_PATH, JSON.stringify(entry) + '\n');
  } catch {
    // don't crash the server if logging fails
  }
}

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(LOG_FILE_PATH)) return;
    const content = fs.readFileSync(LOG_FILE_PATH, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const all = lines.flatMap(line => {
      try { return [JSON.parse(line) as LogEntry]; }
      catch { return []; }
    });
    const recent = all.slice(-V1_MAX_ENTRIES);
    v1Buffer.push(...recent);
    if (recent.length > 0) {
      nextId = Math.max(...recent.map(e => e.id)) + 1;
    }
    // Trim the file on startup to prevent unbounded growth
    if (all.length > V1_MAX_ENTRIES) {
      try {
        fs.writeFileSync(LOG_FILE_PATH, recent.map(e => JSON.stringify(e)).join('\n') + '\n');
      } catch { /* ignore */ }
    }
  } catch {
    // ignore read errors on startup
  }
}

loadFromDisk();

function push(level: LogLevel, args: unknown[]) {
  const message = args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const entry: LogEntry = { id: nextId++, timestamp: new Date().toISOString(), level, message };

  if (isV1Entry(message)) {
    v1Buffer.push(entry);
    if (v1Buffer.length > V1_MAX_ENTRIES) v1Buffer.shift();
    appendToDisk(entry);
  } else {
    otherBuffer.push(entry);
    if (otherBuffer.length > OTHER_MAX_ENTRIES) otherBuffer.shift();
  }
}

const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);

console.log = (...args: unknown[]) => { origLog(...args); push('info', args); };
console.warn = (...args: unknown[]) => { origWarn(...args); push('warn', args); };
console.error = (...args: unknown[]) => { origError(...args); push('error', args); };

export function getLogs(limit = V1_MAX_ENTRIES + OTHER_MAX_ENTRIES): LogEntry[] {
  const combined = [...v1Buffer, ...otherBuffer].sort((a, b) => a.id - b.id);
  return combined.slice(-limit).reverse();
}
