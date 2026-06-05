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
    unit_cost   REAL    NOT NULL DEFAULT 0,
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

  -- One .lbrn2 file per base product (no finish in the key).
  -- filename is the canonical name: e.g. DBC-RBH_doorbell-chime-round.lbrn2
  -- The actual file lives at LIGHTBURN_DIR/filename on the host.
  CREATE TABLE IF NOT EXISTS lightburn_files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sku_base    TEXT    NOT NULL UNIQUE,
    short_name  TEXT    NOT NULL,
    filename    TEXT    NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- Maps an Etsy product_name → lightburn_file_id so Queue Cut can auto-resolve.
  CREATE TABLE IF NOT EXISTS lightburn_mappings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    product_name      TEXT    NOT NULL UNIQUE,
    lightburn_file_id INTEGER NOT NULL REFERENCES lightburn_files(id) ON DELETE CASCADE,
    created_at        INTEGER NOT NULL
  );
`);

// v2: material tracking — label pool + category blank sizes + label_id on inventory
db.exec(`
  CREATE TABLE IF NOT EXISTS label_pool (
    id          TEXT    PRIMARY KEY,
    status      TEXT    NOT NULL DEFAULT 'unassigned',
    created_at  INTEGER NOT NULL,
    assigned_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS category_blank_sizes (
    category   TEXT    PRIMARY KEY,
    min_width  REAL    NOT NULL,
    min_height REAL    NOT NULL
  );
`);

// Add label_id column if this is an existing DB that predates v2
try {
  db.exec('ALTER TABLE inventory ADD COLUMN label_id TEXT REFERENCES label_pool(id)');
} catch (e) {
  if (!e.message.includes('duplicate column')) throw e;
}

// ── Idempotent migrations for existing databases ──────────────────────────────
// ALTER TABLE … ADD COLUMN throws if the column already exists; ignore that.
try {
  db.exec("ALTER TABLE inventory ADD COLUMN unit_cost REAL NOT NULL DEFAULT 0");
  console.log('[db] migrated: added inventory.unit_cost');
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

console.log(`[db] SQLite open: ${dbPath}`);

module.exports = db;
