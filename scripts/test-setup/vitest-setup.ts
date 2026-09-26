// Vitest setupFiles：每个测试 worker 在加载用例之前执行一次。说明见 retrying-temp-removal.ts。
import { createRequire, syncBuiltinESMExports } from "node:module";
import { retryingRemove, retryingRemoveSync } from "./retrying-temp-removal.js";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");

fs.rmSync = retryingRemoveSync(fs.rmSync);
// fs.promises 与 node:fs/promises 是同一个对象，改一处两种导入都生效。
fs.promises.rm = retryingRemove(fs.promises.rm);
// 让 `import { rmSync } from "node:fs"` 这类 ESM 具名导入也指向替换后的函数。
syncBuiltinESMExports();
