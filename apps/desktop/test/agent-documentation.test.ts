import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAgentDocumentationManifest,
  buildAgentDocumentationManifest,
  compareAgentDocumentationManifests,
  installAgentDocumentation,
  installAgentDocumentationForTests,
} from "../src/agent-documentation.js";

const temporary: string[] = [];
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function createBundledFixture(root: string): string {
  const bundled = join(root, "bundled");
  mkdirSync(bundled, { recursive: true });
  copyFileSync(join(workspaceRoot, "ATM_AGENT_GUIDE.md"), join(bundled, "ATM_AGENT_GUIDE.md"));
  cpSync(join(workspaceRoot, "docs"), join(bundled, "docs"), { recursive: true });
  cpSync(join(workspaceRoot, "integrations", "skills"), join(bundled, "integrations", "skills"), {
    recursive: true,
  });
  return bundled;
}

function fsFailure(message: string, code = "EPERM"): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Agent 文档正式数据根分发", () => {
  it("安装并更新 Guide 与完整 docs 树", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-docs-"));
    temporary.push(root);
    const bundled = join(root, "bundled");
    const dataDir = join(root, "data");
    mkdirSync(join(bundled, "docs", "adr"), { recursive: true });
    for (const name of ["atm-plan", "atm-task"]) {
      const skill = join(bundled, "integrations", "skills", name);
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
    }
    writeFileSync(join(bundled, "ATM_AGENT_GUIDE.md"), "guide-v1\n", "utf8");
    writeFileSync(join(bundled, "docs", "agent-integration.md"), "integration-v1\n", "utf8");
    writeFileSync(join(bundled, "docs", "adr", "ADR-001.md"), "adr-v1\n", "utf8");
    writeFileSync(join(bundled, "docs", "retired.md"), "retired-v1\n", "utf8");
    mkdirSync(join(bundled, "integrations", "skills", "retired"), { recursive: true });
    writeFileSync(
      join(bundled, "integrations", "skills", "retired", "SKILL.md"),
      "retired-skill-v1\n",
      "utf8",
    );

    const first = installAgentDocumentation(bundled, dataDir);
    expect(first.guidePath).toBe(join(dataDir, "ATM_AGENT_GUIDE.md"));
    expect(readFileSync(first.guidePath, "utf8")).toBe("guide-v1\n");
    expect(readFileSync(join(dataDir, "docs", "agent-integration.md"), "utf8")).toBe(
      "integration-v1\n",
    );
    expect(readFileSync(join(dataDir, "docs", "adr", "ADR-001.md"), "utf8")).toBe("adr-v1\n");

    writeFileSync(join(bundled, "ATM_AGENT_GUIDE.md"), "guide-v2\n", "utf8");
    writeFileSync(join(bundled, "docs", "agent-integration.md"), "integration-v2\n", "utf8");
    rmSync(join(bundled, "docs", "retired.md"));
    rmSync(join(bundled, "integrations", "skills", "retired"), { recursive: true });
    mkdirSync(join(bundled, "docs", "new"), { recursive: true });
    writeFileSync(join(bundled, "docs", "new", "guide.md"), "new-doc\n", "utf8");
    installAgentDocumentation(bundled, dataDir);
    expect(readFileSync(join(dataDir, "ATM_AGENT_GUIDE.md"), "utf8")).toBe("guide-v2\n");
    expect(readFileSync(join(dataDir, "docs", "agent-integration.md"), "utf8")).toBe(
      "integration-v2\n",
    );
    expect(existsSync(join(dataDir, "docs", "retired.md"))).toBe(false);
    expect(existsSync(join(dataDir, "skills", "retired"))).toBe(false);
    expect(readFileSync(join(dataDir, "docs", "new", "guide.md"), "utf8")).toBe("new-doc\n");
    expect(
      readdirSync(dataDir).filter(
        (name) =>
          /^(?:docs|skills)\.(?:staging|backup)-/u.test(name) ||
          /^ATM_AGENT_GUIDE\.md\.(?:staging|backup)-/u.test(name),
      ),
    ).toEqual([]);
  });

  it("随包分发交互式自动注册、原子 Session 边界与拆分规则", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-policy-"));
    temporary.push(root);
    const dataDir = join(root, "data");
    const bundled = createBundledFixture(root);

    installAgentDocumentation(bundled, dataDir);
    const installed = readFileSync(join(dataDir, "docs", "agent-integration.md"), "utf8");
    expect(installed).toContain("普通交互式开工可在受管开发任务未注册时自动创建");
    expect(installed).toContain("需要崩溃重放的自动化控制器必须先注册项目，并携带稳定 `op_id`");
    expect(installed).toContain("该保证的键空间是 `(project, op_id)`");
    expect(installed).toContain("必须验证该回执");
    expect(installed).toContain("ATOMIC_BEGIN_REQUIRES_EXISTING_PROJECT");
    expect(installed).not.toContain("若项目未注册，先由用户确认是否创建");
    expect(installed).toContain("拆成多个可独立完成和验收的子 WorkItem");
    const guide = readFileSync(join(dataDir, "ATM_AGENT_GUIDE.md"), "utf8");
    expect(guide).toContain("拆成多个可独立完成和验收的子 WorkItem");
  });

  it("随包 Guide 与 surface v3、三 Profile 和真实发现文件保持一致", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-contract-"));
    temporary.push(root);
    const dataDir = join(root, "data");
    const bundled = createBundledFixture(root);

    installAgentDocumentation(bundled, dataDir);
    const guide = readFileSync(join(dataDir, "ATM_AGENT_GUIDE.md"), "utf8");
    const integration = readFileSync(join(dataDir, "docs", "agent-integration.md"), "utf8");

    expect(guide).toContain("MCP Surface `v3`");
    expect(guide).toContain("`endpoint`、`token`、`pid`");
    expect(guide).toContain("ayanami-task-manager-core");
    expect(guide).toContain("ayanami-task-manager-memory");
    expect(guide).toContain("ayanami-task-manager-actions");
    expect(guide).toContain('operation="checklist_batch"');
    expect(guide).not.toContain("`atm_checklist`");
    expect(integration).toContain("MCP 工具面当前为 v3");
    expect(integration).toContain("三个默认同时登记、工具名不重叠的静态 Profile");
    expect(integration).not.toContain("`atm_checklist`");
    for (const content of [guide, integration]) {
      expect(content).toContain("### 固定 mutation ACK");
      expect(content).toContain("`entities_truncated`");
      expect(content).toContain('"name": "atm_search"');
      expect(content).toContain("operation.mutations[].response.planningRootProvisioned");
      expect(content).not.toContain('planning_root: "PROVISIONED"');
    }
    expect(
      readFileSync(join(dataDir, "docs", "generated", "mutation-acknowledgement.md"), "utf8"),
    ).toBe(readFileSync(join(bundled, "docs", "generated", "mutation-acknowledgement.md"), "utf8"));
  });

  it("把 atm-plan 与 atm-task Skills 发布到设备无关数据根", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-skills-"));
    temporary.push(root);
    const dataDir = join(root, "data");
    const bundled = createBundledFixture(root);

    const installed = installAgentDocumentation(bundled, dataDir);

    expect(installed.skillsPath).toBe(join(dataDir, "skills"));
    expect(readFileSync(join(installed.skillsPath, "atm-plan", "SKILL.md"), "utf8")).toContain(
      "name: atm-plan",
    );
    expect(readFileSync(join(installed.skillsPath, "atm-task", "SKILL.md"), "utf8")).toContain(
      "name: atm-task",
    );
  });

  it("以 source/bundled/installed manifest 拒绝内容漂移、缺失和额外文件", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-manifest-"));
    temporary.push(root);
    const bundled = createBundledFixture(root);
    const dataDir = join(root, "data");
    installAgentDocumentation(bundled, dataDir);
    const expected = buildAgentDocumentationManifest(bundled, "bundled");
    const installed = buildAgentDocumentationManifest(dataDir, "installed");
    expect(compareAgentDocumentationManifests(expected, installed)).toEqual([]);

    const tracked = join(dataDir, "docs", "agent-integration.md");
    writeFileSync(tracked, `${readFileSync(tracked, "utf8")}drift\n`, "utf8");
    expect(
      compareAgentDocumentationManifests(
        expected,
        buildAgentDocumentationManifest(dataDir, "installed"),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "content", path: "docs/agent-integration.md" }),
      ]),
    );
    expect(() =>
      assertAgentDocumentationManifest(
        expected,
        buildAgentDocumentationManifest(dataDir, "installed"),
      ),
    ).toThrow("AGENT_DOCUMENTATION_MANIFEST_MISMATCH");

    writeFileSync(join(dataDir, "docs", "extra-after-install.md"), "extra\n", "utf8");
    expect(
      compareAgentDocumentationManifests(
        expected,
        buildAgentDocumentationManifest(dataDir, "installed"),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "extra", path: "docs/extra-after-install.md" }),
      ]),
    );
    rmSync(tracked);
    expect(
      compareAgentDocumentationManifests(
        expected,
        buildAgentDocumentationManifest(dataDir, "installed"),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "missing", path: "docs/agent-integration.md" }),
      ]),
    );
  });

  it("backup rename 失败时保留原始文档并完成有界回滚", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-fs-backup-"));
    temporary.push(root);
    const bundled = createBundledFixture(root);
    const dataDir = join(root, "data");
    installAgentDocumentation(bundled, dataDir);
    const before = buildAgentDocumentationManifest(dataDir, "installed");
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "must-survive\n", "utf8");
    writeFileSync(join(bundled, "ATM_AGENT_GUIDE.md"), "guide-after-backup-failure\n", "utf8");

    expect(() =>
      installAgentDocumentationForTests(bundled, dataDir, {
        retryAttempts: 1,
        retryDelayMs: 0,
        fs: {
          rename(source, target) {
            if (basename(target).startsWith("docs.backup-")) {
              throw fsFailure(`blocked backup rename: ${source}`);
            }
            renameSync(source, target);
          },
        },
      }),
    ).toThrow(/blocked backup rename.*rollback/u);
    expect(buildAgentDocumentationManifest(dataDir, "installed")).toEqual(before);
    expect(readFileSync(outside, "utf8")).toBe("must-survive\n");
    expect(
      readdirSync(dataDir).filter((name) =>
        /^(?:ATM_AGENT_GUIDE\.md|docs|skills)\.(?:staging|backup)-/u.test(name),
      ),
    ).toEqual([]);
  });

  it("第二个 component install rename 失败时恢复全部旧组件", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-fs-install-"));
    temporary.push(root);
    const bundled = createBundledFixture(root);
    const dataDir = join(root, "data");
    installAgentDocumentation(bundled, dataDir);
    const before = buildAgentDocumentationManifest(dataDir, "installed");
    writeFileSync(join(bundled, "ATM_AGENT_GUIDE.md"), "guide-after-component-failure\n", "utf8");

    expect(() =>
      installAgentDocumentationForTests(bundled, dataDir, {
        retryAttempts: 1,
        retryDelayMs: 0,
        fs: {
          rename(source, target) {
            if (basename(source).startsWith("skills.staging-") && basename(target) === "skills") {
              throw fsFailure("blocked second component install rename");
            }
            renameSync(source, target);
          },
        },
      }),
    ).toThrow(/blocked second component install rename.*rollback/u);
    expect(buildAgentDocumentationManifest(dataDir, "installed")).toEqual(before);
    expect(
      readdirSync(dataDir).filter((name) =>
        /^(?:ATM_AGENT_GUIDE\.md|docs|skills)\.(?:staging|backup)-/u.test(name),
      ),
    ).toEqual([]);
  });

  it("target cleanup 失败时用本事务 staging 回退并保持 manifest 一致", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-fs-cleanup-"));
    temporary.push(root);
    const bundled = createBundledFixture(root);
    const dataDir = join(root, "data");
    installAgentDocumentation(bundled, dataDir);
    const before = buildAgentDocumentationManifest(dataDir, "installed");

    expect(() =>
      installAgentDocumentationForTests(bundled, dataDir, {
        retryAttempts: 1,
        retryDelayMs: 0,
        fs: {
          rename(source, target) {
            if (basename(source).startsWith("skills.staging-") && basename(target) === "skills") {
              throw fsFailure("blocked install to trigger target cleanup");
            }
            renameSync(source, target);
          },
          remove(path) {
            if (basename(path) === "docs") throw fsFailure("locked installed docs target", "EBUSY");
            rmSync(path, { recursive: true, force: true });
          },
        },
      }),
    ).toThrow(/blocked install to trigger target cleanup.*rollback.*failures=/u);
    expect(buildAgentDocumentationManifest(dataDir, "installed")).toEqual(before);
    expect(
      readdirSync(dataDir).filter((name) =>
        /^(?:ATM_AGENT_GUIDE\.md|docs|skills)\.(?:staging|backup)-/u.test(name),
      ),
    ).toEqual([]);
  });

  it("backup 恢复被占用时保留可识别备份供下次启动恢复", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-fs-restore-"));
    temporary.push(root);
    const bundled = createBundledFixture(root);
    const dataDir = join(root, "data");
    installAgentDocumentation(bundled, dataDir);
    const before = buildAgentDocumentationManifest(dataDir, "installed");
    let blockRestore = true;

    expect(() =>
      installAgentDocumentationForTests(bundled, dataDir, {
        retryAttempts: 1,
        retryDelayMs: 0,
        fs: {
          rename(source, target) {
            if (basename(source).startsWith("skills.staging-") && basename(target) === "skills") {
              throw fsFailure("blocked install before rollback restore");
            }
            if (
              blockRestore &&
              basename(source).startsWith("docs.backup-") &&
              basename(target) === "docs"
            ) {
              throw fsFailure("locked docs backup restore", "EBUSY");
            }
            renameSync(source, target);
          },
        },
      }),
    ).toThrow(/blocked install before rollback restore.*rollback.*failures=/u);
    expect(existsSync(join(dataDir, "docs"))).toBe(false);
    expect(readdirSync(dataDir).filter((name) => /^docs\.backup-/u.test(name))).toHaveLength(1);

    blockRestore = false;
    installAgentDocumentation(bundled, dataDir);
    expect(buildAgentDocumentationManifest(dataDir, "installed")).toEqual(before);
    expect(
      readdirSync(dataDir).filter((name) =>
        /^(?:ATM_AGENT_GUIDE\.md|docs|skills)\.(?:staging|backup)-/u.test(name),
      ),
    ).toEqual([]);
  });

  it("删除新 target 与 fallback rename 双失败时保留旧 backup 并于下次启动恢复", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-fs-double-failure-"));
    temporary.push(root);
    const bundled = createBundledFixture(root);
    const dataDir = join(root, "data");
    installAgentDocumentation(bundled, dataDir);
    const trackedDoc = join("docs", "agent-integration.md");
    const originalDoc = readFileSync(join(dataDir, trackedDoc), "utf8");
    writeFileSync(join(bundled, trackedDoc), "replacement-doc-v2\n", "utf8");

    expect(() =>
      installAgentDocumentationForTests(bundled, dataDir, {
        retryAttempts: 1,
        retryDelayMs: 0,
        fs: {
          rename(source, target) {
            if (basename(source).startsWith("skills.staging-") && basename(target) === "skills") {
              throw fsFailure("blocked install to trigger double rollback failure");
            }
            if (basename(source) === "docs" && basename(target).startsWith("docs.staging-")) {
              throw fsFailure("locked docs fallback rename", "EBUSY");
            }
            renameSync(source, target);
          },
          remove(path) {
            if (basename(path) === "docs") throw fsFailure("locked docs target removal", "EBUSY");
            rmSync(path, { recursive: true, force: true });
          },
        },
      }),
    ).toThrow(/blocked install to trigger double rollback failure.*rollback.*failures=/u);
    expect(readFileSync(join(dataDir, trackedDoc), "utf8")).toBe("replacement-doc-v2\n");
    const backup = readdirSync(dataDir).find((name) => /^docs\.backup-[a-f0-9]{16}$/u.test(name));
    expect(backup).toBeDefined();
    expect(readFileSync(join(dataDir, backup!, "agent-integration.md"), "utf8")).toBe(originalDoc);

    installAgentDocumentation(bundled, dataDir);
    expect(buildAgentDocumentationManifest(dataDir, "installed")).toEqual(
      buildAgentDocumentationManifest(bundled, "bundled"),
    );
    expect(
      readdirSync(dataDir).filter((name) =>
        /^(?:ATM_AGENT_GUIDE\.md|docs|skills)\.(?:staging|backup)-/u.test(name),
      ),
    ).toEqual([]);
  });

  it("post-commit backup cleanup 失败不阻断安装，并在下次启动精确回收", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-fs-postcommit-"));
    temporary.push(root);
    const bundled = createBundledFixture(root);
    const dataDir = join(root, "data");
    installAgentDocumentation(bundled, dataDir);
    const expected = buildAgentDocumentationManifest(bundled, "bundled");
    let outsideTouches = 0;

    installAgentDocumentationForTests(bundled, dataDir, {
      retryAttempts: 1,
      retryDelayMs: 0,
      fs: {
        remove(path) {
          if (!resolve(path).startsWith(`${resolve(dataDir)}\\`)) outsideTouches += 1;
          if (basename(path).includes(".backup-"))
            throw fsFailure("locked post-commit backup", "EPERM");
          rmSync(path, { recursive: true, force: true });
        },
      },
    });
    expect(buildAgentDocumentationManifest(dataDir, "installed")).toEqual(expected);
    expect(outsideTouches).toBe(0);
    expect(
      readdirSync(dataDir).filter((name) =>
        /^(?:ATM_AGENT_GUIDE\.md|docs|skills)\.backup-/u.test(name),
      ),
    ).toHaveLength(3);

    installAgentDocumentation(bundled, dataDir);
    expect(buildAgentDocumentationManifest(dataDir, "installed")).toEqual(expected);
    expect(
      readdirSync(dataDir).filter((name) =>
        /^(?:ATM_AGENT_GUIDE\.md|docs|skills)\.(?:staging|backup)-/u.test(name),
      ),
    ).toEqual([]);
  });
});
