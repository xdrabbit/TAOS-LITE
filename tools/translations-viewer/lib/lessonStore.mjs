// Saved lessons: one JSON file per lesson, on this machine only.
//
// A lesson is made from Tom's own history, which includes material he prunes
// from production on purpose, so these files are written 0600 into a
// gitignored folder (local_exports/lessons/) and never leave blackbird.
//
// A lesson is identified by WHAT it was made from — the source records'
// database ids (or, for id-less rows from old exports, their time + text) plus
// the exact selection — not by the viewer's row keys, which are renumbered on
// every load. So re-opening the same message after a restart finds the saved
// lesson instead of paying for a new one.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Stable identity for one source record, across loads and sources. */
export function recordIdentity(r) {
  if (r.id) return `${r.source_table ?? ""}#${r.id}`;
  return `t${r.created_ms ?? r.created_at ?? ""}#${r.original_text ?? ""}#${r.translation_text ?? ""}`;
}

/**
 * The id a lesson is saved under: its sources, its selection and — when they
 * aren't the original default — its languages, hashed. The same message makes
 * a different lesson in each direction (Spanish explained in English is not
 * English explained in Spanish). `langs.isDefault` keeps lessons saved before
 * languages were selectable (non-English side, explained in English) at the
 * id they already have.
 */
export function lessonId(records, selection = "", langs = null) {
  const parts = [records.map(recordIdentity), String(selection).trim()];
  if (langs && !langs.isDefault) parts.push(`${langs.target}>${langs.explain}`);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

const VALID_ID = /^[0-9a-f]{16}$/;

export class LessonStore {
  constructor(dir) {
    this.dir = dir;
  }

  #file(id) {
    if (!VALID_ID.test(String(id))) throw new Error("Bad lesson id.");
    return path.join(this.dir, `${id}.json`);
  }

  async get(id) {
    try {
      return JSON.parse(await readFile(this.#file(id), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  /** Write atomically (temp file + rename) so a crash never leaves half a lesson. */
  async put(saved) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.#file(saved.id);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(saved, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
    return saved;
  }

  /** Merge a few user-editable fields (note, tags). Returns the updated lesson. */
  async update(id, changes) {
    const saved = await this.get(id);
    if (!saved) return null;
    if (typeof changes.note === "string") saved.note = changes.note.slice(0, 5000);
    if (Array.isArray(changes.tags)) {
      saved.tags = [...new Set(changes.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
    }
    saved.updatedAt = new Date().toISOString();
    return this.put(saved);
  }

  /** Record one scored practice attempt on the lesson (newest last, capped). */
  async addAttempt(id, attempt) {
    const saved = await this.get(id);
    if (!saved) return null;
    saved.practice = [...(saved.practice ?? []), attempt].slice(-300);
    return this.put(saved);
  }

  async remove(id) {
    try {
      await unlink(this.#file(id));
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  /** Summaries for the library, newest first. Unreadable files are skipped. */
  async list() {
    let names;
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      const id = name.replace(/\.json$/, "");
      if (!VALID_ID.test(id) || !name.endsWith(".json")) continue;
      try {
        const saved = await this.get(id);
        if (saved) out.push(summary(saved));
      } catch {
        /* a damaged file shouldn't hide the rest */
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

/** What the library list shows for one lesson. */
export function summary(saved) {
  const sentences = saved.lesson?.sentences ?? [];
  return {
    id: saved.id,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt ?? saved.createdAt,
    model: saved.model,
    title: sentences[0]?.target ?? "",
    english: sentences[0]?.english ?? "",
    sentenceCount: sentences.length,
    language: saved.target ?? saved.lesson?.target_language ?? "",
    explain: saved.explain ?? "en",
    note: saved.note ?? "",
    tags: saved.tags ?? [],
    sourceAt: saved.sources?.[0]?.created_at ?? null
  };
}

/** Build the record to save from a fresh generation. */
export function newSavedLesson({ id, lesson, model, records, selection, usage, target = null, explain = "en" }) {
  const now = new Date().toISOString();
  return {
    id,
    version: 1,
    createdAt: now,
    updatedAt: now,
    model,
    target: target ?? lesson?.target_language ?? null,
    explain,
    usage: usage ?? null,
    selection: String(selection ?? "").trim(),
    // Enough to find the message again and to show where the lesson came from,
    // without copying the conversation around it.
    sources: records.map((r) => ({
      identity: recordIdentity(r),
      id: r.id ?? null,
      source_table: r.source_table ?? null,
      created_at: r.created_at ?? null,
      source_lang: r.source_lang ?? null,
      target_lang: r.target_lang ?? null,
      original_text: r.original_text ?? "",
      translation_text: r.translation_text ?? ""
    })),
    note: "",
    tags: [],
    lesson
  };
}
