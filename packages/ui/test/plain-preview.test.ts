import { describe, expect, it } from "vitest";
import { plainPreview, PREVIEW_INPUT_LIMIT } from "../src/features/plain-preview.js";

const FENCE = "```";

describe("派单结果的纯文本预览", () => {
  it("去掉正文里的 Markdown 记号：标题、粗体、列表、引用、链接、代码分隔符", () => {
    // 真机派单的结果原文（节选）：面板曾原样显示 ** 和反引号。
    const result = [
      "## 结果",
      "**测试内容：** 用 `node:test` 检查 `greet('Ayanami')`。",
      "- 新增 [greet.test.js](greet.test.js)",
      "1. 调用 atm_task_patch 的 verify_and_complete",
      "> 没有提交",
      `${FENCE}js`,
      "const a = 1;",
      FENCE,
    ].join("\n");
    expect(plainPreview(result)).toBe(
      "结果 测试内容： 用 node:test 检查 greet('Ayanami')。 新增 greet.test.js " +
        "调用 atm_task_patch 的 verify_and_complete 没有提交 const a = 1;",
    );
    expect(plainPreview("粗体包着代码：**`greet.test.js`** 已提交")).toBe(
      "粗体包着代码：greet.test.js 已提交",
    );
  });

  it("同一行首尾各三个反引号是行内代码，不是围栏：失败原因不能被整行吞掉（peer R7-01）", () => {
    expect(plainPreview(`${FENCE}ENOENT: missing a_b.ts${FENCE}`)).toBe("ENOENT: missing a_b.ts");
    expect(plainPreview(`先看 ${FENCE}npm test${FENCE} 的输出`)).toBe("先看 npm test 的输出");
  });

  it("代码里的内容原样保留：glob 双星号、链接写法、比较符、列表记号都不清理（peer R7-02）", () => {
    expect(plainPreview("找不到 `src/**/test/**` 匹配的文件")).toBe(
      "找不到 src/**/test/** 匹配的文件",
    );
    expect(plainPreview("照抄 `[a](b)` 与 `x >= 2`，以及 ``a`b``")).toBe(
      "照抄 [a](b) 与 x >= 2，以及 a`b",
    );
    const block = [`${FENCE}md`, "**不是粗体**", "- 不是列表", "# 不是标题", FENCE, "之后"].join(
      "\n",
    );
    expect(plainPreview(block)).toBe("**不是粗体** - 不是列表 # 不是标题 之后");
    // 没闭合的围栏一直到结尾都算代码。
    expect(plainPreview(`说明\n~~~\n**保留**`)).toBe("说明 **保留**");
  });

  it("行首记号后面要有空白才算：>=22、#123 是普通文本（peer R7-03）", () => {
    expect(plainPreview(">=22.13.0 才能运行")).toBe(">=22.13.0 才能运行");
    expect(plainPreview("#123 已修复")).toBe("#123 已修复");
    expect(plainPreview("> 引用一句\n>\n## 标题")).toBe("引用一句 标题");
    expect(plainPreview("*斜体* 和 * 列表\n* 列表项")).toBe("*斜体* 和 * 列表 列表项");
  });

  it("普通文本原样：单个星号与下划线、版本号、小数、路径、不成对的双星号和反引号", () => {
    for (const text of [
      "Failed to authenticate: OAuth session expired",
      "耗时 3.5 秒，a * b 不变，2.1.286 已登录",
      "C:\\Users\\a_b\\x.ts 和 /tmp/a_b 都在",
      "2**10 等于 1024，a ** b 不是粗体",
      "反引号 ` 没配上",
    ])
      expect(plainPreview(text)).toBe(text);
  });

  it("缩进按列算（Tab 到 4 列）：4 列及以上不开闭围栏，缩进代码按原文（peer R8-01）", () => {
    expect(plainPreview(`${FENCE}text\n\t${FENCE}\n**literal**\n${FENCE}`)).toBe(
      `${FENCE} **literal**`,
    );
    expect(plainPreview(`说明：\n\n\t${FENCE}ENOENT: missing a_b.ts\n\t**literal**`)).toBe(
      `说明： ${FENCE}ENOENT: missing a_b.ts **literal**`,
    );
    expect(plainPreview("失败：\n\n    src/**/test/**")).toBe("失败： src/**/test/**");
    expect(plainPreview("失败：\n\n    # literal\n    [a](b)\n    **literal**")).toBe(
      "失败： # literal [a](b) **literal**",
    );
    // 3 列以内仍是围栏；两个空格加一个 Tab 正好 4 列，那一行按原文、也不开围栏，下一行仍是正文。
    expect(plainPreview(`   ${FENCE}\n**保留**\n   ${FENCE}\n**去掉**`)).toBe("**保留** 去掉");
    expect(plainPreview(`  \t${FENCE}\n**去掉**`)).toBe(`${FENCE} 去掉`);
  });

  it("链接文字里夹着行内代码也只留文字；代码里的链接写法不动（peer R8-02）", () => {
    expect(plainPreview("查看 [日志 `a_b.ts`](./a_b.ts)")).toBe("查看 日志 a_b.ts");
    expect(plainPreview("照抄 `[日志](./a_b.ts)` 原样")).toBe("照抄 [日志](./a_b.ts) 原样");
  });

  it("原文自带私用区字符时：有行内代码的那行按原文，没有代码的行照常清理且字符不丢", () => {
    const privateUse = String.fromCharCode(0xe001);
    expect(plainPreview(`**a** ${privateUse} \`x\``)).toBe(`**a** ${privateUse} \`x\``);
    expect(plainPreview(`**a** ${privateUse}`)).toBe(`a ${privateUse}`);
  });

  it("只看前 2000 个字符，截断不劈开代理对；异常长输入也很快", () => {
    expect(plainPreview("a".repeat(5000))).toBe("a".repeat(PREVIEW_INPUT_LIMIT));
    expect(plainPreview(`${"a".repeat(1999)}😀bb`)).toBe("a".repeat(1999));
    expect(plainPreview(`${"a".repeat(1998)}😀bb`)).toBe(`${"a".repeat(1998)}😀`);
    // 连续左方括号、各种长度的反引号：派单历史读回时不限长度，开销靠上限兜住。
    const started = performance.now();
    plainPreview("[".repeat(100_000));
    plainPreview(Array.from({ length: 2000 }, (_, index) => "`".repeat(index + 1)).join(" "));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("清理完什么都不剩时退回原文（空白合并），空文本仍是空", () => {
    expect(plainPreview(`  \n${FENCE}\n${FENCE}\n `)).toBe(`${FENCE} ${FENCE}`);
    expect(plainPreview("****")).toBe("****");
    expect(plainPreview("   ")).toBe("");
  });
});
