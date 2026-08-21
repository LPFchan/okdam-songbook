import { parseCsvKey } from "./key.js";
import { mergePerformerIds, migratePerformerMemo, normalizePerformerIds } from "./performers.js";
import type { KeyCandidate, Song } from "./schemas.js";

const GENRE_BY_COUNTRY: Record<string, string> = {
  "한국": "K-POP",
  "일본": "J-POP",
  "미국": "POP",
  "아니메": "애니메이션"
};

const NORMALIZED_COUNTRY: Record<string, string> = {
  "아니메": "일본"
};

export interface CsvRowInput {
  title?: string;
  tjNumber?: string;
  createdAt?: string;
  artist?: string;
  originalWork?: string;
  country?: string;
  recommender?: string;
  key?: string;
  genres?: string;
  memo?: string;
}

export interface ImportedSong extends Song {
  _warnings: string[];
  _source: {
    csv: string;
    rowIndex: number;
    raw: CsvRowInput;
  };
}

export interface CsvImportReport {
  totalRows: number;
  inserted: number;
  skipped: number;
  warnings: number;
  performerRows: number;
  ponyaRows: number;
  seongukCorrections: number;
  yeoulCorrections: number;
  memoRecommenderRemoved: number;
  unknownPerformerNames: string[];
  emptyPerformerIds: number;
  songs: ImportedSong[];
  skippedRows: Array<{ rowIndex: number; reason: string; raw: CsvRowInput }>;
  warningRows: Array<{ rowIndex: number; reason: string; raw: CsvRowInput }>;
}

export interface CsvImportOptions {
  csvFileName: string;
  generatedAt?: string;
  idFactory?: () => string;
  keyIdFactory?: () => string;
}

const KOREAN_DATE_RE = /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s*오전|오후)?\s*(\d{1,2}):(\d{2})/;

