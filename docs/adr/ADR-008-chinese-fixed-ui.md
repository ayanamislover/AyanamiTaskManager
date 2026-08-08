# ADR-008：中文 UI、英文枚举、固定领域字段

状态：Accepted

数据库与 API 使用稳定英文标识，Renderer 必须通过集中映射显示中文，不得裸露内部状态。React、TanStack Query、Zustand 与 Phosphor 沿用 Hub 已验证组合：分别负责声明式界面、服务端缓存/事件失效、短暂 UI 状态与可访问图标；产品事实不写 localStorage。
