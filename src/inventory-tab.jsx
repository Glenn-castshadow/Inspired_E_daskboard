import { useState, useEffect, useCallback, useRef } from "react";

const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI__);

// ── Material presets ──────────────────────────────────────────────────────────

export const MATERIALS = [
  { id: "plywood",         label: "Plywood",       color: "#b5885a" },
  { id: "raw_mdf",         label: "Raw MDF",        color: "#9e9e9e" },
  { id: "copper_mdf",      label: "Copper MDF",     color: "#b87333" },
  { id: "gold_foil_mdf",   label: "Gold Foil",      color: "#c9a84c" },
  { id: "silver_foil_mdf", label: "Silver Foil",    color: "#8a9ba8" },
  { id: "black_foil_mdf",  label: "Black Foil",     color: "#444" },
  { id: "white_foil_mdf",  label: "White Foil",     color: "#aaa" },
  { id: "custom",          label: "Other / Custom", color: "#7c6f9f" },
];

const MAT = Object.fromEntries(MATERIALS.map(m => [m.id, m]));

function matMeta(id) {
  return MAT[id] ?? { id, label: id, color: "#777" };
}

const ITEM_TYPES = [
  { id: "sheet",  label: "Sheet stock"      },
  { id: "blank",  label: "Prepared blank"   },
  { id: "offcut", label: "Offcut bin"        },
];

// ── Mock data (Vite preview only) ─────────────────────────────────────────────

