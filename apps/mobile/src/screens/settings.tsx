import { useId, useState, type ReactNode } from "react";
import { LockKeyIcon as LockKey } from "@phosphor-icons/react/dist/icons/LockKey";
import { APP_VERSION, renameDevice, unpair } from "../app-state.js";
import { relayLabel } from "../data/pairing-input.js";
import { formatRelative } from "../data/time.js";
import { ConfirmSheet, Segmented } from "../ui/controls.js";
import { useEngine, useEngineState, useNow } from "../ui/hooks.js";
import { Screen } from "../ui/layout.js";
import { setThemePreference, useThemePreference, type ThemePreference } from "../ui/theme.js";

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export function SettingsScreen() {
  const engine = useEngine();
  const state = useEngineState();
  const now = useNow();
  const theme = useThemePreference();
  const pairing = engine.pairing;
  const [name, setName] = useState(pairing.deviceName);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const hostName = state.snapshot.head?.host.name ?? pairing.n;
  const saveName = () => {
    if (name.trim() && name.trim() !== pairing.deviceName) void renameDevice(name);
    else setName(pairing.deviceName);
  };

  return (
    <Screen title="设置">
      <section className="settings-group">
        <h2>连接</h2>
        <div className="card settings-card">
          <Row label="电脑" value={hostName} />
          <Row label="中继" value={<span className="mono">{relayLabel(pairing.u)}</span>} />
          <Row label="同步方式" value={state.longPoll ? "长轮询（即时）" : "每 3 秒查询一次"} />
          <Row label="上次同步" value={formatRelative(state.snapshot.syncedAt, now)} />
        </div>
        <p className="settings-note">
          <LockKey size={14} weight="bold" aria-hidden="true" />
          内容端到端加密，中继只看得到密文。配对信息保存在这台手机的 Android Keystore 里。
        </p>
      </section>

      <section className="settings-group">
        <h2>本机</h2>
        <div className="field">
          <label htmlFor={nameId}>设备名</label>
          <div className="input-shell field-shell">
            <input
              id={nameId}
              value={name}
              maxLength={64}
              enterKeyHint="done"
              onChange={(event) => setName(event.target.value)}
              onBlur={saveName}
              onKeyDown={(event) => {
                if (event.key === "Enter") (event.target as HTMLInputElement).blur();
              }}
            />
          </div>
          <small className="field-help">电脑的「手机同步」里会用这个名字显示这台手机。</small>
        </div>
      </section>

      <section className="settings-group">
        <h2>外观</h2>
        <Segmented
          label="主题"
          value={theme}
          options={THEME_OPTIONS}
          onChange={setThemePreference}
        />
      </section>

      <section className="settings-group">
        <h2>配对</h2>
        <button type="button" className="button danger block" onClick={() => setConfirming(true)}>
          解除配对
        </button>
      </section>

      <footer className="settings-footer">
        <span>ATM 任务 {APP_VERSION}</span>
        <span className="mono">{pairing.deviceId}</span>
      </footer>

      <ConfirmSheet
        open={confirming}
        title="解除与这台电脑的配对？"
        confirmLabel="解除配对"
        tone="danger"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setBusy(true);
          void unpair().finally(() => setBusy(false));
        }}
      >
        <p>
          会删除这台手机上保存的中继 token、空间密钥和缓存的任务。电脑上的数据不受影响；
          之后要再用，需要在电脑上重新显示配对码扫一次。
        </p>
      </ConfirmSheet>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
      <span className="settings-value">{value}</span>
    </div>
  );
}
