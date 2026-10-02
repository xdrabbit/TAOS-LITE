// Study lessons in the database, from the server side.
//
// Mirrors lib/tutor/lessonStore.ts in shape and differs in ownership: a tutor
// lesson is course content with no user on it; a Study lesson is one person's,
// made from their own history, and is written with user_id stamped from the
// verified session. The browser reads the library directly under RLS
// (lib/supabase.ts listStudyLessons); only this module ever inserts.
//
// Every write here follows a paid generation. A failed write must not throw
// the lesson away — the caller already has it and hands it to the screen — so
// write failures are reported, not raised.

import { supabaseAdmin, hasServiceRoleKey } from "@/lib/supabaseAdmin";
import type { StudyLesson, StudySource } from "./types";

const TABLE = "taos_lite_study_lessons";

export interface StudyLessonRow {
  id: string;
  user_id: string;
  lesson_key: string;
  session_id: string | null;
  source_ids: string[];
  selection: string;
  target_lang: string;
  explain_lang: string;
  model: string | null;
  lesson: StudyLesson;
  note: string;
  created_at: string;
  updated_at: string;
}

/** The saved lesson for this user and key, or null. */
export async function readStudyLesson(userId: string, key: string): Promise<StudyLessonRow | null> {
  if (!hasServiceRoleKey) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select("*")
      .eq("user_id", userId)
      .eq("lesson_key", key)
      .maybeSingle();
    if (error || !data) return null;
    return data as StudyLessonRow;
  } catch {
    return null;
  }
}

/**
 * Save a fresh generation. Upserts on (user_id, lesson_key) so a forced
 * regeneration replaces the lesson but keeps the row — and the note someone
 * wrote on it — rather than minting a second one.
 */
export async function writeStudyLesson(input: {
  userId: string;
  key: string;
  sources: StudySource[];
  selection: string;
  target: string;
  explain: string;
  model: string;
  lesson: StudyLesson;
}): Promise<{ id: string } | null> {
  if (!hasServiceRoleKey) return null;
  try {
    const sessionId = input.sources.find((s) => s.session_id)?.session_id ?? null;
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .upsert(
        {
          user_id: input.userId,
          lesson_key: input.key,
          session_id: sessionId,
          source_ids: input.sources.map((s) => s.id),
          selection: input.selection,
          target_lang: input.target,
          explain_lang: input.explain,
          model: input.model,
          lesson: input.lesson,
          updated_at: new Date().toISOString()
        },
        { onConflict: "user_id,lesson_key" }
      )
      .select("id")
      .single();
    if (error || !data) return null;
    return { id: (data as { id: string }).id };
  } catch {
    return null;
  }
}

/**
 * The user's own rows by id, in time order. The ids come from the client;
 * the rows do not — this is the server reading the table it trusts, scoped to
 * the signed-in user, so a lesson can never be built from text the browser
 * made up or from another person's history.
 */
export async function readOwnSources(userId: string, ids: string[]): Promise<StudySource[]> {
  if (!hasServiceRoleKey || !ids.length) return [];
  const { data, error } = await supabaseAdmin
    .from("taos_lite_translations")
    .select("id, created_at, session_id, source_lang, target_lang, original_text, translation_text")
    .eq("user_id", userId)
    .in("id", ids)
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data as StudySource[];
}

/**
 * The conversation around a source row, for meaning only: the same session
 * when the row has one, otherwise the nearest turns by time. A few lines
 * either side is enough to say what it meant; more just costs.
 */
export async function readContext(
  userId: string,
  anchor: StudySource,
  { before = 4, after = 4 }: { before?: number; after?: number } = {}
): Promise<StudySource[]> {
  if (!hasServiceRoleKey) return [];
  const cols = "id, created_at, session_id, source_lang, target_lang, original_text, translation_text";
  const base = supabaseAdmin.from("taos_lite_translations").select(cols).eq("user_id", userId);

  const earlier = anchor.session_id
    ? base.eq("session_id", anchor.session_id).lt("created_at", anchor.created_at)
    : base.lt("created_at", anchor.created_at);
  const later = (anchor.session_id
    ? supabaseAdmin.from("taos_lite_translations").select(cols).eq("user_id", userId).eq("session_id", anchor.session_id)
    : supabaseAdmin.from("taos_lite_translations").select(cols).eq("user_id", userId)
  ).gt("created_at", anchor.created_at);

  const [b, a] = await Promise.all([
    earlier.order("created_at", { ascending: false }).limit(before),
    later.order("created_at", { ascending: true }).limit(after)
  ]);
  const rows = [...((b.data ?? []) as StudySource[]).reverse(), ...((a.data ?? []) as StudySource[])];
  return rows.filter((r) => r.id !== anchor.id);
}