const MOCK_INVENTORY = [
  { id: 1, item_type: "sheet",  material: "plywood",       width: 48, height: 96, thickness: "1/4", quantity: 3, notes: "",                   created_at: 0, updated_at: 0 },
  { id: 2, item_type: "sheet",  material: "raw_mdf",       width: 48, height: 96, thickness: "1/8", quantity: 5, notes: "",                   created_at: 0, updated_at: 0 },
  { id: 3, item_type: "blank",  material: "copper_mdf",    width: 12, height: 18, thickness: "1/8", quantity: 7, notes: "",                   created_at: 0, updated_at: 0 },
  { id: 4, item_type: "blank",  material: "gold_foil_mdf", width: 8,  height: 12, thickness: "1/8", quantity: 4, notes: "Mixed pattern",      created_at: 0, updated_at: 0 },
  { id: 5, item_type: "blank",  material: "copper_mdf",    width: 6,  height: 9,  thickness: "1/8", quantity: 2, notes: "",                   created_at: 0, updated_at: 0 },
  { id: 6, item_type: "offcut", material: "copper_mdf",    width: 8,  height: 6,  thickness: "1/8", quantity: 1, notes: "From 12×18 cut",     created_at: 0, updated_at: 0 },
  { id: 7, item_type: "offcut", material: "raw_mdf",       width: 10, height: 8,  thickness: "1/8", quantity: 1, notes: "",                   created_at: 0, updated_at: 0 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDims(w, h) {
  const fmt = n => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
  return `${fmt(w)}" × ${fmt(h)}"`;
}

async function invokeOrMock(cmd, args, mockFn) {
  if (!isTauri) return mockFn();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

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

const adjBtn = (color) => ({
  width: 22, height: 22, border: "none", borderRadius: 4,
  background: "var(--bg-muted)", color,
  fontSize: 14, fontWeight: 700, lineHeight: 1,
  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
  fontFamily: "'DM Sans', sans-serif",
});

// ── Add / Edit item form ──────────────────────────────────────────────────────

const BLANK_FORM = {
  item_type: "blank", material: "copper_mdf",
  width: "", height: "", thickness: "1/8", quantity: "1", notes: "",
};

function ItemForm({ initial = BLANK_FORM, onSave, onCancel }) {
  const [form, setForm] = useState({ ...BLANK_FORM, ...initial });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const valid = form.material && parseFloat(form.width) > 0 && parseFloat(form.height) > 0;

  const handleSave = () => {
    if (!valid) return;
    onSave({
      item_type:  form.item_type,
      material:   form.material,
      width:      parseFloat(form.width),
      height:     parseFloat(form.height),
      thickness:  form.thickness,
      quantity:   Math.max(0, parseInt(form.quantity, 10) || 0),
      notes:      form.notes.trim(),
    });
  };

  const field = {
    fontFamily: "'DM Sans', sans-serif", fontSize: 13,
    padding: "7px 10px", borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg-canvas)", color: "var(--text)",
    width: "100%", boxSizing: "border-box",
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
          <select value={form.item_type} onChange={e => set("item_type", e.target.value)} style={field}>
            {ITEM_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        <label style={labelStyle}>
          Material
          <select value={form.material} onChange={e => set("material", e.target.value)} style={field}>
            {MATERIALS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
      </div>

      {/* Row 2: dimensions + thickness + qty */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 100px 80px", gap: 10 }}>
        <label style={labelStyle}>
          Width (in)
          <input type="number" min="0" step="0.25" value={form.width}
            onChange={e => set("width", e.target.value)} style={field} placeholder='e.g. 12' />
        </label>
        <label style={labelStyle}>
          Height (in)
          <input type="number" min="0" step="0.25" value={form.height}
            onChange={e => set("height", e.target.value)} style={field} placeholder='e.g. 18' />
        </label>
        <label style={labelStyle}>
          Thickness
          <select value={form.thickness} onChange={e => set("thickness", e.target.value)} style={field}>
            <option value="1/8">⅛"</option>
            <option value="1/4">¼"</option>
          </select>
        </label>
        <label style={labelStyle}>
          Qty
          <input type="number" min="0" value={form.quantity}
            onChange={e => set("quantity", e.target.value)} style={field} />
        </label>
      </div>

      {/* Row 3: notes */}
      <label style={labelStyle}>
        Notes (optional)
        <input type="text" value={form.notes}
          onChange={e => set("notes", e.target.value)} style={field}
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

// ── Section ───────────────────────────────────────────────────────────────────

function Section({ title, items, reconcileMode, onAdjust, onSet, onEdit, onDelete, onAdd, addLabel, emptyMsg }) {
  const [adding, setAdding] = useState(false);

  return (
    <div style={{ marginBottom: 32 }}>
      {/* Section header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 12,
      }}>
        <div style={{
          fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 700,
          color: "var(--text)",
        }}>{title}
          <span style={{
            marginLeft: 8, fontSize: 11, fontWeight: 600,
            fontFamily: "'DM Sans', sans-serif",
            color: "var(--text-muted)", opacity: 0.7,
          }}>{items.length}</span>
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} style={{
            ...btnSecondary, fontSize: 12, padding: "5px 12px",
          }}>+ {addLabel}</button>
        )}
      </div>

      {/* Add form */}
      {adding && (
        <div style={{ marginBottom: 12 }}>
          <ItemForm
            onSave={item => { onAdd(item); setAdding(false); }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {/* Items table */}
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

// ── Item row ──────────────────────────────────────────────────────────────────

function ItemRow({ item, reconcileMode, onAdjust, onSet, onEdit, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "160px 110px 60px 1fr 110px 72px",
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

      {/* Thickness — only show ¼" since ⅛" is default/expected */}
      <div style={{
        fontFamily: "'DM Sans', sans-serif", fontSize: 11,
        color: item.thickness === "1/4" ? "var(--text)" : "var(--text-faint)",
        fontWeight: item.thickness === "1/4" ? 700 : 400,
      }}>{item.thickness === "1/4" ? "¼\"" : "⅛\""}</div>

      {/* Notes */}
      <div style={{
        fontFamily: "'DM Sans', sans-serif", fontSize: 12,
        color: "var(--text-muted)", overflow: "hidden",
        textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{item.notes}</div>

      {/* Qty controls */}
      <QtyCell item={item} reconcileMode={reconcileMode} onAdjust={onAdjust} onSet={onSet} />

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

const iconBtn = {
  background: "none", border: "none", cursor: "pointer", fontSize: 13,
  color: "var(--text-muted)", padding: "2px 4px", borderRadius: 4,
  fontFamily: "'DM Sans', sans-serif",
};

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
        width: "100%", maxWidth: 560, boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
      }}>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 700, marginBottom: 18 }}>
          Edit item
        </div>
        <ItemForm
          initial={{
            item_type:  item.item_type,
            material:   item.material,
            width:      String(item.width),
            height:     String(item.height),
            thickness:  item.thickness,
            quantity:   String(item.quantity),
            notes:      item.notes,
          }}
          onSave={updated => onSave({ ...item, ...updated })}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export default function InventoryTab() {
  const [items, setItems]               = useState([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [reconcileMode, setReconcile]   = useState(false);
  const [editingItem, setEditingItem]   = useState(null);

  // ── Load ───────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await invokeOrMock("get_inventory", {}, () => MOCK_INVENTORY);
      setItems(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Mutations ──────────────────────────────────────────────────────────────

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

  // ── Derived ────────────────────────────────────────────────────────────────

  const sheets  = items.filter(i => i.item_type === "sheet");
  const blanks  = items.filter(i => i.item_type === "blank");
  const offcuts = items.filter(i => i.item_type === "offcut");

  // ── Render ─────────────────────────────────────────────────────────────────

  const sharedSectionProps = {
    reconcileMode,
    onAdjust: adjustQty,
    onSet:    setQty,
    onEdit:   setEditingItem,
    onDelete: deleteItem,
  };

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
        justifyContent: "space-between", marginBottom: 28,
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
      ) : (
        <>
          <Section
            title="Sheet stock"
            items={sheets}
            addLabel="sheet"
            emptyMsg="No sheet stock recorded yet"
            onAdd={item => addItem({ ...item, item_type: "sheet" })}
            {...sharedSectionProps}
          />
          <Section
            title="Prepared blanks"
            items={blanks}
            addLabel="blank"
            emptyMsg="No prepared blanks recorded yet"
            onAdd={item => addItem({ ...item, item_type: "blank" })}
            {...sharedSectionProps}
          />
          <Section
            title="Offcut bin"
            items={offcuts}
            addLabel="offcut"
            emptyMsg="Offcut bin is empty"
            onAdd={item => addItem({ ...item, item_type: "offcut" })}
            {...sharedSectionProps}
          />
        </>
      )}

      {/* Edit modal */}
      {editingItem && (
        <EditModal
          item={editingItem}
          onSave={saveEdit}
          onClose={() => setEditingItem(null)}
        />
      )}
    </div>
  );
}
