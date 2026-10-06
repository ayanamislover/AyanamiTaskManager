// agenttask-md 解析的独立期望（peer W2 r1 P1-05；03 A18 / U13）。直接调用 2.x 的
// `packages/application/src/agenttask-import.ts`（node 24 原生去类型运行 .ts），不经过 atm-service。
//
// 2.x 记录标题的 slice(0, 80) 会切开代理对，留下孤立的高位代理；Rust 按 00 02 C-19 退到它之前，
// 这里把那一处去掉并标成 splitSurrogate。
//
// 用法：node agenttask-vectors.mjs <输出目录>
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const { parseAgentTaskMarkdown } = await import(
  new URL("../../../../../../packages/application/src/agenttask-import.ts", import.meta.url).href
);

const emoji = "\u{1F600}";
const cases = [
  "",
  "   \n\t\n",
  "# 目标一\n## 阶段 A\n- [ ] 任务一\n- [x] 任务二\n* [X]   任务三   \n+ [ ] 任务四\n### 细节\n普通一行\n1. 第一条\n2) 第二条\n- 列表项",
  "- [ ] 标题前的任务\n# 后来的目标\n- [ ] 目标下的任务",
  "## 没有一级标题的阶段\n- [ ] 任务",
  "####### 七级\n#没有空格\n#\t制表符标题\n######  六级  \n#  NBSP 标题",
  "- [ ]  \n- [x] \n-  \n- [ ]\n-[ ] 无空格\n- [y] 非法标记\n  - [ ] 缩进任务\n\t* [x]\t制表",
  "- [ ] 标题含 分隔\n- [ ] 尾部 CR\r\n- [ ] 尾部 FEFF﻿\n- [ ] 尾部 U+0085\u0085",
  "x".repeat(79) + emoji + "尾巴\n" + "y".repeat(80) + "超出\n" + "1. " + "z".repeat(85),
  "# A\r\n## B\r\n- [ ] C\r\n\r\n3. 序号\n12. 两位\n-1. 负号",
  "﻿# 带 BOM 的标题\n  - [ ] NBSP 缩进",
];
const out = cases.map((content, i) => {
  const plan = parseAgentTaskMarkdown(content, i % 2 ? "plan.md" : "agenttask.md");
  for (const r of plan.records) {
    const last = r.title.charCodeAt(r.title.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      r.title = r.title.slice(0, -1);
      r.splitSurrogate = true;
    }
  }
  return { name: `case-${i}`, content, plan };
});
writeFileSync(join(process.argv[2], "agenttask-vectors.json"), JSON.stringify(out, null, 2) + "\n");
console.log(out.length);
