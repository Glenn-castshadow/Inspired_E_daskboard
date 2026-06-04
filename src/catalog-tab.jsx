import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { SHOP_META } from "./config.js";

const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI__);

const decodeHtml = (() => {
  const ta = typeof document !== "undefined" ? document.createElement("textarea") : null;
  return (s) => { if (!s || !ta) return s ?? ""; ta.innerHTML = s; return ta.value; };
})();

const INACTIVE_DAYS = 90;

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const inputStyle = {
  padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--bg-surface)", color: "var(--text)",
  fontFamily: "'DM Sans', sans-serif", fontSize: 13, boxSizing: "border-box",
};

const btnStyle = (variant = "secondary") => ({
  padding: "5px 11px", borderRadius: 6, cursor: "pointer",
  fontFamily: "'DM Sans', sans-serif", fontSize: 11, fontWeight: 500,
  display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap",
  background: variant === "primary" ? "var(--accent)" : "var(--bg-surface)",
  color:      variant === "primary" ? "#fff"          : "var(--text-muted)",
  border:     variant === "primary" ? "none"          : "1px solid var(--border)",
});

// ── File panel (SVG / ZIP attachments) ───────────────────────────────────────

const ACCEPTED_EXTS = [".svg", ".zip"];
const ACCEPT_ATTR   = ACCEPTED_EXTS.join(",");

function fileIcon(filename) {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "zip") return "⊡";
  return "◈"; // SVG / other
}

