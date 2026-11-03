// A tiny ID3v2.3 writer for the shared mp3 (Tom, 2026-10-24).
//
// A shared file should say where it came from without a server round-trip and
// without touching the audio: the tag goes on the FRONT of the bytes the
// client already holds. v2.3 rather than v2.4 because it is the version
// every player reads (iOS, WhatsApp's own player, Windows Explorer); its
// frame sizes are plain big-endian, only the tag header's size is syncsafe.
//
// Text is Latin-1 when every character fits — "TAOS·LITE" does, the middle
// dot is U+00B7 — and UTF-16 with a BOM otherwise, which v2.3 calls
// encoding 1 and which covers a translated line in any script.

export interface Id3Tags {
  title: string;
  artist: string;
  album: string;
  /** COMM and WXXX both carry it: players show one or the other. */
  url: string;
  /** PNG bytes for the APIC front cover, or omitted for no art. */
  coverPng?: Uint8Array | null;
}

const LATIN1 = 0x00;
const UTF16 = 0x01;

function fitsLatin1(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) > 0xff) return false;
  return true;
}

function latin1(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}

function utf16(text: string): number[] {
  const out = [0xff, 0xfe];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out.push(code & 0xff, code >> 8);
  }
  return out;
}

/** [encoding byte, encoded text] — one encoding chosen for all the strings. */
function encode(...texts: string[]): { encoding: number; parts: number[][]; terminator: number[] } {
  const wide = !texts.every(fitsLatin1);
  return {
    encoding: wide ? UTF16 : LATIN1,
    parts: texts.map(wide ? utf16 : latin1),
    terminator: wide ? [0, 0] : [0]
  };
}

function frame(id: string, body: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(10 + body.length);
  out.set(latin1(id), 0);
  const size = body.length;
  out[4] = (size >>> 24) & 0xff;
  out[5] = (size >>> 16) & 0xff;
  out[6] = (size >>> 8) & 0xff;
  out[7] = size & 0xff;
  out.set(body, 10);
  return out;
}

function textFrame(id: string, text: string): Uint8Array {
  const { encoding, parts } = encode(text);
  return frame(id, [encoding, ...parts[0]]);
}

function commentFrame(text: string): Uint8Array {
  const { encoding, parts, terminator } = encode("", text);
  return frame("COMM", [encoding, ...latin1("eng"), ...parts[0], ...terminator, ...parts[1]]);
}

function urlFrame(url: string): Uint8Array {
  // Description empty; the URL itself is always Latin-1 in v2.3.
  return frame("WXXX", [LATIN1, 0, ...latin1(url)]);
}

function coverFrame(png: Uint8Array): Uint8Array {
  const head = [LATIN1, ...latin1("image/png"), 0, 0x03 /* front cover */, 0 /* no description */];
  const body = new Uint8Array(head.length + png.length);
  body.set(head, 0);
  body.set(png, head.length);
  return frame("APIC", body);
}

/** Bytes taken by an ID3v2 tag at the start of `bytes`, or 0. */
export function existingTagLength(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  return 10 + size + (bytes[5] & 0x10 ? 10 : 0);
}

/** The complete ID3v2.3 tag for `tags`. */
export function id3v2Tag(tags: Id3Tags): Uint8Array {
  const frames = [
    textFrame("TIT2", tags.title),
    textFrame("TPE1", tags.artist),
    textFrame("TALB", tags.album),
    commentFrame(tags.url),
    urlFrame(tags.url),
    ...(tags.coverPng && tags.coverPng.length > 0 ? [coverFrame(tags.coverPng)] : [])
  ];
  const size = frames.reduce((sum, f) => sum + f.length, 0);
  const out = new Uint8Array(10 + size);
  out.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00], 0);
  out[6] = (size >>> 21) & 0x7f;
  out[7] = (size >>> 14) & 0x7f;
  out[8] = (size >>> 7) & 0x7f;
  out[9] = size & 0x7f;
  let at = 10;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

/** `audio` with any tag it carried replaced by this one. */
export function tagMp3(audio: Uint8Array, tags: Id3Tags): Uint8Array {
  const tag = id3v2Tag(tags);
  const body = audio.subarray(existingTagLength(audio));
  const out = new Uint8Array(tag.length + body.length);
  out.set(tag, 0);
  out.set(body, tag.length);
  return out;
}
