import { NextRequest, NextResponse } from "next/server";
import { guardInterpreter } from "@/lib/interpreter/guard";
import {
  interpreterIdleSeconds,
  interpreterMaxMinutes,
  interpreterMediatorEnabled
} from "@/lib/interpreter/flag";
import {
  availableEngines,
  ENGINE_KEY_ENV,
  ENGINE_LABEL,
  engineApiKey,
  engineEnvDefault,
  grokReasoning,
  interpreterTranscribeModel,
  interpreterTranslateTranscribeModel,
  parseEngine,
  XAI_KEY_ENVS,
  type InterpreterEngine
} from "@/lib/interpreter/engine";
import { parseStyle } from "@/lib/interpreter/mediator";
import { loadInterpreterContext } from "@/lib/interpreter/contextStore";
import { buildInterpreterPlan, type LegPlan } from "@/lib/interpreter/plan";
import {
  buildElevenLabsRealtimeSession,
  buildGeminiInterpreterSetup,
  buildGrokSecretSession,
  buildGrokSessionUpdate,
  buildOpenAIRealtimeSession,
  buildOpenAITranslateSession,
  interpreterContextTokenLimit,
  INTERPRETER_SECRET_TTL_SECONDS,
  INTERPRETER_WS_INPUT_RATE,
  INTERPRETER_WS_OUTPUT_RATE,
  interpreterEagerness,
  interpreterReasoning
} from "@/lib/interpreter/session";
import { isSupportedLanguageCode } from "@/lib/realtime/languages";

export const runtime = "nodejs";
export const maxDuration = 30;

// Starts ONE Interpreter-mode session on /tabletop (Tom, 2026-11-09): a
// continuous, hands-free interpreter between the two people at the table.
// One POST mints every LEG the chosen engine needs (lib/interpreter/plan.ts —
// one provider session per direction, each with its own voice) and hands the
// browser what it needs to connect them. Keys never leave the server.
//
// ── Who may spend ──────────────────────────────────────────────────────────
// lib/interpreter/guard.ts, before anything else: TAOS_INTERPRETER_ENABLED
// (404), guardSpend (401), founder (404). A minted secret is a live, billing
// session — nothing is minted for anyone who fails any of the three.
//
// ── The briefing ───────────────────────────────────────────────────────────
// Assembled HERE, from the role in lib/interpreter/briefing.ts and the
// founders' context block in the database, and locked into the provider
// session. It is NEVER LOGGED: the mint line below carries `context_chars`, a
// number, and nothing else about it. And it is never returned to the browser
// — with ONE exception, which is xAI's doing and not a choice:
//
//   grok-voice   xAI's client secret can bind only `model` and
//                `reasoning.effort` (docs.x.ai, ephemeral tokens + the
//                live-interpreter recipe: "the rest goes in session.update").
//                The instructions and the voice have to be sent by whoever
//                holds the socket, and that is the browser. So a Grok leg's
//                ticket carries its `sessionUpdate`, briefing included, to the
//                founder's own phone — the same founder who can already read
//                and edit the context block on this screen (GET …/context).
//                Nobody else can reach this route. It is still not logged.
//
// ── A missing key ──────────────────────────────────────────────────────────
// Each engine fails CLOSED and by NAME: 503, `code: "not_configured"`, and
// `missingEnv` — the exact variable to add in Vercel. Never a silent fall
// back to another provider: a table that picked Grok and heard OpenAI would
// be an A/B that lies.
//
// ── Where the money goes ───────────────────────────────────────────────────
// Unlike the table's push-to-talk turns this session SPEAKS, and the model's
// own speech is the largest line item a realtime surface has. What bounds it:
// the context cap in lib/interpreter/session.ts (the PR #42 pattern), and the
// session cap + idle stop this route stamps into its response for the client
// to enforce (lib/interpreter/limits.ts). Each session ends with one
// [taos-interpreter] cost line (…/interpreter/usage).

