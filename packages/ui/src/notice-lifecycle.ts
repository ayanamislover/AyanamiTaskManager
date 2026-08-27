export type NoticeTimerRef = { current: number | null };

const noticeLifetimeMs = 2800;

export function cancelNoticeTimer(timer: NoticeTimerRef): void {
  if (timer.current === null) return;
  globalThis.clearTimeout(timer.current);
  timer.current = null;
}

export function restartNoticeTimer(timer: NoticeTimerRef, onElapsed: () => void): void {
  cancelNoticeTimer(timer);
  timer.current = globalThis.setTimeout(() => {
    timer.current = null;
    onElapsed();
  }, noticeLifetimeMs) as unknown as number;
}
