import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeArguments,
  DEFAULT_DISPATCH_CONFIG,
  DispatchError,
  dispatchChildEnv,
  dispatchPaths,
  HOST_SESSION_ENV,
  judgeOutcome,
  launchCommand,
  renderDispatchPrompt,
} from "../src/index.js";
import { cleanupAll, fixture } from "./support.js";

afterEach(cleanupAll);

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("派单配置", () => {
  it("没有配置文件时是默认值（默认关闭、auto、并发 1）", () => {
    const f = fixture();
    expect(f.dispatcher().config).toEqual({
      enabled: false,
      permissionMode: "auto",
      maxConcurrent: 1,
      model: null,
      effort: null,
    });
    expect(f.warnings).toEqual([]);
  });

  it("修改会原子写入 config.json，重新加载后仍在", async () => {
    const f = fixture();
    const first = f.dispatcher();
    await first.updateConfig({ enabled: true, maxConcurrent: 3, model: "opus", effort: "high" });
    const path = dispatchPaths(f.dataDir).config;
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      enabled: true,
      permissionMode: "auto",
      maxConcurrent: 3,
      model: "opus",
      effort: "high",
    });
    expect(f.dispatcher().config).toMatchObject({ enabled: true, maxConcurrent: 3 });
    await first.updateConfig({ model: null });
    expect(f.dispatcher().config.model).toBeNull();
  });

  it("坏文件与不合法的值回退默认值并记日志", () => {
    const f = fixture();
    const path = dispatchPaths(f.dataDir).config;
    mkdirSync(join(f.dataDir, "dispatch"), { recursive: true });
    writeFileSync(path, "{ 这不是 JSON");
    expect(f.dispatcher().config).toEqual(DEFAULT_DISPATCH_CONFIG);
    writeFileSync(path, JSON.stringify({ ...DEFAULT_DISPATCH_CONFIG, maxConcurrent: 9 }));
    expect(f.dispatcher().config).toEqual(DEFAULT_DISPATCH_CONFIG);
    expect(f.warnings).toHaveLength(2);
  });

  it("不合法的补丁被拒绝：越界并发、未知字段、危险 model、manual 权限模式", async () => {
    const f = fixture();
    const dispatcher = f.dispatcher();
    for (const patch of [
      { maxConcurrent: 4 },
      { maxConcurrent: 0 },
      { surprise: true },
      { model: "opus && calc" },
      { permissionMode: "manual" },
      { effort: "ultra" },
      "not-an-object",
    ]) {
      const error = await dispatcher.updateConfig(patch).catch((caught: unknown) => caught);
      expect(error, JSON.stringify(patch)).toBeInstanceOf(DispatchError);
      expect((error as DispatchError).code).toBe("DISPATCH_INVALID_ARGUMENT");
    }
    expect(dispatcher.config).toEqual(DEFAULT_DISPATCH_CONFIG);
  });
});

