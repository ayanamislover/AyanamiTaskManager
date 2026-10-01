// 驱动脚本起了原生窗口探针，却忘了 close、还以未捕获异常结束：探针与它的临时根仍要被带走。
import { NativeWindowProbe } from "../../../../scripts/native-window.js";

const probe = NativeWindowProbe.start(process.argv[2]);
await probe.windows(process.pid);
process.stdout.write("probe-ready\n");
throw new Error("driver crashed without closing the probe");
