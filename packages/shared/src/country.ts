export const songCountries = ["일본", "미국", "한국", "그 외"] as const;

export type SongCountry = (typeof songCountries)[number];

export function isSongCountry(value: unknown): value is SongCountry {
  return (songCountries as readonly unknown[]).includes(value);
}
