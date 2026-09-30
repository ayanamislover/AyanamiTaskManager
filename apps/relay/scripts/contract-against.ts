// 对任意「应用数据」兼容服务跑客户端契约（atm-relay、本地 AyanamiCloud……）。
//
//   RELAY_CONTRACT_URL=http://127.0.0.1:8790 RELAY_CONTRACT_APP=atm RELAY_CONTRACT_TOKEN=… \
//     pnpm --filter @ayanami-task/relay contract
//
// 可选 RELAY_CONTRACT_RETENTION=<变更保留条数>：给出时额外跑「游标被裁剪 → 410」，要写 retention+2 次。
// 用例只在 contract/<本次运行 ID>/ 前缀下读写，结束时删掉自己建的文档；变更流里会留下记录。
// 请只对自己的测试实例运行。
import {
  type CaseOutcome,
  type ContractTarget,
  runAppDataContract,
} from "../test/contract/app-data-contract.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    process.stderr.write(`缺少环境变量 ${name}\n`);
    process.exit(2);
  }
  return value;
}

async function detectLongPoll(baseUrl: string, appId: string, token: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/v1/apps/${encodeURIComponent(appId)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (response.status !== 200) {
    throw new Error(`连接测试失败：GET /v1/apps/${appId} 返回 HTTP ${response.status}`);
  }
  const body = (await response.json()) as { id?: unknown; relay?: { long_poll?: unknown } };
  if (body.id !== appId) throw new Error(`连接测试失败：返回的 id 是 ${String(body.id)}`);
  return body.relay?.long_poll === true;
}

async function main(): Promise<number> {
  const baseUrl = required("RELAY_CONTRACT_URL").replace(/\/+$/, "");
  const appId = required("RELAY_CONTRACT_APP");
  const token = required("RELAY_CONTRACT_TOKEN");
  const retentionRaw = process.env.RELAY_CONTRACT_RETENTION?.trim();
  const retention = retentionRaw ? Number(retentionRaw) : undefined;
  if (retention !== undefined && (!Number.isSafeInteger(retention) || retention <= 0)) {
    process.stderr.write("RELAY_CONTRACT_RETENTION 必须是正整数\n");
    return 2;
  }
  const longPoll = await detectLongPoll(baseUrl, appId, token);
  const target: ContractTarget = {
    baseUrl,
    appId,
    token,
    capabilities: { longPoll, ...(retention === undefined ? {} : { changeRetention: retention }) },
  };
  process.stdout.write(`目标 ${baseUrl}，app ${appId}，长轮询：${longPoll ? "支持" : "不支持"}\n`);
  const marks: Record<CaseOutcome["status"], string> = {
    passed: "通过",
    failed: "失败",
    skipped: "跳过",
  };
  const outcomes = await runAppDataContract(target, (outcome) => {
    const detail = outcome.detail ? `：${outcome.detail}` : "";
    process.stdout.write(`[${marks[outcome.status]}] ${outcome.name}${detail}\n`);
  });
  const count = (status: CaseOutcome["status"]) =>
    outcomes.filter((outcome) => outcome.status === status).length;
  process.stdout.write(
    `\n合计 ${outcomes.length}：通过 ${count("passed")}，失败 ${count("failed")}，跳过 ${count("skipped")}\n`,
  );
  return count("failed") === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${(error as Error).message ?? String(error)}\n`);
    process.exitCode = 1;
  },
);
