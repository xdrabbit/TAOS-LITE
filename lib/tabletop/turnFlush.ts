// What /tabletop's live engine owes a turn before it may call it finished.
//
// Tom and Liz, 2026-11-15, after a day of real use at a quiet table: "it holds
// on like it's holding its breath, and when it holds too long it passes out
// and we don't get the translation."
//
// ── What was actually happening (tests/live-fire/tabletop-flush.measure.ts) ─
// Server VAD only commits a segment when the speaker PAUSES (550 ms). Someone
// who talks straight through holds one segment open for as long as they talk —
// nothing streams, which is the held breath. And the session is minted with a
// context cap (lib/tabletop/session.ts, 100 tokens ≈ 10 s of audio), so when
// that long segment finally commits it is bigger than everything the model is
// allowed to read. The server prunes it. The response is created anyway, with
// NO AUDIO IN IT (`input_token_details.audio_tokens: 0`), and the model either
// writes nothing — the lost turn — or makes a sentence up. Measured on the
// shipped session: unbroken phrases of 4 s and 6 s translate; from ~7 s on,
// every one comes back empty-handed. Nothing timed out; the old flat 8 s
// drain was never the problem.
//
// ── What this file does about it ───────────────────────────────────────────
//   1. SEGMENT BUDGET. While a voice is open, commit by hand before the
//      segment outgrows what the session can read (`maxSegmentMs`, from the
//      mint route), and ask for its response. The text streams while the
//      person is still talking, and no segment is ever big enough to prune.
//   2. END-OF-TURN FLUSH. If the voice is still "open" after the mic closed
//      and the grace ran out (VAD never saw the pause), commit and ask by
//      hand. Same for a committed segment the server never answered.
//   3. PROGRESS-AWARE DRAIN. Wait while events are still arriving; give up
//      after DRAIN_NO_PROGRESS_MS of nothing, or DRAIN_HARD_CAP_MS in all.
//   4. NEVER PASS OFF AN INVENTION. A response that read no audio is not a
//      translation. It is reported (`dropped`) so the caller can leave it out
//      and mark the turn incomplete.
//
// ── API semantics this leans on ────────────────────────────────────────────
// https://developers.openai.com/api/reference/resources/realtime —
//   input_audio_buffer.commit: "When in Server VAD mode, the client does not
//     need to send this event, the server will commit the audio buffer
//     automatically. Committing the input audio buffer will trigger input
//     audio transcription (if enabled in session configuration), but it will
//     not create a response from the model." … "This event will produce an
//     error if the input audio buffer is empty."
//   input_audio_buffer.committed: "Returned when an input audio buffer is
//     committed, either by the client or automatically in server VAD mode."
//   turn_detection.create_response: "Whether or not to automatically generate
//     a response when a VAD stop event occurs."
// So a manual commit never answers itself — `create_response: true` is about
// VAD stops — and the client must send `response.create`. The guide
// (…/api/docs/guides/realtime-conversations) only SHOWS manual commits with
// VAD off, so "accepted while server_vad is on, mid-speech" was confirmed
// against the live API rather than assumed: committed in ~55 ms, no response
// of its own, VAD carries on and still closes the rest of the phrase.
//
// One thing a flush cannot do: bring back speech VAD never heard at all. In
// server-VAD mode audio that is not classified as speech is not kept — a
// manual commit after five seconds of it finds "0.00ms of audio". That turn
// is counted (`silent`), and the cure for it is a lower VAD threshold
// (TAOS_TABLETOP_VAD=quiet), not a flush.
//
// Pure of the DOM and the network: it is handed a `send` and fed events, so
// the tests drive it with a scripted provider and the live-fire rig drives
// the very same object against the real one.

/** After the button ends a turn, how long VAD gets to see the pause itself. */
export const ENDTURN_VAD_GRACE_MS = 900;
/** Longest wait for a response once NOTHING is arriving any more. */
export const DRAIN_NO_PROGRESS_MS = 6000;
/** Longest wait for a turn's translations, however alive the stream looks. */
export const DRAIN_HARD_CAP_MS = 45_000;
/** A committed segment with no response this long after it gets one asked for. */
export const UNANSWERED_COMMIT_MS = 800;
/**
 * A hand-cut that lands just as the speaker stops leaves VAD a remainder with
 * no words in it, and VAD commits and answers it all the same — measured: the
 * model answered one with "Understood. I'll keep the translation going." If
 * VAD's stop arrives within its own silence window plus this much of our cut,
 * the remainder held less than this much voice: its response is cancelled and
 * never shown.
 */
