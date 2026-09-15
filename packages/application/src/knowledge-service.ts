import type {
  KnowledgeSaveInput,
  KnowledgeArchiveInput,
  KnowledgeGetInput,
  KnowledgeSearchInput,
} from "@ayanami-task/protocol";
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
  async getForAgent(input: KnowledgeGetInput) {
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
