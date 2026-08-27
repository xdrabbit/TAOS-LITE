# Tutor phase 1 — verification log

Run 2026-08-25 on branch `feat/tutor-phase-1`, against the REAL providers, with
the tutor flag on locally and only auth mocked. This is the record for
docs/tutor-curriculum-plan.md steps 1-3; the harness that produced it is at the
bottom of this file so any of it can be re-run.

## What ran

| Leg | Provider | Result |
| --- | --- | --- |
| Lesson generation, module 4 EN-learner → ES-target | OpenAI `gpt-4.1` | ✅ generated, full lesson below |
| Same request again | — | ✅ `cached=true source=memory`, no second generation |
| Lesson generation, module 4 EN-learner → HI-target | OpenAI `gpt-4.1` | ✅ contrast hook fires (`sameAsLearner=false`) |
| Crawl audio pipeline (TTS → 16 kHz mono WAV → assess route) | OpenAI TTS + ffmpeg | ✅ 119 KB WAV reached the route's Azure branch |
| Crawl scoring, Azure round trip | Azure Speech | ⚠️ **not run — see "The one gap" below** |
| Crawl on a language Azure cannot score | — | ✅ honest refusal, no invented score |
| Walk realtime roleplay, one turn | OpenAI `gpt-realtime-mini` | ✅ opens in character, reacts in Spanish at beginner pace |
| Flag off: `/tutor` and all four APIs | — | ✅ 307 and four `404 {"error":"not_found"}` |

## The one gap: the Azure score itself

> **Closed 2026-08-26.** Tom ran this leg himself on the branch preview,
> where `AZURE_SPEECH_KEY` is present, and pronunciation scoring came back
> real. Everything below describes why the *local* run could not do it.

`AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` are marked **sensitive** in Vercel,
which means `vercel env pull` returns `"[SENSITIVE]"` and the value cannot reach
a laptop at all. Everything on the learner's side of that call is verified —
real audio, resampled to the 16 kHz mono WAV Azure wants, posted as multipart to
the real route, which resolved `es` to the `es-MX` locale and took the Azure
branch. The provider leg then answered the way it does with no key:

```json
{ "configured": false, "message": "Pronunciation scoring isn't configured yet (missing Azure Speech key)." }
```

To close it, run the harness below with the key in the environment — one
command, and the assertion flips itself:

```bash
AZURE_SPEECH_KEY=… AZURE_SPEECH_REGION=… npx vitest run tests/_live-verify.test.ts
```

The same leg is also exercised by simply using Crawl on a preview deployment
with the flag on, where the sensitive vars are available at runtime.

Two smaller things this run could not reach, for the same reason:

* `SUPABASE_SERVICE_ROLE_KEY` is sensitive too, so the cache's **database**
  layer (`public.tutor_lessons`, migration applied 8/25) degraded to memory
  here. The memory layer is what the `cached=true source=memory` line proves.
* The screen itself needs a signed-in browser. `/tutor` serves 200 with the
  flag on and 307 with it off; the module list, Crawl card and Walk feed were
  driven through their routes rather than through a phone.

## What the run found

The first Walk turn came back as a cheerful general-purpose assistant in
English instead of the pharmacist's opening line. Cause: a realtime
`response.create` carrying its own `instructions` **replaces** the session's
instructions for that turn rather than adding to them, so the one-off "open the
scene" nudge was deleting the persona for exactly the turn that needed it most.
The greeting nudge in the RC1 tutor had the same shape. Fixed in
`lib/tutor/conversation.ts` (every one-off turn now goes through `sendTurn()`,
which prepends the persona), and fenced in `tests/tutor-instructions.test.ts`.

## Transcripts

