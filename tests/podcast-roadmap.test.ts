import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertPodcastRoadmap,
  PODCAST_EPISODE_STATUSES,
  PODCAST_ROADMAP
} from "@/lib/podcastRoadmap";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const TITLES = [
  "How We Met Without Really Speaking",
  "Falling in Love Through a Phone",
  "The First Trip",
  "Living in America When English Isn't Yours",
  "When Translation Isn't Enough"
];

describe("the podcast roadmap data contract", () => {
  it("accepts the checked-in JSON and exposes the states an RSS bridge will need", () => {
    const raw: unknown = JSON.parse(read("data/podcast-roadmap.json"));
    expect(() => assertPodcastRoadmap(raw)).not.toThrow();
    expect(PODCAST_EPISODE_STATUSES).toEqual([
      "planned",
      "production",
      "rss_draft",
      "scheduled",
      "published"
    ]);
  });

  it("uses a small stable top-level and episode shape", () => {
    expect(Object.keys(PODCAST_ROADMAP).sort()).toEqual([
      "episodes",
      "rss_podcast_id",
      "show_slug",
      "title"
    ]);

    for (const episode of PODCAST_ROADMAP.episodes) {
      expect(Object.keys(episode).sort()).toEqual([
        "internal_id",
        "public_display",
        "published_at",
        "rss_episode_id",
        "short_summary",
        "status",
        "title",
        "working_episode_number"
      ]);
    }
  });

  it("identifies the approved RSS.com show without inventing RSS episode records", () => {
    expect(PODCAST_ROADMAP.show_slug).toBe("love-in-translation");
    expect(PODCAST_ROADMAP.rss_podcast_id).toBe("400282");
    expect(PODCAST_ROADMAP.title).toBe("Love in Translation");
    expect(PODCAST_ROADMAP.episodes.map((episode) => episode.title)).toEqual(TITLES);

    expect(PODCAST_ROADMAP.episodes).toHaveLength(5);
    for (const episode of PODCAST_ROADMAP.episodes) {
      expect(episode.status).toBe("planned");
      expect(episode.public_display).toBe(true);
      expect(episode.working_episode_number).toBeNull();
      expect(episode.rss_episode_id).toBeNull();
      expect(episode.published_at).toBeNull();
    }
  });

  it("keeps internal episode ids unique and automation-safe", () => {
    const ids = PODCAST_ROADMAP.episodes.map((episode) => episode.internal_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

describe("the public roadmap page", () => {
  const page = read("app/love-in-translation/page.tsx");

  it("renders its episodes from the roadmap instead of duplicating them in JSX", () => {
    expect(page).toContain("PODCAST_ROADMAP.episodes.filter");
    expect(page).toContain("upcomingEpisodes.map");
    for (const title of TITLES) expect(page).not.toContain(title);
  });

  it("keeps planned and published content visibly distinct", () => {
    expect(page).toContain('episode.status === "published"');
    expect(page).toContain('episode.status !== "published"');
    expect(page).toContain("These are plans, not published episodes or promised");
    expect(page).toContain("Planned topics may evolve before release");
  });

  it("does not present fake playback or availability", () => {
    expect(page).not.toMatch(/<audio|<button|play button|listen now/i);
  });
});
