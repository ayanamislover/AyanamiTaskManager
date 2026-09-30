import { useRef } from "react";
import { ArrowClockwiseIcon as ArrowClockwise } from "@phosphor-icons/react/dist/icons/ArrowClockwise";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/dist/icons/CaretRight";
import { CloudSlashIcon as CloudSlash } from "@phosphor-icons/react/dist/icons/CloudSlash";
import { DesktopTowerIcon as DesktopTower } from "@phosphor-icons/react/dist/icons/DesktopTower";
import { FolderSimpleDashedIcon as FolderDashed } from "@phosphor-icons/react/dist/icons/FolderSimpleDashed";
import { GearSixIcon as GearSix } from "@phosphor-icons/react/dist/icons/GearSix";
import { KeyIcon as Key } from "@phosphor-icons/react/dist/icons/Key";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import type { ProjectHead } from "@ayanami-task/sync-protocol";
import { unpair } from "../app-state.js";
import { projectSegments, sortProjects } from "../data/snapshot.js";
import { formatRelative, hostPresence } from "../data/time.js";
import { useEngine, useEngineState, useNow } from "../ui/hooks.js";
import { EmptyState, IconButton, Screen, SectionTitle } from "../ui/layout.js";
import { push } from "../ui/nav.js";
import { staleLabel } from "../ui/offline-note.js";
import { MIN_SPIN_MS, useMinimumDuration, usePullToRefresh } from "../ui/pull-refresh.js";
import { Wordmark } from "../ui/wordmark.js";
import { Outbox } from "./outbox.js";

export function OverviewScreen() {
  const engine = useEngine();
  const state = useEngineState();
  const now = useNow();
  const scrollRef = useRef<HTMLDivElement>(null);
  const indicator = usePullToRefresh(scrollRef, state.refreshing, () => engine.refresh());
  const spinning = useMinimumDuration(state.refreshing, MIN_SPIN_MS);
  const { head } = state.snapshot;
  const fatal = state.phase === "denied" || state.phase === "rekey";

  return (
    <Screen
      className="overview"
      scrollRef={scrollRef}
      overlay={indicator}
      leading={<Wordmark className="topbar-wordmark" />}
      actions={
        <>
          <IconButton label="刷新" busy={spinning} onClick={() => engine.refresh()}>
            <ArrowClockwise size={20} weight="bold" aria-hidden="true" />
          </IconButton>
          <IconButton label="设置" onClick={() => push({ name: "settings" })}>
            <GearSix size={20} weight="bold" aria-hidden="true" />
          </IconButton>
        </>
      }
      footer={
        fatal || !head ? undefined : (
          <button
            type="button"
            className="button primary fab"
            onClick={() => push({ name: "new" })}
          >
            <Plus size={18} weight="bold" aria-hidden="true" />
            新任务
          </button>
        )
      }
    >
      {fatal ? (
        <EmptyState
          tone="danger"
          icon={<Key size={26} weight="duotone" />}
          title={state.phase === "denied" ? "配对已失效" : "需要重新配对"}
          action={
            <button type="button" className="button primary" onClick={() => void unpair()}>
              重新配对
            </button>
          }
        >
          {state.lastError}
        </EmptyState>
      ) : (
        <>
          <HostCard now={now} />
          <Outbox />
          {head ? (
            <ProjectList projects={head.projects} />
          ) : state.snapshot.syncedAt ? (
            <EmptyState icon={<CloudSlash size={26} weight="duotone" />} title="电脑还没有发布数据">
              在电脑 ATM 的「设置 → 手机同步」里确认同步已开启；开启后几秒内这里就会出现项目。
            </EmptyState>
          ) : (
            <div className="skeleton-list" aria-label="正在载入">
              <span className="skeleton" />
              <span className="skeleton" />
              <span className="skeleton" />
            </div>
          )}
        </>
      )}
    </Screen>
  );
}

