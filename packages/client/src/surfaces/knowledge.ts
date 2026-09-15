import type {
  KnowledgeArchiveInput,
  KnowledgeEntry,
  KnowledgeGetInput,
  KnowledgeGetPage,
  KnowledgeHistoryPage,
  KnowledgeRecordPreview,
  KnowledgeSaveInput,
  KnowledgeSearchInput,
  KnowledgeSearchPage,
} from "../types.js";
import { queryString, type ClientRequest } from "../http.js";

export function createKnowledgeSurface(request: ClientRequest) {
  return {
    search: (input: Partial<KnowledgeSearchInput> = {}) =>
      request<KnowledgeSearchPage>(
        "GET",
        `/api/v1/knowledge${queryString({
          query: input.query,
          tag: input.tag,
          includeArchived: input.includeArchived,
          limit: input.limit,
          maxChars: input.maxChars,
          cursor: input.cursor,
        })}`,
      ),
    get: (id: string, input: Omit<Partial<KnowledgeGetInput>, "id"> = {}) =>
      request<KnowledgeGetPage>(
        "GET",
        `/api/v1/knowledge/${encodeURIComponent(id)}${queryString({
          revisionId: input.revisionId,
          section: input.section,
          maxChars: input.maxChars,
          cursor: input.cursor,
        })}`,
      ),
    history: (id: string, beforeRevision?: number, limit?: number) =>
      request<KnowledgeHistoryPage>(
        "GET",
        `/api/v1/knowledge/${encodeURIComponent(id)}/history${queryString({ beforeRevision, limit })}`,
      ),
    save: (input: KnowledgeSaveInput) =>
      request<KnowledgeEntry>("POST", "/api/v1/knowledge", input),
    update: (id: string, input: Omit<KnowledgeSaveInput, "id">) =>
      request<KnowledgeEntry>("PATCH", `/api/v1/knowledge/${encodeURIComponent(id)}`, {
        ...input,
        id,
      }),
    archive: (input: Omit<KnowledgeArchiveInput, "id"> & { id: string }) =>
      request<KnowledgeEntry>(
        "POST",
        `/api/v1/knowledge/${encodeURIComponent(input.id)}/archive`,
        input,
      ),
    previewRecord: (project: string, record: string) =>
      request<KnowledgeRecordPreview>(
        "GET",
        `/api/v1/knowledge/preview-record${queryString({ project, record })}`,
      ),
  };
}
