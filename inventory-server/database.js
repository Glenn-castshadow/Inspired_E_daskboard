const Database = require('better-sqlite3');
const { dbPath } = require('./config');

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS inventory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type   TEXT    NOT NULL DEFAULT 'blank',
    material    TEXT    NOT NULL,
    width       REAL    NOT NULL,
    height      REAL    NOT NULL,
    thickness   TEXT    NOT NULL DEFAULT '1/8',
    quantity    INTEGER NOT NULL DEFAULT 0,
    sku         TEXT    NOT NULL DEFAULT '',
    notes       TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sku         TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    category    TEXT    NOT NULL DEFAULT '',
    design      TEXT    NOT NULL DEFAULT '',
    finish      TEXT    NOT NULL DEFAULT '',
    width       REAL    NOT NULL DEFAULT 0,
    height      REAL    NOT NULL DEFAULT 0,
    thickness   TEXT    NOT NULL DEFAULT '1/8',
    material    TEXT    NOT NULL DEFAULT '',
    notes       TEXT    NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
`);

console.log(`[db] SQLite open: ${dbPath}`);

module.exports = db;
