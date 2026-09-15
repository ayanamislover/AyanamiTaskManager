import { createHash } from "node:crypto";
import { AtmError } from "@ayanami-task/errors";
import {
  KnowledgeGetInputSchema,
  KnowledgeSearchInputSchema,
  KnowledgeHitSchema,
  KnowledgeAgentSearchPageSchema,
  KnowledgeAgentFirstPageSchema,
  KnowledgeAgentContinuationSchema,
  type KnowledgeAgentSearchPage,
  type KnowledgeAgentGetPage,
  type KnowledgeGetInput,
  type KnowledgeGetPage,
  type KnowledgeSearchInput,
  type KnowledgeSearchPage,
} from "@ayanami-task/protocol";
import type { KnowledgeRepository } from "./knowledge-repository.js";

type Cursor = {
  kind: "search" | "get";
  database: string;
  generation: string;
  scope: string;
  position: number;
  revision: number;
  editVersion: number;
  snapshotId: string;
};
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
function encode(cursor: Cursor): string {
  const body = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `k1.${body}.${hash(`atm-knowledge-v1:${body}`)}`;
}
function invalid(message = "知识游标无效；请重新搜索或指定知识 ID 与 revision 读取"): never {
  throw new AtmError("INVALID_CURSOR", { message });
}
function decode(token: string): Cursor {
  const [version, body, signature, extra] = token.split(".");
  if (
    version !== "k1" ||
    !body ||
    signature !== hash(`atm-knowledge-v1:${body}`) ||
    extra !== undefined
  )
    invalid();
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString()) as Cursor;
    if (
      !value ||
      !["search", "get"].includes(value.kind) ||
      typeof value.database !== "string" ||
      typeof value.generation !== "string" ||
      typeof value.scope !== "string" ||
      !Number.isSafeInteger(value.position) ||
      value.position < 0 ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Number.isSafeInteger(value.editVersion) ||
      value.editVersion < 0 ||
      (value.kind === "get" && value.editVersion === 0) ||
      typeof value.snapshotId !== "string" ||
      (value.kind === "get" && !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.snapshotId))
    )
      invalid();
    return value;
  } catch {
    return invalid();
  }
}
function readCursor(
  repository: KnowledgeRepository,
  token: string | undefined,
  kind: Cursor["kind"],
  scope: string,
): Cursor | null {
  if (!token) return null;
  const cursor = decode(token);
  const identity = repository.identity();
  if (
    cursor.kind !== kind ||
    cursor.scope !== scope ||
    cursor.database !== identity.database_id ||
    cursor.generation !== identity.generation
  )
    invalid();
  return cursor;
}
function makeCursor(
  repository: KnowledgeRepository,
  kind: Cursor["kind"],
  scope: string,
  position: number,
  revision: number,
  editVersion = 0,
  snapshotId = "",
): string {
  const identity = repository.identity();
  return encode({
    kind,
    scope,
    position,
    revision,
    editVersion,
    snapshotId,
    database: identity.database_id,
    generation: identity.generation,
  });
}
function tooSmall(): never {
  throw new AtmError("RESULT_TOO_LARGE", {
    message: "max_chars 不足以容纳知识元数据与至少一项内容，请提高预算",
  });
}

export function searchKnowledge(
  repository: KnowledgeRepository,
  input: KnowledgeSearchInput,
): KnowledgeSearchPage {
  return searchKnowledgePage(repository, input, (page) => page);
}

export function searchKnowledgeForAgent(
  repository: KnowledgeRepository,
  input: KnowledgeSearchInput,
): KnowledgeAgentSearchPage {
  return searchKnowledgePage(repository, input, (page) =>
    KnowledgeAgentSearchPageSchema.parse(page),
  );
}

