const express = require('express');
const router  = express.Router();
const db      = require('../database');
const fs      = require('fs');
const path    = require('path');
const { dbPath } = require('../config');

// Files land in a sibling "lightburn" folder next to the DB file.
// Docker volume: /data/lightburn/  →  NAS: /volume1/docker/castshadow-inventory/data/lightburn/
const LIGHTBURN_DIR = path.join(path.dirname(dbPath), 'lightburn');
fs.mkdirSync(LIGHTBURN_DIR, { recursive: true });

const now = () => Math.floor(Date.now() / 1000);

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ── File library ──────────────────────────────────────────────────────────────

// GET /lightburn
router.get('/', (_req, res) => {
  const rows = db.prepare(
    'SELECT id, sku_base, short_name, filename, created_at, updated_at FROM lightburn_files ORDER BY sku_base'
  ).all();
  res.json(rows);
});

// POST /lightburn  — body: { sku_base, short_name, data_base64 }
router.post('/', (req, res) => {
  const { sku_base, short_name, data_base64 } = req.body;
  if (!sku_base || !short_name || !data_base64) {
    return res.status(400).json({ error: 'sku_base, short_name, and data_base64 are required' });
  }

  const base = sku_base.toUpperCase().trim();
  const slug = slugify(short_name);
  const filename = `${base}_${slug}.lbrn2`;
  const filePath = path.join(LIGHTBURN_DIR, path.basename(filename));

  let buf;
  try {
    buf = Buffer.from(data_base64, 'base64');
  } catch {
    return res.status(400).json({ error: 'data_base64 is not valid base64' });
  }

  fs.writeFileSync(filePath, buf);

  const ts = now();
  try {
    const info = db.prepare(
      'INSERT INTO lightburn_files (sku_base, short_name, filename, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(base, short_name.trim(), filename, ts, ts);
    const row = db.prepare(
      'SELECT id, sku_base, short_name, filename, created_at, updated_at FROM lightburn_files WHERE id = ?'
    ).get(info.lastInsertRowid);
    res.status(201).json(row);
  } catch (e) {
    try { fs.unlinkSync(filePath); } catch { /* best-effort cleanup */ }
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `A Lightburn file for "${sku_base}" already exists` });
    }
    throw e;
  }
});

// PUT /lightburn/:id  — update SKU base and short name, renames file on disk
router.put('/:id', (req, res) => {
  const { sku_base, short_name } = req.body;
  if (!sku_base || !short_name) {
    return res.status(400).json({ error: 'sku_base and short_name are required' });
  }
  const row = db.prepare('SELECT filename FROM lightburn_files WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'File not found' });

  const base        = sku_base.toUpperCase().trim();
  const slug        = slugify(short_name);
  const newFilename = `${base}_${slug}.lbrn2`;

  if (row.filename !== newFilename) {
    const oldPath = path.join(LIGHTBURN_DIR, path.basename(row.filename));
    const newPath = path.join(LIGHTBURN_DIR, path.basename(newFilename));
    if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
  }

  const ts = now();
  db.prepare(
    'UPDATE lightburn_files SET sku_base=?, short_name=?, filename=?, updated_at=? WHERE id=?'
  ).run(base, short_name.trim(), newFilename, ts, req.params.id);

  const updated = db.prepare(
    'SELECT id, sku_base, short_name, filename, created_at, updated_at FROM lightburn_files WHERE id=?'
  ).get(req.params.id);
  res.json(updated);
});

// GET /lightburn/:id/file  — download the binary .lbrn2
router.get('/:id/file', (req, res) => {
  const row = db.prepare('SELECT filename FROM lightburn_files WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'File not found' });

  const filePath = path.join(LIGHTBURN_DIR, path.basename(row.filename));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File missing from disk' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(filePath);
});

// DELETE /lightburn/:id
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT filename FROM lightburn_files WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'File not found' });

  db.prepare('DELETE FROM lightburn_mappings WHERE lightburn_file_id = ?').run(req.params.id);
  db.prepare('DELETE FROM lightburn_files WHERE id = ?').run(req.params.id);
  try { fs.unlinkSync(path.join(LIGHTBURN_DIR, path.basename(row.filename))); } catch { /* ok if already gone */ }

  res.json({ ok: true });
});

// ── Product → file mappings ───────────────────────────────────────────────────

// GET /lightburn/mappings
router.get('/mappings', (_req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.product_name, m.lightburn_file_id,
           f.sku_base, f.short_name, f.filename
    FROM   lightburn_mappings m
    JOIN   lightburn_files    f ON f.id = m.lightburn_file_id
    ORDER  BY m.product_name
  `).all();
  res.json(rows);
});

// POST /lightburn/mappings  — body: { product_name, lightburn_file_id }
router.post('/mappings', (req, res) => {
  const { product_name, lightburn_file_id } = req.body;
  if (!product_name || !lightburn_file_id) {
    return res.status(400).json({ error: 'product_name and lightburn_file_id are required' });
  }
  db.prepare(
    'INSERT OR REPLACE INTO lightburn_mappings (product_name, lightburn_file_id, created_at) VALUES (?, ?, ?)'
  ).run(product_name.trim(), lightburn_file_id, now());
  res.status(201).json({ ok: true });
});

// DELETE /lightburn/mappings/:id
router.delete('/mappings/:id', (req, res) => {
  db.prepare('DELETE FROM lightburn_mappings WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
