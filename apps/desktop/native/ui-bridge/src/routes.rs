//! 界面路由表（03 C-02 改采、10 R8）：React 界面照旧发 REST 形状的请求，ui-bridge 在进程内按这张常量表分发，
//! 没有兜底。表就是 06 §2 的总表（[`atm_http::rest::ROUTES`]）里处置为 U、U\*、A+U 的路由，例外只有
//! #27：导出改为 User 才能调的 POST（00 C-07、10 R8，客户端随之改）。投影健康面板的 #3、#4 在总表里已是「删」（00 §6）。
//!
//! 守卫：`tests/routes.rs` 核对这张表与总表、与 `packages/client` 实际调用的路径集合（06 T-UI）。

/// 一条界面路由。路径用 2.0 的 `:参数` 写法。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UiRoute {
    pub n: u16,
    pub method: &'static str,
    pub path: &'static str,
}

const fn r(n: u16, method: &'static str, path: &'static str) -> UiRoute {
    UiRoute { n, method, path }
}

/// 方法与总表不同的路由：`(编号, 界面表里的方法)`。
pub const METHOD_CHANGED: &[(u16, &str)] = &[(27, "POST")];

pub const UI_ROUTES: &[UiRoute] = &[
    // 系统、视图、设置
    r(1, "GET", "/api/v1/system/status"),
    r(2, "GET", "/api/v1/overview"),
    r(5, "GET", "/api/v1/saved-views"),
    r(6, "POST", "/api/v1/saved-views"),
    r(8, "DELETE", "/api/v1/saved-views/:id"),
    r(9, "GET", "/api/v1/settings"),
    r(10, "PUT", "/api/v1/settings/:key"),
    // 项目与垃圾箱
    r(11, "GET", "/api/v1/projects"),
    r(12, "GET", "/api/v1/trash/projects"),
    r(13, "POST", "/api/v1/trash/restore-requests/:id/approve"),
    r(14, "POST", "/api/v1/trash/restore-requests/:id/reject"),
    r(15, "POST", "/api/v1/projects"),
    r(18, "GET", "/api/v1/projects/:code/engineering-metrics"),
    r(19, "POST", "/api/v1/projects/:code/archive"),
    r(20, "POST", "/api/v1/projects/:code/restore"),
    r(21, "POST", "/api/v1/projects/:code/trash"),
    // 备份、导入、导出
    r(22, "GET", "/api/v1/backups"),
    r(23, "POST", "/api/v1/backups"),
    r(24, "POST", "/api/v1/backups/:id/restore"),
    r(25, "POST", "/api/v1/imports/agenttask-md/preview"),
    r(26, "POST", "/api/v1/imports/agenttask-md/apply"),
    r(27, "POST", "/api/v1/exports/:projectCode"),
    // 项目读
    r(28, "GET", "/api/v1/projects/:code/objectives"),
    r(29, "GET", "/api/v1/projects/:code/milestones"),
    r(30, "GET", "/api/v1/projects/:code/agents"),
    r(32, "GET", "/api/v1/projects/:code/reconciliation"),
    r(33, "GET", "/api/v1/projects/:code/records"),
    r(36, "GET", "/api/v1/projects/:code/project-updates"),
    r(39, "POST", "/api/v1/projects/:code/project-updates/draft"),
    r(40, "POST", "/api/v1/projects/:code/project-updates"),
    r(41, "GET", "/api/v1/projects/:code/brief"),
    // 知识库
    r(42, "GET", "/api/v1/knowledge/preview-record"),
    r(44, "GET", "/api/v1/knowledge"),
    r(45, "POST", "/api/v1/knowledge"),
    r(47, "PATCH", "/api/v1/knowledge/:id"),
    r(48, "GET", "/api/v1/knowledge/:id"),
    r(49, "GET", "/api/v1/knowledge/:id/history"),
    r(50, "POST", "/api/v1/knowledge/:id/archive"),
    // 任务（界面路由）
    r(53, "POST", "/api/v1/projects/:code/ui/objectives"),
    r(54, "POST", "/api/v1/projects/:code/ui/milestones"),
    r(55, "POST", "/api/v1/projects/:code/ui/work-items"),
    r(56, "POST", "/api/v1/projects/:code/ui/work-items/patch"),
    r(59, "PATCH", "/api/v1/projects/:code/ui/checklist/:id"),
    r(60, "GET", "/api/v1/projects/:code/ui/work-items"),
    r(61, "GET", "/api/v1/projects/:code/ui/progress-strip"),
    r(62, "GET", "/api/v1/projects/:code/ui/work-items/closed"),
    r(63, "GET", "/api/v1/projects/:code/ui/work-items/:taskKey"),
    r(68, "GET", "/api/v1/projects/:code/work-items/:taskKey"),
    r(76, "POST", "/api/v1/projects/:code/ui/records"),
    // 搜索与事件
    r(77, "GET", "/api/v1/projects/:code/search"),
    r(78, "GET", "/api/v1/search"),
    r(79, "GET", "/api/v1/projects/:code/events"),
    // session 与 quick
    r(82, "POST", "/api/v1/sessions/:id/force-close"),
    r(
        83,
        "POST",
        "/api/v1/projects/:code/sessions/:id/git-context/refresh",
    ),
    r(84, "GET", "/api/v1/quick-tasks"),
    r(85, "POST", "/api/v1/quick-tasks"),
    r(86, "PATCH", "/api/v1/quick-tasks/:id"),
    r(87, "POST", "/api/v1/quick-tasks/:id/promote"),
    // 派单与手机同步（W7）
    r(88, "GET", "/api/v1/dispatch/status"),
    r(89, "PUT", "/api/v1/dispatch/config"),
    r(
        90,
        "POST",
        "/api/v1/projects/:code/ui/work-items/:taskKey/dispatch",
    ),
    r(91, "POST", "/api/v1/dispatch/runs/:run/cancel"),
    r(92, "GET", "/api/v1/sync/status"),
    r(93, "PUT", "/api/v1/sync/config"),
    r(94, "POST", "/api/v1/sync/test"),
    r(95, "POST", "/api/v1/sync/pairing"),
    r(96, "POST", "/api/v1/sync/reset"),
    // 项目包与 2.x 备份的导入（W6c，3.0 新增）
    r(110, "GET", "/api/v1/imports/packages"),
    r(111, "POST", "/api/v1/imports/packages/preview"),
    r(112, "POST", "/api/v1/imports/packages/apply"),
];

