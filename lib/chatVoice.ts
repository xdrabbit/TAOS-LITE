// Where a voice note lives, and what its path means — kept pure so it can be
// fenced (tests/chat-delete.test.ts), same reason chatInvite, chatLabels and
// chatThreads live outside their routes.
//
// ── Why this file exists now ───────────────────────────────────────────────
// The path shape `<thread_id>/<uuid>.<ext>` was invented inside
// /api/chat/voice and then quietly relied on by three other things: the
// storage read policy (`taos_lite_is_chat_member(split_part(name,'/',1))` —
// membership is decided by the FIRST PATH SEGMENT), the thread-delete route,
// which removes a thread's audio by listing that folder, and the orphan sweep.
// A convention four things depend on and one of them owns is a convention
// waiting to drift, and the drift would be silent: change the shape and the
// storage policy starts answering about the wrong thread.
//
// `docs/data-map.md` (2026-08-26) is the reason the other three exist at all.
// Voice audio had no delete path of any kind — no policy, no route, no
// cleanup — so a voice note outlived its message, its thread, and the account
// that sent it. Every consumer of this file is part of closing that.

/** The private bucket. One name, because two would drift. */
export const CHAT_VOICE_BUCKET = "chat-voice";

/**
 * The file extension for a recording's mime type.
 *
 * Phones disagree about what they record: iOS Safari gives mp4/aac, Android
 * Chrome gives webm/opus. The extension is cosmetic to Supabase Storage (the
 * content type is sent alongside) and load-bearing to the player, which
 * sniffs the URL when the server is vague.
 */
export function voiceExtensionFor(mime: string): string {
  if (mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "webm";
}

/**
 * Where a new voice note goes.
 *
 * The thread id leads, and that is not a filing preference — it is the
 * permission. The storage policy reads `split_part(name, '/', 1)` and asks
 * whether the caller is a member of THAT thread, so the first segment is the
 * access-control decision written into the file name.
 */
export function voicePath(threadId: string, objectId: string, mime: string): string {
  return `${threadId}/${objectId}.${voiceExtensionFor(mime)}`;
}

/** The thread a stored object belongs to, or null if the name is not ours. */
export function threadIdFromVoicePath(path: string): string | null {
  const [thread, ...rest] = path.split("/");
  if (!thread || rest.length !== 1 || !rest[0]) return null;
  return thread;
}

/**
 * Is this object one of `threadId`'s, exactly?
 *
 * Used where a path is about to be handed to a delete call. A storage listing
 * is already scoped to a folder, so this is the second fence rather than the
 * first — but "second fence" is the right amount of paranoia for the only
 * destructive call in the app, and it makes the widening cases (`..`, a name
 * containing a slash, a prefix match like `<id>-other/`) impossible rather
 * than merely unlikely.
 */
export function isVoicePathForThread(path: string, threadId: string): boolean {
  return Boolean(threadId) && threadIdFromVoicePath(path) === threadId;
}
