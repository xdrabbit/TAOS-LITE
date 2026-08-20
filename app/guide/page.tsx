import type { Metadata } from "next";
import {
  GUIDE_DESCRIPTION,
  GUIDE_SECTIONS,
  GUIDE_TITLE,
  type Bilingual,
  type GuideEntry,
  type GuideSection
} from "@/lib/guide";
import { BUILD_LABEL } from "@/lib/version";

// The quick-start page. Every word lives in lib/guide.ts, which also carries
// the rules it is under: no personal names, and every control it names is
// quoted from the screen it actually lives on.
//
// Deliberately NOT behind SessionGate. Step one of this page is "sign in", so
// gating it on a session would be a door that asks you to read the sign on
// the other side of it. Same reason /about is open.
//
// Bilingual layout: English block, then Spanish block, per section rather
// than per page. A Spanish reader skimming for the Table section finds it in
// the same place their English-reading companion did, one paragraph lower —
// instead of scrolling past the whole guide to reach a mirrored copy.

export const metadata: Metadata = {
  title: GUIDE_TITLE,
  description: GUIDE_DESCRIPTION
};

/** The Spanish half of any block: same words, quieter, and marked lang="es". */
function EsLine({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <p lang="es" className="mt-1.5 text-sm leading-relaxed text-amber-100/45">
      {children}
    </p>
  );
}

function Entry({ copy, step }: { copy: GuideEntry; step?: number }): JSX.Element {
  return (
    <li className="flex gap-3">
      {/* Install is an ordered procedure, so its badges count 1·2·3. Every
          other section is a list of independent things, where a number would
          imply an order that isn't there — those get the icon instead. */}
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-amber-300/20 bg-amber-400/5 text-base"
      >
        {step === undefined ? copy.icon : <span className="text-sm font-semibold text-amber-200">{step}</span>}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold tracking-tight text-amber-200">{copy.label}</p>
        <p lang="en" className="mt-1 text-sm leading-relaxed text-amber-50/80">
          {copy.body.en}
        </p>
        <EsLine>{copy.body.es}</EsLine>
        {copy.example ? (
          <p className="mt-2.5 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[13px] leading-snug text-amber-100/60">
            <span lang="en">{copy.example.en}</span>
            <span lang="es" className="mt-1 block text-amber-100/40">
              {copy.example.es}
            </span>
          </p>
        ) : null}
      </div>
    </li>
  );
}

function Footnote({ copy }: { copy: Bilingual }): JSX.Element {
  return (
    <p className="mt-5 border-t border-white/10 pt-4 text-[13px] leading-snug text-amber-100/45">
      <span lang="en">{copy.en}</span>
      <span lang="es" className="mt-1 block text-amber-100/30">
        {copy.es}
      </span>
    </p>
  );
}

function Section({ copy }: { copy: GuideSection }): JSX.Element {
  return (
    <section
      id={copy.id}
      className="rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.55)] p-5 sm:p-7"
    >
      <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-200/70">
        <span lang="en">{copy.heading.en}</span>
        <span aria-hidden="true" className="px-1.5 text-amber-100/25">
          ·
        </span>
        <span lang="es" className="text-amber-100/45">
          {copy.heading.es}
        </span>
      </h2>

      {copy.intro ? (
        <div className="mt-3">
          <p lang="en" className="text-base leading-relaxed text-amber-50/80">
            {copy.intro.en}
          </p>
          <EsLine>{copy.intro.es}</EsLine>
        </div>
      ) : null}

      <ul className="mt-5 flex flex-col gap-5">
        {copy.entries.map((entry, i) => (
          <Entry key={entry.label} copy={entry} step={copy.id === "install" ? i + 1 : undefined} />
        ))}
      </ul>

      {copy.footnote ? <Footnote copy={copy.footnote} /> : null}
    </section>
  );
}

export default function GuidePage(): JSX.Element {
  return (
    <main className="min-h-screen px-5 pb-16 pt-[calc(env(safe-area-inset-top)+1.5rem)]">
      <div className="mx-auto max-w-2xl">
        <header className="flex items-center justify-between py-2">
          <a href="/" className="text-lg font-semibold tracking-tight text-amber-200">
            TAOS·LITE
          </a>
          <a
            href="/"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm text-amber-100/80"
          >
            ← Home
          </a>
        </header>

        <div className="mt-8">
          <h1 className="text-[clamp(1.8rem,6vw,2.6rem)] font-semibold leading-tight tracking-tight text-white">
            How to use TAOS
          </h1>
          <p lang="es" className="mt-1 text-[clamp(1.1rem,4vw,1.4rem)] text-amber-200/60">
            Cómo usar TAOS
          </p>
        </div>

        <div className="mt-8 flex flex-col gap-4">
          {GUIDE_SECTIONS.map((copy) => (
            <Section key={copy.id} copy={copy} />
          ))}
        </div>

        <p className="mt-8 text-center text-sm">
          <a href="/about" className="text-amber-100/70 underline-offset-2 hover:underline">
            About TAOS · Acerca de TAOS
          </a>
        </p>

        <p className="mt-4 text-center text-xs tracking-wider text-amber-100/30">{BUILD_LABEL}</p>
      </div>
    </main>
  );
}
