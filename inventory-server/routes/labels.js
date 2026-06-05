// routes/labels.js
//
// Label pool management routes.
// /labels/generate and /labels/counts require the API key (called from Tauri app).
// /labels/print and /labels/qr/:id are public (opened in browser, no key available).

const express  = require('express');
const router   = express.Router();
const db       = require('../database');
const QRCode   = require('qrcode');
const crypto   = require('crypto');
const requireApiKey = require('../middleware/auth');

const now = () => Math.floor(Date.now() / 1000);

// POST /labels/generate — create N unassigned labels (requires API key)
router.post('/generate', requireApiKey, (req, res) => {
  const n = Math.min(Math.max(parseInt(req.body?.n ?? 50, 10), 1), 200);
  const insert = db.prepare("INSERT INTO label_pool (id, status, created_at) VALUES (?, 'unassigned', ?)");
  const createBatch = db.transaction((count) => {
    const ids = [];
    const ts = now();
    for (let i = 0; i < count; i++) {
      const id = crypto.randomUUID();
      insert.run(id, ts);
      ids.push(id);
    }
    return ids;
  });
  const ids = createBatch(n);
  res.json({ ids });
});

// GET /labels/counts — pool counts by status (requires API key)
router.get('/counts', requireApiKey, (req, res) => {
  const unassigned = db.prepare("SELECT COUNT(*) AS c FROM label_pool WHERE status = 'unassigned'").get().c;
  const active     = db.prepare("SELECT COUNT(*) AS c FROM label_pool WHERE status = 'active'").get().c;
  const retired    = db.prepare("SELECT COUNT(*) AS c FROM label_pool WHERE status = 'retired'").get().c;
  res.json({ unassigned, active, retired });
});

// GET /labels/qr/:id — PNG QR code (no auth — loaded by <img> tags in print page)
router.get('/qr/:id', async (req, res) => {
  // Encode the full scan URL into the QR so the iPhone just scans → Safari opens it
  const host  = req.headers['x-forwarded-host'] ?? req.headers.host;
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  const url   = `${proto}://${host}/m/${req.params.id}`;
  try {
    const png = await QRCode.toBuffer(url, {
      type: 'png', width: 150, margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });
    res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=86400').send(png);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /labels/print — 30-up print sheet (no auth — opened in system browser)
router.get('/print', (req, res) => {
  const labels = db.prepare(
    "SELECT id FROM label_pool WHERE status = 'unassigned' ORDER BY created_at"
  ).all();
  const cells = labels.map(l => `
    <div class="cell">
      <img src="/labels/qr/${l.id}" width="80" height="80" alt="">
      <div class="id">${l.id.slice(0, 8).toUpperCase()}</div>
    </div>`).join('');
  res.set('Content-Type', 'text/html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Label Sheet — ${labels.length} labels</title>
<style>
  @page { size: letter portrait; margin: 0.5in 0.1875in; }
  body  { margin: 0; padding: 0; font-family: sans-serif; }
  .grid { display: grid; grid-template-columns: repeat(3, 2.625in);
          column-gap: 0.125in; row-gap: 0; }
  .cell { display: flex; flex-direction: column; align-items: center;
          justify-content: center; height: 1in; padding: 2px;
          border: 0.5px dashed #ccc; }
  .cell img { display: block; }
  .id   { font-family: monospace; font-size: 6.5px; color: #444;
          margin-top: 2px; text-align: center; letter-spacing: .04em; }
  @media print { .cell { border-color: transparent; } }
</style></head>
<body>
  <div class="grid">${cells}</div>
  <p style="margin-top:12px;font-size:11px;color:#888;">
    ${labels.length} unassigned labels · Print on Avery 5160 (3×10 per sheet)
  </p>
</body></html>`);
});

module.exports = router;
