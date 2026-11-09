import { NextRequest, NextResponse } from "next/server";
import { guardInterpreter } from "@/lib/interpreter/guard";
import { interpreterIdleSeconds, interpreterMaxMinutes } from "@/lib/interpreter/flag";
import {
  engineEnvDefault,
  interpreterTranscribeModel,
  interpreterTranslateTranscribeModel,
  parseEngine
} from "@/lib/interpreter/engine";
import { loadInterpreterContext } from "@/lib/interpreter/contextStore";
import { buildInterpreterPlan, type LegPlan } from "@/lib/interpreter/plan";
import {
  buildGeminiInterpreterSetup,
  buildOpenAIRealtimeSession,
  buildOpenAITranslateSession,
  INTERPRETER_CONTEXT_TOKEN_LIMIT,
  INTERPRETER_SECRET_TTL_SECONDS,
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
// session. It is never returned to the browser and NEVER LOGGED: the mint line
// below carries `context_chars`, a number, and nothing else about it.
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

/** What the browser is told about one leg. No briefing, no key. */
type LegTicket = {
  source: string | null;
  target: string | null;
  voice: string | null;
} & (
  | { transport: "openai-webrtc"; clientSecret: string; callUrl: string }
  | { transport: "openai-live-relay"; relayUrl: string; leg: number }
  | { transport: "gemini-ws"; wsUrl: string }
);

class MintError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code?: string
  ) {
    super(message);
  }
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
  };
  // The picker's choice, or the deployment default. An unknown engine is a
  // default, never an error — the screen must not strand a dinner on a typo.
  const engine = parseEngine(body.engine) ?? engineEnvDefault();
  const mine = typeof body.mine === "string" && isSupportedLanguageCode(body.mine) ? body.mine : "en";
  const rawTheirs =
    typeof body.theirs === "string" && isSupportedLanguageCode(body.theirs) ? body.theirs : "es";
  // Never a table of one repeated language (lib/translate/pair.ts).
  const theirs = rawTheirs === mine ? (mine === "en" ? "es" : "en") : rawTheirs;
  const pair = { a: mine, b: theirs };

  const stored = await loadInterpreterContext();
  const plan = buildInterpreterPlan({ engine, pair, context: stored.context });
  const transcribeModel = interpreterTranscribeModel();

  try {
    let legs: LegTicket[];

    if (engine === "gemini-live") {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      if (!apiKey) throw new MintError("Gemini is not configured on this deployment.", 503, "not_configured");
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
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) throw new MintError("OpenAI is not configured on this deployment.", 503, "not_configured");

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
                reasoning: interpreterReasoning()
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
        `legs=${plan.legs.length} briefed=${plan.briefed ? 1 : 0} ` +
        `context_chars=${plan.briefed ? stored.context.length : 0} context=${stored.status} ` +
        `context_tokens=${INTERPRETER_CONTEXT_TOKEN_LIMIT ?? "off"} max_s=${maxSeconds} idle_s=${idleSeconds}`
    );

    return NextResponse.json(
      {
        engine,
        model: plan.model,
        legs,
        maxSeconds,
        idleSeconds,
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
    const apiKeys = [process.env.OPENAI_API_KEY, process.env.GEMINI_API_KEY]
      .map((k) => k?.trim())
      .filter((k): k is string => !!k);
    // Scrubbed anyway: a fetch error that ever echoes a URL or header would
    // echo a key.
    let details = error instanceof Error ? error.message : "Unexpected error.";
    for (const k of apiKeys) details = details.split(k).join("<key>");
    return NextResponse.json(
      { error: "Could not start the interpreter.", details, ...(code ? { code } : {}), engine },
      { status, headers: { "Cache-Control": "no-store" } }
    );
  }
}
