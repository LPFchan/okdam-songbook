import { z } from "zod";
import { songSchema } from "./schemas";

export const tjSearchTypeSchema = z.enum(["all", "title", "artist", "lyricist", "composer", "number", "medley"]);
export const tjNationSchema = z.enum(["", "KOR", "ENG", "JPN"]);

export const tjSongCandidateSchema = z.object({
  tjNumber: z.string().regex(/^\d+$/),
  title: z.string().trim().min(1).max(300),
  artist: z.string().trim().min(1).max(300),
  lyricist: z.string().trim().max(300).default(""),
  composer: z.string().trim().max(300).default(""),
  sourceUrl: z.string().url()
});

export const tjLookupRequestSchema = z.object({
  tjNumber: z.string().trim().regex(/^\d{1,8}$/),
  nation: tjNationSchema.optional().default(""),
  pageSize: z.number().int().min(1).max(30).optional().default(15)
});

export const tjSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(120),
  searchType: tjSearchTypeSchema.optional().default("all"),
  nation: tjNationSchema.optional().default(""),
  page: z.number().int().min(1).max(10).optional().default(1),
  pageSize: z.number().int().min(1).max(30).optional().default(15)
});

export const tjSearchResultSchema = z.object({
  query: z.string(),
  searchType: tjSearchTypeSchema,
  nation: tjNationSchema,
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  hasMore: z.boolean(),
  candidates: z.array(tjSongCandidateSchema),
  sourceUrl: z.string().url()
});

export const tjLookupResultSchema = z.object({
  query: z.string(),
  candidate: tjSongCandidateSchema.nullable(),
  candidates: z.array(tjSongCandidateSchema),
  sourceUrl: z.string().url()
});

export const tjDuplicateKindSchema = z.enum(["tjNumber", "titleArtist"]);
export const tjAddOutcomeSchema = z.enum(["created", "duplicate", "deleted"]);

export const tjAddResultSchema = z.object({
  outcome: tjAddOutcomeSchema,
  song: songSchema.nullable(),
  existing: songSchema.nullable().default(null),
  duplicateKind: tjDuplicateKindSchema.nullable().default(null),
  canRestore: z.boolean().default(false),
  canOpen: z.boolean().default(false)
});

export type TjSearchType = z.infer<typeof tjSearchTypeSchema>;
export type TjNation = z.infer<typeof tjNationSchema>;
export type TjSongCandidate = z.infer<typeof tjSongCandidateSchema>;
export type TjLookupRequest = z.infer<typeof tjLookupRequestSchema>;
export type TjSearchRequest = z.infer<typeof tjSearchRequestSchema>;
export type TjSearchResult = z.infer<typeof tjSearchResultSchema>;
export type TjLookupResult = z.infer<typeof tjLookupResultSchema>;
export type TjAddResult = z.infer<typeof tjAddResultSchema>;

const namedEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"'
};

function decodeHtml(value: string): string {
  return value
    .replace(/&#(x[\da-f]+|\d+);/giu, (_, token: string) => {
      const code = token.toLowerCase().startsWith("x") ? parseInt(token.slice(1), 16) : parseInt(token, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-z][a-z\d]+);/giu, (whole, name: string) => namedEntities[name.toLowerCase()] ?? whole);
}

function cleanText(value: string): string {
  return decodeHtml(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " "))
    .replace(/[\u00a0\t\r\n ]+/gu, " ")
    .trim();
}

function firstText(html: string, pattern: RegExp): string {
  const match = pattern.exec(html);
  return match ? cleanText(match[1] ?? "") : "";
}

function titleText(row: string): string {
  const section = /<li\b[^>]*\btitle3\b[^>]*>([\s\S]*?)(?=<li\b[^>]*\btitle4\b)/iu.exec(row)?.[1] ?? "";
  const values = Array.from(section.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/giu))
    .map((match) => cleanText(match[1] ?? ""))
    .filter(Boolean);
  return values.at(-1) ?? "";
}

function listRows(html: string): string[] {
  const rows: string[] = [];
  const rowPattern = /<ul\b[^>]*class\s*=\s*["'][^"']*\bgrid-container\b[^"']*\blist\b[^"']*["'][^>]*>[\s\S]*?<\/ul>\s*<\/li>/giu;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(html))) rows.push(match[0]);
  return rows;
}

function uniqueCandidates(candidates: TjSongCandidate[]): TjSongCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.tjNumber || `${candidate.title}\u0000${candidate.artist}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Parse only the server-rendered result rows. Raw TJ markup never leaves this boundary. */
export function parseTjSearchHtml(html: string, sourceUrl: string): TjSongCandidate[] {
  const text = String(html || "");
  const rows = listRows(text);
  if (!rows.length && /검색\s*결과를\s*찾을\s*수\s*없습니다/iu.test(text)) return [];
  const candidates = rows.map((row) => ({
    tjNumber: firstText(row, /class\s*=\s*["'][^"']*\bnum2\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/iu).replace(/\D/gu, ""),
    title: titleText(row),
    artist: firstText(row, /class\s*=\s*["'][^"']*\btitle4\b[^"']*\bsinger\b[^"']*["'][\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/iu),
    lyricist: firstText(row, /class\s*=\s*["'][^"']*\btitle5\b[^"']*["'][\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/iu),
    composer: firstText(row, /class\s*=\s*["'][^"']*\btitle6\b[^"']*["'][\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/iu),
    sourceUrl
  })).filter((candidate) => candidate.tjNumber && candidate.title && candidate.artist);
  if (!candidates.length && !/<ul\b[^>]*\bgrid-container\b/iu.test(text)) {
    throw new Error("TJ_PARSER_DRIFT");
  }
  return uniqueCandidates(candidates);
}

export function tjSearchTypeValue(searchType: TjSearchType): string {
  return { all: "0", title: "1", artist: "2", lyricist: "4", composer: "8", number: "16", medley: "32" }[searchType];
}

export function buildTjSearchUrl(input: TjSearchRequest | TjLookupRequest): string {
  const isLookup = "tjNumber" in input;
  const query = isLookup ? input.tjNumber : input.query.replace(/\s/gu, "");
  const searchType = isLookup ? "16" : tjSearchTypeValue(input.searchType ?? "all");
  const page = isLookup ? 1 : input.page ?? 1;
  const pageSize = input.pageSize ?? 15;
  const params = new URLSearchParams({
    pageNo: String(page),
    pageRowCnt: String(pageSize),
    strSotrGubun: "ASC",
    strSortType: isLookup ? "pro" : "",
    nationType: input.nation ?? "",
    strType: searchType,
    searchTxt: query,
    strWord: "Y"
  });
  return `https://www.tjmedia.com/song/accompaniment_search?${params.toString()}`;
}

export function parseTjHasMore(html: string): boolean {
  return /class\s*=\s*["'][^"']*\bmore-btn\b/iu.test(html);
}
