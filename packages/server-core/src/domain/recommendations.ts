import {
  filterSongs,
  type DamSongCandidate,
  type KaraokeSystem,
  type PerformerId,
  type RecommendationGroup,
  type RecommendationRole,
  type Song,
  type TjSongCandidate
} from "@songbook/shared";
import type { TjCredits } from "../db/tjMirror.js";
import type { DamAdapter } from "./dam.js";
import { DomainError, isDomainError } from "./errors.js";
import type { TjAdapter } from "./tj.js";

export const RECOMMENDATION_PEOPLE = 5;
const RECOMMENDATION_PAGE_SIZE = 30;
// TJ and DAM each allow 4 upstream requests per 10 seconds, so the fifth
// person waits for the window instead of failing.
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_WAIT_MS = 2_500;
const ROLE_ORDER: RecommendationRole[] = ["artist", "composer", "lyricist"];

export interface RecommendationPerson {
  name: string;
  role: RecommendationRole;
  songCount: number;
}

function personKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, "");
}

/** "TAK(feat.初音ミク)" is TAK singing. */
function withoutFeaturing(name: string): string {
  return name.replace(/\s*\((?:feat|ft)\.?[^)]*\)/giu, "").trim();
}

/** TJ joins several composers or lyricists with commas. */
function creditNames(value: string): string[] {
  return value.split(/[,，]/u).map((name) => name.trim()).filter(Boolean);
}

/**
 * The people who sang, composed or wrote the most of these songs. A person
 * credited twice on one song counts that song once, and is searched by the
 * role they hold most visibly (artist before composer before lyricist).
 */
export function topRecommendationPeople(songs: Song[], credits: Map<string, TjCredits>, limit = RECOMMENDATION_PEOPLE): RecommendationPerson[] {
  const people = new Map<string, { spellings: Map<string, number>; roles: Set<RecommendationRole>; songCount: number; latest: string }>();
  for (const song of songs) {
    const credit = credits.get(song.tjNumber);
    const named: Array<[string, RecommendationRole]> = [
      [withoutFeaturing(song.artist), "artist"],
      ...creditNames(credit?.composer ?? "").map((name): [string, RecommendationRole] => [name, "composer"]),
      ...creditNames(credit?.lyricist ?? "").map((name): [string, RecommendationRole] => [name, "lyricist"])
    ];
    const counted = new Set<string>();
    for (const [name, role] of named) {
      const key = personKey(name);
      if (!key) continue;
      const person = people.get(key) ?? { spellings: new Map(), roles: new Set(), songCount: 0, latest: "" };
      person.roles.add(role);
      person.spellings.set(name, (person.spellings.get(name) ?? 0) + 1);
      if (!counted.has(key)) {
        counted.add(key);
        person.songCount += 1;
        if (song.createdAt > person.latest) person.latest = song.createdAt;
      }
      people.set(key, person);
    }
  }
  return [...people.values()]
    .map((person) => ({
      name: [...person.spellings].sort((a, b) => b[1] - a[1])[0]![0],
      role: ROLE_ORDER.find((role) => person.roles.has(role))!,
      songCount: person.songCount,
      latest: person.latest
    }))
    .sort((a, b) => b.songCount - a.songCount
      || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
      || b.latest.localeCompare(a.latest)
      || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name, role, songCount }) => ({ name, role, songCount }));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRateLimited(error: unknown): boolean {
  return isDomainError(error) && (error.code === "TJ_RATE_LIMITED" || error.code === "DAM_RATE_LIMITED");
}

/**
 * Songs by the people behind the performers' saved songs, one group per
 * person. Saved songs are left in: the client already holds the catalog and
 * hides them, which also covers songs added after this answer.
 */
export async function recommendSongs(options: {
  catalog: Song[];
  performerIds: PerformerId[];
  system: KaraokeSystem;
  credits(tjNumbers: string[]): Promise<Map<string, TjCredits>>;
  tj?: TjAdapter;
  dam?: DamAdapter;
  sleep?(ms: number): Promise<void>;
}): Promise<RecommendationGroup[]> {
  const { tj, dam, system } = options;
  if (system === "tj" && !tj) throw new DomainError("TJ_UPSTREAM_ERROR", "TJ 연결이 설정되지 않았어.");
  if (system === "dam" && !dam) throw new DomainError("DAM_UPSTREAM_ERROR", "DAM 연결이 설정되지 않았어.");
  const sleep = options.sleep ?? defaultSleep;
  // Each mode only shows songs with that system's number, so only those speak for taste there.
  const songs = filterSongs(options.catalog, { performerIds: options.performerIds, hasTjNumber: system === "tj" || undefined, hasDamNumber: system === "dam" || undefined });
  const people = topRecommendationPeople(songs, await options.credits(songs.map((song) => song.tjNumber)));

  const search = async (person: RecommendationPerson): Promise<Array<TjSongCandidate | DamSongCandidate>> => {
    const query = person.name.slice(0, 120);
    return system === "tj"
      ? (await tj!.search({ query, searchType: person.role, nation: "", page: 1, pageSize: RECOMMENDATION_PAGE_SIZE })).candidates
      // DAM's keyword search already matches artists, composers and lyricists.
      : (await dam!.search({ query, page: 1, pageSize: RECOMMENDATION_PAGE_SIZE })).candidates;
  };

  const groups: RecommendationGroup[] = [];
  for (const person of people) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        groups.push({ ...person, candidates: await search(person), error: null });
        break;
      } catch (error) {
        if (isRateLimited(error) && attempt < RATE_LIMIT_RETRIES) {
          await sleep(RATE_LIMIT_WAIT_MS);
          continue;
        }
        groups.push({ ...person, candidates: [], error: isDomainError(error) ? error.message : "검색하지 못했어." });
        break;
      }
    }
  }
  return groups;
}
