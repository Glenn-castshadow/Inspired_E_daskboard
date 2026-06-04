import { useState, useEffect, useCallback, useRef } from "react";
import {
  MATERIALS, CATEGORIES, FINISHES, ITEM_TYPES,
  CAT_MAP, FIN_MAP, matMeta, parseSku,
} from "./taxonomy.js";

const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI__);

// Taxonomy (categories, finishes, materials, item types) and the SKU grammar
// now live in ./taxonomy.js so every tab shares one source of truth.
// Re-exported here for back-compat with existing importers.
export { MATERIALS, CATEGORIES, FINISHES };

// ── Mock data (Vite preview only) ─────────────────────────────────────────────

const MOCK_INVENTORY = [
  { id: 1, item_type: "sheet",    material: "plywood",       width: 48, height: 96, thickness: "1/4", quantity: 3, sku: "",              notes: "",                 created_at: 0, updated_at: 0 },
  { id: 2, item_type: "sheet",    material: "raw_mdf",       width: 48, height: 96, thickness: "1/8", quantity: 5, sku: "",              notes: "",                 created_at: 0, updated_at: 0 },
  { id: 3, item_type: "blank",    material: "copper_mdf",    width: 12, height: 18, thickness: "1/8", quantity: 7, sku: "DBC-RBH-SM-CU", notes: "",                 created_at: 0, updated_at: 0 },
  { id: 4, item_type: "blank",    material: "gold_foil_mdf", width: 8,  height: 12, thickness: "1/8", quantity: 4, sku: "ORN-RBH4-CPF",  notes: "Mixed pattern",    created_at: 0, updated_at: 0 },
  { id: 5, item_type: "blank",    material: "copper_mdf",    width: 6,  height: 9,  thickness: "1/8", quantity: 2, sku: "",              notes: "",                 created_at: 0, updated_at: 0 },
  { id: 6, item_type: "finished", material: "copper_mdf",    width: 12, height: 18, thickness: "1/8", quantity: 2, sku: "DBC-RBH-SM-CU", notes: "Display + extra",  created_at: 0, updated_at: 0 },
  { id: 7, item_type: "finished", material: "gold_foil_mdf", width: 9,  height: 12, thickness: "1/8", quantity: 1, sku: "CLM-LOT-CU",    notes: "Photo prop",       created_at: 0, updated_at: 0 },
  { id: 8, item_type: "offcut",   material: "copper_mdf",    width: 8,  height: 6,  thickness: "1/8", quantity: 1, sku: "",              notes: "From 12×18 cut",   created_at: 0, updated_at: 0 },
  { id: 9, item_type: "offcut",   material: "raw_mdf",       width: 10, height: 8,  thickness: "1/8", quantity: 1, sku: "",              notes: "",                 created_at: 0, updated_at: 0 },
];

