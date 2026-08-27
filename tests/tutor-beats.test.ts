// The fence around forward motion.
//
// Tom's field report, 2026-08-27: a Walk session took "Buenos días" correctly
// five times, said "Ahora es perfecto. Gracias.", and then asked for it again
// because the learner said "mhm". Every test here is one clause of "that can
// no longer happen", written against the pure state machine so the rule can be
// argued with on a laptop instead of on a phone with a live microphone.
//
// The verbatim scene from the screenshot is the first fixture on purpose.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BEAT_MAX_ATTEMPTS,
  BEAT_MAX_CORRECTIONS,
  RUN_TURNS_PER_CHECKPOINT,
  beatProgress,
  currentBeat,
  deriveBeats,
  initBeatState,
  isAcknowledgment,
  lineMatchScore,
  normalizeSpoken,
  onLearnerTurn,
  onTutorTurn,
  producedLine,
  type BeatState
} from "@/lib/tutor/beats";
import { CRAWL_MAX_ATTEMPTS } from "@/lib/tutor/crawl";
import { getTutorModule } from "@/lib/tutor/modules";
import type { Lesson } from "@/lib/tutor/lesson";

const firstContact = getTutorModule("first-contact")!;

/** Module 1, EN learner → ES: the scene Tom was actually in. */
const lesson: Lesson = {
  moduleId: "first-contact",
  target: "es",
  learner: "en",
  title: "Primer contacto",
  contrastHook: { headline: "h", explanation: "e", sameAsLearner: true },
  phrases: [
    { move: "greet", target: "Buenos días", meaning: "Good morning" },
    { move: "yes", target: "Sí", meaning: "Yes" },
    { move: "please", target: "Por favor", meaning: "Please" },
    { move: "thank", target: "Gracias", meaning: "Thank you" }
  ],
  pronunciation: [{ slot: "greet_phrase", phrase: "Buenos días" }],
  roleplay: {
    setting: "una tienda pequeña",
    tutorRole: "el tendero",
    learnerRole: "el cliente",
    opening: { cue: "entras", target: "¡Hola, buenos días! ¿En qué le puedo ayudar?", meaning: "Hello, good morning!" },
    learnerLines: [
      { cue: "te saluda", target: "Buenos días", meaning: "Good morning" },
      { cue: "te pregunta qué necesitas", target: "Necesito agua, por favor", meaning: "I need water, please" },
      { cue: "te lo da", target: "Gracias", meaning: "Thank you" }
    ]
  },
  runGoal: "Sobrevivir un primer intercambio."
};

function walkState(): BeatState {
  return initBeatState({ phase: "walk", lesson, module: firstContact });
}

/** Get past the tutor's opening line to the first line the learner owns. */
function opened(): BeatState {
  return onTutorTurn(walkState(), "¡Hola, buenos días! ¿En qué le puedo ayudar?").state;
}

describe("the scene, as an ordered list", () => {
  it("is the tutor's opening, then each learner line, then the close", () => {
    const beats = deriveBeats({ phase: "walk", lesson, module: firstContact });
    expect(beats.map((b) => b.kind)).toEqual(["opening", "line", "line", "line", "close"]);
    expect(beats[1].target).toBe("Buenos días");
    expect(beats[3].target).toBe("Gracias");
  });

  it("falls back to the module's moves when Walk has no cached lesson", () => {
    // The realtime route answers `lessonAvailable: false` when the server has
    // no cached lesson. A loose scene that moves beats a strict one that
    // cannot be held at all.
    const beats = deriveBeats({ phase: "walk", module: firstContact });
    expect(beats.length).toBeGreaterThan(1);
    expect(beats.every((b) => b.kind === "checkpoint" || b.kind === "close")).toBe(true);
  });

  it("counts only the beats the learner owns", () => {
    // The opening and the close are the tutor's lines. "0 of 5" on a scene
    // with three learner lines would be the screen counting work nobody has
    // to do.
    expect(beatProgress(walkState())).toEqual({ done: 0, total: 3 });
  });
});

