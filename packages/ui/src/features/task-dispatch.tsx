import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { MutationErrorAlert } from "../components/async-state.js";
import type { Notify } from "../contracts.js";
import {
  dispatchFailureReason,
  dispatchRefetchInterval,
  DISPATCH_STATUS_QUERY_KEY,
  dispatchStateLabels,
  dispatchStateTone,
  featureUnavailable,
  isActiveRun,
  latestRunFor,
  taskAcceptsDispatch,
  type DispatchableTask,
} from "./mobile-sync-support.js";

/**
 * 抽屉的状态行与操作行共用同一份派单状态（和设置页同一个 query key）。
 * 派单接口读不到（宿主没启用、daemon 旧版本）时不重试，两处都什么都不画。
 */
function useDispatchStatus(client: AyanamiClient) {
  return useQuery({
    queryKey: DISPATCH_STATUS_QUERY_KEY,
    queryFn: () => client.getDispatchStatus(),
    refetchInterval: (query) =>
      featureUnavailable(query.state.error) ? false : dispatchRefetchInterval(query.state.data),
    retry: false,
  });
}

/**
 * 状态行里的「Claude 进行中」之类：这个任务派过单才出现，显示最近一次。
 * 失败时紧跟一句原因（例如 claude 登录过期），用次要文字，放不下就折到下一行。
 */
export function TaskDispatchBadge({
  client,
  project,
  taskKey,
}: {
  client: AyanamiClient;
  project: string;
  taskKey: string;
}) {
  const status = useDispatchStatus(client);
  const run = status.data ? latestRunFor(status.data.runs, project, taskKey) : null;
  if (!run) return null;
  const reason = dispatchFailureReason(run);
  return (
    <>
      <span
        className={`atm-badge ${dispatchStateTone(run.state)}`}
        data-testid="task-dispatch-state"
      >
        Claude {dispatchStateLabels[run.state] ?? run.state}
      </span>
      {reason ? (
        <span className="atm-row-sub atm-task-dispatch-reason" title={reason}>
          {reason}
        </span>
      ) : null}
    </>
  );
}

/**
 * 操作行里的「交给 Claude」：派单开启、任务是 READY / BACKLOG、没有有效领取，
 * 且这个任务没有排队或运行中的派单时才给按钮。
 */
export function TaskDispatchButton({
  client,
  project,
  taskKey,
  task,
  notify,
}: {
  client: AyanamiClient;
  project: string;
  taskKey: string;
  task: DispatchableTask;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const status = useDispatchStatus(client);
  const dispatch = useMutation({
    mutationFn: () => client.dispatchTask(project, taskKey),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: DISPATCH_STATUS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ["task", project, taskKey] }),
      ]);
      notify(`${taskKey} 已交给 Claude`);
    },
  });
  if (!status.data) return null;
  const run = latestRunFor(status.data.runs, project, taskKey);
  const eligible =
    status.data.enabled && taskAcceptsDispatch(task) && !(run !== null && isActiveRun(run));
  return (
    <>
      {eligible ? (
        <button
          className="atm-button"
          type="button"
          disabled={dispatch.isPending}
          onClick={() => dispatch.mutate()}
        >
          {dispatch.isPending ? "正在交给 Claude" : "交给 Claude"}
        </button>
      ) : null}
      {/* 在操作行里独占一整行：派单被拒的原因（未开启、项目没绑定路径、已有人领取……）要看得见。 */}
      <MutationErrorAlert
        error={dispatch.error}
        prefix="交给 Claude 失败："
        className="atm-task-dispatch-error"
      />
    </>
  );
}
