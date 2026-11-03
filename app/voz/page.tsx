import type { Metadata } from "next";
import { ExitHome } from "@/components/ExitHome";
import { VozShell } from "@/components/voz/VozShell";
import { vozEnabled } from "@/lib/voz/server";

// /voz — "Tu voz", public: a stranger records ~30 s on their own phone and
// hears themselves speak the other language; the voice is deleted within ten
// minutes (lib/voz/server.ts). No sign-in for the first try. Reached from a
// link Tom texts, not from the nav (tests/nav-completeness.test.ts).
//
// Dynamic because TAOS_VOZ_ENABLED is a SERVER flag read per request.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  if (!vozEnabled()) return { robots: { index: false, follow: false } };
  return {
    title: "Tu voz · TAOS",
    description: "Escúchate hablar otro idioma — con tu propia voz. · Hear yourself speak another language.",
    robots: { index: false, follow: false }
  };
}

export default function VozPage(): JSX.Element {
  if (!vozEnabled()) {
    return (
      <main className="min-h-screen px-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
        <div className="mx-auto flex max-w-md flex-col gap-6">
          <header className="flex items-center gap-3">
            <ExitHome />
          </header>
          <p className="text-center text-amber-100/70">Todavía no está disponible · Not available yet</p>
        </div>
      </main>
    );
  }
  return <VozShell />;
}
