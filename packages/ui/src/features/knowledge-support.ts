import type {
  AyanamiClient,
  KnowledgeEntry,
  KnowledgeGetPage,
  KnowledgeSource,
} from "@ayanami-task/client";

export type KnowledgeDraftSeed = {
  title: string;
  summary: string;
  bodyMarkdown: string;
  sourceRefs: KnowledgeSource[];
};

export type KnowledgeForm = {
  id?: string;
  version: number;
  revisionId?: string;
  archived: boolean;
  slug: string;
  title: string;
  summary: string;
  useWhen: string;
  tags: string[];
  aliases: string[];
  appliesTo: string[];
  bodyMarkdown: string;
  sourceRefs: KnowledgeSource[];
};

export type PendingNavigation =
  | { kind: "select"; id: string }
  | { kind: "create" }
  | { kind: "import"; file: File }
  | { kind: "revision"; revisionId: string };

export const emptyForm = (): KnowledgeForm => ({
  version: 0,
  archived: false,
  slug: "",
  title: "",
  summary: "",
  useWhen: "",
  tags: [],
  aliases: [],
  appliesTo: [],
  bodyMarkdown: "",
  sourceRefs: [],
});

export function formFromEntry(entry: KnowledgeEntry): KnowledgeForm {
  return {
    id: entry.id,
    version: entry.version,
    revisionId: entry.revisionId,
    archived: entry.archived,
    slug: entry.slug,
    title: entry.title,
    summary: entry.summary,
    useWhen: entry.useWhen,
    tags: entry.tags,
    aliases: entry.aliases,
    appliesTo: entry.appliesTo,
    bodyMarkdown: entry.bodyMarkdown,
    sourceRefs: entry.sourceRefs,
  };
}

export function listValue(value: string): string[] {
  return value
    .split(/[\n,，]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function displayList(values: string[]): string {
  return values.join("、");
}

export function slugFromName(name: string): string {
  const withoutExtension = name.replace(/\.[^.]+$/u, "").trim();
  return withoutExtension
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\u4e00-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 160);
}

export function exportMarkdown(form: KnowledgeForm): void {
  // JSON front matter keeps newlines, colons, quotes and `---` in user text
  // round-trippable. File references are reduced to their visible basename;
  // the browser cannot expose a local path and exports must not invent one.
  const sourceRefs = form.sourceRefs.map((source) =>
    source.type === "file"
      ? { ...source, reference: source.reference.split(/[\\/]/u).at(-1) ?? source.reference }
      : source,
  );
  const metadata = {
    title: form.title,
    slug: form.slug,
    summary: form.summary,
    useWhen: form.useWhen,
    tags: form.tags,
    aliases: form.aliases,
    appliesTo: form.appliesTo,
    sourceRefs,
  };
  const frontMatter = `---json\n${JSON.stringify(metadata, null, 2)}\n---\n\n`;
  const blob = new Blob([frontMatter, form.bodyMarkdown], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${form.slug || "knowledge"}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function validSourceRefs(value: unknown): KnowledgeSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): KnowledgeSource[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const source = candidate as Record<string, unknown>;
    if (
      !["project_record", "file", "url", "manual"].includes(String(source.type)) ||
      typeof source.reference !== "string" ||
      !source.reference.trim()
    )
      return [];
    const type = source.type as KnowledgeSource["type"];
    const common = { type, reference: source.reference } as KnowledgeSource;
    if (type === "project_record") {
      if (
        typeof source.projectId !== "string" ||
        typeof source.recordId !== "string" ||
        !Number.isInteger(source.sourceVersion) ||
        Number(source.sourceVersion) < 0
      )
        return [];
      return [
        {
          ...common,
          projectId: source.projectId,
          recordId: source.recordId,
          sourceVersion: Number(source.sourceVersion),
        },
      ];
    }
    if (
      source.sourceVersion !== undefined &&
      (!Number.isInteger(source.sourceVersion) || Number(source.sourceVersion) < 0)
    )
      return [];
    return [
      {
        ...common,
        ...(typeof source.sourceVersion === "number"
          ? { sourceVersion: source.sourceVersion }
          : {}),
        ...(typeof source.projectId === "string" ? { projectId: source.projectId } : {}),
        ...(typeof source.recordId === "string" ? { recordId: source.recordId } : {}),
      },
    ];
  });
}

export function importedMarkdown(content: string): {
  metadata: Partial<
    Pick<
      KnowledgeForm,
      "title" | "slug" | "summary" | "useWhen" | "tags" | "aliases" | "appliesTo" | "sourceRefs"
    >
  >;
  bodyMarkdown: string;
} {
  const match = /^---json\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u.exec(content);
  if (!match) return { metadata: {}, bodyMarkdown: content };
  try {
    const raw = JSON.parse(match[1]!) as Record<string, unknown>;
    const list = (value: unknown): string[] | undefined =>
      Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
    const tags = list(raw.tags);
    const aliases = list(raw.aliases);
    const appliesTo = list(raw.appliesTo);
    return {
      metadata: {
        ...(typeof raw.title === "string" ? { title: raw.title } : {}),
        ...(typeof raw.slug === "string" ? { slug: raw.slug } : {}),
        ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
        ...(typeof raw.useWhen === "string" ? { useWhen: raw.useWhen } : {}),
        ...(tags === undefined ? {} : { tags }),
        ...(aliases === undefined ? {} : { aliases }),
        ...(appliesTo === undefined ? {} : { appliesTo }),
        ...(Array.isArray(raw.sourceRefs) ? { sourceRefs: validSourceRefs(raw.sourceRefs) } : {}),
      },
      bodyMarkdown: content.slice(match[0].length),
    };
  } catch {
    // Invalid metadata is just Markdown; never discard user content on import.
    return { metadata: {}, bodyMarkdown: content };
  }
}

export function sourceLabel(source: KnowledgeSource): string {
  if (source.type === "project_record") {
    return `${source.projectId ?? "项目"} · ${source.reference}${source.sourceVersion === undefined ? "" : ` · v${source.sourceVersion}`}`;
  }
  return `${source.type} · ${source.reference}`;
}

export async function readFullEntry(
  entries: AyanamiClient["knowledge"],
  id: string,
  revisionId?: string,
): Promise<KnowledgeGetPage> {
  let page = await entries.get(id, {
    maxChars: 600_000,
    ...(revisionId === undefined ? {} : { revisionId }),
  });
  const firstPage = page;
  const fixedRevision = firstPage.revision;
  const fixedRevisionId = firstPage.revisionId;
  const fixedId = firstPage.id;
  const body = [page.bodyMarkdown];
  const seen = new Set<string>();
  while (page.nextCursor) {
    if (seen.has(page.nextCursor)) throw new Error("知识正文分页游标重复，已停止读取");
    seen.add(page.nextCursor);
    page = await entries.get(id, { cursor: page.nextCursor, maxChars: 600_000 });
    if (
      page.id !== fixedId ||
      page.revision !== fixedRevision ||
      page.revisionId !== fixedRevisionId
    )
      throw new Error("知识正文分页返回了不一致的条目或修订，已停止读取");
    body.push(page.bodyMarkdown);
  }
  return { ...firstPage, bodyMarkdown: body.join(""), truncated: false, nextCursor: null };
}
