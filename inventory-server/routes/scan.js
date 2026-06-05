// routes/scan.js
//
// Mobile scan landing pages for QR-labelled inventory pieces.
// No API-key auth — iPhone users scan these with Safari, no credentials.
// Routes: GET /m/:id, POST /m/:id/in, POST /m/:id/out

const express = require('express');
const router  = express.Router();
const db      = require('../database');

router.use(express.urlencoded({ extended: false }));

const now = () => Math.floor(Date.now() / 1000);

const MAT_LABELS = {
  plywood:         'Plywood',
  raw_mdf:         'Raw MDF',
  copper_mdf:      'Copper MDF',
  gold_foil_mdf:   'Gold Foil',
  silver_foil_mdf: 'Silver Foil',
  black_foil_mdf:  'Black Foil',
  white_foil_mdf:  'White Foil',
  custom:          'Custom',
};

const MATERIALS = [
  { id: 'plywood',         label: 'Plywood'        },
  { id: 'raw_mdf',         label: 'Raw MDF'         },
  { id: 'copper_mdf',      label: 'Copper MDF'      },
  { id: 'gold_foil_mdf',   label: 'Gold Foil'       },
  { id: 'silver_foil_mdf', label: 'Silver Foil'     },
  { id: 'black_foil_mdf',  label: 'Black Foil'      },
  { id: 'white_foil_mdf',  label: 'White Foil'      },
  { id: 'custom',          label: 'Other / Custom'  },
];