describe("advancing on what the learner actually said", () => {
  it("moves to the next line when the target line lands", () => {
    const before = opened();
    expect(currentBeat(before)?.target).toBe("Buenos días");

    const after = onLearnerTurn(before, "Buenos días");
    expect(after.action).toBe("advanced");
    expect(currentBeat(after.state)?.target).toBe("Necesito agua, por favor");
    expect(after.state.produced).toEqual(["Buenos días"]);
    expect(after.directive).toBeTruthy();
  });

  it("is fuzzy: a recognizer that drops an accent has still heard the line", () => {
    const after = onLearnerTurn(opened(), "buenos dias");
    expect(after.action).toBe("advanced");
  });

  it("accepts the line inside a longer sentence", () => {
    // Coverage of the target, not similarity of the two strings — a learner
    // who says more than the line has still said the line.
    const after = onLearnerTurn(opened(), "Ah, sí, buenos días señor, ¿cómo está?");
    expect(after.action).toBe("advanced");
  });

  it("does not advance on something else entirely", () => {
    const after = onLearnerTurn(opened(), "I have absolutely no idea what to say");
    expect(after.action).toBe("attempt");
    expect(after.state.attempts).toBe(1);
    expect(after.directive).toBeUndefined();
  });

  it("never re-drills a line it has already taken", () => {
    // The whole bug in one assertion: five correct "Buenos días" in a row can
    // only ever consume ONE beat, and the scene is somewhere else by the
    // second one.
    let state = opened();
    for (let i = 0; i < 5; i += 1) state = onLearnerTurn(state, "Buenos días").state;
    expect(state.produced).toEqual(["Buenos días"]);
    expect(currentBeat(state)?.target).not.toBe("Buenos días");
  });
});

describe("Liz's mercy law, in the roleplay too", () => {
  it("is the same number Crawl uses", () => {
    // One constant family. Nobody tunes the drill loose and leaves the
    // roleplay tight.
    expect(BEAT_MAX_ATTEMPTS).toBe(CRAWL_MAX_ATTEMPTS);
  });

  it("moves on after three failed attempts at one line", () => {
    let state = opened();
    const first = onLearnerTurn(state, "um, something wrong");
    expect(first.action).toBe("attempt");
    state = first.state;
    const second = onLearnerTurn(state, "still wrong, sorry");
    expect(second.action).toBe("attempt");
    state = second.state;

    const third = onLearnerTurn(state, "wrong a third time");
    expect(third.action).toBe("mercy-advanced");
    expect(currentBeat(third.state)?.target).toBe("Necesito agua, por favor");
    // Moved past, but NOT recorded as produced: the learner did not say it,
    // and telling the model they did would be a lie the scene is built on.
    expect(third.state.produced).toEqual([]);
    expect(third.directive).toContain("CURRENT BEAT");
  });

  it("closes the line it moved past, without claiming the learner said it", () => {
    // Found in the live run, 2026-08-27: after a mercy advance the model kept
    // drilling the missed line, and the correction path was blind to it
    // because it only watched lines the learner HAD produced. The learner who
    // cannot say a phrase is the one most likely to be trapped by it.
    let state = opened();
    for (const miss of ["nope", "still nope", "sorry, no"]) {
      state = onLearnerTurn(state, miss).state;
    }
    expect(state.left).toEqual(["Buenos días"]);
    expect(state.produced).toEqual([]);

    const directive = onLearnerTurn(state, "erm").state;
    const drift = onTutorTurn(directive, "Repita conmigo: Buenos días.");
    expect(drift.action).toBe("corrected");
    expect(drift.directive).toContain("MOVED PAST");
    // And it does not tell the model a lie it would hear in its own next line.
    expect(drift.directive).not.toContain('ALREADY produced these lines and they are FINISHED — never ask for any of them again, not to check, not to polish, not to confirm: "Buenos días"');
  });

  it("resets the count for the next beat", () => {
    let state = opened();
    state = onLearnerTurn(state, "wrong").state;
    expect(state.attempts).toBe(1);
    state = onLearnerTurn(state, "Buenos días").state;
    expect(state.attempts).toBe(0);
  });
});

