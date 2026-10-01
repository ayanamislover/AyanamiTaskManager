/**
 * 派单的错误码。形状照抄 `@ayanami-task/errors` 的 AtmError（code / httpStatus / retryable / details），
 * 但不往那张全局错误码表里加条目：派单是可选功能，错误只在派单路由与同步命令里出现。
 */
export const DISPATCH_ERROR_POLICIES = Object.freeze({
  DISPATCH_DISABLED: { httpStatus: 409, retryable: false },
  DISPATCH_INVALID_ARGUMENT: { httpStatus: 400, retryable: false },
  DISPATCH_PROJECT_NOT_FOUND: { httpStatus: 404, retryable: false },
  DISPATCH_PROJECT_PATH_MISSING: { httpStatus: 422, retryable: false },
  DISPATCH_TASK_NOT_FOUND: { httpStatus: 404, retryable: false },
  DISPATCH_TASK_NOT_READY: { httpStatus: 409, retryable: false },
  DISPATCH_ALREADY_ACTIVE: { httpStatus: 409, retryable: false },
  DISPATCH_CLAUDE_NOT_FOUND: { httpStatus: 503, retryable: false },
  DISPATCH_CLAUDE_NOT_LOGGED_IN: { httpStatus: 503, retryable: false },
  DISPATCH_RUN_NOT_FOUND: { httpStatus: 404, retryable: false },
  DISPATCH_RUN_NOT_ACTIVE: { httpStatus: 409, retryable: false },
  /**
   * 取消时没能结束会话进程（taskkill 失败），或确认不了那个 PID 还是不是这次的会话：
   * 派单仍算运行中、并发名额不释放，可以重试。是宿主这边没办成，所以按 500 + retryable。
   */
  DISPATCH_CANCEL_FAILED: { httpStatus: 500, retryable: true },
  /** 保留期内的手机派单请求数到了账本上限（见 request-ledger.ts），条目过期后自然恢复。 */
  DISPATCH_TOO_MANY_REQUESTS: { httpStatus: 429, retryable: true },
} as const);

export type DispatchErrorCode = keyof typeof DISPATCH_ERROR_POLICIES;

/**
 * claude 命令行没登录或登录过期时给用户看的话：派单被拒（DISPATCH_CLAUDE_NOT_LOGGED_IN）
 * 与会话因鉴权失败结束（run.error）用同一句，原文另存在 summary.result。
 */
export const CLAUDE_LOGIN_REQUIRED_MESSAGE =
  "Claude Code 未登录或登录已过期：在电脑终端运行 claude auth login 后再交给 Claude";

export type DispatchErrorDto = {
  code: DispatchErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export class DispatchError extends Error {
  readonly code: DispatchErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | null;

  constructor(
    code: DispatchErrorCode,
    message: string,
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
    this.httpStatus = DISPATCH_ERROR_POLICIES[code].httpStatus;
    this.retryable = DISPATCH_ERROR_POLICIES[code].retryable;
    this.details = details;
  }

  toDto(): DispatchErrorDto {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === null ? {} : { details: this.details }),
    };
  }
}

export function isDispatchError(error: unknown): error is DispatchError {
  return error instanceof DispatchError;
}
