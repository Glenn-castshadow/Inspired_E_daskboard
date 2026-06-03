const express = require('express');
const router = express.Router();
const db = require('../database');

const now = () => Math.floor(Date.now() / 1000);
const toProduct = r => (r ? { ...r, active: r.active === 1 } : null);

// GET /products
router.get('/', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM products WHERE active = 1 ORDER BY category, sku'
  ).all();
  res.json(rows.map(toProduct));
});

// POST /products  — create product
router.post('/', (req, res) => {
  const { sku, name, category, design, finish, width, height, thickness, material, notes } = req.body;
  if (!sku || !name) return res.status(400).json({ error: 'sku and name are required' });
  const ts = now();
  try {
    const info = db.prepare(
      `INSERT INTO products
         (sku, name, category, design, finish, width, height, thickness, material, notes, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      sku, name,
      category ?? '', design ?? '', finish ?? '',
      width ?? 0, height ?? 0,
      thickness ?? '1/8',
      material ?? '', notes ?? '',
      ts, ts
    );
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(toProduct(row));
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `SKU "${sku}" already exists in catalog` });
    }
    throw e;
  }
});

// PUT /products/:id  — update product
router.put('/:id', (req, res) => {
  const { sku, name, category, design, finish, width, height, thickness, material, notes } = req.body;
  try {
    const info = db.prepare(
      `UPDATE products
       SET sku=?, name=?, category=?, design=?, finish=?, width=?, height=?, thickness=?, material=?, notes=?, updated_at=?
       WHERE id=?`
    ).run(
      sku, name,
      category ?? '', design ?? '', finish ?? '',
      width ?? 0, height ?? 0,
      thickness ?? '1/8',
      material ?? '', notes ?? '',
      now(), req.params.id
    );
    if (info.changes === 0) return res.status(404).json({ error: 'Product not found' });
    res.json({ ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `SKU "${sku}" already exists in catalog` });
    }
    throw e;
  }
});

// DELETE /products/:id  — soft delete, preserves history
router.delete('/:id', (req, res) => {
  db.prepare(
    'UPDATE products SET active = 0, updated_at = ? WHERE id = ?'
  ).run(now(), req.params.id);
  res.json({ ok: true });
});

module.exports = router;
