// The thread LIST for /chat — one row per chat, kept pure so it can be fenced
// (tests/chat-threads.test.ts), same reason chatLabels and chatInvite live
// outside their routes.
//
// ── Why this file exists ───────────────────────────────────────────────────
// /chat held one chat at a time. Not in the schema — the members table is
// keyed (thread_id, user_id) and never cared — but in the code: lib/chat.ts
// drew the FIRST thread an account belonged to, /api/chat/invite re-used that
// same first thread, and /api/chat/join refused a second one outright with
//
//     "You're already in a chat, and TAOS holds one at a time."
//
// Tom hit that sentence on his own app during the two-phone walkthrough. It
// was an honest description of a screen with no switcher, which is the point:
// the refusal existed because there was nowhere to put a second chat, so the
// fix is the somewhere, and the refusal goes with it. Verdict from the
// walkthrough was multiples, with every existing thread untouched.
//
// A row has to answer three questions at a glance, and all three are the
// VIEWER's, not the thread's:
//
//   who is this with  -> partnerDisplayName, off their own auth profile
//   what was said     -> threadPreview, in the language I read HERE
//   when              -> formatThreadStamp
//
// The middle one is the one worth being careful about. Reading language is
// per-MEMBERSHIP (taos_lite_chat_members.lang, one row per person per thread),
// so the same message previews differently in two different people's lists —
// and a preview that showed the raw body would put the sender's language in a
// list the sender never opens.

// ── The words ──────────────────────────────────────────────────────────────
// Bilingual, "English · Español" per the app's convention: both people in a
// thread are looking at the same layout in different languages.

/** Over the list. */
export const CHAT_LIST_CAPTION = "Your chats · Tus chats";

/** The way back to the list from inside a thread. Small, and always there. */
export const CHAT_LIST_BACK = "← Chats";

/**
 * A thread nobody has joined yet — the state a freshly minted invite leaves
 * behind. Not an error and not an empty chat: it is a chat waiting on a link
 * somebody is still holding, and the row says so rather than showing a blank.
 */
export const CHAT_LIST_WAITING = "Waiting for someone · Esperando a alguien";

/** A partner whose account carries no name and no email we can read. */
export const CHAT_LIST_SOMEONE = "Someone · Alguien";

/** A thread with a second person in it and nothing said yet. */
export const CHAT_LIST_NO_MESSAGES = "No messages yet · Aún no hay mensajes";

/** Longest name a row will show before it starts eating the timestamp. */
export const NAME_MAX = 28;

/** Longest preview a row will show. One line on the narrowest phone. */
export const PREVIEW_MAX = 80;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

// ── Who the row is with ────────────────────────────────────────────────────

/**
 * The shape of an auth profile this file is willing to look at. Deliberately
 * loose: it is whatever Supabase hands back for the OTHER member, and the
 * metadata is provider-shaped (Google fills full_name; a passcode account
 * fills nothing at all).
 */
export interface ChatPartnerIdentity {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

/**
 * What to call the other person: their own display name, never a name this
 * app decided for them.
 *
 * Google's `full_name` first, then the email's local part, then a bilingual
 * "Someone" — the app has no directory and no profile screen, so there is no
 * fourth place to look and inventing one would be putting a stranger's label
 * on a stranger. Returns null when there IS no other person yet, which is a
 * different thing from an unnameable one and gets a different row.
 */
export function partnerDisplayName(
  user: ChatPartnerIdentity | null | undefined
): string | null {
  if (!user) return null;
  const meta = user.user_metadata ?? {};
  for (const key of ["full_name", "name", "preferred_username"]) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return clip(value, NAME_MAX);
  }
  const email = typeof user.email === "string" ? user.email : "";
  const local = email.split("@")[0]?.trim() ?? "";
  if (local) return clip(local, NAME_MAX);
  return CHAT_LIST_SOMEONE;
}

/** The row's title: the partner, or the fact that there isn't one. */
export function threadRowLabel(partnerName: string | null): string {
  return partnerName ?? CHAT_LIST_WAITING;
}

