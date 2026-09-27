# Translations viewer

Browse every TAOS-LITE translation — live from Supabase or from a saved export
— with SQLite **FTS5** full-text search, date-range filtering, and JSON export.

```bash
node tools/translations-viewer/server.mjs
# → http://localhost:3018
```

`--port 3019` moves it. Port 3018 is used so it never collides with the app on
3017.

`--tailnet` also serves it on this machine's Tailscale address, so any of your
signed-in Tailscale devices can open it — no password, because Tailscale's
device sign-in is the gate. It is never exposed on the LAN, and requests from
anything other than loopback or a Tailscale (100.64.0.0/10) address get a 403.

## Why it is a local tool and not a page in the app

It reads **every user's** translations with the service-role key. That is not
something to put behind a web gate, so this process binds to `127.0.0.1`, the
key never reaches the browser, and nothing here is deployed to Vercel. It sits
outside `app/`, so Next never builds or bundles it.

## The two sources

**Live database** — pulls `public.taos_lite_translations` through PostgREST,
paging past the 1,000-row cap. It needs, in the environment or `.env.local`:

| Variable | Where it comes from |
| --- | --- |
| `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`) | Supabase dashboard → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | same page, "service_role" |

Vercel stores the service-role key as a *sensitive* variable, so
`vercel env pull` writes a placeholder instead of the real value — the repo's
`.env.local` currently holds an 11-character stub. The viewer detects that and
says so in the UI rather than showing a button that fails. Copy the real key
from the Supabase dashboard to use the live source:

```bash
SUPABASE_URL=https://<project-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<real key> \
node tools/translations-viewer/server.mjs
```

**Export file** — anything in `local_exports/`. No credentials needed, which
makes it the offline path. Three shapes are read:

- the existing NDJSON exports (manifest line, then `{record, source_table}`
  lines) — both `taos_lite_translations` and the translated
  `taos_lite_chat_messages` rows land in one index;
- JSON this viewer wrote (`{manifest, summary, records}`);
- a bare JSON array of records.

- a CSV with a header row (the Supabase dashboard's CSV export).

Unparsable lines are counted and skipped, not fatal — one bad line cannot hide
5,000 good ones.

**Everything** — the first picker entry loads live (when available) plus every
file in every folder, merged and de-duplicated. A record with an id is kept
once per id, and live is read first so its copy wins over a stale export. An
id-less record (some old exports have none) is dropped only if a kept record
has the same original, translation and `created_at` to the millisecond. The
stats line shows sources merged, duplicates removed, and anything not loaded
(hover for per-file detail).

**History folder** — older exports kept elsewhere show up as a second group in
the picker. Point at the folder with `TRANSLATIONS_HISTORY_DIR` (environment or
`.env.local`) or `--history <dir>`. Files there often have no extension
(`07142026`), so an extension-less file is listed if it opens like JSON, and
the date is read from the name (`20260909`, `07142026` = MMDDYYYY, `822026` =
MDYYYY) because copied files' timestamps mean nothing. A JSON file with no
translation text in it (say, a location history) is refused with a message
rather than loaded as empty rows.

## Searching

The box is **not** raw FTS5 — it is translated into it, so that an apostrophe,
a hyphen or `¿` can never be a syntax error:

| You type | FTS5 gets | Finds |
| --- | --- | --- |
| `camino` | `"camino"` | the whole word, any case, accents ignored |
| `how much` | `"how" AND "much"` | rows with both |
| `"on my way"` | `"on my way"` | that exact phrase |
| `doctor OR hospital` | `"doctor" OR "hospital"` | either |
| `ayud*` | `"ayud"*` | ayuda, ayudar, ayudame… |
| `well-being` | `"well being"` | the hyphenated word (FTS5 split it on input) |

Accents and case are folded (`unicode61 remove_diacritics 2`), so `adios`
finds `adiós`. Tick **Raw FTS5 syntax** to pass your own expression through
unaltered — `NEAR(doctor hospital, 10)`, column filters, and so on. A syntax
error there comes back as a readable message, not a 500.

**Dates** filter on `created_at`. A bare `YYYY-MM-DD` is read as a *local* day,
and **To** includes the whole of that day.

Text search, dates, language, engine and source table all combine.

## In context, and lessons (prototype)

Click a result to open it **in context**: the full message with your search
words highlighted, and that person's messages just before and after it. The
results list stays where it is; ↑/↓ (or k/j) step through results, Esc closes.

**Lesson** (a button on each message), or select some text in the panel and
press **Make a lesson from this**. The picked message and a few neighbours
(never the history) go to OpenAI, and a breakdown comes back: the words, why
they're in that order (with the mistake an English speaker would make, struck
through), what it means in context, and build-up chunks to say out loud.

