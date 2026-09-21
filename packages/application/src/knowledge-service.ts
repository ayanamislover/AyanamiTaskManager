import type {
  KnowledgeSaveInput,
  KnowledgeArchiveInput,
  KnowledgeGetInput,
  KnowledgeAgentGetInput,
  KnowledgeSearchInput,
} from "@ayanami-task/protocol";
import {
  KnowledgeAgentSaveInputSchema,
  type KnowledgeAgentSaveInput,
} from "@ayanami-task/protocol";
import { AtmError } from "@ayanami-task/errors";
import {
  getKnowledge,
  searchKnowledge,
  searchKnowledgeForAgent,
  getKnowledgeForAgent,
  ProjectRepository,
  type AyanamiDatabaseManager,
} from "@ayanami-task/storage-sqlite";

/** Shared application boundary; adapters never open SQLite or access project databases. */
export class KnowledgeService {
  constructor(private readonly databases: AyanamiDatabaseManager) {}
  private get database() {
    return this.databases.knowledge;
  }
  async save(input: KnowledgeSaveInput) {
    return (await this.database.open()).save(input);
  }
  async saveForAgent(input: KnowledgeAgentSaveInput) {
    const parsed = KnowledgeAgentSaveInputSchema.parse(input);
    const project = this.databases.getProject(parsed.project);
    const repository = new ProjectRepository(await this.databases.openProject(project.id));
    // Open the knowledge store before the final identity check so no await can
    // interleave session closure between validation and the publication transaction.
    const knowledge = await this.database.open();
    const session = repository.getSession(parsed.session);
    const canonical = { ...parsed, project: project.id };
    const author = {
      type: "AGENT" as const,
      agentId: String(session.agent_id),
      sessionId: String(session.id),
      projectId: project.id,
    };
    // Exact durable replay is a read. It neither revives the old Session nor
    // authorizes a new mutation, and still checks the original payload/author.
    const replay = knowledge.replayForAgent(canonical, author);
    if (!replay && session.connection_state !== "ONLINE")
      throw new AtmError("SESSION_CLOSED", {
        message: "知识写入需要活动 Session；请先 atm_begin 恢复会话",
      });
    const entry = replay ?? knowledge.saveForAgent(canonical, author);
    // Knowledge is global: no project projection or cross-database operation receipt.
    return {
      ok: true,
      op_id: parsed.opId,
      id: entry.id,
      revisionId: entry.revisionId,
      version: entry.version,
      reference: `${entry.id}@${entry.revisionId}`,
      publishedBy: entry.publishedBy,
    };
  }
  async archive(input: KnowledgeArchiveInput) {
    return (await this.database.open()).archive(input);
  }
  async search(input: KnowledgeSearchInput = {}) {
    return searchKnowledge(await this.database.open(), input);
  }
  async get(input: KnowledgeGetInput) {
    return getKnowledge(await this.database.open(), input);
  }
  async searchForAgent(input: KnowledgeSearchInput = {}) {
    return searchKnowledgeForAgent(await this.database.open(), input);
  }
  async getForAgent(input: KnowledgeAgentGetInput) {
    return getKnowledgeForAgent(await this.database.open(), input);
  }
  async history(id: string, beforeRevision?: number, limit?: number) {
    return (await this.database.open()).history(id, beforeRevision, limit);
  }
  async previewRecord(projectReference: string, recordReference: string) {
    const project = this.databases.getProject(projectReference);
    const repository = new ProjectRepository(await this.databases.openProject(project.id));
    const { record, version } = repository.getRecordSnapshot(recordReference);
    return {
      title: record.title,
      summary: record.summary,
      bodyMarkdown: record.detail,
      sourceRef: {
        type: "project_record" as const,
        reference: record.key,
        projectId: project.id,
        recordId: record.id,
        sourceVersion: version,
      },
    };
  }
}
