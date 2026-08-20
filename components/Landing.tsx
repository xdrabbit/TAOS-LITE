"use client";

import { COMING_SOON, tutorComingSoon } from "@/lib/release";

// Tutor is gated off for v1.0.0 (lib/release.ts), and this page is the
// storefront a stranger scans a QR code into. Everything tutor touches —
// the conversation tutor, the drills, the progress tracking, the minutes on
// every plan, the add-on packs — is marked `tutor: true` here and renders
// with a "Coming soon" badge until NEXT_PUBLIC_ENABLE_TUTOR=1. The line
// items stay: the plans are priced around tutor and it comes back. They just
// stop reading as things you can do the day you pay.
const FEATURES: { title: string; body: string; icon: string; tutor?: boolean }[] = [
  {
    icon: "🎙️",
    title: "Live voice translation",
    body: "Speak a full thought and hear it back in the other language in seconds. Auto-detects English or Spanish, natural voices, saved history."
  },
  {
    icon: "💬",
    title: "Conversation tutor",
    body: "A hands-free AI tutor that talks with you, listens, and corrects your pronunciation as you go — steer it to any topic.",
    tutor: true
  },
  {
    icon: "📈",
    title: "Pronunciation drills",
    body: "Repeat-after-me drills with real phoneme scoring and progress, so you actually improve — not just translate.",
    tutor: true
  }
];

const PLANS: {
  name: string;
  price: string;
  per?: string;
  features: { text: string; tutor?: boolean }[];
  cta: string;
  highlight?: boolean;
}[] = [
  {
    name: "Free",
    price: "$0",
    features: [
      { text: "25 translations / month" },
      { text: "15 tutor minutes / month", tutor: true },
      { text: "Drills & progress", tutor: true }
    ],
    cta: "Start free"
  },
  {
    name: "Basic",
    price: "$5.99",
    per: "/ mo",
    features: [
      { text: "Unlimited translation" },
      { text: "45 tutor minutes / month", tutor: true },
      { text: "Drills & progress", tutor: true }
    ],
    cta: "Choose Basic"
  },
  {
    name: "Premium",
    price: "$19.99",
    per: "/ mo",
    features: [
      { text: "Unlimited translation" },
      { text: "200 tutor minutes / month", tutor: true },
      { text: "Add-on minute packs", tutor: true }
    ],
    cta: "Choose Premium",
    highlight: true
  }
];