function arrayBufferToBase64(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function FilePanel({ productName, catalogFiles, onFileChange, showToast }) {
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(null);
  const [deleting,  setDeleting]  = useState(null);
  const fileRef = useRef();

  const productFiles = (catalogFiles ?? []).filter(f => f.product_name === productName);

  const handleFile = (file) => {
    const ext = "." + file.name.split(".").pop().toLowerCase();
    if (!ACCEPTED_EXTS.includes(ext)) {
      showToast(`Only ${ACCEPTED_EXTS.join(", ")} files are supported`, true);
      return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      setUploading(true);
      try {
        if (isTauri) {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("save_catalog_file", {
            productName,
            label: "",
            filename: file.name,
            dataBase64: arrayBufferToBase64(ev.target.result),
          });
          onFileChange?.();
          showToast(`Attached ${file.name}`);
        }
      } catch (e) {
        showToast(String(e), true);
      } finally {
        setUploading(false);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleExport = async (id) => {
    setExporting(id);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await invoke("export_catalog_file", { id });
      showToast(`Saved → ${path}`);
    } catch (e) {
      showToast(String(e), true);
    } finally {
      setExporting(null);
    }
  };

  const handleDelete = async (id) => {
    setDeleting(id);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("delete_catalog_file", { id });
      onFileChange?.();
    } catch (e) {
      showToast(String(e), true);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div style={{
      background: "var(--bg-canvas)", borderTop: "1px solid var(--border)",
      padding: "12px 16px 12px 58px",
    }}>
      {productFiles.length > 0 && (
        <div style={{ marginBottom: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          {productFiles.map(f => (
            <div key={f.id} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "6px 10px", borderRadius: 6,
              background: "var(--bg-surface)", border: "1px solid var(--border)",
            }}>
              <span style={{ fontSize: 14, lineHeight: 1, color: "var(--text-faint)", flexShrink: 0 }}>{fileIcon(f.filename)}</span>
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.filename}
              </span>
              <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 10, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
                {fmtBytes(f.file_size)}
              </span>
              <button
                style={{ ...btnStyle("secondary"), fontSize: 10, padding: "3px 8px", opacity: exporting === f.id ? 0.5 : 1 }}
                disabled={exporting === f.id}
                onClick={() => handleExport(f.id)}
              >
                ↓ {exporting === f.id ? "…" : "Save"}
              </button>
              <button
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", fontSize: 13, padding: "2px 4px", opacity: deleting === f.id ? 0.5 : 1 }}
                disabled={deleting === f.id}
                onClick={() => handleDelete(f.id)}
                title="Remove file"
              >✕</button>
            </div>
          ))}
        </div>
      )}

      <button
        style={{ ...btnStyle("secondary"), fontSize: 11, opacity: uploading ? 0.5 : 1 }}
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
      >
        {uploading ? "Attaching…" : "+ Attach file"}
      </button>
      <span style={{ marginLeft: 8, fontFamily: "'DM Sans', sans-serif", fontSize: 10, color: "var(--text-faint)" }}>
        .svg or .zip
      </span>
      <input
        ref={fileRef} type="file" accept={ACCEPT_ATTR} style={{ display: "none" }}
        onChange={e => { const f = e.target.files[0]; if (f) handleFile(f); e.target.value = ""; }}
      />
    </div>
  );
}

// ── Product row ───────────────────────────────────────────────────────────────

function ProductRow({ product, file, catalogFiles, onFileChange, showToast }) {
  const [expanded,  setExpanded]  = useState(false);
  const [exporting, setExporting] = useState(false);

  const age       = daysSince(product.last_seen);
  const inactive  = age > INACTIVE_DAYS;
  const fileCount = (catalogFiles ?? []).filter(f => f.product_name === product.product_name).length;

  const handleExport = async () => {
    if (!file) return;
    setExporting(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await invoke("export_lightburn_file", { lightburnFileId: file.id, filename: file.filename });
      showToast(`Saved → ${path}`);
    } catch (e) {
      showToast(String(e), true);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div style={{
        display: "grid",
        gridTemplateColumns: "44px 1fr 190px 80px 80px",
        alignItems: "center", gap: 14, padding: "10px 16px",
        borderTop: "1px solid var(--border)", background: "var(--bg-surface)",
      }}>
        {/* Thumbnail */}
        <div style={{
          width: 36, height: 36, borderRadius: 5, overflow: "hidden",
          background: "var(--bg-muted)", flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {product.image_url ? (
            <img src={product.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }}
              onError={e => { e.currentTarget.style.display = "none"; }} />
          ) : (
            <span style={{ color: "var(--text-faint)", fontSize: 18 }}>◻</span>
          )}
        </div>

        {/* Name + badge */}
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontFamily: "'DM Sans', sans-serif", fontSize: 13,
            color: inactive ? "var(--text-muted)" : "var(--text)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {decodeHtml(product.product_name)}
          </div>
          {inactive && (
            <span style={{
              display: "inline-block", marginTop: 3, fontSize: 10,
              fontFamily: "'DM Sans', sans-serif",
              background: "rgba(180, 90, 0, 0.12)", color: "#b45a00",
              border: "1px solid rgba(180, 90, 0, 0.25)",
              borderRadius: 4, padding: "1px 6px", letterSpacing: "0.05em",
            }}>
              {age === Infinity ? "No orders yet" : `No orders in ${age}d`}
            </span>
          )}
        </div>

        {/* Lightburn file with pip */}
        <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{
            display: "inline-block", width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
            background: file ? "#2D6A4F" : "transparent",
            border: file ? "none" : "1.5px solid var(--border)",
          }} />
          {file ? (
            <div style={{ minWidth: 0 }}>
              <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 600, color: "var(--accent)" }}>{file.sku_base}</span>
              <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, color: "var(--text-muted)" }}> {file.short_name}</span>
            </div>
          ) : (
            <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "var(--text-faint)", fontStyle: "italic" }}>Not linked</span>
          )}
        </div>

        {/* LBR download */}
        <div style={{ display: "flex", justifyContent: "center" }}>
          {file && (
            <button onClick={handleExport} disabled={exporting} style={{ ...btnStyle("secondary"), opacity: exporting ? 0.5 : 1 }}>
              ↓ {exporting ? "…" : ".lbrn2"}
            </button>
          )}
        </div>

        {/* File expand toggle */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={() => setExpanded(e => !e)}
            style={{
              ...btnStyle("secondary"),
              background: expanded ? "var(--bg-muted)" : "var(--bg-surface)",
            }}
          >
            <span style={{ fontSize: 13 }}>◈</span>
            {fileCount > 0 ? ` ${fileCount}` : ""}
            <span style={{ fontSize: 9 }}>{expanded ? "▴" : "▾"}</span>
          </button>
        </div>
      </div>

      {expanded && (
        <FilePanel
          productName={product.product_name}
          catalogFiles={catalogFiles}
          onFileChange={onFileChange}
          showToast={showToast}
        />
      )}
    </>
  );
}

// ── Shop section ──────────────────────────────────────────────────────────────

