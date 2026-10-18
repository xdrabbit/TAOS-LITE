"use client";

import { copyFor } from "@/lib/chrome/copy";
import { PRACTICA_TRIPS } from "@/lib/practica/scenes";
import { PracticaGate } from "./PracticaGate";

export function PracticaHome({ configured }: { configured: boolean }): JSX.Element {
  const copy = copyFor("es");

  return (
    <PracticaGate configured={configured}>
      <main className="min-h-screen bg-[radial-gradient(circle_at_top,#3b2a18_0%,#171210_42%,#0c0a09_100%)] px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1.25rem)] text-amber-50">
        <div className="mx-auto flex max-w-lg flex-col gap-6">
          <header className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.25em] text-amber-200/60">TAOS · SPIKE</p>
              <h1 className="text-3xl font-semibold tracking-tight">{copy.practicaTitle}</h1>
            </div>
            <a href="/" className="rounded-full border border-white/15 px-4 py-2 text-sm text-amber-100">
              {copy.home}
            </a>
          </header>

          {PRACTICA_TRIPS.map((trip) => (
            <section
              key={trip.id}
              className="overflow-hidden rounded-[2rem] border border-amber-200/20 bg-white/[0.06] shadow-2xl"
            >
              <div className="bg-gradient-to-br from-red-950 via-orange-900 to-sky-950 p-6">
                <p className="text-sm text-amber-100/70">
                  Español → English · {trip.scenes.length} escenas
                </p>
                <h2 className="mt-2 text-2xl font-semibold">{trip.title.learner}</h2>
                <p className="text-sm text-amber-100/75">{trip.title.target}</p>
              </div>
              <ol className="space-y-2 p-4">
                {trip.scenes.map((scene, index) => (
                  <li key={scene.id}>
                    <a
                      href={`/practica/${trip.id}/${index}`}
                      className="flex min-h-[52px] items-center gap-3 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 transition active:scale-[0.99]"
                    >
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-amber-300 text-sm font-bold text-stone-950">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{scene.title.learner}</span>
                        <span className="block text-xs text-amber-100/55">{scene.title.target}</span>
                      </span>
                      <span aria-hidden="true">→</span>
                    </a>
                  </li>
                ))}
              </ol>
              <div className="px-4 pb-4">
                <a
                  href={`/practica/${trip.id}/0`}
                  className="flex min-h-[48px] items-center justify-center rounded-2xl bg-amber-300 px-5 py-3 font-semibold text-stone-950"
                >
                  {copy.practicaStart}
                </a>
              </div>
            </section>
          ))}
        </div>
      </main>
    </PracticaGate>
  );
}
