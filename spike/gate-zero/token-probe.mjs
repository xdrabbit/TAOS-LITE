// Gate Zero, part 2: can a SERVER mint an ephemeral token for this model with
// the translation config and the system instruction LOCKED into it, and can a
// client that holds only that token run the session? Throwaway.
// Usage: GEMINI_KEY=... node token-probe.mjs <wav> <target>
import { readFileSync } from 'node:fs';

const [wavPath = 'neutral.wav', target = 'es'] = process.argv.slice(2);
const KEY = process.env.GEMINI_KEY;
const MODEL = 'gemini-3.5-live-translate-preview';
const RULE = 'When the source language does not mark formality, use the familiar form (tú) — these are partners or friends. Address them in tú on every turn.';

const now = Date.now();
const res = await fetch(`https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=${KEY}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    uses: 1,
    expireTime: new Date(now + 30 * 60_000).toISOString(),
    newSessionExpireTime: new Date(now + 60_000).toISOString(),
    bidiGenerateContentSetup: {
      model: `models/${MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        translationConfig: { targetLanguageCode: target, echoTargetLanguage: false }
      },
      systemInstruction: { parts: [{ text: RULE }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    }
  })
});
const tok = await res.json();
console.log('mint', res.status, tok.name ? 'name=auth_tokens/<redacted>' : JSON.stringify(tok).slice(0, 600));
if (!tok.name) process.exit(1);

const pcm = (() => {
  const b = readFileSync(wavPath);
  let o = 12;
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === 'data') return b.subarray(o + 8, o + 8 + size);
    o += 8 + size;
  }
})();

const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(tok.name)}`;
const ws = new WebSocket(url);
let out = '', inTx = '', timer, t0;
ws.onopen = () => ws.send(JSON.stringify({ setup: {} })); // everything comes from the token
ws.onclose = (e) => { console.log('close', e.code, e.reason.slice(0, 300)); console.log('in :', inTx); console.log('out:', out); process.exit(0); };
ws.onmessage = async (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text());
  if (m.setupComplete) {
    console.log('setupComplete');
    t0 = performance.now();
    let i = 0;
    timer = setInterval(() => {
      const off = i++ * 3200;
      const chunk = off < pcm.length ? pcm.subarray(off, off + 3200) : Buffer.alloc(3200);
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: Buffer.from(chunk).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
      if (performance.now() - t0 > 14000) { clearInterval(timer); ws.close(); }
    }, 100);
    return;
  }
  const sc = m.serverContent;
  if (sc?.inputTranscription?.text) inTx += sc.inputTranscription.text;
  if (sc?.outputTranscription?.text) out += sc.outputTranscription.text;
  if (m.goAway) console.log('goAway', JSON.stringify(m.goAway));
};
