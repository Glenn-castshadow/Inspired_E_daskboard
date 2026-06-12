// routes/scan.js
//
// Mobile scan landing pages for QR-labelled inventory pieces.
// No API-key auth — iPhone users scan these with Safari, no credentials.
// Routes: GET /m/:id, POST /m/:id/in, POST /m/:id/out
//
// Batch check-in: localStorage key 'csi_tpl' holds the last-used template
// (item_type, material, width, height, thickness). Each new unassigned scan
// pre-fills the form so checking in the 2nd–Nth sheet is a single tap.

const express = require('express');
const router  = express.Router();
const db      = require('../database');

router.use(express.urlencoded({ extended: false }));

const now = () => Math.floor(Date.now() / 1000);

// Materials = the finishes we stock as raw sheets. Order matches the Etsy
// variant dropdown. Keep in sync with src/taxonomy.js MATERIALS.
const MATERIALS = [
  { id: 'copper_leaf',        label: 'Copper Leaf'        },
  { id: 'copper',             label: 'Copper'             },
  { id: 'copper_patina_foil', label: 'Copper Patina Foil' },
  { id: 'gold_leaf',          label: 'Gold Leaf'          },
  { id: 'maple',              label: 'Maple'              },
  { id: 'cherry',             label: 'Cherry'             },
  { id: 'walnut',             label: 'Walnut'             },
  { id: 'white_oak',          label: 'White Oak'          },
  { id: 'aromatic_cedar',     label: 'Aromatic Cedar'     },
  { id: 'mahogany',           label: 'Mahogany'           },
  { id: 'sapele',             label: 'Sapele'             },
  { id: 'mdf',                label: 'MDF (Unfinished)'   },
  { id: 'custom',             label: 'Other / Custom'     },
];

const MAT_LABELS = Object.fromEntries(MATERIALS.map(m => [m.id, m.label]));

const ITEM_TYPES = [
  { id: 'sheet',    label: 'Sheet stock'    },
  { id: 'blank',    label: 'Prepared blank' },
  { id: 'offcut',   label: 'Offcut'         },
  { id: 'finished', label: 'Finished piece' },
];

