// A Taokie channel is a /call room: the same five-character code, the same
// unambiguous alphabet, shared the same way (a link with ?room=). The code
// IS the pairing — two founders in the same room are a channel, and a third
// phone is turned away (lib/walkie/channel.ts, like lib/call/session.ts).
//
// Duplicated from lib/call/session.ts rather than imported, because that
// file is "use client" and builds a WebRTC call; the routes need the
// alphabet and nothing else. tests/walkie.test.ts pins the two in step.

export const ROOM_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const ROOM_LENGTH = 5;

export function normalizeWalkieRoom(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().toUpperCase().replace(/[^0-9A-Z-]/g, "");
}

/** A code that could have come from the generator — nothing else reaches a row. */
export function isWalkieRoom(code: string): boolean {
  if (code.length < 4 || code.length > 12) return false;
  for (const ch of code) if (!ROOM_ALPHABET.includes(ch)) return false;
  return true;
}
