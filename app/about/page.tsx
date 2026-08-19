import type { Metadata } from "next";
import {
  ABOUT_COPY,
  ABOUT_DESCRIPTION,
  ABOUT_TITLE,
  SUPPORT_EMAIL,
  type AboutCopy
} from "@/lib/about";
import { BUILD_LABEL } from "@/lib/version";

// The public about page. Every word of it lives in lib/about.ts, which also
// carries the rule this page is under: no personal names. The original signed
// dedication is preserved verbatim in docs/backstory.md.

export const metadata: Metadata = {
  title: ABOUT_TITLE,
  description: ABOUT_DESCRIPTION
};

function Section({ copy }: { copy: AboutCopy }): JSX.Element {
  return (
    <section lang={copy.lang}>
      <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-200/70">
        {copy.heading}
      </h2>
      <p className="mt-3 text-base leading-relaxed text-amber-50/80">{copy.body}</p>
      <p className="mt-4 text-sm text-amber-50/60">
        {copy.contactLabel} · {copy.contactHint} —{" "}
        <a
          href={`mailto:${SUPPORT_EMAIL}`}
          className="text-amber-200/90 underline underline-offset-2"
        >
          {SUPPORT_EMAIL}
        </a>
      </p>
    </section>
  );
}

export default function AboutPage(): JSX.Element {
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

        <article className="mt-10 rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.55)] p-7 sm:p-10">
          <h1 className="text-[clamp(1.9rem,6vw,2.8rem)] font-semibold leading-tight tracking-tight text-white">
            TAOS <span className="text-amber-200/70">· Real-time translation</span>
          </h1>

          {ABOUT_COPY.map((copy, i) => (
            <div key={copy.lang} className={i === 0 ? "mt-8" : "mt-8 border-t border-white/10 pt-8"}>
              <Section copy={copy} />
            </div>
          ))}
        </article>

        <p className="mt-8 text-center text-xs tracking-wider text-amber-100/30">{BUILD_LABEL}</p>
      </div>
    </main>
  );
}
