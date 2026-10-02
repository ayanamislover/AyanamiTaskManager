// 客户端契约对 atm-relay 跑一遍。同一套用例用 scripts/contract-against.ts 对 AyanamiCloud 跑过，
// 结果记在 README「兼容性」一节。
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  ContractClient,
  appDataContractCases,
  newNamespace,
} from "./contract/app-data-contract.js";
import { type TestRelay, cleanupHarness, startTestRelay } from "./support/relay-harness.js";

// 变更保留调小到 8 条，让「游标被裁剪 → 410」用例只需写 10 次。
const CHANGE_RETENTION = 8;

let relay: TestRelay;
let client: ContractClient;

beforeAll(async () => {
  relay = await startTestRelay({ limits: { changeRetentionCount: CHANGE_RETENTION } });
  client = new ContractClient(
    {
      baseUrl: relay.baseUrl,
      appId: "atm",
      token: relay.token,
      capabilities: { longPoll: true, changeRetention: CHANGE_RETENTION },
    },
    newNamespace(),
  );
});

afterAll(async () => {
  await client.cleanup();
  await cleanupHarness();
});

describe("应用数据契约：atm-relay", () => {
  for (const contractCase of appDataContractCases) {
    const reason = contractCase.skip?.({ longPoll: true, changeRetention: CHANGE_RETENTION });
    const test = reason ? it.skip : it;
    test(contractCase.name, () => contractCase.run(client));
  }
});