function HostCard({ now }: { now: number }) {
  const engine = useEngine();
  const state = useEngineState();
  const { head, host, syncedAt } = state.snapshot;
  const presence = hostPresence(host, head, now);
  const hostName = head?.host.name ?? engine.pairing.n ?? "电脑";
  const offline = state.phase === "offline";
  const connecting = state.phase === "connecting" && !syncedAt;

  let headline: string;
  if (connecting) headline = "正在连接中继…";
  // 手机自己连不上中继时，看不到电脑的实时状态：不能沿用缓存里的「在线」。
  else if (offline) headline = "暂时看不到电脑状态";
  else if (presence.online)
    headline = `电脑在线 · ${formatRelative(syncedAt, now) === "刚刚" ? "刚刚同步" : `${formatRelative(syncedAt, now)}同步`}`;
  else if (presence.lastSeen)
    headline = `电脑离线 · 上次在线 ${formatRelative(presence.lastSeen, now)}`;
  else headline = "还没收到电脑的消息";

  // 派单状态只在电脑确实在线时有意义；电脑离线或手机连不上中继时，换成「新任务会怎样」的说明。
  const dispatch = presence.online && !offline ? head?.dispatch : undefined;
  const hostAway = !connecting && !offline && !presence.online;
  return (
    <div className="card host-card" data-online={presence.online && !offline ? "true" : "false"}>
      <div className="host-row">
        <div className="host-copy">
          <strong className="host-status">
            <span
              className="status-dot"
              data-state={
                connecting ? "pending" : presence.online && !offline ? "online" : "offline"
              }
              aria-hidden="true"
            />
            {headline}
          </strong>
          <span className="host-meta">
            <span>{hostName}</span>
            {dispatch ? (
              <span>
                {dispatch.enabled
                  ? dispatch.running > 0
                    ? `派单已开启，运行中 ${dispatch.running}`
                    : "Claude 派单已开启"
                  : "Claude 派单未开启"}
              </span>
            ) : null}
            {hostAway ? <span>新任务会在它上线后处理</span> : null}
          </span>
        </div>
        <DesktopTower className="host-icon" size={22} weight="duotone" aria-hidden="true" />
      </div>
      {offline ? (
        <div className="host-alert" role="status">
          <CloudSlash size={16} weight="bold" aria-hidden="true" />
          <span>
            {state.lastError ?? "连不上中继"}
            {syncedAt ? `。下面是${staleLabel(syncedAt, now)}同步的数据` : ""}
          </span>
          <button type="button" className="text-button" onClick={() => engine.refresh()}>
            重试
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ProjectList({ projects }: { projects: ProjectHead[] }) {
  if (projects.length === 0) {
    return (
      <EmptyState icon={<FolderDashed size={26} weight="duotone" />} title="电脑上还没有项目">
        在电脑 ATM 里建好项目后，会自动同步到这里。
      </EmptyState>
    );
  }
  return (
    <>
      <SectionTitle count={projects.length}>项目</SectionTitle>
      <div className="project-list">
        {sortProjects(projects).map((project) => (
          <ProjectCard key={project.code} project={project} />
        ))}
      </div>
    </>
  );
}

function ProjectCard({ project }: { project: ProjectHead }) {
  const { counts } = project;
  const segments = projectSegments(project);
  // 「等你」「受阻」是例外，只在不为零时出现（并带状态色）；手机一行放不下五组数。
  const stats: Array<{ label: string; value: number; tone?: string }> = [
    // 顺序与下面的彩条一致（完成 / 进行中 / 等你+受阻 / 可开始，同桌面端进度条），数字能对着色段读。
    { label: "完成", value: counts.doneRecent },
    { label: "进行中", value: counts.inProgress },
    ...(counts.waitingUser > 0 ? [{ label: "等你", value: counts.waitingUser, tone: "user" }] : []),
    ...(counts.blocked > 0 ? [{ label: "受阻", value: counts.blocked, tone: "blocked" }] : []),
    { label: "可开始", value: counts.ready },
  ];
  return (
    <button
      type="button"
      className="card project-card"
      onClick={() => push({ name: "project", code: project.code })}
    >
      <span className="project-head">
        <span className="code-chip">{project.code}</span>
        <strong className="project-name">{project.name}</strong>
        <CaretRight className="project-chevron" size={16} weight="bold" aria-hidden="true" />
      </span>
      <span className="project-counts">
        {stats.map((stat, index) => (
          <span key={stat.label} data-tone={stat.tone}>
            {index > 0 ? <i aria-hidden="true">·</i> : null}
            {stat.label} <b>{stat.value}</b>
          </span>
        ))}
      </span>
      <span className="project-bar" aria-hidden="true">
        {segments.length === 0 ? <i data-segment="empty" style={{ flexGrow: 1 }} /> : null}
        {segments.map((segment) => (
          <i key={segment.id} data-segment={segment.id} style={{ flexGrow: segment.value }} />
        ))}
      </span>
    </button>
  );
}
