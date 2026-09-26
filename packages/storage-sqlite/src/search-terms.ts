// 搜索词拆分。整条 query 当一个短语匹配时，最自然的查法——ID 加几个关键词，
// 比如 `D-398 HALF_OPEN 复审裁决`——反而 0 命中：三个词在正文里并不相邻。
// 这里按空白拆成若干词，每个词各自匹配、彼此 AND；双引号括起来的一段仍当一个词，
// 给确实需要相邻短语的调用方留一条路。

import { AtmError } from "@ayanami-task/errors";

export const MAX_SEARCH_TERMS = 8;

/**
 * 超过上限直接拒绝，不截断（ATM-T-0490 P2）：公开契约是「每个词都须命中」，
 * 悄悄丢掉第九个词以后，缺了那个词的文档也会被当成命中返回。
 */
export function searchTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of query.matchAll(/"([^"]*)"|(\S+)/gu)) {
    const term = (match[1] ?? match[2] ?? "").trim();
    const folded = term.toLowerCase();
    if (!term || seen.has(folded)) continue;
    seen.add(folded);
    terms.push(term);
  }
  if (terms.length > MAX_SEARCH_TERMS)
    throw new AtmError("VALIDATION_ERROR", {
      message: `query 最多 ${MAX_SEARCH_TERMS} 个词（去重后 ${terms.length} 个）：删掉次要的词，或用双引号把相邻的几个词合成一个短语`,
      details: {
        field: "query",
        issue: "too_many_terms",
        max: MAX_SEARCH_TERMS,
        actual: terms.length,
      },
    });
  return terms;
}

/** trigram FTS 服务不了少于三个 code point 的词，这些词只能扫表。 */
export function usesFts(term: string): boolean {
  return [...term].length >= 3;
}

/** 引号短语让 FTS 语法字面化：连字符、冒号、AND/OR 都不再是运算符。 */
export function ftsPhrase(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/** %、_ 和反斜杠在 LIKE 里是元字符，配合 ESCAPE '\\' 使用。 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/gu, "\\$&")}%`;
}

export type TermPredicate = { sql: string; params: unknown[] };

/** 每个词一个谓词，全部 AND。没有词时恒假，调用方据此返回空页。 */
export function allTerms(terms: string[], predicate: (term: string) => TermPredicate) {
  if (terms.length === 0) return { sql: "0 = 1", params: [] as unknown[] };
  const parts = terms.map(predicate);
  return {
    sql: parts.map((part) => `(${part.sql})`).join(" AND "),
    params: parts.flatMap((part) => part.params),
  };
}