- **Learning / Explained in** (top of the context panel, remembered per
  browser) set the language being taught and the language the lesson is
  written in, headings included (English and Spanish chrome; other
  languages get English headings). The same message makes a different lesson
  per direction: Tom learns Spanish from it, and Liz can learn English from
  it explained in Spanish, with a Spanish speaker's mistakes ("I have there
  some ravioli"). A message without the chosen language says so instead of
  guessing. Lessons made before this keep their ids.
- Model: `gpt-5.5` by default, or `TRANSLATIONS_LESSON_MODEL`. `gpt-4.1` was
  tried first and marked correct, flexible word orders as mistakes.
- It's slow: about 15 seconds a sentence.
- **Every lesson is saved** as it's made, one owner-only file per lesson in
  `local_exports/lessons/` (gitignored). A lesson is keyed on the source
  message's database id plus your exact selection, so reopening the same
  message, even after a restart or a different load, shows the saved lesson
  without paying again. **Lessons** in the header opens the library: filter,
  open, add a note, Regenerate (keeps your note), Delete (tap twice), and
  Open in context (when the loaded data contains the message).
- The word-for-word line is built from each word's own gloss, not written by
  the model, so it can't drift back into English order.
- **Practice**: each sentence and each build-up chunk has ▶ (hear it in Liz's
  cloned voice, `ELEVENLABS_LIZ_VOICE_ID`), 🐢 (slower), and ● Say it
  (record, then Azure Pronunciation Assessment scores it, es → es-MX). You
  get an overall score, every word coloured, and pronunciation / flow /
  completeness with a hint naming what cost you. Attempts are saved on the
  lesson ("best 87"). Audio is cached in `local_exports/lessons/audio/`.
  Recording needs a secure page: on another machine use
  **https://blackbird.tail42ac25.ts.net:3019** (tailnet-only `tailscale
  serve`; ports 443/8443/10000 belong to other projects' public Funnels).
  Scoring needs the real `AZURE_SPEECH_KEY` in `.env.local`.
- A silent recording is caught in the browser (peak level) rather than sent
  to Azure. A live mic can deliver silence without any error.

## Exporting

- **Export JSON ↓** downloads the current filtered set.
- **Save to local_exports** writes the same thing next to the other exports,
  where this viewer can load it straight back.

Both write `{manifest, summary, records}`. The manifest records which source
the rows came from, the filters in force, and the exact FTS5 expression that
produced them — so an export can be explained later, and the file round-trips
back into the viewer.

## The SQLite dependency

FTS5 is the whole point, and the usual `sql.js` build **does not ship it**
(`no such module: fts5`). This uses the SQLite project's own WASM
distribution, which does. It is fetched once into `vendor/` (gitignored) on
first run and used offline afterwards — deliberately *not* added to the
repo's `package.json`, which the app's build depends on.

Delete `vendor/` to force a refetch.

## Tests

`tests/translations-viewer.test.ts` pins the search contract — the query
translation, the inclusive end-of-day date bound, the export shapes, and a
real FTS5 index. The FTS5 block skips itself when `vendor/` is absent, so CI
runs offline; everything else always runs.
