// Fences for the ● Say it control (components/study/SayIt.tsx), read as
// source — it owns a microphone and a MediaRecorder, which jsdom does not have.
//
// What is pinned is the set of ways the button can fail to send anything, and
// that EVERY one of them says so. The first field walk found the one that did
// not: a zero-byte recording returned to idle in silence, which from the phone
// is indistinguishable from a dead button.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../components/study/SayIt.tsx", import.meta.url), "utf8");

describe("every way Say it can send nothing says so", () => {
  it("an empty recording shows a message instead of going quiet", () => {
    expect(src).toContain("if (blob.size === 0)");
    expect(src).toContain("setNote(L.empty)");
    expect(src).toMatch(/empty: "Nothing was recorded/);
    expect(src).toMatch(/empty: "No se grabó nada/);
  });

  it("silence is caught by peak level before Azure is paid", () => {
    expect(src).toContain("converted.peak < SILENCE_PEAK");
    expect(src).toContain("setNote(L.silence)");
  });

  it("a refused or absent microphone says so", () => {
    expect(src).toContain("setNote(L.noMic)");
    expect(src).toContain("setNote(L.denied)");
  });
});

describe("the recorder is stopped the way WebKit needs", () => {
  it("asks for buffered data before stop, so onstop never sees an empty chunk list", () => {
    const req = src.indexOf("recorder.requestData()");
    const stop = src.indexOf("recorder.stop()");
    expect(req).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(req);
  });

  it("an interrupted mic scores what it captured instead of hanging", () => {
    expect(src).toContain("recorder.onerror = () => stop()");
    expect(src).toContain("track.onended = () => stop()");
  });
});

describe("where the audio goes", () => {
  it("posts to the tutor's metered assess route and nowhere else", () => {
    expect(src).toContain('fetch("/api/tutor/assess"');
    expect(src).not.toContain("/api/study/assess");
  });
});
