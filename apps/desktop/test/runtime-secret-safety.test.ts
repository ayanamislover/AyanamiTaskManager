import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("runtime secret safety guards", () => {
  it("keeps the legacy token filename confined to cleanup compatibility code", () => {
    const candidates = [
      "apps/daemon/src/runtime-discovery.ts",
      "apps/daemon/src/main.ts",
      "apps/desktop/src/runtime-host.ts",
      "apps/desktop/src/preload.ts",
      "apps/desktop/src/renderer.tsx",
      "packages/cli/src/index.ts",
      "packages/cli/src/runtime.ts",
      "scripts/migrate-data-root.ts",
    ];
    expect(candidates.length).toBeGreaterThan(5);
    const occurrences = candidates.filter((path) =>
      readFileSync(join(root, path), "utf8").includes("local.token"),
    );
    expect(occurrences).toEqual([
      "apps/daemon/src/runtime-discovery.ts",
      "scripts/migrate-data-root.ts",
    ]);

    const legacyWriter = (source: string) =>
      /(?:writeFileSync|copyFileSync|\.writeFile)\([^)]*local\.token/u.test(source);
    expect(legacyWriter('writeFileSync(join(runtime, "local.token"), token)')).toBe(true);
    for (const path of occurrences)
      expect(legacyWriter(readFileSync(join(root, path), "utf8")), path).toBe(false);
  });

  it("does not publish a CLI token argument or expose the descriptor through preload", () => {
    const cli = readFileSync(join(root, "packages/cli/src/index.ts"), "utf8");
    const preload = readFileSync(join(root, "apps/desktop/src/preload.ts"), "utf8");
    expect(cli).not.toContain("--token");
    expect(cli).not.toContain("--endpoint");
    expect(preload).not.toContain("atm:get-runtime");
    expect(preload).not.toContain("sendSync");
  });

  // ATM-T-0503：用户凭证只在主进程内存里，renderer 请求由主进程代为注入。
  it("keeps the user credential out of daemon.json and hands it only to renderer requests", () => {
    const leaks = (runtimeHost: string, integrations: string): string[] => {
      const problems: string[] = [];
      const descriptor = /const runtime: Runtime = \{([\s\S]*?)\n {2}\};/u.exec(runtimeHost)?.[1];
      if (descriptor === undefined) problems.push("descriptor block not found");
      else if (/userToken/u.test(descriptor)) problems.push("userToken in daemon.json descriptor");
      if (!/lease\.publish\(runtime\)/u.test(runtimeHost))
        problems.push("publish is not the descriptor");
      if (!/const userToken = createDaemonToken\(\{\}\)/u.test(runtimeHost))
        problems.push("userToken not rotated per start");
      if (!/proxyRuntimeRequest\(\{[^}]*token: host\.userToken[^}]*\}/u.test(runtimeHost))
        problems.push("renderer requests do not carry the user credential");
      if (/userToken/u.test(integrations)) problems.push("userToken reaches agent integrations");
      if (/(?:writeFileSync|appendFileSync|console\.\w+|log\w*)\([^)]*userToken/u.test(runtimeHost))
        problems.push("userToken written or logged");
      return problems;
    };
    const runtimeHost = readFileSync(join(root, "apps/desktop/src/runtime-host.ts"), "utf8");
    const integrations = readFileSync(
      join(root, "apps/desktop/src/main-agent-integrations.ts"),
      "utf8",
    );
    expect(leaks(runtimeHost, integrations)).toEqual([]);

    // 阳性对照：把根因逐条写回去，守卫都要认出来。
    expect(
      leaks(
        runtimeHost.replace("    token,\n    pid:", "    token,\n    userToken,\n    pid:"),
        integrations,
      ),
    ).toContain("userToken in daemon.json descriptor");
    expect(
      leaks(
        runtimeHost.replace("token: host.userToken", "token: host.runtime.token"),
        integrations,
      ),
    ).toContain("renderer requests do not carry the user credential");
    expect(leaks(runtimeHost, `${integrations}\nconst leaked = host.userToken;`)).toContain(
      "userToken reaches agent integrations",
    );
    expect(leaks(`${runtimeHost}\nconsole.log(userToken);`, integrations)).toContain(
      "userToken written or logged",
    );
  });

  it("always rotates the packaged desktop token even when the parent environment has an override", () => {
    const runtimeHost = readFileSync(join(root, "apps/desktop/src/runtime-host.ts"), "utf8");
    expect(runtimeHost).toContain("createDaemonToken({})");
    expect(runtimeHost).not.toMatch(/createDaemonToken\(\s*\)/u);
  });
});
