import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About TAOS · Made for Lizmariett Marquez",
  description:
    "TAOS was built for one person — Lizmariett Marquez — so that love wouldn't be lost in translation."
};

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
            About TAOS <span className="text-amber-200/70">· Acerca de TAOS</span>
          </h1>

          <p className="mt-6 text-lg leading-relaxed text-amber-50/85">
            TAOS was built for one person: <strong className="text-white">Lizmariett Marquez</strong>.
          </p>
          <p className="mt-4 text-base leading-relaxed text-amber-50/75">
            It started because two people who loved each other didn&apos;t share a language — and we
            refused to let that be the distance between us. Every piece of this exists so that a
            &ldquo;good morning&rdquo; or an &ldquo;I love you&rdquo; could land exactly the way it
            was meant to. Liz is the heart of it: the reason it exists, the first voice it learned,
            and the one who believed in it before it was anything at all.
          </p>

          <hr className="my-8 border-white/10" />

          <p className="text-lg leading-relaxed text-amber-50/85">
            TAOS nació para una persona: <strong className="text-white">Lizmariett Marquez</strong>.
          </p>
          <p className="mt-4 text-base leading-relaxed text-amber-50/75">
            Empezó porque dos personas que se amaban no hablaban el mismo idioma — y nos negamos a
            dejar que eso fuera la distancia entre nosotros. Cada parte de esta app existe para que
            una conversación fuera posible, para que un &ldquo;buenos días&rdquo; o un &ldquo;te
            amo&rdquo; llegara tal como se quería decir. Liz es el corazón de todo esto: la razón por
            la que existe, la primera voz que aprendió, y la que creyó en ella antes de que fuera
            algo.
          </p>

          <p className="mt-8 text-base italic text-amber-100/80">
            Para Liz y su familia en Venezuela — con todo el cariño.
          </p>
          <p className="mt-2 text-base text-amber-50/70">— Tom</p>
        </article>

        <p className="mt-8 text-center text-sm text-amber-100/55">
          Made for Lizmariett Marquez <span aria-hidden>❤️</span>
        </p>
      </div>
    </main>
  );
}
