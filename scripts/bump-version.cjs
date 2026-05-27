#!/usr/bin/env node
// scripts/bump-version.js
// Increments the patch version in package.json, Cargo.toml, and tauri.conf.json.
// Prints the new version string to stdout.
// Called by .githooks/pre-commit — do not run manually unless testing.

const fs   = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

// ── Read all three current versions ───────────────────────────────────────────
// Pick max(package.json, Cargo.toml, tauri.conf.json) before bumping so a drift
// between files (e.g. a failed regex on CRLF endings) never silently regresses.
const pkgPath   = path.join(root, "package.json");
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
const tauriPath = path.join(root, "src-tauri", "tauri.conf.json");

const pkg     = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
let   cargo   = fs.readFileSync(cargoPath, "utf8");
const tauri   = JSON.parse(fs.readFileSync(tauriPath, "utf8"));

const cargoMatch = cargo.match(/^version = "([^"]+)"/m);
if (!cargoMatch) {
  console.error("bump-version: could not find [package] version in Cargo.toml");
  process.exit(1);
}

const cmp = (a, b) => {
  const A = a.split(".").map(Number), B = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i];
  return 0;
};
const versions = [pkg.version, cargoMatch[1], tauri.package.version];
const current  = versions.reduce((m, v) => cmp(v, m) > 0 ? v : m);
const [maj, min, patch] = current.split(".").map(Number);
const next = `${maj}.${min}.${patch + 1}`;

// ── Write all three to `next` ─────────────────────────────────────────────────
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// Use \r?\n-tolerant boundary so CRLF-ended files match too
cargo = cargo.replace(/^(version = )"[^"]*"/m, `$1"${next}"`);
fs.writeFileSync(cargoPath, cargo);

tauri.package.version = next;
fs.writeFileSync(tauriPath, JSON.stringify(tauri, null, 2) + "\n");

// ── README.md ─────────────────────────────────────────────────────────────────
const readmePath = path.join(root, "README.md");
let readme = fs.readFileSync(readmePath, "utf8");

const today = new Date().toISOString().slice(0, 10);

// Update the "Current version:" badge line
readme = readme.replace(
  /\*\*Current version:\*\* v[\d.]+/,
  `**Current version:** v${next}`
);

// Prepend new row to the version history table (after the |---|---| separator)
readme = readme.replace(
  /(## Version history[\s\S]*?\|---\|---\|\n)/,
  `$1| v${next} | ${today} |\n`
);

fs.writeFileSync(readmePath, readme);

process.stdout.write(`v${next}\n`);
