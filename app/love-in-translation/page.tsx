import type { Metadata } from "next";
import {
  PODCAST_ROADMAP,
  type PodcastEpisodeStatus,
  type PodcastRoadmapEpisode
} from "@/lib/podcastRoadmap";

const DESCRIPTION =
  "Tom and Liz talk about love, language, culture, and building a life across English and Spanish.";

const STATUS_LABELS: Record<PodcastEpisodeStatus, string> = {
  planned: "Planned · Planeado",
  production: "In production · En producción",
  rss_draft: "RSS draft · Borrador",
  scheduled: "Scheduled · Programado",
  published: "Published · Publicado"
};

export const metadata: Metadata = {
  title: `${PODCAST_ROADMAP.title} · Podcast roadmap`,
  description: DESCRIPTION,
  alternates: { canonical: "/love-in-translation" },
  openGraph: {
    title: PODCAST_ROADMAP.title,
    description: DESCRIPTION,
    url: "/love-in-translation",
    type: "website"
  },
  twitter: {
    card: "summary",
    title: PODCAST_ROADMAP.title,
    description: DESCRIPTION
  }
};

function StatusBadge({ status }: { status: PodcastEpisodeStatus }): JSX.Element {
  return (
    <span className="inline-flex rounded-full border border-rose-200/20 bg-rose-200/[0.07] px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-rose-100/80">
      {STATUS_LABELS[status]}
    </span>
  );
}

function EpisodeCard({ episode }: { episode: PodcastRoadmapEpisode }): JSX.Element {
  return (
    <li>
      <article className="group relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-[rgba(33,23,22,0.78)] p-5 shadow-[0_18px_55px_rgba(0,0,0,0.18)] sm:p-7">
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-rose-300/70 via-amber-300/60 to-emerald-300/50"
        />
        <StatusBadge status={episode.status} />
        <h3 className="mt-4 font-[Georgia,'Times_New_Roman',serif] text-[clamp(1.35rem,5vw,1.75rem)] leading-tight tracking-[-0.02em] text-white">
          {episode.title}
        </h3>
        <p className="mt-3 max-w-2xl text-[0.95rem] leading-7 text-amber-50/65">
          {episode.short_summary}
        </p>
      </article>
    </li>
  );
}

export default function LoveInTranslationPage(): JSX.Element {
  const publicEpisodes = PODCAST_ROADMAP.episodes.filter((episode) => episode.public_display);
  const publishedEpisodes = publicEpisodes.filter((episode) => episode.status === "published");
  const upcomingEpisodes = publicEpisodes.filter((episode) => episode.status !== "published");

  return (
    <main className="relative min-h-screen overflow-hidden px-5 pb-16 pt-[calc(env(safe-area-inset-top)+1.25rem)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[-12rem] h-[32rem] w-[32rem] -translate-x-1/2 rounded-full bg-rose-400/[0.08] blur-3xl"
      />

      <div className="relative mx-auto max-w-3xl">
        <header className="flex items-center justify-between gap-4 py-2">
          <a href="/" className="text-base font-semibold tracking-tight text-amber-200 sm:text-lg">
            TAOS·LITE
          </a>
          <a
            href="/"
            className="inline-flex min-h-[44px] items-center rounded-full border border-white/10 bg-white/5 px-4 text-sm text-amber-100/75 transition hover:border-amber-300/25 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
          >
            ← Back to TAOS
          </a>
        </header>

        <section className="pb-14 pt-14 text-center sm:pb-20 sm:pt-20">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-rose-200/65">
            A new podcast · Un nuevo podcast
          </p>
          <h1 className="mt-5 text-balance font-[Georgia,'Times_New_Roman',serif] text-[clamp(3.2rem,13vw,6.3rem)] font-normal leading-[0.9] tracking-[-0.055em] text-white">
            Love in
            <span className="block bg-gradient-to-r from-rose-200 via-amber-200 to-emerald-200 bg-clip-text pb-2 text-transparent">
              Translation
            </span>
          </h1>
          <p className="mx-auto mt-7 max-w-xl text-balance text-lg leading-8 text-amber-50/72 sm:text-xl">
            Tom and Liz talk about love, language, culture, and building a life across English and
            Spanish.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs uppercase tracking-[0.2em] text-amber-100/45">
            <span>love · amor</span>
            <span aria-hidden="true" className="text-rose-200/30">◆</span>
            <span>language · idioma</span>
            <span aria-hidden="true" className="text-rose-200/30">◆</span>
            <span>home · hogar</span>
          </div>
        </section>

        {publishedEpisodes.length > 0 ? (
          <section aria-labelledby="published-heading" className="mb-14">
            <h2
              id="published-heading"
              className="font-[Georgia,'Times_New_Roman',serif] text-3xl tracking-tight text-white"
            >
              Published
            </h2>
            <ul className="mt-6 flex flex-col gap-4">
              {publishedEpisodes.map((episode) => (
                <EpisodeCard key={episode.internal_id} episode={episode} />
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="coming-next-heading">
          <div className="border-t border-white/10 pt-8 sm:flex sm:items-end sm:justify-between sm:gap-6">
            <div>
              <p lang="es" className="text-xs font-semibold uppercase tracking-[0.25em] text-rose-200/55">
                Próximamente
              </p>
              <h2
                id="coming-next-heading"
                className="mt-2 font-[Georgia,'Times_New_Roman',serif] text-4xl tracking-[-0.03em] text-white sm:text-5xl"
              >
                Coming Next
              </h2>
            </div>
            <p className="mt-3 max-w-sm text-sm leading-6 text-amber-50/45 sm:mt-0 sm:text-right">
              Stories we are shaping now. These are plans, not published episodes or promised
              release dates.
            </p>
          </div>

          <ol className="mt-8 flex list-none flex-col gap-4">
            {upcomingEpisodes.map((episode) => (
              <EpisodeCard key={episode.internal_id} episode={episode} />
            ))}
          </ol>

          <aside className="mt-8 rounded-2xl border border-amber-200/10 bg-amber-100/[0.035] px-5 py-4 text-sm leading-6 text-amber-50/50">
            Planned topics may evolve before release as the conversations take shape.
          </aside>
        </section>

        <footer className="mt-16 border-t border-white/10 pt-7 text-center text-xs text-amber-100/35">
          <p>Love in Translation · A TAOS·LITE project</p>
        </footer>
      </div>
    </main>
  );
}
