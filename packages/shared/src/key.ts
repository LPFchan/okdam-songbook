import type { RecommendedKey } from "./schemas.js";

export const KEY_TEXT_PATTERN = /^([여남])(?:자?키)?\s*([+-]?\d{1,2})?$/;

export function parseKeyText(raw: string): { recommendedKey: RecommendedKey; matchedText: string } | null {
  const text = raw.trim();
  const match = text.match(KEY_TEXT_PATTERN);
  const offsetOnly = text.match(/^([+-]\d{1,2})$/);
  if (!match && !offsetOnly) return null;
  const baseMode = match ? (match[1] === "여" ? "female" : "male") : "original";
  const offset = match ? Number(match[2] ?? 0) : Number(offsetOnly?.[1] ?? 0);
  if (!Number.isInteger(offset) || offset < -12 || offset > 12) return null;
  return { recommendedKey: { baseMode, offset }, matchedText: text };
}

export interface MemoKeyMigration {
  recommendedKey: RecommendedKey | null;
  memo: string;
  matched: string[];
}

export function migrateMemoKey(memo: string): MemoKeyMigration {
  if (!memo.trim()) return { recommendedKey: null, memo, matched: [] };
  const segments = memo.split(/[\n,/]/);
  const kept: string[] = [];
  let recommendedKey: RecommendedKey | null = null;
  let matchedText = "";
  for (const segment of segments) {
    const parsed: ReturnType<typeof parseKeyText> = recommendedKey ? null : parseKeyText(segment);
    if (parsed) {
      recommendedKey = parsed.recommendedKey;
      matchedText = parsed.matchedText;
    } else {
      kept.push(segment);
    }
  }
  return { recommendedKey, memo: kept.join("\n").trim(), matched: matchedText ? [matchedText] : [] };
}

export function formatRecommendedKey(key?: RecommendedKey | null): string {
  if (!key) return "";
  const prefix = key.baseMode === "female" ? "여성키" : key.baseMode === "male" ? "남성키" : "원키";
  if (key.offset === 0) return prefix;
  return `${prefix} ${key.offset > 0 ? "+" : ""}${key.offset}`;
}

export interface ParsedRecommendedKey {
  recommendedKey: RecommendedKey | null;
  warnings: string[];
  original: string;
}

export function parseCsvKey(raw: string): ParsedRecommendedKey {
  const original = raw.trim();
  if (!original) return { recommendedKey: null, warnings: [], original };

  const uncertain = /[?？~～]|\/|,/.test(original);
  const baseOnlyMatch = original.match(/^(여|남)$/);
  if (baseOnlyMatch) {
    return {
      recommendedKey: { baseMode: baseOnlyMatch[1] === "여" ? "female" : "male", offset: 0 },
      warnings: [`키 모드 단독 표기는 원본(${original})을 보존하고 변환했어`],
      original
    };
  }
  const warnings: string[] = uncertain ? [`키 값이 애매해서 원본을 확인해야 해: ${original}`] : [];
  const match = original.match(/^(여|남)?\s*([+-]?\d+)$/);
  if (!match) return { recommendedKey: null, warnings: [`키 값을 자동 변환하지 못했어: ${original}`], original };

  const modeMark = match[1];
  const offset = Number(match[2]);
  if (!Number.isInteger(offset) || offset < -12 || offset > 12) {
    return { recommendedKey: null, warnings: [`키 범위를 벗어났어: ${original}`], original };
  }
  return {
    recommendedKey: {
      baseMode: modeMark === "여" ? "female" : modeMark === "남" ? "male" : "original",
      offset
    },
    warnings,
    original
  };
}