function searchKnowledgePage<T>(
  repository: KnowledgeRepository,
  input: KnowledgeSearchInput,
  project: (page: KnowledgeSearchPage) => T,
): T {
  const parsed = KnowledgeSearchInputSchema.parse(input);
  return repository.database.sqlite.transaction(() => {
    const { query, tag, includeArchived, limit, maxChars } = parsed;
    const scope = hash(JSON.stringify([query, tag ?? null, includeArchived]));
    const cursor = readCursor(repository, parsed.cursor, "search", scope);
    const sequence = repository.identity().sequence;
    if (cursor && cursor.revision !== sequence)
      invalid("知识目录已更新，请重新搜索；已固定的正文修订仍可继续读取");
    const offset = cursor?.position ?? 0;
    // A quoted phrase makes FTS syntax literal; trigram FTS cannot serve queries
    // shorter than three characters, so those still scan.
    //
    // 正文那一支用 LIKE 而不是 instr(lower(f.body), lower(@q))：后者要为扫到的每一行
    // 再造一份整篇正文的小写副本，条目一多就是成百 MB 的瞬时分配。语义没变——SQLite
    // 的 lower() 和 LIKE 的大小写折叠都只作用于 ASCII，对中文两边都不折叠。
    // 元数据字段留着 instr，它们都很短，换成 LIKE 只是徒增一处转义要维护。
    //
    // @like 里的 %、_ 和反斜杠必须转义：它们在 instr 里是普通字符，在 LIKE 里不是。
    const codePoints = [...query].length;
    const bodyMatch =
      codePoints >= 3
        ? "e.id IN (SELECT entry_id FROM knowledge_fts WHERE knowledge_fts MATCH @match)"
        : "f.body LIKE @like ESCAPE '\\'";
    const metadataMatch = ["title", "summary", "use_when", "aliases", "tags", "applies_to"]
      .map((field) => `instr(lower(f.${field}), lower(@q)) > 0`)
      .join(" OR ");
    const parameters = {
      q: query,
      tag: tag ?? null,
      archived: Number(includeArchived),
      limit: limit + 1,
      offset,
      ...(codePoints >= 3
        ? { match: `"${query.replaceAll('"', '""')}"` }
        : { like: `%${query.replace(/[\\%_]/gu, (character) => `\\${character}`)}%` }),
    };
    const rows = repository.database.sqlite
      .prepare(
        `SELECT e.id, e.version, e.archived, f.metadata,
      CASE WHEN e.id=@q OR lower(e.slug)=lower(@q) OR lower(f.title)=lower(@q) THEN 0
        WHEN instr(lower(f.title),lower(@q))>0 THEN 1
        WHEN instr(lower(f.aliases),lower(@q))>0 OR instr(lower(f.tags),lower(@q))>0 THEN 2
        WHEN ${metadataMatch} THEN 3 ELSE 4 END AS rank
      FROM knowledge_fts f JOIN knowledge_entries e ON e.id=f.entry_id
      WHERE (@archived=1 OR e.archived=0)
        AND (@tag IS NULL OR EXISTS(SELECT 1 FROM json_each(f.metadata, '$.tags') WHERE value=@tag))
        AND (@q='' OR e.id=@q OR instr(lower(e.slug),lower(@q))>0 OR ${metadataMatch} OR ${bodyMatch})
      ORDER BY rank, e.id DESC LIMIT @limit OFFSET @offset`,
      )
      .all(parameters) as { id: string; version: number; archived: number; metadata: string }[];
    const hits = rows.slice(0, limit).map((row) =>
      KnowledgeHitSchema.parse({
        ...JSON.parse(row.metadata),
        version: row.version,
        archived: row.archived === 1,
      }),
    );
    const page = (count: number): T =>
      project({
        hits: hits.slice(0, count),
        hasMore: rows.length > count,
        nextCursor:
          rows.length > count
            ? makeCursor(repository, "search", scope, offset + count, sequence)
            : null,
      });
    for (let count = hits.length; count > 0; count--) {
      const result = page(count);
      if (JSON.stringify(result).length <= maxChars) return result;
    }
    if (hits.length || JSON.stringify(page(0)).length > maxChars) tooSmall();
    return page(0);
  })();
}

