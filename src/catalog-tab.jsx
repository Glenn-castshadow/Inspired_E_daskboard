import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { SHOP_META } from "./config.js";
import { categoryLabel, skuBase as toSkuBase, CATEGORIES } from "./taxonomy.js";

const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI__);

const UNCATEGORIZED = "__uncat__";

/** Category code (first SKU segment) for a sku_base, or null. */
function categoryOf(skuBase) {
  if (!skuBase) return null;
  return skuBase.split("-")[0] || null;
}

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

// Preferred display order for shops; unknown shops fall to the end.
const KNOWN_SHOP_ORDER = [7438218, 6807617, 22660031];

const STATUS_FILTERS = [
  { key: "all",       label: "All"              },
  { key: "noproduct", label: "No product"       },
  { key: "instock",   label: "In stock"         },
  { key: "linked",    label: "Has cut file"     },
  { key: "unlinked",  label: "Needs cut file"   },
  { key: "inactive",  label: "No recent orders" },
  { key: "files",     label: "Has files"        },
];

const SORTS = [
  { key: "linked", label: "Linked first"      },
  { key: "name",   label: "Name A–Z"          },
  { key: "recent", label: "Recently ordered"  },
];

const chipStyle = (active) => ({
  padding: "5px 12px", borderRadius: 999, cursor: "pointer", whiteSpace: "nowrap",
  fontFamily: "'DM Sans', sans-serif", fontSize: 12, fontWeight: 500,
  border:     active ? "1px solid var(--accent)" : "1px solid var(--border)",
  background: active ? "var(--accent)"           : "var(--bg-surface)",
  color:      active ? "#fff"                    : "var(--text-muted)",
  transition: "background 0.12s, color 0.12s, border-color 0.12s",
});

const shopTabStyle = (active) => ({
  padding: "6px 13px", borderRadius: 8, cursor: "pointer", whiteSpace: "nowrap",
  fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: active ? 600 : 500,
  border:     active ? "1px solid var(--accent)" : "1px solid var(--border)",
  background: active ? "var(--bg-muted)"         : "transparent",
  color:      active ? "var(--text)"             : "var(--text-muted)",
  display: "inline-flex", alignItems: "center", gap: 7,
  transition: "background 0.12s, color 0.12s, border-color 0.12s",
});

function CountBadge({ children, active }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, lineHeight: 1,
      padding: "2px 6px", borderRadius: 999,
      background: active ? "rgba(255,255,255,0.22)" : "var(--bg-muted)",
      color: active ? "#fff" : "var(--text-faint)",
    }}>
      {children}
    </span>
  );
}

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

function ProductFamilyControl({ productName, linkedSkuBase, skuBaseOptions, onLink, onUnlink }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(linkedSkuBase ?? "");

  useEffect(() => { setDraft(linkedSkuBase ?? ""); }, [linkedSkuBase]);

  const commit = () => {
    const v = draft.trim().toUpperCase();
    setEditing(false);
    if (v && v !== (linkedSkuBase ?? "")) onLink(productName, v);
  };

  if (editing) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 4 }}>
        <input
          list="sku-base-options"
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value.toUpperCase())}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
          placeholder="e.g. DBC-RBH"
          style={{
            width: 120, fontFamily: "monospace", fontSize: 11, letterSpacing: "0.04em",
            padding: "2px 6px", borderRadius: 4, border: "1.5px solid var(--accent)",
            background: "var(--bg-canvas)", color: "var(--text)",
          }}
        />
      </span>
    );
  }

  if (linkedSkuBase) {
    const cat = categoryOf(linkedSkuBase);
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 4, flexWrap: "wrap" }}>
        <span
          onClick={() => setEditing(true)}
          title="Click to change product family"
          style={{
            cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5,
            fontSize: 10, fontFamily: "'DM Sans', sans-serif",
            background: "rgba(111, 78, 55, 0.12)", color: "var(--text-muted)",
            border: "1px solid var(--border)", borderRadius: 4, padding: "1px 6px",
          }}
        >
          <span style={{ fontFamily: "monospace", fontWeight: 700, color: "var(--accent)" }}>{linkedSkuBase}</span>
          {cat && <span>· {categoryLabel(cat)}</span>}
        </span>
        <button
          onClick={() => onUnlink(productName)}
          title="Unlink product family"
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", fontSize: 11, padding: 0, lineHeight: 1 }}
        >✕</button>
      </span>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      style={{
        marginTop: 4, background: "none", border: "1px dashed var(--border)",
        borderRadius: 4, padding: "1px 8px", cursor: "pointer",
        fontFamily: "'DM Sans', sans-serif", fontSize: 10, color: "var(--text-faint)",
      }}
    >+ Link product</button>
  );
}

