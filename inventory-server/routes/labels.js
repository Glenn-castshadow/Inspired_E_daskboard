// routes/labels.js
//
// Label pool management routes.
// /labels/generate and /labels/counts require the API key (called from Tauri app).
// /labels/print and /labels/qr/:id are public (opened in browser, no key available).

const express = require('express');
const router = express.Router();
const db = require('../database');
const QRCode = require('qrcode');
const crypto = require('crypto');
const requireApiKey = require('../middleware/auth');
const { scanBaseUrl } = require('../config');

const now = () => Math.floor(Date.now() / 1000);

const LABEL_STOCKS = {
  rollo_2x1: {
    key: 'rollo_2x1',
    label: 'Rollo 2 x 1 in',
    printer: 'rollo',
    mode: 'roll',
    page: { width: '2in', height: '1in' },
    cell: { width: '2in', height: '1in' },
    qr: 58,
  },
  rollo_2_25x1_25: {
    key: 'rollo_2_25x1_25',
    label: 'Rollo 2.25 x 1.25 in',
    printer: 'rollo',
    mode: 'roll',
    page: { width: '2.25in', height: '1.25in' },
    cell: { width: '2.25in', height: '1.25in' },
    qr: 74,
  },
  rollo_3x2: {
    key: 'rollo_3x2',
    label: 'Rollo 3 x 2 in',
    printer: 'rollo',
    mode: 'roll',
    page: { width: '3in', height: '2in' },
    cell: { width: '3in', height: '2in' },
    qr: 104,
  },
  avery_5160: {
    key: 'avery_5160',
    label: 'Avery 5160 / 8160',
    printer: 'laser',
    mode: 'sheet',
    page: { size: 'letter portrait', margin: '0.5in 0.1875in' },
    columns: 3,
    cell: { width: '2.625in', height: '1in' },
    columnGap: '0.125in',
    rowGap: '0',
    qr: 80,
  },
  avery_5163: {
    key: 'avery_5163',
    label: 'Avery 5163 / 8163',
    printer: 'laser',
    mode: 'sheet',
    page: { size: 'letter portrait', margin: '0.5in 0.1875in' },
    columns: 2,
    cell: { width: '4in', height: '2in' },
    columnGap: '0.15625in',
    rowGap: '0',
    qr: 118,
  },
};

const resolveStock = (key, printer) => {
  const requested = LABEL_STOCKS[key] || LABEL_STOCKS.rollo_2x1;
  if (!printer || requested.printer === printer) return requested;
  return Object.values(LABEL_STOCKS).find(s => s.printer === printer) || requested;
};

const clampLimit = (value) =>
  Math.min(Math.max(parseInt(value ?? 30, 10) || 30, 1), 200);

// POST /labels/generate - create N unassigned labels.
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

// GET /labels/counts - pool counts by status.
router.get('/counts', requireApiKey, (_req, res) => {
  const unassigned = db.prepare("SELECT COUNT(*) AS c FROM label_pool WHERE status = 'unassigned'").get().c;
  const active = db.prepare("SELECT COUNT(*) AS c FROM label_pool WHERE status = 'active'").get().c;
  const retired = db.prepare("SELECT COUNT(*) AS c FROM label_pool WHERE status = 'retired'").get().c;
  res.json({ unassigned, active, retired });
});

// GET /labels/qr/:id - PNG QR code loaded by print pages.
router.get('/qr/:id', async (req, res) => {
  const url = `${scanBaseUrl}/m/${req.params.id}`;
  try {
    const png = await QRCode.toBuffer(url, {
      type: 'png',
      width: 150,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });
    res.set('Content-Type', 'image/png')
      .set('Cache-Control', 'public, max-age=86400')
      .send(png);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /labels/print - print-ready labels with stock-specific page CSS.
router.get('/print', (req, res) => {
  const printer = ['rollo', 'laser'].includes(req.query.printer) ? req.query.printer : undefined;
  const stock = resolveStock(req.query.stock, printer);
  const limit = clampLimit(req.query.limit);
  const autoPrint = req.query.autoprint === '1';
  const labels = db.prepare(
    "SELECT id FROM label_pool WHERE status = 'unassigned' ORDER BY created_at LIMIT ?"
  ).all(limit);
  const cells = labels.map(l => `
    <div class="cell">
      <img src="/labels/qr/${l.id}" width="${stock.qr}" height="${stock.qr}" alt="">
      <div class="id">${l.id.slice(0, 8).toUpperCase()}</div>
    </div>`).join('');
  const pageCss = stock.mode === 'roll'
    ? `@page { size: ${stock.page.width} ${stock.page.height}; margin: 0; }`
    : `@page { size: ${stock.page.size}; margin: ${stock.page.margin}; }`;
  const layoutCss = stock.mode === 'roll'
    ? `.grid { display: block; }
  .cell { box-sizing: border-box; width: ${stock.cell.width}; height: ${stock.cell.height};
          page-break-after: always; break-after: page; display: flex; flex-direction: column;
          align-items: center; justify-content: center; padding: 0.04in; border: 0.5px dashed #ccc; }`
    : `.grid { display: grid; grid-template-columns: repeat(${stock.columns}, ${stock.cell.width});
          column-gap: ${stock.columnGap}; row-gap: ${stock.rowGap}; }
  .cell { box-sizing: border-box; display: flex; flex-direction: column; align-items: center;
          justify-content: center; height: ${stock.cell.height}; padding: 2px; border: 0.5px dashed #ccc; }`;

  res.set('Content-Type', 'text/html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${stock.label} - ${labels.length} labels</title>
<style>
  ${pageCss}
  body  { margin: 0; padding: 0; font-family: sans-serif; color: #111; background: #fff; }
  ${layoutCss}
  .cell img { display: block; }
  .id   { font-family: monospace; font-size: 6.5px; color: #444;
          margin-top: 2px; text-align: center; letter-spacing: .04em; }
  .toolbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center;
             justify-content: space-between; gap: 16px; padding: 10px 14px; margin-bottom: 12px;
             background: #111; color: #fff; font-size: 13px; }
  .toolbar strong { display: block; font-size: 14px; }
  .toolbar span { color: #cfcfcf; }
  .toolbar button { border: 0; border-radius: 6px; padding: 7px 12px; cursor: pointer;
                    font-weight: 700; background: #44d5c5; color: #06211f; }
  @media print {
    .toolbar { display: none; }
    .cell { border-color: transparent; }
  }
</style></head>
<body>
  <div class="toolbar">
    <div>
      <strong>${stock.label}</strong>
      <span>${labels.length} unassigned labels - target: ${stock.printer === 'rollo' ? 'Rollo' : 'Laser printer'}</span>
    </div>
    <button onclick="window.print()">Print</button>
  </div>
  <div class="grid">${cells}</div>
  ${autoPrint ? `<script>
    const runPrint = () => setTimeout(() => window.print(), 150);
    if (document.readyState === 'complete') runPrint();
    else window.addEventListener('load', runPrint, { once: true });
  </script>` : ''}
</body></html>`);
});

module.exports = router;
