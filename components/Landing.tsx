"use client";

const FEATURES: { title: string; body: string; icon: string }[] = [
  {
    icon: "🎙️",
    title: "Live voice translation",
    body: "Speak a full thought and hear it back in the other language in seconds. Auto-detects English or Spanish, natural voices, saved history."
  },
  {
    icon: "💬",
    title: "Conversation tutor",
    body: "A hands-free AI tutor that talks with you, listens, and corrects your pronunciation as you go — steer it to any topic."
  },
  {
    icon: "📈",
    title: "Pronunciation drills",
    body: "Repeat-after-me drills with real phoneme scoring and progress, so you actually improve — not just translate."
  }
];

const PLANS: {
  name: string;
  price: string;
  per?: string;
  features: string[];
  cta: string;
  highlight?: boolean;
}[] = [
  {
    name: "Free",
    price: "$0",
    features: ["25 translations / month", "15 tutor minutes / month", "Drills & progress"],
    cta: "Start free"
  },
  {
    name: "Basic",
    price: "$5.99",
    per: "/ mo",
    features: ["Unlimited translation", "45 tutor minutes / month", "Drills & progress"],
    cta: "Choose Basic"
  },
  {
    name: "Premium",
    price: "$19.99",
    per: "/ mo",
    features: ["Unlimited translation", "200 tutor minutes / month", "Add-on minute packs"],
    cta: "Choose Premium",
    highlight: true
  }
];

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
            talks back. Made for couples, families, and caregivers.
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
              <h3 className="mt-2 text-base font-semibold text-white">{f.title}</h3>
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
            Start free. Upgrade when you want more tutor time.
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
                  {p.features.map((x) => (
                    <li key={x}>✓ {x}</li>
                  ))}
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
            Heavy user? Premium adds 200 tutor minutes a month, with add-on packs when you need more.
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
          <a
            href="/about"
            className="text-sm text-amber-100/70 underline-offset-2 hover:underline"
          >
            Made for Lizmariett Marquez <span aria-hidden>❤️</span>
          </a>
          <span className="text-xs text-amber-100/30">
            © {new Date().getFullYear()} TAOS · Real-time translation &amp; language tutoring
          </span>
        </footer>
      </div>
    </main>
  );
}
