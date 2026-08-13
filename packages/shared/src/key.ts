import type { KeyCandidate } from "./schemas.js";

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
