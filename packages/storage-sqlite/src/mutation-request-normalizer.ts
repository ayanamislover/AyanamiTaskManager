/**
 * 把一笔写请求折算成「两道幂等闸门都认的那一份」。
 *
 * 同一笔写要过两道闸门，读写的是 idempotency_keys 里同一行：
 *   - session 侧 executeSessionMutation → #resolveMutationActorInternal，只读不写
 *   - kernel 侧 mutate → mutateWithReplay，读且写
 * session 侧拿到的是调用方原样的 request，kernel 侧拿到的是命令层重新拼过的
 * normalizedInput。只要命令层改写了某个字段而这里没跟上，同一笔请求重试就会在
 * session 闸门先炸 IDEMPOTENCY_CONFLICT——明明是合法重放。
 *
 * 所以这里要跟命令层逐字对齐，多一分少一分都是新的分叉。
 */
export class MutationRequestNormalizer {
  readonly #recordIdForReference: (reference: string) => string;
  readonly #normalizeEvidence: (evidence: unknown[]) => unknown[];

  constructor(
    recordIdForReference: (reference: string) => string,
    normalizeEvidence: (evidence: unknown[]) => unknown[],
  ) {
    this.#recordIdForReference = recordIdForReference;
    this.#normalizeEvidence = normalizeEvidence;
  }

  normalize(operation: string, request: unknown): unknown {
    const withEvidence = this.#withNormalizedEvidence(request);
    if (
      operation !== "record.create" ||
      !withEvidence ||
      typeof withEvidence !== "object" ||
      Array.isArray(withEvidence)
    ) {
      return withEvidence;
    }
    const record = withEvidence as Record<string, unknown>;
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

  /**
   * 命令层对 evidence 一律写成 `{...input, evidence: normalize(input.evidence)}`，
   * 批量那支写在 `items[]` 每一项上（progress-commands、checklist-commands、
   * review-commands 都是这个形状）。这里照抄同一个形状。
   *
   * 归一化会因为引用不存在而抛错。在指纹这条路上抛出去只会把「哪个错先报」搞乱——
   * 真正该报这个错的是随后的命令层。所以这里抛了就退回原样，让指纹对不上、
   * 由命令层去报准确的错，而不是在闸门上提前炸。
   */
  #withNormalizedEvidence(request: unknown): unknown {
    if (Array.isArray(request)) return request.map((entry) => this.#withNormalizedEvidence(entry));
    if (!request || typeof request !== "object") return request;
    const value = request as Record<string, unknown>;
    let result = value;
    if (Array.isArray(value.evidence)) {
      try {
        result = { ...result, evidence: this.#normalizeEvidence(value.evidence) };
      } catch {
        return request;
      }
    }
    if (Array.isArray(value.items)) {
      try {
        result = { ...result, items: this.#withNormalizedEvidence(value.items) };
      } catch {
        return request;
      }
    }
    return result;
  }
}
