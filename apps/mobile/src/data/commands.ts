import {
  COMMAND_MAX_AGE_MS,
  CommandDocSchema,
  type AckDoc,
  type CommandDoc,
} from "@ayanami-task/sync-protocol";

/**
 * 手机发出的命令在本地的生命周期（docs/mobile-sync.md §5–§6、§9）：
 *
 *   pending ──写入中继──▶ sent ──电脑回执 ok──▶ created
 *      │                  │
 *      └──────────────────┴──回执 ok:false / 本地过期──▶ failed
 *
 * - pending：已经存进本机，还没确认写到中继（离线、网络失败都停在这里，恢复后自动重发）。
 * - sent：中继上已有这条命令，等电脑接收（界面上的「等待电脑接收」）。
 * - created / failed：收到回执。回执随后从中继删除（ackCleared），本地记录保留几天供查看。
 *
 * 命令 ID 在入队时就生成并落盘：重启后重发用的是同一个 ID，电脑端以它为幂等键，
 * 所以「发出去了但没来得及记下」的那一条被重发也不会建出第二个任务。
 */
export type LocalCommandState = "pending" | "sent" | "created" | "failed";

export type AckResult = Extract<AckDoc, { ok: true }>["result"];
export type CommandError = { code: string; message: string };

export type LocalCommand = {
  doc: CommandDoc;
  state: LocalCommandState;
  attempts: number;
  lastError?: string;
  sentAt?: string;
  ackAt?: string;
  result?: AckResult;
  error?: CommandError;
  ackCleared?: boolean;
  dismissed?: boolean;
};

export type CommandEvent =
  | { type: "enqueue"; doc: CommandDoc }
  | { type: "send-ok"; id: string; at: string }
  | { type: "send-error"; id: string; message: string }
  | { type: "ack"; ack: AckDoc }
  | { type: "ack-cleared"; id: string }
  | { type: "expire"; now: number }
  | { type: "dismiss"; id: string }
  | { type: "prune"; now: number };

/** 已结束的命令在本地留多久。 */
export const FINISHED_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export const MAX_LOCAL_COMMANDS = 50;

const EXPIRED: CommandError = {
  code: "COMMAND_EXPIRED",
  message: "7 天内电脑都没有接收这条命令，已作废。需要的话请重新发送",
};

function update(
  list: LocalCommand[],
  id: string,
  change: (command: LocalCommand) => LocalCommand,
): LocalCommand[] {
  let changed = false;
  const next = list.map((command) => {
    if (command.doc.id !== id) return command;
    const updated = change(command);
    if (updated !== command) changed = true;
    return updated;
  });
  return changed ? next : list;
}

function isOpen(command: LocalCommand): boolean {
  return command.state === "pending" || command.state === "sent";
}

function finishedAt(command: LocalCommand): number {
  return Date.parse(command.ackAt ?? command.sentAt ?? command.doc.at);
}

/** 发送成功或拿到回执后，上一次的发送错误就不再有意义。 */
function withoutError(command: LocalCommand): LocalCommand {
  const copy = { ...command };
  delete copy.lastError;
  return copy;
}

