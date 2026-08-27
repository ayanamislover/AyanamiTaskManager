export type AtmBaseErrorDetails = Readonly<Record<string, unknown>>;

const policy = (httpStatus: number, retryable = false) => ({ httpStatus, retryable }) as const;

/** The compile-time and runtime truth source for every typed ATM error code. */
export const ERROR_POLICIES = Object.freeze({
  AGENT_DOCS_MISSING: policy(500, true),
  AGENT_GUIDE_MISSING: policy(500, true),
  AGENT_RULE_MODIFIED_REQUIRES_REPAIR: policy(409),
  AGENT_RULE_NEEDS_EXPLICIT_UPDATE: policy(409),
  AGENT_SKILLS_MISSING: policy(500, true),
  AGENT_SKILL_MISSING: policy(500, true),
  AGENT_SKILL_MODIFIED_REQUIRES_REPAIR: policy(409),
  ATOMIC_BEGIN_REQUIRES_EXISTING_PROJECT: policy(422),
  BACKUP_FILE_MISSING: policy(422),
  BACKUP_HASH_MISMATCH: policy(422),
  BACKUP_INTEGRITY_FAILED: policy(422),
  BACKUP_MANIFEST_MISMATCH: policy(422),
  BACKUP_MANIFEST_MISSING: policy(422),
  BACKUP_NOT_FOUND: policy(404),
  BACKUP_PROJECT_IDENTITY_MISMATCH: policy(422),
  BACKUP_RESTORE_SCOPE_UNSUPPORTED: policy(422),
  BLOCKED_REASON_REQUIRED: policy(422),
  CANDIDATE_HASH_MISMATCH: policy(409),
  CHECKLIST_NOT_FOUND: policy(404),
  CLAIM_OWNER_REQUIRED: policy(422),
  COMPLETION_GATE_FAILED: policy(409),
  CONTINUATION_CONFLICT: policy(409),
  COUNTER_NOT_FOUND: policy(404),
  DEPENDENCY_CYCLE: policy(409),
  DEPENDENCY_NOT_READY: policy(409),
  DEPENDENCY_REF_NOT_FOUND: policy(404),
  DISCOVERED_FROM_REF_NOT_FOUND: policy(404),
  DUPLICATE_TOOL_DEFINITION: policy(500),
  EXTERNAL_NAME_MISSING: policy(500),
  FORBIDDEN: policy(403),
  HIERARCHY_CYCLE: policy(409),
  HIERARCHY_DEPTH: policy(422),
  IDEMPOTENCY_CONFLICT: policy(409),
  IMMUTABLE_RECORD: policy(409),
  IMPORT_OBJECTIVE_MISSING: policy(422),
  IMPORT_SOURCE_CHANGED: policy(409),
  INTERNAL_ERROR: policy(500, true),
  INVALID_ARGUMENT: policy(400),
  INVALID_CURSOR: policy(422),
  INVALID_PROJECT_CODE: policy(422),
  INVALID_RESPONSE: policy(502, true),
  INVALID_TOOL_DESCRIPTION: policy(500),
  INVALID_TRANSITION: policy(409),
  INVALID_WORK_ITEM_KEY: policy(422),
  METHOD_NOT_ALLOWED: policy(405),
  MIGRATION_FILE_MISSING: policy(409),
  MIGRATION_GAP: policy(409),
  MIGRATION_HASH_MISMATCH: policy(409),
  MIGRATION_HASH_ORIGIN: policy(409),
  MIGRATION_HISTORY_GAP: policy(409),
  MIGRATION_NAME_MISMATCH: policy(409),
  MIGRATION_PLAN_EMPTY: policy(409),
  MILESTONE_OBJECTIVE_MISMATCH: policy(409),
  MILESTONE_NOT_FOUND: policy(404),
  NOT_FOUND: policy(404),
  OBJECTIVE_NOT_FOUND: policy(404),
  OBJECTIVE_REQUIRED: policy(422),
  OPERATION_ID_INVALID: policy(422),
  OPERATION_NOT_FOUND: policy(404),
  PARENT_REF_NOT_FOUND: policy(404),
  PROGRESS_NOT_FOUND: policy(404),
  PROJECT_ALREADY_EXISTS: policy(409),
  PROJECT_CODE_CONFLICT: policy(409),
  PROJECT_CODE_EXHAUSTED: policy(409),
  PROJECT_DB_QUICK_CHECK_FAILED: policy(500, true),
  PROJECT_DB_UNAVAILABLE: policy(503, true),
  PROJECT_LIFECYCLE_CONFLICT: policy(409),
  PROJECT_META_MISSING: policy(500),
  PROJECT_NOT_FOUND: policy(404),
  PROJECT_PATH_CONFLICT: policy(409),
  PROJECT_REQUIRED: policy(422),
  PROJECT_UPDATE_DRAFT_NOT_FOUND: policy(404),
  PROJECT_UPDATE_NOT_FOUND: policy(404),
  RECORD_NOT_FOUND: policy(404),
  RESULT_TOO_LARGE: policy(422),
  REVIEWER_REQUIRED: policy(403),
  REVIEWER_SESSION_REQUIRED: policy(422),
  REVIEW_ALREADY_SUBMITTED: policy(409),
  REVIEW_BINDING_MISMATCH: policy(409),
  REVIEW_CHECKLIST_CLOSED: policy(409),
  REVIEW_IDENTITY_MISMATCH: policy(409),
  REVIEW_REQUEST_CONFLICT: policy(409),
  REVIEW_REQUEST_NOT_FOUND: policy(404),
  REVIEW_REQUEST_REQUIRES_SESSION: policy(422),
  REVIEW_TASK_CLOSED: policy(409),
  REVIEW_TASK_INVALID: policy(422),
  SAVED_VIEW_NAME_REQUIRED: policy(422),
  SESSION_CLOSED: policy(409),
  SESSION_NOT_FOUND: policy(404),
  SESSION_NOT_RETIRED: policy(409),
  SESSION_REQUIRED: policy(422),
  SESSION_SUCCESSOR_AGENT_MISMATCH: policy(409),
  SESSION_SUCCESSOR_AMBIGUOUS: policy(409),
  SESSION_SUCCESSOR_IDENTITY_MISMATCH: policy(409),
  SETTING_KEY_INVALID: policy(422),
  SQLITE_FTS5_TRIGRAM_REQUIRED: policy(500),
  SQLITE_VERSION_UNSAFE: policy(500),
  TASK_ALREADY_CLAIMED: policy(409),
  UNAUTHORIZED: policy(401),
  VALIDATION_ERROR: policy(422),
  VERSION_CONFLICT: policy(409, true),
  WAITING_FOR_REQUIRED: policy(422),
  WORK_ITEM_NOT_FOUND: policy(404),
} as const);

