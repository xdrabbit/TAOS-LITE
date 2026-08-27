// One module, instantiated in one language, for one learner.
//
// POST { moduleId, target, learner } -> a Lesson (lib/tutor/lesson.ts).
//
// This is where the fourteen intent modules become teachable text. The prompt
// and the parser live in lib/tutor/lesson.ts; the route's own job is the three
// fences around them: the tutor flag, the spend guard, and the cache.
//
// The cache is not an optimization here, it is the feature's economics. A
// lesson depends on (module, target, learner) and on nothing else, so the
// second person to open "I need / I want" in Spanish must not cost a
// generation — and neither must the same person opening it again tomorrow.
// See lib/tutor/lessonStore.ts.
//
// NOTE the sibling route: /api/tutor/lessons (plural) is the old 30-day
// English course parsed out of content/tutor-course markdown. Different
// feature, still wired to the Drills tab, deliberately untouched.

import { NextRequest, NextResponse } from "next/server";
import { isLanguageCode, canSpeak } from "@/lib/languages/catalog";
import { tutorEnabled } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";
import { buildLessonPrompt, lessonCacheKey, parseLesson, LessonParseError } from "@/lib/tutor/lesson";
import { readCachedLesson, writeCachedLesson } from "@/lib/tutor/lessonStore";
import { getTutorModule } from "@/lib/tutor/modules";
import { canAssessPronunciation } from "@/lib/tutor/pronunciation";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Generation is slow and rare; a lesson is worth waiting for once. */
const GENERATION_TIMEOUT_MS = 90_000;

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Tutor is off (lib/release.ts) and this route mints a completion, so it
  // answers as if it did not exist — same rule as /api/tutor/realtime.
  if (!tutorEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const guard = await guardSpend(req);
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as {
    moduleId?: string;
    target?: string;
    learner?: string;
  };

  const mod = getTutorModule(String(body.moduleId ?? ""));
  if (!mod) {
    return NextResponse.json({ error: "Unknown module." }, { status: 400 });
  }
  const target = String(body.target ?? "");
  const learner = String(body.learner ?? "");
  if (!isLanguageCode(target) || !isLanguageCode(learner)) {
    return NextResponse.json({ error: "Unsupported language." }, { status: 400 });
  }
  if (target === learner) {
    // Not a validation nicety: a lesson contrasting a language with itself has
    // no contrast hook, which is most of what a lesson is.
    return NextResponse.json(
      { error: "Pick a language different from the one you already speak." },
      { status: 400 }
    );
  }

  // What the CLIENT needs to know about this pair before it draws anything.
  // Both are honest degradations, not errors: a text-only language still has
  // a lesson to read, and an unscorable one still has a phrase to repeat.
  const capabilities = {
    speech: canSpeak(target),
    pronunciationScoring: canAssessPronunciation(target)
  };

  const key = lessonCacheKey(mod.id, target, learner);
  const cached = await readCachedLesson(key);
  if (cached) {
    return NextResponse.json({ lesson: cached.lesson, cached: true, source: cached.hit, capabilities });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing OPENAI_API_KEY." },
      { status: 500 }
    );
  }

  // The quality-sensitive translation model, not the cheap paraphrase one: a
  // lesson is generated once and then served forever, so this is the one place
  // in the app where paying for the better model is unambiguously correct.
  const model =
    process.env.OPENAI_TUTOR_LESSON_MODEL?.trim() ||
    process.env.OPENAI_TRANSLATE_MODEL?.trim() ||
    "gpt-4.1";

  const { system, user } = buildLessonPrompt({ module: mod, target, learner });

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS)
    });
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = payload ? JSON.stringify(payload) : `HTTP ${res.status}`;
      return NextResponse.json(
        { error: "Could not generate that lesson.", details: detail },
        { status: 502 }
      );
    }
    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    const content = typeof message?.content === "string" ? message.content : "";

    const lesson = {
      ...parseLesson(content, { module: mod, target, learner }),
      model,
      generatedAt: new Date().toISOString()
    };

    // Written after the parse, never before: a lesson that failed validation
    // must not become the cached answer for everyone who asks next.
    await writeCachedLesson(key, lesson);

    return NextResponse.json({ lesson, cached: false, source: "generated", capabilities });
  } catch (error) {
    if (error instanceof LessonParseError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    const messageText = error instanceof Error ? error.message : "Lesson generation failed.";
    return NextResponse.json(
      { error: "Could not generate that lesson.", details: messageText },
      { status: 502 }
    );
  }
}
