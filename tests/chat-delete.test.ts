// The fence around DELETE MEANS DELETE.
//
// `docs/data-map.md` (2026-08-26) found three ways this app kept things it had
// implied it would not: two backup tables of everyone's translation history
// sitting outside every delete path, a chat corpus nobody could delete at all,
// and voice audio that outlived the message, the thread and the account that
// sent it. This file pins the fixes.
//
// Two of the three are SCHEMA facts, and the lesson from
// tests/chat-language.test.ts applies: a source-reading test cannot see the
// database, so what it reads is the migration — the schema's record in the
// repo. That is exactly how the `lang in ('en','es')` ceiling hid for a month.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHAT_DELETE_CONFIRM,
  CHAT_DELETE_FAILED,
  CHAT_DELETE_LABEL
} from "@/lib/chatThreads";
import {
  CHAT_VOICE_BUCKET,
  isVoicePathForThread,
  threadIdFromVoicePath,
  voiceExtensionFor,
  voicePath
} from "@/lib/chatVoice";

const MIGRATIONS_DIR = new URL("../supabase/migrations/", import.meta.url);

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

/** A migration's SQL with its `--` commentary stripped. */
function sql(name: string): string {
  const found = migrationNames().find((m) => m === name);
  if (!found) throw new Error(`missing migration ${name}`);
  return readFileSync(new URL(found, MIGRATIONS_DIR), "utf8").replace(/^\s*--.*$/gm, "");
}

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("the translation backups are dropped, not archived", () => {
  const migration = sql("20260826_drop_translation_backups.sql");

  it("drops both tables by name", () => {
    expect(migration).toMatch(/drop table public\.taos_lite_translations_bak_20260706/);
    expect(migration).toMatch(/drop table public\.taos_lite_translations_bak_20260825/);
  });

  it("does not quietly move them somewhere else first", () => {
    // Tom's call was a straight drop — he keeps his own backups. An export, a
    // rename, or a copy into another schema would be the same rows in a new
    // place, which is the thing being fixed rather than a gentler version of
    // fixing it.
    expect(migration).not.toMatch(/create table/i);
    expect(migration).not.toMatch(/alter table .* rename/i);
    expect(migration).not.toMatch(/insert into/i);
  });

  it("is not `if exists` — a silent no-op would hide a recreated table", () => {
    expect(migration).not.toMatch(/drop table if exists/i);
  });
});

describe("taos_leads is server-only", () => {
  const migration = sql("20260826_leads_server_only.sql");

  it("drops the world-writable insert policy and leaves RLS on", () => {
    expect(migration).toMatch(/drop policy if exists taos_leads_anon_insert/);
    expect(migration).toMatch(/enable row level security/);
  });

  it("does not replace it with a narrower browser-reachable write", () => {
    // A `with check` cannot express a rate limit or a validated address. The
    // writer is a route now; see app/api/leads/route.ts.
    expect(migration).not.toMatch(/create policy/i);
  });

  it("the route is the replacement, and it validates, limits, and uses the service role", () => {
    const route = source("app/api/leads/route.ts");
    expect(route).toContain("isValidLeadEmail");
    expect(route).toContain("fromTrustedOrigin");
    expect(route).toContain("hit(leadBuckets");
    expect(route).toContain("supabaseAdmin");
    // Never echo Postgres at a stranger: the error names columns.
    expect(route).not.toMatch(/error:\s*error\.message/);
  });
});

describe("either member may delete the whole chat", () => {
  const migration = sql("20260826_chat_thread_deletion.sql");

  it("adds a DELETE policy keyed on membership, not on authorship", () => {
    expect(migration).toMatch(/on public\.taos_lite_chat_threads/);
    expect(migration).toMatch(/for delete/);
    expect(migration).toMatch(/using \(public\.taos_lite_is_chat_member\(id\)\)/);
    // sender_id anywhere in this policy would mean "delete my half", which is
    // the asymmetry the whole change exists to remove.
    expect(migration).not.toMatch(/sender_id/);
  });

  it("purges a departing account's threads entirely, before the FK cascades", () => {
    expect(migration).toMatch(/before delete on auth\.users/);
    expect(migration).toMatch(/delete from public\.taos_lite_chat_threads/);
    expect(migration).toMatch(/security definer/);
  });

  it("does not try to delete storage from SQL — Supabase refuses that", () => {
    // storage.objects carries protect_objects_delete, which raises on any SQL
    // DELETE. A trigger that tried would fail at the worst possible moment:
    // mid-cascade, on an account deletion.
    expect(migration).not.toMatch(/delete from storage\.objects/i);
  });
});

