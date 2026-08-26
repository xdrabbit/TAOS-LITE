// Where generated lessons live so they are only paid for once.
//
// A lesson is (module × target × learner) and nothing else — no user, no
// session, no time — so the SAME fourteen lessons serve every learner going
// to Mexico, and generating them again per visit would be burning money to
// produce a byte-identical page. The plan says it plainly: repeat visits must
// be free.
//
// Two layers, because they fail in different directions:
//
//   memory   — a module-scope Map. Free, instant, and on Vercel's Fluid
//              Compute it survives between requests on a warm instance. It
//              does NOT survive a deploy or a cold start, which is the whole
//              reason for the second layer.
//   database — public.tutor_lessons, written with the service role. Durable,
//              shared across instances and deploys.
//
// The database layer is BEST EFFORT on purpose. If SUPABASE_SERVICE_ROLE_KEY
// is missing (a local shell, a preview without the var) or the table has not
// been migrated yet, every call here quietly degrades to the memory cache and
// the feature still works — a lesson that costs one extra generation is a
// worse day than a lesson that 500s. The one thing it must never do is throw
// into the route.

import { supabaseAdmin, hasServiceRoleKey } from "@/lib/supabaseAdmin";
import type { Lesson } from "./lesson";

const TABLE = "tutor_lessons";

/**
 * Memory cap. 14 modules × a handful of language pairs is the realistic
 * working set on one instance; the cap exists so a crawler asking for 14 × 100
 * × 100 cannot grow the map without bound.
 */
const MEMORY_MAX = 200;

const memory = new Map<string, Lesson>();

function remember(key: string, lesson: Lesson): void {
  // Re-insert on write so the Map's insertion order is a usable LRU tail.
  memory.delete(key);
  memory.set(key, lesson);
  while (memory.size > MEMORY_MAX) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/** Tests only — the production reset is a new instance. */
export function clearLessonMemoryCache(): void {
  memory.clear();
}

export type LessonCacheHit = "memory" | "database" | null;

export interface CachedLesson {
  lesson: Lesson;
  hit: Exclude<LessonCacheHit, null>;
}

export async function readCachedLesson(key: string): Promise<CachedLesson | null> {
  const local = memory.get(key);
  if (local) {
    remember(key, local); // touch
    return { lesson: local, hit: "memory" };
  }
  if (!hasServiceRoleKey) return null;

  try {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select("lesson")
      .eq("cache_key", key)
      .maybeSingle();
    if (error || !data) return null;
    const lesson = (data as { lesson?: Lesson }).lesson;
    if (!lesson || typeof lesson !== "object") return null;
    remember(key, lesson);
    return { lesson, hit: "database" };
  } catch {
    return null;
  }
}

export async function writeCachedLesson(key: string, lesson: Lesson): Promise<void> {
  remember(key, lesson);
  if (!hasServiceRoleKey) return;
  try {
    await supabaseAdmin.from(TABLE).upsert(
      {
        cache_key: key,
        module_id: lesson.moduleId,
        target_lang: lesson.target,
        learner_lang: lesson.learner,
        prompt_version: lesson.promptVersion ?? 0,
        model: lesson.model ?? null,
        lesson
      },
      { onConflict: "cache_key" }
    );
  } catch {
    /* cache misses cost a generation; a cache write failure must cost nothing */
  }
}
