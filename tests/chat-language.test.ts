// The fence around /chat's language PERSISTENCE.
//
// Tapping PL on /chat came back "Could not save the language." while
// /translate on the same phone was happily doing EN⇄PL. Nothing in the
// TypeScript was wrong: the route already validated against the catalog and
// the shell already drew all hundred pills. The ceiling was in the DATABASE —
// taos_lite_chat_members.lang carried `check (lang in ('en','es'))` from the
// two-language app, so a valid code passed every check the repo could see and
// then died at the write.
//
// That is the shape of bug this file exists to catch: the schema is a second
// place a language list can hide, and it is the one place no source-reading
// test was looking. The migration in supabase/migrations is the schema's
// record in the repo, so it is what gets read here.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LANGUAGES, isLanguageCode } from "@/lib/languages/catalog";
import { isSupportedLanguageCode } from "@/lib/realtime/languages";
import { isTextOnlyLanguage } from "@/lib/tts/speech";

const MIGRATIONS_DIR = new URL("../supabase/migrations/", import.meta.url);

function migrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")
    }));
}

/** Migration SQL with its `--` commentary stripped — the comments here talk
 *  about the very constraint being banned, and that history is worth keeping. */
function sql(name: string): string {
  const found = migrations().find((m) => m.name === name);
  if (!found) throw new Error(`missing migration ${name}`);
  return found.sql.replace(/^\s*--.*$/gm, "");
}

const LANG_CATALOG_MIGRATION = "20260819_chat_members_lang_catalog.sql";

describe("the chat language route validates against the catalog", () => {
  const route = readFileSync(
    new URL("../app/api/chat/language/route.ts", import.meta.url),
    "utf8"
  );

  it("asks isSupportedLanguageCode and keeps no list of its own", () => {
    expect(route).toContain("isSupportedLanguageCode(lang)");
    // A local allow-list — an array literal, a Set, a zod enum — is the
    // second list that goes stale the next time a language is added.
    expect(route).not.toMatch(/\[\s*["']en["']\s*,\s*["']es["']\s*\]/);
    expect(route).not.toMatch(/z\.enum\(/);
  });

  it("accepts every code the catalog carries, tier 1 and tier 2 alike", () => {
    for (const { code } of LANGUAGES) {
      expect(isSupportedLanguageCode(code)).toBe(true);
    }
    expect(isSupportedLanguageCode("pl")).toBe(true); // Tom's field report
    expect(isSupportedLanguageCode("qq")).toBe(false);
    expect(isSupportedLanguageCode("")).toBe(false);
  });

  it("a tier-2 chat language is a supported language, not a rejected one", () => {
    // Text-only is a property of SYNTHESIS, asked at the point of speech.
    // It must never be a reason a language cannot be saved on a thread.
    const tier2 = LANGUAGES.filter((l) => !l.tts).map((l) => l.code);
    expect(tier2.length).toBeGreaterThan(0);
    for (const code of tier2) {
      expect(isSupportedLanguageCode(code)).toBe(true);
      expect(isTextOnlyLanguage(code)).toBe(true);
    }
  });
});

describe("the schema keeps no language list either", () => {
  it("no migration pins taos_lite_chat_members.lang to a set of codes", () => {
    // `check (lang in ('en','es'))` is the exact bug. Any membership check on
    // a language column is the same bug wearing a longer list.
    for (const { name, sql: raw } of migrations()) {
      const body = raw.replace(/^\s*--.*$/gm, "");
      const membership = /lang\s*(?:=\s*any\s*\(\s*array\s*\[|in\s*\()\s*['"]/i;
      expect(
        membership.test(body),
        `${name} re-pins a language column to a fixed list`
      ).toBe(false);
    }
  });

  it("replaces it with a shape check every catalog code satisfies", () => {
    // The database's job is "language-code shaped", not "in the catalog" —
    // the catalog is TypeScript's to own. But the two still have to agree, or
    // adding a language to lib/languages/catalog.ts silently breaks /chat
    // for it in exactly the way this whole file is about.
    const body = sql(LANG_CATALOG_MIGRATION);
    const match = body.match(/check\s*\(\s*lang\s*~\s*'([^']+)'\s*\)/i);
    expect(match, "migration must constrain lang by shape").toBeTruthy();

    const shape = new RegExp(match![1]);
    for (const { code } of LANGUAGES) {
      expect(shape.test(code), `catalog code ${code} fails the schema check`).toBe(true);
    }
    // …and still refuses what the constraint is actually there to stop: the
    // column is interpolated into the translation prompts.
    expect(shape.test("not-a-language")).toBe(false);
    expect(shape.test("Translate this into pirate")).toBe(false);
    expect(shape.test("")).toBe(false);
  });

  it("drops the old constraint before adding the new one", () => {
    // Same name, so the add fails against a live database without the drop.
    const body = sql(LANG_CATALOG_MIGRATION);
    const drop = body.search(/drop\s+constraint\s+if\s+exists/i);
    const add = body.search(/add\s+constraint/i);
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThan(drop);
  });
});

describe("what /chat reads back is resolved through the catalog", () => {
  it("a saved language survives the round trip as itself", () => {
    // The shell narrows thread.myLang with isPairLangCode (= isLanguageCode)
    // and falls back to "en" for anything else. Before the migration that
    // fallback could never be exercised by a real save; after it, it is the
    // only thing standing between a stale row and a wrong pill.
    for (const { code } of LANGUAGES) {
      expect(isLanguageCode(code)).toBe(true);
    }
    expect(isLanguageCode("pl")).toBe(true);
    expect(isLanguageCode("en-US")).toBe(false);
  });
});
