import { promises as fs } from "fs";
import type { Dirent } from "fs";
import path from "path";

export interface Drill {
  en: string;
  es: string;
}

export interface Lesson {
  id: string;
  day: number;
  title: string;
  drills: Drill[];
}

const COURSE_DIR = path.join(process.cwd(), "content/tutor-course");

function splitRow(row: string): string[] {
  return row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

// Pull the "Micro-Sentences" table (English target + Spanish meaning) from a day file.
function parseMicroSentences(raw: string): Drill[] {
  const section = raw.match(/##\s*Micro-?\s*Sentences[^\n]*\n([\s\S]*?)(?:\n##\s|\n#\s|$)/i);
  if (!section) return [];
  const rows = section[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));
  if (rows.length < 2) return [];

  const header = splitRow(rows[0]).map((h) => h.toLowerCase());
  const enFirst = header[0].includes("english") || !header[0].includes("espa");

  const drills: Drill[] = [];
  for (const row of rows.slice(1)) {
    if (/^[-\s|:]+$/.test(row)) continue; // separator row
    const cols = splitRow(row);
    if (cols.length < 2) continue;
    const en = (enFirst ? cols[0] : cols[1]).trim();
    const es = (enFirst ? cols[1] : cols[0]).trim();
    if (!en || !es) continue;
    if (en.toLowerCase() === "english" || es.toLowerCase().startsWith("espa")) continue;
    drills.push({ en, es });
  }
  return drills;
}

async function collectMarkdown(dir: string): Promise<string[]> {
  let out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(await collectMarkdown(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

export async function loadLessons(): Promise<Lesson[]> {
  const files = await collectMarkdown(COURSE_DIR);
  const lessons: Lesson[] = [];
  const seen = new Set<number>();

  for (const file of files) {
    const dayMatch = path.basename(file).match(/day-(\d+)/i);
    if (!dayMatch) continue;
    const day = Number(dayMatch[1]);
    if (seen.has(day)) continue;
    const raw = await fs.readFile(file, "utf8");
    const drills = parseMicroSentences(raw);
    if (!drills.length) continue;
    const title = (raw.match(/^#\s+(.+)$/m)?.[1] ?? `Day ${day}`).trim();
    lessons.push({ id: `day-${day}`, day, title, drills });
    seen.add(day);
  }

  lessons.sort((a, b) => a.day - b.day);
  return lessons;
}
