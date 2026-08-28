import type { FastifyInstance } from "fastify";
import { createHttpServer, installNotFoundHandler } from "./http-boundary.js";
import { registerProjectRoutes } from "./project-routes.js";
import type { AyanamiServerOptions } from "./server-options.js";
import { registerSessionRoutes } from "./session-routes.js";
import { registerTransportRoutes } from "./transport-routes.js";
import { registerWorkRoutes } from "./work-routes.js";

export type { AyanamiServerOptions } from "./server-options.js";
export {
  acquireDaemonRuntime,
  createDaemonToken,
  DAEMON_LOCK_FILENAME,
  DAEMON_RUNTIME_FILENAME,
  DAEMON_VERSION,
  LEGACY_TOKEN_FILENAME,
  readDaemonRuntime,
  resolveDaemonDataDirectory,
  type DaemonRuntimeDescriptor,
  type DaemonRuntimeLease,
} from "./runtime-discovery.js";
import { DAEMON_VERSION } from "./runtime-discovery.js";

export async function buildAyanamiServer(options: AyanamiServerOptions): Promise<FastifyInstance> {
  const app = await createHttpServer(options);
  registerProjectRoutes(app, options, DAEMON_VERSION);
  registerWorkRoutes(app, options);
  registerSessionRoutes(app, options);
  await registerTransportRoutes(app, options);
  installNotFoundHandler(app);
  await app.ready();
  return app;
}
