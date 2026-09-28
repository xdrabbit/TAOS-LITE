// Gate Zero probe for gemini-3.5-live-translate-preview. Throwaway, not shipped.
// Usage: GEMINI_KEY=... node probe.mjs <wav> <targetLang> <variant> [trials]
// variant: baseline | sysinst-tu | sysinst-usted | canary | voice | text-turn |
//          field-register | field-instructions
// Streams the WAV in real time as 100ms 16kHz PCM chunks, then trailing silence,
// and reports what came back plus first-token / first-audio latency.
import { readFileSync, writeFileSync } from 'node:fs';

const [wavPath, target, variant = 'baseline', trialsArg = '1'] = process.argv.slice(2);
const KEY = process.env.GEMINI_KEY;
if (!KEY) throw new Error('GEMINI_KEY unset');
const MODEL = 'gemini-3.5-live-translate-preview';
const URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEY}`;

function pcmFromWav(path) {
  const b = readFileSync(path);
  let o = 12;
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === 'data') return b.subarray(o + 8, o + 8 + size);
    o += 8 + size;
  }
  throw new Error('no data chunk');
}

const TU = 'Translate informally. Always address the listener as tú, never usted.';
const USTED = 'Translate formally. Always address the listener as usted, never tú.';
const MEANING = 'Translate meaning-first: render idioms by their meaning, never word for word.';
const CANARY = 'Begin every translation with the English word PINEAPPLE.';

function setupFor(v) {
  const gen = {
    responseModalities: ['AUDIO'],
    translationConfig: { targetLanguageCode: target, echoTargetLanguage: false },
  };
  const setup = { model: `models/${MODEL}`, generationConfig: gen, inputAudioTranscription: {}, outputAudioTranscription: {} };
  if (v === 'sysinst-tu') setup.systemInstruction = { parts: [{ text: TU }] };
  if (v === 'sysinst-usted') setup.systemInstruction = { parts: [{ text: USTED }] };
  if (v === 'sysinst-meaning') setup.systemInstruction = { parts: [{ text: MEANING }] };
  if (v === 'sysinst-literal') setup.systemInstruction = { parts: [{ text: 'Translate strictly word for word, literally, even idioms.' }] };
  if (v === 'sysinst-french') setup.systemInstruction = { parts: [{ text: 'Always translate into French.' }] };
  if (v === 'taos-tu') setup.systemInstruction = { parts: [{ text: "Say what they said the way a fluent native speaker would say it — closest to the original meaning, no more and no less. Not word for word, not a summary. Keep every fact, name, number, and condition, and the feeling behind it. When a phrase has a natural equivalent in the target language, use it instead of the literal rendering (English \"let me see\" is Spanish \"a ver\", not \"déjame ver\"). Match the speaker's register: formal stays formal, casual stays casual. When the source language does not mark formality, use the familiar form (tú) — these are partners or friends. This is a standing rule for the whole conversation, not a one-time choice: address them in tú on every turn, the same way every time." }] };
  if (v === 'canary') setup.systemInstruction = { parts: [{ text: CANARY }] };
  if (v === 'voice') gen.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } };
  if (v === 'field-register') gen.translationConfig.register = 'informal';
  if (v === 'field-instructions') gen.translationConfig.instructions = TU;
  return { setup };
}

function trial(n) {
  return new Promise((resolve) => {
    const pcm = pcmFromWav(wavPath);
    const CHUNK = 3200; // 100ms @ 16kHz s16
    const ws = new WebSocket(URL);
    const r = { variant, n, inTx: '', outTx: '', audioBytes: 0, events: [], outAudio: [] };
    let t0 = 0, speechEnd = 0, timer, lastActivity = 0;
    const now = () => performance.now();
    const mark = (k) => { if (r[k] === undefined) r[k] = Math.round(now() - t0); };
    const finish = (why) => {
      clearInterval(timer);
      r.end = why;
      r.speechMs = Math.round(speechEnd - t0);
      try { ws.close(); } catch {}
      resolve(r);
    };
    ws.onopen = () => ws.send(JSON.stringify(setupFor(variant)));
    ws.onclose = (e) => { if (!r.end) { r.close = `${e.code} ${e.reason} @${Math.round(now() - t0)}`; finish('closed'); } };
    ws.onmessage = async (ev) => {
      const txt = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      const m = JSON.parse(txt);
      if (m.setupComplete) {
        r.events.push('setupComplete');
        if (variant === 'text-turn') {
          ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: TU }] }], turnComplete: true } }));
        }
        t0 = now();
        let i = 0;
        timer = setInterval(() => {
          const silence = Buffer.alloc(CHUNK);
          const off = i * CHUNK;
          const chunk = off < pcm.length ? pcm.subarray(off, off + CHUNK) : silence;
          if (off >= pcm.length && !speechEnd) speechEnd = now();
          ws.send(JSON.stringify({ realtimeInput: { audio: { data: Buffer.from(chunk).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
          i++;
          const idle = lastActivity && now() - lastActivity > 5000;
          if ((speechEnd && idle) || now() - t0 > (process.env.MAXMS ? +process.env.MAXMS : 30000)) finish(idle ? 'idle' : 'timeout');
        }, 100);
        return;
      }
      const sc = m.serverContent;
      if (sc?.inputTranscription?.text || sc?.outputTranscription?.text) lastActivity = now();
      if (sc?.inputTranscription?.text) { mark('firstInTxMs'); r.inTx += sc.inputTranscription.text; r.inLang ??= sc.inputTranscription.languageCode; }
      if (sc?.outputTranscription?.text) { mark('firstOutTxMs'); r.outTx += sc.outputTranscription.text; r.outLang ??= sc.outputTranscription.languageCode; }
      for (const p of sc?.modelTurn?.parts ?? []) {
        if (p.inlineData?.data) {
          mark('firstAudioMs');
          const buf = Buffer.from(p.inlineData.data, 'base64');
          let peak = 0;
          for (let j = 0; j + 1 < buf.length; j += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(j)));
          if (peak > 500) { mark('firstVoicedAudioMs'); r.lastVoicedAudioMs = Math.round(now() - t0); r.voicedBytes = (r.voicedBytes ?? 0) + buf.length; lastActivity = now(); }
          r.chunkSizes ??= new Set(); r.chunkSizes.add(buf.length);
          r.audioBytes += buf.length;
          r.outAudio.push(buf);
          r.lastAudioMs = Math.round(now() - t0);
          r.mime ??= p.inlineData.mimeType;
        }
      }
      if (sc?.turnComplete) r.events.push(`turnComplete@${Math.round(now() - t0)}`);
      if (m.usageMetadata) { r.usageMsgs = (r.usageMsgs ?? 0) + 1; r.usageLast = m.usageMetadata; r.promptSum = (r.promptSum ?? 0) + (m.usageMetadata.promptTokenCount ?? 0); r.respSum = (r.respSum ?? 0) + (m.usageMetadata.responseTokenCount ?? 0); }
      const other = Object.keys(m).filter((k) => !['serverContent', 'usageMetadata', 'sessionResumptionUpdate'].includes(k));
      if (other.length) { r.events.push(`@${Math.round(now() - t0)} ` + JSON.stringify(m).slice(0, 400)); if (process.env.LOUD) console.error(`@${Math.round(now() - t0)} ` + JSON.stringify(m).slice(0, 300)); }
    };
  });
}

const trials = Number(trialsArg);
for (let n = 1; n <= trials; n++) {
  const r = await trial(n);
  const audio = Buffer.concat(r.outAudio);
  delete r.outAudio; r.chunkSizes = [...(r.chunkSizes ?? [])].slice(0, 6);
  r.audioSec = +(audio.length / 48000).toFixed(2);
  writeFileSync(`out-${variant}-${target}-${n}.pcm`, audio);
  console.log(JSON.stringify(r));
}
