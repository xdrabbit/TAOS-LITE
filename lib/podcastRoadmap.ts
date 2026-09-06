import roadmapData from "@/data/podcast-roadmap.json";

export const PODCAST_EPISODE_STATUSES = [
  "planned",
  "production",
  "rss_draft",
  "scheduled",
  "published"
] as const;

export type PodcastEpisodeStatus = (typeof PODCAST_EPISODE_STATUSES)[number];

export interface PodcastRoadmapEpisode {
  internal_id: string;
  working_episode_number: number | null;
  title: string;
  short_summary: string;
  status: PodcastEpisodeStatus;
  public_display: boolean;
  rss_episode_id: string | null;
  published_at: string | null;
}

export interface PodcastRoadmap {
  show_slug: string;
  rss_podcast_id: string;
  title: string;
  episodes: PodcastRoadmapEpisode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isEpisodeStatus(value: unknown): value is PodcastEpisodeStatus {
  return (
    typeof value === "string" &&
    (PODCAST_EPISODE_STATUSES as readonly string[]).includes(value)
  );
}

function isEpisode(value: unknown): value is PodcastRoadmapEpisode {
  if (!isRecord(value)) return false;

  return (
    typeof value.internal_id === "string" &&
    (typeof value.working_episode_number === "number" ||
      value.working_episode_number === null) &&
    typeof value.title === "string" &&
    typeof value.short_summary === "string" &&
    isEpisodeStatus(value.status) &&
    typeof value.public_display === "boolean" &&
    isNullableString(value.rss_episode_id) &&
    isNullableString(value.published_at)
  );
}

/**
 * Runtime validation keeps the JSON boundary honest for future automation.
 * An rss-mcp bridge can update the file, while the build still fails loudly
 * if it writes an unknown state or changes the stable contract by accident.
 */
export function assertPodcastRoadmap(value: unknown): asserts value is PodcastRoadmap {
  if (
    !isRecord(value) ||
    typeof value.show_slug !== "string" ||
    typeof value.rss_podcast_id !== "string" ||
    typeof value.title !== "string" ||
    !Array.isArray(value.episodes) ||
    !value.episodes.every(isEpisode)
  ) {
    throw new Error("Invalid podcast roadmap data");
  }
}

assertPodcastRoadmap(roadmapData);

export const PODCAST_ROADMAP: PodcastRoadmap = roadmapData;
