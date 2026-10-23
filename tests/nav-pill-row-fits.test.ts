// Tom, 10/23, on his iPhone: the founder's five pills (Translate · Live ·
// Table · Chat · Call) wrapped Call onto a second line. Measured in headless
// Chrome at 375px, the Spanish row needed 345.7px of a 343px line at px-3 /
// gap-2; at px-2 / gap-1.5 it needs 298.3px, and English 270.3px.
//
// This pins the class tokens that bought that room. It is not a layout test —
// CI has no layout. Re-measure in a browser if the row changes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function nav(): string {
  const source = readFileSync(new URL("../components/TranslatorShell.tsx", import.meta.url), "utf8");
  const header = source.slice(source.indexOf("<header"), source.indexOf("</header>"));
  return header.slice(header.indexOf("<nav"), header.indexOf("</nav>"));
}

describe("the founder pill row fits one line on a 375px phone", () => {
  it("spaces the pills with gap-1.5, not gap-2", () => {
    expect(nav()).toMatch(/<nav aria-label=\{nav\.navScreens\} className="[^"]*\bgap-1\.5\b[^"]*"/);
  });

  it("gives every pill px-2, nowrap and a 44px minimum width", () => {
    const pills = nav().match(/className="[^"]*rounded-full border border-amber-300\/30[^"]*"/g) ?? [];
    expect(pills.length).toBeGreaterThanOrEqual(5);
    for (const pill of pills) {
      expect(pill).toMatch(/\bpx-2\b/);
      expect(pill).not.toMatch(/\bpx-3\b/);
      expect(pill).toContain("whitespace-nowrap");
      expect(pill).toContain("min-w-[44px]");
      expect(pill).toContain("justify-center");
      expect(pill).toContain("text-xs");
    }
  });
});
