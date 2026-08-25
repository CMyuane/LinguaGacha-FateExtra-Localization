# LinguaGacha 后端权威边界

本文统一承载后端公开协议、状态拥有者、项目写入、任务运行态、数据库与 `.lg` 物理存储规则。字段级细节、完整 schema 和局部算法留在代码与测试中。

## 1. 公开协议

- `ApiGatewayServer` 是 Electron 运行态公开 `/api/*` 的唯一装配点；路由只消费 `BackendServices`，不自行组装业务依赖。
- 普通 loaded-project query / write 从 `ProjectSessionState` 取得目标工程；create、open、preview 和打开前 settings alignment 是可以接收显式路径的生命周期例外。
- Gateway 只监听本机地址，CORS 只允许 `Content-Type`，renderer 不依赖额外私有请求头。
- 成功响应为 `{ ok: true, data }`，失败响应为 `{ ok: false, error }`；公开错误不包含 diagnostic context、cause、stack 或供应商原始异常。
- 公开 SSE topic 固定为 `project.data_changed`、`task.snapshot_changed`、`settings.changed`、`log.appended`，data 使用严格 JSON 序列化。
- `log.appended` 只携带轻量预览；完整记录按日志目标落盘，`/api/logs/detail` 只查询当前进程详情池且不回扫历史文件。
- `/api/diagnostics/renderer-error` 只接收实际 renderer 异常摘要与白名单上下文并写入 `LogManager`，不改变项目、任务或设置事实。

## 2. 状态拥有者

| 状态 / 事实                                             | 拥有者                                          | 唯一写入口 / 读出口                                       |
| ------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| 应用设置、最近工程、语言                                | `AppSettingService`                             | 设置 API、CLI transient overrides、`settings.changed`     |
| loaded 工程身份                                         | `ProjectSessionState`                           | `ProjectLifecycleService`                                 |
| loaded 工程热读数据                                     | `CacheManager`                                  | 工程热机、committed event、功能 query                     |
| 运行态项目事实                                          | `ProjectWriteStore` / `ProjectWriteCoordinator` | database transaction、内部 event、按需公开 change         |
| 后端内部 committed event                                | `ProjectEventBus`                               | 写侧事务成功后的 after-commit 发布                        |
| 公开项目变更                                            | `ProjectChangePublisher`                        | 同一 canonical event 进入 SSE 与 HTTP `changes`           |
| 任务类型、scope、status、busy、`run_revision`、请求压力 | `TaskRunState` / `TaskRunPublisher`             | 任务命令与 Engine 生命周期                                |
| 任务 progress / extras                                  | `.lg` meta                                      | `ProjectTaskStore` 经 `ProjectWriteStore` 写入            |
| 任务公开快照                                            | `TaskSnapshotBuilder`                           | 组合内存运行态与 `.lg` meta                               |
| FE scan / scan-apply / preview-index job                | `FateExtraJobCoordinator`                       | job API、隔离 worker 通道                                 |
| FE scan draft                                           | 有期限的 staging SQLite + 小型 handle           | 扫描 worker 创建、FE coordinator 清理                     |
| FE 预览派生索引                                         | `.lg` 内 generation 化索引表                    | `FateExtraIndexCoordinator` / 索引维护 worker             |
| `.lg` 物理 workflow                                     | `ProjectDatabase`                               | `DatabaseOperation`、`execute()`、`execute_transaction()` |
| 平台 IO 与路径身份                                      | `NativeFs` / `NativePathPolicy`                 | `src/native`                                              |
| 后端日志                                                | `LogManager`                                    | 文件日志、轻量 SSE、当前进程详情池                        |

`ProjectOperationGate` 保护会改变任务输入集合或需要慢准备的结构性项目操作；准备与最终提交必须持有同一 gate lease，避免检查通过后被任务启动插入。

## 3. 项目读取与写入

项目数据 section 固定为：

```text
project, files, items, quality, prompts, analysis, proofreading
```

