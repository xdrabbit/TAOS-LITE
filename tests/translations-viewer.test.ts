// Fences for the local translations viewer (tools/translations-viewer).
//
// What is pinned here is the *search contract*, because it is the part a user
// can get silently wrong results from:
//   - a plain search box is not FTS5 syntax, and must never become a syntax
//     error just because someone typed an apostrophe, a hyphen or "¿";
//   - a hyphenated word has to match, which means it becomes a PHRASE, not a
//     single glued token — FTS5 split it on the way in;
//   - the "To" date is inclusive of the whole local day, which is what a human
//     typing a date into a box means by it.
// The FTS5 integration block only runs where the SQLite WASM build has been
// vendored (first local run fetches it); CI stays offline and runs the rest.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildMatchQuery,
  parseDateBound,
  TranslationIndex
} from "@/tools/translations-viewer/lib/index-db.mjs";
import {
  fromChatRow,
  fromTranslationRow,
  parseExport,
  dedupe,
  summarise
} from "@/tools/translations-viewer/lib/records.mjs";

const VENDORED = existsSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "tools",
    "translations-viewer",
    "vendor",
    "dist",
    "node.mjs"
  )
);

describe("buildMatchQuery", () => {
  it("ANDs bare words as whole-word terms", () => {
    expect(buildMatchQuery("how much")).toBe('"how" AND "much"');
  });

  it("keeps a quoted phrase as one phrase", () => {
    expect(buildMatchQuery('"on my way"')).toBe('"on my way"');
  });

  it("passes OR / NEAR through as operators", () => {
    expect(buildMatchQuery("doctor OR hospital")).toBe('"doctor" OR "hospital"');
    expect(buildMatchQuery("gracias AND por")).toBe('"gracias" AND "por"');
  });

  it("keeps a trailing star as a prefix search", () => {
    expect(buildMatchQuery("ayud*")).toBe('"ayud"*');
  });

  it("turns a hyphenated word into a phrase, not a glued token", () => {
    // FTS5 tokenised "well-being" as two tokens, so only a phrase matches it.
    expect(buildMatchQuery("well-being")).toBe('"well being"');
  });

  it("never lets punctuation become FTS5 syntax", () => {
    expect(buildMatchQuery("(hello)")).toBe('"hello"');
    expect(buildMatchQuery("cost: 5")).toBe('"cost" AND "5"');
    expect(buildMatchQuery("a^b")).toBe('"a b"');
  });

  it("returns null when there is nothing to match on", () => {
    expect(buildMatchQuery("")).toBeNull();
    expect(buildMatchQuery("   ")).toBeNull();
    expect(buildMatchQuery(null)).toBeNull();
    expect(buildMatchQuery("-")).toBeNull();
    // A query that is only operators would be a syntax error, not a search.
    expect(buildMatchQuery("OR OR")).toBeNull();
    expect(buildMatchQuery("AND camino")).toBe('"camino"');
  });

  it("hands raw mode straight to FTS5", () => {
    expect(buildMatchQuery("NEAR(a b, 5)", { raw: true })).toBe("NEAR(a b, 5)");
  });
});

describe("parseDateBound", () => {
  it("reads a bare date as a local day", () => {
    const from = parseDateBound("2026-09-01");
    expect(new Date(from as number).getHours()).toBe(0);
    expect(new Date(from as number).getDate()).toBe(1);
  });

  it("makes the To bound inclusive of the whole day", () => {
    const to = parseDateBound("2026-09-01", { endOfDay: true });
    const end = new Date(to as number);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    // A row at 22:00 local on the 1st must fall inside the range.
    expect(new Date(2026, 8, 1, 22, 0, 0).getTime()).toBeLessThan(to as number);
  });

  it("is null for an empty or unparsable box", () => {
    expect(parseDateBound("")).toBeNull();
    expect(parseDateBound("not a date")).toBeNull();
  });
});