// One badge, used at three sizes: on a feature card, beside a plan line item,
// and inline in a sentence. Kept here rather than in a shared component
// because /translate never needs it — the app itself simply has no tutor link
// while the flag is off, so there is nothing there to label.
function ComingSoonBadge({ className }: { className?: string }): JSX.Element {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full border border-amber-300/30 bg-amber-400/10 px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-amber-200/90 ${className ?? ""}`}
    >
      {COMING_SOON}
    </span>
  );
}

// Smiley TAOS — the brand mascot (the friendly face that lives in the "O").
function TaosMascot({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 120 120"
      className={className}
      role="img"
      aria-label="TAOS mascot"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="taosFace" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1c1712" />
          <stop offset="100%" stopColor="#0e0b08" />
        </linearGradient>
      </defs>
      <rect x="12" y="14" width="96" height="92" rx="34" fill="url(#taosFace)" stroke="#fbbf24" strokeWidth="4" />
      <circle cx="46" cy="54" r="6.5" fill="#fbbf24" />
      <circle cx="74" cy="54" r="6.5" fill="#fbbf24" />
      <path d="M40 66 Q60 88 80 66" fill="none" stroke="#fbbf24" strokeWidth="6.5" strokeLinecap="round" />
    </svg>
  );
}

export function Landing({ onSignIn }: { onSignIn: () => void }): JSX.Element {
  // Read once per render rather than per line item: it is a build-time
  // constant in the browser bundle, and reading it in one place is what makes
  // the whole page flip back together when tutor returns.
  const comingSoon = tutorComingSoon();

  return (
    <main className="min-h-screen px-5 pb-16 pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <header className="flex items-center justify-between py-2">
          <span className="flex items-center gap-2 text-lg font-semibold tracking-tight text-amber-200">
            <TaosMascot className="h-7 w-7" />
            TAOS·LITE
          </span>
          <button
            type="button"
            onClick={onSignIn}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm text-amber-100/80 transition hover:bg-white/10"
          >
            Sign in
          </button>
        </header>

        {/* Hero */}
        <section className="flex flex-col items-center gap-5 py-10 text-center">
          <TaosMascot className="h-24 w-24 drop-shadow-[0_0_34px_rgba(251,191,36,0.35)]" />
          <h1 className="text-pretty text-[clamp(2.2rem,8vw,3.6rem)] font-semibold leading-[1.05] tracking-tight text-white">
            Talk across languages,
            <br />
            then actually learn one.
          </h1>
          <p className="max-w-xl text-balance text-lg text-amber-50/70">
            The easiest way for two people to understand each other on one phone. Real-time voice
            that keeps your meaning and tone — not robotic word-for-word — plus an AI tutor that
            talks back{comingSoon ? <ComingSoonBadge className="mx-1.5 align-middle" /> : null}. Made
            for couples, families, and caregivers.
          </p>
          <p className="text-xs uppercase tracking-[0.25em] text-amber-200/70">
            Speak · Translate · Learn
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={onSignIn}
              className="rounded-2xl bg-amber-400 px-6 py-3 text-lg font-semibold text-stone-950 transition hover:bg-amber-300"
            >
              Start free
            </button>
            <a
              href="/try"
              className="rounded-2xl border border-amber-300/30 bg-white/5 px-6 py-3 text-lg font-medium text-amber-100 transition hover:bg-white/10"
            >
              Try it now, no signup
            </a>
          </div>
          <p className="text-xs text-amber-100/40">No credit card to start · cancel anytime</p>
        </section>

        {/* Features */}
        <section className="grid gap-3 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.6)] p-5"
            >
              <div className="text-2xl">{f.icon}</div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-white">{f.title}</h3>
                {f.tutor && comingSoon ? <ComingSoonBadge /> : null}
              </div>
              <p className="mt-1 text-sm text-amber-50/65">{f.body}</p>
            </div>
          ))}
        </section>

        {/* Pricing */}
        <section className="mt-14">
          <h2 className="text-center text-2xl font-semibold tracking-tight text-amber-200">
            Simple pricing
          </h2>
          <p className="mt-1 text-center text-sm text-amber-100/50">
            {comingSoon
              ? "Start free. Paid plans lift the translation limit today; the tutor minutes below unlock when the tutor arrives."
              : "Start free. Upgrade when you want more tutor time."}
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {PLANS.map((p) => (
              <div
                key={p.name}
                className={`flex flex-col rounded-3xl border p-5 ${
                  p.highlight
                    ? "border-amber-300/40 bg-amber-400/5"
                    : "border-white/10 bg-[rgba(20,16,14,0.7)]"
                }`}
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-lg font-semibold text-white">{p.name}</span>
                  <span className="text-amber-100/80">
                    <span className="text-xl font-semibold text-white">{p.price}</span>
                    {p.per ? <span className="text-sm"> {p.per}</span> : null}
                  </span>
                </div>
                <ul className="mt-3 flex flex-1 flex-col gap-1.5 text-sm text-amber-50/80">
                  {p.features.map((x) => {
                    const pending = x.tutor === true && comingSoon;
                    return (
                      <li key={x.text} className={pending ? "text-amber-50/45" : undefined}>
                        {pending ? "·" : "✓"} {x.text}
                        {pending ? <ComingSoonBadge className="ml-1.5 align-middle" /> : null}
                      </li>
                    );
                  })}
                </ul>
                <button
                  type="button"
                  onClick={onSignIn}
                  className={`mt-4 w-full rounded-2xl px-5 py-2.5 text-base font-semibold transition ${
                    p.highlight
                      ? "bg-amber-400 text-stone-950 hover:bg-amber-300"
                      : "border border-amber-300/30 bg-white/5 text-amber-100 hover:bg-white/10"
                  }`}
                >
                  {p.cta}
                </button>
              </div>
            ))}
          </div>
          <p className="mt-3 text-center text-xs text-amber-100/40">
            Heavy user? Premium adds 200 tutor minutes a month, with add-on packs when you need
            more.{" "}
            {comingSoon ? (
              <span className="text-amber-200/70">
                Tutor minutes, drills and progress are {COMING_SOON.toLowerCase()} — every plan
                translates without limit in the meantime.
              </span>
            ) : null}
          </p>
        </section>

        {/* Footer CTA */}
        <section className="mt-16 flex flex-col items-center gap-4 rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.6)] p-8 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-white">
            Ready to be understood?
          </h2>
          <button
            type="button"
            onClick={onSignIn}
            className="rounded-2xl bg-amber-400 px-6 py-3 text-lg font-semibold text-stone-950 transition hover:bg-amber-300"
          >
            Start free
          </button>
        </section>

        <footer className="mt-10 flex flex-col items-center gap-1 text-center">
          {/* The storefront is handed to strangers (a QR at a table), so this
              link is named for what it reaches. It used to reach a signed
              dedication and read "Why we built TAOS"; on 8/19 /about became a
              product page, and the dedication moved to docs/backstory.md. */}
          {/* The quick start sits above About on purpose: a visitor who got
              here from a QR code wants to know how to USE it before they want
              to know what it is. */}
          <a
            href="/guide"
            className="text-sm text-amber-100/70 underline-offset-2 hover:underline"
          >
            How to use TAOS · Cómo usar TAOS
          </a>
          <a
            href="/about"
            className="text-sm text-amber-100/70 underline-offset-2 hover:underline"
          >
            About TAOS · Acerca de TAOS
          </a>
          <span className="text-xs text-amber-100/30">
            © {new Date().getFullYear()} TAOS ·{" "}
            {comingSoon
              ? "Real-time translation for the people in front of you"
              : "Real-time translation & language tutoring"}
          </span>
        </footer>
      </div>
    </main>
  );
}
