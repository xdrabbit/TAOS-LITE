// The way into a /chat thread, kept pure so it can be fenced
// (tests/chat-invite.test.ts) — same reason buildInstructions, chatLabels and
// elevenLabsVoiceId live outside their routes.
//
// ── Why this file exists ───────────────────────────────────────────────────
// /chat had no entry path at all. The one thread in the database was seeded by
// hand in July, and every account that was not one of those two rows landed on
// this, in English, under a live composer that could not send anything:
//
//     "This account isn't part of a chat yet. Sign in with your own Google
//      account (not the shared passcode account)."
//
// Tom hit it on his second phone during the RC1 walkthrough, signed in, with a
// perfectly good Google account. The sentence is an instruction to do the
// thing he had just done, so the only way to read it is "your sign-in didn't
// take" — a state the app was in no position to claim. There was nothing
// wrong with his account; there was no flow.
//
// So: one person mints a link, the other opens it. A link and not a user
// search, because a user search needs a directory of everyone who has ever
// signed up, and /chat is two people who already have each other's phone
// number. A link is also already the app's idiom — the QR on /translate is how
// a stranger at a table gets TAOS in the first place.
import { trustedOrigin } from "@/lib/authRedirect";

/** How long a minted link stays good. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Token length in bytes before base64url encoding. 24 bytes → 32 characters,
 * 192 bits. The token IS the credential — anyone holding it becomes the other
 * half of somebody's private conversation — so it is sized to be unguessable
 * rather than to be typed by hand.
 */
export const INVITE_TOKEN_BYTES = 24;

/** The shape, mirrored by the CHECK constraint in the invites migration. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22,64}$/;

export function isInviteToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_SHAPE.test(value);
}

/**
 * A fresh token. Web Crypto rather than `node:crypto` so this module stays
 * importable from the client half of /chat, which needs the copy below.
 */
export function newInviteToken(): string {
  const bytes = new Uint8Array(INVITE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function inviteExpiry(now: number = Date.now()): string {
  return new Date(now + INVITE_TTL_MS).toISOString();
}

export function isInviteExpired(expiresAt: string, now: number = Date.now()): boolean {
  const at = Date.parse(expiresAt);
  // An unparseable expiry counts as expired. The only way to get one is a row
  // this code did not write, and "refuse" is the safe direction to guess in.
  return !Number.isFinite(at) || at <= now;
}

/** The path an invite link points at. One place, because two would drift. */
export function invitePath(token: string): string {
  return `/chat/join/${token}`;
}

/**
 * The full link to hand somebody.
 *
 * The origin goes through `trustedOrigin` — the same allow-list Google
 * sign-in is fenced by (lib/authRedirect.ts) — because this URL is built from
 * a client-supplied `Origin` header and then displayed, copied, and printed
 * into a QR code for a stranger to scan. An unrecognized origin falls back to
 * production rather than being echoed, which is also the right answer for the
 * boring case: a link minted somewhere odd should still land on the real app.
 */
export function inviteUrl(origin: string | null | undefined, token: string): string {
  return `${trustedOrigin(origin)}${invitePath(token)}`;
}

// ── The words ──────────────────────────────────────────────────────────────
// Bilingual throughout, "English · Español" per the app's convention. The
// route messages live here with the screen's, and not as string literals in
// app/api/chat/join, because they are the same conversation with the same
// person: half of them are read on the join screen and half on the chat
// screen, and the pair has to sound like one app.

/** The empty state for an account that belongs to no thread. */
export const CHAT_NO_THREAD_TITLE = "No chat yet · Aún no hay chat";

export const CHAT_NO_THREAD_BODY =
  "A chat is two people. Start one and send the link to the person you want to " +
  "talk with — they open it on their phone and you are in. · " +
  "Un chat son dos personas. Empieza uno y envía el enlace a la persona con quien " +
  "quieres hablar — lo abre en su teléfono y ya están dentro.";

export const CHAT_START_LABEL = "Start a chat · Inicia un chat";
export const CHAT_START_BUSY = "Starting… · Empezando…";

/** The button on a thread that is still one person. */
export const CHAT_INVITE_LABEL = "Invite someone · Invita a alguien";
export const CHAT_INVITE_BUSY = "Making a link… · Creando enlace…";

/** Above the QR in the invite sheet. */
export const CHAT_INVITE_HEADING = "Invite to chat · Invita al chat";

export const CHAT_INVITE_BLURB =
  "They scan this, or you send them the link. Whoever opens it becomes the " +
  "other person in this chat. · " +
  "Lo escanean, o les envías el enlace. Quien lo abra será la otra persona de " +
  "este chat.";

/** Said out loud under the link, because both halves surprise people. */
export const CHAT_INVITE_CAUTION =
  "One person only, and the link expires in 7 days. · " +
  "Solo una persona, y el enlace caduca en 7 días.";

export const CHAT_INVITE_COPY = "Copy link · Copiar enlace";
export const CHAT_INVITE_COPIED = "Copied · Copiado";

// The join screen.
export const CHAT_JOIN_TITLE = "You've been invited to chat · Te han invitado a chatear";

export const CHAT_JOIN_BLURB =
  "Private messages between the two of you, each one translated into the " +
  "language the other reads. · " +
  "Mensajes privados entre ustedes dos, cada uno traducido al idioma que lee la " +
  "otra persona.";

export const CHAT_JOIN_SIGNED_OUT =
  "Sign in and you're in the chat. · Inicia sesión y ya estás en el chat.";

export const CHAT_JOIN_BUSY = "Joining… · Uniéndote…";

// ── The refusals ───────────────────────────────────────────────────────────
// Every one of these has to be a true statement about the LINK, never about
// the reader's account — that confusion is the whole bug this file is fixing.
// None of them may ask a signed-in person to sign in.

export const CHAT_JOIN_BAD_LINK =
  "This invite link isn't valid. Ask for a new one. · " +
  "Este enlace de invitación no es válido. Pide uno nuevo.";

export const CHAT_JOIN_USED =
  "This link has already been used. Ask for a new one. · " +
  "Este enlace ya se usó. Pide uno nuevo.";

export const CHAT_JOIN_EXPIRED =
  "This link has expired. Ask for a new one. · " +
  "Este enlace caducó. Pide uno nuevo.";

export const CHAT_JOIN_FULL =
  "That chat already has two people in it. · " +
  "Ese chat ya tiene dos personas.";

/**
 * One chat per account, for now.
 *
 * lib/chat.ts takes the FIRST thread an account belongs to and draws it; there
 * is no thread list and no switcher. So joining a second one would look like
 * the link doing nothing, which is a worse dead end than the one being fixed
 * here. Said plainly instead, and logged in ENHANCEMENTS.md as the next thing
 * this screen wants.
 */
export const CHAT_JOIN_ALREADY_IN_ANOTHER =
  "You're already in a chat, and TAOS holds one at a time. · " +
  "Ya estás en un chat, y TAOS mantiene uno a la vez.";

/** Not an error: they opened their own link, or opened the same one twice. */
export const CHAT_JOIN_ALREADY_MEMBER =
  "You're already in this chat. · Ya estás en este chat.";