function toIsoFromKoreanDate(value: string | undefined, generatedAt: string): string {
  if (!value) return generatedAt;
  const match = value.match(KOREAN_DATE_RE);
  if (!match) return generatedAt;
  const [, year, month, day, hour, minute] = match;
  const isAfternoon = /오후/.test(value);
  let h = Number(hour);
  if (isAfternoon) {
    h = h === 12 ? 12 : h + 12;
  } else if (h === 12) {
    h = 0;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(Number(month))}-${pad(Number(day))}T${pad(h)}:${pad(Number(minute))}:00+09:00`;
}

function normalizeKeyCandidates(raw: string, keyIdFactory: () => string): { candidates: KeyCandidate[]; warnings: string[] } {
  if (!raw) return { candidates: [], warnings: [] };
  const parsed = parseCsvKey(raw, keyIdFactory);
  return { candidates: parsed.candidates, warnings: parsed.warnings };
}

function buildMemo(row: CsvRowInput, keyWarnings: string[], unknownPerformerNames: string[]): string {
  const parts: string[] = [];
  const migratedMemo = migratePerformerMemo(row.memo || "").memo;
  if (migratedMemo) parts.push(migratedMemo);
  unknownPerformerNames.forEach((name) => parts.push(`외부 부를 사람 원문 ${name}`));
  if (row.key && /[?？~～/]/.test(row.key)) {
    parts.push(`키 모호(${row.key}) - 원본 확인 필요`);
}
  parts.push(...keyWarnings);
  return parts.join(" | ");
}

function buildSourceReference(csvFileName: string): string {
  return csvFileName;
}

export function csvRowToSong(row: CsvRowInput, rowIndex: number, options: CsvImportOptions): ImportedSong {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const keyIdFactory = options.keyIdFactory ?? idFactory;

  const title = String(row.title || "").trim();
  const artist = String(row.artist || "").trim();
  const recommender = String(row.recommender || "").trim();
  const importedCountry = String(row.country || "").trim();
  const country = NORMALIZED_COUNTRY[importedCountry] ?? importedCountry;
  const originalWork = String(row.originalWork || "").trim();
  const tjNumber = String(row.tjNumber || "").trim();

  const { candidates: keyCandidates, warnings: keyWarnings } = normalizeKeyCandidates(row.key || "", keyIdFactory);
  const warnings = [...keyWarnings];
  const recommenderPerformers = normalizePerformerIds(recommender);
  const memoPerformers = migratePerformerMemo(row.memo || "");
  const performerIds = mergePerformerIds(recommenderPerformers.ids, memoPerformers.ids);
  const unknownPerformerNames = Array.from(new Set([...recommenderPerformers.unknownNames, ...memoPerformers.unknownNames]));

  if (!title) warnings.push(`곡명이 비어있어 (행 ${rowIndex + 1})`);
  if (!artist) warnings.push(`아티스트가 비어있어 (행 ${rowIndex + 1})`);
  unknownPerformerNames.forEach((name) => warnings.push(`알 수 없는 부를 사람 '${name}' (행 ${rowIndex + 1})`));

  const countryGenre = importedCountry && GENRE_BY_COUNTRY[importedCountry] ? GENRE_BY_COUNTRY[importedCountry] : "";
  const genres = Array.from(new Set([countryGenre, ...(row.genres ? [row.genres] : [])].filter(Boolean)));

  const createdAt = toIsoFromKoreanDate(row.createdAt, generatedAt);

  const song: ImportedSong = {
    id: idFactory(),
    tjNumber,
    title,
    titleReadingKo: "",
    titleRomanized: "",
    titleAliases: [],
    artist,
    artistReadingKo: "",
    artistAliases: [],
    country,
    genres,
    originalWork,
    keyCandidates,
    performerIds,
    memo: buildMemo(row, keyWarnings, unknownPerformerNames),
    status: "active",
    youtubeUrl: "",
    youtubeVideoId: "",
    isOfficialTjVideo: null,
    sourceType: "csv",
    sourceReference: buildSourceReference(options.csvFileName),
    createdByName: "",
    createdAt,
    updatedByName: "",
    updatedAt: createdAt,
    deletedAt: "",
    version: 1,
    lastPerformedAt: "",
    performanceCount: 0,
    _warnings: warnings,
    _source: {
      csv: options.csvFileName,
      rowIndex,
      raw: row
    }
  };
  return song;
}

export function importSongsFromCsv(rows: CsvRowInput[], options: CsvImportOptions): CsvImportReport {
  const dedupeByTj = new Map<string, number>();
  const dedupeByTitleArtist = new Map<string, number>();
  const songs: ImportedSong[] = [];
  const skippedRows: CsvImportReport["skippedRows"] = [];
  const warningRows: CsvImportReport["warningRows"] = [];
  const unknownPerformerNames: string[] = [];
  let performerRows = 0;
  let ponyaRows = 0;
  let seongukCorrections = 0;
  let yeoulCorrections = 0;
  let memoRecommenderRemoved = 0;
  let emptyPerformerIds = 0;

  rows.forEach((row, rowIndex) => {
    const song = csvRowToSong(row, rowIndex, options);
    if (!song.title || !song.artist) {
      skippedRows.push({ rowIndex, reason: "필수 필드 누락 (곡명/아티스트)", raw: row });
      return;
    }
    if (song.tjNumber) {
      const existing = dedupeByTj.get(song.tjNumber);
      if (existing !== undefined) {
        skippedRows.push({ rowIndex, reason: `TJ 번호 중복 (행 ${existing + 1})`, raw: row });
        return;
      }
      dedupeByTj.set(song.tjNumber, rowIndex);
    }
    const dedupKey = song.title.toLowerCase() + "|" + song.artist.toLowerCase();
    const existingTitleArtist = dedupeByTitleArtist.get(dedupKey);
    if (existingTitleArtist !== undefined) {
      skippedRows.push({ rowIndex, reason: `곡명/아티스트 중복 (행 ${existingTitleArtist + 1})`, raw: row });
      return;
    }
    dedupeByTitleArtist.set(dedupKey, rowIndex);

    if (song._warnings.length) {
      warningRows.push({ rowIndex, reason: song._warnings.join("; "), raw: row });
    }
    const performerRaw = [row.recommender, row.memo].filter(Boolean).join(" ");
    if (performerRaw.trim()) performerRows += 1;
    if (/뽀냐|ponya/u.test(performerRaw)) ponyaRows += 1;
    if (/seonguk/u.test(performerRaw)) seongukCorrections += 1;
    if (/yeoul/u.test(performerRaw)) yeoulCorrections += 1;
    memoRecommenderRemoved += migratePerformerMemo(row.memo || "").removedCount;
    song._warnings.forEach((warning) => {
      const match = warning.match(/알 수 없는 부를 사람 '(.+?)'/u);
      if (match?.[1] && !unknownPerformerNames.includes(match[1])) unknownPerformerNames.push(match[1]);
    });
    if (song.performerIds.length === 0) emptyPerformerIds += 1;
    songs.push(song);
  });

  return {
    totalRows: rows.length,
    inserted: songs.length,
    skipped: skippedRows.length,
    warnings: warningRows.length,
    performerRows,
    ponyaRows,
    seongukCorrections,
    yeoulCorrections,
    memoRecommenderRemoved,
    unknownPerformerNames,
    emptyPerformerIds,
    songs,
    skippedRows,
    warningRows
  };
}