function ShopSection({ shopId, products, files, catalogFiles, mappings, mappingByProduct, fileById, onFileChange, showToast }) {
  const meta = SHOP_META[shopId] ?? { name: shopId === 0 ? "Unknown Shop" : `Shop ${shopId}`, color: "#888" };

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, marginBottom: 10,
      }}>
        <span style={{ display: "inline-block", width: 3, height: 18, borderRadius: 2, background: meta.color }} />
        <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, color: "var(--text)" }}>
          {meta.name}
        </span>
        <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, color: "var(--text-faint)" }}>
          {products.length} {products.length === 1 ? "listing" : "listings"}
        </span>
      </div>

      <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
        {/* Column header */}
        <div style={{
          display: "grid", gridTemplateColumns: "44px 1fr 190px 80px 80px",
          padding: "7px 16px", gap: 14, background: "var(--bg-muted)",
          fontFamily: "'DM Sans', sans-serif", fontSize: 10,
          textTransform: "uppercase", letterSpacing: "0.09em", color: "var(--text-faint)",
          borderBottom: "1px solid var(--border)",
        }}>
          <span />
          <span>Product</span>
          <span>Lightburn file</span>
          <span style={{ textAlign: "center" }}>LBR</span>
          <span style={{ textAlign: "right" }}>SVG</span>
        </div>

        {products.map(product => {
          const mapping = mappingByProduct[product.product_name];
          const file    = mapping ? fileById[mapping.lightburn_file_id] : null;
          return (
            <ProductRow
              key={product.product_name}
              product={product}
              file={file}
              catalogFiles={catalogFiles}
              onFileChange={onFileChange}
              showToast={showToast}
            />
          );
        })}

        <div style={{
          padding: "6px 16px", background: "var(--bg-muted)", borderTop: "1px solid var(--border)",
          fontFamily: "'DM Sans', sans-serif", fontSize: 11, color: "var(--text-faint)",
        }}>
          {products.filter(p => mappingByProduct[p.product_name]).length} of {products.length} linked
          {products.filter(p => daysSince(p.last_seen) > INACTIVE_DAYS).length > 0 &&
            ` · ${products.filter(p => daysSince(p.last_seen) > INACTIVE_DAYS).length} inactive`}
        </div>
      </div>
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export default function CatalogTab() {
  const [catalog,      setCatalog]      = useState([]);
  const [files,        setFiles]        = useState([]);
  const [mappings,     setMappings]     = useState([]);
  const [catalogFiles, setCatalogFiles] = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState("");
  const [toast,        setToast]        = useState(null);

  const showToast = useCallback((msg, isErr = false) => {
    setToast({ msg, isErr });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const loadAll = useCallback(async () => {
    if (!isTauri) { setLoading(false); return; }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const [products, f, m, cf] = await Promise.all([
        invoke("list_catalog_products"),
        invoke("list_lightburn_files"),
        invoke("list_lightburn_mappings"),
        invoke("list_catalog_files"),
      ]);
      setCatalog(products);
      setFiles(f);
      setMappings(m);
      setCatalogFiles(cf);
    } catch (e) {
      console.error("catalog load error", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const mappingByProduct = useMemo(
    () => Object.fromEntries(mappings.map(m => [m.product_name, m])),
    [mappings]
  );

  const fileById = useMemo(
    () => Object.fromEntries(files.map(f => [f.id, f])),
    [files]
  );

  // Filter by search then group by shop_id
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? catalog.filter(p => decodeHtml(p.product_name).toLowerCase().includes(q))
      : catalog;
  }, [catalog, search]);

  const byShop = useMemo(() => {
    const map = new Map();
    for (const p of filtered) {
      const key = p.shop_id ?? 0;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    }
    // Sort each shop's products: linked first, then by name
    for (const [, prods] of map) {
      prods.sort((a, b) => {
        const aLinked = mappingByProduct[a.product_name] ? 0 : 1;
        const bLinked = mappingByProduct[b.product_name] ? 0 : 1;
        if (aLinked !== bLinked) return aLinked - bLinked;
        return decodeHtml(a.product_name).localeCompare(decodeHtml(b.product_name));
      });
    }
    // Preserve SHOP_IDS order, unknowns at end
    const known = [7438218, 6807617, 22660031].filter(id => map.has(id));
    const unknown = [...map.keys()].filter(id => !known.includes(id));
    return [...known, ...unknown].map(id => ({ shopId: id, products: map.get(id) }));
  }, [filtered, mappingByProduct]);

  return (
    <div style={{ padding: "32px 40px", maxWidth: 1060 }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, margin: 0, color: "var(--text)" }}>
          Product Catalog
        </h2>
        <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text-faint)", margin: "6px 0 0" }}>
          Every listing seen in your Etsy orders — durable even after a listing is removed.
          Link Lightburn files in the Ingest tab.
        </p>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 24, maxWidth: 380 }}>
        <input
          type="search"
          placeholder="Search products…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...inputStyle, width: "100%", paddingLeft: 32, backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.35-4.35'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "10px center" }}
        />
      </div>

      {loading ? (
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text-faint)" }}>Loading…</div>
      ) : catalog.length === 0 ? (
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text-faint)" }}>
          No orders loaded yet — products appear here once orders sync.
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text-faint)" }}>
          No products match "{search}".
        </div>
      ) : (
        byShop.map(({ shopId, products }) => (
          <ShopSection
            key={shopId}
            shopId={shopId}
            products={products}
            files={files}
            catalogFiles={catalogFiles}
            mappings={mappings}
            mappingByProduct={mappingByProduct}
            fileById={fileById}
            onFileChange={loadAll}
            showToast={showToast}
          />
        ))
      )}

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
