// 首次启动：建应用 atm 与第一枚 token，明文写进 <data>/initial-token.txt。
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Database } from "./database.js";
import type { RelayLogger } from "./log.js";
import {
  DEFAULT_APP_ID,
  DEFAULT_APP_NAME,
  createApp,
  createToken,
  getApp,
  getMeta,
  setMeta,
} from "./tokens.js";

export const INITIAL_TOKEN_FILE = "initial-token.txt";
const BOOTSTRAP_META = "bootstrapped";

/**
 * 只有本人能读的文件。POSIX 用 0600；Windows 没有 mode 语义，改用 icacls 去掉继承、只授当前用户。
 * 收紧失败返回 false：文件仍然写出（否则用户拿不到 token），由调用方在日志里提醒。
 */
export function writePrivateFile(path: string, content: string): boolean {
  rmSync(path, { force: true });
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") return true;
  try {
    const user = userInfo().username;
    const domain = process.env.USERDOMAIN;
    const principal = domain ? `${domain}\\${user}` : user;
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${principal}:F`], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 库里还没做过首次初始化就做一次，返回 initial-token.txt 的路径；做过了返回 null。
 * 用 meta 标记而不是「有没有 app」判断：用户撤销了全部 token 之后重启，不应该又冒出一枚新的。
 */
export function bootstrapIfNeeded(db: Database, dataDir: string, log: RelayLogger): string | null {
  if (getMeta(db, BOOTSTRAP_META) === "1") return null;
  if (!getApp(db, DEFAULT_APP_ID)) createApp(db, DEFAULT_APP_ID, DEFAULT_APP_NAME);
  const issued = createToken(db, DEFAULT_APP_ID, "initial");
  const path = join(dataDir, INITIAL_TOKEN_FILE);
  const restricted = writePrivateFile(path, `${issued.plaintext}\n`);
  setMeta(db, BOOTSTRAP_META, "1");
  log.info(
    `首次启动：已建立应用 ${DEFAULT_APP_ID} 并签发 token ${issued.token.id}，明文见 ${path}（只此一份，抄走后请删除该文件）`,
  );
  if (!restricted) log.warn(`未能收紧 ${path} 的访问权限，请确认只有你自己能读它`);
  return path;
}
