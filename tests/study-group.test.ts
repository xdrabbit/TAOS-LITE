// Fences for how a flat history becomes conversations on the Study picker.
//
// Two kinds of row reach it. Rows since 20261001_translation_sessions carry a
// session_id, which is the truth written at the moment of speaking. Older
// rows have none and can only be grouped by a gap — a reconstruction. What
// is pinned: the truth is used when present, the reconstruction is kept
// visibly separate, and the two never mix.
import { describe, expect, it } from "vitest";
import { conversationTitle, groupConversations, sideIn, type StudyTurn } from "@/lib/study/group";
import { SESSION_GAP_MS } from "@/lib/translate/session";

const T0 = Date.parse("2026-09-13T20:00:00.000Z");

function turn(id: string, offsetMs: number, session: string | null, es = "hola", en = "hi"): StudyTurn {
  return {
    id,
    created_at: new Date(T0 + offsetMs).toISOString(),
    session_id: session,
    source_lang: "es",
    target_lang: "en",
    original_text: es,
    translation_text: en
  };
}

describe("groupConversations", () => {
  it("groups by session_id when the rows have one", () => {
    const out = groupConversations([turn("a", 0, "S1"), turn("b", 60_000, "S1"), turn("c", 120_000, "S2")]);
    expect(out.map((c) => c.key).sort()).toEqual(["S1", "S2"]);
    expect(out.find((c) => c.key === "S1")?.turns.map((t) => t.id)).toEqual(["a", "b"]);
    expect(out.every((c) => c.reconstructed === false)).toBe(true);
  });

  it("reconstructs rows without a session by the same ten-minute gap, from the LAST turn", () => {
    // Four turns eight minutes apart span 24 minutes but are one conversation,
    // because no two neighbours are more than the gap apart.
    const rows = [0, 1, 2, 3].map((i) => turn(`r${i}`, i * 8 * 60_000, null));
    const out = groupConversations(rows);
    expect(out).toHaveLength(1);
    expect(out[0].reconstructed).toBe(true);
    expect(out[0].key).toBe("gap:r0");
    expect(out[0].turns.map((t) => t.id)).toEqual(["r0", "r1", "r2", "r3"]);
  });

  it("starts a new reconstructed conversation one millisecond past the gap", () => {
    const out = groupConversations([turn("x", 0, null), turn("y", SESSION_GAP_MS + 1, null)]);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.key).sort()).toEqual(["gap:x", "gap:y"]);
  });

  it("never mixes a sessioned row into a reconstructed group, however close in time", () => {
    const out = groupConversations([turn("old", 0, null), turn("new", 1_000, "S1")]);
    expect(out).toHaveLength(2);
    expect(out.find((c) => c.key === "S1")?.turns.map((t) => t.id)).toEqual(["new"]);
    expect(out.find((c) => c.key === "gap:old")?.turns.map((t) => t.id)).toEqual(["old"]);
  });

  it("lists the newest conversation first, and reads each one forwards", () => {
    const out = groupConversations([
      turn("late2", 3_600_000 + 30_000, "LATE"),
      turn("late1", 3_600_000, "LATE"),
      turn("early", 0, "EARLY")
    ]);
    expect(out.map((c) => c.key)).toEqual(["LATE", "EARLY"]);
    expect(out[0].turns.map((t) => t.id)).toEqual(["late1", "late2"]);
    expect(out[0].startedAt).toBe(T0 + 3_600_000);
    expect(out[0].endedAt).toBe(T0 + 3_600_000 + 30_000);
  });

  it("is empty for no rows", () => {
    expect(groupConversations([])).toEqual([]);
  });
});

describe("sideIn / conversationTitle", () => {
  it("returns the side of a turn in the language being learned", () => {
    const t = turn("a", 0, "S", "Voy en camino.", "I'm on my way.");
    expect(sideIn(t, "es")).toBe("Voy en camino.");
    expect(sideIn(t, "en")).toBe("I'm on my way.");
    expect(sideIn(t, "it")).toBeNull();
  });

  it("titles a conversation by its first line, in the learned language", () => {
    const c = groupConversations([turn("a", 0, "S", "Primero", "First"), turn("b", 1_000, "S", "Segundo", "Second")])[0];
    expect(conversationTitle(c, "es")).toBe("Primero");
    expect(conversationTitle(c, "en")).toBe("First");
    // A language the line doesn't have falls back to what was said.
    expect(conversationTitle(c, "it")).toBe("Primero");
  });
});