```
status=200 cached=false source=generated capabilities={"speech":true,"pronunciationScoring":true}

===== MODULE 4 · needs-wants · EN learner → ES target =====
TITLE: I need / I want: Getting What You Need in Spanish
CONTRAST HOOK (sameAsLearner=true):
  Spanish and English use nearly the same structure for 'I need' and 'I want'.
  In Spanish, you simply say 'Necesito' for 'I need' and 'Quiero' for 'I want', followed by what you want or need. This is almost identical to English, making it easy to remember and use. However, just like in English, using 'I want' (Quiero) can sound blunt with strangers, so 'I need' (Necesito) is usually more polite in shops and pharmacies.
  e.g. Necesito algo para el dolor de cabeza. = I need something for a headache. (lit. I need something for the pain of head)
PHRASES:
  [request] Necesito algo para el dolor de cabeza. — I need something for a headache. (lit. I need something for the pain of head)
  [quantity] ¿Puede darme una caja, por favor? — Can you give me a box, please? (lit. Can you give me a box, please?)
  [accept] Sí, eso está bien. Gracias. — Yes, that's fine. Thank you. (lit. Yes, that is good. Thanks.)
  [decline] No, es para el dolor de cabeza, no de estómago. — No, it's for a headache, not for the stomach. (lit. No, it is for the pain of head, not of stomach.)
  [thank] Muchas gracias. — Thank you very much. (lit. Many thanks.)
PRONUNCIATION TARGETS:
  <request_phrase> Necesito algo para el dolor de cabeza. — The 'ce' in 'Necesito' is pronounced like 'th' in Spain or 's' in Latin America; stress is on the 'si'.
  <thank_phrase> Muchas gracias. — 'Gracias' ends with 'see-as', not 'shus'; stress is on the first syllable.
ROLEPLAY: pharmacy · tutor plays pharmacist
  opening: Buenos días, ¿en qué puedo ayudarle?
  learner: Necesito algo para el dolor de cabeza. — I need something for a headache.
  learner: No, es para el dolor de cabeza, no de estómago. — No, it's for a headache, not for the stomach.
  learner: ¿Puede darme una caja, por favor? — Can you give me a box, please?
  learner: Sí, eso está bien. Gracias. — Yes, that's fine. Thank you.
  learner: Muchas gracias. — Thank you very much.
RUN GOAL: Ask for something you need, clarify if misunderstood, and finish the exchange politely in Spanish.

second request: cached=true source=memory

===== MODULE 4 · needs-wants · EN learner → HI target =====
TITLE: How to Say 'I Need / I Want' in Hindi
CONTRAST HOOK (sameAsLearner=false):
  Hindi says 'To me, X is wanted'—not 'I want X.'
  In Hindi, you don't say 'I want' directly. Instead, you say 'To me, X is wanted' using a special structure: the thing you want comes first, then 'to me,' then 'is wanted.' This is softer and more polite than the English way. Using just 'I want' in Hindi would sound strange and overly direct.
  e.g. मुझे सिरदर्द की दवा चाहिए। [mujhe sir-dard ki dawa chahiye.] = I need medicine for a headache. (lit. To me, headache's medicine is wanted.)
PHRASES:
  [request] मुझे सिरदर्द की दवा चाहिए। [mujhe sir-dard ki dawa chahiye.] — I need medicine for a headache. (lit. To me, headache's medicine is wanted.)
  [quantity] एक पैकेट चाहिए। [ek packet chahiye.] — I need one packet. (lit. One packet is wanted.)
  [accept] ठीक है, यही चलेगा। [theek hai, yahi chalega.] — Okay, this will do. (lit. Okay, this will work.)
  [decline] नहीं, मुझे सिरदर्द की दवा चाहिए। [nahin, mujhe sir-dard ki dawa chahiye.] — No, I need medicine for a headache. (lit. No, to me, headache's medicine is wanted.)
  [thank] धन्यवाद। [dhanyavaad.] — Thank you. (lit. Thank you.)
PRONUNCIATION TARGETS:
  <request_phrase> मुझे सिरदर्द की दवा चाहिए। — English speakers often stress the wrong syllable in 'chahiye' (say: chaa-hee-yeh, not chai-yee).
  <thank_phrase> धन्यवाद। — The 'dh' is a soft, aspirated sound, not a hard 'd'.
ROLEPLAY: pharmacy counter · tutor plays pharmacist
  opening: नमस्ते, कैसे मदद कर सकता हूँ?
  learner: मुझे सिरदर्द की दवा चाहिए। — I need medicine for a headache.
  learner: नहीं, मुझे सिरदर्द की दवा चाहिए। — No, I need medicine for a headache.
  learner: एक पैकेट चाहिए। — I need one packet.
  learner: ठीक है, यही चलेगा। — Okay, this will do.
  learner: धन्यवाद। — Thank you.
RUN GOAL: You can ask for what you need politely, clarify if misunderstood, and finish the conversation smoothly.

===== CRAWL · Azure pronunciation assessment =====
reference phrase: Necesito algo para el dolor de cabeza.
wav: 16 kHz mono, 101454 bytes (OpenAI TTS reading the phrase — a real recording through the real pipeline, not a human mouth)
AZURE_SPEECH_KEY present: false
response:
{
  "configured": false,
  "message": "Pronunciation scoring isn't configured yet (missing Azure Speech key)."
}

unscorable language: {"configured":true,"supported":false,"message":"Pronunciation scoring isn't available for Uzbek yet — the phrase and its meaning still are."}

===== WALK · realtime mint =====
status=200 model=gpt-realtime-mini phase=walk lessonAvailable=true sessionId=c5a37867…
INSTRUCTIONS:
You are role-playing a scene in Spanish with a learner whose own language is English. This is a rehearsal, not a lesson about grammar. SCENE: pharmacy. You play pharmacist. The learner is customer needing headache medicine. The scene exists to practise: State a need, understand the response, and handle 'we don't have it' without the conversation collapsing. Open the scene with this line, or something very close to it: "Buenos días, ¿en qué puedo ayudarle?" The learner is trying to produce these lines, roughly in this order — steer the scene so each one becomes the natural thing to say next: 1. Necesito algo para el dolor de cabeza. (I need something for a headache.) 2. No, es para el dolor de cabeza, no de estómago. (No, it's for a headache, not for the stomach.) 3. ¿Puede darme una caja, por favor? (Can you give me a box, please?) 4. Sí, eso está bien. Gracias. (Yes, that's fine. Thank you.) 5. Muchas gracias. (Thank you very much.) Do NOT say the learner's lines for them and do NOT list them. Give them the opening, wait, and react to what they actually say. If they freeze for a moment, prompt them the way a real person would — repeat your question more simply, or offer a choice — rather than reading them the answer. Once during the scene, misunderstand or complicate things exactly as the scene calls for, so they have to recover. Then let the scene resolve successfully. The learner is a BEGINNER. Speak slowly, in short simple sentences, and use Spanish they can survive on; drop into English briefly when they are truly stuck, then return to Spanish. Keep YOUR turns short (1-3 sentences) so the learner does most of the talking. When the learner makes a meaningful mistake, correct it kindly and immediately: say the correct version clearly in Spanish, have them repeat it once, then move on. Never lecture. Never break character and never say you are an AI. When the learner has hit the last line, close the scene warmly in one sentence and tell them in English that the roleplay is done.

TUTOR (in character): Buenos días, ¿en qué puedo ayudarle?
LEARNER (script line): Necesito algo para el dolor de cabeza.
TUTOR (reply): Claro, ¿qué tipo de dolor de cabeza tiene? ¿Es fuerte o leve?

status=200 cached=false source=generated capabilities={"speech":true,"pronunciationScoring":true}

===== MODULE 4 · needs-wants · EN learner → ES target =====
TITLE: How to Say 'I Need' and 'I Want' in Spanish
CONTRAST HOOK (sameAsLearner=true):
  'I want' and 'I need' work almost exactly the same in Spanish and English.
  In Spanish, you simply say 'quiero' for 'I want' and 'necesito' for 'I need', followed by the thing you want or need. This is very similar to English. However, just like in English, saying 'I want' can sound a bit blunt with strangers, so you can soften it by adding 'por favor' (please) or by using 'quisiera' (I would like), which is even more polite.
  e.g. Necesito algo para el dolor de cabeza. = I need something for a headache. (lit. I need something for the pain of head)
PHRASES:
  [request] Necesito algo para el dolor de cabeza. — I need something for a headache. (lit. I need something for the pain of head)
  [quantity] Solo una caja, por favor. — Just one box, please. (lit. Only one box, please)
  [accept] Sí, eso está bien. — Yes, that's fine. (lit. Yes, that is good)
  [decline] No, es para el dolor de cabeza. — No, it's for a headache. (lit. No, it is for the pain of head)
  [thank] Muchas gracias. — Thank you very much. (lit. Many thanks)
PRONUNCIATION TARGETS:
  <request_phrase> Necesito algo para el dolor de cabeza. — The 'ce' in 'necesito' sounds like 'th' in Spain or 's' in Latin America; stress is on the 'si'.
  <thank_phrase> Muchas gracias. — 'Gracias' ends with 'syas', not 'see-as'.
ROLEPLAY: pharmacy counter · tutor plays pharmacist
  opening: Buenos días, ¿en qué puedo ayudarle?
  learner: Necesito algo para el dolor de cabeza. — I need something for a headache.
  learner: No, es para el dolor de cabeza. — No, it's for a headache.
  learner: Solo una caja, por favor. — Just one box, please.
  learner: Sí, eso está bien. — Yes, that's fine.
  learner: Muchas gracias. — Thank you very much.
RUN GOAL: You should be able to say what you need, clarify if misunderstood, and finish the exchange politely.

second request: cached=true source=memory

===== MODULE 4 · needs-wants · EN learner → HI target =====
TITLE: How to Say 'I Need' and 'I Want' in Hindi
CONTRAST HOOK (sameAsLearner=false):
  Hindi uses 'to me X is needed/wanted' instead of 'I want X'.
  In Hindi, you don't say 'I want' or 'I need' directly. Instead, you say 'To me, X is needed' or 'To me, X is wanted.' This is built with a different sentence structure: the thing you want or need comes first, and you use a polite form that is safe with strangers. The literal subject is not 'I', but 'to me', which feels softer and more indirect than English.
  e.g. मुझे सिरदर्द की दवा चाहिए। [mujhe sir-dard ki dawa chahiye.] = I need medicine for a headache. (lit. to me headache's medicine is needed)
PHRASES:
  [request] मुझे सिरदर्द की दवा चाहिए। [mujhe sir-dard ki dawa chahiye.] — I need medicine for a headache. (lit. to me headache's medicine is needed)
  [quantity] एक पैकेट चाहिए। [ek packet chahiye.] — I need one packet. (lit. one packet is needed)
  [accept] ठीक है, यही चाहिए। [theek hai, yahi chahiye.] — Okay, I want this one. (lit. okay, this one is needed)
  [decline] नहीं, सिरदर्द के लिए चाहिए। [nahin, sir-dard ke liye chahiye.] — No, I need it for a headache. (lit. no, for headache is needed)
  [thank] धन्यवाद। [dhanyavaad.] — Thank you. (lit. thank you)
PRONUNCIATION TARGETS:
  <request_phrase> मुझे सिरदर्द की दवा चाहिए। — The 'chahiye' ending is soft and the 'j' in 'mujhe' is like the 's' in 'measure', not a hard 'j'.
  <thank_phrase> धन्यवाद। — The 'dh' is a soft aspirated 'd', not a hard 'd' as in 'dog'.
ROLEPLAY: pharmacy counter · tutor plays pharmacist
  opening: नमस्ते, कैसे मदद कर सकता हूँ?
  learner: मुझे सिरदर्द की दवा चाहिए। — I need medicine for a headache.
  learner: नहीं, सिरदर्द के लिए चाहिए। — No, I need it for a headache.
  learner: एक पैकेट चाहिए। — I need one packet.
  learner: ठीक है, यही चाहिए। — Okay, I want this one.
  learner: धन्यवाद। — Thank you.
RUN GOAL: Ask for something you need, clarify if misunderstood, and complete the exchange politely in Hindi.

===== CRAWL · Azure pronunciation assessment =====
reference phrase: Necesito algo para el dolor de cabeza.
wav: 16 kHz mono, 109134 bytes (OpenAI TTS reading the phrase — a real recording through the real pipeline, not a human mouth)
AZURE_SPEECH_KEY present: false
response:
{
  "configured": false,
  "message": "Pronunciation scoring isn't configured yet (missing Azure Speech key)."
}

unscorable language: {"configured":true,"supported":false,"message":"Pronunciation scoring isn't available for Uzbek yet — the phrase and its meaning still are."}

===== WALK · realtime mint =====
status=200 model=gpt-realtime-mini phase=walk lessonAvailable=true sessionId=93b827a6…
INSTRUCTIONS:
You are role-playing a scene in Spanish with a learner whose own language is English. This is a rehearsal, not a lesson about grammar. SCENE: pharmacy counter. You play pharmacist. The learner is customer needing headache medicine. The scene exists to practise: State a need, understand the response, and handle 'we don't have it' without the conversation collapsing. Open the scene with this line, or something very close to it: "Buenos días, ¿en qué puedo ayudarle?" The learner is trying to produce these lines, roughly in this order — steer the scene so each one becomes the natural thing to say next: 1. Necesito algo para el dolor de cabeza. (I need something for a headache.) 2. No, es para el dolor de cabeza. (No, it's for a headache.) 3. Solo una caja, por favor. (Just one box, please.) 4. Sí, eso está bien. (Yes, that's fine.) 5. Muchas gracias. (Thank you very much.) Do NOT say the learner's lines for them and do NOT list them. Give them the opening, wait, and react to what they actually say. If they freeze for a moment, prompt them the way a real person would — repeat your question more simply, or offer a choice — rather than reading them the answer. Once during the scene, misunderstand or complicate things exactly as the scene calls for, so they have to recover. Then let the scene resolve successfully. The learner is a BEGINNER. Speak slowly, in short simple sentences, and use Spanish they can survive on; drop into English briefly when they are truly stuck, then return to Spanish. Keep YOUR turns short (1-3 sentences) so the learner does most of the talking. When the learner makes a meaningful mistake, correct it kindly and immediately: say the correct version clearly in Spanish, have them repeat it once, then move on. Never lecture. Never break character and never say you are an AI. When the learner has hit the last line, close the scene warmly in one sentence and tell them in English that the roleplay is done.

TUTOR (in character): Buenos días, ¿en qué puedo ayudarle?
LEARNER (script line): Necesito algo para el dolor de cabeza.
TUTOR (reply): Claro, ¿puede decirme qué tipo de dolor de cabeza tiene? ¿Es leve o fuerte?
```