- `/api/session/project/manifest` 只返回项目身份、revision 索引和 counts，不预热大 section。
- 功能 query 返回其结果依赖的 `sectionRevisions`，用户写入和任务命令以这些 revision 做乐观锁；`projectRevision` 只是所有 section revision 的最大值，不是独立全序或可写锁。
- `CacheManager` 是当前 session 的热读缓存根；query 只组合 cache、按需数据库读取和 shared 纯规则，不建立第二套项目事实。
- item 热机分为普通工程、精简 FE 和完整 FE 三态：普通工程与精简 FE 缓存可编辑 `items`，其中精简 FE 只包含去重代表项；完整 FE 只保留逻辑计数，不把近百万物理条目装入主进程。`ItemCache` 同步维护状态与文件摘要，工作台热查询不得复制完整 item 数组；renderer 的通用 FE `items` section 仍保持轻量。
- 工作台翻译统计只认当前 item `status`；非空 `dst` 可能是精简工程的日文占位，`translation_extras` 可能是任务历史进度，两者都不能替代状态事实。状态写入在 revision 一致时以缓存摘要纠正行数进度，不一致时回到数据库聚合，不在项目打开阶段主动写回派生进度。
- `QualityStatisticsCache` 的身份由规则和实际文本依赖决定；`items` 变化只在能证明文本源范围时局部失效，否则全量失效。
- 客户端只提交用户意图、设置镜像和 revision 依赖；canonical items、task extras、prefilter 结果和 analysis 结果由后端计算。
- 需要乐观锁的用户写入在最终提交点完成 revision guard 与单 `.lg` 事务；任务 artifact 等内部写入可以不带预期 revision，但仍通过 `ProjectWriteStore` 更新事实和 section revision。
- settings-only alignment 只发布内部 committed event，不发布公开 project change；仅持久化任务 progress 的写入走 task snapshot 通道，不制造项目变更事件。
- 项目事实事务提交后才发布内部 committed event。未捕获的 handler 失败不会回滚已提交事务，但会令请求失败并阻止公开 change；`CacheManager` 自身的维护失败会标记为可恢复并由后续 query 重建，不阻断其它成功 handler。
- HTTP `changes` 与 SSE 使用同一 canonical `ProjectChangeEvent`，消费者不得依赖两条通道的网络到达顺序。
- 公开事件绑定后端确认的 `projectPath`、`projectRevision`、`sectionRevisions` 与 `updatedSections`；payload mode 只允许 `canonical-delta`、`field-patch`、`section-invalidated`。
- 全量替换、排序或无法精确表达受影响行的写入使用 `section-invalidated`；只有能完整表达受影响行和删除 tombstone 的小范围变化才发布行级增量。
- create / load / migration / 默认预设初始化与 CLI bootstrap 资源属于生命周期或初始化写入；若它们改变 query 可见事实，必须在同一事务更新对应 revision meta。

## 4. 任务、worker 与 LLM

- `TaskService` 负责命令 JSON 收窄、task / mode / scope 归一、section revision 校验、gate 接入和 Engine 命令转交；激活模型由 `TaskEngine` 在每轮 run 开始时解析并冻结到运行上下文。
- 启动任务必须携带任务定义声明的 `expected_section_revisions`；通过 gate 后立即进入 busy，Engine 启动失败时恢复前置状态。
- 所有任务命令 ack 都通过 `TaskSnapshotBuilder` 重新组合当前事实，避免旧命令意图覆盖更晚的终态。
- `TaskSnapshot` 由内存中的类型、scope、status、busy、`run_revision`、请求压力与 `.lg` 中的 progress / extras 组成；`run_revision` 是前端丢弃旧 snapshot 的排序依据。
- 生命周期和进度提交立即发布完整 `task.snapshot_changed`；只有请求压力允许合并，终态前必须冲刷。请求压力只表示已租约发出的 LLM 请求，不表示队列或 worker 数量。
- `TaskEngine` 拥有全局运行锁、执行编排和 artifact commit；全量翻译与分析经过 Planner，行级重翻直接从目标 items 构造 context，三者共享同一执行与提交边界。
- work-unit worker 负责提示词构建、runner、pipeline 和响应处理；planning worker 只承担规划期计算。线程数不等于 LLM 并发，实际并发由模型 key lease 与 limiter 决定。
- 非 engine 的重型计算通过 `BackendWorkerClient` 提交 worker task；普通 task 保持无状态且不读写数据库。FE 扫描/应用、普通与精简导出、索引维护和预览查询是受控例外，只能访问任务载荷显式授予的工程或 staging 路径，不持有项目 cache、不发布事件；主进程仍拥有 gate、revision 校验、唯一业务写入口和 after-commit 发布。
- provider policy、request policy、SDK transport 和结果归一归 `src/backend/llm`，任务层不解析供应商异常文本。

