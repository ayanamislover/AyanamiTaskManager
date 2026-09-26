-- Agent 在垃圾箱项目的目录里 begin 时登记的恢复请求（ATM-T-0493）。
-- Agent 不能自己恢复项目，只能留下请求；用户在项目页垃圾箱里点「授权恢复」或「拒绝」。
-- 同一项目同时只有一条 PENDING：同一个请求被反复触发只累加 request_count。
CREATE TABLE project_restore_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  source_cwd TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  request_count INTEGER NOT NULL DEFAULT 1 CHECK(request_count >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  CHECK((status = 'PENDING') = (decided_at IS NULL)),
  CHECK((status = 'PENDING') = (decided_by IS NULL))
);

CREATE UNIQUE INDEX idx_project_restore_requests_pending
ON project_restore_requests(project_id)
WHERE status = 'PENDING';

CREATE INDEX idx_project_restore_requests_project
ON project_restore_requests(project_id, created_at);