export function reduceCommands(list: LocalCommand[], event: CommandEvent): LocalCommand[] {
  switch (event.type) {
    case "enqueue":
      if (list.some((command) => command.doc.id === event.doc.id)) return list;
      return [...list, { doc: event.doc, state: "pending", attempts: 0 }];
    case "send-ok":
      return update(list, event.id, (command) => {
        if (command.state !== "pending") return command;
        return {
          ...withoutError(command),
          state: "sent",
          attempts: command.attempts + 1,
          sentAt: event.at,
        };
      });
    case "send-error":
      return update(list, event.id, (command) =>
        command.state === "pending"
          ? { ...command, attempts: command.attempts + 1, lastError: event.message }
          : command,
      );
    case "ack":
      return update(list, event.ack.id, (command) => {
        // 回执只接受一次；已经结束的命令再看到同一条回执（例如删除失败后重读）不改结果。
        if (!isOpen(command)) return command;
        const base = {
          ...withoutError(command),
          ackAt: event.ack.at,
          sentAt: command.sentAt ?? event.ack.at,
        };
        return event.ack.ok
          ? { ...base, state: "created", result: event.ack.result }
          : { ...base, state: "failed", error: event.ack.error };
      });
    case "ack-cleared":
      return update(list, event.id, (command) =>
        command.ackCleared ? command : { ...command, ackCleared: true },
      );
    case "expire": {
      let changed = false;
      const next = list.map((command) => {
        if (!isOpen(command)) return command;
        if (event.now - Date.parse(command.doc.at) <= COMMAND_MAX_AGE_MS) return command;
        changed = true;
        return { ...command, state: "failed" as const, error: EXPIRED, ackCleared: true };
      });
      return changed ? next : list;
    }
    case "dismiss":
      return update(list, event.id, (command) =>
        isOpen(command) || command.dismissed ? command : { ...command, dismissed: true },
      );
    case "prune": {
      const kept = list.filter((command) => {
        if (isOpen(command)) return true;
        // 回执还没从中继删掉的先留着，删完再按时间清。
        if (!command.ackCleared) return true;
        if (command.dismissed) return false;
        return event.now - finishedAt(command) <= FINISHED_RETENTION_MS;
      });
      const trimmed =
        kept.length > MAX_LOCAL_COMMANDS
          ? kept.filter(
              (command, index) => isOpen(command) || index >= kept.length - MAX_LOCAL_COMMANDS,
            )
          : kept;
      return trimmed.length === list.length ? list : trimmed;
    }
  }
}

/** 需要（重新）写到中继的命令。 */
export function commandsToSend(list: LocalCommand[]): LocalCommand[] {
  return list.filter((command) => command.state === "pending");
}

/**
 * 需要查回执的命令。pending 也要查：上次可能已经写到中继、电脑也处理了，
 * 只是手机没来得及记下 send-ok 就被杀掉了。
 */
export function commandsAwaitingAck(list: LocalCommand[]): LocalCommand[] {
  return list.filter(isOpen);
}

/** 回执已处理但还没从中继删掉的命令。 */
export function acksToClear(list: LocalCommand[]): LocalCommand[] {
  return list.filter((command) => !isOpen(command) && !command.ackCleared);
}

const STATES: readonly LocalCommandState[] = ["pending", "sent", "created", "failed"];

/**
 * 从 IndexedDB 读回的队列：逐条校验，坏掉的丢弃，不让一条脏数据卡住整个队列。
 */
export function restoreCommands(raw: unknown): LocalCommand[] {
  if (!Array.isArray(raw)) return [];
  const restored: LocalCommand[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const doc = CommandDocSchema.safeParse(record.doc);
    if (!doc.success || seen.has(doc.data.id)) continue;
    const state = STATES.includes(record.state as LocalCommandState)
      ? (record.state as LocalCommandState)
      : "pending";
    const command: LocalCommand = {
      doc: doc.data,
      state,
      attempts: typeof record.attempts === "number" && record.attempts >= 0 ? record.attempts : 0,
    };
    copyString(record, command, "lastError");
    copyString(record, command, "sentAt");
    copyString(record, command, "ackAt");
    if (record.result && typeof record.result === "object") {
      command.result = record.result as AckResult;
    }
    if (record.error && typeof record.error === "object") {
      command.error = record.error as CommandError;
    }
    if (record.ackCleared === true) command.ackCleared = true;
    if (record.dismissed === true) command.dismissed = true;
    // 结束态缺结果的记录无法展示，退回 sent 重新等回执。
    if (state === "created" && !command.result) command.state = "sent";
    if (state === "failed" && !command.error) command.state = "sent";
    seen.add(doc.data.id);
    restored.push(command);
  }
  return restored;
}

function copyString(
  from: Record<string, unknown>,
  to: LocalCommand,
  key: "lastError" | "sentAt" | "ackAt",
): void {
  const value = from[key];
  if (typeof value === "string") to[key] = value;
}
