#!/usr/bin/env node
// scripts/bump-version.js
// Increments the patch version in package.json, Cargo.toml, and tauri.conf.json.
// Prints the new version string to stdout.
// Called by .githooks/pre-commit — do not run manually unless testing.

const fs   = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

// ── package.json ──────────────────────────────────────────────────────────────
const pkgPath = path.join(root, "package.json");
const pkg     = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const [maj, min, patch] = pkg.version.split(".").map(Number);
const next = `${maj}.${min}.${patch + 1}`;
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// ── src-tauri/Cargo.toml ──────────────────────────────────────────────────────
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
let cargo = fs.readFileSync(cargoPath, "utf8");
// Only replace the version line inside [package], not dependency version specs
cargo = cargo.replace(/^(version = )"[^"]*"$/m, `$1"${next}"`);
fs.writeFileSync(cargoPath, cargo);

// ── src-tauri/tauri.conf.json ─────────────────────────────────────────────────
const tauriPath = path.join(root, "src-tauri", "tauri.conf.json");
const tauri     = JSON.parse(fs.readFileSync(tauriPath, "utf8"));
tauri.package.version = next;
fs.writeFileSync(tauriPath, JSON.stringify(tauri, null, 2) + "\n");

process.stdout.write(`v${next}\n`);