describe("命令行与环境", () => {
  const config = { permissionMode: "auto" as const, model: null, effort: null };

  it("参数数组固定且不含提示词；model/effort 按需追加", () => {
    expect(claudeArguments({ sessionId: SESSION, key: "ATM-T-0545", config })).toEqual([
      "-p",
      "--permission-mode",
      "auto",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      SESSION,
      "--name",
      "ATM · ATM-T-0545",
    ]);
    expect(
      claudeArguments({
        sessionId: SESSION,
        key: "ATM-T-0545",
        config: { permissionMode: "plan", model: "claude-opus-5-5", effort: "max" },
      }).slice(-4),
    ).toEqual(["--model", "claude-opus-5-5", "--effort", "max"]);
  });

  it("键名、model、会话 ID 不合法时拒绝，不会带进命令行", () => {
    for (const key of ["atm-t-0001", "ATM-T-01", "ATM-T-0001 & calc", 'A-T-0001"'])
      expect(() => claudeArguments({ sessionId: SESSION, key, config })).toThrow(DispatchError);
    expect(() =>
      claudeArguments({ sessionId: SESSION, key: "A-T-0001", config: { ...config, model: "a b" } }),
    ).toThrow(DispatchError);
    expect(() => claudeArguments({ sessionId: "x", key: "A-T-0001", config })).toThrow(
      DispatchError,
    );
  });

  it("npm 装法的 .cmd 经 cmd.exe /d /s /c 起，参数逐个加引号；.mjs 用当前 Node 起", () => {
    const args = claudeArguments({ sessionId: SESSION, key: "ATM-T-0545", config });
    const viaCmd = launchCommand(
      "C:\\Users\\Tom Jerry\\AppData\\Roaming\\npm\\claude.cmd",
      args,
      "win32",
      "C:\\Windows\\system32\\cmd.exe",
    );
    expect(viaCmd.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(viaCmd.windowsVerbatimArguments).toBe(true);
    expect(viaCmd.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(viaCmd.args[3]).toBe(
      `""C:\\Users\\Tom Jerry\\AppData\\Roaming\\npm\\claude.cmd" -p --permission-mode auto ` +
        `--output-format stream-json --verbose --session-id ${SESSION} --name "ATM · ATM-T-0545""`,
    );
    expect(() => launchCommand("C:\\100%\\claude.cmd", args, "win32")).toThrow(DispatchError);
    expect(launchCommand("C:\\x\\claude.exe", args, "win32")).toEqual({
      command: "C:\\x\\claude.exe",
      args,
    });
    expect(launchCommand("/opt/fake.mjs", ["--version"], "linux")).toEqual({
      command: process.execPath,
      args: ["/opt/fake.mjs", "--version"],
    });
  });

  it("去掉宿主 Claude 会话的变量与 ATM 用户凭证（大小写不敏感），保留用户配置", () => {
    const env = dispatchChildEnv(
      {
        PATH: "p",
        CLAUDECODE: "1",
        claude_code_entrypoint: "sdk-ts",
        CLAUDE_CODE_SSE_PORT: "1234",
        CLAUDE_CODE_MESSAGING_TOKEN: "secret",
        AYANAMI_TASK_USER_TOKEN: "user-secret",
        "SENTRY-TRACE": "t",
        ANTHROPIC_BASE_URL: "https://proxy.example",
        ANTHROPIC_API_KEY: "sk-user",
        CLAUDE_CODE_USE_BEDROCK: "1",
        HTTPS_PROXY: "http://127.0.0.1:7890",
        ATM_DISPATCH_RUN: "stale",
      },
      "run-1",
    );
    expect(env).toEqual({
      PATH: "p",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      ANTHROPIC_API_KEY: "sk-user",
      CLAUDE_CODE_USE_BEDROCK: "1",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ATM_DISPATCH_RUN: "run-1",
    });
    for (const name of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"])
      expect(HOST_SESSION_ENV).toHaveProperty(name);
    expect(Object.keys(HOST_SESSION_ENV).some((name) => /^ANTHROPIC_|PROXY/iu.test(name))).toBe(
      false,
    );
  });
});

describe("提示词", () => {
  it("中文模板快照：键、标题、项目、来源、工作守则，不含任何令牌", () => {
    const prompt = renderDispatchPrompt({
      run: "mg7x3k2a-1a2b3c4d",
      projectCode: "ATM",
      projectName: "AyanamiTaskManager",
      cwd: "R:\\Project_All\\AyanamiTaskManager",
      key: "ATM-T-0545",
      title: "Claude 自动派单\n（agent-dispatch）",
      origin: "mobile",
      requestedBy: "Pixel 9",
    });
    expect(prompt).toMatchSnapshot();
    expect(prompt).toContain('atm_begin(cwd="R:\\\\Project_All\\\\AyanamiTaskManager"');
    expect(prompt).toContain('project_code="ATM"');
    expect(prompt).not.toMatch(/token|secret|令牌/iu);
    const desktop = renderDispatchPrompt({
      run: "r-00000000",
      projectCode: "ATM",
      projectName: "A",
      cwd: "/p",
      key: "ATM-T-0001",
      title: "t",
      origin: "desktop",
    });
    expect(desktop).toContain("用户在 ATM 桌面端点名");
  });
});

describe("结局判定", () => {
  it("success 且非 is_error 才算成功；登录失败那种 subtype=success + is_error 算失败", () => {
    const f = fixture();
    const out = join(f.root, "out.jsonl");
    const err = join(f.root, "err.log");
    const write = (value: unknown) =>
      writeFileSync(out, `{"type":"system"}\n截断的噪声\n${JSON.stringify(value)}\n`);
    write({ type: "result", subtype: "success", is_error: false, num_turns: 2, result: "好" });
    expect(judgeOutcome(out, err, 0)).toEqual({
      state: "succeeded",
      summary: { numTurns: 2, durationMs: null, totalCostUsd: null, result: "好" },
    });
    write({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate" });
    expect(judgeOutcome(out, err, 1)).toMatchObject({
      state: "failed",
      error: "Failed to authenticate",
    });
    write({ type: "result", subtype: "error_max_turns", is_error: true });
    expect(judgeOutcome(out, err, 1)).toMatchObject({ state: "failed", error: "error_max_turns" });
    writeFileSync(out, '{"type":"assistant"}\n');
    writeFileSync(err, "line1\nline2\n");
    expect(judgeOutcome(out, err, 3)).toEqual({
      state: "failed",
      error: "进程退出（exit code 3）：line1 | line2",
    });
    expect(judgeOutcome(join(f.root, "none"), join(f.root, "none2"), null)).toEqual({
      state: "failed",
      error: "进程已结束，日志里没有 result 行",
    });
  });
});