/// 路径参数：`(名字, 已解码的值)`。
pub type Params = Vec<(&'static str, String)>;

/// 匹配的结果。
#[derive(Debug, PartialEq, Eq)]
pub enum Matched {
    Route(&'static UiRoute, Params),
    /// 路径对得上、方法不对。
    WrongMethod,
    NotFound,
}

/// 按已解码的路径段匹配。字面段比参数段优先（`ui/work-items/closed` 不会落进 `ui/work-items/:taskKey`）。
pub fn find(method: &str, segments: &[String]) -> Matched {
    let mut best: Option<(&'static UiRoute, Params, usize)> = None;
    let mut path_only = false;
    for route in UI_ROUTES {
        let pattern: Vec<&str> = route.path.trim_start_matches('/').split('/').collect();
        if pattern.len() != segments.len() {
            continue;
        }
        let mut params = Vec::new();
        let mut literal = 0;
        let fits = pattern
            .iter()
            .zip(segments)
            .all(|(p, s)| match p.strip_prefix(':') {
                Some(name) => {
                    params.push((name, s.clone()));
                    true
                }
                None => {
                    literal += 1;
                    *p == s
                }
            });
        if !fits {
            continue;
        }
        if route.method != method {
            path_only = true;
            continue;
        }
        if best.as_ref().is_none_or(|(_, _, l)| literal > *l) {
            best = Some((route, params, literal));
        }
    }
    match best {
        Some((route, params, _)) => Matched::Route(route, params),
        None if path_only => Matched::WrongMethod,
        None => Matched::NotFound,
    }
}
