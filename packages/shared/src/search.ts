import type { Song } from "./schemas.js";
import { formatKeyCandidate } from "./key.js";
import { getHangulChoseong, includesAllTokens, normalizeNumber, normalizeText } from "./normalize.js";
import { performerSearchText, type PerformerId } from "./performers.js";
import { isPublicSongStatus } from "./permissions.js";

export function normalizedSearchQuery(query: string): string {
  return query.trim();
}

export function isSearchableQuery(query: string): boolean {
  const trimmed = normalizedSearchQuery(query);
  return trimmed.length >= 2 || /^\d+$/u.test(trimmed);
}

export function searchTypeForQuery(query: string): "all" | "number" {
  return /^\d+$/u.test(normalizedSearchQuery(query)) ? "number" : "all";
}

export type SortKey = "title" | "tjNumber" | "recentAdded" | "recentUpdated" | "recentPerformed" | "performanceCount";

export interface SongFilters {
  country?: string;
  status?: string;
  hasKey?: boolean;
  recentOnly?: boolean;
  createdByName?: string;
  performerIds?: PerformerId[];
  hasTjNumber?: boolean;
  favorite?: boolean;
}

export function primaryKey(song: Song): string {
  return formatKeyCandidate(song.keyCandidates.find((key) => key.isPrimary) ?? song.keyCandidates[0]);
}

export function buildSearchDocument(song: Song): string {
  const fields = [
    song.tjNumber,
    song.title,
    song.titleReadingKo,
    song.titleRomanized,
    song.titleAliases.join(" "),
    song.artist,
    song.artistReadingKo,
    song.artistAliases.join(" "),
    song.country,
    song.originalWork,
    song.memo,
    performerSearchText(song.performerIds),
    primaryKey(song)
  ];
  const text = fields.filter(Boolean).join(" ");
  return `${normalizeText(text)} ${getHangulChoseong(text)}`;
}

export function searchSongs(songs: Song[], query: string): Song[] {
  const trimmed = normalizeText(query);
  if (!trimmed) return songs;
  const numeric = normalizeNumber(trimmed);
  const matches = songs.filter((song) => {
    if (numeric && song.tjNumber.includes(numeric)) return true;
    return includesAllTokens(buildSearchDocument(song), trimmed);
  });
  return matches.sort((a, b) => {
    if (numeric) return Number(b.tjNumber.startsWith(numeric)) - Number(a.tjNumber.startsWith(numeric));
    return 0;
  });
}

export function filterSongs(songs: Song[], filters: SongFilters, includeHidden = false): Song[] {
  return songs.filter((song) => {
    if (!includeHidden && !isPublicSongStatus(song.status)) return false;
    if (filters.country && song.country !== filters.country) return false;
    if (filters.status && song.status !== filters.status) return false;
    if (filters.hasKey && song.keyCandidates.length === 0) return false;
    if (filters.recentOnly && !song.lastPerformedAt) return false;
    if (filters.createdByName && song.createdByName !== filters.createdByName) return false;
    if (filters.performerIds?.length && !filters.performerIds.some((id) => song.performerIds.includes(id))) return false;
    if (filters.hasTjNumber && !song.tjNumber) return false;
    if (filters.favorite && song.status !== "favorite") return false;
    return true;
  });
}

export function sortSongs(songs: Song[], sortKey: SortKey): Song[] {
  const copy = [...songs];
  const collator = new Intl.Collator("ko-KR", { numeric: true, sensitivity: "base" });
  return copy.sort((a, b) => {
    switch (sortKey) {
      case "tjNumber":
        return collator.compare(a.tjNumber || "999999", b.tjNumber || "999999");
      case "recentAdded":
        return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
      case "recentUpdated":
        return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
      case "recentPerformed":
        return (Date.parse(b.lastPerformedAt) || 0) - (Date.parse(a.lastPerformedAt) || 0);
      case "performanceCount":
        return b.performanceCount - a.performanceCount;
      case "title":
      default:
        return collator.compare(a.titleReadingKo || a.title, b.titleReadingKo || b.title);
    }
  });
}

export function highlightParts(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const q = normalizeText(query);
  if (!q) return [{ text, hit: false }];
  const lower = normalizeText(text);
  const first = q.split(" ").find((token) => token && lower.includes(token));
  if (!first) return [{ text, hit: false }];
  const index = lower.indexOf(first);
  return [
    { text: text.slice(0, index), hit: false },
    { text: text.slice(index, index + first.length), hit: true },
    { text: text.slice(index + first.length), hit: false }
  ].filter((part) => part.text.length > 0);
}
