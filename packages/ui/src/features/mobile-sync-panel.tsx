import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AyanamiClient, SyncStatus } from "@ayanami-task/client";
import { useDialogs } from "../components/atm-dialogs.js";
import { LoadingRows, MutationErrorAlert, SectionLoadError } from "../components/async-state.js";
import { Presence } from "../components/presence.js";
import type { DesktopBridge, Notify } from "../contracts.js";
import { SyncConfigForm } from "./mobile-sync-form.js";
import { PairingDialog } from "./mobile-sync-pairing.js";
import {
  deviceKindLabel,
  deviceOnline,
  featureUnavailable,
  pollingLabel,
  relativeTime,
  SYNC_STATUS_QUERY_KEY,
  SYNC_STATUS_REFRESH_MS,
  syncLamp,
} from "./mobile-sync-support.js";

/**
 * 设置页「手机同步」：用户自己的中继服务器、状态、已配对设备、配对与重置。
 * 默认关闭；不配置时 ATM 仍是纯本地工具（docs/mobile-sync.md §1）。
 */
export function MobileSyncPanel({
  client,
  desktop,
  notify,
}: {
  client: AyanamiClient;
  desktop?: DesktopBridge;
  notify: Notify;
}) {
  const status = useQuery({
    queryKey: SYNC_STATUS_QUERY_KEY,
    queryFn: () => client.getSyncStatus(),
    refetchInterval: (query) =>
      featureUnavailable(query.state.error) ? false : SYNC_STATUS_REFRESH_MS,
  });
  const [pairingOpen, setPairingOpen] = useState(false);
  const lamp = status.data ? syncLamp(status.data) : null;
  return (
    <>
      <section className="atm-panel atm-settings-sync" aria-labelledby="sync-panel-title">
        <div className="atm-panel-head">
          <h2 id="sync-panel-title">手机同步</h2>
          {lamp ? (
            <span
              className="atm-service-status is-inline atm-sync-lamp"
              data-state={lamp.state}
              title={lamp.reason ?? undefined}
            >
              {lamp.label}
            </span>
          ) : null}
        </div>
        <div className="atm-panel-body">
          {status.data ? (
            status.data.enabled ? (
              <SyncEnabledView
                client={client}
                status={status.data}
                notify={notify}
                onPair={() => setPairingOpen(true)}
              />
            ) : (
              <div className="atm-form">
                <p className="atm-row-sub atm-sync-intro">
                  像 RustDesk 一样用你自己的中继服务器；ATM 不内置任何服务器。可以自建
                  atm-relay，也可以填兼容的应用数据服务。内容端到端加密，中继只看得到密文。
                </p>
                <PlaintextSecretNote status={status.data} />
                <SyncConfigForm
                  client={client}
                  status={status.data}
                  notify={notify}
                  mode="enable"
                />
              </div>
            )
          ) : status.error && featureUnavailable(status.error) ? (
            <p className="atm-sync-note">这个 ATM 宿主没有启用手机同步（独立 daemon 或旧版本）。</p>
          ) : status.error && !status.isFetching ? (
            <SectionLoadError
              message="同步状态没能读出来，暂时无法显示或修改。"
              onRetry={() => void status.refetch()}
            />
          ) : (
            <LoadingRows count={3} />
          )}
        </div>
      </section>
      <Presence present={pairingOpen} inertWhenClosing>
        {pairingOpen ? (
          <PairingDialog
            client={client}
            {...(desktop ? { desktop } : {})}
            notify={notify}
            close={() => setPairingOpen(false)}
          />
        ) : null}
      </Presence>
    </>
  );
}

function PlaintextSecretNote({ status }: { status: SyncStatus }) {
  if (status.secretStore !== "plaintext") return null;
  return (
    <p className="atm-sync-note" data-tone="warning">
      开发模式：中继 token 和配对密钥以明文存放在数据目录里（独立 daemon 没有系统加密存储）。
      日常使用请在桌面应用里配置。
    </p>
  );
}

