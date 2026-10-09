import { DAM_MAX_PAGE_SIZE, type DamSongCandidate, type KaraokeSystem, type Song, type TjSongCandidate } from "@songbook/shared";
import { addDamSong, addTjSong, searchDamSongs, searchTjSongs } from "./api";

export type Candidate = TjSongCandidate | DamSongCandidate;

/** Everything that differs between searching TJ and searching DAM. */
export interface KaraokeSource {
  label: string;
  number(candidate: Candidate): string;
  savedNumber(song: Song): string;
  search(query: string): Promise<Candidate[]>;
  add(candidate: Candidate, requestId: string, ownerSubject: string): Promise<{ outcome: string; song: Song | null; existing: Song | null }>;
}

export const karaokeSources: Record<KaraokeSystem, KaraokeSource> = {
  tj: {
    label: "TJ",
    number: (candidate) => (candidate as TjSongCandidate).tjNumber,
    savedNumber: (song) => song.tjNumber,
    search: async (q) => (await searchTjSongs({ query: q, searchType: /^\d+$/u.test(q) ? "number" : "all", nation: "", page: 1, pageSize: 15 })).candidates,
    add: (candidate, requestId, ownerSubject) => addTjSong(candidate as TjSongCandidate, requestId, ownerSubject)
  },
  dam: {
    label: "DAM",
    number: (candidate) => (candidate as DamSongCandidate).damNumber,
    savedNumber: (song) => song.damNumber,
    search: async (q) => (await searchDamSongs({ query: q, page: 1, pageSize: DAM_MAX_PAGE_SIZE })).candidates,
    add: (candidate, requestId, ownerSubject) => addDamSong(candidate as DamSongCandidate, requestId, ownerSubject)
  }
};

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function candidateKey(system: KaraokeSystem, candidate: Candidate): string {
  return `${karaokeSources[system].number(candidate)}:${candidate.title}:${candidate.artist}`;
}

/**
 * A saved song only counts as "already there" when it has this system's
 * number; a DAM pick matching a TJ-only song by name links the two instead.
 */
export function findSavedSong(system: KaraokeSystem, candidate: Candidate, songs: Song[]): Song | undefined {
  const source = karaokeSources[system];
  const number = source.number(candidate);
  return songs.find((song) => {
    const saved = source.savedNumber(song);
    if (saved === number) return true;
    if (system === "dam" && !saved) return false;
    return normalized(song.title) === normalized(candidate.title) && normalized(song.artist) === normalized(candidate.artist);
  });
}
