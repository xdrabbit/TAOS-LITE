// What one Interpreter-mode session IS, per engine: how many legs, which
// direction and voice each has, and whether it carries the briefing. Pure and
// isomorphic — the mint route builds a plan and turns each leg into a provider
// session; the tests read the same plan.

import {
  buildInterpreterBriefing,
  buildLegBriefing,
  SILENCE_TOKEN,
  type InterpreterDirection,
  type InterpreterPair
} from "./briefing";
import { DEFAULT_INTERPRETER_STYLE, isMediatorStyle, type InterpreterStyle } from "./mediator";
import {
  engineIntroduces,
  engineTakesBriefing,
  interpreterLegCount,
  interpreterModel,
  interpreterVoice,
  pairDirections,
  type InterpreterEngine
} from "./engine";

export interface LegPlan {
  /**
   * The direction this leg interprets. `null` = one session both ways
   * (TAOS_INTERPRETER_LEGS=1): it hears both people and answers each in the
   * other's language, and its captions have no side.
   */
  direction: InterpreterDirection | null;
  /** The stock voice it speaks in. Null where the engine takes none. */
  voice: string | null;
  /** The briefing it is given. Null where the engine takes none. */
  instructions: string | null;
}

export interface InterpreterPlan {
  engine: InterpreterEngine;
  model: string;
  pair: InterpreterPair;
  legs: LegPlan[];
  /** Did the provider session get the briefing at all? */
  briefed: boolean;
  /**
   * The style the briefing was ACTUALLY written in. "mediator" only when it
   * was asked for and the engine takes a briefing — an engine that cannot be
   * briefed cannot be a mediator, and the screen is told so.
   */
  style: InterpreterStyle;
  /**
   * The leg that introduces the mediator when the screen cues it at session
   * start — the ONLY leg whose briefing carries the introduction. Null for
   * the interpreter style and for an engine that cannot be cued.
   *
   * On a two-leg table it is the leg that speaks the phone owner's language
   * (target = pair.a): it gives the introduction the way it gives any note —
   * its own language first, then the other — so the person who pressed Start
   * hears at once that the mediator is there, and the other leg stays quiet.
   */
  introLeg: number | null;
}

export function buildInterpreterPlan(opts: {
  engine: InterpreterEngine;
  pair: InterpreterPair;
  /** The founders' context block, already loaded. "" = none. */
  context: string;
  /** What the founder's device asked for. Absent = the interpreter. */
  style?: InterpreterStyle;
  env?: Record<string, string | undefined>;
}): InterpreterPlan {
  const env = opts.env ?? process.env;
  const { engine, pair, context } = opts;
  const model = interpreterModel(engine, env);
  const briefed = engineTakesBriefing(engine);
  const style: InterpreterStyle = briefed ? (opts.style ?? DEFAULT_INTERPRETER_STYLE) : DEFAULT_INTERPRETER_STYLE;
  const liveModel = engine === "openai-live";
  const directions = pairDirections(pair);
  // A cascade cannot say nothing; its quiet leg is given a word for it
  // (lib/interpreter/briefing.ts, SILENCE_TOKEN).
  const silenceToken = engine === "elevenlabs-realtime" ? SILENCE_TOKEN : undefined;
  const introduces = briefed && isMediatorStyle(style) && engineIntroduces(engine);

  if (interpreterLegCount(engine, env.TAOS_INTERPRETER_LEGS) === 1) {
    return {
      engine,
      model,
      pair,
      briefed,
      style,
      introLeg: introduces ? 0 : null,
      legs: [
        {
          direction: null,
          // One session has one voice: voice 1's.
          voice: interpreterVoice(engine, directions[0], env),
          instructions: buildInterpreterBriefing({ pair, context, liveModel, style, silenceToken, intro: introduces })
        }
      ]
    };
  }

  const introIndex = directions.findIndex((d) => d.target === pair.a);
  const introLeg = introduces && introIndex >= 0 ? introIndex : null;
  return {
    engine,
    model,
    pair,
    briefed,
    style,
    introLeg,
    legs: directions.map((direction, index) => ({
      direction,
      voice: engine === "openai-translate" ? null : interpreterVoice(engine, direction, env),
      instructions: briefed
        ? buildLegBriefing({ direction, context, liveModel, style, silenceToken, intro: index === introLeg })
        : null
    }))
  };
}