## 5. 数据库与 `.lg` 存储

- `ProjectDatabase` 是 `.lg` workflow 的唯一入口；上层发送严格 JSON 的 `DatabaseOperation`，不持有 SQLite 连接。
- `execute()` 处理单操作，`execute_transaction()` 处理同一 `.lg` 内的批量操作；事务不跨文件，`createProject` 失败时关闭并移除刚创建的文件。
- 运行期使用 WAL；长任务通过 project lease 保留连接，普通 workflow 结束且无租约时统一 checkpoint 并关闭连接，不手动删除 `-wal` / `-shm`。
- asset 存在 `assets` 表，以 Zstd blob 落库；压缩格式集中在 `src/shared/utils/zstd-tool.ts`，数据库读取向上返回解压后的 bytes。
- `schema_version` 只描述物理表结构，业务写回迁移单独记账；完整表与 migration 清单以 migration registry 和 schema migration 代码为准。
- 启动期迁移先处理 userdata / resource 落点，再读取设置；项目迁移在 `.lg` 首次打开时先补 schema，再执行幂等写回迁移。

## 6. 更新条件

公开路由、响应壳、错误载荷、SSE、状态所有权、写入/失败语义、任务快照、worker / LLM 边界、数据库 workflow、migration 或 `.lg` 物理格式变化时更新本文；前端消费方式只更新 [`FRONTEND.md`](FRONTEND.md)。

## 7. Fate/Extra API 与事务语义

FE 百宝箱公开以下项目 API：

```text
POST /api/toolbox/fate-extra/scan
POST /api/toolbox/fate-extra/apply
POST /api/toolbox/fate-extra/jobs/status
POST /api/toolbox/fate-extra/jobs/cancel
POST /api/toolbox/fate-extra/font/scan
POST /api/toolbox/fate-extra/font/sync
POST /api/toolbox/fate-extra/export
POST /api/toolbox/fate-extra/index/rebuild
```

`scan`、`apply` 与 `index/rebuild` 快速返回统一 job snapshot，运行态不借用翻译任务或通用 worker 队列：

```ts
type FateExtraJobSnapshot = {
  job_id: string;
  kind: "scan" | "scan-apply" | "preview-index";
  status: "queued" | "running" | "cancelling" | "succeeded" | "cancelled" | "failed";
  phase: string;
  completed: number;
  total: number | null;
  project_epoch: number;
  source_revision: number;
  cancellable: boolean;
  result?: ApiJsonValue;
  error?: ApiErrorPayload;
};
```

`jobs/status` 读取权威快照，`jobs/cancel` 只发出幂等取消请求；取消是正常终态，不包装为 500。相同项目、kind 和源 identity 的索引启动合并为同一 job；成功索引在数据库 identity 仍就绪时继续返回原完成快照，失败、取消或 identity 变化才允许重建。job 终态必须核对 `project_epoch` 和源 revision，迟到结果不得覆盖新工程状态。`scan-apply` 失败时只有 `error.details.scan_draft_retryable === true` 明确保留 staging 重试资格，字段缺失或为 `false` 时前端不得继续使用旧 `scan_id`。

### 7.1 扫描 staging 与唯一写入口

扫描 worker 流式读取六份索引原稿、旧译文、完整日文主库和外置只读分类 SQLite，不用整文件 `split`，也不向主进程传递近百万对象。序列化 items、assets、迁移问题、计数、去重字库 corpus 和输入指纹写入带版本号的临时 staging SQLite。主进程只保留 `scan_id`、project epoch/revisions、输入 SHA-256/size/mtime、staging 路径、状态、摘要与过期时间组成的 handle。

