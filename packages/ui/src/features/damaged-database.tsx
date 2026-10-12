import { PageHead } from "../components/async-state.js";
import type { DataSourceState } from "../contracts.js";

type Damaged = Extract<DataSourceState, { state: "DAMAGED" }>;

/**
 * 已发布的库读不出（W8f-3）：宿主不服务、不动任何文件，等用户退出 ATM 后运行 `atm recover --offline`
 * 从这一代的备份恢复。恢复要独占准入，ATM 开着时会被拒绝，所以第一步是退出。
 */
export function DamagedDatabasePage({
  source,
  copy,
}: {
  source: Damaged;
  copy: (text: string, label: string) => Promise<void>;
}) {
  return (
    <div className="atm-source-choice">
      <PageHead
        title="数据库读不出，需要从备份恢复"
        description="ATM 这次没能打开 3.0 的数据库。为了不丢数据，ATM 没有改动它，也没有新建空库；恢复之前 Agent 暂时连不上。"
      />
      <section className="atm-panel">
        <div className="atm-panel-head">
          <h2>从备份恢复</h2>
        </div>
        <div className="atm-panel-body atm-source-choice-body">
          <ol className="atm-damaged-steps">
            <li>从托盘菜单选「完全退出」，关掉 ATM。恢复时 ATM 不能开着。</li>
            <li>
              打开
              PowerShell（开始菜单搜索「PowerShell」），运行下面这条命令。它会选最近一份可用的整库备份，输入它显示的备份
              ID 确认后开始恢复；当前的数据库整体移进 <code>quarantine</code>
              ，不会删除。备份之后的修改不会回来。
            </li>
            <li>恢复完成后重新打开 ATM。</li>
          </ol>
          <code className="atm-damaged-command">{source.command}</code>
          <div className="atm-actions">
            <button
              className="atm-button primary"
              type="button"
              onClick={() => void copy(source.command, "恢复命令")}
            >
              复制恢复命令
            </button>
          </div>
          <p className="atm-muted atm-damaged-hint">
            命令报告没有可用的备份时，在命令末尾加 <code>--list</code> 可以看每一份备份的问题。
          </p>
          <dl className="atm-source-choice-detail">
            <dt>原因（原文）</dt>
            <dd>{source.reason}</dd>
            <dt>数据目录</dt>
            <dd>{source.dataDir}</dd>
            <dt>数据版本</dt>
            <dd>{source.generation}</dd>
          </dl>
        </div>
      </section>
    </div>
  );
}
