// SQLite (official WASM build) loader.
//
// We need FTS5. The popular `sql.js` build does NOT ship it ("no such module:
// fts5"), so this uses the SQLite project's own WASM distribution, which does.
// It is fetched on first run into ./vendor (gitignored) and reused offline
// afterwards, so the shared package.json stays untouched.

import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "..", "vendor");
const PKG = "@sqlite.org/sqlite-wasm";
const VERSION = "3.53.4-build1";
const TARBALL = `https://registry.npmjs.org/@sqlite.org/sqlite-wasm/-/sqlite-wasm-${VERSION}.tgz`;
const ENTRY = path.join(VENDOR, "dist", "node.mjs");

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Download + unpack the pinned SQLite WASM build into ./vendor. */
async function fetchVendor(log) {
  log(`sqlite: ${PKG}@${VERSION} not vendored yet, fetching once…`);
  await rm(VENDOR, { recursive: true, force: true });
  await mkdir(VENDOR, { recursive: true });

  const res = await fetch(TARBALL);
  if (!res.ok) {
    throw new Error(
      `could not download ${TARBALL} (HTTP ${res.status}). ` +
        `Fetch it manually and unpack its package/ contents into ${VENDOR}.`
    );
  }

  // npm tarballs nest everything under package/; strip that one level.
  const tar = spawn("tar", ["-x", "-C", VENDOR, "--strip-components=1"], {
    stdio: ["pipe", "inherit", "inherit"]
  });
  const done = new Promise((resolve, reject) => {
    tar.on("error", reject);
    tar.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))
    );
  });
  await pipeline(res.body, createGunzip(), tar.stdin);
  await done;

  if (!(await exists(ENTRY))) {
    const got = await readdir(VENDOR).catch(() => []);
    throw new Error(
      `unpacked ${PKG} but ${ENTRY} is missing (saw: ${got.join(", ")})`
    );
  }
  log(`sqlite: vendored into ${VENDOR}`);
}

let cached = null;

/**
 * Resolve the sqlite3 WASM namespace, vendoring it on first use.
 * Throws with an actionable message if FTS5 turns out to be missing.
 */
export async function loadSqlite({ log = () => {} } = {}) {
  if (cached) return cached;

  if (!(await exists(ENTRY))) await fetchVendor(log);

  const mod = await import(path.toNamespacedPath(ENTRY));
  const sqlite3 = await (mod.default ?? mod.sqlite3InitModule)();

  // Fail loudly here rather than on the first user search.
  const probe = new sqlite3.oo1.DB(":memory:");
  try {
    probe.exec("create virtual table fts5_probe using fts5(x)");
  } catch (err) {
    throw new Error(
      `the vendored SQLite build has no FTS5 (${err.message}). ` +
        `Delete ${VENDOR} and re-run to refetch ${PKG}@${VERSION}.`
    );
  } finally {
    probe.close();
  }

  cached = sqlite3;
  return sqlite3;
}

export const VENDOR_DIR = VENDOR;
export const SQLITE_VERSION = VERSION;
