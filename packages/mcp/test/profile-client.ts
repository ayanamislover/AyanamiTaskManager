import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { createAyanamiMcpServer } from "../src/index.js";

const memoryToolNames = new Set([
  "atm_task_patch",
  "atm_progress_add",
  "atm_record",
  "atm_search",
  "atm_delta",
]);

export async function connectProfiledClients(service: AyanamiTaskService, name: string) {
  const coreServer = createAyanamiMcpServer(service, { profile: "core" });
  const memoryServer = createAyanamiMcpServer(service, { profile: "memory" });
  const coreClient = new Client({ name: `${name}-core`, version: "1" });
  const memoryClient = new Client({ name: `${name}-memory`, version: "1" });
  const [coreClientTransport, coreServerTransport] = InMemoryTransport.createLinkedPair();
  const [memoryClientTransport, memoryServerTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    coreServer.connect(coreServerTransport),
    coreClient.connect(coreClientTransport),
    memoryServer.connect(memoryServerTransport),
    memoryClient.connect(memoryClientTransport),
  ]);
  return {
    coreClient,
    memoryClient,
    client: {
      callTool: (request: Parameters<Client["callTool"]>[0]) =>
        (memoryToolNames.has(request.name) ? memoryClient : coreClient).callTool(request),
    },
    close: async () => {
      await Promise.all([
        coreClient.close(),
        memoryClient.close(),
        coreServer.close(),
        memoryServer.close(),
      ]);
    },
  };
}