describe("an acknowledgment is not a restart", () => {
  it("recognises the small sounds", () => {
    for (const ack of ["mhm", "Mhm.", "ok", "okay", "sí", "si", "uh huh", "yeah", "claro", "嗯"]) {
      expect(isAcknowledgment(ack), ack).toBe(true);
    }
  });

  it("does not swallow a real turn", () => {
    for (const real of [
      "Necesito agua, por favor",
      "sí, necesito una aspirina para el dolor",
      "no entiendo nada"
    ]) {
      expect(isAcknowledgment(real), real).toBe(false);
    }
  });

  it("continues: it costs no attempt, moves nothing, and resets nothing", () => {
    // This is the exact turn that sent the field session back to the top.
    let state = opened();
    state = onLearnerTurn(state, "Buenos días").state;
    const before = state;

    const ack = onLearnerTurn(state, "mhm");
    expect(ack.action).toBe("acknowledged");
    expect(ack.state.index).toBe(before.index);
    expect(ack.state.attempts).toBe(0);
    expect(ack.state.produced).toEqual(["Buenos días"]);
    // Nothing moved, so nothing is pushed into the live session.
    expect(ack.directive).toBeUndefined();
  });

  it("still advances when the target line IS an acknowledgment word", () => {
    // Module 1 teaches "yes". A scene whose next line is "Sí" must take "Sí"
    // as the line and not as a nod — which is why the machine tests the
    // current target BEFORE it tests for acknowledgments.
    const yesLesson: Lesson = {
      ...lesson,
      roleplay: {
        ...lesson.roleplay,
        learnerLines: [{ cue: "te pregunta", target: "Sí", meaning: "Yes" }]
      }
    };
    const state = onTutorTurn(
      initBeatState({ phase: "walk", lesson: yesLesson, module: firstContact }),
      "¿Quiere una bolsa?"
    ).state;
    expect(onLearnerTurn(state, "Sí").action).toBe("scene-complete");
  });
});

describe("when the tutor drifts anyway", () => {
  it("takes the tutor's opening line as the opening beat", () => {
    const t = onTutorTurn(walkState(), "¡Hola, buenos días! ¿En qué le puedo ayudar?");
    expect(t.action).toBe("advanced");
    expect(currentBeat(t.state)?.kind).toBe("line");
  });

  it("corrects a re-request for a finished line", () => {
    let state = onLearnerTurn(opened(), "Buenos días").state;
    // The learner is working on the next line…
    state = onLearnerTurn(state, "erm").state;
    expect(state.attempts).toBe(1);

    const drift = onTutorTurn(state, "Muy bien. Ahora dígame otra vez: Buenos días.");
    expect(drift.action).toBe("corrected");
    expect(drift.directive).toContain("Buenos días");
    expect(drift.directive).toContain("That beat is done");
  });

  it("stops asking and moves the position itself after two corrections", () => {
    let state = onLearnerTurn(opened(), "Buenos días").state;
    state = onLearnerTurn(state, "erm").state;
    const redrill = "Otra vez, por favor: Buenos días.";

    for (let i = 0; i < BEAT_MAX_CORRECTIONS; i += 1) {
      const t = onTutorTurn(state, redrill);
      expect(t.action).toBe("corrected");
      state = t.state;
    }
    const forced = onTutorTurn(state, redrill);
    expect(forced.action).toBe("force-advanced");
    expect(currentBeat(forced.state)?.target).toBe("Gracias");
  });

  it("does not skip a line the learner has not tried yet", () => {
    // A tutor echoing a finished line as praise ("¡Perfecto! Buenos días.")
    // looks exactly like one re-drilling it. Skipping an untried line would be
    // a worse bug than the loop, so the force-advance waits for an attempt.
    let state = onLearnerTurn(opened(), "Buenos días").state;
    const praise = "¡Perfecto! Buenos días. Muy bien dicho.";
    for (let i = 0; i < 5; i += 1) {
      const t = onTutorTurn(state, praise);
      expect(t.action).toBe("corrected");
      state = t.state;
    }
    expect(currentBeat(state)?.target).toBe("Necesito agua, por favor");
  });

  it("says nothing at all about an ordinary in-character turn", () => {
    const state = onLearnerTurn(opened(), "Buenos días").state;
    const t = onTutorTurn(state, "¿Y qué necesita usted hoy?");
    expect(t.action).toBe("none");
    expect(t.directive).toBeUndefined();
  });
});

describe("the scene ends", () => {
  it("completes after the last line and asks for a close, not a restart", () => {
    let state = opened();
    state = onLearnerTurn(state, "Buenos días").state;
    state = onLearnerTurn(state, "Necesito agua, por favor").state;
    const last = onLearnerTurn(state, "Gracias");

    expect(last.action).toBe("scene-complete");
    expect(last.state.done).toBe(true);
    expect(beatProgress(last.state)).toEqual({ done: 3, total: 3 });
    expect(last.directive).toContain("Close now");
    expect(last.directive).toContain("Do not start the scene again");
  });

  it("goes quiet once it is done", () => {
    let state = opened();
    for (const line of ["Buenos días", "Necesito agua, por favor", "Gracias"]) {
      state = onLearnerTurn(state, line).state;
    }
    expect(onLearnerTurn(state, "adiós").action).toBe("none");
    expect(onTutorTurn(state, "Buenos días").action).toBe("none");
  });
});

