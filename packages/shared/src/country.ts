import type { Song } from "./schemas.js";
import { normalizeText } from "./normalize.js";

export type SongCountry = "일본" | "미국" | "한국" | "그 외";

type KnownSongCountry = Pick<Song, "artist" | "country">;

function scriptCount(value: string, script: "Hiragana" | "Katakana" | "Han" | "Hangul"): number {
  return Array.from(value.matchAll(new RegExp(`\\p{Script=${script}}`, "gu"))).length;
}

/** Infer the country for a TJ candidate without making a network request. */
export function detectSongCountry(title: string, artist: string, knownSongs: readonly KnownSongCountry[] = []): string {
  const normalizedArtist = normalizeText(artist);
  const knownArtist = knownSongs.find((song) =>
    song.country && normalizeText(song.artist) === normalizedArtist
  );
  if (knownArtist) return knownArtist.country;

  const text = `${title} ${artist}`.normalize("NFKC");
  const japanese = scriptCount(text, "Hiragana") + scriptCount(text, "Katakana") + scriptCount(text, "Han");
  const korean = scriptCount(text, "Hangul");

  if (japanese || korean) return japanese > korean ? "일본" : "한국";
  if (/\p{Script=Latin}/u.test(text)) return "미국";
  return "그 외";
}
