import {
  filterSongs,
  type DamSongCandidate,
  type KaraokeSystem,
  type PerformerId,
  type RecommendationGroup,
  type RecommendationResult,
  type Song,
  type TjSongCandidate
} from "@songbook/shared";
import type { DamAdapter } from "./dam.js";
import { DomainError, isDomainError } from "./errors.js";
import type { TjAdapter } from "./tj.js";

export const RECOMMENDATION_PAGE_PEOPLE = 5;
const RECOMMENDATION_PAGE_SIZE = 30;
// TJ and DAM each allow 4 upstream requests per 10 seconds, so the fifth
// person waits for the window instead of failing.
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_WAIT_MS = 2_500;

export interface RecommendationPerson {
  name: string;
  songCount: number;
}

function personKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, "");
}

/** "TAK(feat.初音ミク)" is TAK singing. */
function withoutFeaturing(name: string): string {
  return name.replace(/\s*\((?:feat|ft)\.?[^)]*\)/giu, "").trim();
}

/** Every artist of these songs, most saved songs first, newest first on a tie. */
export function topRecommendationPeople(songs: Song[]): RecommendationPerson[] {
  const people = new Map<string, { spellings: Map<string, number>; songCount: number; latest: string }>();
  for (const song of songs) {
    const name = withoutFeaturing(song.artist);
    const key = personKey(name);
    if (!key) continue;
    const person = people.get(key) ?? { spellings: new Map(), songCount: 0, latest: "" };
    person.spellings.set(name, (person.spellings.get(name) ?? 0) + 1);
    person.songCount += 1;
    if (song.createdAt > person.latest) person.latest = song.createdAt;
    people.set(key, person);
  }
  return [...people.values()]
    .map((person) => ({
      name: [...person.spellings].sort((a, b) => b[1] - a[1])[0]![0],
      songCount: person.songCount,
      latest: person.latest
    }))
    .sort((a, b) => b.songCount - a.songCount || b.latest.localeCompare(a.latest) || a.name.localeCompare(b.name))
    .map(({ name, songCount }) => ({ name, songCount }));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRateLimited(error: unknown): boolean {
  return isDomainError(error) && (error.code === "TJ_RATE_LIMITED" || error.code === "DAM_RATE_LIMITED");
}

/**
 * One page of songs by the artists of the performers' saved songs, one group
 * per artist. Saved songs are left in: the client already holds the catalog and
 * hides them, which also covers songs added after this answer.
 */
export async function recommendSongs(options: {
  catalog: Song[];
  performerIds: PerformerId[];
  system: KaraokeSystem;
  offset?: number;
  tj?: TjAdapter;
  dam?: DamAdapter;
  sleep?(ms: number): Promise<void>;
}): Promise<RecommendationResult> {
  const { tj, dam, system } = options;
  if (system === "tj" && !tj) throw new DomainError("TJ_UPSTREAM_ERROR", "TJ 연결이 설정되지 않았어.");
  if (system === "dam" && !dam) throw new DomainError("DAM_UPSTREAM_ERROR", "DAM 연결이 설정되지 않았어.");
  const sleep = options.sleep ?? defaultSleep;
  // Each mode only shows songs with that system's number, so only those speak for taste there.
  const songs = filterSongs(options.catalog, { performerIds: options.performerIds, hasTjNumber: system === "tj" || undefined, hasDamNumber: system === "dam" || undefined });
  const ranked = topRecommendationPeople(songs);
  const offset = options.offset ?? 0;
  const people = ranked.slice(offset, offset + RECOMMENDATION_PAGE_PEOPLE);
  const nextOffset = offset + RECOMMENDATION_PAGE_PEOPLE < ranked.length ? offset + RECOMMENDATION_PAGE_PEOPLE : null;

  const search = async (person: RecommendationPerson): Promise<Array<TjSongCandidate | DamSongCandidate>> => {
    const query = person.name.slice(0, 120);
    return system === "tj"
      ? (await tj!.search({ query, searchType: "artist", nation: "", page: 1, pageSize: RECOMMENDATION_PAGE_SIZE })).candidates
      // DAM keyword search also matches composers and lyricists; keep the artist's own songs.
      : (await dam!.search({ query, page: 1, pageSize: RECOMMENDATION_PAGE_SIZE })).candidates
        .filter((candidate) => personKey(candidate.artist).includes(personKey(person.name)));
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
  return { groups, nextOffset };
}
