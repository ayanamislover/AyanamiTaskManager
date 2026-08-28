import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const markdownLink = /\[[^\]]*\]\(([^)]+)\)/gu;
const installedDocsReference =
  /%LOCALAPPDATA%\\AyanamiTaskManager\\docs\\([A-Za-z0-9_./\\-]+\.md)/gu;

function markdownFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (extname(entry.name).toLowerCase() === ".md") files.push(path);
  }
  return files;
}

function missingRelativeLinks(files: Array<{ path: string; source: string }>): string[] {
  const missing: string[] = [];
  for (const file of files) {
    for (const match of file.source.matchAll(markdownLink)) {
      const rawTarget = match[1]!.trim().replace(/^<|>$/gu, "");
      if (!rawTarget || rawTarget.startsWith("#") || /^[a-z]+:/iu.test(rawTarget)) continue;
      const target = decodeURIComponent(rawTarget.split("#", 1)[0]!.split("?", 1)[0]!);
      if (!existsSync(resolve(dirname(file.path), target)))
        missing.push(`${relative(process.cwd(), file.path)} -> ${target}`);
    }
  }
  return missing;
}

describe("本地安全文档契约", () => {
  it("威胁模型与 Guide/Agent 接入描述当前实现，而不是旧 token 或伪签名语义", () => {
    const guide = readFileSync(resolve(process.cwd(), "ATM_AGENT_GUIDE.md"), "utf8");
    const integration = readFileSync(resolve(process.cwd(), "docs/agent-integration.md"), "utf8");
    const security = readFileSync(resolve(process.cwd(), "docs/security-model.md"), "utf8");

    for (const source of [guide, integration, security]) {
      expect(source).toContain("正式桌面 daemon 每次启动都会生成新的");
      expect(source).not.toContain("生成或加载本地 token");
    }
    expect(integration).not.toContain("cursor 经过签名");
    expect(integration).toContain("不是认证签名或授权凭据");
    for (const marker of [
      "只监听 `127.0.0.1`",
      "WebSocket 必须在 3 秒内完成认证",
      "不是带秘密密钥的签名、MAC、认证或授权",
      "DATA_ROOT_LINK_NOT_ALLOWED",
      "禁止 `ATTACH DATABASE`",
      "跨数据库不承诺原子可见",
      "同一 Windows 用户",
      "读取或修改 `%LOCALAPPDATA%`",
    ])
      expect(security).toContain(marker);
  });

  it("Guide 的安装态 docs 引用与 docs 内相对链接全部可解析，并有缺失链接阳性对照", () => {
    const docsRoot = resolve(process.cwd(), "docs");
    const guidePath = resolve(process.cwd(), "ATM_AGENT_GUIDE.md");
    const guide = readFileSync(guidePath, "utf8");
    const installedReferences = [...guide.matchAll(installedDocsReference)].map((match) =>
      match[1]!.replaceAll("\\", "/"),
    );
    expect(installedReferences.length).toBeGreaterThan(5);
    expect(installedReferences).toContain("security-model.md");
    expect(installedReferences.filter((target) => !existsSync(resolve(docsRoot, target)))).toEqual(
      [],
    );

    const paths = markdownFiles(docsRoot);
    expect(paths.length).toBeGreaterThan(10);
    const sources = paths.map((path) => ({ path, source: readFileSync(path, "utf8") }));
    expect(missingRelativeLinks(sources)).toEqual([]);
    const positivePath = join(docsRoot, "positive-fixture.md");
    expect(
      missingRelativeLinks([{ path: positivePath, source: "[missing](./not-packaged.md)" }]),
    ).toEqual([`${relative(process.cwd(), positivePath)} -> ./not-packaged.md`]);
  });
});
