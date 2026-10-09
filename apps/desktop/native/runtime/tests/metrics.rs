//! job `metrics.capture` 归入口管（W5h2）：宿主要求时入口开放后把采集的去处登记到服务上，撤下入口时先注销；
//! 不要求（e2e、独立运行时）就不登记，任务操作之后什么都不交。

mod support;

use std::time::Duration;

use atm_runtime::{Background, Started};
use support::*;

#[test]
fn the_entries_register_metrics_capture_only_when_asked() {
    for (name, asked) in [("metrics-on", true), ("metrics-off", false)] {
        let d = dir(name);
        let n = d.join("N");
        let events = Events::default();
        let mut opts = options(&n, &d.join("L-missing"), &events);
        opts.metrics_capture = asked;
        let Started::Serving(s) = atm_runtime::start(&opts).unwrap() else {
            panic!("conflict")
        };
        drop(opts);
        assert_eq!(
            s.background(Duration::from_secs(60)),
            Some(Background::Unchanged)
        );
        let (svc, _) = s.service().unwrap();
        assert_eq!(svc.metrics_sink_registered(), asked, "{name}");
        s.stop(&|_| {});
        assert!(
            !svc.metrics_sink_registered(),
            "withdrawing the entries unregisters it"
        );
    }
}
