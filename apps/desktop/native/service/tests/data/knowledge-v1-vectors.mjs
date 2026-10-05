// 知识库 2.x 回执的端到端期望（W2g3；04 L-106；10 A2）。不经过 atm-service 的任何代码。
//
// 直接用 2.x 打包的 zod schema（packages/protocol/dist）解析输入，照抄 `knowledge-repository.ts` 的
// payload 拼法与 `sha256(JSON.stringify(payload))`，Agent 的旧键照抄 `agentOperation`。
// Rust 侧把这些指纹当成转换来的回执行插进库里，再用同样的业务输入调用服务，必须得到 REPLAY。
//
// 用法（仓库根目录）：node apps/desktop/native/service/tests/data/knowledge-v1-vectors.mjs
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  KnowledgeSaveInputSchema,
  KnowledgeArchiveInputSchema,
  KnowledgeAgentSaveInputSchema,
  KnowledgeAuthorSchema,
} from "../../../../../../packages/protocol/dist/index.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const here = dirname(fileURLToPath(import.meta.url));

// 带首尾空白与默认值缺省的输入：zod 会去空白、补默认值，键序按 shape。
const content = {
  bodyMarkdown: "# 标题\n\n正文 ✓",
  title: "  备份策略  ",
  slug: " backup-policy ",
  summary: "每天两份",
  tags: [" ops ", "备份"],
  sourceRefs: [{ reference: " ATM-D-1 ", type: "manual" }],
};

const userNew = KnowledgeSaveInputSchema.parse({ ...content, opId: " u-new ", expectedVersion: 0 });
const userUpdate = KnowledgeSaveInputSchema.parse({
  ...content,
  useWhen: "改备份时",
  aliases: ["保留策略"],
  appliesTo: ["ATM"],
  opId: "u-upd",
  id: "01KENTRY000000000000000000",
  expectedVersion: 3,
  expectedRevisionId: "01KREV00000000000000000003",
});
const archive = KnowledgeArchiveInputSchema.parse({
  archived: true,
  expectedRevisionId: "01KREV00000000000000000003",
  expectedVersion: 4,
  id: "01KENTRY000000000000000000",
  opId: "u-arc",
});
const agentInput = KnowledgeAgentSaveInputSchema.parse({
  ...content,
  project: "ATM",
  session: "S1",
  opId: "a-new",
});
const projectId = "PA";
const author = KnowledgeAuthorSchema.parse({
  type: "AGENT",
  agentId: "claude",
  sessionId: "S1",
  projectId,
});
const canonical = { ...agentInput, project: projectId };

const out = {
  content,
  user: [
    {
      name: "user new",
      opId: userNew.opId,
      fp: sha(JSON.stringify({ operation: "save", ...userNew })),
      payload: JSON.stringify({ operation: "save", ...userNew }),
    },
    {
      name: "user update",
      opId: userUpdate.opId,
      fp: sha(JSON.stringify({ operation: "save", ...userUpdate })),
      payload: JSON.stringify({ operation: "save", ...userUpdate }),
    },
  ],
  archive: {
    opId: archive.opId,
    fp: sha(JSON.stringify({ operation: "archive", ...archive })),
    payload: JSON.stringify({ operation: "archive", ...archive }),
  },
  agent: {
    opId: agentInput.opId,
    key: "agent:" + sha(JSON.stringify([projectId, author.sessionId, agentInput.opId])),
    fp: sha(JSON.stringify({ operation: "agent.save", ...canonical, author })),
    payload: JSON.stringify({ operation: "agent.save", ...canonical, author }),
  },
};
writeFileSync(join(here, "knowledge-v1-vectors.json"), JSON.stringify(out, null, 2) + "\n");
console.log("knowledge v1 vectors written");
