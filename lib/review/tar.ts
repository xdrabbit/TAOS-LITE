// A plain ustar archive, written by hand. Isomorphic (no node: imports).
//
// Why a tar and not a zip or a manifest of links: the review export's
// consumer is `tar xf` into a directory the transcriber probe reads
// (tests/live-fire/transcribe-accuracy.run.mjs --clips <dir>), the clips are
// private and only the service role can sign them, and the archive is built
// in one founder-authenticated request — nothing to install, no token to
// paste into a script. Uncompressed: opus and mp3 do not compress.

export interface TarEntry {
  /** Relative path, forward slashes, at most 100 bytes. */
  name: string;
  data: Uint8Array;
  /** Seconds since the epoch. */
  mtime?: number;
}

const BLOCK = 512;
const encoder = new TextEncoder();

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
  block.set(bytes, offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  // NUL-terminated, zero-padded, as GNU tar writes it.
  writeString(block, offset, length, value.toString(8).padStart(length - 1, "0"));
}

function header(entry: TarEntry): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const nameBytes = encoder.encode(entry.name);
  if (nameBytes.length > 100) throw new Error(`tar name too long: ${entry.name}`);
  writeString(block, 0, 100, entry.name);
  writeOctal(block, 100, 8, 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, entry.data.length);
  writeOctal(block, 136, 12, Math.max(0, Math.floor(entry.mtime ?? 0)));
  // Checksum is computed with the field itself as spaces.
  block.fill(0x20, 148, 156);
  block[156] = 0x30; // '0' — regular file
  writeString(block, 257, 6, "ustar");
  block[262] = 0;
  writeString(block, 263, 2, "00");
  let sum = 0;
  for (const b of block) sum += b;
  writeString(block, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return block;
}

/** The whole archive, in memory. */
export function buildTar(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const entry of entries) {
    const h = header(entry);
    const padded = Math.ceil(entry.data.length / BLOCK) * BLOCK;
    const body = new Uint8Array(padded);
    body.set(entry.data);
    parts.push(h, body);
    total += BLOCK + padded;
  }
  const end = new Uint8Array(BLOCK * 2);
  parts.push(end);
  total += end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The reverse, for the round-trip test and nothing else in production:
 * enough of ustar to read back what buildTar wrote.
 */
export function readTar(archive: Uint8Array): TarEntry[] {
  const decoder = new TextDecoder();
  const entries: TarEntry[] = [];
  let at = 0;
  while (at + BLOCK <= archive.length) {
    const block = archive.subarray(at, at + BLOCK);
    if (block.every((b) => b === 0)) break;
    const field = (from: number, to: number): string => decoder.decode(block.subarray(from, to)).split("\0")[0].trim();
    const name = field(0, 100);
    const size = Number.parseInt(field(124, 136), 8);
    const mtime = Number.parseInt(field(136, 148), 8);
    const start = at + BLOCK;
    entries.push({ name, data: archive.slice(start, start + size), mtime });
    at = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}
