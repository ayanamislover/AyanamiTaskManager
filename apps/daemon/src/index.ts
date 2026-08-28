import type { FastifyInstance } from "fastify";
import { createHttpServer, installNotFoundHandler } from "./http-boundary.js";
import { registerProjectRoutes } from "./project-routes.js";
import type { AyanamiServerOptions } from "./server-options.js";
import { registerSessionRoutes } from "./session-routes.js";
import { registerTransportRoutes } from "./transport-routes.js";
import { registerWorkRoutes } from "./work-routes.js";

export type { AyanamiServerOptions } from "./server-options.js";

const DAEMON_VERSION = "1.0.18";

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