describe("Run — checkpoints, not lines", () => {
  const runState = () => initBeatState({ phase: "run", lesson, module: firstContact });

  it("builds topic checkpoints from the module's core moves", () => {
    const beats = deriveBeats({ phase: "run", lesson, module: firstContact });
    expect(beats.filter((b) => b.kind === "checkpoint").length).toBeGreaterThan(1);
    expect(beats.some((b) => b.kind === "line")).toBe(false);
    expect(beats.at(-1)?.kind).toBe("close");
  });

  it("never demands a phrase verbatim — a checkpoint is covered by talking", () => {
    // Free conversation collapsing into a drill is Run's version of the Walk
    // loop, so a checkpoint moves on after a couple of real turns whatever the
    // learner said.
    expect(RUN_TURNS_PER_CHECKPOINT).toBeLessThan(BEAT_MAX_ATTEMPTS);
    let state = runState();
    const first = currentBeat(state);
    state = onLearnerTurn(state, "Pues, hoy fui al mercado y compré fruta").state;
    const second = onLearnerTurn(state, "Después caminé por el centro un rato");
    expect(second.action).toBe("advanced");
    expect(currentBeat(second.state)?.id).not.toBe(first?.id);
  });

  it("takes an acknowledgment as continue here too", () => {
    const state = runState();
    expect(onLearnerTurn(state, "mhm").action).toBe("acknowledged");
  });
});

describe("matching what a recognizer hands back", () => {
  it("normalizes case, punctuation and Latin accents", () => {
    expect(normalizeSpoken("¡Buenos DÍAS!")).toBe("buenos dias");
  });

  it("leaves meaning-bearing marks in other scripts alone", () => {
    // Devanagari matras and Arabic harakat live outside the combining block
    // that gets stripped. Flattening them would turn different words into the
    // same word.
    expect(normalizeSpoken("मुझे पानी चाहिए")).toBe("मुझे पानी चाहिए");
  });

  it("scores partial lines partially", () => {
    expect(lineMatchScore("necesito agua", "Necesito agua, por favor")).toBeCloseTo(0.5, 1);
    expect(producedLine("necesito agua", "Necesito agua, por favor")).toBe(false);
    expect(producedLine("necesito agua por favor", "Necesito agua, por favor")).toBe(true);
  });

  it("handles a script the recognizer returns without spaces", () => {
    expect(producedLine("你好，我需要水", "我需要水")).toBe(true);
    expect(producedLine("我不知道", "我需要水")).toBe(false);
  });

  it("is not fooled by silence", () => {
    expect(producedLine("", "Buenos días")).toBe(false);
    expect(lineMatchScore("Buenos días", "")).toBe(0);
  });
});

describe("the machine is actually wired to the session", () => {
  // Source-reading, like tests/screen-language-wiring.test.ts, and for the
  // same reason: a state machine nothing calls is a very well-tested no-op,
  // and that failure is invisible to every test above.
  function code(path: string): string {
    return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  }

  it("the client drives it from both sides of the conversation", () => {
    const shell = code("components/tutor/ModulesShell.tsx");
    expect(shell).toContain("onLearnerTurn(beatRef.current, t)");
    expect(shell).toContain("onTutorTurn(beatRef.current, text)");
    expect(shell).toContain("setScriptState(next.directive)");
  });

  it("shelves a skipped line the same way Crawl shelves a capped phrase", () => {
    const shell = code("components/tutor/ModulesShell.tsx");
    expect(shell).toContain("next.state.left.slice(before.left.length)");
    expect(shell).toContain("onSkipped={(line) => recordAttempt(null, line)}");
  });

  it("the position rides along with the persona on every session.update", () => {
    // session.update REPLACES the instructions. Sending the script position
    // without the persona would strip the tutor's character for the rest of
    // the call — the same shape as the bare-response.create scar in
    // tests/tutor-instructions.test.ts.
    const conv = code("lib/tutor/conversation.ts");
    expect(conv).toMatch(/const instructions = \[\s*baseInstructions,\s*scriptState,/);
  });

  it("moves the scene with session.update and never a second response", () => {
    // With server VAD the model is already answering the turn that triggered
    // the advance; a response.create here would either error as an active
    // response or talk over the learner.
    const conv = code("lib/tutor/conversation.ts");
    expect(conv.match(/type:\s*"response\.create"/g) ?? []).toHaveLength(1);
  });
});
