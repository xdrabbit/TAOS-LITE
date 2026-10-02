// A Study lesson from one or two lines of your own history.
//
// POST { ids, selection?, target?, explain?, force? } -> StudyLessonResponse
//
// The prompt and the parser live in lib/study/lesson.ts (a port of the viewer
// prototype that proved them). The route's own job is the fences around them,
// in the same order every money route in this app uses: the study flag, the
// spend guard, then the cache.
//
// Two things this route refuses to take from the browser:
//   - the TEXT. The client sends row ids; the server reads the rows from the
//     table it trusts, scoped to the signed-in user. A lesson is never built
//     from text the phone typed in, and never from another person's rows.
//   - the BILL. A lesson is cached per (user, sources, selection, pair) and a
//     repeat ask is served from the table. `force` regenerates on purpose.

import { NextRequest, NextResponse } from "next/server";
import { studyEnabled } from "@/lib/release";
import { guardSpend, SIGN_IN_REQUIRED } from "@/lib/spendGuard";
import { isLanguageCode } from "@/lib/languages/catalog";
import {
  STUDY_LESSON_MODEL_DEFAULT,
  StudyLessonParseError,
  buildStudyPrompt,
  generateStudyLesson,
  languageName,
  languagesIn,
  studyLessonKey,
  targetSide
} from "@/lib/study/lesson";
import { readContext, readOwnSources, readStudyLesson, writeStudyLesson } from "@/lib/study/lessonStore";
import type { StudyLessonResponse } from "@/lib/study/types";

export const runtime = "nodejs";
// gpt-5.5 took 42s on a three-sentence message; the generator's own timeout is
// 120s, and this must outlive it or Vercel cuts the lesson off mid-answer.
export const maxDuration = 150;

const MAX_SOURCES = 3;
const MAX_SELECTION = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Study is dark until NEXT_PUBLIC_ENABLE_STUDY is set (lib/release.ts), and
  // this route mints a completion, so it answers as if it did not exist.
  if (!studyEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const guard = await guardSpend(req);
  if (!guard.ok) return guard.response;
  const user = guard.user;
  if (!user) return NextResponse.json({ error: SIGN_IN_REQUIRED }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    ids?: unknown;
    selection?: unknown;
    target?: unknown;
    explain?: unknown;
    force?: unknown;
  };

  const ids = (Array.isArray(body.ids) ? body.ids : [])
    .filter((v): v is string => typeof v === "string" && UUID.test(v))
    .slice(0, MAX_SOURCES);
  if (!ids.length) {
    return NextResponse.json({ error: "Pick a line to make a lesson from." }, { status: 400 });
  }
  const selection = typeof body.selection === "string" ? body.selection.slice(0, MAX_SELECTION) : "";

  const sources = await readOwnSources(user.id, ids);
  if (!sources.length) {
    return NextResponse.json({ error: "Those lines aren't in your history." }, { status: 404 });
  }

  // Which language to learn and which to be taught in. Defaults keep the
  // prototype's behaviour: the non-English side, explained in English.
  const code = (v: unknown): string | null => (typeof v === "string" && isLanguageCode(v) ? v : null);
  const autoTarget = targetSide(sources[0])?.lang ?? "es";
  const target = code(body.target) ?? autoTarget;
  const explain = code(body.explain) ?? "en";
  if (target === explain) {
    return NextResponse.json(
      { error: `Pick a different language to explain ${languageName(target)} in.` },
      { status: 400 }
    );
  }
  const missing = sources.find((r) => !targetSide(r, target));
  if (missing) {
    const has = languagesIn([missing]).map(languageName).join(" and ");
    return NextResponse.json(
      {
        error: `This line has no ${languageName(target)} side (it's ${has || "unlabelled"}). Pick a line in ${languageName(target)}, or change what you're learning.`
      },
      { status: 400 }
    );
  }

  const key = studyLessonKey(
    sources.map((s) => s.id),
    selection,
    target,
    explain
  );
  const existing = await readStudyLesson(user.id, key);
  if (existing && body.force !== true) {
    const cached: StudyLessonResponse = {
      id: existing.id,
      key,
      lesson: existing.lesson,
      cached: true,
      model: existing.model,
      target,
      explain,
      sources
    };
    return NextResponse.json(cached);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server misconfiguration: missing OPENAI_API_KEY." }, { status: 500 });
  }
  // Its own knob. The tutor's models are tuned for a different job, and the
  // prototype's finding was specific: gpt-4.1 marks flexible word orders as
  // mistakes, gpt-5.5 does not.
  const model = process.env.OPENAI_STUDY_LESSON_MODEL?.trim() || STUDY_LESSON_MODEL_DEFAULT;

  const context = await readContext(user.id, sources[0]);
  const prompt = buildStudyPrompt({ selection, records: sources, context, target, explain });

  const started = Date.now();
  try {
    const { lesson, usage } = await generateStudyLesson({ apiKey, model, prompt });
    // eslint-disable-next-line no-console
    console.log(
      `[taos-study-lesson] user=${user.id} key=${key} sentences=${lesson.sentences.length} model=${model} ms=${Date.now() - started}` +
        (usage ? ` tokens=${usage.prompt_tokens ?? "?"}+${usage.completion_tokens ?? "?"}` : "")
    );

    // Written after the parse, never before: a lesson that failed validation
    // must not become the saved answer for the next ask.
    const saved = await writeStudyLesson({
      userId: user.id,
      key,
      sources,
      selection,
      target,
      explain,
      model,
      lesson
    });

    const response: StudyLessonResponse = {
      id: saved?.id ?? existing?.id ?? "",
      key,
      lesson,
      cached: false,
      model,
      target,
      explain,
      sources
    };
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof StudyLessonParseError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    const message = error instanceof Error ? error.message : "Lesson generation failed.";
    return NextResponse.json({ error: "Could not make that lesson.", details: message }, { status: 502 });
  }
}