describe("parseExport", () => {
  const manifestLine = JSON.stringify({
    record_type: "export_manifest",
    format: "ndjson"
  });
  const translationLine = JSON.stringify({
    record: {
      id: "t1",
      user_id: "u1",
      created_at: "2026-08-18T14:13:41.781011+00:00",
      source_lang: "es",
      target_lang: "en",
      tone: "detailed",
      original_text: "Voy en camino.",
      translation_text: "I'm on my way.",
      engine: "elevenlabs",
      fast_sealed_at: null
    },
    source_table: "public.taos_lite_translations"
  });
  const chatLine = JSON.stringify({
    record: {
      id: "c1",
      thread_id: "th1",
      sender_id: "u2",
      body: "hola",
      body_translated: "hello",
      source_lang: "es",
      target_lang: "en",
      created_at: "2026-09-08T14:23:19.120066+00:00",
      kind: "text"
    },
    source_table: "public.taos_lite_chat_messages"
  });

  it("reads the NDJSON export shape, manifest and both tables", () => {
    const parsed = parseExport([manifestLine, translationLine, chatLine].join("\n"));
    expect(parsed.manifest).toMatchObject({ record_type: "export_manifest" });
    expect(parsed.records).toHaveLength(2);
    expect(parsed.skipped).toHaveLength(0);
    // A chat message maps body/body_translated onto the same two text columns.
    expect(parsed.records[1].original_text).toBe("hola");
    expect(parsed.records[1].translation_text).toBe("hello");
    expect(parsed.records[1].user_id).toBe("u2");
  });

  it("skips an unparsable line instead of losing the whole file", () => {
    const parsed = parseExport([translationLine, "{not json", chatLine].join("\n"));
    expect(parsed.records).toHaveLength(2);
    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.skipped[0].line).toBe(2);
  });

  it("round-trips the viewer's own JSON export", () => {
    const records = parseExport([translationLine].join("\n")).records;
    const reparsed = parseExport(JSON.stringify({ manifest: null, records }));
    expect(reparsed.records).toEqual(records);
  });

  it("reads a bare JSON array", () => {
    const parsed = parseExport(
      JSON.stringify([
        { id: "x", created_at: "2026-09-01T00:00:00Z", original_text: "a", translation_text: "b" }
      ])
    );
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].created_ms).toBe(Date.parse("2026-09-01T00:00:00Z"));
  });

  it("reads a dashboard CSV: quoted commas, doubled quotes, newlines, empty = null", () => {
    const csv = [
      "﻿id,user_id,created_at,source_lang,target_lang,tone,original_text,translation_text,engine",
      't1,u1,2026-09-09 14:00:00+00,es,en,,"Hola, ¿cómo estás?","He said ""hi""\nthen left",openai',
      "t2,u2,2026-09-10 01:00:00+00,en,es,casual,Thanks,Gracias,"
    ].join("\r\n");
    const parsed = parseExport(csv);
    expect(parsed.skipped).toHaveLength(0);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0].original_text).toBe("Hola, ¿cómo estás?");
    expect(parsed.records[0].translation_text).toBe('He said "hi"\nthen left');
    expect(parsed.records[0].tone).toBeNull();
    expect(parsed.records[1].engine).toBeNull();
    expect(parsed.records[0].created_ms).toBe(Date.parse("2026-09-09T14:00:00Z"));
  });

  it("skips a CSV row with the wrong field count", () => {
    const parsed = parseExport("id,original_text,translation_text\na,b,c\nbroken,row\nd,e,f");
    expect(parsed.records).toHaveLength(2);
    expect(parsed.skipped).toEqual([{ line: 3, reason: "expected 3 fields, got 2" }]);
  });
});

describe("dedupe", () => {
  const row = (over: Record<string, unknown>) =>
    fromTranslationRow({
      id: "t1",
      user_id: "u1",
      created_at: "2026-08-18T14:13:41.781011+00:00",
      original_text: "Voy en camino.",
      translation_text: "I'm on my way.",
      ...over
    });

  it("keeps the first copy of an id, so live beats an old export", () => {
    const live = [row({ engine: "elevenlabs" })];
    const old = [row({ engine: null }), row({ id: "t2", original_text: "otra" })];
    const { records, duplicates } = dedupe([live, old]);
    expect(duplicates).toBe(1);
    expect(records.map((r) => r.id)).toEqual(["t1", "t2"]);
    expect(records[0].engine).toBe("elevenlabs");
  });

  it("drops an id-less copy of a kept record, even when the id-less set comes first", () => {
    // Same moment printed two ways: micro- vs milliseconds, T vs space.
    const idless = [row({ id: null, user_id: null, created_at: "2026-08-18 14:13:41.781+00" })];
    const full = [row({})];
    const { records, duplicates } = dedupe([idless, full]);
    expect(duplicates).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("t1");
  });

  it("keeps different records that happen to share text", () => {
    const { records, duplicates } = dedupe([
      [row({ id: null }), row({ id: null, created_at: "2026-08-19T00:00:00Z" })]
    ]);
    expect(duplicates).toBe(0);
    expect(records).toHaveLength(2);
  });
});

