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

export function Landing({ onSignIn }: { onSignIn: () => void }): JSX.Element {
  return (
    <main className="min-h-screen px-5 pb-16 pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <header className="flex items-center justify-between py-2">
          <span className="text-lg font-semibold tracking-tight text-amber-200">TAOS·LITE</span>
          <button
            type="button"
            onClick={onSignIn}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm text-amber-100/80 transition hover:bg-white/10"
          >
            Sign in
          </button>
        </header>

        {/* Hero */}
        <section className="flex flex-col items-center gap-5 py-12 text-center">
          <h1 className="text-pretty text-[clamp(2.2rem,8vw,3.6rem)] font-semibold leading-[1.05] tracking-tight text-white">
            Talk across languages,
            <br />
            then actually learn one.
          </h1>
          <p className="max-w-xl text-balance text-lg text-amber-50/70">
            Real-time voice translation plus an AI tutor that talks back and fixes your
            pronunciation. Speak, be understood, and improve — all in one app.
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

        <footer className="mt-10 text-center text-xs text-amber-100/30">
          © {new Date().getFullYear()} TAOS · Real-time translation & language tutoring
        </footer>
      </div>
    </main>
  );
}