type Heading = { id: string; title: string; level: number; start: number };
function headings(markdown: string): Heading[] {
  const result: Heading[] = [];
  let offset = 0;
  let fence: { char: string; size: number } | null = null;
  for (const line of markdown.split(/(?<=\n)/u)) {
    const fenced = /^ {0,3}(`{3,}|~{3,})(.*)/u.exec(line);
    if (fenced) {
      const marker = fenced[1]!;
      if (!fence) fence = { char: marker[0]!, size: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.size && !fenced[2]!.trim())
        fence = null;
    } else if (!fence) {
      const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/u.exec(line.trimEnd());
      if (heading)
        result.push({
          id: `h-${result.length + 1}`,
          title: heading[2]!.replace(/[ \t]+#+[ \t]*$/u, "").trim(),
          level: heading[1]!.length,
          start: offset,
        });
    }
    offset += line.length;
  }
  return result;
}

export function getKnowledge(
  repository: KnowledgeRepository,
  input: KnowledgeGetInput,
): KnowledgeGetPage {
  return readKnowledgePage(repository, input, (page) => page);
}

export function getKnowledgeForAgent(
  repository: KnowledgeRepository,
  input: KnowledgeGetInput,
): KnowledgeAgentGetPage {
  return readKnowledgePage(
    repository,
    input,
    (page, continuation) => {
      if (continuation) return KnowledgeAgentContinuationSchema.parse(page);
      const toc = page.toc.slice(0, 40).map((heading) => {
        const title = Array.from(heading.title);
        return {
          ...heading,
          title: title.length > 120 ? `${title.slice(0, 120).join("")}…` : heading.title,
        };
      });
      const budget = Math.min(1600, Math.floor((input.maxChars ?? 6000) / 3));
      while (toc.length && JSON.stringify(toc).length > budget) toc.pop();
      return KnowledgeAgentFirstPageSchema.parse({
        ...page,
        toc,
        tocTotal: page.toc.length,
        tocTruncated: toc.length < page.toc.length,
      });
    },
    !input.cursor,
  );
}

function readKnowledgePage<T>(
  repository: KnowledgeRepository,
  input: KnowledgeGetInput,
  project: (page: KnowledgeGetPage, continuation: boolean) => T,
  includeDirectory = true,
): T {
  const parsed = KnowledgeGetInputSchema.parse(input);
  return repository.database.sqlite.transaction(() => {
    const scope = hash(JSON.stringify([parsed.id, parsed.section ?? null]));
    const cursor = readCursor(repository, parsed.cursor, "get", scope);
    if (cursor && parsed.revisionId !== undefined && parsed.revisionId !== cursor.snapshotId)
      invalid();
    const entry = repository.get(parsed.id, cursor?.snapshotId ?? parsed.revisionId);
    // Preserve the first page's edit baseline: later pages must not pair an old
    // body with a newer head version and accidentally authorize a stale overwrite.
    const editVersion = cursor?.editVersion ?? entry.version;
    const allHeadings = includeDirectory || parsed.section ? headings(entry.bodyMarkdown) : [];
    const toc = allHeadings.map(({ start: _start, ...heading }) => heading);
    let body = entry.bodyMarkdown;
    if (parsed.section) {
      let index = allHeadings.findIndex((heading) => heading.id === parsed.section);
      if (index < 0) {
        const matches = allHeadings
          .map((heading, position) => ({ heading, position }))
          .filter((item) => item.heading.title === parsed.section);
        if (matches.length > 1)
          throw new AtmError("INVALID_ARGUMENT", {
            message: "章节标题重复，请使用章节 ID",
            details: {
              candidateIds: matches.slice(0, 20).map((item) => item.heading.id),
              candidateCount: matches.length,
            },
          });
        index = matches[0]?.position ?? -1;
      }
      const heading = allHeadings[index];
      if (!heading)
        throw new AtmError("NOT_FOUND", { message: "知识章节不存在，请从 toc 选择 section" });
      const end =
        allHeadings.slice(index + 1).find((item) => item.level <= heading.level)?.start ??
        body.length;
      body = body.slice(heading.start, end);
    }
    // 游标位置按 UTF-16 码元计，直接在字符串上切。早先这里是 Array.from(body)，
    // 500KB 正文会摊成 50 万个单字符串、几十 MB 瞬时堆，而下面的二分还要反复投影，
    // 峰值就压在这上面。ATM 的 RSS 预算只有 150MB，这条读取路径不该按正文长度分配。
    const total = body.length;
    const offset = cursor?.position ?? 0;
    if (offset > total) invalid();
    // 唯一不能落的切点是代理对中间——劈开就成了两个孤立代理。组合记号是独立码点，
    // 本来就允许分到两页，不用管。
    //
    // 这一步目前够不到，变异实测过：下面按 JSON 长度二分，而劈开一对要写成两个
    // 转义序列（+6 字符），整对原样输出只要 +2。所以「多切一个码元」既让 count 更大
    // 又让 JSON 更短，二分永远不会选中切在对中间的那一格。留着是因为那个不等式属于
    // JSON.stringify 的转义规则，不属于这里的分页逻辑：预算口径一旦改成按码元算，
    // 切点立刻就能落进对中间。
    const boundary = (index: number): number =>
      index > offset &&
      index < total &&
      (body.charCodeAt(index) & 0xfc00) === 0xdc00 &&
      (body.charCodeAt(index - 1) & 0xfc00) === 0xd800
        ? index - 1
        : index;
    const endOf = (count: number): number => boundary(Math.min(offset + count, total));
    const page = (count: number): T => {
      const end = endOf(count);
      return project(
        {
          ...entry,
          version: editVersion,
          bodyMarkdown: body.slice(offset, end),
          toc,
          truncated: end < total,
          nextCursor:
            end < total
              ? makeCursor(
                  repository,
                  "get",
                  scope,
                  end,
                  entry.revision,
                  editVersion,
                  entry.revisionId,
                )
              : null,
        },
        Boolean(cursor),
      );
    };
    const complete = page(total - offset);
    if (JSON.stringify(complete).length <= parsed.maxChars) return complete;
    let low = 0,
      high = Math.max(0, total - offset - 1);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (JSON.stringify(page(middle)).length <= parsed.maxChars) low = middle;
      else high = middle - 1;
    }
    const result = page(low);
    // 切点被退回起点时这一页是空的，再发游标就指回原处，续读会死循环。
    // 起点正好是高位代理、预算又只够一个码元时会走到这里，不只是 low 为 0 的情况。
    if (endOf(low) === offset && offset < total) tooSmall();
    if (JSON.stringify(result).length > parsed.maxChars) tooSmall();
    return result;
  })();
}
