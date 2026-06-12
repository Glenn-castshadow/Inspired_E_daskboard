// src/taxonomy.js
//
// Single source of truth for the product taxonomy — categories, finishes,
// materials, item types, and the SKU grammar. Every tab (Inventory, Listings,
// Ingest, Analytics) imports from here so they all speak one language.
//
// SKU grammar:  CATEGORY-DESIGN[-SIZE...]-FINISH   e.g. DBC-RBH-SM-CU
//   CATEGORY = a code from CATEGORIES
//   FINISH   = a code from FINISHES (always the trailing segment)
//   DESIGN   = free design code (e.g. RBH = Robie House)

// ── Materials (physical stock substrate) ────────────────────────────────────
// These are the finishes we stock as raw sheets — same list as FINISHES below,
// kept in this id/label/color shape for the inventory MatChip. Order matches
// the Etsy variant dropdown.
export const MATERIALS = [
  { id: "copper_leaf",        label: "Copper Leaf",        color: "#b87333" },
  { id: "copper",             label: "Copper",             color: "#c87f4d" },
  { id: "copper_patina_foil", label: "Copper Patina Foil", color: "#4a9b8e" },
  { id: "gold_leaf",          label: "Gold Leaf",          color: "#c9a84c" },
  { id: "maple",              label: "Maple",              color: "#d9c08a" },
  { id: "cherry",             label: "Cherry",             color: "#a0522d" },
  { id: "walnut",             label: "Walnut",             color: "#5c4033" },
  { id: "white_oak",          label: "White Oak",          color: "#c2a378" },
  { id: "aromatic_cedar",     label: "Aromatic Cedar",     color: "#b5835a" },
  { id: "mahogany",           label: "Mahogany",           color: "#7b3f2f" },
  { id: "sapele",             label: "Sapele",             color: "#964b2e" },
  { id: "mdf",                label: "MDF (Unfinished)",   color: "#9e9e9e" },
  { id: "custom",             label: "Other / Custom",     color: "#7c6f9f" },
];

// ── Categories (first SKU segment) ──────────────────────────────────────────
export const CATEGORIES = [
  { code: "SE",  label: "Special Edition"         },
  { code: "ORN", label: "Architectural Ornaments" },
  { code: "DBC", label: "Doorbell Chime Covers"   },
  { code: "WAL", label: "Wall & Window Panels"    },
  { code: "MPS", label: "Multi-Panel & Sets"      },
  { code: "LMP", label: "Lamps & Lighting"        },
  { code: "JWL", label: "Jewelry"                 },
  { code: "GI",  label: "Global Influences"       },
  { code: "ACC", label: "Accessories"             },
];

// ── Finishes (trailing SKU segment) ─────────────────────────────────────────
// Order matches the Etsy variant dropdown.
export const FINISHES = [
  { code: "CL",  label: "Copper Leaf"        },
  { code: "CU",  label: "Copper"             },
  { code: "CPF", label: "Copper Patina Foil" },
  { code: "GL",  label: "Gold Leaf"          },
  { code: "MA",  label: "Maple"              },
  { code: "CH",  label: "Cherry"             },
  { code: "WA",  label: "Walnut"             },
  { code: "WO",  label: "White Oak"          },
  { code: "AC",  label: "Aromatic Cedar"     },
  { code: "MH",  label: "Mahogany"           },
  { code: "SP",  label: "Sapele"             },
  { code: "MDF", label: "MDF (Unfinished)"   },
];

// ── Inventory item types ────────────────────────────────────────────────────
export const ITEM_TYPES = [
  { id: "sheet",    label: "Sheet stock"    },
  { id: "blank",    label: "Prepared blank" },
  { id: "finished", label: "Finished piece" },
  { id: "offcut",   label: "Offcut"         },
];

// ── Lookup maps ─────────────────────────────────────────────────────────────
export const MAT_MAP = Object.fromEntries(MATERIALS.map(m => [m.id, m]));
export const CAT_MAP = Object.fromEntries(CATEGORIES.map(c => [c.code, c.label]));
export const FIN_MAP = Object.fromEntries(FINISHES.map(f => [f.code, f.label]));

/** Material metadata (label + color) with a safe fallback for unknown ids. */
export function matMeta(id) {
  return MAT_MAP[id] ?? { id, label: id, color: "#777" };
}

/** Human label for a category code, falling back to the code itself. */
export function categoryLabel(code) {
  return CAT_MAP[code] || code || "";
}

/** Human label for a finish code, falling back to the code itself. */
export function finishLabel(code) {
  return FIN_MAP[code] || code || "";
}

/** Best-effort parse of a SKU string into its component codes. */
export function parseSku(sku) {
  const parts = (sku || "").toUpperCase().replace(/\s/g, "").split("-").filter(Boolean);
  if (parts.length < 2) return {};
  return {
    category: parts[0] ?? "",
    design:   parts[1] ?? "",
    finish:   parts[parts.length - 1] ?? "",
  };
}

/**
 * The leading CATEGORY-DESIGN of a SKU (e.g. "DBC-RBH" from "DBC-RBH-SM-CU").
 * This is what Lightburn files use as their `sku_base`, so it's the natural
 * key for matching a production file to a full product SKU.
 */
export function skuBase(sku) {
  const parts = (sku || "").toUpperCase().replace(/\s/g, "").split("-").filter(Boolean);
  return parts.slice(0, 2).join("-");
}
