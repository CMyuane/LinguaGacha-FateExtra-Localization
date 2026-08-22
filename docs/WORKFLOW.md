# LinguaGacha 工作流

本文供需要项目文档支持的实现或长期文档维护任务选择阅读路径、验证范围、文档同步和交付自检；它不替代始终适用的仓库行动规则。专题正文不写在这里。

## 1. 起手式

1. 先判断任务类型，再读 [`ARCHITECTURE.md`](ARCHITECTURE.md) 和对应专题文档；纯文档自检可直接读目标文档与 [`project-doc` 技能](../.codex/skills/project-doc/SKILL.md)。
2. 文档与代码冲突时回到当前实现，证据不足列为未决，不写成长期规则。
3. 涉及共享状态、任务、文件集合、数据库或持久化写入时，改动前确认拥有者、唯一写入口、事件回流、互斥、事务和失败补偿；纯函数、样式等无关任务不套用这组检查。
4. 改动会影响未来维护判断时，同一任务内同步唯一归宿；代码表面可直接看出的事实不进入长期文档。
5. 完成后回看 diff，确认没有并行规则、旧入口、低密度重复或无关改动。

## 2. 阅读路径

| 任务类型                                   | 必读                                                        | 补读                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 架构、进程边界、跨层依赖                   | [`ARCHITECTURE.md`](ARCHITECTURE.md)                        | `src/index.ts`、`src/backend/bootstrap/`、相关入口测试                                |
| CLI 命令、输出、临时工程、平台启动器       | [`CLI.md`](CLI.md)                                          | `src/cli/`、`buildtools/builder/`、CLI / index 测试                                   |
| API、SSE、错误、项目读写                   | [`BACKEND.md`](BACKEND.md)                                  | `src/backend/api/`、`src/backend/project/`、`src/backend/cache/`、`src/shared/error/` |
| 数据库、`.lg`、migration、asset、NativeFs  | [`BACKEND.md`](BACKEND.md)                                  | `src/backend/database/`、`src/backend/migration/`、`src/native/`                      |
| 任务、worker、LLM                          | [`BACKEND.md`](BACKEND.md)                                  | `src/backend/engine/`、`src/backend/worker/`、`src/backend/llm/`                      |
| Electron / preload / renderer 接入         | [`FRONTEND.md`](FRONTEND.md)                                | `src/gui/`、`src/frontend/app/desktop/`                                               |
| 前端共享状态、页面 query、导航、session UI | [`FRONTEND.md`](FRONTEND.md)                                | `src/frontend/app/state/`、`src/frontend/app/session/`、`src/frontend/pages/`         |
| 前端文案、样式消费、视觉                   | [`FRONTEND.md`](FRONTEND.md)                                | 当前任务设计输入、既有界面证据、`src/frontend/index.css`、相关组件 / 页面 CSS         |
| 长期文档治理                               | [`project-doc` 技能](../.codex/skills/project-doc/SKILL.md) | `docs/`、README / 脚本 / 测试中的文档引用                                             |

## 3. 验证矩阵

代码、测试、构建配置或脚本有改动时先执行代码基线：

```bash
npx tsc -b --noEmit
npm run lint
npm run check
npm run format -- --check
```

格式检查失败时运行 `npm run format` 修复相关文件，再重新执行 `npm run format -- --check`。

| 改动范围                                          | 基线后追加验证                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 纯长期文档                                        | 检查目标形态、相对链接和 diff；涉及 README、脚本提示、测试断言或技能时全文检索入口                   |
| 单域 TypeScript 行为                              | 运行离改动最近的 `*.test.ts(x)`                                                                      |
| 跨目录、跨前后端或共享契约                        | 运行双方相关测试；影响面无法可靠收窄时执行 `npm test`                                                |
| GUI / preload / native / 桌面集成                 | 运行相关单测，必要时 `npm run dev` 走真实主链路                                                      |
| 前端视觉、CSS、可见文案                           | 运行相关页面或组件测试，核对当前设计输入与既有视觉证据，必要时 Electron 真机检查                     |
| Windows Go launcher                               | 在受影响的 `buildtools/builder/win-cli` 或 `buildtools/builder/win-berserker` 内执行 `go test ./...` |
| 构建、Vite、electron-builder、afterPack、发布资产 | `npm run build`；afterPack 会测试并构建对应 Go module                                                |