const OPENAI_BASE = (process.env.OPENAI_API_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
const GEMINI_BASE = (
  process.env.GEMINI_API_BASE_URL ?? "https://generativelanguage.googleapis.com"
).replace(/\/$/, "");
const GEMINI_WS_URL =
  process.env.GEMINI_LIVE_WS_URL ??
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const XAI_BASE = (process.env.XAI_API_BASE_URL ?? "https://api.x.ai/v1").replace(/\/$/, "");
const XAI_WS_URL = process.env.XAI_REALTIME_WS_URL ?? "wss://api.x.ai/v1/realtime";
const ELEVENLABS_BASE = (process.env.ELEVENLABS_API_BASE_URL ?? "https://api.elevenlabs.io/v1").replace(/\/$/, "");
const ELEVENLABS_WS_URL = process.env.ELEVENLABS_REALTIME_WS_URL ?? "wss://api.elevenlabs.io/v1/convai/realtime";

/** What the browser is told about one leg. No briefing, no key. */
type LegTicket = {
  source: string | null;
  target: string | null;
  voice: string | null;
} & (
  | { transport: "openai-webrtc"; clientSecret: string; callUrl: string }
  | { transport: "openai-live-relay"; relayUrl: string; leg: number }
  | { transport: "gemini-ws"; wsUrl: string }
  | {
      // The OpenAI Realtime wire protocol over a WebSocket (Grok, ElevenLabs).
      transport: "realtime-ws";
      wsUrl: string;
      /** How a browser authenticates a socket: the secret, as a subprotocol. */
      protocols: string[];
      /** Sent by the browser once the socket is up. Null = locked in at mint. */
      sessionUpdate: Record<string, unknown> | null;
      inputRate: number;
      outputRate: number;
    }
);

class MintError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code?: string,
    readonly missingEnv?: string
  ) {
    super(message);
  }
}

/** The engine's key, or the 503 that names the variable to add. */
function requireKey(engine: InterpreterEngine): string {
  const key = engineApiKey(engine);
  if (key) return key;
  const name = ENGINE_KEY_ENV[engine];
  throw new MintError(
    `${ENGINE_LABEL[engine]} is not configured on this deployment: ${name} is not set.`,
    503,
    "not_configured",
    name
  );
}

/** A provider's error body, whatever its shape, as one short line. */
function providerMessage(payload: unknown, status: number): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const nested = (p.error ?? p.detail ?? null) as Record<string, unknown> | string | null;
  const text =
    (typeof nested === "string" && nested) ||
    (nested && typeof nested === "object" && typeof nested.message === "string" && nested.message) ||
    (typeof p.message === "string" && p.message) ||
    (typeof p.error === "string" && p.error) ||
    "";
  return text ? text.slice(0, 200) : `HTTP ${status}`;
}

function secretFrom(payload: Record<string, unknown> | null): string {
  const nested = (payload?.client_secret ?? null) as Record<string, unknown> | null;
  return (
    (typeof payload?.value === "string" && payload.value) ||
    (nested && typeof nested.value === "string" && nested.value) ||
    ""
  );
}

async function mintOpenAISecret(url: string, apiKey: string, body: unknown): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store"
  });
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    // OpenAI's error body names the parameter it disliked. It can never echo
    // the briefing back at length, but it is trimmed anyway, and it goes to
    // the founder's screen — not to the log.
    const err = (payload?.error ?? null) as { message?: unknown; code?: unknown } | null;
    const message = typeof err?.message === "string" ? err.message.slice(0, 200) : `HTTP ${res.status}`;
    throw new MintError(message);
  }
  const secret = secretFrom(payload);
  if (!secret) throw new MintError("No client secret in the provider response.");
  return secret;
}

