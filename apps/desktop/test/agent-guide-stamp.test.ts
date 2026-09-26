import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentGuideBuild, stampPackagedAgentGuides } from "../../../scripts/forge-api.js";
import {
  buildAgentDocumentationManifest,
  buildStampedSourceManifest,
  compareAgentDocumentationManifests,
} from "../src/agent-documentation-manifest.js";
import {
  agentGuideStampLine,
  readAgentGuideBuild,
  stampAgentGuide,
} from "../src/agent-guide-stamp.js";

const root = resolve(__dirname, "../../..");
const sourceGuide = readFileSync(join(root, "ATM_AGENT_GUIDE.md"), "utf8");
const build = { version: "1.2.3", commit: "0123456789ab" };
const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "atm-guide-stamp-"));
  temporary.push(directory);
  return directory;
}

// ATM-T-0412：两个 Agent 会话各自比对 guide 副本的字节数和 mtime，才确认本机那份是旧构建。
describe("Agent Guide 构建戳", () => {
  it("源仓那份不带戳：戳只存在于打包产物，源文件不会每次构建都变", () => {
    expect(readAgentGuideBuild(sourceGuide)).toBeNull();
  });

  it("在一级标题下插入一行戳，其余逐字不变，并能读回版本与 commit", () => {
    const stamped = stampAgentGuide(sourceGuide, build);
    expect(readAgentGuideBuild(stamped)).toEqual(build);
    const lines = stamped.split("\n");
    expect(lines[0]).toBe(sourceGuide.split("\n")[0]);
    expect(lines[2]).toBe(agentGuideStampLine(build));
    expect(stamped.replace(`${agentGuideStampLine(build)}\n\n`, "")).toBe(sourceGuide);
    expect(() => stampAgentGuide(stamped, build)).toThrow("AGENT_GUIDE_ALREADY_STAMPED");
  });

  it("CRLF 的工作区文件盖戳后不混入裸 LF", () => {
    const crlf = sourceGuide.replaceAll("\n", "\r\n");
    const stamped = stampAgentGuide(crlf, build);
    expect(stamped.replaceAll("\r\n", "")).not.toContain("\n");
    expect(readAgentGuideBuild(stamped)).toEqual(build);
  });

  it("拒绝说不清来历的版本或 commit，以及缺标题的 guide", () => {
    expect(() => stampAgentGuide(sourceGuide, { version: "dev", commit: build.commit })).toThrow(
      "VERSION_INVALID",
    );
    expect(() => stampAgentGuide(sourceGuide, { version: "1.2.3", commit: "HEAD" })).toThrow(
      "COMMIT_INVALID",
    );
    expect(() => stampAgentGuide("no title\n", build)).toThrow("AGENT_GUIDE_TITLE_MISSING");
    const dirty = stampAgentGuide(sourceGuide, { ...build, commit: "0123456789ab-dirty" });
    expect(readAgentGuideBuild(dirty)?.commit).toBe("0123456789ab-dirty");
  });

  it("构建身份取自 package.json 与 HEAD，工作区有已跟踪改动时带 -dirty", () => {
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    const answers = (status: string) => (args: string[]) =>
      args[0] === "rev-parse" ? "0123456789ab\n" : status;
    expect(resolveAgentGuideBuild(root, answers(""))).toEqual({
      version,
      commit: "0123456789ab",
    });
    expect(resolveAgentGuideBuild(root, answers(" M README.md\n")).commit).toBe(
      "0123456789ab-dirty",
    );
  });

  it("打包产物盖戳后与「源仓盖戳」的期望 manifest 完全一致；漏盖则只有 guide 一项不符", async () => {
    const dir = scratch();
    const resources = join(dir, "out", "AyanamiTaskManager-win32-x64", "resources");
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(resources, "ATM_AGENT_GUIDE.md"), sourceGuide, "utf8");
    cpSync(join(root, "docs"), join(resources, "docs"), { recursive: true });
    cpSync(join(root, "integrations"), join(resources, "integrations"), { recursive: true });

    const unstamped = compareAgentDocumentationManifests(
      buildStampedSourceManifest(root, build),
      buildAgentDocumentationManifest(resources, "bundled"),
    );
    expect(unstamped.map((mismatch) => mismatch.path)).toEqual(["ATM_AGENT_GUIDE.md"]);

    await stampPackagedAgentGuides(dir, build);
    expect(
      compareAgentDocumentationManifests(
        buildStampedSourceManifest(root, build),
        buildAgentDocumentationManifest(resources, "bundled"),
      ),
    ).toEqual([]);
    expect(
      readAgentGuideBuild(readFileSync(join(resources, "ATM_AGENT_GUIDE.md"), "utf8")),
    ).toEqual(build);
  });
});
