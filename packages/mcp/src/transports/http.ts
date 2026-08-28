import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { createAyanamiMcpServer } from "../server.js";
import type { AyanamiMcpProfile } from "../surface.js";

export async function handleAyanamiMcpHttp(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  service: AyanamiTaskService,
  options: { profile?: AyanamiMcpProfile } = {},
): Promise<void> {
  const server = createAyanamiMcpServer(service, options);
  const transport = new StreamableHTTPServerTransport();
  // SDK 1.30's accessor declaration is not assignable under exactOptionalPropertyTypes,
  // although this concrete class implements the same Transport contract at runtime.
  await server.connect(transport as unknown as Transport);
  const cleanup = () => {
    void transport.close();
    void server.close();
  };
  response.once("close", cleanup);
  await transport.handleRequest(request, response, body);
}