// ── Client-side template utilities (inlined into every relevant page) ─────────
// Stored in localStorage as JSON under key 'csi_tpl'.
const TPL_JS = `
<script>
var TPL_KEY='csi_tpl';
function loadTpl(){try{return JSON.parse(localStorage.getItem(TPL_KEY));}catch(e){return null;}}
function saveTpl(t){try{localStorage.setItem(TPL_KEY,JSON.stringify(t));}catch(e){}}
function clearTpl(){try{localStorage.removeItem(TPL_KEY);}catch(e){}}
</script>`;

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
    .tpl-bar{display:none;align-items:center;justify-content:space-between;
             background:#0e1e3a;border:1px solid #1a3a6a;border-radius:10px;
             padding:12px 14px;margin-bottom:18px}
    .tpl-label{font-size:13px;font-weight:600;color:#5599ff}
    .tpl-clear{font-size:12px;color:#5577aa;background:none;border:none;
               cursor:pointer;text-decoration:underline;padding:0;
               font-family:-apple-system,BlinkMacSystemFont,sans-serif}
    .next-hint{text-align:center;padding:18px 0 4px;
               font-size:14px;color:#5577aa;line-height:1.5}
    .sz-row{display:flex;gap:8px;margin-bottom:18px}
    .sz-btn{flex:1;padding:13px 8px;border-radius:10px;border:1px solid #2a3050;
            background:#1a1d2e;color:#8899bb;font-size:14px;font-weight:600;
            cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
    .sz-btn.active{background:#0e1e3a;border-color:#5599ff;color:#5599ff}
    .id{font-family:monospace;font-size:11px;color:#334466;
        background:#0a0d16;padding:4px 8px;border-radius:5px;
        word-break:break-all;margin-bottom:20px;display:block}
  </style>
</head>
<body>${body}</body>
</html>`;
}

// ── GET /m/:id ────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const { id } = req.params;
  let label = db.prepare('SELECT * FROM label_pool WHERE id = ?').get(id);

  if (!label) {
    // Auto-register: any QR we physically printed should always work,
    // even if the DB was wiped and rebuilt.
    db.prepare("INSERT OR IGNORE INTO label_pool (id, status, created_at) VALUES (?, 'unassigned', ?)")
      .run(id, now());
    label = { id, status: 'unassigned' };
  }

  // ── Retired ────────────────────────────────────────────────────────────────
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

  // ── Active / in stock ──────────────────────────────────────────────────────
  if (label.status === 'active') {
    const item = db.prepare('SELECT * FROM inventory WHERE label_id = ?').get(id);
    if (!item) {
      return res.send(page('Data Error', `
        <h1>Label state error</h1>
        <span class="id">${id}</span>
        <p>This label is marked active but has no linked inventory item.<br>
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

  // ── Unassigned — check-in form with sticky template ────────────────────────
  const matOpts  = MATERIALS.map(m =>
    `<option value="${m.id}">${m.label}</option>`).join('');
  const typeOpts = ITEM_TYPES.map(t =>
    `<option value="${t.id}">${t.label}</option>`).join('');

  res.send(page('Check In', `
    ${TPL_JS}
    <h1>Check in</h1>
    <span class="badge new">New label</span>
    <span class="id">${id}</span>

    <!-- Template bar — shown by JS when a template is active -->
    <div class="tpl-bar" id="tpl-bar">
      <span class="tpl-label" id="tpl-label"></span>
      <button class="tpl-clear" id="tpl-clear">Clear template</button>
    </div>

    <form method="POST" action="/m/${id}/in" id="ci-form">
      <div class="card">
        <label>Item Type</label>
        <select name="item_type" id="f-type">${typeOpts}</select>
        <label>Material</label>
        <select name="material" id="f-mat">${matOpts}</select>
        <label>Size</label>
        <div class="sz-row">
          <button type="button" class="sz-btn" data-w="12" data-h="20"
                  onclick="setQS(12,20)">12 × 20"</button>
          <button type="button" class="sz-btn" data-w="30" data-h="20"
                  onclick="setQS(30,20)">30 × 20"</button>
        </div>
        <div style="display:flex;gap:10px">
          <div style="flex:1">
            <label>Width (in)</label>
            <input type="number" name="width" id="f-w"
                   placeholder="12" step="0.01" min="0.01" required
                   oninput="syncQS()">
          </div>
          <div style="flex:1">
            <label>Height (in)</label>
            <input type="number" name="height" id="f-h"
                   placeholder="20" step="0.01" min="0.01" required
                   oninput="syncQS()">
          </div>
        </div>
        <label>Thickness</label>
        <select name="thickness" id="f-thick">
          <option value="1/8">1/8"</option>
          <option value="1/4">1/4"</option>
        </select>
        <label>Notes (optional — not saved to template)</label>
        <input type="text" name="notes" placeholder="e.g. From 48×96 cut">
      </div>
      <button type="submit" class="btn btn-primary" id="ci-btn">Check In</button>
    </form>

    <script>
    // Quick-size button helpers
    function setQS(w, h) {
      document.getElementById('f-w').value = w;
      document.getElementById('f-h').value = h;
      syncQS();
    }
    function syncQS() {
      var w = parseFloat(document.getElementById('f-w').value);
      var h = parseFloat(document.getElementById('f-h').value);
      document.querySelectorAll('.sz-btn').forEach(function(b) {
        b.classList.toggle('active',
          parseFloat(b.dataset.w) === w && parseFloat(b.dataset.h) === h);
      });
    }

    (function() {
      var tpl = loadTpl();
      if (tpl) {
        // Pre-fill from template
        document.getElementById('f-type').value  = tpl.item_type || 'sheet';
        document.getElementById('f-mat').value   = tpl.material  || '';
        document.getElementById('f-w').value     = tpl.width     || 12;
        document.getElementById('f-h').value     = tpl.height    || 20;
        document.getElementById('f-thick').value = tpl.thickness || '1/8';

        // Show template bar
        var bar = document.getElementById('tpl-bar');
        bar.style.display = 'flex';
        document.getElementById('tpl-label').textContent =
          '⚡ ' + (tpl.mat_label || tpl.material)
          + ' · ' + tpl.width + '×' + tpl.height + '"'
          + ' · ' + tpl.thickness + '"';

        document.getElementById('ci-btn').textContent =
          'Check In — ' + (tpl.mat_label || tpl.material);

        document.getElementById('tpl-clear').addEventListener('click', function() {
          clearTpl(); location.reload();
        });
      } else {
        // No template — default to 12×20 (most common size)
        setQS(12, 20);
      }
      // Highlight whichever quick-size button matches the current values
      syncQS();
    })();
    </script>
  `));
});

// ── POST /m/:id/in ────────────────────────────────────────────────────────────
router.post('/:id/in', (req, res) => {
  const { id } = req.params;
  let label = db.prepare('SELECT * FROM label_pool WHERE id = ?').get(id);

  if (!label) {
    db.prepare("INSERT OR IGNORE INTO label_pool (id, status, created_at) VALUES (?, 'unassigned', ?)")
      .run(id, now());
    label = { id, status: 'unassigned' };
  }

  // Already active or retired — bounce to the item view
  if (label.status !== 'unassigned') return res.redirect(`/m/${id}`);

  const { item_type, material, width, height, thickness, notes } = req.body;

  if (!material || !width || !height) {
    return res.status(400).send(page('Missing fields',
      '<h1>Missing fields</h1><p>Material, width, and height are required.</p>'));
  }

  const validMaterials = new Set(MATERIALS.map(m => m.id));
  const validItemTypes = new Set(ITEM_TYPES.map(t => t.id));

  if (!validMaterials.has(material)) {
    return res.status(400).send(page('Invalid input',
      `<h1>Invalid material</h1><p>Unknown material: ${String(material).slice(0, 40)}</p>`));
  }

  const safeItemType = validItemTypes.has(item_type) ? item_type : 'sheet';
  const w = parseFloat(width);
  const h = parseFloat(height);

  if (!isFinite(w) || w <= 0 || w > 500 || !isFinite(h) || h <= 0 || h > 500) {
    return res.status(400).send(page('Invalid dimensions',
      '<h1>Invalid dimensions</h1><p>Width and height must be between 0 and 500 inches.</p>'));
  }

  const safeThickness = thickness || '1/8';
  const safeNotes     = notes     || '';
  const ts            = now();
  const matLabel      = MAT_LABELS[material] ?? material;

  db.prepare(
    `INSERT INTO inventory
       (item_type, material, width, height, thickness, quantity, sku, notes, unit_cost, label_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, '', ?, 0, ?, ?, ?)`
  ).run(safeItemType, material, w, h, safeThickness, safeNotes, id, ts, ts);

  db.prepare("UPDATE label_pool SET status = 'active', assigned_at = ? WHERE id = ?").run(ts, id);

  // Build a JSON-safe template object to write into localStorage
  const tplJson = JSON.stringify({
    item_type:  safeItemType,
    material:   material,
    mat_label:  matLabel,
    width:      w,
    height:     h,
    thickness:  safeThickness,
  });

  res.send(page('Checked In', `
    ${TPL_JS}
    <h1>Checked in ✓</h1>
    <span class="badge in">In stock</span>
    <span class="id">${id}</span>
    <div class="card">
      <div class="meta-row"><span class="ml">Type</span><span class="mv">${safeItemType}</span></div>
      <div class="meta-row"><span class="ml">Material</span><span class="mv">${matLabel}</span></div>
      <div class="meta-row"><span class="ml">Size</span><span class="mv">${w}" \xd7 ${h}"</span></div>
      <div class="meta-row"><span class="ml">Thickness</span><span class="mv">${safeThickness}"</span></div>
      ${safeNotes ? `<div class="meta-row"><span class="ml">Notes</span><span class="mv">${safeNotes}</span></div>` : ''}
    </div>

    <p class="next-hint">
      Template saved — scan your next<br>
      <strong style="color:#e8e8f0">${matLabel} ${safeThickness}"</strong> sheet
    </p>

    <script>
    saveTpl(${tplJson});
    </script>

    <p style="text-align:center;margin-top:24px">
      <button class="tpl-clear" onclick="clearTpl();this.textContent='Cleared ✓'">
        Different material next? Clear template
      </button>
    </p>
  `));
});

// ── POST /m/:id/out ───────────────────────────────────────────────────────────
router.post('/:id/out', (req, res) => {
  const { id } = req.params;
  const label = db.prepare('SELECT * FROM label_pool WHERE id = ?').get(id);

  db.prepare('UPDATE inventory SET quantity = 0, updated_at = ? WHERE label_id = ?').run(now(), id);

  if (label) {
    db.prepare("UPDATE label_pool SET status = 'retired' WHERE id = ?").run(id);
  } else {
    db.prepare("INSERT OR IGNORE INTO label_pool (id, status, created_at) VALUES (?, 'retired', ?)")
      .run(id, now());
  }

  res.send(page('Checked Out', `
    <h1>Checked out ✓</h1>
    <span class="badge out">Retired</span>
    <span class="id">${id}</span>
    <p>Piece marked as used. The label is now retired.<br>
       Stick a fresh label on any new material.</p>
  `));
});

module.exports = router;