/**
 * Listing thumbnail with lazy-loading + retry. The catalog can render ~700 rows,
 * and firing that many image requests at Etsy's CDN at once gets the burst
 * throttled into timeouts (which is why thumbnails show up blank). `loading=lazy`
 * means the browser only fetches images near the viewport; on a transient failure
 * we retry a few times with backoff (cache-busting the URL) before giving up.
 * These are i.etsystatic.com CDN loads — they do NOT count against the Etsy API
 * rate limit, so retrying is safe.
 */
function Thumbnail({ src }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed]   = useState(false);
  const MAX_RETRIES = 3;

  if (!src || failed) {
    return <span style={{ color: "var(--text-faint)", fontSize: 18 }}>◻</span>;
  }

  // First load uses the plain URL (CDN-cached); retries append a param so the
  // WebView re-requests instead of replaying the cached failed response.
  const url = attempt === 0 ? src : `${src}${src.includes("?") ? "&" : "?"}r=${attempt}`;

  return (
    <img
      key={attempt}
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
      onError={() => {
        if (attempt < MAX_RETRIES) {
          const delay = 400 * (attempt + 1); // 400 / 800 / 1200 ms backoff
          setTimeout(() => setAttempt(a => a + 1), delay);
        } else {
          setFailed(true);
        }
      }}
    />
  );
}

