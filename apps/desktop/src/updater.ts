import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 更新源是一个本地目录，不是服务器。单机单用户场景下这样最省事：发布链把
 * Squirrel 产出的 RELEASES 和 -full.nupkg 投递进来，运行中的应用自己发现并应用。
 *
 * 本地 feed 也让 delta 包变得没必要——169 MB 在本机是一次文件复制而不是一次
 * 网络下载。delta 是为跨机分发省流量的，真要分发给别人时再说。
 */
export function updateFeedDir(dataDir: string): string {
  return join(dataDir, "updates");
}

/**
 * 没有 RELEASES 就等于没有更新源。这时必须安静地什么都不做：把 autoUpdater
 * 指向一个不存在的源会抛错，而「还没发过任何更新」是完全正常的状态，不该在
 * 用户面前变成一条报错。
 */
export function updateFeedReady(dataDir: string): boolean {
  return existsSync(join(updateFeedDir(dataDir), "RELEASES"));
}