const MOCK_PRODUCTS = [
  { id: 1, sku: "DBC-RBH-SM-CU",  name: "Robie House Chime - Small",   category: "DBC", design: "RBH", finish: "CU",  width: 12, height: 18, thickness: "1/8", material: "copper_mdf",    notes: "", active: true, created_at: 0, updated_at: 0 },
  { id: 2, sku: "CLM-LOT-CU",     name: "Lotus Column",                category: "CLM", design: "LOT", finish: "CU",  width: 9,  height: 12, thickness: "1/8", material: "copper_mdf",    notes: "", active: true, created_at: 0, updated_at: 0 },
  { id: 3, sku: "ORN-RBH4-CPF",   name: "Robie 4-Pack Ornament",       category: "ORN", design: "RBH", finish: "CPF", width: 8,  height: 12, thickness: "1/8", material: "gold_foil_mdf", notes: "", active: true, created_at: 0, updated_at: 0 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDims(w, h) {
  const fmt = n => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
  return `${fmt(w)}" × ${fmt(h)}"`;
}

function fmtMoney(n) {
  return `$${(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function invokeOrMock(cmd, args, mockFn) {
  if (!isTauri) return mockFn();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// ── Shared style tokens ───────────────────────────────────────────────────────

const labelStyle = {
  display: "flex", flexDirection: "column", gap: 4,
  fontFamily: "'DM Sans', sans-serif", fontSize: 11, fontWeight: 600,
  color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em",
};

const btnPrimary = {
  fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 600,
  color: "#fff", background: "var(--accent)", border: "none",
  borderRadius: 6, padding: "8px 18px", cursor: "pointer",
};

const btnSecondary = {
  fontFamily: "'DM Sans', sans-serif", fontSize: 13,
  color: "var(--text-muted)", background: "none",
  border: "1px solid var(--border)", borderRadius: 6,
  padding: "8px 14px", cursor: "pointer",
};

const iconBtn = {
  background: "none", border: "none", cursor: "pointer", fontSize: 13,
  color: "var(--text-muted)", padding: "2px 4px", borderRadius: 4,
  fontFamily: "'DM Sans', sans-serif",
};

const fieldStyle = {
  fontFamily: "'DM Sans', sans-serif", fontSize: 13,
  padding: "7px 10px", borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-canvas)", color: "var(--text)",
  width: "100%", boxSizing: "border-box",
};

const adjBtn = (color) => ({
  width: 22, height: 22, border: "none", borderRadius: 4,
  background: "var(--bg-muted)", color,
  fontSize: 14, fontWeight: 700, lineHeight: 1,
  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
  fontFamily: "'DM Sans', sans-serif",
});

// ── Material chip ─────────────────────────────────────────────────────────────

function MatChip({ materialId }) {
  const m = matMeta(materialId);
  return (
    <span style={{
      display: "inline-block",
      fontSize: 10, fontWeight: 700, fontFamily: "'DM Sans', sans-serif",
      letterSpacing: "0.04em", textTransform: "uppercase",
      color: "#fff", background: m.color,
      padding: "2px 8px", borderRadius: 10,
      whiteSpace: "nowrap",
    }}>{m.label}</span>
  );
}

// ── SKU badge ─────────────────────────────────────────────────────────────────

function SkuBadge({ sku }) {
  if (!sku) return null;
  return (
    <span style={{
      fontFamily: "monospace", fontSize: 11, fontWeight: 700,
      letterSpacing: "0.06em",
      background: "var(--bg-muted)", border: "1px solid var(--border)",
      borderRadius: 4, padding: "2px 6px",
      color: "var(--text)", whiteSpace: "nowrap",
    }}>{sku}</span>
  );
}

// ── Inline qty cell ───────────────────────────────────────────────────────────

function QtyCell({ item, reconcileMode, onAdjust, onSet }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(item.quantity));
  const inputRef = useRef(null);

  useEffect(() => {
    if (reconcileMode || editing) setDraft(String(item.quantity));
  }, [item.quantity, reconcileMode, editing]);

  useEffect(() => {
    if ((reconcileMode || editing) && inputRef.current) inputRef.current.select();
  }, [reconcileMode, editing]);

  const commit = () => {
    const n = parseInt(draft, 10);
    if (!isNaN(n) && n >= 0 && n !== item.quantity) onSet(item.id, n);
    setEditing(false);
  };

  if (reconcileMode || editing) {
    return (
      <input
        ref={inputRef}
        type="number" min="0"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        style={{
          width: 52, textAlign: "center", fontSize: 13, fontWeight: 700,
          fontFamily: "'DM Sans', sans-serif",
          padding: "3px 6px", borderRadius: 6,
          border: "2px solid var(--accent)",
          background: "var(--bg-canvas)", color: "var(--text)",
        }}
      />
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <button onClick={() => onAdjust(item.id, -1)} style={adjBtn("#c0392b")}>−</button>
      <span
        onClick={() => setEditing(true)}
        title="Click to edit quantity"
        style={{
          minWidth: 32, textAlign: "center", fontSize: 13, fontWeight: 700,
          fontFamily: "'DM Sans', sans-serif", cursor: "text",
          padding: "2px 4px", borderRadius: 4,
          color: item.quantity === 0 ? "var(--text-faint)" : "var(--text)",
        }}
      >{item.quantity}</span>
      <button onClick={() => onAdjust(item.id, +1)} style={adjBtn("var(--accent)")}>+</button>
    </div>
  );
}

// ── Add / Edit inventory item form ────────────────────────────────────────────

const BLANK_FORM = {
  item_type: "blank", material: "copper_mdf",
  width: "", height: "", thickness: "1/8", quantity: "1", sku: "", notes: "", unit_cost: "",
};

function ItemForm({ initial = BLANK_FORM, onSave, onCancel }) {
  const [form, setForm] = useState({ ...BLANK_FORM, ...initial });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const valid = form.material && parseFloat(form.width) > 0 && parseFloat(form.height) > 0;
  const showSku = form.item_type === "blank" || form.item_type === "finished";

  const handleSave = () => {
    if (!valid) return;
    onSave({
      item_type:  form.item_type,
      material:   form.material,
      width:      parseFloat(form.width),
      height:     parseFloat(form.height),
      thickness:  form.thickness,
      quantity:   Math.max(0, parseInt(form.quantity, 10) || 0),
      sku:        showSku ? form.sku.toUpperCase().trim() : "",
      notes:      form.notes.trim(),
      unit_cost:  Math.max(0, parseFloat(form.unit_cost) || 0),
    });
  };

  return (
    <div style={{
      background: "var(--bg-surface)", border: "1px solid var(--border)",
      borderRadius: 10, padding: "18px 20px",
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      {/* Row 1: type + material */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label style={labelStyle}>
          Type
          <select value={form.item_type} onChange={e => set("item_type", e.target.value)} style={fieldStyle}>
            {ITEM_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        <label style={labelStyle}>
          Material
          <select value={form.material} onChange={e => set("material", e.target.value)} style={fieldStyle}>
            {MATERIALS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
      </div>

      {/* Row 2: dimensions + thickness + qty + cost */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 90px 70px 110px", gap: 10 }}>
        <label style={labelStyle}>
          Width (in)
          <input type="number" min="0" step="0.25" value={form.width}
            onChange={e => set("width", e.target.value)} style={fieldStyle} placeholder='e.g. 12' />
        </label>
        <label style={labelStyle}>
          Height (in)
          <input type="number" min="0" step="0.25" value={form.height}
            onChange={e => set("height", e.target.value)} style={fieldStyle} placeholder='e.g. 18' />
        </label>
        <label style={labelStyle}>
          Thickness
          <select value={form.thickness} onChange={e => set("thickness", e.target.value)} style={fieldStyle}>
            <option value="1/8">⅛"</option>
            <option value="1/4">¼"</option>
          </select>
        </label>
        <label style={labelStyle}>
          Qty
          <input type="number" min="0" value={form.quantity}
            onChange={e => set("quantity", e.target.value)} style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Unit cost ($)
          <input type="number" min="0" step="0.01" value={form.unit_cost}
            onChange={e => set("unit_cost", e.target.value)} style={fieldStyle} placeholder="0.00" />
        </label>
      </div>

      {/* SKU — only for blank / finished */}
      {showSku && (
        <label style={labelStyle}>
          SKU <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(optional — links to product catalog)</span>
          <input type="text" value={form.sku}
            onChange={e => set("sku", e.target.value.toUpperCase())}
            style={{ ...fieldStyle, fontFamily: "monospace", letterSpacing: "0.06em" }}
            placeholder="e.g. DBC-RBH-SM-CU" />
        </label>
      )}

      {/* Notes */}
      <label style={labelStyle}>
        Notes (optional)
        <input type="text" value={form.notes}
          onChange={e => set("notes", e.target.value)} style={fieldStyle}
          placeholder="e.g. Mixed pattern, from 48×96 sheet" />
      </label>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={btnSecondary}>Cancel</button>
        <button onClick={handleSave} disabled={!valid} style={{ ...btnPrimary, opacity: valid ? 1 : 0.4 }}>Save item</button>
      </div>
    </div>
  );
}

// ── Item row ──────────────────────────────────────────────────────────────────

function ItemRow({ item, reconcileMode, onAdjust, onSet, onEdit, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const showSku = item.item_type === "blank" || item.item_type === "finished";

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "150px 100px 50px 1fr 104px 96px 72px",
      gap: 10, alignItems: "center",
      padding: "9px 14px",
      background: item.quantity === 0 ? "var(--bg-muted)" : "var(--bg-surface)",
      border: "1px solid var(--border)",
      borderRadius: 8,
      opacity: item.quantity === 0 ? 0.65 : 1,
    }}>
      {/* Material */}
      <MatChip materialId={item.material} />

      {/* Dimensions */}
      <div style={{
        fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 600,
        color: "var(--text)",
      }}>{fmtDims(item.width, item.height)}</div>

      {/* Thickness — only show ¼" prominently; ⅛" is the implicit default */}
      <div style={{
        fontFamily: "'DM Sans', sans-serif", fontSize: 11,
        color: item.thickness === "1/4" ? "var(--text)" : "var(--text-faint)",
        fontWeight: item.thickness === "1/4" ? 700 : 400,
      }}>{item.thickness === "1/4" ? "¼\"" : "⅛\""}</div>

      {/* SKU + notes */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2, overflow: "hidden" }}>
        {showSku && item.sku && <SkuBadge sku={item.sku} />}
        {item.notes && (
          <div style={{
            fontFamily: "'DM Sans', sans-serif", fontSize: 12,
            color: "var(--text-muted)", overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{item.notes}</div>
        )}
      </div>

      {/* Qty controls */}
      <QtyCell item={item} reconcileMode={reconcileMode} onAdjust={onAdjust} onSet={onSet} />

      {/* Cost: unit cost + extended (qty × unit cost) */}
      <div style={{ textAlign: "right" }}>
        {item.unit_cost > 0 ? (
          <>
            <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
              {fmtMoney(item.unit_cost * item.quantity)}
            </div>
            <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 10, color: "var(--text-faint)" }}>
              {fmtMoney(item.unit_cost)} ea
            </div>
          </>
        ) : (
          <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "var(--text-faint)" }}>—</span>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        {confirmDelete ? (
          <>
            <button onClick={() => setConfirmDelete(false)} style={{ ...iconBtn, color: "var(--text-muted)" }}>✕</button>
            <button onClick={() => onDelete(item.id)} style={{ ...iconBtn, color: "#c0392b" }}>Delete</button>
          </>
        ) : (
          <>
            <button onClick={() => onEdit(item)} title="Edit" style={iconBtn}>✎</button>
            <button onClick={() => setConfirmDelete(true)} title="Delete" style={{ ...iconBtn, color: "var(--text-faint)" }}>🗑</button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Inventory section ─────────────────────────────────────────────────────────

function Section({ title, items, reconcileMode, onAdjust, onSet, onEdit, onDelete, onAdd, addLabel, emptyMsg, defaultType }) {
  const [adding, setAdding] = useState(false);

  const sectionValue = items.reduce((s, i) => s + (i.unit_cost || 0) * i.quantity, 0);

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 12,
      }}>
        <div style={{
          fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 700,
          color: "var(--text)",
        }}>
          {title}
          <span style={{
            marginLeft: 8, fontSize: 11, fontWeight: 600,
            fontFamily: "'DM Sans', sans-serif",
            color: "var(--text-muted)", opacity: 0.7,
          }}>{items.length}</span>
          {sectionValue > 0 && (
            <span style={{
              marginLeft: 10, fontSize: 12, fontWeight: 600,
              fontFamily: "'DM Sans', sans-serif", color: "var(--text-muted)",
            }}>· {fmtMoney(sectionValue)} on hand</span>
          )}
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} style={{ ...btnSecondary, fontSize: 12, padding: "5px 12px" }}>
            + {addLabel}
          </button>
        )}
      </div>

      {adding && (
        <div style={{ marginBottom: 12 }}>
          <ItemForm
            initial={{ ...BLANK_FORM, item_type: defaultType }}
            onSave={item => { onAdd(item); setAdding(false); }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {items.length === 0 && !adding ? (
        <div style={{
          padding: "20px 0", textAlign: "center",
          fontFamily: "'DM Sans', sans-serif", fontSize: 13,
          color: "var(--text-faint)", fontStyle: "italic",
        }}>{emptyMsg}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {items.map(item => (
            <ItemRow
              key={item.id}
              item={item}
              reconcileMode={reconcileMode}
              onAdjust={onAdjust}
              onSet={onSet}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Edit modal ────────────────────────────────────────────────────────────────

function EditModal({ item, onSave, onClose }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
      zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20,
    }}>
      <div style={{
        background: "var(--bg-surface)", borderRadius: 12, padding: "24px 28px",
        width: "100%", maxWidth: 580, boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
      }}>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 700, marginBottom: 18 }}>
          Edit item
        </div>
        <ItemForm
          initial={{
            item_type: item.item_type,
            material:  item.material,
            width:     String(item.width),
            height:    String(item.height),
            thickness: item.thickness,
            quantity:  String(item.quantity),
            sku:       item.sku ?? "",
            notes:     item.notes,
            unit_cost: item.unit_cost != null ? String(item.unit_cost) : "",
          }}
          onSave={updated => onSave({ ...item, ...updated })}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}

// ── Product form ──────────────────────────────────────────────────────────────

const BLANK_PRODUCT = {
  sku: "", name: "", category: "DBC", design: "", finish: "CU",
  width: "", height: "", thickness: "1/8", material: "copper_mdf", notes: "",
};

function ProductForm({ initial = BLANK_PRODUCT, onSave, onCancel }) {
  const [form, setForm] = useState({ ...BLANK_PRODUCT, ...initial });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Auto-populate category / finish from SKU when user blurs the SKU field
  const handleSkuBlur = () => {
    if (!form.sku) return;
    const parsed = parseSku(form.sku);
    setForm(f => ({
      ...f,
      category: parsed.category && CAT_MAP[parsed.category] ? parsed.category : f.category,
      design:   parsed.design   || f.design,
      finish:   parsed.finish   && FIN_MAP[parsed.finish]   ? parsed.finish   : f.finish,
    }));
  };

  const valid = form.sku.trim() && form.name.trim() &&
                parseFloat(form.width) > 0 && parseFloat(form.height) > 0;

  const handleSave = () => {
    if (!valid) return;
    onSave({
      sku:       form.sku.toUpperCase().trim(),
      name:      form.name.trim(),
      category:  form.category,
      design:    form.design.toUpperCase().trim(),
      finish:    form.finish.toUpperCase().trim(),
      width:     parseFloat(form.width),
      height:    parseFloat(form.height),
      thickness: form.thickness,
      material:  form.material,
      notes:     form.notes.trim(),
    });
  };

  return (
    <div style={{
      background: "var(--bg-surface)", border: "1px solid var(--border)",
      borderRadius: 10, padding: "18px 20px",
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      {/* Row 1: SKU + Name */}
      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 10 }}>
        <label style={labelStyle}>
          SKU
          <input type="text" value={form.sku}
            onChange={e => set("sku", e.target.value.toUpperCase())}
            onBlur={handleSkuBlur}
            style={{ ...fieldStyle, fontFamily: "monospace", letterSpacing: "0.06em" }}
            placeholder="DBC-RBH-SM-CU" />
        </label>
        <label style={labelStyle}>
          Product name
          <input type="text" value={form.name}
            onChange={e => set("name", e.target.value)} style={fieldStyle}
            placeholder="e.g. Robie House Chime - Small" />
        </label>
      </div>

      {/* Row 2: Category + Design + Finish */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 1fr", gap: 10 }}>
        <label style={labelStyle}>
          Category
          <select value={form.category} onChange={e => set("category", e.target.value)} style={fieldStyle}>
            {CATEGORIES.map(c => <option key={c.code} value={c.code}>{c.code} — {c.label}</option>)}
          </select>
        </label>
        <label style={labelStyle}>
          Design code
          <input type="text" value={form.design}
            onChange={e => set("design", e.target.value.toUpperCase())}
            style={{ ...fieldStyle, fontFamily: "monospace" }}
            placeholder="RBH" />
        </label>
        <label style={labelStyle}>
          Finish
          <select value={form.finish} onChange={e => set("finish", e.target.value)} style={fieldStyle}>
            {FINISHES.map(f => <option key={f.code} value={f.code}>{f.code} — {f.label}</option>)}
          </select>
        </label>
      </div>

      {/* Row 3: Dimensions + Thickness + Material */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 100px 1fr", gap: 10 }}>
        <label style={labelStyle}>
          Blank width (in)
          <input type="number" min="0" step="0.25" value={form.width}
            onChange={e => set("width", e.target.value)} style={fieldStyle} placeholder='e.g. 12' />
        </label>
        <label style={labelStyle}>
          Blank height (in)
          <input type="number" min="0" step="0.25" value={form.height}
            onChange={e => set("height", e.target.value)} style={fieldStyle} placeholder='e.g. 18' />
        </label>
        <label style={labelStyle}>
          Thickness
          <select value={form.thickness} onChange={e => set("thickness", e.target.value)} style={fieldStyle}>
            <option value="1/8">⅛"</option>
            <option value="1/4">¼"</option>
          </select>
        </label>
        <label style={labelStyle}>
          Material
          <select value={form.material} onChange={e => set("material", e.target.value)} style={fieldStyle}>
            {MATERIALS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
      </div>

      {/* Notes */}
      <label style={labelStyle}>
        Notes (optional)
        <input type="text" value={form.notes}
          onChange={e => set("notes", e.target.value)} style={fieldStyle}
          placeholder="Any extra context for this product" />
      </label>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={btnSecondary}>Cancel</button>
        <button onClick={handleSave} disabled={!valid} style={{ ...btnPrimary, opacity: valid ? 1 : 0.4 }}>
          Save product
        </button>
      </div>
    </div>
  );
}

// ── Product row ───────────────────────────────────────────────────────────────

function ProductRow({ product, finishedCount, blankCount, onEdit, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const catLabel = CAT_MAP[product.category] || product.category;
  const finLabel = FIN_MAP[product.finish]   || product.finish;

  // On-hand status
  const hasFinished = finishedCount > 0;
  const hasBlanks   = blankCount > 0;
  const statusColor = hasFinished ? "#27ae60" : hasBlanks ? "#d4a017" : "var(--text-faint)";
  const statusText  = hasFinished
    ? `${finishedCount} ready`
    : hasBlanks
    ? `${blankCount} blank${blankCount !== 1 ? "s" : ""}`
    : "none";

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "150px 1fr 150px 90px 90px 72px",
      gap: 10, alignItems: "center",
      padding: "10px 14px",
      background: "var(--bg-surface)",
      border: "1px solid var(--border)",
      borderRadius: 8,
    }}>
      {/* SKU */}
      <SkuBadge sku={product.sku} />

      {/* Name + category */}
      <div>
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
          {product.name}
        </div>
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, color: "var(--text-muted)" }}>
          {catLabel} · {finLabel}{product.notes ? ` · ${product.notes}` : ""}
        </div>
      </div>

      {/* Material */}
      <MatChip materialId={product.material} />

      {/* Blank size */}
      <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "var(--text-muted)" }}>
        {product.width && product.height ? fmtDims(product.width, product.height) : "—"}
      </div>

      {/* On hand */}
      <div style={{
        fontFamily: "'DM Sans', sans-serif", fontSize: 12, fontWeight: 600,
        color: statusColor,
      }}>{statusText}</div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        {confirmDelete ? (
          <>
            <button onClick={() => setConfirmDelete(false)} style={{ ...iconBtn, color: "var(--text-muted)" }}>✕</button>
            <button onClick={() => onDelete(product.id)} style={{ ...iconBtn, color: "#c0392b", fontSize: 11 }}>Remove</button>
          </>
        ) : (
          <>
            <button onClick={() => onEdit(product)} title="Edit" style={iconBtn}>✎</button>
            <button onClick={() => setConfirmDelete(true)} title="Remove from catalog" style={{ ...iconBtn, color: "var(--text-faint)" }}>🗑</button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Edit product modal ────────────────────────────────────────────────────────

function EditProductModal({ product, onSave, onClose }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
      zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20,
    }}>
      <div style={{
        background: "var(--bg-surface)", borderRadius: 12, padding: "24px 28px",
        width: "100%", maxWidth: 640, boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
      }}>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 700, marginBottom: 18 }}>
          Edit product
        </div>
        <ProductForm
          initial={{
            sku:       product.sku,
            name:      product.name,
            category:  product.category,
            design:    product.design,
            finish:    product.finish,
            width:     String(product.width),
            height:    String(product.height),
            thickness: product.thickness,
            material:  product.material,
            notes:     product.notes,
          }}
          onSave={updated => onSave({ ...product, ...updated })}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}

// ── Catalog view ──────────────────────────────────────────────────────────────

function CatalogView({ items, products, onAddProduct, onUpdateProduct, onDeleteProduct }) {
  const [adding, setAdding] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);

  // On-hand counts from inventory items
  const finishedBySku = {};
  const blanksBySku   = {};
  items.forEach(item => {
    if (!item.sku) return;
    if (item.item_type === "finished") finishedBySku[item.sku] = (finishedBySku[item.sku] || 0) + item.quantity;
    if (item.item_type === "blank")    blanksBySku[item.sku]   = (blanksBySku[item.sku]   || 0) + item.quantity;
  });

  // Group by category
  const grouped = {};
  products.forEach(p => {
    if (!grouped[p.category]) grouped[p.category] = [];
    grouped[p.category].push(p);
  });
  const sortedCats = Object.keys(grouped).sort();

  return (
    <div>
      {/* Catalog header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>
            Products
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, fontFamily: "'DM Sans', sans-serif", color: "var(--text-muted)", opacity: 0.7 }}>
              {products.length}
            </span>
          </div>
          <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "var(--text-faint)", marginTop: 2 }}>
            Define SKUs and track what's on hand. Add products as you go — no need to enter all 149 upfront.
          </div>
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} style={{ ...btnSecondary, fontSize: 12, padding: "5px 12px" }}>
            + Add product
          </button>
        )}
      </div>

      {/* Add form */}
      {adding && (
        <div style={{ marginBottom: 20 }}>
          <ProductForm
            onSave={p => { onAddProduct(p); setAdding(false); }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {/* Column headers */}
      {products.length > 0 && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "150px 1fr 150px 90px 90px 72px",
          gap: 10, padding: "4px 14px 8px",
          fontFamily: "'DM Sans', sans-serif", fontSize: 10, fontWeight: 700,
          color: "var(--text-muted)", letterSpacing: "0.06em", textTransform: "uppercase",
        }}>
          <div>SKU</div>
          <div>Name</div>
          <div>Material</div>
          <div>Blank size</div>
          <div>On hand</div>
          <div></div>
        </div>
      )}

      {/* Products grouped by category */}
      {products.length === 0 && !adding ? (
        <div style={{
          padding: "40px 0", textAlign: "center",
          fontFamily: "'DM Sans', sans-serif", fontSize: 13,
          color: "var(--text-faint)", fontStyle: "italic",
        }}>
          No products in catalog yet — add your first SKU above.
        </div>
      ) : (
        sortedCats.map(cat => (
          <div key={cat} style={{ marginBottom: 24 }}>
            <div style={{
              fontFamily: "'DM Sans', sans-serif", fontSize: 11, fontWeight: 700,
              color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase",
              marginBottom: 6, paddingLeft: 4,
            }}>
              {cat}{CAT_MAP[cat] ? ` — ${CAT_MAP[cat]}` : ""}
              <span style={{ marginLeft: 6, fontWeight: 400, opacity: 0.6 }}>({grouped[cat].length})</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {grouped[cat].map(p => (
                <ProductRow
                  key={p.id}
                  product={p}
                  finishedCount={finishedBySku[p.sku] || 0}
                  blankCount={blanksBySku[p.sku] || 0}
                  onEdit={setEditingProduct}
                  onDelete={onDeleteProduct}
                />
              ))}
            </div>
          </div>
        ))
      )}

      {/* Edit product modal */}
      {editingProduct && (
        <EditProductModal
          product={editingProduct}
          onSave={p => { onUpdateProduct(p); setEditingProduct(null); }}
          onClose={() => setEditingProduct(null)}
        />
      )}
    </div>
  );
}

// ── Server settings modal ─────────────────────────────────────────────────────

function SettingsModal({ onClose }) {
  const [url,    setUrl]    = useState("");
  const [key,    setKey]    = useState("");
  const [status, setStatus] = useState(null);   // null | "testing" | "ok:msg" | "err:msg"
  const [saving, setSaving] = useState(false);

  // Load current settings on open
  useEffect(() => {
    invokeOrMock("get_settings", {}, () => ({ inventory_server_url: "", inventory_api_key: "" }))
      .then(s => {
        setUrl(s.inventory_server_url || "");
        setKey(s.inventory_api_key   || "");
      })
      .catch(() => {});
  }, []);

  const test = async () => {
    if (!url.trim()) return;
    setStatus("testing");
    try {
      const msg = await invokeOrMock(
        "test_inventory_connection",
        { url: url.trim(), apiKey: key.trim() },
        () => "Connected — 1.0.0 (mock)"
      );
      setStatus("ok:" + msg);
    } catch (e) {
      setStatus("err:" + String(e));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await invokeOrMock("save_settings", {
        newSettings: {
          inventory_server_url: url.trim() || null,
          inventory_api_key:    key.trim() || null,
        },
      }, () => {});
      onClose();
    } catch (e) {
      setStatus("err:Save failed — " + String(e));
    } finally {
      setSaving(false);
    }
  };

  const statusColor = status?.startsWith("ok:") ? "#27ae60"
    : status?.startsWith("err:") ? "#c0392b"
    : "var(--text-muted)";
  const statusMsg = status === "testing" ? "Testing…"
    : status?.startsWith("ok:")  ? status.slice(3)
    : status?.startsWith("err:") ? status.slice(4)
    : null;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
      zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20,
    }}>
      <div style={{
        background: "var(--bg-surface)", borderRadius: 12, padding: "28px 32px",
        width: "100%", maxWidth: 500, boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
      }}>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
          Inventory Server
        </div>
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text-muted)", marginBottom: 22 }}>
          Both machines must point to the same server and use the same API key.
          Leave blank to use local storage on this machine only.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label style={labelStyle}>
            Server URL
            <input
              type="text"
              value={url}
              onChange={e => { setUrl(e.target.value); setStatus(null); }}
              style={fieldStyle}
              placeholder="http://192.168.1.10:3456  or  http://synology.local:3456"
            />
          </label>

          <label style={labelStyle}>
            API key
            <input
              type="password"
              value={key}
              onChange={e => { setKey(e.target.value); setStatus(null); }}
              style={fieldStyle}
              placeholder="Matches API_KEY in .env.docker on the server"
            />
          </label>

          {/* Connection status */}
          {statusMsg && (
            <div style={{
              fontFamily: "'DM Sans', sans-serif", fontSize: 12, fontWeight: 600,
              color: statusColor, padding: "8px 12px",
              background: status?.startsWith("ok:") ? "#f0fdf4" : status?.startsWith("err:") ? "#fff1f0" : "var(--bg-muted)",
              border: `1px solid ${status?.startsWith("ok:") ? "#bbf7d0" : status?.startsWith("err:") ? "#ffd0cc" : "var(--border)"}`,
              borderRadius: 6,
            }}>{statusMsg}</div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 4 }}>
            <button
              onClick={test}
              disabled={!url.trim() || status === "testing"}
              style={{ ...btnSecondary, opacity: url.trim() ? 1 : 0.4 }}
            >
              Test connection
            </button>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onClose} style={btnSecondary}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────

const SUB_TABS = [
  { key: "stock",   label: "Stock"    },
  { key: "catalog", label: "Products" },
];

export default function InventoryTab() {
  const [subTab, setSubTab]             = useState("stock");
  const [items, setItems]               = useState([]);
  const [products, setProducts]         = useState([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [reconcileMode, setReconcile]   = useState(false);
  const [editingItem, setEditingItem]   = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  // ── Load ───────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [invData, catData] = await Promise.all([
        invokeOrMock("get_inventory", {}, () => MOCK_INVENTORY),
        invokeOrMock("get_products",  {}, () => MOCK_PRODUCTS),
      ]);
      setItems(invData);
      setProducts(catData);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Inventory mutations ────────────────────────────────────────────────────

  const addItem = useCallback(async (newItem) => {
    try {
      const created = await invokeOrMock("add_inventory_item", { item: newItem }, () => ({
        ...newItem, id: Date.now(), created_at: 0, updated_at: 0,
      }));
      setItems(prev => [...prev, created]);
    } catch (e) { setError(String(e)); }
  }, []);

  const adjustQty = useCallback(async (id, delta) => {
    try {
      const newQty = await invokeOrMock("adjust_inventory_qty", { id, delta }, () => {
        const item = items.find(i => i.id === id);
        return Math.max(0, (item?.quantity ?? 0) + delta);
      });
      setItems(prev => prev.map(i => i.id === id ? { ...i, quantity: newQty } : i));
    } catch (e) { setError(String(e)); }
  }, [items]);

  const setQty = useCallback(async (id, quantity) => {
    try {
      await invokeOrMock("set_inventory_qty", { id, quantity }, () => {});
      setItems(prev => prev.map(i => i.id === id ? { ...i, quantity } : i));
    } catch (e) { setError(String(e)); }
  }, []);

  const saveEdit = useCallback(async (updatedItem) => {
    try {
      await invokeOrMock("update_inventory_item", { item: updatedItem }, () => {});
      setItems(prev => prev.map(i => i.id === updatedItem.id ? updatedItem : i));
      setEditingItem(null);
    } catch (e) { setError(String(e)); }
  }, []);

  const deleteItem = useCallback(async (id) => {
    try {
      await invokeOrMock("delete_inventory_item", { id }, () => {});
      setItems(prev => prev.filter(i => i.id !== id));
    } catch (e) { setError(String(e)); }
  }, []);

  // ── Product catalog mutations ──────────────────────────────────────────────

  const addProduct = useCallback(async (newProduct) => {
    try {
      const created = await invokeOrMock("add_product", { product: newProduct }, () => ({
        ...newProduct, id: Date.now(), active: true, created_at: 0, updated_at: 0,
      }));
      setProducts(prev => [...prev, created].sort((a, b) => a.sku.localeCompare(b.sku)));
    } catch (e) { setError(String(e)); }
  }, []);

  const updateProduct = useCallback(async (updatedProduct) => {
    try {
      await invokeOrMock("update_product", { product: updatedProduct }, () => {});
      setProducts(prev => prev.map(p => p.id === updatedProduct.id ? updatedProduct : p));
    } catch (e) { setError(String(e)); }
  }, []);

  const deleteProduct = useCallback(async (id) => {
    try {
      await invokeOrMock("delete_product", { id }, () => {});
      setProducts(prev => prev.filter(p => p.id !== id));
    } catch (e) { setError(String(e)); }
  }, []);

  // ── Derived ────────────────────────────────────────────────────────────────

  const sheets   = items.filter(i => i.item_type === "sheet");
  const blanks   = items.filter(i => i.item_type === "blank");
  const finished = items.filter(i => i.item_type === "finished");
  const offcuts  = items.filter(i => i.item_type === "offcut");

  const sharedSectionProps = {
    reconcileMode,
    onAdjust: adjustQty,
    onSet:    setQty,
    onEdit:   setEditingItem,
    onDelete: deleteItem,
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{
      minHeight: "100vh",
      background: "var(--bg-canvas)",
      padding: "32px 40px",
      fontFamily: "'DM Sans', sans-serif",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "flex-start",
        justifyContent: "space-between", marginBottom: 20,
      }}>
        <div>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 700, color: "var(--text)" }}>
            Material Inventory
          </div>
          <div style={{ fontSize: 13, color: "var(--text-faint)", marginTop: 3 }}>
            Laser sheet goods · plywood, MDF &amp; prepared blanks
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Gear / server settings */}
          <button
            onClick={() => setShowSettings(true)}
            title="Inventory server settings"
            style={{ ...iconBtn, fontSize: 16, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 6 }}
          >⚙</button>
        {subTab === "stock" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {reconcileMode && (
              <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600 }}>
                Count mode — click any qty to edit
              </span>
            )}
            <button
              onClick={() => setReconcile(r => !r)}
              style={{
                ...btnSecondary,
                fontWeight: reconcileMode ? 700 : 400,
                borderColor: reconcileMode ? "var(--accent)" : "var(--border)",
                color: reconcileMode ? "var(--accent)" : "var(--text-muted)",
              }}
            >
              {reconcileMode ? "✓ Done counting" : "Count stock"}
            </button>
          </div>
        )}
        </div>  {/* end right-side button group */}
      </div>

      {/* Sub-tab nav */}
      <div style={{
        display: "flex", gap: 2, marginBottom: 28,
        borderBottom: "1px solid var(--border)",
      }}>
        {SUB_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setSubTab(t.key)}
            style={{
              padding: "7px 16px 9px",
              background: "none", border: "none",
              borderBottom: subTab === t.key ? "2px solid var(--accent)" : "2px solid transparent",
              marginBottom: "-1px",
              cursor: "pointer",
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 13,
              fontWeight: subTab === t.key ? 600 : 400,
              color: subTab === t.key ? "var(--accent)" : "var(--text-muted)",
              letterSpacing: "0.01em",
              transition: "color 0.15s, border-color 0.15s",
            }}
          >{t.label}</button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div style={{
          marginBottom: 20, padding: "10px 14px",
          background: "#fff1f0", border: "1px solid #ffd0cc",
          borderRadius: 8, fontSize: 13, color: "#c0392b",
        }}>{error}</div>
      )}

      {/* Loading */}
      {loading ? (
        <div style={{ padding: "48px 0", textAlign: "center", color: "var(--text-faint)", fontSize: 14 }}>
          Loading inventory…
        </div>
      ) : subTab === "stock" ? (
        <>
          <Section
            title="Sheet stock"
            items={sheets}
            addLabel="sheet"
            emptyMsg="No sheet stock recorded yet"
            defaultType="sheet"
            onAdd={item => addItem({ ...item, item_type: "sheet" })}
            {...sharedSectionProps}
          />
          <Section
            title="Prepared blanks"
            items={blanks}
            addLabel="blank"
            emptyMsg="No prepared blanks recorded yet"
            defaultType="blank"
            onAdd={item => addItem({ ...item, item_type: "blank" })}
            {...sharedSectionProps}
          />
          <Section
            title="Finished goods"
            items={finished}
            addLabel="finished piece"
            emptyMsg="No finished pieces on hand — add display samples, overstock, or photo props"
            defaultType="finished"
            onAdd={item => addItem({ ...item, item_type: "finished" })}
            {...sharedSectionProps}
          />
          <Section
            title="Offcut bin"
            items={offcuts}
            addLabel="offcut"
            emptyMsg="Offcut bin is empty"
            defaultType="offcut"
            onAdd={item => addItem({ ...item, item_type: "offcut" })}
            {...sharedSectionProps}
          />
        </>
      ) : (
        <CatalogView
          items={items}
          products={products}
          onAddProduct={addProduct}
          onUpdateProduct={updateProduct}
          onDeleteProduct={deleteProduct}
        />
      )}

      {/* Edit inventory item modal */}
      {editingItem && (
        <EditModal
          item={editingItem}
          onSave={saveEdit}
          onClose={() => setEditingItem(null)}
        />
      )}

      {/* Server settings modal */}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
