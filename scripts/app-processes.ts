export type AppProcess = { imageName: string; pid: number };

// tasklist /fo csv /nh 的每行形如：
//   "AyanamiTaskManager.exe","972","Console","1","123,456 K"
// 没有匹配时它打印的是一句本地化提示（中文「信息: 没有运行的任务…」/英文 INFO:），
// 不带引号，所以只认以引号开头的行，避免把提示语当成一个进程。
export function parseTasklistCsv(stdout: string): AppProcess[] {
  const processes: AppProcess[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const matched = /^"([^"]+)","(\d+)"/u.exec(line.trim());
    if (!matched) continue;
    processes.push({ imageName: matched[1]!, pid: Number(matched[2]) });
  }
  return processes;
}

// 只报「有进程在跑」等于没说：退出桌面应用之后剩下的几乎总是 MCP stdio 桥——
// 每个连着 ATM 的 Claude 会话都会用同一个 exe 名拉起一个，tasklist 按镜像名根本
// 分不出来。它们还占着安装目录里的 exe 句柄，Squirrel 卸载因此只能留 .dead 标记。
// 把 PID 和这条因果一起说出来，下一个人就不用再从头查一遍。
export function describeAppProcesses(processes: AppProcess[]): string {
  if (processes.length === 0) return "";
  const pids = processes.map((process) => process.pid).join("、");
  return (
    `${processes.length} 个 ${processes[0]!.imageName} 仍在运行（PID ${pids}）。` +
    "退出桌面应用不会结束它们：任何连着 ATM 的 Claude 会话都会用同一个 exe 名拉起一个 " +
    "MCP stdio 桥接进程，并占着安装目录里的 exe 句柄。请先断开这些会话，或结束上列 PID，再重跑发布验收。"
  );
}