每个 loaded project 至多一个 draft；新扫描先取消并清理旧 draft，ready draft 默认 30 分钟过期。取消、输入失效、成功应用、工程卸载、backend dispose 和启动时发现的残留都必须删除 staging。精简工程已经拥有另一套代表项与物理映射事实，scan/apply 入口必须在取消旧任务或清理 draft 前拒绝它，不能把全量扫描结果写入仍带 compact 身份的工程。瞬时写入失败可以在 TTL 内重试，输入或 revision 前置条件失效则立即销毁 draft。

`apply` 仍由 `ProjectWriteStore` 作为唯一业务写入口，并先通过 `ProjectOperationGate` 取得独占写租约。主进程复核 project identity、section revisions 与输入指纹后，应用 worker 才能在一个 SQLite 事务中从 staging 批量导入；中止 worker 必须触发回滚。事务提交后由 `ProjectWriteStore` 更新 files/items/analysis/proofreading revisions 并发布 canonical change，失败或取消不得发布半成品事件。worker 在创建全量备份前写入带 UUID token 的 pending manifest，并把同 token durable receipt 放入提交事务；项目重新打开时只在路径身份、manifest 与 receipt 三者一致时保留已提交备份，旧 receipt 未变化时删除未提交备份和报告临时文件，损坏或歧义状态一律保守保留。

`font/sync` 和 `export` 以独立 helper 处理 CPU/IO 密集字库生成。普通 FE QA 警告不阻止
导出；字库同步失败、编码槽耗尽、索引结构损坏和输出不可写属于系统错误。项目元数据
只记录语料、manifest 哈希及剩余槽数，不把分类数据库、译文或字体生成临时目录写入
`.lg`。

精简工程使用 `POST /api/toolbox/fate-extra/compact/create` 创建新项目文件。数据库层在单事务中复制项目配置与资源、建立精确原文组和完整物理映射，只把有效代表条目写入普通 `items`。每个 `fate_extra_compact_source` 以 `representative_translation_authoritative` 记录组级初翻所有权：初建值 `0` 继续优先复现非空物理原初翻，物理值为空才回退代表 `dst`；工作台、重翻或校对链路实际写入代表 `dst` 后，`ProjectWriteStore` 在同一事实事务中把目标组置为 `1`，此后整组 machine layer 使用当前代表 `dst`。只改状态、重试、最终校对稿或显示模式不改变标记；最终校对稿仍高于 machine layer，导出的单物理位置覆盖继续保持既有最高优先级。schema 9 的一次性写回只遍历代表组，并通过 item 与代表 occurrence 主键比较创建基线，不扫描完整物理映射。

普通与精简工程共用专用 FE 导出 worker：普通工程按 item 主键分页，精简工程按 `original_item_id` 主键分页；精简预览、搜索冷建/增量刷新、上下文和导出统一消费上述 machine layer 规则。输出文件各只打开一次并按页批量流写，去重字库 corpus 和 helper 构建也留在 worker。精简工程的分类 SQLite 先生成一致性快照，并在完成前以第二份逻辑快照复核主库/WAL 的有效内容。JSON、CSV、安全清单与路线文件全部先进入同一暂存目录，复核 items/proofreading revisions 后才发布。精简目录整体切换并保留可回滚旧版本；普通目录只替换本次拥有的文件，以逐文件备份和逆序回滚保留无关内容。冲突、writer 或发布失败必须恢复旧结果、清理临时输出且不更新 adapter meta。

翻译重置按普通、精简 FE 和未物化 FE 三种工程模式分流。普通工程保留资源重解析；精简 FE 只在 `ProjectWriteStore` 的单事务中重置代表 `items`，不读取物理资源或映射，并保留 item 身份、原文、文件/行位置、FE 元数据、物理映射、覆盖记录、显示模式和最终校对稿。其初翻恢复为原文占位，状态/重试清零后重新应用预过滤。失败项重置只作用于 `ERROR` 代表项；未物化 FE 明确返回 `project.compact_required`，不尝试解析百万物理位置。

### 7.2 Generation 索引与预览查询

