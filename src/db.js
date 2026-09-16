import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, UPLOAD_DIR, PUBLIC_DIR, DB_PATH } from "./config.js";

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash BLOB NOT NULL,
  pass_salt BLOB NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  weight_kg REAL NOT NULL,
  calories INTEGER NOT NULL,
  exercise_kcal INTEGER NOT NULL DEFAULT 0,
  exercise_src TEXT NOT NULL DEFAULT 'est',
  flags INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_entries_user_day ON entries(user_id, day);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  stored TEXT NOT NULL UNIQUE,
  orig_name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_entry ON media(entry_id);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
CREATE TABLE IF NOT EXISTS profile (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  goal_kg REAL,
  goal_day TEXT,
  activity REAL NOT NULL DEFAULT 1.2,
  cycle_enabled INTEGER NOT NULL DEFAULT 0,
  cycle_last TEXT,
  cycle_len INTEGER NOT NULL DEFAULT 28,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cycle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_cycle_events_user ON cycle_events(user_id, day);
`);

// migração: colunas de versões anteriores
for (const sql of [
  "ALTER TABLE entries ADD COLUMN flags INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE entries ADD COLUMN exercise_kcal INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE entries ADD COLUMN exercise_src TEXT NOT NULL DEFAULT 'est'",
  "ALTER TABLE profile ADD COLUMN cycle_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE profile ADD COLUMN cycle_last TEXT",
  "ALTER TABLE profile ADD COLUMN cycle_len INTEGER NOT NULL DEFAULT 28",
]) {
  try { db.exec(sql); } catch {}
}

export function audit(ip, actor, event, detail = "") {
  try {
    db.prepare("INSERT INTO audit(at,ip,actor,event,detail) VALUES(?,?,?,?,?)").run(Date.now(), ip, actor, event, String(detail).slice(0, 500));
    // rotação: mantém só os últimos 5000 eventos
    const n = db.prepare("SELECT COUNT(*) c FROM audit").get().c;
    if (n > 5500) db.prepare("DELETE FROM audit WHERE id <= (SELECT MIN(id) + (? - 5000) FROM audit)").run(n);
  } catch {}
}
