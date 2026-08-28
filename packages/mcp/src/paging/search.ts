import { plain } from "../result.js";
import { selectFields } from "./field.js";

export function publicKeyKind(value: string): "WORK_ITEM" | "RECORD" | null {
  if (/-T-\d+$/iu.test(value)) return "WORK_ITEM";
  if (/-[DR]-\d+$/iu.test(value)) return "RECORD";
  return null;
}

export function projectFromPublicKey(value: string): string | null {
  const match = /^(.*)-(?:T|D|R)-\d+$/iu.exec(value.trim());
  return match?.[1]?.toUpperCase() ?? null;
}

function compactSearchHit(hit: Record<string, unknown>): Record<string, unknown> {
  return {
    entity_type: hit.entityType,
    entity_key: hit.entityKey,
    title: hit.title,
    snippet: hit.snippet,
    updated_at: hit.updatedAt,
    ...(hit.project === undefined ? {} : { project: hit.project }),
  };
}

export type SearchServicePage = {
  hits: any[];
  nextCursor: string | null;
  hasMore: boolean;
};

export async function fitSearchPage(input: {
  initial: SearchServicePage;
  fetchPage: (limit: number) => Promise<SearchServicePage> | SearchServicePage;
  requestedLimit: number;
  inputCursor?: string;
  fieldMask: string[];
  maxChars: number;
}): Promise<Record<string, unknown>> {
  const maximum = Math.min(input.requestedLimit, input.initial.hits.length);
  for (let count = maximum; count >= 1; count -= 1) {
    const page = count === input.requestedLimit ? input.initial : await input.fetchPage(count);
    const hits = page.hits
      .slice(0, count)
      .map((hit) => selectFields(compactSearchHit(plain(hit)), input.fieldMask));
    const candidate: Record<string, unknown> = {
      exact: false,
      requested_limit: input.requestedLimit,
      returned_count: hits.length,
      hits,
      next_cursor: page.hasMore ? page.nextCursor : null,
      has_more: page.hasMore,
      truncated: count < input.requestedLimit,
    };
    if (JSON.stringify(candidate).length <= input.maxChars) return candidate;
  }
  if (input.initial.hits.length === 0) {
    return {
      exact: false,
      requested_limit: input.requestedLimit,
      returned_count: 0,
      hits: [],
      next_cursor: null,
      has_more: false,
      truncated: false,
    };
  }
  const retry: Record<string, unknown> = {
    exact: false,
    returned_count: 0,
    hits: [],
    next_cursor: input.inputCursor ?? null,
    has_more: true,
    truncated: true,
  };
  if (JSON.stringify(retry).length <= input.maxChars) return retry;
  return {
    code: "RESULT_TOO_LARGE",
    next_cursor: input.inputCursor ?? null,
    has_more: true,
    truncated: true,
  };
}
