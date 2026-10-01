import { EventEmitter } from "node:events";
import { AtmError } from "@ayanami-task/errors";
import {
  AyanamiDatabaseManager,
  ProjectRepository,
  type ProjectActor,
} from "@ayanami-task/storage-sqlite";

/**
 * Stateful seams shared by the public facade's query and command forwarders.
 * This module never imports the public barrel so the dependency remains one-way.
 */
export class ApplicationServiceRuntime {
  readonly databases: AyanamiDatabaseManager;
  readonly #repositories = new Map<string, ProjectRepository>();
  readonly #events = new EventEmitter();

  constructor(databases: AyanamiDatabaseManager) {
    this.databases = databases;
  }

  async repository(projectCode: string): Promise<ProjectRepository> {
    const project = this.databases.getProject(projectCode);
    // 命中缓存也经过连接池：池按取用记录判断连接是否在用（空闲回收、容量淘汰都看它）。
    const database = await this.databases.openProject(project.id);
    const existing = this.#repositories.get(project.id);
    if (existing?.database === database) return existing;
    const repository = new ProjectRepository(database);
    this.#repositories.set(project.id, repository);
    return repository;
  }

  dropRepository(projectId: string): void {
    this.#repositories.delete(projectId);
  }

  async actor(projectCode: string, sessionId: string): Promise<ProjectActor> {
    const repository = await this.repository(projectCode);
    const session = repository.getSession(sessionId);
    if (session.connection_state === "CLOSED") {
      throw new AtmError("SESSION_CLOSED", {
        message: sessionId,
        details: { entity: "SESSION", session_id: sessionId, reference: sessionId },
      });
    }
    return { type: "AGENT", id: session.agent_id, sessionId };
  }

  userActor(): ProjectActor {
    return { type: "USER", id: "USER", sessionId: null };
  }

  emitProject(projectCode: string): void {
    this.#events.emit(`project:${projectCode.toUpperCase()}`);
  }

  emitGlobal(): void {
    this.#events.emit("global");
  }

  subscribeProject(projectCode: string, listener: () => void): () => void {
    const channel = `project:${projectCode.toUpperCase()}`;
    this.#events.on(channel, listener);
    return () => this.#events.off(channel, listener);
  }

  subscribeGlobal(listener: () => void): () => void {
    this.#events.on("global", listener);
    return () => this.#events.off("global", listener);
  }

  close(): void {
    this.#repositories.clear();
    this.databases.close();
  }
}
