export const notificationModes = ["ALL", "CRITICAL", "OFF"] as const;
export type NotificationMode = (typeof notificationModes)[number];

const supportedEvents = new Set([
  "work.waiting",
  "work.blocked",
  "work.completed",
  "agent.recovered_stale",
  "backup.failed",
]);

const criticalEvents = new Set(["work.blocked", "agent.recovered_stale", "backup.failed"]);

export function normalizeNotificationMode(
  value: unknown,
  legacyEnabled: unknown,
): NotificationMode {
  if (notificationModes.includes(value as NotificationMode)) return value as NotificationMode;
  return legacyEnabled === false ? "OFF" : "ALL";
}

export function shouldNotify(mode: NotificationMode, eventType: string): boolean {
  if (mode === "OFF" || !supportedEvents.has(eventType)) return false;
  return mode === "ALL" || criticalEvents.has(eventType);
}
