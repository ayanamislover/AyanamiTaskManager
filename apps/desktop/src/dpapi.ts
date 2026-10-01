import { spawn } from "node:child_process";

/** 原生宿主的一次性 DPAPI 模式（native/host/src/dpapi.rs）。 */
export const DPAPI_FLAG = "--dpapi";

const CALL_TIMEOUT_MS = 10_000;
/** 密钥很短；输出超过这个长度（hex 字符）一定不对，直接放弃。 */
const MAX_OUTPUT_CHARS = 256 * 1024;
const HEX_LINE = /^(?:[0-9a-f]{2})*$/u;

/** Windows DPAPI（当前用户）：密文只能由同一个 Windows 用户在这台机器上解开。 */
export type Dpapi = {
  protect(data: Buffer): Promise<Buffer>;
  unprotect(data: Buffer): Promise<Buffer>;
};

export type HostDpapiOptions = {
  /** 插在 `--dpapi` 前面的参数；测试用它让 node 跑一个假宿主脚本。 */
  prefixArgs?: readonly string[];
  timeoutMs?: number;
};

/**
 * 经原生宿主调 DPAPI：`<host> --dpapi protect|unprotect`，数据走 stdin / stdout（hex 一行），
 * 不上命令行。宿主与 core 包在同一个版本目录里，和请求方同样可信。
 * 失败（宿主不存在、不认识这个模式、调用失败、超时、输出不合格式）一律 reject，由调用方当作不可用。
 */
export function hostDpapi(hostPath: string, options: HostDpapiOptions = {}): Dpapi {
  const prefixArgs = options.prefixArgs ?? [];
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  const call = (operation: "protect" | "unprotect", data: Buffer): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(hostPath, [...prefixArgs, DPAPI_FLAG, operation], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      let output = "";
      let settled = false;
      const finish = (error: Error | null, value?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value ?? Buffer.alloc(0));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("DPAPI_TIMEOUT"));
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.length <= MAX_OUTPUT_CHARS) return;
        child.kill();
        finish(new Error("DPAPI_OUTPUT_TOO_LARGE"));
      });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        const line = output.trim();
        if (code !== 0 || !HEX_LINE.test(line)) finish(new Error("DPAPI_FAILED"));
        else finish(null, Buffer.from(line, "hex"));
      });
      // 宿主提前退出（不认识这个模式）时写 stdin 会 EPIPE，结果以退出码为准。
      child.stdin.on("error", () => undefined);
      child.stdin.end(`${data.toString("hex")}\n`);
    });
  return {
    protect: (data) => call("protect", data),
    unprotect: (data) => call("unprotect", data),
  };
}