纯长期文档不强制执行代码基线；同时改代码、测试、配置或脚本时按完整基线处理。

## 4. 长期文档同步

- 长期文档统一按 [`project-doc` 技能](../.codex/skills/project-doc/SKILL.md) 的收录闸门与先减后增流程治理，专题归宿见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。
- 工程长期文档体系只包含 `ARCHITECTURE.md`、`CLI.md`、`BACKEND.md`、`FRONTEND.md` 和本文；仓库行动规则在体系外始终生效，不参与五份文档间的去重。
- 产品或设计流程产物在体系外按需存在和独立变化；工程文档不吸收其正文，也不依赖固定产物存在。
- 删除或迁移入口前，全文检索 README、脚本报错、测试断言、技能提示和文档链接，确认不再指向旧位置。

## 5. 交付自检

- diff 只包含本任务文件，命名、实现、测试与文档边界一致。
- 代码基线和影响范围验证已执行；未执行、失败或只执行部分时说明原因与影响范围。
- 协议、状态、数据库、任务、前端运行态、CLI 或验证要求的变化已同步到唯一归宿。
- 前端视觉改动已说明采用的设计输入或视觉证据，以及是否做了真机或等价验证。
- 文档治理按删除、合并、迁移、压缩、补写、保留、未决、验证汇报信息集合变化。

## 6. 更新条件

阅读路径、验证命令、测试分层、文档同步入口或交付要求变化时更新本文；新增或删除工程长期文档、改变五份文档的目标形态时同步检查仓库引用。

## 7. Fate/Extra 交付验证

本节是 FE 性能门禁、正式数据门禁和交付证据的唯一权威；贡献者清单只链接本节，不复制或放宽数值。基准必须先记录改动前结果，并在同一机器、同一数据和同一采样方式下复测。正式数据只能使用不改动原件的外部副本，不得提交 `.lg`、分类 SQLite、完整译文、ISO、EBOOT、游戏资源、密钥、日志、缓存或 `build` 产物。

### 7.1 功能与故障注入

- 导航测试完整断言五个区域、四条分隔线、区域内顺序、既有子菜单和展开/折叠。
- 校对缓存测试覆盖热命中零读取、同身份单飞、项目或 revision 切换，以及旧 generation 迟到。
- 普通与精简 FE 导出测试覆盖主键游标跨 ID 空洞无重漏、查询计划无 OFFSET、格式兼容、路径越界拒绝、无关文件保留、临时输出、revision 冲突和 writer 失败清理；主进程不得调用 `getAllItems` 或接收全量 item payload。
- FE 扫描与应用测试覆盖 golden fixture 等价、单项目至多一个 draft、精简工程入口拒绝、取消、过期、卸载、dispose、事务回滚，以及 pending manifest 在提交前/后的重启恢复和歧义状态误删保护。
- 索引测试覆盖重复启动合并、取消、worker 崩溃、revision 变化、旧 cleanup 与新 generation 构建串行化、非活动 generation 清理、原子切换、同路径 close/reopen epoch 隔离和旧完整 generation 可读；warning 查询覆盖第 121 条以后唯一命中仍有精确 total/分页，并覆盖四类 warning 与普通/精简工程。
- 搜索测试用旧 `includes` 语义作 oracle，覆盖 CJK 1/2/3 字、ASCII 大小写、Ruby、控制符、文件路径、精确计数、跳转、伪造/迟到 `(item_id, unit_id)` 回滚和 `AbortSignal` / latest-wins；查询计划必须证明 FTS 命中集驱动文档主键复核。
- schema 7 迁移测试覆盖旧普通、FE 与精简项目，并证明打开项目不会同步触发全量索引重建。
- 既有 FE 回归仍覆盖索引解析与双模式导出、18/19 全宽字边界、第四行溢出、所有从者/性别分支、字库映射/纹理/manifest 一致性、编码槽耗尽安全失败，以及六份当前译文主字库和 Ruby 字库零缺字。

