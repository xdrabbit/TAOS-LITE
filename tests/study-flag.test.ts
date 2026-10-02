// A disabled feature must cost nothing.
//
// Study is gated to everyone until NEXT_PUBLIC_ENABLE_STUDY is set
// (lib/release.ts): the screen redirects home and every Study API answers 404
// rather than spending on an OpenAI completion. This is the same fence
// tests/tutor-flag.test.ts holds over app/api/tutor, for the same reason: a
// new route that forgets the line is a live billing endpoint behind a flag
// everyone believes is off. The check enumerates the directory rather than a
// list someone has to remember to update.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const API_DIR = new URL("../app/api/study/", import.meta.url);
const PAGE = new URL("../app/study/page.tsx", import.meta.url);

function routeFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(API_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(`${entry.name}/route.ts`);
  }
  return out;
}

describe("every Study route is behind the flag", () => {
  it("finds the routes at all (a rename must fail loudly, not vacuously pass)", () => {
    expect(routeFiles()).toContain("lesson/route.ts");
  });

  it("checks studyEnabled() before doing anything expensive", () => {
    for (const file of routeFiles()) {
      const src = readFileSync(new URL(file, API_DIR), "utf8");
      expect(src, file).toContain("studyEnabled");
      expect(src, file).toContain("{ status: 404 }");
    }
  });

  it("guards the spending routes with a session too", () => {
    // The 404 is the flag; the guard is what stands there once the flag is on.
    for (const file of routeFiles()) {
      const src = readFileSync(new URL(file, API_DIR), "utf8");
      expect(src, file).toContain("guardSpend");
    }
  });

  it("never trusts text from the browser", () => {
    // The client sends row ids; the server reads the rows from the table it
    // trusts, scoped to the signed-in user. A lesson built from text the phone
    // typed in — or from another person's rows — is the thing this prevents.
    const src = readFileSync(new URL("lesson/route.ts", API_DIR), "utf8");
    expect(src).toContain("readOwnSources(user.id");
    expect(src).not.toMatch(/original_text:\s*body\./);
  });

  it("keeps Study off the tutor's flag", () => {
    // Study is deliberately not the tutor (ENHANCEMENTS.md): /tutor is held
    // back because it is unfinished, and a finished Study screen must not
    // inherit that gate.
    for (const file of routeFiles()) {
      const src = readFileSync(new URL(file, API_DIR), "utf8");
      expect(src, file).not.toContain("tutorEnabled");
    }
    expect(readFileSync(PAGE, "utf8")).not.toContain("tutorEnabled");
  });
});

describe("the Study page", () => {
  it("redirects home while the flag is off, and hides its title", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toContain("studyEnabled");
    expect(src).toContain('redirect("/")');
    expect(src).toContain('export const dynamic = "force-dynamic"');
    expect(src).toContain("if (!studyEnabled()) return {};");
  });
});
