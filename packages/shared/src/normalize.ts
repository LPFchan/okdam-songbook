const CHOSEONG = [
  "ㄱ",
  "ㄲ",
  "ㄴ",
  "ㄷ",
  "ㄸ",
  "ㄹ",
  "ㅁ",
  "ㅂ",
  "ㅃ",
  "ㅅ",
  "ㅆ",
  "ㅇ",
  "ㅈ",
  "ㅉ",
  "ㅊ",
  "ㅋ",
  "ㅌ",
  "ㅍ",
  "ㅎ"
] as const;

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeNumber(value: string): string {
  return value.normalize("NFKC").replace(/[^\d]/g, "");
}

export function getHangulChoseong(value: string): string {
  let result = "";
  for (const char of value.normalize("NFKC")) {
    const code = char.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const index = Math.floor((code - 0xac00) / 588);
      result += CHOSEONG[index] ?? "";
    } else if (/[\u3131-\u314e]/.test(char)) {
      result += char;
    } else if (/\S/.test(char)) {
      result += char.toLocaleLowerCase("ko-KR");
    }
  }
  return result;
}

export function includesAllTokens(haystack: string, query: string): boolean {
  const normalizedHaystack = normalizeText(haystack);
  const normalizedChoseong = getHangulChoseong(haystack);
  return normalizeText(query)
    .split(" ")
    .filter(Boolean)
    .every((token) => normalizedHaystack.includes(token) || normalizedChoseong.includes(token));
}


export function normalizeEmail(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}