function ProductRow({ product, file, onHand, catalogFiles, onFileChange, showToast, linkedSkuBase, skuBaseOptions, onLink, onUnlink }) {
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
          <Thumbnail src={product.image_url} />
        </div>

        {/* Name + badge */}
        <div style={{ minWidth: 0 }}>
          <div
            title={decodeHtml(product.product_name)}
            style={{
              fontFamily: "'DM Sans', sans-serif", fontSize: 13, lineHeight: 1.35,
              color: inactive ? "var(--text-muted)" : "var(--text)",
              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
              overflow: "hidden", textOverflow: "ellipsis",
            }}
          >
            {decodeHtml(product.product_name)}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <ProductFamilyControl
              productName={product.product_name}
              linkedSkuBase={linkedSkuBase}
              skuBaseOptions={skuBaseOptions}
              onLink={onLink}
              onUnlink={onUnlink}
            />
            {onHand && (onHand.finished > 0 || onHand.blank > 0) && (
              <span
                title="On hand (from Inventory)"
                style={{
                  display: "inline-block", marginTop: 4, fontSize: 10,
                  fontFamily: "'DM Sans', sans-serif",
                  background: onHand.finished > 0 ? "rgba(39, 174, 96, 0.14)" : "rgba(212, 160, 23, 0.14)",
                  color: onHand.finished > 0 ? "#1e8449" : "#9a7d0a",
                  border: `1px solid ${onHand.finished > 0 ? "rgba(39, 174, 96, 0.3)" : "rgba(212, 160, 23, 0.3)"}`,
                  borderRadius: 4, padding: "1px 6px",
                }}
              >
                {[
                  onHand.finished > 0 ? `${onHand.finished} ready` : null,
                  onHand.blank > 0 ? `${onHand.blank} blank${onHand.blank !== 1 ? "s" : ""}` : null,
                ].filter(Boolean).join(" · ")}
              </span>
            )}
            {inactive && (
              <span style={{
                display: "inline-block", marginTop: 4, fontSize: 10,
                fontFamily: "'DM Sans', sans-serif",
                background: "rgba(180, 90, 0, 0.12)", color: "#b45a00",
                border: "1px solid rgba(180, 90, 0, 0.25)",
                borderRadius: 4, padding: "1px 6px", letterSpacing: "0.05em",
              }}>
                {age === Infinity ? "No orders yet" : `No orders in ${age}d`}
              </span>
            )}
          </div>
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

// ── Listing group (shop or category section) ────────────────────────────────

function ShopSection({ title, color, products, catalogFiles, mappingByProduct, fileById, onFileChange, showToast, linkBySku, skuBaseOptions, onLink, onUnlink, onHandBySkuBase, filesBySkuBase }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, marginBottom: 10,
      }}>
        {color && <span style={{ display: "inline-block", width: 3, height: 18, borderRadius: 2, background: color }} />}
        <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, color: "var(--text)" }}>
          {title}
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
          const mapping   = mappingByProduct[product.product_name];
          const linked    = linkBySku[product.product_name];
          // Prefer an explicit title→file mapping; otherwise resolve by family.
          const file      = (mapping ? fileById[mapping.lightburn_file_id] : null)
                            ?? (linked ? filesBySkuBase[linked] : null);
          const onHand    = linked ? onHandBySkuBase[linked] : null;
          return (
            <ProductRow
              key={product.product_name}
              product={product}
              file={file}
              onHand={onHand}
              catalogFiles={catalogFiles}
              onFileChange={onFileChange}
              showToast={showToast}
              linkedSkuBase={linked}
              skuBaseOptions={skuBaseOptions}
              onLink={onLink}
              onUnlink={onUnlink}
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

function ListingSyncBanner({ status }) {
  if (!status || status.state === "idle") return null;

  const rows = status.results ?? [];
  const failures = rows.filter(r => !r.ok);
  const successes = rows.filter(r => r.ok);
  const syncedCount = successes.reduce((s, r) => s + (r.active_count || 0), 0);
  const isSyncing = status.state === "syncing";
  const isProblem = status.state === "error" || failures.length > 0;
  const updated = status.updatedAt
    ? new Date(status.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;

  const bg = isProblem ? "rgba(180, 90, 0, 0.10)" : "rgba(45, 106, 79, 0.10)";
  const border = isProblem ? "rgba(180, 90, 0, 0.28)" : "rgba(45, 106, 79, 0.25)";
  const accent = isProblem ? "#b45a00" : "#2D6A4F";

  return (
    <div style={{
      margin: "0 40px 14px", maxWidth: 1100,
      background: bg, border: `1px solid ${border}`, borderRadius: 8,
      padding: "10px 12px", fontFamily: "'DM Sans', sans-serif",
      fontSize: 12, color: "var(--text-muted)",
    }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: accent, fontWeight: 700 }}>
          {isSyncing ? "Syncing active listings..." : isProblem ? "Active listing sync needs attention" : "Active listings synced"}
        </span>
        {!isSyncing && updated && (
          <span style={{ color: "var(--text-faint)" }}>Last checked {updated}</span>
        )}
        {successes.length > 0 && (
          <span style={{ color: "var(--text-faint)" }}>
            {syncedCount} active listings {isSyncing ? "saved so far" : "found"}
          </span>
        )}
      </div>
      {!isSyncing && failures.length > 0 && (
        <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 4 }}>
          {failures.map((r, i) => {
            const shop = SHOP_META[r.shop_id]?.name ?? (r.shop_id ? `Shop ${r.shop_id}` : "Sync");
            return (
              <div key={`${r.shop_id}-${i}`}>
                <strong style={{ color: "var(--text)" }}>{shop}:</strong> {r.message}
              </div>
            );
          })}
          <div style={{ color: "var(--text-faint)" }}>
            If this mentions permissions, reconnect the Etsy shop so the new listings scope is granted.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export default function CatalogTab({ activeListingSync }) {
  const [catalog,      setCatalog]      = useState([]);
  const [files,        setFiles]        = useState([]);
  const [mappings,     setMappings]     = useState([]);
  const [catalogFiles, setCatalogFiles] = useState([]);
  const [links,        setLinks]        = useState([]);   // [{product_name, sku_base}]
  const [products,     setProducts]     = useState([]);   // SKU'd product catalog
  const [inventory,    setInventory]    = useState([]);   // stock items (for on-hand)
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState("");
  const [toast,        setToast]        = useState(null);

  // View controls
  const [shopFilter,   setShopFilter]   = useState("all");   // "all" | shopId
  const [statusFilter, setStatusFilter] = useState("all");   // see STATUS_FILTERS
  const [sortBy,       setSortBy]        = useState("linked"); // see SORTS
  const [groupBy,      setGroupBy]       = useState("shop");   // "shop" | "category"
  const syncReloadTimer = useRef(null);

  const showToast = useCallback((msg, isErr = false) => {
    setToast({ msg, isErr });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const loadAll = useCallback(async () => {
    if (!isTauri) { setLoading(false); return; }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Seed listing→product links from existing Lightburn mappings (no-op if
      // already present) before reading them back.
      await invoke("seed_listing_links_from_mappings").catch(() => {});
      const [prods, f, m, cf, lk, skuProducts, inv] = await Promise.all([
        invoke("list_catalog_products"),
        invoke("list_lightburn_files"),
        invoke("list_lightburn_mappings"),
        invoke("list_catalog_files"),
        invoke("list_listing_product_links"),
        invoke("get_products").catch(() => []),
        invoke("get_inventory").catch(() => []),
      ]);
      // Only show listings that are currently live on the Etsy storefront.
      // catalog_products also retains products that survive only in old orders
      // (delisted items); is_active, refreshed by the active-listings sync,
      // filters those out so the Listings tab mirrors the actual storefront.
      setCatalog(prods.filter(p => p.is_active));
      setFiles(f);
      setMappings(m);
      setCatalogFiles(cf);
      setLinks(lk);
      setProducts(skuProducts);
      setInventory(inv);
    } catch (e) {
      console.error("catalog load error", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("active-listings-progress", () => {
        if (syncReloadTimer.current) clearTimeout(syncReloadTimer.current);
        syncReloadTimer.current = setTimeout(() => loadAll(), 150);
      }))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("active-listings-progress catalog listener failed:", e));
    return () => {
      cancelled = true;
      if (syncReloadTimer.current) clearTimeout(syncReloadTimer.current);
      unlisten?.();
    };
  }, [loadAll]);

  const linkBySku = useMemo(
    () => Object.fromEntries(links.map(l => [l.product_name, l.sku_base])),
    [links]
  );

  // Autocomplete options for the link control: every sku_base we know about,
  // gathered from existing links, Lightburn files, and the SKU'd product catalog.
  const skuBaseOptions = useMemo(() => {
    const s = new Set();
    for (const l of links) if (l.sku_base) s.add(l.sku_base);
    for (const f of files) if (f.sku_base) s.add(String(f.sku_base).toUpperCase());
    for (const p of products) { const b = toSkuBase(p.sku); if (b) s.add(b); }
    return [...s].sort();
  }, [links, files, products]);

  const onLink = useCallback(async (productName, skuBase) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("link_listing_product", { productName, skuBase });
      setLinks(prev => {
        const rest = prev.filter(l => l.product_name !== productName);
        return [...rest, { product_name: productName, sku_base: skuBase }];
      });
    } catch (e) { showToast(String(e), true); }
  }, [showToast]);

  const onUnlink = useCallback(async (productName) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("unlink_listing_product", { productName });
      setLinks(prev => prev.filter(l => l.product_name !== productName));
    } catch (e) { showToast(String(e), true); }
  }, [showToast]);

  const mappingByProduct = useMemo(
    () => Object.fromEntries(mappings.map(m => [m.product_name, m])),
    [mappings]
  );

  const fileById = useMemo(
    () => Object.fromEntries(files.map(f => [f.id, f])),
    [files]
  );

  const fileCountByProduct = useMemo(() => {
    const m = {};
    for (const f of catalogFiles) m[f.product_name] = (m[f.product_name] ?? 0) + 1;
    return m;
  }, [catalogFiles]);

  // On-hand stock rolled up to the product family (sku_base) from inventory.
  const onHandBySkuBase = useMemo(() => {
    const m = {};
    for (const it of inventory) {
      if (!it.sku) continue;
      const base = toSkuBase(it.sku);
      if (!base) continue;
      if (!m[base]) m[base] = { finished: 0, blank: 0 };
      const qty = it.quantity || 0;
      if (it.item_type === "finished") m[base].finished += qty;
      else if (it.item_type === "blank") m[base].blank += qty;
    }
    return m;
  }, [inventory]);

  // Lightburn file resolved by product family (sku_base), so a listing linked to
  // a family shows its cut file even without an explicit title→file mapping.
  const filesBySkuBase = useMemo(() => {
    const m = {};
    for (const f of files) {
      if (!f.sku_base) continue;
      const b = String(f.sku_base).toUpperCase();
      if (!(b in m)) m[b] = f; // first file for a family wins
    }
    return m;
  }, [files]);

  const resolvedFileFor = useCallback((p) => {
    const mapping = mappingByProduct[p.product_name];
    if (mapping && fileById[mapping.lightburn_file_id]) return fileById[mapping.lightburn_file_id];
    const linked = linkBySku[p.product_name];
    return linked ? filesBySkuBase[linked] : null;
  }, [mappingByProduct, fileById, linkBySku, filesBySkuBase]);

  // Predicates (read live from the memoized lookups above)
  const isLinked   = useCallback((p) => !!resolvedFileFor(p), [resolvedFileFor]);
  const hasFiles   = useCallback((p) => (fileCountByProduct[p.product_name] ?? 0) > 0, [fileCountByProduct]);
  const isInactive = useCallback((p) => daysSince(p.last_seen) > INACTIVE_DAYS, []);
  const hasProduct = useCallback((p) => !!linkBySku[p.product_name], [linkBySku]);
  const hasStock   = useCallback((p) => {
    const base = linkBySku[p.product_name];
    const oh = base ? onHandBySkuBase[base] : null;
    return !!oh && (oh.finished > 0 || oh.blank > 0);
  }, [linkBySku, onHandBySkuBase]);

  // Total listings per shop (ignores filters — drives the shop switcher counts)
  const shopCounts = useMemo(() => {
    const m = {};
    for (const p of catalog) { const k = p.shop_id ?? 0; m[k] = (m[k] ?? 0) + 1; }
    return m;
  }, [catalog]);

  const orderedShopIds = useMemo(() => {
    const present = new Set(catalog.map(p => p.shop_id ?? 0));
    const known   = KNOWN_SHOP_ORDER.filter(id => present.has(id));
    const unknown = [...present].filter(id => !known.includes(id));
    return [...known, ...unknown];
  }, [catalog]);

  // Apply shop + search + status filters
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let arr = catalog;
    if (shopFilter !== "all") arr = arr.filter(p => (p.shop_id ?? 0) === shopFilter);
    if (q) arr = arr.filter(p => decodeHtml(p.product_name).toLowerCase().includes(q));
    switch (statusFilter) {
      case "noproduct": arr = arr.filter(p => !hasProduct(p)); break;
      case "instock":   arr = arr.filter(hasStock);            break;
      case "linked":    arr = arr.filter(isLinked);            break;
      case "unlinked":  arr = arr.filter(p => !isLinked(p));   break;
      case "inactive":  arr = arr.filter(isInactive);          break;
      case "files":     arr = arr.filter(hasFiles);            break;
      default: break;
    }
    return arr;
  }, [catalog, search, shopFilter, statusFilter, isLinked, hasFiles, isInactive, hasProduct, hasStock]);

  const sortProducts = useCallback((arr) => {
    const a = [...arr];
    if (sortBy === "name") {
      a.sort((x, y) => decodeHtml(x.product_name).localeCompare(decodeHtml(y.product_name)));
    } else if (sortBy === "recent") {
      a.sort((x, y) => {
        const dx = x.last_seen ? new Date(x.last_seen).getTime() : -1;
        const dy = y.last_seen ? new Date(y.last_seen).getTime() : -1;
        return dy - dx;
      });
    } else { // "linked" — linked first, then A–Z
      a.sort((x, y) => {
        const lx = isLinked(x) ? 0 : 1, ly = isLinked(y) ? 0 : 1;
        if (lx !== ly) return lx - ly;
        return decodeHtml(x.product_name).localeCompare(decodeHtml(y.product_name));
      });
    }
    return a;
  }, [sortBy, isLinked]);

  const groups = useMemo(() => {
    const map = new Map();
    if (groupBy === "category") {
      for (const p of visible) {
        const code = categoryOf(linkBySku[p.product_name]) ?? UNCATEGORIZED;
        if (!map.has(code)) map.set(code, []);
        map.get(code).push(p);
      }
      for (const [k, v] of map) map.set(k, sortProducts(v));
      const order = [...CATEGORIES.map(c => c.code), UNCATEGORIZED].filter(c => map.has(c));
      // Any category codes not in the canonical list (shouldn't happen) tacked on.
      const extra = [...map.keys()].filter(c => !order.includes(c));
      return [...order, ...extra].map(code => ({
        key: code,
        title: code === UNCATEGORIZED ? "Uncategorized" : `${code} — ${categoryLabel(code)}`,
        color: null,
        products: map.get(code),
      }));
    }
    // Default: group by shop
    for (const p of visible) { const k = p.shop_id ?? 0; if (!map.has(k)) map.set(k, []); map.get(k).push(p); }
    for (const [k, v] of map) map.set(k, sortProducts(v));
    return orderedShopIds.filter(id => map.has(id)).map(id => {
      const meta = SHOP_META[id] ?? { name: id === 0 ? "Unknown Shop" : `Shop ${id}`, color: "#888" };
      return { key: id, title: meta.name, color: meta.color, products: map.get(id) };
    });
  }, [visible, sortProducts, orderedShopIds, groupBy, linkBySku]);

  // Summary reflecting the current filtered view
  const summary = useMemo(() => {
    const total       = visible.length;
    const hasFile     = visible.filter(isLinked).length;
    const categorized = visible.filter(p => !!linkBySku[p.product_name]).length;
    return { total, hasFile, needFiles: total - hasFile, categorized, uncategorized: total - categorized };
  }, [visible, isLinked, linkBySku]);

  const searchBg = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.35-4.35'/%3E%3C/svg%3E\")";

  return (
    <div style={{ paddingBottom: 48 }}>
      {/* Header */}
      <div style={{ padding: "28px 40px 14px", maxWidth: 1100 }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, margin: 0, color: "var(--text)" }}>
          Listings
        </h2>
        <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text-faint)", margin: "6px 0 0" }}>
          Every active Etsy listing, plus anything ever ordered — durable even after a listing is removed.
          Link Lightburn files in the Ingest tab.
        </p>
      </div>

      <ListingSyncBanner status={activeListingSync} />

      {/* Sticky control bar */}
      <div style={{
        position: "sticky", top: 48, zIndex: 9,
        background: "var(--bg-canvas)", borderBottom: "1px solid var(--border)",
        padding: "12px 40px 13px",
      }}>
        {/* Row 1 — shop switcher */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 11 }}>
          <button style={shopTabStyle(shopFilter === "all")} onClick={() => setShopFilter("all")}>
            All <CountBadge active={shopFilter === "all"}>{catalog.length}</CountBadge>
          </button>
          {orderedShopIds.map(id => {
            const meta = SHOP_META[id] ?? { name: id === 0 ? "Unknown Shop" : `Shop ${id}`, color: "#888" };
            const active = shopFilter === id;
            return (
              <button key={id} style={shopTabStyle(active)} onClick={() => setShopFilter(id)}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: meta.color }} />
                {meta.name} <CountBadge active={active}>{shopCounts[id] ?? 0}</CountBadge>
              </button>
            );
          })}
        </div>

        {/* Row 2 — search + sort */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 11 }}>
          <input
            type="search"
            placeholder="Search listings…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...inputStyle, flex: "1 1 280px", maxWidth: 420, paddingLeft: 32, backgroundImage: searchBg, backgroundRepeat: "no-repeat", backgroundPosition: "10px center" }}
          />
          <label style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-faint)" }}>Group</span>
            <select value={groupBy} onChange={e => setGroupBy(e.target.value)} style={{ ...inputStyle, cursor: "pointer", padding: "7px 8px" }}>
              <option value="shop">Shop</option>
              <option value="category">Category</option>
            </select>
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-faint)" }}>Sort</span>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...inputStyle, cursor: "pointer", padding: "7px 8px" }}>
              {SORTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
        </div>

        {/* Row 3 — status filters + live summary */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
          {STATUS_FILTERS.map(f => (
            <button key={f.key} style={chipStyle(statusFilter === f.key)} onClick={() => setStatusFilter(f.key)}>
              {f.label}
            </button>
          ))}
          <span style={{ marginLeft: "auto", fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "var(--text-faint)" }}>
            {summary.total} {summary.total === 1 ? "listing" : "listings"}
            {summary.total > 0 && <> · {summary.categorized} categorized · {summary.needFiles} need files</>}
          </span>
        </div>
      </div>

      {/* List */}
      <div style={{ padding: "22px 40px 0", maxWidth: 1100 }}>
        {loading ? (
          <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text-faint)" }}>Loading…</div>
        ) : catalog.length === 0 ? (
          <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text-faint)" }}>
            No listings yet — they appear here after the next refresh syncs your Etsy catalog.
          </div>
        ) : visible.length === 0 ? (
          <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "var(--text-faint)" }}>
            No listings match the current filters.
            <button
              onClick={() => { setSearch(""); setStatusFilter("all"); setShopFilter("all"); }}
              style={{ ...btnStyle("secondary"), marginLeft: 10 }}
            >Clear filters</button>
          </div>
        ) : (
          groups.map(({ key, title, color, products: groupProducts }) => (
            <ShopSection
              key={key}
              title={title}
              color={color}
              products={groupProducts}
              catalogFiles={catalogFiles}
              mappingByProduct={mappingByProduct}
              fileById={fileById}
              onFileChange={loadAll}
              showToast={showToast}
              linkBySku={linkBySku}
              skuBaseOptions={skuBaseOptions}
              onLink={onLink}
              onUnlink={onUnlink}
              onHandBySkuBase={onHandBySkuBase}
              filesBySkuBase={filesBySkuBase}
            />
          ))
        )}
      </div>

      {/* Shared autocomplete source for the product-family link inputs */}
      <datalist id="sku-base-options">
        {skuBaseOptions.map(b => <option key={b} value={b} />)}
      </datalist>

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
