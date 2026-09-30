// 极简日志：一行一条，带 UTC 时间与级别，写到 stderr（stdout 留给 CLI 输出，例如 token 明文）。
//
// 约束：任何调用方都不得把 token 明文、Authorization 头或文档 data 传进来。
// 中继运营者本来就能看到键名、大小和时间，这些可以记；内容与凭据不行。

export type RelayLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export function streamLogger(write: (line: string) => void): RelayLogger {
  const line = (level: string, message: string) =>
    write(`${new Date().toISOString()} ${level} ${message}\n`);
  return {
    info: (message) => line("INFO ", message),
    warn: (message) => line("WARN ", message),
    error: (message) => line("ERROR", message),
  };
}

export const consoleLogger: RelayLogger = streamLogger((line) => process.stderr.write(line));

export const silentLogger: RelayLogger = { info() {}, warn() {}, error() {} };
