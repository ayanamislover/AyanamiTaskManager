//! job `maintenance` 归入口管（W5h）：宿主要求时入口开放后 2.5 s 跑第一轮（DAILY + WEEKLY），撤下入口时先停；
//! 不要求（e2e、独立运行时）就不起。

mod support;

use std::time::{Duration, Instant};

use atm_runtime::{Background, Started};
use support::*;

fn backups(s: &atm_runtime::Serving) -> i64 {
    let (svc, _) = s.service().unwrap();
    svc.store()
        .read(|tx| tx.query_row("SELECT count(*) FROM backups", [], |r| r.get(0)))
        .unwrap()
}

#[test]
fn the_entries_run_maintenance_only_when_asked() {
    for (name, asked) in [("maint-on", true), ("maint-off", false)] {
        let d = dir(name);
        let n = d.join("N");
        let events = Events::default();
        let mut opts = options(&n, &d.join("L-missing"), &events);
        opts.maintenance = asked;
        let Started::Serving(s) = atm_runtime::start(&opts).unwrap() else {
            panic!("conflict")
        };
        drop(opts);
        assert_eq!(
            s.background(Duration::from_secs(60)),
            Some(Background::Unchanged)
        );
        let deadline = Instant::now() + Duration::from_secs(if asked { 30 } else { 5 });
        while backups(&s) < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        if asked {
            assert_eq!(backups(&s), 2, "the first round makes a DAILY and a WEEKLY");
            assert!(
                n.join("backups").read_dir().unwrap().count() >= 2,
                "backups live under N\\backups"
            );
        } else {
            assert_eq!(backups(&s), 0);
        }
        let t = Instant::now();
        s.stop(&|_| {});
        assert!(t.elapsed() < Duration::from_secs(20));
    }
}
