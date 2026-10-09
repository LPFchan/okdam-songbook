export const performerOrder = ["marie", "yeowool", "seongwook", "eunhu"] as const;

export type PerformerId = (typeof performerOrder)[number];

export interface Performer {
  id: PerformerId;
  displayName: string;
}

export const performers: Record<PerformerId, Performer> = {
  marie: { id: "marie", displayName: "마리" },
  seongwook: { id: "seongwook", displayName: "성욱" },
  eunhu: { id: "eunhu", displayName: "은후" },
  yeowool: { id: "yeowool", displayName: "여울" }
};

const performerAliasMap: Record<string, PerformerId[]> = {
  "마리": ["marie"],
  "성욱": ["seongwook"],
  "여울": ["yeowool"],
  "은후": ["eunhu"],
  "뽀냐": ["marie", "yeowool"],
  marie: ["marie"],
  seongwook: ["seongwook"],
  seonguk: ["seongwook"],
  yeowool: ["yeowool"],
  yeoul: ["yeowool"],
  eunhu: ["eunhu"],
  ponya: ["marie", "yeowool"]
};

const performerAliases = Object.keys(performerAliasMap).sort((a, b) => b.length - a.length);

export interface PerformerParseResult {
  ids: PerformerId[];
  unknownNames: string[];
}

export interface MemoPerformerMigrationResult extends PerformerParseResult {
  memo: string;
  removedCount: number;
}

function normalizePerformerToken(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/^추천인\s*/u, "")
    .replace(/^[()[\]{}"'`]+|[()[\]{}"'`]+$/gu, "")
    .replace(/[。．.!！?？:：;；]+$/gu, "")
    .replace(/\s+/gu, " ");
}

function addIds(target: PerformerId[], ids: PerformerId[]) {
  ids.forEach((id) => {
    if (!target.includes(id)) target.push(id);
  });
}

function splitPerformerText(value: string): string[] {
  return normalizePerformerToken(value)
    .replace(/[,，、/／·・\n\r\t]+/gu, " ")
    .split(/\s+/u)
    .map(normalizePerformerToken)
    .filter(Boolean);
}

export function normalizePerformerIds(value: unknown): PerformerParseResult {
  const ids: PerformerId[] = [];
  const unknownNames: string[] = [];
  const values = Array.isArray(value) ? value : typeof value === "string" ? splitPerformerText(value) : [];

  values.forEach((entry) => {
    const token = normalizePerformerToken(String(entry));
    if (!token) return;
    const mapped = performerAliasMap[token];
    if (mapped) {
      addIds(ids, mapped);
      return;
    }
    if (!unknownNames.includes(token)) unknownNames.push(token);
  });

  return { ids, unknownNames };
}

function consumeLeadingPerformers(value: string): { ids: PerformerId[]; unknownNames: string[]; rest: string } {
  let rest = normalizePerformerToken(value);
  const ids: PerformerId[] = [];
  const unknownNames: string[] = [];
  let consumed = false;

  while (rest) {
    rest = rest.replace(/^[\s,，、/／·・]+/u, "");
    const alias = performerAliases.find((candidate) => rest === candidate || rest.startsWith(`${candidate} `) || /^[,，、/／·・]/u.test(rest.slice(candidate.length, candidate.length + 1)));
    if (!alias) break;
    addIds(ids, performerAliasMap[alias] ?? []);
    rest = rest.slice(alias.length);
    consumed = true;
  }

  if (!consumed && rest) {
    const token = splitPerformerText(rest)[0];
    if (token) unknownNames.push(token);
  }

  return { ids, unknownNames, rest: rest.replace(/^[\s,，、/／·・]+/u, "").trim() };
}

export function migratePerformerMemo(memo: string): MemoPerformerMigrationResult {
  const ids: PerformerId[] = [];
  const unknownNames: string[] = [];
  let removedCount = 0;

  const parts = String(memo || "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  const kept = parts.flatMap((part) => {
    if (!/^추천인\s+/u.test(part)) return [part];
    const parsed = consumeLeadingPerformers(part.replace(/^추천인\s+/u, ""));
    addIds(ids, parsed.ids);
    parsed.unknownNames.forEach((name) => {
      if (!unknownNames.includes(name)) unknownNames.push(name);
    });
    if (parsed.ids.length) removedCount += 1;
    if (parsed.rest) return [parsed.rest];
    return parsed.ids.length ? [] : [part];
  });

  return { ids, unknownNames, memo: kept.join(" | "), removedCount };
}

export function mergePerformerIds(...groups: PerformerId[][]): PerformerId[] {
  const ids: PerformerId[] = [];
  groups.forEach((group) => addIds(ids, group));
  return ids;
}

export function sortPerformerIds(ids: PerformerId[]): PerformerId[] {
  return [...ids].sort((a, b) => performerOrder.indexOf(a) - performerOrder.indexOf(b));
}

export function formatPerformerNames(ids: PerformerId[], compact = false): string {
  const sorted = sortPerformerIds(ids);
  if (!sorted.length) return "";
  const first = sorted[0];
  if (compact && sorted.length > 2 && first) return `${performers[first].displayName} 외 ${sorted.length - 1}명`;
  return sorted.map((id) => performers[id]?.displayName ?? id).join(" · ");
}

export function performerSearchText(ids: PerformerId[]): string {
  const names = ids.flatMap((id) => [id, performers[id]?.displayName ?? ""]);
  if (ids.includes("marie") && ids.includes("yeowool")) names.push("뽀냐");
  return names.filter(Boolean).join(" ");
}