export const REMNANT_SPEECH_MS = 300;
/** A turn at least this long that VAD committed nothing from is "silent". */
export const SILENT_TURN_MIN_MS = 1500;

const POLL_MS = 50;

export type DrainOutcome = "ok" | "flushed" | "timeout";

/** One turn's end, in numbers. No text, ever. */
export interface TurnDrain {
  /** Mic closed → turn resolved, including the VAD grace. */
  ms: number;
  outcome: DrainOutcome;
  /** Segments committed this turn, by VAD or by hand. */
  committedSegments: number;
  /** Of those, how many the segment budget committed mid-speech. */
  forcedCommits: number;
  /** Responses that read no audio, or were cut short — left out or marked. */
  droppedSegments: number;
  /** The mic was open a while and VAD never committed a thing. */
  silent: boolean;
}

export interface TurnFlushDeps {
  /** Send one client event to the realtime session. */
  send: (ev: Record<string, unknown>) => void;
  /**
   * Longest a single segment may run before it is committed by hand, in ms.
   * null = never (the session has no context cap to outgrow).
   */
  maxSegmentMs: number | null;
  /**
   * Instructions for a response the client asks for itself. `continuing` is
   * true when the segment picks up mid-sentence from one this controller cut.
   * undefined = the session's own instructions.
   */
  responseInstructions?: (continuing: boolean) => string | undefined;
  /** The session's VAD silence_duration_ms (lib/tabletop/session.ts). */
  vadSilenceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** What the caller should do with the event it just fed in. */
export interface FlushVerdict {
  /** Does this event belong to the turn that is open or draining? */
  forTurn: boolean;
  /** The response it is about, when it is about one. */
  responseId: string | null;
  /** An error this controller caused and handled — do not show it. */
  swallow: boolean;
  /** response.done only: this response read no audio. Its text is not a translation. */
  dropped: boolean;
  /** response.done only: cut short by the output cap. */
  incomplete: boolean;
}

export interface TurnFlush {
  /** The mic is open: a new turn starts counting. */
  beginTurn: () => void;
  /** Feed every server event, in order. */
  handle: (ev: Readonly<Record<string, unknown>>) => FlushVerdict;
  /** The mic just closed. Resolves when the turn has everything it will get. */
  endTurn: () => Promise<TurnDrain>;
  /** The session is gone; let any drain in flight return. */
  dispose: () => void;
}

export function createTurnFlush(deps: TurnFlushDeps): TurnFlush {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let disposed = false;
  let turnId = 0;
  let turnOpen = false;
  let draining = false;
  let turnStartedAt = 0;

  // ── What server VAD is doing, as far as its events say ──
  let speechOpen = false;
  let speechOpenSince = 0;
  /** speech_stopped arrived; the `committed` that follows it is VAD's own. */
  let vadCommitPending = false;
  /** We sent a commit and have heard neither `committed` nor an error. */
  let manualPending = false;
  /** Manual commits in the current run of speech — the next one continues it. */
  let runCuts = 0;
  let lastCutAt = -Infinity;
  /** VAD is about to commit and answer a remainder with no words in it. */
  let remnant = false;
  let budgetTimer: unknown = null;
  const vadSilenceMs = deps.vadSilenceMs ?? 550;

  // ── Who owes whom a response ──
  let seq = 0;
  let lastCommitSeq = 0;
  let lastCommitAt = 0;
  let lastResponseSeq = 0;
  /** A manual commit landed; we must ask for its response. */
  let owed: { continuing: boolean } | null = null;
  /** We sent response.create and its response.created has not come back. */
  let asked = false;
  /** response id → the turn it was created in (0 = between turns). */
  const responses = new Map<string, number>();
  let anonymousActive = 0;

  let lastProgressAt = 0;
  let stats = { committed: 0, forced: 0, dropped: 0, speechStarts: 0, flushed: false };

  const live = () => turnOpen || draining;
  const activeForTurn = () => {
    let n = anonymousActive;
    for (const t of responses.values()) if (t === turnId) n += 1;
    return n;
  };
  const anyActive = () => responses.size + anonymousActive > 0;

  const clearBudget = () => {
    if (budgetTimer !== null) clearTimer(budgetTimer);
    budgetTimer = null;
  };

  const commitByHand = () => {
    if (disposed || manualPending) return;
    manualPending = true;
    deps.send({ type: "input_audio_buffer.commit" });
  };

  const armBudget = () => {
    clearBudget();
    // Only while the mic is open. Once it has closed, silence is flowing and
    // VAD ends the segment within its own pause — a cut then would only split
    // off a remainder with nothing in it.
    if (deps.maxSegmentMs === null || !speechOpen || !turnOpen || disposed) return;
    const wait = Math.max(0, deps.maxSegmentMs - (now() - speechOpenSince));
    budgetTimer = setTimer(() => {
      budgetTimer = null;
      // The voice is still open and the segment is as big as it may get.
      if (speechOpen && turnOpen) commitByHand();
    }, wait);
  };

  const askIfOwed = () => {
    if (disposed || !owed || anyActive()) return;
    const instructions = deps.responseInstructions?.(owed.continuing);
    owed = null;
    // Counts as answered from here: a late server response must not make us
    // ask twice for the same segment.
    lastResponseSeq = ++seq;
    asked = true;
    deps.send(
      instructions ? { type: "response.create", response: { instructions } } : { type: "response.create" }
    );
  };

  const beginTurn = () => {
    turnId += 1;
    turnOpen = true;
    draining = false;
    turnStartedAt = now();
    lastProgressAt = turnStartedAt;
    stats = { committed: 0, forced: 0, dropped: 0, speechStarts: 0, flushed: false };
    // A voice VAD still thinks is open from before (the last turn ended on a
    // flush, and no silence reached the server since) is this turn's from now.
    if (speechOpen) {
      speechOpenSince = turnStartedAt;
      armBudget();
    }
  };

  const none: FlushVerdict = { forTurn: false, responseId: null, swallow: false, dropped: false, incomplete: false };

  const handle = (ev: Readonly<Record<string, unknown>>): FlushVerdict => {
    const type = typeof ev.type === "string" ? ev.type : "";
    if (type !== "error") lastProgressAt = now();

    if (type === "input_audio_buffer.speech_started") {
      speechOpen = true;
      speechOpenSince = now();
      runCuts = 0;
      remnant = false;
      if (live()) stats.speechStarts += 1;
      armBudget();
      return { ...none, forTurn: live() };
    }
    if (type === "input_audio_buffer.speech_stopped") {
      speechOpen = false;
      vadCommitPending = true;
      // The stop is sent once the pause has lasted vadSilenceMs, so the voice
      // ended that long ago. If that is (nearly) where we cut, what VAD is
      // about to commit is the pause itself.
      remnant = now() - lastCutAt < vadSilenceMs + REMNANT_SPEECH_MS;
      clearBudget();
      return { ...none, forTurn: live() };
    }
    if (type === "input_audio_buffer.committed") {
      if (vadCommitPending && remnant) {
        // The wordless remainder: not a segment, and nobody owes it an answer.
        vadCommitPending = false;
        return { ...none, forTurn: live() };
      }
      lastCommitSeq = ++seq;
      lastCommitAt = now();
      if (live()) stats.committed += 1;
      if (vadCommitPending) {
        // VAD's own — `create_response: true` answers it.
        vadCommitPending = false;
      } else if (manualPending) {
        manualPending = false;
        lastCutAt = now();
        if (live()) {
          if (turnOpen) stats.forced += 1;
          else stats.flushed = true;
          owed = { continuing: runCuts > 0 };
          runCuts += 1;
          // Whatever is still being said belongs to a new segment.
          speechOpenSince = now();
          armBudget();
          askIfOwed();
        }
      }
      return { ...none, forTurn: live() };
    }
    if (type === "response.created") {
      const id = responseIdOf(ev);
      if (remnant && !asked) {
        // The server answering the wordless remainder. Stop it; show nothing.
        remnant = false;
        if (id) responses.set(id, 0);
        deps.send(id ? { type: "response.cancel", response_id: id } : { type: "response.cancel" });
        return { ...none, responseId: id };
      }
      lastResponseSeq = ++seq;
      asked = false;
      const owner = live() ? turnId : 0;
      if (id) responses.set(id, owner);
      else if (owner) anonymousActive += 1;
      return { ...none, forTurn: owner !== 0, responseId: id };
    }
    if (type === "response.done") {
      const id = responseIdOf(ev);
      let owner = 0;
      if (id && responses.has(id)) {
        owner = responses.get(id) ?? 0;
        responses.delete(id);
      } else if (!id && anonymousActive > 0) {
        anonymousActive -= 1;
        owner = turnId;
      }
      const forTurn = owner !== 0 && owner === turnId && live();
      const response = (ev.response ?? {}) as {
        status?: unknown;
        usage?: { input_token_details?: { audio_tokens?: unknown } };
      };
      const audioIn = response.usage?.input_token_details?.audio_tokens;
      // Exactly zero, reported as a number: the segment was pruned out from
      // under its own response. (No usage at all is not evidence of that.)
      const dropped = audioIn === 0 && response.status !== "cancelled";
      const incomplete = response.status === "incomplete";
      if (forTurn && (dropped || incomplete)) stats.dropped += 1;
      askIfOwed();
      return { forTurn, responseId: id, swallow: false, dropped, incomplete };
    }
    if (type === "error") {
      const err = (ev.error ?? {}) as { code?: unknown };
      const code = typeof err.code === "string" ? err.code : "";
      if (code === "input_audio_buffer_commit_empty" && manualPending) {
        // VAD got there first, or there was nothing to flush. Not a fault.
        manualPending = false;
        return { ...none, swallow: true };
      }
      if (code === "response_cancel_not_active") {
        // We cancelled something that had already finished. Nothing to do.
        return { ...none, swallow: true };
      }
      if (code === "conversation_already_has_active_response") {
        // Our ask raced a response the server was already writing; that one
        // read the same conversation, so the segment is answered.
        asked = false;
        return { ...none, swallow: true };
      }
      return none;
    }
    if (type.startsWith("response.")) {
      const id = typeof ev.response_id === "string" ? ev.response_id : null;
      const owner = id ? (responses.get(id) ?? 0) : anonymousActive > 0 ? turnId : 0;
      return { ...none, forTurn: owner !== 0 && owner === turnId && live(), responseId: id };
    }
    return none;
  };

  const endTurn = async (): Promise<TurnDrain> => {
    const endAt = now();
    const myTurn = turnId;
    const micOpenMs = endAt - turnStartedAt;
    turnOpen = false;
    draining = true;
    lastProgressAt = endAt;
    let outcome: DrainOutcome = "ok";

    // Silence is flowing from the muted mic: VAD closes the last phrase itself
    // if it can. The loop below would wait for that anyway; the grace is the
    // floor that keeps a response.created that is still in the air from being
    // mistaken for "nothing owed".
    await sleep(ENDTURN_VAD_GRACE_MS);

    let flushedOpenVoice = false;
    while (!disposed && turnId === myTurn) {
      const at = now();
      if (speechOpen && !manualPending && !flushedOpenVoice) {
        // The grace is spent and VAD still thinks someone is talking: it will
        // not commit this by itself. Take what is in the buffer.
        flushedOpenVoice = true;
        commitByHand();
      } else if (
        !manualPending &&
        !vadCommitPending &&
        !owed &&
        !asked &&
        activeForTurn() === 0 &&
        lastCommitSeq > lastResponseSeq &&
        at - lastCommitAt >= UNANSWERED_COMMIT_MS
      ) {
        // Committed, and nobody answered it (`interrupt_response: false` "may
        // fail to create a response if the model is already responding").
        stats.flushed = true;
        owed = { continuing: false };
        askIfOwed();
      }

      const settled =
        !manualPending &&
        !vadCommitPending &&
        !owed &&
        !asked &&
        activeForTurn() === 0 &&
        lastCommitSeq <= lastResponseSeq &&
        (!speechOpen || flushedOpenVoice);
      if (settled) break;
      if (at - lastProgressAt >= DRAIN_NO_PROGRESS_MS || at - endAt >= DRAIN_HARD_CAP_MS) {
        outcome = "timeout";
        break;
      }
      await sleep(POLL_MS);
    }

    if (outcome === "timeout") {
      // Abandoned, so stop paying for it; anything it still sends is ignored
      // because the turn it belonged to is over.
      for (const [id, owner] of responses) {
        if (owner === myTurn) deps.send({ type: "response.cancel", response_id: id });
      }
      owed = null;
      asked = false;
      manualPending = false;
      vadCommitPending = false;
    } else if (stats.flushed) {
      outcome = "flushed";
    }
    if (turnId === myTurn) draining = false;
    if (!speechOpen) clearBudget();

    return {
      ms: Math.max(0, Math.round(now() - endAt)),
      outcome,
      committedSegments: stats.committed,
      forcedCommits: stats.forced,
      droppedSegments: stats.dropped,
      silent: stats.committed === 0 && stats.speechStarts === 0 && micOpenMs >= SILENT_TURN_MIN_MS
    };
  };

  const dispose = () => {
    disposed = true;
    clearBudget();
  };

  return { beginTurn, handle, endTurn, dispose };
}

function responseIdOf(ev: Readonly<Record<string, unknown>>): string | null {
  const r = ev.response as { id?: unknown } | undefined;
  return r && typeof r.id === "string" ? r.id : null;
}
