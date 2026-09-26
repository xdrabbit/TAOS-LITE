// Saved lessons (tools/translations-viewer/lib/lessonStore.mjs). They hold
// Tom's own history, so: files are 0600, ids can't escape the folder, and a
// lesson is found again by WHAT it was made from, not by a row key that
// changes on every load.
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LessonStore,
  lessonId,
  newSavedLesson,
  recordIdentity,
  summary
} from "@/tools/translations-viewer/lib/lessonStore.mjs";

const rec = (over: Record<string, unknown> = {}) => ({
  key: 7,
  id: "t1",
  source_table: "public.taos_lite_translations",
  created_at: "2026-09-01T12:00:00Z",
  created_ms: Date.parse("2026-09-01T12:00:00Z"),
  source_lang: "es",
  target_lang: "en",
  original_text: "Ya te lo dije",
  translation_text: "I already told you",
  ...over
});

const lesson = {
  target_language: "es",
  caveats: "",
  sentences: [{ target: "Ya te lo dije.", english: "I already told you.", words: [{ text: "Ya" }] }]
};

describe("lesson identity", () => {
  it("ignores the viewer's row key, so a reload finds the same lesson", () => {
    expect(lessonId([rec({ key: 7 })])).toBe(lessonId([rec({ key: 9001 })]));
  });

  it("differs by selection and by source", () => {
    expect(lessonId([rec()], "te lo dije")).not.toBe(lessonId([rec()], ""));
    expect(lessonId([rec()])).not.toBe(lessonId([rec({ id: "t2" })]));
  });

  it("uses time + text for id-less rows from old exports", () => {
    const a = rec({ id: null });
    expect(recordIdentity(a)).toContain("Ya te lo dije");
    expect(lessonId([a])).toBe(lessonId([{ ...a, key: 3 }]));
  });
});

describe("LessonStore", () => {
  let dir: string;
  let store: LessonStore;
  beforeEach(async () => {
    dir = path.join(await mkdtemp(path.join(tmpdir(), "lessons-")), "lessons");
    store = new LessonStore(dir);
  });
  afterEach(async () => {
    await rm(path.dirname(dir), { recursive: true, force: true });
  });

  const saveOne = async (selection = "") => {
    const records = [rec()];
    const id = lessonId(records, selection);
    return store.put(newSavedLesson({ id, lesson, model: "gpt-5.5", records, selection, usage: null }));
  };

  it("writes owner-only files and reads them back", async () => {
    const saved = await saveOne();
    const mode = (await stat(path.join(dir, `${saved.id}.json`))).mode & 0o777;
    expect(mode).toBe(0o600);
    const back = await store.get(saved.id);
    expect(back?.lesson.sentences[0].target).toBe("Ya te lo dije.");
    // Enough of the source to find it again — not the conversation around it.
    expect(back?.sources[0]).toMatchObject({ id: "t1", original_text: "Ya te lo dije" });
    expect(await readdir(dir)).toEqual([`${saved.id}.json`]); // no temp file left behind
  });

  it("updates the note and tags without touching the lesson", async () => {
    const saved = await saveOne();
    const updated = await store.update(saved.id, { note: "Liz says this a lot", tags: ["Verbs", "verbs", " "] });
    expect(updated?.note).toBe("Liz says this a lot");
    expect(updated?.tags).toEqual(["verbs"]);
    expect(updated?.lesson).toEqual(saved.lesson);
  });

  it("lists newest first with a readable summary, and removes", async () => {
    const a = await saveOne("");
    await new Promise((r) => setTimeout(r, 5));
    const b = await saveOne("te lo dije");
    const list = await store.list();
    expect(list.map((l) => l.id)).toEqual([b.id, a.id]);
    expect(list[0]).toMatchObject({ title: "Ya te lo dije.", english: "I already told you.", sentenceCount: 1 });
    expect(await store.remove(a.id)).toBe(true);
    expect(await store.remove(a.id)).toBe(false);
    expect((await store.list()).map((l) => l.id)).toEqual([b.id]);
  });

  it("rejects an id that could reach outside the folder", async () => {
    await expect(store.get("../../.env.local")).rejects.toThrow(/Bad lesson id/);
    await expect(store.remove("../x")).rejects.toThrow(/Bad lesson id/);
  });

  it("returns null for a lesson that doesn't exist, and an empty list for no folder", async () => {
    expect(await store.get("0123456789abcdef")).toBeNull();
    expect(await new LessonStore(path.join(dir, "nope")).list()).toEqual([]);
  });

  it("summary() tolerates a lesson with no sentences", () => {
    expect(summary({ id: "x", createdAt: "2026-01-01", lesson: { sentences: [] } } as never).title).toBe("");
  });
});