const ITEM_TYPES = [
  { id: 'sheet',    label: 'Sheet stock'    },
  { id: 'blank',    label: 'Prepared blank' },
  { id: 'offcut',   label: 'Offcut'         },
  { id: 'finished', label: 'Finished piece' },
];

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <title>${title}</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;
         background:#0f1117;color:#e8e8f0;min-height:100vh;padding:24px 20px 48px}
    h1{font-size:22px;font-weight:700;margin-bottom:8px;color:#fff}
    p{font-size:15px;color:#8899bb;line-height:1.5;margin-bottom:18px}
    .card{background:#1a1d2e;border-radius:14px;padding:18px;margin-bottom:18px}
    label{display:block;font-size:11px;font-weight:600;color:#5577aa;
          text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px}
    select,input[type=number],input[type=text]{
      width:100%;padding:14px;font-size:16px;
      background:#0f1117;border:1px solid #2a3050;
      border-radius:10px;color:#e8e8f0;-webkit-appearance:none;appearance:none;
      margin-bottom:18px}
    select:focus,input:focus{outline:none;border-color:#5599ff}
    .btn{display:block;width:100%;padding:18px;font-size:17px;font-weight:700;
         border:none;border-radius:12px;cursor:pointer;margin-top:8px;
         font-family:-apple-system,BlinkMacSystemFont,sans-serif}
    .btn-primary{background:#5599ff;color:#fff}
    .btn-danger{background:#cc3333;color:#fff}
    .meta-row{display:flex;justify-content:space-between;align-items:center;
              padding:10px 0;border-bottom:1px solid #252840;font-size:15px}
    .meta-row:last-child{border-bottom:none}
    .ml{font-size:11px;font-weight:600;text-transform:uppercase;
        letter-spacing:.06em;color:#5577aa}
    .mv{font-weight:600;color:#e8e8f0}
    .badge{display:inline-block;padding:4px 10px;border-radius:6px;
           font-size:11px;font-weight:700;text-transform:uppercase;
           letter-spacing:.07em;margin-bottom:16px}
    .new{background:#0d2a1e;color:#33cc66}
    .in{background:#0e1e3a;color:#5599ff}
    .out{background:#2a0e0e;color:#cc3333}
    .id{font-family:monospace;font-size:11px;color:#334466;
        background:#0a0d16;padding:4px 8px;border-radius:5px;
        word-break:break-all;margin-bottom:20px;display:block}
  </style>
</head>
<body>${body}</body>
</html>`;
}

// GET /m/:id
router.get('/:id', (req, res) => {
  const { id } = req.params;
  const label = db.prepare('SELECT * FROM label_pool WHERE id = ?').get(id);

  if (!label) {
    return res.send(page('Label Not Recognized', `
      <h1>Label not recognized</h1>
      <span class="id">${id}</span>
      <p>This QR code isn't in the label pool.<br>
         Generate a fresh batch from the desktop app and try again.</p>
    `));
  }

  if (label.status === 'retired') {
    const item = db.prepare('SELECT * FROM inventory WHERE label_id = ?').get(id);
    return res.send(page('Label Retired', `
      <h1>Label retired</h1>
      <span class="badge out">Retired</span>
      <span class="id">${id}</span>
      ${item ? `
      <div class="card">
        <div class="meta-row"><span class="ml">Type</span><span class="mv">${item.item_type}</span></div>
        <div class="meta-row"><span class="ml">Material</span><span class="mv">${MAT_LABELS[item.material] ?? item.material}</span></div>
        <div class="meta-row"><span class="ml">Size</span><span class="mv">${item.width}" × ${item.height}"</span></div>
        <div class="meta-row"><span class="ml">Thickness</span><span class="mv">${item.thickness}"</span></div>
        ${item.notes ? `<div class="meta-row"><span class="ml">Notes</span><span class="mv">${item.notes}</span></div>` : ''}
      </div>` : ''}
      <p>This piece has been checked out. Stick a fresh label on new material.</p>
    `));
  }

  if (label.status === 'active') {
    const item = db.prepare('SELECT * FROM inventory WHERE label_id = ?').get(id);
    if (!item) {
      return res.send(page('Data Error', `
        <h1>Label state error</h1>
        <span class="id">${id}</span>
        <p>This label is active but has no linked inventory item.<br>
           Contact the shop manager to fix this record.</p>
      `));
    }
    return res.send(page('Check Out', `
      <h1>Check out</h1>
      <span class="badge in">In stock</span>
      <span class="id">${id}</span>
      <div class="card">
        <div class="meta-row"><span class="ml">Type</span><span class="mv">${item.item_type}</span></div>
        <div class="meta-row"><span class="ml">Material</span><span class="mv">${MAT_LABELS[item.material] ?? item.material}</span></div>
        <div class="meta-row"><span class="ml">Size</span><span class="mv">${item.width}" × ${item.height}"</span></div>
        <div class="meta-row"><span class="ml">Thickness</span><span class="mv">${item.thickness}"</span></div>
        ${item.notes ? `<div class="meta-row"><span class="ml">Notes</span><span class="mv">${item.notes}</span></div>` : ''}
      </div>
      <form method="POST" action="/m/${id}/out">
        <button type="submit" class="btn btn-danger">Check Out — Mark Used</button>
      </form>
    `));
  }

  // Unassigned — show check-in form
  const matOpts = MATERIALS.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
  const typeOpts = ITEM_TYPES.map(t => `<option value="${t.id}">${t.label}</option>`).join('');
  res.send(page('Check In', `
    <h1>Check in</h1>
    <span class="badge new">New label</span>
    <span class="id">${id}</span>
    <form method="POST" action="/m/${id}/in">
      <div class="card">
        <label>Item Type</label>
        <select name="item_type" required>${typeOpts}</select>
        <label>Material</label>
        <select name="material" required>${matOpts}</select>
        <label>Width (inches)</label>
        <input type="number" name="width" placeholder="e.g. 12" step="0.01" min="0.01" required>
        <label>Height (inches)</label>
        <input type="number" name="height" placeholder="e.g. 18" step="0.01" min="0.01" required>
        <label>Thickness</label>
        <select name="thickness">
          <option value="1/8">1/8"</option>
          <option value="1/4">1/4"</option>
        </select>
        <label>Notes (optional)</label>
        <input type="text" name="notes" placeholder="e.g. From 12×18 cut">
      </div>
      <button type="submit" class="btn btn-primary">Check In</button>
    </form>
  `));
});

// POST /m/:id/in
router.post('/:id/in', (req, res) => {
  const { id } = req.params;
  const label = db.prepare("SELECT * FROM label_pool WHERE id = ?").get(id);
  if (!label || label.status !== 'unassigned') {
    return res.status(400).send(page('Error', `
      <h1>Cannot check in</h1>
      <p>Label <code>${id}</code> is not available (status: ${label?.status ?? 'unknown'}).</p>
    `));
  }
  const { item_type, material, width, height, thickness, notes } = req.body;
  if (!material || !width || !height) {
    return res.status(400).send(page('Missing fields', `
      <h1>Missing fields</h1><p>Material, width, and height are required.</p>
    `));
  }
  const validMaterials = new Set(MATERIALS.map(m => m.id));
  const validItemTypes = new Set(ITEM_TYPES.map(t => t.id));
  if (!validMaterials.has(material)) {
    return res.status(400).send(page('Invalid input', `
      <h1>Invalid material</h1><p>Unknown material: ${material.slice(0, 40)}</p>
    `));
  }
  const safeItemType = validItemTypes.has(item_type) ? item_type : 'blank';
  const w = parseFloat(width);
  const h = parseFloat(height);
  if (!isFinite(w) || w <= 0 || w > 500 || !isFinite(h) || h <= 0 || h > 500) {
    return res.status(400).send(page('Invalid dimensions', `
      <h1>Invalid dimensions</h1><p>Width and height must be between 0 and 500 inches.</p>
    `));
  }
  const ts = now();
  db.prepare(
    `INSERT INTO inventory
       (item_type, material, width, height, thickness, quantity, sku, notes, unit_cost, label_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, '', ?, 0, ?, ?, ?)`
  ).run(
    safeItemType,
    material,
    w,
    h,
    thickness || '1/8',
    notes || '',
    id, ts, ts
  );
  db.prepare("UPDATE label_pool SET status = 'active', assigned_at = ? WHERE id = ?").run(ts, id);
  const matLabel = MAT_LABELS[material] ?? material;
  res.send(page('Checked In', `
    <h1>Checked in ✓</h1>
    <span class="badge in">In stock</span>
    <span class="id">${id}</span>
    <div class="card">
      <div class="meta-row"><span class="ml">Type</span><span class="mv">${item_type || 'blank'}</span></div>
      <div class="meta-row"><span class="ml">Material</span><span class="mv">${matLabel}</span></div>
      <div class="meta-row"><span class="ml">Size</span><span class="mv">${width}" × ${height}"</span></div>
      <div class="meta-row"><span class="ml">Thickness</span><span class="mv">${thickness || '1/8'}"</span></div>
      ${notes ? `<div class="meta-row"><span class="ml">Notes</span><span class="mv">${notes}</span></div>` : ''}
    </div>
    <p>Piece is now tracked in inventory.</p>
  `));
});

// POST /m/:id/out
router.post('/:id/out', (req, res) => {
  const { id } = req.params;
  const label = db.prepare("SELECT * FROM label_pool WHERE id = ?").get(id);
  if (!label || label.status !== 'active') {
    return res.status(400).send(page('Error', `
      <h1>Cannot check out</h1>
      <p>Label <code>${id}</code> is not active.</p>
    `));
  }
  db.prepare("UPDATE inventory SET quantity = 0, updated_at = ? WHERE label_id = ?").run(now(), id);
  db.prepare("UPDATE label_pool SET status = 'retired' WHERE id = ?").run(id);
  res.send(page('Checked Out', `
    <h1>Checked out ✓</h1>
    <span class="badge out">Retired</span>
    <span class="id">${id}</span>
    <p>Piece marked as used. The label is now retired.<br>
       Stick a fresh label on any new material.</p>
  `));
});

module.exports = router;
