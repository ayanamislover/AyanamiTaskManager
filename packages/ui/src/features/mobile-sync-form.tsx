import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AyanamiClient, SyncRelayTestResult, SyncStatus } from "@ayanami-task/client";
import { MutationErrorAlert } from "../components/async-state.js";
import type { Notify } from "../contracts.js";
import {
  describeRelayTest,
  SYNC_STATUS_QUERY_KEY,
  syncConfigPatch,
  syncDraftProblem,
  type SyncDraft,
} from "./mobile-sync-support.js";

/**
 * 中继连接表单。首次配置时是「测试连接 / 保存并启用」；已启用后展开「连接设置」时是「取消 / 保存」。
 * token 是密码框、从不回显：已保存时留空就沿用旧的。
 */
export function SyncConfigForm({
  client,
  status,
  notify,
  mode,
  onDone,
}: {
  client: AyanamiClient;
  status: SyncStatus;
  notify: Notify;
  mode: "enable" | "edit";
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const tokenSaved = status.configured;
  const [draft, setDraft] = useState<SyncDraft>({
    relayUrl: status.relayUrl ?? "",
    appId: status.appId || "atm",
    token: "",
    deviceName: status.deviceName ?? "",
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<SyncRelayTestResult | null>(null);
  const field =
    (key: keyof SyncDraft) =>
    (event: { target: { value: string } }): void => {
      setDraft((current) => ({ ...current, [key]: event.target.value }));
      setProblem(null);
      setTestResult(null);
    };

  const test = useMutation({
    mutationFn: () =>
      client.testSyncRelay({
        relayUrl: draft.relayUrl.trim(),
        appId: draft.appId.trim(),
        ...(draft.token.trim() ? { token: draft.token.trim() } : {}),
      }),
    onSuccess: setTestResult,
  });
  const save = useMutation({
    mutationFn: () =>
      client.updateSyncConfig(syncConfigPatch(draft, mode === "enable" ? true : undefined)),
    onSuccess: async () => {
      setDraft((current) => ({ ...current, token: "" }));
      await queryClient.invalidateQueries({ queryKey: SYNC_STATUS_QUERY_KEY });
      notify(mode === "enable" ? "手机同步已启用" : "连接设置已保存");
      onDone?.();
    },
  });
  const submit = (action: "test" | "save") => {
    const found = syncDraftProblem(draft, tokenSaved, action === "test");
    if (found) {
      setProblem(found);
      return;
    }
    setProblem(null);
    if (action === "test") test.mutate();
    else save.mutate();
  };
  const pending = test.isPending || save.isPending;

  return (
    <form
      className="atm-sync-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit("save");
      }}
    >
      <div className="atm-sync-fields">
        <div className="atm-field atm-sync-field-relay">
          <label htmlFor="sync-relay-url">中继地址</label>
          <input
            id="sync-relay-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://relay.example.com"
            value={draft.relayUrl}
            onChange={field("relayUrl")}
          />
        </div>
        <div className="atm-field">
          <label htmlFor="sync-app-id">应用 ID</label>
          <input
            id="sync-app-id"
            autoComplete="off"
            spellCheck={false}
            value={draft.appId}
            onChange={field("appId")}
          />
        </div>
        <div className="atm-field">
          <label htmlFor="sync-token">中继 token</label>
          <input
            id="sync-token"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            placeholder={tokenSaved ? "已保存 · 重新填写可替换" : "中继签发的 token"}
            value={draft.token}
            onChange={field("token")}
          />
        </div>
        <div className="atm-field">
          <label htmlFor="sync-device-name">本机名称</label>
          <input
            id="sync-device-name"
            autoComplete="off"
            maxLength={64}
            placeholder="例如：书房电脑"
            value={draft.deviceName}
            onChange={field("deviceName")}
          />
        </div>
      </div>
      {problem ? (
        <div className="atm-inline-error" role="alert">
          {problem}
        </div>
      ) : null}
      {testResult ? (
        <div
          className="atm-sync-note"
          data-tone={testResult.ok ? "success" : "danger"}
          role="status"
        >
          {describeRelayTest(testResult)}
        </div>
      ) : null}
      <MutationErrorAlert errors={[test.error, save.error]} />
      <div className="atm-sync-form-actions">
        {mode === "edit" ? (
          <button className="atm-button" type="button" disabled={pending} onClick={onDone}>
            取消
          </button>
        ) : null}
        <button
          className="atm-button"
          type="button"
          disabled={pending}
          onClick={() => submit("test")}
        >
          {test.isPending ? "正在测试" : "测试连接"}
        </button>
        <button className="atm-button primary" type="submit" disabled={pending}>
          {mode === "enable" ? "保存并启用" : "保存"}
        </button>
      </div>
    </form>
  );
}
