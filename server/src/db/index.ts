/** SQLite initialization and shared database access. Provider models are discovered at runtime. */
import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initEncryptionKey } from '../lib/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/freeapi.db');
const MODEL_DISCOVERY_FILTER_VERSION = 'free-catalog-v1';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? DB_PATH;
  if (resolvedPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  db = new Database(resolvedPath);
  if (resolvedPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createTables(db);
  migrateIntelligenceScores(db);
  disableLegacyCatalog(db);
  disableCreditBasedProviderCatalogs(db);
  invalidateChangedModelDiscovery(db);
  migrateRequestMetrics(db);
  initEncryptionKey(db);
  ensureUnifiedKey(db);

  console.log(`Database initialized at ${resolvedPath}`);
  return db;
}

function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      monthly_token_budget TEXT NOT NULL DEFAULT '',
      context_window INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fallback_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL REFERENCES models(id),
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_syncs (
      platform TEXT PRIMARY KEY,
      last_succeeded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS modelgrep_scores (
      model_id TEXT PRIMARY KEY,
      intelligence_score REAL NOT NULL CHECK(intelligence_score >= 0 AND intelligence_score <= 100)
    );

    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
    CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);
  `);
}

/** Adds AA-backed scores without rewriting legacy installations' model catalog. */
function migrateIntelligenceScores(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(models)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'intelligence_score')) {
    db.prepare('ALTER TABLE models ADD COLUMN intelligence_score REAL').run();
  }
}

function migrateRequestMetrics(db: Database.Database): void {
  const hasTtfbMetric = (db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>)
    .some(column => column.name === 'ttfb_ms');
  if (!hasTtfbMetric) db.prepare('ALTER TABLE requests ADD COLUMN ttfb_ms INTEGER').run();
}

function disableLegacyCatalog(db: Database.Database): void {
  const migrationKey = 'dynamic_model_catalog_v1';
  const migrated = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(migrationKey);
  if (migrated) return;

  // Existing installations populated this table from the retired static catalog.
  // A successful provider sync re-enables only models the provider currently lists.
  db.prepare('UPDATE models SET enabled = 0').run();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(migrationKey, 'complete');
}

function disableCreditBasedProviderCatalogs(db: Database.Database): void {
  const migrationKey = 'disabled_nvidia_credit_catalog_v1';
  const migrated = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(migrationKey);
  if (migrated) return;

  // NVIDIA's API lists credit-based routes alongside any trial access. They are
  // not a recurring free tier, so exclude them from the free fallback catalog.
  db.transaction(() => {
    db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'nvidia'").run();
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(migrationKey, 'complete');
  })();
}

function invalidateChangedModelDiscovery(db: Database.Database): void {
  const settingKey = 'model_discovery_filter_version';
  const current = db.prepare('SELECT value FROM settings WHERE key = ?').get(settingKey) as { value: string } | undefined;
  if (current?.value === MODEL_DISCOVERY_FILTER_VERSION) return;

  db.transaction(() => {
    db.prepare('DELETE FROM model_syncs').run();
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(settingKey, MODEL_DISCOVERY_FILTER_VERSION);
  })();
}

function ensureUnifiedKey(db: Database.Database): void {
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string } | undefined;
  if (existing) return;

  const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  db.prepare("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)").run(key);
  console.log(`\n  Your unified API key: ${key}\n`);
}

export function getUnifiedApiKey(): string {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string };
  return row.value;
}

export function regenerateUnifiedKey(): string {
  const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  getDb().prepare("UPDATE settings SET value = ? WHERE key = 'unified_api_key'").run(key);
  return key;
}