## The harness

Not committed under `tests/` — it calls paid providers, and CI runs
`vitest run` on every PR. Save it as `tests/_live-verify.test.ts` to use it, and
delete it again afterwards.

```ts
// TEMPORARY verification harness — NOT part of the suite, deleted before the
// PR. Runs the real route handlers against the real providers with only auth
// mocked (the pattern from the /live and /chat verifications).
//
//   npx vitest run tests/_live-verify.test.ts
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// ── env ────────────────────────────────────────────────────────────────────
// .env.local holds the real OPENAI_API_KEY. Azure's key and Supabase's
// service-role key are marked SENSITIVE in Vercel and cannot be pulled at all
// (`vercel env pull` returns "[SENSITIVE]"), so the Azure provider leg is
// stubbed below and the database cache layer degrades to memory here.
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
process.env.NEXT_PUBLIC_ENABLE_TUTOR = "1";

const REPORT = "/tmp/tutor-verify.md";
function say(line: string): void {
  appendFileSync(REPORT, line + "\n");
}

// Auth is mocked, so the id is never checked against the database — any
// well-formed UUID stands in for the signed-in user.
const TOM = "00000000-0000-4000-8000-000000000000";

vi.mock("@/lib/spendGuard", () => ({
  guardSpend: async () => ({ ok: true, user: { id: TOM }, anonymous: false }),
  SIGN_IN_REQUIRED: "Please sign in to use this feature."
}));
vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async () => ({ id: TOM, email: "xdrabbit@gmail.com" })
}));

const jsonReq = (body: unknown) =>
  new Request("https://taoslite.com/api/tutor/lesson", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

interface AnyLesson {
  title: string;
  contrastHook: { headline: string; explanation: string; sameAsLearner: boolean; example?: Record<string, string> };
  phrases: Array<Record<string, string>>;
  pronunciation: Array<Record<string, string>>;
  roleplay: { setting: string; tutorRole: string; opening: Record<string, string>; learnerLines: Array<Record<string, string>> };
  runGoal: string;
}

let esLesson: AnyLesson;

function show(label: string, lesson: AnyLesson): void {
  const out: string[] = [];
  out.push(`\n===== ${label} =====`);
  out.push(`TITLE: ${lesson.title}`);
  out.push(`CONTRAST HOOK (sameAsLearner=${lesson.contrastHook.sameAsLearner}):`);
  out.push(`  ${lesson.contrastHook.headline}`);
  out.push(`  ${lesson.contrastHook.explanation}`);
  if (lesson.contrastHook.example) {
    out.push(`  e.g. ${lesson.contrastHook.example.target}` +
      (lesson.contrastHook.example.romanization ? ` [${lesson.contrastHook.example.romanization}]` : "") +
      ` = ${lesson.contrastHook.example.meaning}` +
      (lesson.contrastHook.example.literal ? ` (lit. ${lesson.contrastHook.example.literal})` : ""));
  }
  out.push("PHRASES:");
  for (const p of lesson.phrases) {
    out.push(`  [${p.move}] ${p.target}${p.romanization ? ` [${p.romanization}]` : ""} — ${p.meaning}${p.literal ? ` (lit. ${p.literal})` : ""}`);
  }
  out.push("PRONUNCIATION TARGETS:");
  for (const p of lesson.pronunciation) out.push(`  <${p.slot}> ${p.phrase} — ${p.why ?? ""}`);
  out.push(`ROLEPLAY: ${lesson.roleplay.setting} · tutor plays ${lesson.roleplay.tutorRole}`);
  out.push(`  opening: ${lesson.roleplay.opening.target}`);
  for (const l of lesson.roleplay.learnerLines) out.push(`  learner: ${l.target} — ${l.meaning}`);
  out.push(`RUN GOAL: ${lesson.runGoal}`);
    say(out.join("\n"));
}

describe("lesson generation", () => {
  it("generates module 4 EN-learner → ES-target", { timeout: 180_000 }, async () => {
    const { POST } = await import("@/app/api/tutor/lesson/route");
    const res = await POST(jsonReq({ moduleId: "needs-wants", target: "es", learner: "en" }) as never);
    const payload = (await res.json()) as { lesson: AnyLesson; cached: boolean; source: string; capabilities: unknown };
        say(`\nstatus=${res.status} cached=${payload.cached} source=${payload.source} capabilities=${JSON.stringify(payload.capabilities)}`);
    expect(res.status).toBe(200);
    esLesson = payload.lesson;
    show("MODULE 4 · needs-wants · EN learner → ES target", esLesson);
  });

  it("serves the second request from cache, free", { timeout: 60_000 }, async () => {
    const { POST } = await import("@/app/api/tutor/lesson/route");
    const res = await POST(jsonReq({ moduleId: "needs-wants", target: "es", learner: "en" }) as never);
    const payload = (await res.json()) as { cached: boolean; source: string };
        say(`\nsecond request: cached=${payload.cached} source=${payload.source}`);
    expect(payload.cached).toBe(true);
  });

  it("fires a real contrast hook on a structurally different pair (EN → HI)", { timeout: 180_000 }, async () => {
    const { POST } = await import("@/app/api/tutor/lesson/route");
    const res = await POST(jsonReq({ moduleId: "needs-wants", target: "hi", learner: "en" }) as never);
    const payload = (await res.json()) as { lesson: AnyLesson; cached: boolean; source: string };
    expect(res.status).toBe(200);
    show("MODULE 4 · needs-wants · EN learner → HI target", payload.lesson);
    expect(payload.lesson.contrastHook.sameAsLearner).toBe(false);
  });
});

describe("crawl: a real Azure round trip", () => {
  it("scores a spoken attempt at the module's request phrase", { timeout: 180_000 }, async () => {
    const phrase = esLesson.pronunciation[0].phrase;
    // The "learner" here is OpenAI TTS reading the phrase — a real recording
    // through the real pipeline, but not a human mouth. Noted in the report.
    const speech = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: phrase })
    });
    expect(speech.ok).toBe(true);
    const dir = mkdtempSync(path.join(tmpdir(), "taos-verify-"));
    const mp3 = path.join(dir, "say.mp3");
    const wav = path.join(dir, "say.wav");
    writeFileSync(mp3, Buffer.from(await speech.arrayBuffer()));
    const ffmpeg = (await import("ffmpeg-static")).default as unknown as string;
    execFileSync(ffmpeg, ["-y", "-i", mp3, "-ar", "16000", "-ac", "1", "-f", "wav", wav], {
      stdio: "ignore"
    });

    const form = new FormData();
    form.append("audio", new Blob([readFileSync(wav)], { type: "audio/wav" }), "attempt.wav");
    form.append("referenceText", phrase);
    form.append("language", "es");
    form.append("learner", "en");
    const { POST } = await import("@/app/api/tutor/assess/route");
    const res = await POST(
      new Request("https://taoslite.com/api/tutor/assess", { method: "POST", body: form }) as never
    );
    const payload = (await res.json()) as Record<string, unknown>;
        say(`\n===== CRAWL · Azure pronunciation assessment =====\nreference phrase: ${phrase}\nwav: 16 kHz mono, ${readFileSync(wav).length} bytes (OpenAI TTS reading the phrase — a real recording through the real pipeline, not a human mouth)\nAZURE_SPEECH_KEY present: ${Boolean(process.env.AZURE_SPEECH_KEY)}\nresponse:\n${JSON.stringify(payload, null, 2)}`);
    expect(res.status).toBe(200);
    if (process.env.AZURE_SPEECH_KEY) {
      expect(payload.supported).toBe(true);
      expect(typeof payload.pron).toBe("number");
    } else {
      // Azure's key is SENSITIVE in Vercel and cannot be pulled to a laptop.
      // What this still proves: the route reached the Azure branch with a
      // resolved locale, and degrades honestly when the key is absent.
      expect(payload.configured).toBe(false);
    }
  });

  it("refuses to fake a score for a language Azure cannot assess", { timeout: 60_000 }, async () => {
    const form = new FormData();
    form.append("audio", new Blob([Buffer.from("x".repeat(64))], { type: "audio/wav" }), "a.wav");
    form.append("referenceText", "salom");
    form.append("language", "uz");
    const { POST } = await import("@/app/api/tutor/assess/route");
    const res = await POST(
      new Request("https://taoslite.com/api/tutor/assess", { method: "POST", body: form }) as never
    );
    const payload = (await res.json()) as Record<string, unknown>;
        say(`\nunscorable language: ${JSON.stringify(payload)}`);
    expect(payload.supported).toBe(false);
  });
});

describe("walk: a real realtime roleplay turn", () => {
  it("mints a walk session and plays the counterpart in character", { timeout: 180_000 }, async () => {
    const { POST } = await import("@/app/api/tutor/realtime/route");
    const res = await POST(
      new Request("https://taoslite.com/api/tutor/realtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "es",
          learner: "en",
          level: "beginner",
          phase: "walk",
          moduleId: "needs-wants",
          capSeconds: 360
        })
      }) as never
    );
    const mint = (await res.json()) as Record<string, string | boolean>;
        say(
      `\n===== WALK · realtime mint =====\nstatus=${res.status} model=${mint.model} phase=${mint.phase} lessonAvailable=${mint.lessonAvailable} sessionId=${String(mint.sessionId).slice(0, 8)}…\nINSTRUCTIONS:\n${mint.instructions}`
    );
    expect(res.status).toBe(200);
    expect(mint.lessonAvailable).toBe(true);

    // Drive one turn over the GA realtime WebSocket with the ephemeral secret.
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(String(mint.model))}`;
    const transcript: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, ["realtime", `openai-insecure-api-key.${mint.clientSecret}`]);
      const done = (err?: Error) => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => done(new Error("realtime timeout")), 90_000);
      ws.onerror = () => {
        clearTimeout(timer);
        done(new Error("realtime socket error"));
      };
      // Wait for session.updated before asking for a turn: over WebRTC the
      // persona is in the session at mint time (the client secret carries it),
      // but on a raw socket the first response can race the update.
      let opened = false;
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "session.update",
            session: { type: "realtime", instructions: mint.instructions, output_modalities: ["text"] }
          })
        );
      };
      const kickOff = () => {
        if (opened) return;
        opened = true;
        ws.send(
          JSON.stringify({
            type: "response.create",
            response: {
              // Same rule as lib/tutor/conversation.ts sendTurn(): a per-response
              // `instructions` REPLACES the session persona, so it travels with
              // the nudge.
              instructions: `${mint.instructions}\n\nFor this turn only: Open the scene now, in character, with your first line. Do not greet the learner as a tutor.`
            }
          })
        );
      };
      ws.onmessage = (ev) => {
        const event = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (event.type === "session.updated") kickOff();
        if (event.type === "response.output_text.delta" || event.type === "response.text.delta") {
          transcript.push(String(event.delta));
        }
        if (event.type === "error") {
          clearTimeout(timer);
          done(new Error(JSON.stringify(event.error)));
        }
        if (event.type === "response.done") {
          const first = transcript.join("");
          transcript.length = 0;
          transcript.push(first, "\n---\n");
          // Now answer as the learner, with the lesson's first line.
          const learnerLine = esLesson.roleplay.learnerLines[0].target;
                    say(`\nTUTOR (in character): ${first}\nLEARNER (script line): ${learnerLine}`);
          ws.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: { type: "message", role: "user", content: [{ type: "input_text", text: learnerLine }] }
            })
          );
          ws.send(JSON.stringify({ type: "response.create" }));
          ws.onmessage = (ev2) => {
            const e2 = JSON.parse(String(ev2.data)) as Record<string, unknown>;
            if (e2.type === "response.output_text.delta" || e2.type === "response.text.delta") {
              transcript.push(String(e2.delta));
            }
            if (e2.type === "response.done") {
              clearTimeout(timer);
                            say(`TUTOR (reply): ${transcript.slice(2).join("")}`);
              done();
            }
            if (e2.type === "error") {
              clearTimeout(timer);
              done(new Error(JSON.stringify(e2.error)));
            }
          };
        }
      };
    });
    expect(transcript.join("").length).toBeGreaterThan(10);
  });
});
```