describe("summarise", () => {
  it("counts users, languages and the date span", () => {
    const summary = summarise([
      fromTranslationRow({
        id: "a",
        user_id: "u1",
        created_at: "2026-08-18T00:00:00Z",
        source_lang: "es",
        target_lang: "en",
        tone: "detailed",
        original_text: "hola",
        translation_text: "hi",
        engine: "elevenlabs"
      }),
      fromChatRow({
        id: "b",
        sender_id: "u1",
        created_at: "2026-09-08T00:00:00Z",
        source_lang: "es",
        target_lang: "en",
        body: "adiós",
        body_translated: "bye"
      })
    ]);
    expect(summary.total).toBe(2);
    expect(summary.users).toBe(1);
    expect(summary.firstAt).toBe("2026-08-18T00:00:00.000Z");
    expect(summary.lastAt).toBe("2026-09-08T00:00:00.000Z");
    expect(summary.sourceLangs).toEqual([{ value: "es", count: 2 }]);
    expect(summary.tables).toHaveLength(2);
  });
});

describe.skipIf(!VENDORED)("FTS5 index", () => {
  const records = [
    fromTranslationRow({
      id: "a",
      user_id: "u1",
      created_at: "2026-08-18T14:13:41Z",
      source_lang: "es",
      target_lang: "en",
      tone: "detailed",
      original_text: "Voy en camino.",
      translation_text: "I'm on my way.",
      engine: "elevenlabs"
    }),
    fromTranslationRow({
      id: "b",
      user_id: "u2",
      created_at: "2026-09-10T09:00:00Z",
      source_lang: "en",
      target_lang: "es",
      tone: "casual",
      original_text: "Say goodbye to the dog",
      translation_text: "Dile adiós al perro",
      engine: "openai"
    })
  ];

  async function index() {
    return TranslationIndex.build({ records, source: { kind: "test" } });
  }

  it("matches ignoring accents and case", async () => {
    const db = await index();
    try {
      // "adios" must find "adiós" — remove_diacritics 2 is why.
      const hit = db.search({ match: buildMatchQuery("ADIOS") });
      expect(hit.total).toBe(1);
      expect(hit.rows[0].id).toBe("b");
    } finally {
      db.close();
    }
  });

  it("marks hits with control characters, never with HTML", async () => {
    const db = await index();
    try {
      const { rows } = db.search({ match: buildMatchQuery("camino") });
      // The client escapes the snippet before swapping these for <mark>, so a
      // user who types "<script>" can never have it rendered as a tag.
      expect(rows[0].original_snippet).toContain("camino");
      expect(rows[0].original_snippet).not.toContain("<mark>");
    } finally {
      db.close();
    }
  });

  it("filters by date range without a text query", async () => {
    const db = await index();
    try {
      const { total, rows } = db.search({
        fromMs: Date.parse("2026-09-01T00:00:00Z"),
        toMs: Date.parse("2026-09-30T23:59:59Z")
      });
      expect(total).toBe(1);
      expect(rows[0].id).toBe("b");
    } finally {
      db.close();
    }
  });

  it("combines a text match with a date range", async () => {
    const db = await index();
    try {
      const inRange = db.search({
        match: buildMatchQuery("camino"),
        fromMs: Date.parse("2026-08-01T00:00:00Z")
      });
      expect(inRange.total).toBe(1);

      const outOfRange = db.search({
        match: buildMatchQuery("camino"),
        fromMs: Date.parse("2026-09-01T00:00:00Z")
      });
      expect(outOfRange.total).toBe(0);
    } finally {
      db.close();
    }
  });

  it("searches the translation column, not just the original", async () => {
    const db = await index();
    try {
      expect(db.search({ match: buildMatchQuery("perro") }).total).toBe(1);
    } finally {
      db.close();
    }
  });

  it("exports every matching record with no snippet columns", async () => {
    const db = await index();
    try {
      const exported = db.all({ match: buildMatchQuery("camino") });
      expect(exported).toHaveLength(1);
      expect(exported[0]).not.toHaveProperty("original_snippet");
      expect(exported[0].original_text).toBe("Voy en camino.");
      // Unfiltered export is the whole set.
      expect(db.all()).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