export type AtmErrorCode = keyof typeof ERROR_POLICIES;

export type ProjectNotFoundDetails = {
  readonly entity: "PROJECT";
  readonly reference: string;
  readonly did_you_mean?: string | null;
  readonly candidates?: ReadonlyArray<{ readonly code: string; readonly name: string }>;
};

export type VersionConflictDetails = {
  readonly entity: string;
  readonly key: string;
  readonly expected: number;
  readonly actual: number;
  readonly [key: string]: unknown;
};

export type ChecklistFailureReason =
  | {
      readonly task_key: string;
      readonly code: "VERSION_CONFLICT";
      readonly expected: number;
      readonly actual: number;
    }
  | {
      readonly checklist_id: string;
      readonly code: "NOT_FOUND" | "TASK_MISMATCH" | "EVIDENCE_REQUIRED";
    };

export type CompletionGateReason =
  | ChecklistFailureReason
  | { readonly code: "CHECKLIST_INCOMPLETE"; readonly checklist_id?: string }
  | { readonly code: "EVIDENCE_MISSING"; readonly checklist_id?: string }
  | { readonly code: "CHILD_INCOMPLETE"; readonly work_item_id?: string }
  | { readonly code: "BLOCKER_ACTIVE"; readonly blocker_id?: string }
  | { readonly code: "DEPENDENCY_INCOMPLETE"; readonly work_item_id?: string }
  | { readonly code: "VERIFICATION_REQUIRED" }
  | {
      readonly code: "CURRENT_STATE_INVALID";
      readonly current_status: string;
      readonly legal_operations: readonly string[];
    };

