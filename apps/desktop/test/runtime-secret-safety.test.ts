import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** 宿主注入页面的 window.ayanamiDesktop 桥（取代 Electron 的 preload）。 */
function bridgeScript(): string {
  const source = read("apps/desktop/native/host/src/bridge.rs");
  const script = /pub const INIT_SCRIPT: &str = r#"([\s\S]*?)"#;/u.exec(source)?.[1];
  if (script === undefined) throw new Error("INIT_SCRIPT block not found");
  return script;
}

describe("runtime secret safety guards", () => {
  it("keeps the legacy token filename confined to cleanup compatibility code", () => {
    const candidates = [
      "apps/daemon/src/runtime-discovery.ts",
      "apps/daemon/src/main.ts",
      "apps/desktop/src/core-main.ts",
      "apps/desktop/src/renderer.tsx",
      "apps/desktop/native/host/src/bridge.rs",
      "apps/desktop/native/host/src/core_process.rs",
      "packages/cli/src/index.ts",
      "packages/cli/src/runtime.ts",
      "scripts/migrate-data-root.ts",
    ];
    const occurrences = candidates.filter((path) => read(path).includes("local.token"));
    expect(occurrences).toEqual([
      "apps/daemon/src/runtime-discovery.ts",
      "scripts/migrate-data-root.ts",
    ]);

    const legacyWriter = (source: string) =>
      /(?:writeFileSync|copyFileSync|\.writeFile)\([^)]*local\.token/u.test(source);
    expect(legacyWriter('writeFileSync(join(runtime, "local.token"), token)')).toBe(true);
    for (const path of occurrences) expect(legacyWriter(read(path)), path).toBe(false);
  });

  it("does not publish a CLI token argument or expose the descriptor through the page bridge", () => {
    const cli = read("packages/cli/src/index.ts");
    expect(cli).not.toContain("--token");
    expect(cli).not.toContain("--endpoint");
    const exposes = (script: string): string[] =>
      [/\bruntime\s*:/u, /getRuntime/u, /\btoken\b/iu, /daemon\.json/u]
        .filter((pattern) => pattern.test(script))
        .map(String);
    const script = bridgeScript();
    expect(exposes(script)).toEqual([]);
    expect(script).toContain('runtimeRequest: (input) => call("runtimeRequest", [input])');
    // 阳性对照
    expect(exposes(`${script}\n    runtime: () => call("getRuntime", []),`)).toHaveLength(2);
  });

  // ATM-T-0503：用户凭证只在 core 内存里，renderer 请求由 core 代为注入；宿主只转发请求。
  it("keeps the user credential out of daemon.json and hands it only to renderer requests", () => {
    const leaks = (core: string, integrations: string, host: string): string[] => {
      const problems: string[] = [];
      const descriptor = /const descriptor: DaemonRuntimeDescriptor = \{([\s\S]*?)\n {2}\};/u.exec(
        core,
      )?.[1];
      if (descriptor === undefined) problems.push("descriptor block not found");
      else if (/userToken/u.test(descriptor)) problems.push("userToken in daemon.json descriptor");
      if (!/lease\.publish\(descriptor\)/u.test(core))
        problems.push("publish is not the descriptor");
      if (!/const userToken = createDaemonToken\(\{\}\)/u.test(core))
        problems.push("userToken not rotated per start");
      if (!/proxyRuntimeRequest\(\s*\{[^}]*token: current\.userToken[^}]*\}/u.test(core))
        problems.push("renderer requests do not carry the user credential");
      if (/userToken/u.test(integrations)) problems.push("userToken reaches agent integrations");
      if (
        /(?:writeFileSync|appendFileSync|console\.\w+|log\w*|send\w*)\([^)]*userToken/u.test(core)
      )
        problems.push("userToken written, logged or sent");
      if (/user_?token/iu.test(host)) problems.push("userToken reaches the host");
      return problems;
    };
    const core = read("apps/desktop/src/core-main.ts");
    const integrations = read("apps/desktop/src/main-agent-integrations.ts");
    const host = ["bridge.rs", "core_process.rs", "app.rs"]
      .map((name) => read(`apps/desktop/native/host/src/${name}`))
      .join("\n");
    expect(leaks(core, integrations, host)).toEqual([]);

    // 阳性对照：把根因逐条写回去，守卫都要认出来。
    expect(
      leaks(
        core.replace("    token,\n    pid:", "    token,\n    userToken,\n    pid:"),
        integrations,
        host,
      ),
    ).toContain("userToken in daemon.json descriptor");
    expect(
      leaks(
        core.replace("token: current.userToken", "token: current.descriptor.token"),
        integrations,
        host,
      ),
    ).toContain("renderer requests do not carry the user credential");
    expect(leaks(core, `${integrations}\nconst leaked = host.userToken;`, host)).toContain(
      "userToken reaches agent integrations",
    );
    expect(leaks(`${core}\nconsole.log(userToken);`, integrations, host)).toContain(
      "userToken written, logged or sent",
    );
    expect(leaks(`${core}\nsession.send({ t: "x", userToken });`, integrations, host)).toContain(
      "userToken written, logged or sent",
    );
    expect(leaks(core, integrations, `${host}\nlet user_token = frame;`)).toContain(
      "userToken reaches the host",
    );
  });

  it("always rotates the packaged desktop token even when the parent environment has an override", () => {
    const core = read("apps/desktop/src/core-main.ts");
    expect(core).toContain("const token = createDaemonToken({});");
    expect(core).not.toMatch(/createDaemonToken\(\s*\)/u);
  });
});
