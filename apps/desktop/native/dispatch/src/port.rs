//! 接到手机同步连接器上（2.x `packages/sync/src/dispatch-port.ts` 的 `dispatchPortFrom`）：head 里的派单摘要、
//! 任务卡片上的派单状态，与手机命令的入队。

use atm_domain::principal::Principal;
use atm_sync::dispatch::{DispatchPort, DispatchRun, DispatchSummary, EnqueueInput};
use atm_sync::errors::Failure;
use atm_sync_protocol::schema::PERMISSION_MODES;
use serde_json::{Map, Value};

use crate::dispatcher::{Dispatcher, Enqueue};
use crate::errors::Error;

fn run_view(v: &Map<String, Value>) -> DispatchRun {
    let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    DispatchRun {
        run: text("run").unwrap_or_default(),
        state: text("state").unwrap_or_default(),
        at: text("endedAt")
            .or_else(|| text("startedAt"))
            .or_else(|| text("createdAt"))
            .unwrap_or_default(),
        error: text("error").filter(|e| !e.is_empty()),
    }
}

impl DispatchPort for Dispatcher {
    fn summary(&self) -> DispatchSummary {
        let config = self.config();
        DispatchSummary {
            enabled: config.enabled,
            mode: if PERMISSION_MODES.contains(&config.permission_mode.as_str()) {
                config.permission_mode
            } else {
                "auto".into()
            },
            running: self.running() as u64,
        }
    }

    fn run_for_task(&self, project: &str, key: &str) -> Option<DispatchRun> {
        Dispatcher::run_for_task(self, project, key).map(|r| run_view(&r.view()))
    }

    fn enqueue(&self, principal: &Principal, input: EnqueueInput) -> Result<DispatchRun, Failure> {
        Dispatcher::enqueue(
            self,
            principal,
            &Enqueue {
                project: input.project,
                key: input.key,
                mobile: true,
                requested_by: input.requested_by,
                request_id: input.request_id,
            },
        )
        .map(|v| run_view(&v))
        .map_err(|e| match e {
            Error::Dispatch(e) => Failure::Dispatch {
                code: e.code.as_str().to_owned(),
                message: e.message,
            },
            Error::Domain(d) => Failure::Domain(d),
        })
    }
}
