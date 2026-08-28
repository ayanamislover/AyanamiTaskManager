export class MutationRequestNormalizer {
  readonly #recordIdForReference: (reference: string) => string;

  constructor(recordIdForReference: (reference: string) => string) {
    this.#recordIdForReference = recordIdForReference;
  }

  normalize(operation: string, request: unknown): unknown {
    if (
      operation !== "record.create" ||
      !request ||
      typeof request !== "object" ||
      Array.isArray(request)
    ) {
      return request;
    }
    const record = request as Record<string, unknown>;
    return {
      ...record,
      ...(typeof record.supersedes === "string" && record.supersedes.trim()
        ? { supersedes: this.#recordIdForReference(record.supersedes) }
        : {}),
      ...(typeof record.topic === "string" ? { topic: record.topic.trim() || null } : {}),
      ...(typeof record.subjectKey === "string"
        ? { subjectKey: record.subjectKey.trim() || null }
        : {}),
    };
  }
}
