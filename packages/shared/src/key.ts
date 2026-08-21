import type { KeyCandidate } from "./schemas.js";

export const KEY_TEXT_PATTERN = /^([여남])(?:키)?\s*([+-]?\d{1,2})?$/;

/**
 * Read key notation written in free text ("여+1", "남 -2", "여키", "-3").
 * Returns null when the text is not recognisable as a key notation, so the
 * caller can leave the memo untouched instead of guessing.
 */
export function parseKeyText(
  raw: string,
  idFactory: () => string = () => crypto.randomUUID()
): { candidate: KeyCandidate; matchedText: string } | null {
  const text = raw.trim();
  const match = text.match(KEY_TEXT_PATTERN);
  const offsetOnly = text.match(/^([+-]\d{1,2})$/);
  if (!match && !offsetOnly) return null;
  const baseMode = match ? (match[1] === "여" ? "female" : "male") : "original";
  const offset = match ? Number(match[2] ?? 0) : Number(offsetOnly?.[1] ?? 0);
  if (!Number.isInteger(offset) || offset < -12 || offset > 12) return null;
  return {
    candidate: {
      id: idFactory(),
      baseMode,
      offset,
      label: "추천",
      memo: "",
      isPrimary: true
    },
    matchedText: text
  };
}

export interface MemoKeyMigration {
  candidates: KeyCandidate[];
  memo: string;
  matched: string[];
}

/**
 * Extract key notations from a memo. Only whole segments (split on newlines,
 * commas, slashes) that are entirely key notation are moved; anything else
 * stays in the memo verbatim.
 */
export function migrateMemoKey(
  memo: string,
  idFactory: () => string = () => crypto.randomUUID()
): MemoKeyMigration {
  if (!memo.trim()) return { candidates: [], memo, matched: [] };
  const segments = memo.split(/[\n,/]/);
  const matched: string[] = [];
  const candidates: KeyCandidate[] = [];
  const kept: string[] = [];
  for (const segment of segments) {
    const parsed = parseKeyText(segment, idFactory);
    if (parsed) {
      matched.push(parsed.matchedText);
      candidates.push(parsed.candidate);
    } else {
      kept.push(segment);
    }
  }
  candidates.forEach((candidate, index) => {
    candidate.isPrimary = index === 0;
  });
  return { candidates, memo: kept.join("\n").trim(), matched };
}

export function formatKeyCandidate(candidate?: KeyCandidate | null): string {
  if (!candidate) return "";
  const prefix =
    candidate.baseMode === "female"
      ? "여성키"
      : candidate.baseMode === "male"
        ? "남성키"
        : candidate.baseMode === "custom"
          ? candidate.label || "커스텀"
          : "원키";
  if (candidate.offset === 0) return prefix;
  return `${prefix} ${candidate.offset > 0 ? "+" : ""}${candidate.offset}`;
}

export interface ParsedKeyCandidate {
  candidates: KeyCandidate[];
  warnings: string[];
  original: string;
}

export function parseCsvKey(raw: string, idFactory: () => string = () => crypto.randomUUID()): ParsedKeyCandidate {
  const original = raw.trim();
  if (!original) return { candidates: [], warnings: [], original };

  const uncertain = /[?？~～]|\/|,/.test(original);
  const baseOnlyMatch = original.match(/^(여|남)$/);
  if (baseOnlyMatch) {
    return {
      candidates: [
        {
          id: idFactory(),
          baseMode: baseOnlyMatch[1] === "여" ? "female" : "male",
          offset: 0,
          label: "추천",
          memo: "",
          isPrimary: true
        }
      ],
      warnings: [`키 모드 단독 표기는 원본(${original})을 보존하고 변환했어`],
      original
    };
  }
  const warnings: string[] = uncertain ? [`키 값이 애매해서 원본을 확인해야 해: ${original}`] : [];
  const match = original.match(/^(여|남)?\s*([+-]?\d+)$/);
  if (!match) {
    return { candidates: [], warnings: [`키 값을 자동 변환하지 못했어: ${original}`], original };
  }

  const modeMark = match[1];
  const offset = Number(match[2]);
  const baseMode = modeMark === "여" ? "female" : modeMark === "남" ? "male" : "original";
  return {
    candidates: [
      {
        id: idFactory(),
        baseMode,
        offset,
        label: "추천",
        memo: "",
        isPrimary: true
      }
    ],
    warnings,
    original
  };
}