export type CompletionGateFailedDetails = {
  readonly reasons: readonly CompletionGateReason[];
};

export type InvalidTransitionDetails = {
  readonly current_status: string;
  readonly requested_status: string;
  readonly operation?: string;
  readonly legal_operations?: readonly string[];
};

type SpecificErrorDetails = {
  PROJECT_NOT_FOUND: ProjectNotFoundDetails;
  VERSION_CONFLICT: VersionConflictDetails;
  COMPLETION_GATE_FAILED: CompletionGateFailedDetails;
  INVALID_TRANSITION: InvalidTransitionDetails;
};

export type ErrorDetailsByCode = {
  readonly [C in AtmErrorCode]: C extends keyof SpecificErrorDetails
    ? SpecificErrorDetails[C]
    : AtmBaseErrorDetails;
};

export type AtmErrorOptions<C extends AtmErrorCode> = {
  readonly message?: string;
  readonly details?: ErrorDetailsByCode[C] | null;
  readonly httpStatus?: number;
  readonly retryable?: boolean;
  readonly cause?: unknown;
};

export type AtmErrorDto<C extends AtmErrorCode = AtmErrorCode> = {
  readonly code: C;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: ErrorDetailsByCode[C];
};

export function isAtmErrorCode(value: unknown): value is AtmErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_POLICIES, value);
}

export function errorPolicy(code: AtmErrorCode): (typeof ERROR_POLICIES)[AtmErrorCode] {
  return ERROR_POLICIES[code];
}

export class AtmError<C extends AtmErrorCode = AtmErrorCode> extends Error {
  readonly code: C;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: ErrorDetailsByCode[C] | null;

  constructor(code: C, options: AtmErrorOptions<C> = {}) {
    if (!isAtmErrorCode(code)) throw new TypeError(`Unknown ATM error code: ${String(code)}`);
    const defaults = errorPolicy(code);
    super(
      options.message ?? code,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AtmError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? defaults.httpStatus;
    this.retryable = options.retryable ?? defaults.retryable;
    this.details = options.details ?? null;
  }

  withDetails(details: ErrorDetailsByCode[C] | null): AtmError<C> {
    return new AtmError(this.code, {
      message: this.message,
      details,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      cause: this,
    });
  }
}

export function isAtmError(error: unknown): error is AtmError {
  return error instanceof AtmError;
}

export function asAtmError(error: unknown): AtmError {
  if (isAtmError(error)) return error;
  return new AtmError("INTERNAL_ERROR", {
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

export function atmErrorDto<C extends AtmErrorCode>(error: AtmError<C>): AtmErrorDto<C> {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.details === null ? {} : { details: error.details }),
  };
}

export function normalizedSuggestionText(value: string): string {
  return value
    .slice(0, 128)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "");
}

export function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

export function rankSuggestions<T>(
  queryValue: string,
  candidates: readonly T[],
  identities: (candidate: T) => readonly string[],
  limit = 5,
): { didYouMean: string | null; candidates: T[] } {
  const query = normalizedSuggestionText(queryValue);
  if (!query) return { didYouMean: null, candidates: [] };
  const ranked = candidates
    .map((candidate) => {
      const values = identities(candidate).map(normalizedSuggestionText).filter(Boolean);
      const rawScore = Math.min(...values.map((value) => editDistance(query, value)));
      const prefix = values.some((value) => value.startsWith(query) || query.startsWith(value));
      return {
        candidate,
        identity: values[0] ?? "",
        rawScore,
        score: rawScore - (prefix ? 0.5 : 0),
        prefix,
      };
    })
    .sort((left, right) => left.score - right.score || left.identity.localeCompare(right.identity))
    .slice(0, limit);
  const first = ranked[0];
  const plausible =
    first !== undefined &&
    (first.prefix || first.rawScore <= Math.max(2, Math.ceil(query.length * 0.34)));
  return {
    didYouMean: plausible && first ? (identities(first.candidate)[0] ?? null) : null,
    candidates: ranked.map(({ candidate }) => candidate),
  };
}
