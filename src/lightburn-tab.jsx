import { useState, useEffect, useRef, useCallback } from "react";
import { CATEGORIES } from "./taxonomy.js";
import { SHOP_META } from "./config.js";

const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI__);

// ── Mock data (Vite preview only) ─────────────────────────────────────────────

const MOCK_FILES = [
  { id: 1, sku_base: "DBC-RBH", short_name: "doorbell-chime-round",  filename: "DBC-RBH_doorbell-chime-round.lbrn2",  created_at: 0, updated_at: 0 },
  { id: 2, sku_base: "ORN-ARC", short_name: "arch-ornament",         filename: "ORN-ARC_arch-ornament.lbrn2",          created_at: 0, updated_at: 0 },
  { id: 3, sku_base: "WAL-GEO", short_name: "wall-panel-geometric",  filename: "WAL-GEO_wall-panel-geometric.lbrn2",   created_at: 0, updated_at: 0 },
];

const MOCK_MAPPINGS = [
  { id: 1, product_name: "Architectural Doorbell Cover – Round", lightburn_file_id: 1, sku_base: "DBC-RBH", short_name: "doorbell-chime-round", filename: "DBC-RBH_doorbell-chime-round.lbrn2" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function buildFilename(skuBase, shortName) {
  if (!skuBase) return "";
  const slug = slugify(shortName || "");
  return slug ? `${skuBase.toUpperCase()}_${slug}.lbrn2` : `${skuBase.toUpperCase()}.lbrn2`;
}

const decodeHtml = (() => {
  const ta = typeof document !== "undefined" ? document.createElement("textarea") : null;
  return (s) => { if (!s || !ta) return s ?? ""; ta.innerHTML = s; return ta.value; };
})();

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ── Style helpers ─────────────────────────────────────────────────────────────

function Label({ children }) {
  return (
    <div style={{
      fontFamily: "'DM Sans', sans-serif",
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: "0.09em",
      color: "var(--text-faint)",
      marginBottom: 5,
    }}>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return <div><Label>{label}</Label>{children}</div>;
}

const inputStyle = {
  width: "100%",
  padding: "7px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-surface)",
  color: "var(--text)",
  fontFamily: "'DM Sans', sans-serif",
  fontSize: 13,
  boxSizing: "border-box",
};

const btnStyle = (variant = "primary") => ({
  padding: "8px 16px",
  borderRadius: 6,
  cursor: "pointer",
  fontFamily: "'DM Sans', sans-serif",
  fontSize: 13,
  fontWeight: 500,
  background: variant === "primary" ? "var(--accent)" : "var(--bg-surface)",
  color:      variant === "primary" ? "#fff"          : "var(--text-muted)",
  border:     variant === "primary" ? "none"          : "1px solid var(--border)",
});

// ── Edit modal ────────────────────────────────────────────────────────────────

function EditModal({ file, onSave, onCancel, saving }) {
  const parts    = file.sku_base.split("-");
  const [category, setCategory] = useState(parts[0] ?? "");
  const [design,   setDesign]   = useState(parts.slice(1).join("-") ?? "");
  const [name,     setName]     = useState(file.short_name);

  const skuBase = [category, design].filter(Boolean).join("-").toUpperCase();
  const preview = buildFilename(skuBase, name);
  const canSave = skuBase && name.trim() && !saving &&
    (skuBase !== file.sku_base || name.trim() !== file.short_name);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: "rgba(0,0,0,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: "var(--bg-surface)", border: "1px solid var(--border)",
        borderRadius: 10, padding: 28, width: 440,
        boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
      }}>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, marginBottom: 4 }}>
          Edit file details
        </div>
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "var(--text-faint)", marginBottom: 20 }}>
          {file.filename}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <Field label="Category">
            <select value={category} onChange={e => setCategory(e.target.value)} style={inputStyle}>
              <option value="">Select…</option>
              {CATEGORIES.map(c => <option key={c.code} value={c.code}>{c.code} — {c.label}</option>)}
            </select>
          </Field>
          <Field label="Design code">
            <input
              value={design}
              onChange={e => setDesign(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              placeholder="e.g. RBH"
              style={inputStyle}
            />
          </Field>
        </div>

        <div style={{ marginBottom: 18 }}>
          <Field label="Short name">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. doorbell chime round"
              style={inputStyle}
            />
          </Field>
        </div>

        {preview && (
          <div style={{
            background: "var(--bg-muted)", border: "1px solid var(--border)",
            borderRadius: 6, padding: "8px 12px", marginBottom: 20,
            fontFamily: "monospace", fontSize: 12, color: "var(--text-muted)",
          }}>
            {preview}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={btnStyle("secondary")} onClick={onCancel} disabled={saving}>Cancel</button>
          <button
            style={{ ...btnStyle("primary"), opacity: canSave ? 1 : 0.5 }}
            onClick={() => canSave && onSave({ skuBase, shortName: name.trim() })}
            disabled={!canSave}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Ingest form modal ─────────────────────────────────────────────────────────

function IngestModal({ pendingFile, onSave, onCancel, saving }) {
  const [category, setCategory] = useState("");
  const [design,   setDesign]   = useState("");
  const [name,     setName]     = useState("");

  const skuBase  = [category, design].filter(Boolean).join("-").toUpperCase();
  const preview  = buildFilename(skuBase, name);
  const canSave  = skuBase && name.trim() && !saving;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: "rgba(0,0,0,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: 28,
        width: 440,
        boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
      }}>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, marginBottom: 4 }}>
          Import Lightburn file
        </div>
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "var(--text-faint)", marginBottom: 20 }}>
          {pendingFile.name}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <Field label="Category">
            <select value={category} onChange={e => setCategory(e.target.value)} style={inputStyle}>
              <option value="">Select…</option>
              {CATEGORIES.map(c => <option key={c.code} value={c.code}>{c.code} — {c.label}</option>)}
            </select>
          </Field>
          <Field label="Design code">
            <input
              value={design}
              onChange={e => setDesign(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              placeholder="e.g. RBH"
              style={inputStyle}
            />
          </Field>
        </div>

        <div style={{ marginBottom: 18 }}>
          <Field label="Short name">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. doorbell chime round"
              style={inputStyle}
            />
          </Field>
        </div>

        {preview && (
          <div style={{
            background: "var(--bg-muted)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "8px 12px",
            marginBottom: 20,
            fontFamily: "monospace",
            fontSize: 12,
            color: "var(--text-muted)",
          }}>
            {preview}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={btnStyle("secondary")} onClick={onCancel} disabled={saving}>Cancel</button>
          <button
            style={{ ...btnStyle("primary"), opacity: canSave ? 1 : 0.5 }}
            onClick={() => canSave && onSave({ skuBase, shortName: name.trim() })}
            disabled={!canSave}
          >
            {saving ? "Saving…" : "Save to library"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── File combobox (type-to-search file picker) ────────────────────────────────

function FileCombobox({ files, value, onChange, disabled }) {
  const [query,    setQuery]    = useState("");
  const [open,     setOpen]     = useState(false);
  const [focused,  setFocused]  = useState(false);
  const wrapRef  = useRef();
  const inputRef = useRef();

  // Current selection label
  const selectedFile = files.find(f => f.id === value);
  const displayText  = focused
    ? query
    : selectedFile ? `${selectedFile.sku_base} · ${selectedFile.short_name}` : "";

  const filtered = query.trim()
    ? files.filter(f => {
        const q = query.toLowerCase();
        return f.sku_base.toLowerCase().includes(q) || f.short_name.toLowerCase().includes(q);
      })
    : files;

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setFocused(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleFocus = () => {
    setFocused(true);
    setQuery("");
    setOpen(true);
  };

  const handleInput = (e) => {
    setQuery(e.target.value);
    setOpen(true);
  };

  const handleSelect = (fileId) => {
    onChange(fileId);
    setOpen(false);
    setFocused(false);
    setQuery("");
    inputRef.current?.blur();
  };

  const handleClear = (e) => {
    e.stopPropagation();
    onChange(null);
    setQuery("");
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", position: "relative" }}>
        <input
          ref={inputRef}
          value={displayText}
          placeholder={files.length === 0 ? "No files in library" : "Search SKU or name…"}
          disabled={disabled || files.length === 0}
          onFocus={handleFocus}
          onChange={handleInput}
          style={{
            ...inputStyle, fontSize: 12, width: "100%",
            paddingRight: selectedFile ? 24 : 10,
            color: focused ? "var(--text)" : selectedFile ? "var(--accent)" : "var(--text-faint)",
          }}
        />
        {selectedFile && !focused && (
          <button
            onMouseDown={handleClear}
            style={{
              position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
              background: "none", border: "none", cursor: "pointer",
              color: "var(--text-faint)", fontSize: 13, lineHeight: 1, padding: 0,
            }}
            title="Unlink"
          >✕</button>
        )}
      </div>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 3px)", left: 0, right: 0,
          background: "var(--bg-surface)", border: "1px solid var(--border)",
          borderRadius: 6, boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
          zIndex: 100, maxHeight: 220, overflowY: "auto",
        }}>
          <div
            onMouseDown={() => handleSelect(null)}
            style={{
              padding: "8px 12px", cursor: "pointer", fontSize: 12,
              fontFamily: "'DM Sans', sans-serif", color: "var(--text-faint)",
              fontStyle: "italic", borderBottom: "1px solid var(--border)",
            }}
          >
            — Not linked —
          </div>
          {filtered.length === 0 ? (
            <div style={{ padding: "8px 12px", fontSize: 12, fontFamily: "'DM Sans', sans-serif", color: "var(--text-faint)" }}>
              No files match "{query}"
            </div>
          ) : (
            filtered.map(f => (
              <div
                key={f.id}
                onMouseDown={() => handleSelect(f.id)}
                style={{
                  padding: "8px 12px", cursor: "pointer", display: "flex", gap: 8, alignItems: "baseline",
                  background: f.id === value ? "var(--bg-muted)" : "transparent",
                }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--bg-muted)"}
                onMouseLeave={e => e.currentTarget.style.background = f.id === value ? "var(--bg-muted)" : "transparent"}
              >
                <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "var(--accent)", flexShrink: 0 }}>
                  {f.sku_base}
                </span>
                <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {f.short_name}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Catalog stats tile ────────────────────────────────────────────────────────

function StatsTile({ orders, mappings }) {
  // First shop_id seen for each unique product name
  const shopByProduct = {};
  for (const o of orders ?? []) {
    if (o.product_name && shopByProduct[o.product_name] === undefined) {
      shopByProduct[o.product_name] = o.shop_id ?? 0;
    }
  }
  const linkedSet = new Set((mappings ?? []).map(m => m.product_name));

  // Per-shop tallies: { shopId: { total, linked } }
  const tally = {};
  for (const [name, shopId] of Object.entries(shopByProduct)) {
    if (!tally[shopId]) tally[shopId] = { total: 0, linked: 0 };
    tally[shopId].total += 1;
    if (linkedSet.has(name)) tally[shopId].linked += 1;
  }

  const totalProducts = Object.keys(shopByProduct).length;
  const totalLinked   = Object.values(tally).reduce((s, t) => s + t.linked, 0);
  const totalUnlinked = totalProducts - totalLinked;

  // Order shops by SHOP_IDS preference, unknowns last
  const known   = [7438218, 6807617, 22660031].filter(id => tally[id]);
  const unknown = Object.keys(tally).map(Number).filter(id => !known.includes(id));
  const shopOrder = [...known, ...unknown];

  const Row = ({ label, total, unlinked, color, bold }) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
        {color && <span style={{ display: "inline-block", width: 3, height: 13, borderRadius: 2, background: color }} />}
        <span style={{
          fontFamily: "'DM Sans', sans-serif", fontSize: 12,
          fontWeight: bold ? 600 : 500, color: "var(--text)",
        }}>
          {label}
        </span>
        <span style={{ marginLeft: "auto", fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
          {total}
        </span>
      </div>
      <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, color: unlinked > 0 ? "#b45a00" : "var(--text-faint)", paddingLeft: color ? 10 : 0 }}>
        {unlinked > 0 ? `${unlinked} without a file` : "all linked ✓"}
      </div>
    </div>
  );

  return (
    <div style={{
      width: 240, flexShrink: 0,
      border: "1px solid var(--border)", borderRadius: 8,
      background: "var(--bg-surface)", padding: "16px 18px", alignSelf: "flex-start",
    }}>
      <div style={{
        fontFamily: "'DM Sans', sans-serif", fontSize: 10, textTransform: "uppercase",
        letterSpacing: "0.09em", color: "var(--text-faint)", marginBottom: 14,
      }}>
        Listing coverage
      </div>

      {shopOrder.map(shopId => {
        const meta = SHOP_META[shopId] ?? { name: shopId === 0 ? "Unknown" : `Shop ${shopId}`, color: "#888" };
        const t = tally[shopId];
        return (
          <Row key={shopId} label={meta.name} color={meta.color} total={t.total} unlinked={t.total - t.linked} />
        );
      })}

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
        <Row label="All listings" total={totalProducts} unlinked={totalUnlinked} bold />
      </div>
    </div>
  );
}

// ── Match Products panel ──────────────────────────────────────────────────────

function MatchProductsPanel({ orders, files, mappings, onMappingChange }) {
  const [saving,  setSaving]  = useState({});   // productName → bool
  const [search,  setSearch]  = useState("");   // product name filter

  // Unique product names from all orders, sorted
  const productNames = [...new Set((orders ?? []).map(o => o.product_name).filter(Boolean))].sort();

  // Product name → first available listing thumbnail
  const imageByProduct = {};
  for (const o of orders ?? []) {
    if (o.product_name && o.image_url && !imageByProduct[o.product_name]) {
      imageByProduct[o.product_name] = o.image_url;
    }
  }

  if (productNames.length === 0) {
    return (
      <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text-faint)" }}>
        No orders loaded — product names appear here once orders sync.
      </div>
    );
  }

  const mappingByProduct = Object.fromEntries((mappings ?? []).map(m => [m.product_name, m]));

  const handleSelect = async (productName, fileId) => {
    setSaving(s => ({ ...s, [productName]: true }));
    try {
      if (isTauri) {
        const { invoke } = await import("@tauri-apps/api/core");
        if (fileId) {
          await invoke("save_lightburn_mapping", { productName, lightburnFileId: fileId });
        } else {
          const existing = mappingByProduct[productName];
          if (existing) await invoke("delete_lightburn_mapping", { id: existing.id });
        }
      }
      onMappingChange?.();
    } catch (e) {
      console.error("mapping error", e);
    } finally {
      setSaving(s => ({ ...s, [productName]: false }));
    }
  };

  // Filter by search query, then sort: unlinked first
  const q = search.trim().toLowerCase();
  const filtered = productNames
    .filter(n => !q || decodeHtml(n).toLowerCase().includes(q))
    .sort((a, b) => {
      const aLinked = mappingByProduct[a] ? 1 : 0;
      const bLinked = mappingByProduct[b] ? 1 : 0;
      return aLinked - bLinked || a.localeCompare(b);
    });

  const linked   = productNames.filter(n =>  mappingByProduct[n]);
  const visible  = filtered.length;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      {/* Search bar */}
      <div style={{
        padding: "10px 16px", background: "var(--bg-muted)", borderBottom: "1px solid var(--border)",
      }}>
        <input
          type="search"
          placeholder="Filter Etsy listings…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            ...inputStyle, width: "100%", fontSize: 12,
            paddingLeft: 28,
            backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.35-4.35'/%3E%3C/svg%3E\")",
            backgroundRepeat: "no-repeat", backgroundPosition: "9px center",
          }}
        />
      </div>

      {/* Column header */}
      <div style={{
        display: "grid", gridTemplateColumns: "44px 1fr 240px 20px",
        gap: 14, padding: "7px 16px", background: "var(--bg-muted)",
        fontFamily: "'DM Sans', sans-serif", fontSize: 10,
        textTransform: "uppercase", letterSpacing: "0.09em", color: "var(--text-faint)",
        borderBottom: "1px solid var(--border)",
      }}>
        <span />
        <span>Etsy product name</span>
        <span>Lightburn file</span>
        <span style={{ textAlign: "center" }}>✓</span>
      </div>

      {visible === 0 ? (
        <div style={{ padding: "14px 16px", fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text-faint)" }}>
          No listings match "{search}".
        </div>
      ) : (
        filtered.map(name => {
          const m   = mappingByProduct[name];
          const isS = saving[name];
          return (
            <div key={name} style={{
              display: "grid", gridTemplateColumns: "44px 1fr 240px 20px",
              alignItems: "center", gap: 14, padding: "9px 16px",
              borderTop: "1px solid var(--border)", background: "var(--bg-surface)",
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: 5, overflow: "hidden",
                background: "var(--bg-muted)", flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {imageByProduct[name] ? (
                  <img src={imageByProduct[name]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    onError={e => { e.currentTarget.style.display = "none"; }} />
                ) : (
                  <span style={{ color: "var(--text-faint)", fontSize: 16 }}>◻</span>
                )}
              </div>
              <div
                title={decodeHtml(name)}
                style={{
                  fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text)", lineHeight: 1.35,
                  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                  overflow: "hidden", textOverflow: "ellipsis",
                }}
              >
                {decodeHtml(name)}
              </div>
              <FileCombobox
                files={files}
                value={m?.lightburn_file_id ?? null}
                disabled={isS}
                onChange={fileId => handleSelect(name, fileId)}
              />
              <span style={{ fontSize: 12, textAlign: "center", color: isS ? "var(--text-faint)" : m ? "#2D6A4F" : "var(--text-faint)" }}>
                {isS ? "…" : m ? "✓" : "○"}
              </span>
            </div>
          );
        })
      )}

      <div style={{
        padding: "7px 16px", background: "var(--bg-muted)",
        fontFamily: "'DM Sans', sans-serif", fontSize: 11, color: "var(--text-faint)",
        borderTop: "1px solid var(--border)",
      }}>
        {linked.length} of {productNames.length} linked
        {q && ` · showing ${visible} of ${productNames.length}`}
        {" · "}changes save instantly
      </div>
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export default function LightburnTab({ orders = [] }) {
  const [files,    setFiles]    = useState([]);
  const [mappings, setMappings] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);

  const [dragOver,    setDragOver]    = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const [saving,      setSaving]      = useState(false);
  const [saveError,   setSaveError]   = useState(null);
  const [toast,       setToast]       = useState(null);

  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [editFile,      setEditFile]      = useState(null);  // file being edited
  const [editSaving,    setEditSaving]    = useState(false);

  const fileInputRef = useRef();

  const showToast = useCallback((msg, isErr = false) => {
    setToast({ msg, isErr });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const load = useCallback(async () => {
    if (!isTauri) {
      setFiles(MOCK_FILES);
      setMappings(MOCK_MAPPINGS);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const [f, m] = await Promise.all([
        invoke("list_lightburn_files"),
        invoke("list_lightburn_mappings"),
      ]);
      setFiles(f);
      setMappings(m);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Native Tauri file drop (Windows Explorer → app window) ─────────────────
  useEffect(() => {
    if (!isTauri) return;
    let unlisten;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("tauri://drag-drop", async (event) => {
        // Payload is { paths: string[] } in Tauri v2
        const paths = Array.isArray(event.payload)
          ? event.payload
          : (event.payload?.paths ?? []);
        const lbr = paths.find(p => p.toLowerCase().endsWith(".lbrn2"));
        if (!lbr) return;
        setDragOver(false);
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const base64 = await invoke("read_file_as_base64", { path: lbr });
          const fileName = lbr.replace(/\\/g, "/").split("/").pop();
          setPendingFile({ name: fileName, base64 });
          setSaveError(null);
        } catch (e) {
          showToast(`Could not read file: ${e}`, true);
        }
      });
      // Visual hover state
      const unlistenHover = await listen("tauri://drag-enter", () => setDragOver(true));
      const unlistenLeave = await listen("tauri://drag-leave", () => setDragOver(false));
      const origUnlisten = unlisten;
      unlisten = () => { origUnlisten(); unlistenHover(); unlistenLeave(); };
    })();
    return () => { unlisten?.(); };
  }, [showToast]);

  // ── Browser file picker (click) ─────────────────────────────────────────────
  const readFile = (file) => {
    if (!file.name.toLowerCase().endsWith(".lbrn2")) {
      showToast("Only .lbrn2 files are supported", true);
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPendingFile({ name: file.name, base64: arrayBufferToBase64(ev.target.result) });
      setSaveError(null);
    };
    reader.readAsArrayBuffer(file);
  };

  const onDragOver  = (e) => { e.preventDefault(); setDragOver(true); };
  const onDragLeave = ()  => setDragOver(false);
  const onDrop      = (e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) readFile(f); };
  const onBrowse    = (e) => { const f = e.target.files[0]; if (f) readFile(f); e.target.value = ""; };

  // ── Save ────────────────────────────────────────────────────────────────────
  const handleSave = async ({ skuBase, shortName }) => {
    if (!pendingFile) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (isTauri) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("save_lightburn_file", { skuBase, shortName, dataBase64: pendingFile.base64 });
      }
      setPendingFile(null);
      showToast(`Saved ${buildFilename(skuBase, shortName)}`);
      await load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Export from library ─────────────────────────────────────────────────────
  const handleExportLib = async (file) => {
    try {
      if (isTauri) {
        const { invoke } = await import("@tauri-apps/api/core");
        const path = await invoke("export_lightburn_file", { lightburnFileId: file.id, filename: file.filename });
        showToast(`Saved → ${path}`);
      }
    } catch (e) {
      showToast(String(e), true);
    }
  };

  // ── Edit ────────────────────────────────────────────────────────────────────
  const handleEdit = async ({ skuBase, shortName }) => {
    if (!editFile) return;
    setEditSaving(true);
    try {
      if (isTauri) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("update_lightburn_file", { id: editFile.id, skuBase, shortName });
      }
      setEditFile(null);
      showToast(`Updated ${buildFilename(skuBase, shortName)}`);
      await load();
    } catch (e) {
      showToast(String(e), true);
    } finally {
      setEditSaving(false);
    }
  };

  // ── Delete ──────────────────────────────────────────────────────────────────
  const handleDelete = async (id) => {
    try {
      if (isTauri) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("delete_lightburn_file", { id });
      }
      setDeleteConfirm(null);
      showToast("File removed from library");
      await load();
    } catch (e) {
      showToast(String(e), true);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{
      height: "calc(100vh - 48px)",
      display: "flex", flexDirection: "column", overflow: "hidden",
      padding: "32px 40px 0", maxWidth: 1180,
    }}>

      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, margin: 0, color: "var(--text)" }}>
          Ingest
        </h2>
        <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text-faint)", margin: "6px 0 0" }}>
          One Lightburn file per base product. Drag a .lbrn2 onto this window or click below to add it to the library.
          Link products to files here, then browse the Listings tab.
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? "var(--accent)" : "var(--border)"}`,
          borderRadius: 10,
          padding: "36px 20px",
          textAlign: "center",
          cursor: "pointer",
          background: dragOver ? "var(--bg-muted)" : "transparent",
          transition: "border-color 0.15s, background 0.15s",
          marginBottom: 28,
        }}
      >
        <div style={{ fontSize: 28, marginBottom: 8, color: "var(--text-faint)" }}>⬇</div>
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 14, color: "var(--text-muted)", marginBottom: 4 }}>
          Drag a .lbrn2 file onto this window, or click to browse
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".lbrn2"
          style={{ display: "none" }}
          onChange={onBrowse}
          onClick={e => e.stopPropagation()}
        />
      </div>

      {saveError && (
        <div style={{ background: "#fff1f0", border: "1px solid #ffa39e", borderRadius: 6, padding: "10px 14px", marginBottom: 16, fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#c0392b" }}>
          {saveError}
        </div>
      )}

      {/* Library + orders — scrollable */}
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 48 }}>

      {/* Library */}
      <div style={{ marginBottom: 36 }}>
        <Label>Lightburn library ({files.length} {files.length === 1 ? "file" : "files"})</Label>

        {loading && <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text-faint)", padding: "20px 0" }}>Loading…</div>}
        {error   && <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#c0392b", padding: "20px 0" }}>{error}</div>}

        {!loading && !error && files.length === 0 && (
          <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text-faint)", padding: "12px 0" }}>
            No files yet.
          </div>
        )}

        {files.length > 0 && (
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{
              display: "grid", gridTemplateColumns: "20px 110px 1fr 1fr auto",
              padding: "8px 16px", background: "var(--bg-muted)", borderBottom: "1px solid var(--border)",
              fontFamily: "'DM Sans', sans-serif", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.09em", color: "var(--text-faint)",
            }}>
              <span /><span>SKU base</span><span>Short name</span><span>Filename</span><span />
            </div>
            {files.map((f, i) => {
              const linked = mappings.some(m => m.lightburn_file_id === f.id);
              return (
                <div key={f.id} style={{
                  display: "grid", gridTemplateColumns: "20px 110px 1fr 1fr auto",
                  alignItems: "center", padding: "10px 16px",
                  borderTop: i === 0 ? "none" : "1px solid var(--border)",
                  background: "var(--bg-surface)",
                }}>
                  <span title={linked ? "Linked to a product" : "Not linked"} style={{
                    display: "inline-block",
                    width: 8, height: 8, borderRadius: "50%",
                    background: linked ? "#2D6A4F" : "transparent",
                    border: linked ? "none" : "1.5px solid var(--border)",
                  }} />
                  <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>{f.sku_base}</span>
                  <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text)" }}>{f.short_name}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-faint)" }}>{f.filename}</span>
                  <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
                    <button onClick={() => handleExportLib(f)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", fontSize: 14, padding: "2px 6px" }}
                      title="Download to Desktop\Lightburn_Exports">↓</button>
                    <button onClick={() => setEditFile(f)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", fontSize: 13, padding: "2px 6px" }}
                      title="Edit details">✎</button>
                    <button onClick={() => setDeleteConfirm(f.id)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", fontSize: 14, padding: "2px 6px" }}
                      title="Remove from library">✕</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Match Products */}
      <div>
        <Label>Match products to files</Label>
        <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "var(--text-faint)", marginTop: 0, marginBottom: 12 }}>
          Link each Etsy product name to its Lightburn file. Unlinked products show at the top.
          The Queue Cut button uses these links automatically.
        </p>
        {!loading && (
          <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <MatchProductsPanel
                orders={orders}
                files={files}
                mappings={mappings}
                onMappingChange={load}
              />
            </div>
            <StatsTile orders={orders} mappings={mappings} />
          </div>
        )}
      </div>

      {/* Modals */}
      {editFile && (
        <EditModal
          file={editFile}
          saving={editSaving}
          onSave={handleEdit}
          onCancel={() => setEditFile(null)}
        />
      )}

      {pendingFile && (
        <IngestModal
          pendingFile={pendingFile}
          saving={saving}
          onSave={handleSave}
          onCancel={() => { setPendingFile(null); setSaveError(null); }}
        />
      )}

      {deleteConfirm != null && (
        <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 28, width: 360, boxShadow: "0 8px 32px rgba(0,0,0,0.25)" }}>
            <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 15, marginBottom: 16 }}>
              Remove this file from the library? The .lbrn2 will also be deleted from disk.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button style={btnStyle("secondary")} onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button style={{ ...btnStyle("primary"), background: "#c0392b" }} onClick={() => handleDelete(deleteConfirm)}>Delete</button>
            </div>
          </div>
        </div>
      )}

      </div> {/* end scrollable area */}

      {toast && (
        <div style={{
          position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)",
          background: toast.isErr ? "#c0392b" : "var(--accent)", color: "#fff",
          padding: "10px 20px", borderRadius: 8, fontFamily: "'DM Sans', sans-serif", fontSize: 13,
          boxShadow: "0 4px 16px rgba(0,0,0,0.3)", zIndex: 300,
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Queue Cut widget (used in fulfillment-view order rows) ────────────────────

export function QueueCutWidget({ order }) {
  const [files,      setFiles]      = useState(null);
  const [mappings,   setMappings]   = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const [remember,   setRemember]   = useState(true);
  const [picked,     setPicked]     = useState(null);
  const [queueing,   setQueueing]   = useState(false);
  const [result,     setResult]     = useState(null);

  const loadLibrary = async () => {
    if (!isTauri) { setFiles(MOCK_FILES); setMappings(MOCK_MAPPINGS); return { files: MOCK_FILES, mappings: MOCK_MAPPINGS }; }
    const { invoke } = await import("@tauri-apps/api/core");
    const [f, m] = await Promise.all([invoke("list_lightburn_files"), invoke("list_lightburn_mappings")]);
    setFiles(f); setMappings(m);
    return { files: f, mappings: m };
  };

  const handleQueue = async (fileId) => {
    if (queueing) return;
    setQueueing(true);
    setResult(null);
    try {
      if (isTauri) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("queue_cut_job", { lightburnFileId: fileId, receiptId: order.receipt_id ?? order.id });
        if (remember && showPicker) {
          await invoke("save_lightburn_mapping", { productName: order.product_name, lightburnFileId: fileId });
        }
      }
      setResult({ ok: true });
      setShowPicker(false);
    } catch (e) {
      setResult({ err: String(e) });
    } finally {
      setQueueing(false);
    }
  };

  const handleClick = async () => {
    setResult(null);
    const { files: f, mappings: m } = files !== null ? { files, mappings } : await loadLibrary();
    const match = (m ?? []).find(mp => mp.product_name === order.product_name);
    if (match) {
      handleQueue(match.lightburn_file_id);
    } else {
      setShowPicker(true);
    }
  };

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-muted)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          onClick={handleClick}
          disabled={queueing}
          style={{
            padding: "6px 14px", borderRadius: 6, border: "1px solid var(--border)",
            background: "var(--bg-surface)", cursor: queueing ? "not-allowed" : "pointer",
            fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "var(--text-muted)",
            display: "flex", alignItems: "center", gap: 6,
          }}
        >
          <span style={{ fontSize: 14 }}>⚡</span>
          {queueing ? "Queuing…" : "Queue cut job"}
        </button>

        {result?.ok  && <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "#2D6A4F" }}>✓ Copied to Jobs_to_Cut</span>}
        {result?.err && <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "#c0392b" }}>{result.err}</span>}
      </div>

      {showPicker && (
        <div style={{ marginTop: 12, background: "var(--bg-canvas)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 16px" }}>
          {(files ?? []).length === 0 ? (
            <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "var(--text-faint)" }}>
              No Lightburn files in library yet — add one in the Production tab.
            </div>
          ) : (
            <>
              <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "var(--text-faint)", marginBottom: 10 }}>
                No file linked to <strong style={{ color: "var(--text)" }}>{decodeHtml(order.product_name)}</strong>. Pick one:
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                {(files ?? []).map(f => (
                  <label key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input type="radio" name={`lb-pick-${order.id}`} value={f.id} checked={picked === f.id} onChange={() => setPicked(f.id)} />
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--accent)" }}>{f.sku_base}</span>
                    <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "var(--text-muted)" }}>— {f.short_name}</span>
                  </label>
                ))}
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12, cursor: "pointer" }}>
                <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "var(--text-muted)" }}>Remember for "{decodeHtml(order.product_name)}"</span>
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={{ ...btnStyle("primary"), fontSize: 12, padding: "6px 14px", opacity: picked ? 1 : 0.5 }}
                  onClick={() => picked && handleQueue(picked)} disabled={!picked || queueing}>Queue</button>
                <button style={{ ...btnStyle("secondary"), fontSize: 12, padding: "6px 14px" }}
                  onClick={() => { setShowPicker(false); setPicked(null); }}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
