const express = require('express');
const router = express.Router();
const db = require('../database');

const now = () => Math.floor(Date.now() / 1000);

// GET /inventory
router.get('/', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM inventory ORDER BY item_type, material, width DESC, height DESC'
  ).all();
  res.json(rows);
});

// POST /inventory  — create item
router.post('/', (req, res) => {
  const { item_type, material, width, height, thickness, quantity, sku, notes } = req.body;
  if (!material || width == null || height == null) {
    return res.status(400).json({ error: 'material, width, and height are required' });
  }
  const ts = now();
  const info = db.prepare(
    `INSERT INTO inventory
       (item_type, material, width, height, thickness, quantity, sku, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    item_type ?? 'blank', material,
    width, height,
    thickness ?? '1/8',
    quantity ?? 0,
    sku ?? '', notes ?? '',
    ts, ts
  );
  const row = db.prepare('SELECT * FROM inventory WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(row);
});

// PUT /inventory/:id  — full update
router.put('/:id', (req, res) => {
  const { item_type, material, width, height, thickness, quantity, sku, notes } = req.body;
  const info = db.prepare(
    `UPDATE inventory
     SET item_type=?, material=?, width=?, height=?, thickness=?, quantity=?, sku=?, notes=?, updated_at=?
     WHERE id=?`
  ).run(item_type, material, width, height, thickness, quantity, sku ?? '', notes ?? '', now(), req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
});

// PATCH /inventory/:id/qty  — adjust by delta (pass { delta: 1 } or { delta: -1 })
router.patch('/:id/qty', (req, res) => {
  const { delta } = req.body;
  if (delta == null) return res.status(400).json({ error: 'delta is required' });
  db.prepare(
    'UPDATE inventory SET quantity = MAX(0, quantity + ?), updated_at = ? WHERE id = ?'
  ).run(delta, now(), req.params.id);
  const row = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Item not found' });
  res.json({ quantity: row.quantity });
});

// PUT /inventory/:id/qty  — set absolute value
router.put('/:id/qty', (req, res) => {
  const { quantity } = req.body;
  if (quantity == null) return res.status(400).json({ error: 'quantity is required' });
  const info = db.prepare(
    'UPDATE inventory SET quantity = MAX(0, ?), updated_at = ? WHERE id = ?'
  ).run(quantity, now(), req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
});

// DELETE /inventory/:id
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM inventory WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
