import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTemporaryDirectory<T>(
  name: string,
  action: (directory: string) => Promise<T> | T,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), `ayanami-task-${name}-`));
  try {
    return await action(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function eventually(
  assertion: () => Promise<void> | void,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + (options.timeoutMs ?? 3_000);
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError;
}
