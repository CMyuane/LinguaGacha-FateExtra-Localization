import { allocate_backend_api_port } from "../../src/backend/api/api-port-allocator";
import { ApiGatewayServer } from "../../src/backend/api/api-gateway-server";
import { AppMetadataService } from "../../src/backend/app/app-metadata-service";
import { AppPathService } from "../../src/backend/app/app-path-service";
import { AppSettingService } from "../../src/backend/app/app-setting-service";
import { BackendServices } from "../../src/backend/bootstrap/backend-services";
import { ProjectDatabase } from "../../src/backend/database/database-operations";
import type { DatabaseOperation } from "../../src/backend/database/database-types";
import { LogManager } from "../../src/backend/log/log-manager";
import { build_worker_threads_backend_worker_execution_from_desktop_bundle_dir } from "../../src/backend/worker/worker-execution";

type JsonRecord = Record<string, unknown>;

/** 使用真实 Gateway、会话缓存、写入口和独立查询 worker；调用方只传入工程副本。 */
export async function run_preview_save_benchmark(options: {
  project_path: string;
  app_root: string;
  desktop_bundle_dir: string;
  warmups: number;
  repetitions: number;
}) {
  const paths = new AppPathService({ appRoot: options.app_root });
  const database = new ProjectDatabase();
  const log_manager = new LogManager({
    logDir: paths.get_log_dir(),
    targets: { console: false, file: false },
  });
  const services = new BackendServices({
    paths,
    database,
    metadata: new AppMetadataService(paths),
    appSettingService: new AppSettingService(paths),
    logManager: log_manager,
    systemProxySnapshot: null,
    openOutputFolder: async () => undefined,
    workerExecution: build_worker_threads_backend_worker_execution_from_desktop_bundle_dir(
      options.desktop_bundle_dir,
    ),
  });
  const gateway = new ApiGatewayServer({
    backendServices: services,
    publicPort: await allocate_backend_api_port(),
  });
  const operation_counts: Record<string, number> = {};
  const execute = database.execute.bind(database);
  let measure_operations = false;
  database.execute = (operation: DatabaseOperation) => {
    if (measure_operations)
      operation_counts[operation.name] = (operation_counts[operation.name] ?? 0) + 1;
    return execute(operation);
  };
  services.start();
  try {
    const { baseUrl } = await gateway.start();
    const post = async (route: string, body: JsonRecord): Promise<JsonRecord> => {
      const response = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as { ok: boolean; data: JsonRecord; error?: unknown };
      if (!response.ok || !result.ok) throw new Error(`${route}: ${JSON.stringify(result)}`);
      return result.data;
    };
    await post("/api/session/project/open", { path: options.project_path });
    const query = () =>
      post("/api/toolbox/fate-extra/items", {
        project_path: options.project_path,
        view_mode: "unique",
        position: 0,
        limit: 120,
        query_id: 1,
      });
    let page = await query();
    if (page["index_ready"] !== true) throw new Error("保存基准需要已就绪的索引副本。");
    let revisions = page["sectionRevisions"];
    const rows = page["items"] as JsonRecord[];
    if (rows.length === 0) throw new Error("保存基准没有可编辑条目。");
    const target = rows[0]!;
    const scenarios = [];
    for (const scope of ["unit", "occurrence"] as const) {
      const samples: number[] = [];
      const refresh_samples: number[] = [];
      let changes_are_incremental = true;
      for (let index = -options.warmups; index < options.repetitions; index++) {
        measure_operations = index >= 0;
        const started = performance.now();
        const saved = await post("/api/toolbox/fate-extra/review/save", {
          project_path: options.project_path,
          item_id: target["item_id"],
          text_unit_id: target["text_unit_id"],
          occurrence_id: target["occurrence_id"],
          expected_section_revisions: revisions,
          review_scope: scope,
          proofread_translation: index % 3 === 0 ? "" : `基准校对${scope}${index.toString()}`,
          display_mode: "dialogue",
        });
        if (index >= 0) samples.push(performance.now() - started);
        revisions = saved["sectionRevisions"];
        const changes = saved["changes"] as Array<{ items?: { payloadMode?: string } }>;
        changes_are_incremental &&= changes.every(
          (change) =>
            change.items === undefined ||
            change.items.payloadMode === "canonical-delta" ||
            (scope === "occurrence" && change.items.payloadMode === "field-patch"),
        );
        measure_operations = false;
        const query_started = performance.now();
        page = await query();
        if (index >= 0) refresh_samples.push(performance.now() - query_started);
        if (
          (page["sectionRevisions"] as JsonRecord)["items"] !== (revisions as JsonRecord)["items"]
        ) {
          throw new Error("保存后查询未读取已提交 revision。");
        }
      }
      scenarios.push({
        scope,
        samples_ms: samples,
        refresh_samples_ms: refresh_samples,
        changes_are_incremental,
      });
    }
    const hot_open_samples_ms: number[] = [];
    for (let index = -options.warmups; index < options.repetitions; index++) {
      await post("/api/session/project/close", {});
      await post("/api/session/project/open", { path: options.project_path });
      const started = performance.now();
      const reopened = await query();
      if (index >= 0) hot_open_samples_ms.push(performance.now() - started);
      if (reopened["index_ready"] !== true || reopened["index_job"] !== undefined)
        throw new Error("同路径热开未复用持久化索引。");
    }
    return {
      target_occurrence_count: target["occurrence_count"],
      operation_counts,
      scenarios,
      hot_open_samples_ms,
    };
  } finally {
    await gateway.stop();
    await services.dispose();
    database.close();
  }
}
