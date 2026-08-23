# LinguaGacha 架构边界

本文只记录进程拓扑、跨层依赖和运行时主链路。命令、后端协议、前端运行态与验证流程分别进入对应专题文档；产品语义和视觉权威不在这里展开。

## 1. 专题地图

| 问题                                                                  | 唯一归宿                     |
| --------------------------------------------------------------------- | ---------------------------- |
| 系统分层、进程拓扑、跨层边界、运行时主链路                            | 本文                         |
| CLI 入口、命令、临时工程、资源、输出、平台启动器                      | [`CLI.md`](CLI.md)           |
| 后端 API / SSE、状态、任务、数据库、`.lg` 存储                        | [`BACKEND.md`](BACKEND.md)   |
| Electron / preload / renderer、共享运行态、页面 query、导航、样式消费 | [`FRONTEND.md`](FRONTEND.md) |
| 阅读路径、验证矩阵、文档同步和交付自检                                | [`WORKFLOW.md`](WORKFLOW.md) |

## 2. 运行时拓扑

- `src/index.ts` 是唯一产品入口，只按显式 `--cli` 分发 GUI 或 CLI；入口层只解析应用根、桌面 bundle 根和 `BackendWorkerExecution`，不持有业务服务、命令协议或窗口状态。
- GUI 与后端能力层同在 Electron 主进程，当前没有独立 backend 子进程或 database HTTP 服务。
- GUI 与 CLI 都通过 `BackendBootstrap` 组装同一 `BackendServices`；GUI 开启本机 Gateway，CLI 关闭 Gateway 并直接消费服务与同进程事件流。
- 发布态后端 worker 由产品入口配置为 `worker_threads`；`in_process` 只允许测试或源码运行显式选择，不作为失败回退。
- `BackendServices` 是 Gateway、CLI job 与任务引擎共用的组合根，运行期服务只在这里装配。
- FE 大数据链路使用四条互不复用执行队列的 worker 通道：扫描/应用、普通与精简导出、预览索引维护和预览只读查询。取消或重建任一通道的 worker 不得终止其他 FE 通道或通用校对任务。

```mermaid
flowchart LR
    I["src/index.ts"] --> G["GUI 入口"]
    I --> C["CLI 入口"]
    G --> BG["BackendBootstrap + Gateway"]
    C --> BC["BackendBootstrap，无 Gateway"]
    BG --> S["BackendServices"]
    BC --> S
    S --> E["TaskEngine"]
    E --> W["worker_threads"]
    BG --> R["preload / renderer"]
```

## 3. 跨层依赖

- `src/domain` 只承载跨层实体、值对象、合法值集合和贴身判断规则，不反向依赖 backend、frontend 或 Electron。
- `src/shared` 承载可复用的纯规则、协议词表、reader 与无状态工具，不依赖 React、DOM、Electron、Node FS、SQLite、服务单例或可变全局状态。
- `src/native` 收口真实磁盘 IO、路径身份和平台路径策略；backend 与 worker 不绕过它处理平台差异。
- `src/backend` 拥有项目事实、任务执行、数据库和出站模型请求，不依赖 renderer。
- `src/gui` 是 Electron 宿主、IPC、preload、窗口和外链策略边界；renderer 只通过 `window.desktopApp` 与后端 API 接触宿主和后端能力。
- `src/frontend` 只消费宿主契约、后端公开协议、`src/domain` 与 `src/shared`，不导入 backend 或 native 实现。

## 4. 更新条件

只有进程拓扑、产品入口分发、Bootstrap / Gateway 关系、worker 执行方式或跨层依赖方向变化时更新本文；命令、协议、状态、存储、页面或验证细节只更新对应专题文档。

## 5. Fate/Extra 定制边界

- `src/shared/fate-extra` 保存无状态的索引解析、元数据协议和 PSP 布局规则，可由后端、校对器和 renderer 共同使用。
- `src/backend/toolbox/fate-extra-service.ts` 只编排 FE job、项目身份和结果发布；外置分类 SQLite 始终以只读方式打开。扫描/应用 worker 流式解析输入并把序列化条目、资产、问题和指纹写入临时 staging SQLite，主进程只持有有期限的小型 draft handle；FE 导出 worker 对普通工程 items 或精简工程物理映射使用主键游标分页，生成完整暂存结果和去重字库 corpus，主进程不接收百万行 payload。
- `src/backend/toolbox/fate-extra-font-service.ts` 负责语料收集与 helper 进程边界。字库生成器只读内置基线并写入用户选定的导出目录，不修改 `.lg` 条目。
- FE 项目状态继续存放在现有 `meta` 和 `extra_field` 中，不增加 `text_type`。普通项目不会进入 FE 提示、校对、预览或导出路径。
- 索引维护 worker 分批构建非活动 generation；预览只读查询 worker 只读已发布 generation，并以终止并重建专用 worker 的方式中断同步 SQLite 查询。两者都不持有 renderer、session cache 或业务写状态。
- FE worker 只能访问任务载荷显式授予的工程或 staging 路径。主进程仍拥有 project epoch/revision 校验、`ProjectOperationGate`、`ProjectWriteStore` 和 committed event；应用 worker 仅在已取得独占写租约后执行单事务导入，pending manifest 与事务内 durable receipt 为硬崩溃恢复提供提交判据；索引 worker 只能构建并完成非活动 generation，active meta 由主进程复核身份后经 `ProjectDatabase` 短事务切换，任何 worker 都不得自行激活索引或发布项目事件。
- 扫描/应用、FE 导出、索引、查询、通用 backend task 和字库 helper 的生命周期相互隔离；取消、崩溃或身份变化只能清理本通道的未发布状态，不能损坏旧完整工程、旧完整导出结果或旧完整索引。
