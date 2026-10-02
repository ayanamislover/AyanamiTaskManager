// 探针退出时临时根删失败（被扫描占着），之后没人再调 dispose，驱动正常结束：退出时要再删一次。
import { rmSync } from "node:fs";
import { powershellScratch } from "../../../../scripts/powershell-scratch.js";

let attempts = 0;
const scratch = powershellScratch(process.argv[2], process.env, (directory) => {
  attempts += 1;
  if (attempts === 1) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
  rmSync(directory, { recursive: true, force: true });
});
process.stdout.write(
  `${JSON.stringify({ directory: scratch.env.TEMP, disposed: scratch.dispose() })}\n`,
);
