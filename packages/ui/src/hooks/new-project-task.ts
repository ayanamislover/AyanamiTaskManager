/**
 * 「在这个项目里新建任务」的全局命令（Ctrl+N、顶栏「新建任务」）。
 *
 * 事件带上目标项目：切项目的等待窗口里，前台还是旧项目页、后台是正在准备的新项目页，
 * 只有目标那一页该响应。以前事件不带项目，结果打开的是旧项目的弹窗，新页一换上就跟着
 * 旧页一起被卸载；从总览切过来时则谁都不响应，操作直接丢了。
 */
export const NEW_PROJECT_TASK_EVENT = "atm:new-project-task";

export type NewProjectTaskDetail = { project: string };

export function requestNewProjectTask(project: string): void {
  window.dispatchEvent(
    new CustomEvent<NewProjectTaskDetail>(NEW_PROJECT_TASK_EVENT, { detail: { project } }),
  );
}

/** 这条命令是不是发给 project 的。 */
export function isNewProjectTaskFor(event: Event, project: string): boolean {
  return (event as CustomEvent<Partial<NewProjectTaskDetail>>).detail?.project === project;
}