describe("the delete route takes the audio down with the rows", () => {
  const route = source("app/api/chat/thread/[id]/route.ts");

  it("is member-only, and reads MY membership rather than the thread", () => {
    expect(route).toContain('.eq("user_id", user.id)');
    expect(route).toContain('.eq("thread_id", threadId)');
    expect(route).toContain("You are not part of this chat.");
    expect(route).toContain("403");
  });

  it("removes storage BEFORE the rows, and aborts if storage fails", () => {
    const removeAt = route.indexOf(".remove(paths)");
    const deleteRowsAt = route.indexOf('.from("taos_lite_chat_threads")');
    expect(removeAt).toBeGreaterThan(-1);
    expect(deleteRowsAt).toBeGreaterThan(-1);
    // Audio left behind after the rows are gone is the privacy promise broken
    // with nothing left pointing at the evidence. Rows left behind after the
    // audio is gone is a retry.
    expect(removeAt).toBeLessThan(deleteRowsAt);
  });

  it("deletes the thread row and lets the FKs do the rest", () => {
    // Every FK into a thread is ON DELETE CASCADE, so hand-deleting messages
    // would be a second, driftable copy of the schema's own rule.
    expect(route).not.toMatch(/from\("taos_lite_chat_messages"\)[\s\S]{0,80}\.delete\(\)/);
    expect(route).toMatch(/from\("taos_lite_chat_threads"\)[\s\S]{0,80}\.delete\(\)/);
  });
});

describe("the confirm says what the delete actually does", () => {
  it("warns that it hits both people, in both languages", () => {
    expect(CHAT_DELETE_CONFIRM).toMatch(/BOTH of you/);
    expect(CHAT_DELETE_CONFIRM).toMatch(/LOS DOS/);
  });

  it("names the voice notes, which are the part people would regret", () => {
    expect(CHAT_DELETE_CONFIRM).toMatch(/voice note/i);
    expect(CHAT_DELETE_CONFIRM).toMatch(/notas de voz/i);
  });

  it("says it cannot be undone, in both languages", () => {
    expect(CHAT_DELETE_CONFIRM).toMatch(/can't be undone/i);
    expect(CHAT_DELETE_CONFIRM).toMatch(/no se puede deshacer/i);
  });

  it("keeps the app's bilingual label convention", () => {
    for (const label of [CHAT_DELETE_LABEL, CHAT_DELETE_FAILED]) {
      expect(label).toContain("·");
    }
  });

  it("the shell asks before it calls, and does not delete rows behind the route", () => {
    const shell = source("components/ChatShell.tsx");
    expect(shell).toContain("window.confirm(CHAT_DELETE_CONFIRM)");
    expect(shell).toContain("deleteChatThread(thread.threadId)");
    const client = source("lib/chat.ts");
    // A direct supabase delete from the browser would satisfy the policy and
    // strand every voice note in the thread.
    expect(client).not.toMatch(/from\("taos_lite_chat_threads"\)/);
  });
});

describe("the voice path shape has one owner", () => {
  it("puts the thread id first — that segment IS the storage permission", () => {
    // The storage read policy is taos_lite_is_chat_member(split_part(name,
    // '/', 1)). Move the thread id out of the first segment and membership
    // starts being decided about the wrong thread.
    expect(voicePath("thread-1", "abc", "audio/webm")).toBe("thread-1/abc.webm");
    expect(threadIdFromVoicePath("thread-1/abc.webm")).toBe("thread-1");
  });

  it("maps what phones actually record", () => {
    expect(voiceExtensionFor("audio/mp4")).toBe("m4a");
    expect(voiceExtensionFor("audio/webm;codecs=opus")).toBe("webm");
    expect(voiceExtensionFor("audio/ogg")).toBe("ogg");
    expect(voiceExtensionFor("audio/mpeg")).toBe("mp3");
  });

  it("refuses to widen a delete beyond one thread's folder", () => {
    expect(isVoicePathForThread("t1/a.webm", "t1")).toBe(true);
    expect(isVoicePathForThread("t2/a.webm", "t1")).toBe(false);
    expect(isVoicePathForThread("t1-other/a.webm", "t1")).toBe(false);
    expect(isVoicePathForThread("t1/nested/a.webm", "t1")).toBe(false);
    expect(isVoicePathForThread("../t2/a.webm", "t1")).toBe(false);
    expect(isVoicePathForThread("a.webm", "t1")).toBe(false);
    expect(isVoicePathForThread("t1/a.webm", "")).toBe(false);
  });

  it("is the only place the bucket is named", () => {
    expect(CHAT_VOICE_BUCKET).toBe("chat-voice");
    for (const path of [
      "app/api/chat/voice/route.ts",
      "app/api/chat/thread/[id]/route.ts",
      "app/api/chat/voice/orphans/route.ts",
      "lib/chat.ts"
    ]) {
      // A second string literal is a second bucket name waiting to drift out
      // of step with the storage policy.
      expect(source(path)).not.toMatch(/["']chat-voice["']/);
    }
  });
});

describe("the orphan sweep is the safety net SQL cannot be", () => {
  const route = source("app/api/chat/voice/orphans/route.ts");

  it("is founders-only — it reads paths from other people's conversations", () => {
    expect(route).toContain("isFounder");
  });

  it("reports before it removes", () => {
    expect(route).toMatch(/export async function GET/);
    expect(route).toMatch(/export async function POST/);
  });

  it("defines an orphan as an object no message row points at", () => {
    expect(route).toContain('.select("audio_path")');
    expect(route).toContain("owned.has(p)");
  });
});