### 7.2 正式数据一致性

正式 FE 基线固定为 941,489 个物理位置、28,433 个可编辑精简 `items` 和 941,489 条映射。验收必须证明源工程条目数不变、精简 `items` 数等于有效精确原文组数、物理映射数等于源条目数，并且零孤儿映射、零活动组缺少代表条目、零位置/原文错配、零无效结构 JSON、零路径/原文/source hash 错配。

缺少正式副本时允许先以合成百万级数据执行门禁，但必须把正式数据验收标为未执行，不得据此宣称正式实测完成。

### 7.3 量化性能门禁

| 链路     | 必须达到                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| 正式数据 | 941,489 物理位置、28,433 可编辑精简 items、941,489 映射；零孤儿、零缺代表、零路径/原文/hash 错配             |
| 校对缓存 | 热命中 p95 ≤10ms；160 行窗口 p95 ≤16ms；100 次热请求主堆增量 <5MiB                                           |
| 精简导出 | 189 页时每个 JSON/CSV 流写入次数 ≤191；100k→1m 耗时增长 ≤12 倍；无二次 OFFSET 曲线                           |
| FE 扫描  | 主进程 50ms 心跳最大漂移 ≤100ms；主进程 heap 增量 <128MiB；ready draft <5MiB；worker RSS 目标 <512MiB        |
| 索引任务 | 启动/取消请求 ACK p95 ≤100ms；worker 完全退出 ≤500ms；冷建期间 `/health` p95 ≤100ms；取消后 1 秒内无 staging |
| 搜索     | ≥3 字 p95 ≤200ms、p99 ≤500ms；1～2 字 p95 ≤500ms；查询计划不得扫描 `items`/`filtered_item` JSON              |
| 连续输入 | 十次快速输入只展示最后一次结果；队列不超过 1 active + 1 pending；取消 worker 在 500ms 内退出                 |

### 7.4 完整验证与证据

完成实现后执行：

```powershell
npm run format
npm run check
npm run lint
npm test
npm run build
```

同时执行 FE 校对缓存、导出、扫描、索引与搜索基准。性能报告必须保存机器 CPU、内存、操作系统与运行时版本，数据来源和规模，预热与重复次数，p95/p99、wall time、主进程 heap、worker RSS、50ms 心跳漂移、文件写入次数、查询次数和 `EXPLAIN QUERY PLAN`。故障注入应记录触发点、可见旧状态、回滚和临时资源清理结果；前端验收应记录侧栏展开/折叠、任务阶段/进度/取消、十次快速输入、项目切换和组件卸载结果。

四个 FE 基准的无参数默认配置即合成正式门禁：校对使用 28,433 items / 100 次热循环 / 160 行窗口，精简导出同时使用 100k、941,489 和 1m 物理位置，扫描使用 941,489 逻辑位置 / 28,433 有效文本的正式形状，预览使用 941,489 物理位置 / 28,433 文本单元 / 20 次搜索与取消采样。门禁失败或显式缩小正式配置会返回非零退出码；`--self-check` 只验证缩小 fixture、生产入口、报告结构和清理，不构成性能证据，导出、扫描和预览基准的 `--allow-partial` 仅用于有意拆分的探索性测量。报告中的 `not-executed` / `not-independently-evaluable` 必须在交付中继续列为未执行，不能由其余布尔门禁代替。

```powershell
npm run benchmark:fe:proofreading -- --output build/benchmark-reports/fe-proofreading.json
npm run benchmark:fe:compact -- --output build/benchmark-reports/fe-compact.json
npm run benchmark:fe:scan -- --output build/benchmark-reports/fe-scan.json
npm run benchmark:fe:preview -- --output build/benchmark-reports/fe-preview.json
```

未达到任一门禁时不得标记完成。无法执行、失败或只执行部分时，交付必须逐项写明原因、影响范围、剩余风险以及正式数据还是合成数据；不能以单元测试通过代替量化证据。