// ── What the row says ──────────────────────────────────────────────────────

/** Just enough of a message row to preview it. */
export interface ChatPreviewMessage {
  sender_id: string;
  kind: "text" | "voice";
  body: string;
  body_translated: string | null;
}

/**
 * The last line of the thread, IN THE LANGUAGE THE VIEWER READS.
 *
 * The same rule the bubbles draw by (components/ChatShell.tsx): my own message
 * previews as I typed it, theirs previews as it was translated FOR ME. Getting
 * this backwards would put Spanish in Tom's list under a chat he reads in
 * English — the exact confusion lib/chatLabels.ts spent three rounds fixing
 * one screen further in.
 *
 * A missing translation falls through to the original rather than to nothing:
 * the send routes deliberately store a message untranslated when the provider
 * hiccups, and a blank row would hide a message that did arrive.
 */
export function threadPreview(
  message: ChatPreviewMessage | null | undefined,
  myUserId: string
): string {
  if (!message) return CHAT_LIST_NO_MESSAGES;
  const mine = message.sender_id === myUserId;
  const text = mine ? message.body : message.body_translated ?? message.body;
  const clipped = clip(text ?? "", PREVIEW_MAX);
  if (!clipped) return CHAT_LIST_NO_MESSAGES;
  // Voice notes preview as their transcript, which is the useful part — the
  // 🎤 says where it came from. The voice route already falls back to a body
  // that carries the emoji itself, so don't stack a second one.
  if (message.kind === "voice" && !clipped.startsWith("🎤")) return `🎤 ${clipped}`;
  return clipped;
}

/**
 * When. Today is a time, anything older is a date — the same two formats the
 * thread itself uses for its bubbles and its day separators.
 *
 * `now` is a parameter so this is testable without freezing the clock, and an
 * unparseable stamp answers "" rather than "Invalid Date": a row with no time
 * on it is a smaller lie than a row with nonsense on it.
 */
export function formatThreadStamp(iso: string | null | undefined, now: number = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const when = new Date(at);
  const today = new Date(now);
  return when.toDateString() === today.toDateString()
    ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleDateString([], { month: "short", day: "numeric" });
}

// ── The list ───────────────────────────────────────────────────────────────

/** One row, as GET /api/chat/threads answers it. */
export interface ChatThreadSummary {
  threadId: string;
  /** MY reading language in THIS thread. Per-membership; two threads differ. */
  myLang: string;
  /** Theirs, in this thread. Null until somebody joins. */
  partnerLang: string | null;
  /** Their own display name. Null until somebody joins. */
  partnerName: string | null;
  /** The last thing said, already resolved into my language. */
  preview: string;
  /** Last message time, or the thread's creation time when it is still empty. */
  updatedAt: string;
}

/**
 * Newest first, and never a shuffle: threads that share a timestamp fall back
 * to their id so the list cannot reorder under a thumb between two renders.
 */
export function sortThreads(threads: readonly ChatThreadSummary[]): ChatThreadSummary[] {
  return [...threads].sort((a, b) => {
    const at = Date.parse(a.updatedAt);
    const bt = Date.parse(b.updatedAt);
    const av = Number.isFinite(at) ? at : 0;
    const bv = Number.isFinite(bt) ? bt : 0;
    if (av !== bv) return bv - av;
    return a.threadId.localeCompare(b.threadId);
  });
}

/**
 * Which thread to open on arrival.
 *
 * One chat behaves exactly as it did before this file existed — straight in,
 * no list in the way, because a list of one is a tap that asks a question with
 * one answer. Two or more, and the list IS the screen. A `wanted` thread (the
 * ?t= in the URL, which is where /chat/join lands somebody it just let in)
 * wins over both, and is ignored if it is not mine — a stale link should not
 * open an empty thread view.
 */
export function initialThreadId(
  threads: readonly ChatThreadSummary[],
  wanted?: string | null
): string | null {
  if (wanted && threads.some((t) => t.threadId === wanted)) return wanted;
  return threads.length === 1 ? threads[0].threadId : null;
}