function SyncEnabledView({
  client,
  status,
  notify,
  onPair,
}: {
  client: AyanamiClient;
  status: SyncStatus;
  notify: Notify;
  onPair: () => void;
}) {
  const queryClient = useQueryClient();
  const dialogs = useDialogs();
  const [editing, setEditing] = useState(false);
  const lamp = syncLamp(status);
  const refresh = () => queryClient.invalidateQueries({ queryKey: SYNC_STATUS_QUERY_KEY });
  const disable = useMutation({
    mutationFn: () => client.updateSyncConfig({ enabled: false }),
    onSuccess: async () => {
      await refresh();
      notify("手机同步已停用");
    },
  });
  const reset = useMutation({
    mutationFn: () => client.resetSyncSpace(),
    onSuccess: async () => {
      await refresh();
      notify("配对已重置，旧手机需要重新扫码");
    },
  });
  const confirmReset = async () => {
    const confirmed = await dialogs.confirm({
      title: "重置配对",
      message:
        "会换一把新的配对密钥，并删除中继上这台电脑写过的数据。已配对的手机全部失效，需要重新扫码。",
      confirmLabel: "重置配对",
      tone: "danger",
    });
    if (confirmed) reset.mutate();
  };
  const pending = disable.isPending || reset.isPending;
  const devices = status.paired;
  return (
    <div className="atm-sync-layout">
      <div className="atm-form">
        <PlaintextSecretNote status={status} />
        {lamp.reason ? (
          <div className="atm-inline-error" role="alert">
            同步出错：{lamp.reason}
          </div>
        ) : null}
        <dl className="atm-sync-facts">
          <div>
            <dt>中继</dt>
            <dd title={status.relayUrl ?? undefined}>{relayHost(status.relayUrl)}</dd>
          </div>
          <div>
            <dt>上次同步</dt>
            <dd>{relativeTime(status.lastSyncAt)}</dd>
          </div>
          <div>
            <dt>待处理命令</dt>
            <dd>{status.pendingCommands}</dd>
          </div>
          <div>
            <dt>轮询方式</dt>
            <dd>{pollingLabel(status.longPoll)}</dd>
          </div>
        </dl>
        {editing ? (
          <SyncConfigForm
            client={client}
            status={status}
            notify={notify}
            mode="edit"
            onDone={() => setEditing(false)}
          />
        ) : null}
        <MutationErrorAlert errors={[disable.error, reset.error]} />
        {editing ? null : (
          <div className="atm-sync-form-actions">
            <button
              className="atm-button"
              type="button"
              disabled={pending}
              onClick={() => setEditing(true)}
            >
              连接设置
            </button>
            <button
              className="atm-button"
              type="button"
              disabled={pending}
              onClick={() => disable.mutate()}
            >
              停用同步
            </button>
            <button
              className="atm-button danger"
              type="button"
              disabled={pending}
              onClick={() => void confirmReset()}
            >
              重置配对
            </button>
            <button
              className="atm-button primary"
              type="button"
              disabled={pending}
              onClick={onPair}
            >
              添加手机
            </button>
          </div>
        )}
      </div>
      <div className="atm-sync-devices">
        <div className="atm-sync-subhead">
          <h3>已配对设备</h3>
          <span className="atm-badge">{devices.length}</span>
        </div>
        {devices.length ? (
          <div className="atm-list atm-scroll-list">
            {devices.map((device) => {
              const online = deviceOnline(device);
              return (
                <article className="atm-row" key={device.id}>
                  <div>
                    <div className="atm-row-title" title={device.name}>
                      {device.name}
                    </div>
                    <div className="atm-row-sub">
                      {deviceKindLabel(device.kind)} · 最后在线 {relativeTime(device.at)}
                    </div>
                  </div>
                  <span className={`atm-badge ${online ? "success" : ""}`}>
                    {online ? "在线" : "离线"}
                  </span>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="atm-row-sub atm-sync-empty">
            还没有配对的手机。点「添加手机」，用 ATM 手机 App 扫码。
          </p>
        )}
      </div>
    </div>
  );
}

function relayHost(relayUrl: string | null): string {
  if (!relayUrl) return "未设置";
  try {
    return new URL(relayUrl).host;
  } catch {
    return relayUrl;
  }
}
