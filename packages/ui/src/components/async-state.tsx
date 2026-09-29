import type { CSSProperties, ReactNode } from "react";

export function LoadingRows({ count = 4 }: { count?: number }) {
  return (
    <div className="atm-panel-body" style={{ display: "grid", gap: 9 }}>
      {Array.from({ length: count }, (_, index) => (
        <div className="atm-skeleton" key={index} />
      ))}
    </div>
  );
}

export function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="atm-empty">
      <div>
        <strong>{title}</strong>
        <div>{text}</div>
        {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
      </div>
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="atm-error">
      <div>
        <strong>载入失败</strong>
        <div>{error instanceof Error ? error.message : String(error)}</div>
      </div>
    </div>
  );
}

export function MutationErrorAlert({
  error,
  errors,
  prefix = "",
  className = "",
  style,
}: {
  error?: unknown;
  errors?: readonly unknown[];
  prefix?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const current =
    error ?? errors?.find((candidate) => candidate !== null && candidate !== undefined);
  if (current === null || current === undefined) return null;
  const rawMessage = current instanceof Error ? current.message : String(current);
  const message = rawMessage.length > 500 ? `${rawMessage.slice(0, 499)}…` : rawMessage;
  return (
    <div
      className={`atm-inline-error${className ? ` ${className}` : ""}`}
      role="alert"
      style={style}
    >
      {prefix}
      {message}
    </div>
  );
}

export function CursorLoadStatus({
  loadedCount,
  matchedCount,
  hasMore,
  loading,
  error,
  onRetry,
}: {
  loadedCount: number;
  /**
   * 页面只展示加载结果里的一部分（比如只看进行中）时传这个：状态行要数「显示了几项」，
   * 不能数「扫过几项」，否则表里 4 行、上面却写着已加载 56 项。
   */
  matchedCount?: number;
  hasMore: boolean;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  if (matchedCount !== undefined) {
    return (
      <MatchedLoadStatus
        matchedCount={matchedCount}
        hasMore={hasMore}
        {...(loading === undefined ? {} : { loading })}
        error={error}
        {...(onRetry ? { onRetry } : {})}
      />
    );
  }
  if (error) {
    return (
      <div className="atm-inline-error" role="alert">
        已加载 {loadedCount} 项，后续分页加载失败。
        {onRetry ? (
          <button className="atm-button" style={{ marginLeft: 8 }} onClick={onRetry}>
            重试
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="atm-row-sub atm-cursor-load-status" role="status" aria-live="polite">
      {loading
        ? `已加载 ${loadedCount} 项，正在加载后续…`
        : hasMore
          ? `已加载 ${loadedCount} 项`
          : `已加载 ${loadedCount} 项，已全部加载`}
    </div>
  );
}

function MatchedLoadStatus({
  matchedCount,
  hasMore,
  loading,
  error,
  onRetry,
}: {
  matchedCount: number;
  hasMore: boolean;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  if (error) {
    return (
      <div className="atm-inline-error" role="alert">
        已找到 {matchedCount} 项，部分任务读取失败，可能还有没列出的。
        {onRetry ? (
          <button className="atm-button" style={{ marginLeft: 8 }} onClick={onRetry}>
            重试
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="atm-row-sub atm-cursor-load-status" role="status" aria-live="polite">
      {loading
        ? `已找到 ${matchedCount} 项，正在加载后续…`
        : hasMore
          ? `已找到 ${matchedCount} 项，还有任务未加载`
          : `共 ${matchedCount} 项`}
    </div>
  );
}

export function PageHead({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="atm-page-head">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="atm-actions">{actions}</div> : null}
    </header>
  );
}