function ticketBase(leg: LegPlan): { source: string | null; target: string | null; voice: string | null } {
  return {
    source: leg.direction?.source ?? null,
    target: leg.direction?.target ?? null,
    voice: leg.voice
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardInterpreter(req);
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as {
    engine?: unknown;
    mine?: unknown;
    theirs?: unknown;
    style?: unknown;
  };
  // The picker's choice, or the deployment default. An unknown engine is a
  // default, never an error — the screen must not strand a dinner on a typo.
  // An experimental engine this deployment has not switched on
  // (TAOS_INTERPRETER_EXPERIMENTAL_ENGINES) is treated the same way: it is
  // never minted, whatever a stale tab or a hand-written request asks for.
  const requested = parseEngine(body.engine);
  const engine = requested && availableEngines().includes(requested) ? requested : engineEnvDefault();
  const mine = typeof body.mine === "string" && isSupportedLanguageCode(body.mine) ? body.mine : "en";
  const rawTheirs =
    typeof body.theirs === "string" && isSupportedLanguageCode(body.theirs) ? body.theirs : "es";
  // Never a table of one repeated language (lib/translate/pair.ts).
  const theirs = rawTheirs === mine ? (mine === "en" ? "es" : "en") : rawTheirs;
  const pair = { a: mine, b: theirs };

  const stored = await loadInterpreterContext();
  // "mediator" only when the device asked for exactly that; anything else is
  // the interpreter (lib/interpreter/mediator.ts — the style is OFF by default).
  const plan = buildInterpreterPlan({
    engine,
    pair,
    context: stored.context,
    style: interpreterMediatorEnabled() ? parseStyle(body.style) ?? undefined : undefined
  });
  const transcribeModel = interpreterTranscribeModel();

  try {
    let legs: LegTicket[];

    if (engine === "grok-voice") {
      const apiKey = requireKey(engine);
      const reasoning = grokReasoning();
      legs = await Promise.all(
        plan.legs.map(async (leg): Promise<LegTicket> => {
          const res = await fetch(`${XAI_BASE}/realtime/client_secrets`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              expires_after: { seconds: INTERPRETER_SECRET_TTL_SECONDS },
              // All a Grok secret can bind (see the note at the top).
              session: buildGrokSecretSession({ model: plan.model, reasoning })
            }),
            cache: "no-store"
          });
          const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
          const secret = secretFrom(payload);
          if (!res.ok || !secret) throw new MintError(providerMessage(payload, res.status));
          return {
            ...ticketBase(leg),
            transport: "realtime-ws",
            // The effort again, as xAI's documented query parameter: the
            // secret may not carry it (see buildGrokSessionUpdate).
            wsUrl: `${XAI_WS_URL}?model=${encodeURIComponent(plan.model)}&reasoning.effort=${reasoning}`,
            protocols: [`xai-client-secret.${secret}`],
            sessionUpdate: buildGrokSessionUpdate({
              instructions: leg.instructions ?? "",
              voice: leg.voice ?? "",
              reasoning
            }),
            inputRate: INTERPRETER_WS_INPUT_RATE,
            outputRate: INTERPRETER_WS_OUTPUT_RATE
          };
        })
      );
    } else if (engine === "elevenlabs-realtime") {
      const apiKey = requireKey(engine);
      legs = await Promise.all(
        plan.legs.map(async (leg): Promise<LegTicket> => {
          const res = await fetch(`${ELEVENLABS_BASE}/convai/realtime/client_secrets`, {
            method: "POST",
            headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              expires_after: { anchor: "created_at", seconds: INTERPRETER_SECRET_TTL_SECONDS },
              // "The session configuration you send when minting the client
              // secret is the authoritative initial session": the briefing
              // and the cloned voice are locked in here, server-side.
              session: buildElevenLabsRealtimeSession({
                model: plan.model,
                instructions: leg.instructions ?? "",
                voice: leg.voice ?? "",
                // The language this leg LISTENS for; a single session that
                // hears both is given none and left to detect.
                language: leg.direction?.source ?? null,
                maxSeconds: interpreterMaxMinutes() * 60,
                eagerness: interpreterEagerness()
              })
            }),
            cache: "no-store"
          });
          const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
          const secret = secretFrom(payload);
          if (!res.ok || !secret) throw new MintError(providerMessage(payload, res.status));
          return {
            ...ticketBase(leg),
            // A clone's ID is configuration, not something a screen needs.
            voice: null,
            transport: "realtime-ws",
            wsUrl: ELEVENLABS_WS_URL,
            // What OpenAI's own browser SDK sends, which ElevenLabs' guide uses.
            protocols: ["realtime", `openai-insecure-api-key.${secret}`],
            sessionUpdate: null,
            inputRate: INTERPRETER_WS_INPUT_RATE,
            outputRate: INTERPRETER_WS_OUTPUT_RATE
          };
        })
      );
    } else if (engine === "gemini-live") {
      const apiKey = requireKey(engine);
      const now = Date.now();
      legs = await Promise.all(
        plan.legs.map(async (leg): Promise<LegTicket> => {
          const res = await fetch(`${GEMINI_BASE}/v1beta/auth_tokens`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify({
              uses: 1,
              expireTime: new Date(now + (interpreterMaxMinutes() + 5) * 60_000).toISOString(),
              newSessionExpireTime: new Date(now + INTERPRETER_SECRET_TTL_SECONDS * 1000).toISOString(),
              bidiGenerateContentSetup: buildGeminiInterpreterSetup({
                model: plan.model,
                instructions: leg.instructions ?? "",
                voice: leg.voice ?? ""
              })
            }),
            cache: "no-store"
          });
          const payload = (await res.json().catch(() => null)) as {
            name?: unknown;
            error?: { message?: unknown };
          } | null;
          const token = typeof payload?.name === "string" ? payload.name : "";
          if (!res.ok || !token) {
            const message =
              typeof payload?.error?.message === "string"
                ? payload.error.message.slice(0, 200)
                : `HTTP ${res.status}`;
            throw new MintError(message);
          }
          return {
            ...ticketBase(leg),
            transport: "gemini-ws",
            wsUrl: `${GEMINI_WS_URL}?access_token=${encodeURIComponent(token)}`
          };
        })
      );
    } else {
      const apiKey = requireKey(engine);

      if (engine === "openai-live") {
        // GPT-Live has no client secret: the browser's SDP offer is exchanged
        // by OUR server (…/interpreter/live), which re-asks the guard and
        // rebuilds the same plan. Nothing is minted — or billed — here.
        legs = plan.legs.map((leg, index) => ({
          ...ticketBase(leg),
          transport: "openai-live-relay",
          relayUrl: "/api/tabletop/interpreter/live",
          leg: index
        }));
      } else if (engine === "openai-translate") {
        legs = await Promise.all(
          plan.legs.map(async (leg): Promise<LegTicket> => {
            const direction = leg.direction!;
            const clientSecret = await mintOpenAISecret(
              `${OPENAI_BASE}/realtime/translations/client_secrets`,
              apiKey,
              {
                session: buildOpenAITranslateSession({
                  model: plan.model,
                  direction,
                  transcribeModel: interpreterTranslateTranscribeModel()
                })
              }
            );
            return {
              ...ticketBase(leg),
              transport: "openai-webrtc",
              clientSecret,
              callUrl: `${OPENAI_BASE}/realtime/translations/calls`
            };
          })
        );
      } else {
        legs = await Promise.all(
          plan.legs.map(async (leg): Promise<LegTicket> => {
            const clientSecret = await mintOpenAISecret(`${OPENAI_BASE}/realtime/client_secrets`, apiKey, {
              expires_after: { anchor: "created_at", seconds: INTERPRETER_SECRET_TTL_SECONDS },
              session: buildOpenAIRealtimeSession({
                model: plan.model,
                instructions: leg.instructions ?? "",
                voice: leg.voice ?? "",
                transcribeModel,
                pair,
                eagerness: interpreterEagerness(),
                reasoning: interpreterReasoning(),
                // Deal keeps a longer memory, for its terms ledger.
                contextTokenLimit: interpreterContextTokenLimit(plan.style)
              })
            });
            return {
              ...ticketBase(leg),
              transport: "openai-webrtc",
              clientSecret,
              callUrl: `${OPENAI_BASE}/realtime/calls?model=${encodeURIComponent(plan.model)}`
            };
          })
        );
      }
    }

    const maxSeconds = interpreterMaxMinutes() * 60;
    const idleSeconds = interpreterIdleSeconds();

    // Greppable as [taos-interpreter-mint]. Numbers and closed-set values
    // only: the briefing and the context block never reach a log line.
    console.info(
      `[taos-interpreter-mint] engine=${engine} model=${plan.model} pair=${mine}<>${theirs} ` +
        `legs=${plan.legs.length} briefed=${plan.briefed ? 1 : 0} style=${plan.style} ` +
        `context_chars=${plan.briefed ? stored.context.length : 0} context=${stored.status} ` +
        `context_tokens=${interpreterContextTokenLimit(plan.style) ?? "off"} max_s=${maxSeconds} idle_s=${idleSeconds} ` +
        `intro_leg=${plan.introLeg ?? "none"}`
    );

    return NextResponse.json(
      {
        engine,
        model: plan.model,
        legs,
        maxSeconds,
        idleSeconds,
        // What the session was actually briefed as — "interpreter" for an
        // engine that takes no briefing, whatever the device asked for.
        style: plan.style,
        // Which leg the screen cues to introduce the mediator. An index —
        // the introduction itself is in that leg's briefing, server-side.
        introLeg: plan.introLeg,
        briefing: {
          // False for gpt-realtime-translate: its session takes no instructions.
          applied: plan.briefed,
          contextChars: plan.briefed ? stored.context.length : 0,
          contextStatus: stored.status
        }
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const status = error instanceof MintError ? error.status : 502;
    const code = error instanceof MintError ? error.code : undefined;
    const missingEnv = error instanceof MintError ? error.missingEnv : undefined;
    const apiKeys = [
      process.env.OPENAI_API_KEY,
      process.env.GEMINI_API_KEY,
      process.env.ELEVENLABS_API_KEY,
      ...XAI_KEY_ENVS.map((name) => process.env[name])
    ]
      .map((k) => k?.trim())
      .filter((k): k is string => !!k);
    // Scrubbed anyway: a fetch error that ever echoes a URL or header would
    // echo a key.
    let details = error instanceof Error ? error.message : "Unexpected error.";
    for (const k of apiKeys) details = details.split(k).join("<key>");
    return NextResponse.json(
      {
        error: "Could not start the interpreter.",
        details,
        ...(code ? { code } : {}),
        // A NAME, never a value: the variable Tom has to add in Vercel.
        ...(missingEnv ? { missingEnv } : {}),
        engine
      },
      { status, headers: { "Cache-Control": "no-store" } }
    );
  }
}