工程 schema 9 创建组级译文所有权列及可删除、可重建的搜索与导航 generation 结构，打开旧普通、FE 或精简项目时不得同步重建近百万行。派生格式版本与 adapter、items revision 共同组成索引身份；旧格式只进入 `updating` 并异步重建，不能被后续增量写入认证。导航结构预计算过滤后的唯一代表项、物理位置、文件内位置、补漏去重顺序和文件摘要：标准 FE 逐物理 item 排除精确状态 `EXCLUDED`，重复组改用 ID 最小的未排除成员并重算出现数；精简 FE 的代表 item 被排除时隐藏整组。查询以 `position >= ?` 做范围读取，不用 `LIMIT/OFFSET` 或重复聚合计数。`FateExtraIndexCoordinator` 令维护 worker 构建非活动 generation；身份变化时，替代任务必须等待旧 worker 终止和 inactive cleanup 退出，防止旧 cleanup 删除新 generation。worker 返回后，`FateExtraService` 复核 project epoch、items revision 与 adapter 原值，再以短事务同时切换导航和搜索 active meta。构建 worker 不具备激活权限，取消、崩溃或身份变化只清理非活动 generation。

FE 搜索索引由去重搜索文档和整数物理位置映射组成，映射只覆盖导航 generation 的可见集合。`src`、`dst`、`proofread` 分字段建文档，文件路径独立建文档；共享规范化只做现有大小写折叠，不 trim、不做 Unicode 归一化。按 Unicode code point 为 1 字符建立 unigram、2 字符建立 bigram、3 字符以上建立 FTS5 trigram 候选，候选再以精确 `includes` 复核。三字以上查询先物化 FTS 命中 rowid，再以文档主键复核 generation 和原子串，禁止让 SQLite 反向遍历全部 generation 文档。文本、文件和分类筛选的 COUNT、分页、上一条、下一条和序号跳转都从派生索引读取，不得对 `items.data` 或 `filtered_item` JSON 执行 `LOWER/LIKE` 全表扫描。四类布局/编码 warning 不能用 JSON SQL 近似：专用只读 worker 在相同可见 generation 中按物理主键游标精确计算 occurrence warning，并以 project epoch、搜索/导航 generation、revision 和筛选身份缓存数字 ID/unit 映射；上下文投影也只返回未排除成员。主进程只接收命中页，翻页不重复扫描或物化百万 item 对象。

项目写入后，`dst` / `proofread` 变化增量更新搜索文档，导航 generation 保持不变并只推进应用 revision；`src`、文件路径、分类或跨入/离开 `EXCLUDED` 会把派生索引标为 dirty。可见性变化不得推进旧 generation，查询立即返回空的 `updating` 状态，由维护 worker 后台重建。revision 落后时不得回退主线程全表扫描。`/api/toolbox/fate-extra/items` 以零基 `position` 接受分页位置；响应携带 `query_id`、`index_generation`、`applied_items_revision`、`navigation_generation`、`applied_navigation_revision` 和两种 state，使客户端能丢弃旧 query 或旧 generation。

预览只读查询通道实行 latest-wins：每个页面通道最多一个 active 和一个 latest pending；取消正在执行的同步 SQLite 查询时终止并重建该专用 worker。同一 project epoch 的 worker 复用一个持久只读 SQLite 连接；项目切换、身份错配或查询失败会关闭它。搜索、分类和 warning 筛选在 worker 内只保留当前身份的数字结果位置索引，翻页复用该索引；查询 worker 不能切换 generation 或写项目事实。唯一文本视图读取当前可见代表并返回过滤后的物理出现次数；整组保存进入 `ProjectWriteStore` 事务后必须先验证 `(item_id, unit_id)` 仍属于当前 generation，再同步组内校对稿，错配时整组回滚且不推进 revision。`/review/save` 必须携带当前正整数 `occurrence_id`：精简 FE 以 `fate_extra_compact_occurrence.display_mode` 为唯一显示模式事实，普通 FE 继续写 item metadata；display-only 保持文本、状态、重试和组级译文所有权不变，不刷新搜索文档或重建导航。校对稿与显示模式同时保存时处于同一事务并只发布一次提交事件。
