import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export async function runStdioMcpProxy(options: {
  endpoint: string;
  token: string;
  input?: Readable;
  output?: Writable;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const fetchImpl = options.fetchImpl ?? fetch;
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(
        `${JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null })}\n`,
      );
      continue;
    }
    try {
      const response = await fetchImpl(options.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify(message),
      });
      if (response.status === 202 || response.status === 204) continue;
      const text = await response.text();
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        for (const data of text
          .split(/\r?\n/u)
          .filter((entry) => entry.startsWith("data:"))
          .map((entry) => entry.slice(5).trim())
          .filter(Boolean)) {
          output.write(`${data}\n`);
        }
      } else if (text.trim()) {
        output.write(`${JSON.stringify(JSON.parse(text))}\n`);
      }
    } catch (error) {
      const id =
        message && typeof message === "object" && "id" in message
          ? ((message as { id?: unknown }).id ?? null)
          : null;
      output.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : "MCP proxy error",
          },
          id,
        })}\n`,
      );
    }
  }
}
