import os from "node:os";
import process from "node:process";

import type { AppSettingService } from "../../src/backend/app/app-setting-service";
import type { CacheReadPort } from "../../src/backend/cache/cache-types";
import { ProofreadingCache } from "../../src/backend/cache/proofreading/proofreading-cache";
import type { ProjectDatabase } from "../../src/backend/database/database-operations";
import type { BackendWorkerClient } from "../../src/backend/worker/worker-client";
import { run_proofreading_sync_worker_task } from "../../src/backend/worker/tasks/proofreading-sync-worker-task";
import type { BackendWorkerTask } from "../../src/backend/worker/worker-task";
import {
  createProofreadingListReader,
  type ProofreadingSyncInput,
} from "../../src/shared/proofreading/proofreading-list-reader";

type BenchmarkOptions = {
  item_count: number;
  warmups: number;
  repetitions: number;
  window_count: number;
};

type OperationCounters = {
  snapshot: number;
  read_revisions: number;
  read_items: number;
  read_files: number;
  read_quality: number;
  compact_state: number;
  get_all_items: number;
  worker_sync: number;
};

type SyntheticItem = {
  id: number;
  file_path: string;
  row: number;
  src: string;
  dst: string;
  name_src: string;
  name_dst: string;
  status: string;
  text_type: string;
  retry_count: number;
  extra_field: string;
};

type LatencySummary = {
  count: number;
  min_ms: number;
  median_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
};

const PROJECT_PATH = "Z:/synthetic/fate-extra-compact-proofreading.lg";
const FILE_COUNT = 32;

export async function run_proofreading_benchmark(options: BenchmarkOptions) {
  const counters = create_counters();
  const items = create_synthetic_items(options.item_count);
  const file_entries = Array.from(
    { length: Math.min(FILE_COUNT, options.item_count) },
    (_, index) => {
      return {
        rel_path: `script/route-${index.toString().padStart(2, "0")}.txt`,
        file_type: "TXT",
        sort_index: index,
      };
    },
  );
  const revisions = { files: 1, items: 1, quality: 1, proofreading: 0 };
  const item_summary = build_item_summary(items, file_entries);
  const cache_port: CacheReadPort = {
    snapshot: () => {
      counters.snapshot += 1;
      return {
        projectPath: PROJECT_PATH,
        epoch: 1,
        freshness: "fresh",
        sectionRevisions: revisions,
        itemCount: items.length,
        itemMode: "fate-extra-compact",
      };
    },
    readSectionRevisions: () => {
      counters.read_revisions += 1;
      return revisions;
    },
    items: {
      readItems: () => {
        counters.read_items += 1;
        return items;
      },
      readItem: () => null,
      readSummary: () => item_summary,
    },
    files: {
      readFileEntries: () => {
        counters.read_files += 1;
        return file_entries;
      },
    },
    quality: {
      readBlock: () => {
        counters.read_quality += 1;
        return {};
      },
    },
    prompts: { readBlock: () => ({}) },
    analysis: { readBlock: () => ({}) },
  };
  const database = {
    execute: (operation: { name: string }) => {
      if (operation.name === "getFateExtraCompactState") {
        counters.compact_state += 1;
        return { enabled: true };
      }
      if (operation.name === "getAllItems") {
        counters.get_all_items += 1;
        return items;
      }
      throw new Error(`校对缓存基准未实现数据库操作：${operation.name}`);
    },
  } as Pick<ProjectDatabase, "execute">;
  const worker_client = create_counting_worker(counters);
  const cache = new ProofreadingCache({
    cache: cache_port,
    appSettingService: {
      read_setting: () => ({ source_language: "JA", target_language: "ZH" }),
    } as unknown as AppSettingService,
    workerClient: worker_client,
    service: createProofreadingListReader(),
    database,
  });

  const counts_before_cold = clone_counters(counters);
  const cold_started = performance.now();
  const cold_sync = await cache.sync({});
  const cold_sync_ms = performance.now() - cold_started;
  const filters = cold_sync.data.defaultFilters;
  const list_query = {
    filters,
    keyword: "",
    scope: "all" as const,
    is_regex: false,
    sort_state: null,
    window_start: 0,
    window_count: 0,
  };
  const cold_row_count = (await cache.list(list_query)).data.row_count;
  const counts_after_cold = clone_counters(counters);

  let current_view_id = "";
  for (let index = 0; index < options.warmups; index += 1) {
    await cache.sync({});
    current_view_id = (await cache.list(list_query)).data.view_id;
    await cache.filterPanel({ filters });
    await cache.window({ view_id: current_view_id, start: 0, count: options.window_count });
  }
  const counts_after_warmups = clone_counters(counters);

  force_gc();
  const heap_before_bytes = process.memoryUsage().heapUsed;
  const sync_samples: number[] = [];
  const list_samples: number[] = [];
  const filter_samples: number[] = [];
  const window_samples: number[] = [];
  let last_row_count = 0;
  let last_window_row_count = 0;
  for (let index = 0; index < options.repetitions; index += 1) {
    sync_samples.push(await measure_async(async () => await cache.sync({})));

    const list_started = performance.now();
    const list_result = await cache.list(list_query);
    list_samples.push(performance.now() - list_started);
    current_view_id = list_result.data.view_id;
    last_row_count = list_result.data.row_count;

    filter_samples.push(await measure_async(async () => await cache.filterPanel({ filters })));

    const window_started = performance.now();
    const window_result = await cache.window({
      view_id: current_view_id,
      start: 0,
      count: options.window_count,
    });
    window_samples.push(performance.now() - window_started);
    last_window_row_count = window_result.data.rows.length;
  }
  force_gc();
  const heap_after_bytes = process.memoryUsage().heapUsed;
  const counts_after_measured = clone_counters(counters);
  await worker_client.dispose();

  const latency = {
    sync: summarize_samples(sync_samples),
    list: summarize_samples(list_samples),
    filter_panel: summarize_samples(filter_samples),
    window: summarize_samples(window_samples),
  };
  const heap_delta_mib = round((heap_after_bytes - heap_before_bytes) / 1024 / 1024);
  const accounting = {
    cold: subtract_counters(counts_after_cold, counts_before_cold),
    warmup_delta: subtract_counters(counts_after_warmups, counts_after_cold),
    measured_hot_delta: subtract_counters(counts_after_measured, counts_after_warmups),
    total: counts_after_measured,
  };
  const measured_gates = {
    hot_sync_p95_at_most_10ms: latency.sync.p95_ms <= 10,
    window_160_rows_p95_at_most_16ms:
      options.window_count === 160
        ? latency.window.p95_ms <= 16
        : "not-evaluated-window-is-not-160",
    hot_requests_heap_delta_less_than_5mib: heap_delta_mib < 5,
    hot_path_read_items_zero: accounting.measured_hot_delta.read_items === 0,
    hot_path_get_all_items_zero: accounting.measured_hot_delta.get_all_items === 0,
    hot_path_worker_sync_zero: accounting.measured_hot_delta.worker_sync === 0,
    list_result_contains_every_item: last_row_count === items.length,
    window_result_matches_requested_size:
      last_window_row_count === Math.min(options.window_count, items.length),
  };
  const formal_sample_count_met = options.repetitions >= 100 && options.window_count === 160;
  const boolean_gate_results = Object.values(measured_gates).filter(
    (result): result is boolean => typeof result === "boolean",
  );

  return {
    benchmark: "FE compact proofreading cache hot identity, list/filter, and virtual window",
    generated_at: new Date().toISOString(),
    machine: machine_snapshot(),
    data: {
      source: "synthetic-compact-items",
      project_path: PROJECT_PATH,
      item_count: items.length,
      file_count: file_entries.length,
      project_epoch: 1,
      revisions,
    },
    methodology: {
      cold_sync: `真实 ProofreadingCache 从模拟 compact 基础缓存端口取得 ${items.length.toLocaleString("en-US")} 个合成 item，调用生产 proofreading sync worker task，并交给真实 ProofreadingListReader 建立运行态；数据库端口只用于断言校对热机不再回退读取。`,
      worker_execution:
        "production proofreading worker task is invoked in-process so this benchmark isolates cache/main-heap behavior; worker dispatch latency and worker RSS are outside this gate",
      hot_cycle:
        "每轮依次执行 sync identity hit、完整默认 list、filter panel 和当前 view_id 的窗口读取；list 本身设置 window_count=0，窗口仅在独立样本中构造。",
      hot_hit_gate_scope:
        "docs/WORKFLOW.md 的热命中 10ms 门槛对应 O(1) sync identity hit；list/filter 的真实计算时延分别报告但没有擅自新增门槛。",
      heap: "在全部预热后和全部测量后分别强制 GC，以持久主堆增量判定 5MiB 门槛。",
      warmups: options.warmups,
      repetitions: options.repetitions,
      window_count: options.window_count,
      evidence_scope: {
        wall_time: "cold sync 与四类热请求分别报告 wall time、p95 和 p99",
        main_heap: "强制 GC 前后的 Node 主堆持久增量",
        worker_rss:
          "not-applicable-in-process-worker-task; 校对门禁不包含 worker RSS，进程隔离资源由对应 worker 基准负责",
        heartbeat:
          "not-applicable-o1-cache-hit; 本基准测量同步命中和窗口调用时延，不以 50ms 心跳替代单次时延",
        file_writes: "not-applicable-read-only-cache-benchmark",
        query_plan: "not-applicable-no-search-or-full-database-pagination",
      },
    },
    cold_sync: {
      wall_ms: round(cold_sync_ms),
      project_id: cold_sync.data.projectId,
      input_item_count: items.length,
      synced_row_count: cold_row_count,
    },
    latency_ms: latency,
    heap: {
      gc_exposed: typeof globalThis.gc === "function",
      before_mib: round(heap_before_bytes / 1024 / 1024),
      after_mib: round(heap_after_bytes / 1024 / 1024),
      delta_mib: heap_delta_mib,
    },
    result_shape: {
      list_row_count: last_row_count,
      window_row_count: last_window_row_count,
      expected_window_row_count: Math.min(options.window_count, items.length),
    },
    accounting,
    gates: {
      ...measured_gates,
      formal_sample_count_at_least_100_and_window_160: formal_sample_count_met,
      acceptance:
        formal_sample_count_met && boolean_gate_results.every(Boolean)
          ? true
          : formal_sample_count_met
            ? false
            : "not-evaluated-requires-at-least-100-repetitions-and-160-row-window",
    },
    formal_data_acceptance: "not-applicable-synthetic-proofreading-items",
    warning: `合成 ${items.length.toLocaleString("en-US")}-item 缓存基准不能替代外部正式 FE 项目的数据一致性验收。`,
  };
}

function create_synthetic_items(item_count: number): SyntheticItem[] {
  return Array.from({ length: item_count }, (_, index) => {
    const item_id = index + 1;
    const file_index = index % Math.min(FILE_COUNT, item_count);
    return {
      id: item_id,
      file_path: `script/route-${file_index.toString().padStart(2, "0")}.txt`,
      row: Math.floor(index / Math.min(FILE_COUNT, item_count)) + 1,
      src: `原文項目-${item_id.toString().padStart(6, "0")}`,
      dst: `译文条目-${item_id.toString().padStart(6, "0")}`,
      name_src: "",
      name_dst: "",
      status: index % 3 === 0 ? "NONE" : index % 3 === 1 ? "PROCESSED" : "ERROR",
      text_type: "NONE",
      retry_count: 0,
      extra_field: "",
    };
  });
}

function build_item_summary(
  items: SyntheticItem[],
  file_entries: Array<{ rel_path: string; file_type: string; sort_index: number }>,
) {
  const status_counts: Record<string, number> = {};
  const file_counts = new Map<string, number>();
  for (const item of items) {
    status_counts[item.status] = (status_counts[item.status] ?? 0) + 1;
    file_counts.set(item.file_path, (file_counts.get(item.file_path) ?? 0) + 1);
  }
  return {
    totalCount: items.length,
    statusCounts: status_counts,
    nonemptySourceStatusCounts: { ...status_counts },
    fileEntries: file_entries.map((entry) => ({
      rel_path: entry.rel_path,
      file_type: entry.file_type,
      item_count: file_counts.get(entry.rel_path) ?? 0,
    })),
  };
}

function create_counting_worker(counters: OperationCounters): BackendWorkerClient {
  return {
    run: async (task: BackendWorkerTask, signal: AbortSignal) => {
      if (signal.aborted) throw new Error("校对缓存基准 worker 在执行前被取消。");
      if (task.type !== "proofreading_sync") {
        throw new Error(`校对缓存基准未实现 worker task：${task.type}`);
      }
      counters.worker_sync += 1;
      return run_proofreading_sync_worker_task(task.input as ProofreadingSyncInput);
    },
    dispose: async () => undefined,
  } as unknown as BackendWorkerClient;
}

async function measure_async(operation: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

function create_counters(): OperationCounters {
  return {
    snapshot: 0,
    read_revisions: 0,
    read_items: 0,
    read_files: 0,
    read_quality: 0,
    compact_state: 0,
    get_all_items: 0,
    worker_sync: 0,
  };
}

function clone_counters(counters: OperationCounters): OperationCounters {
  return { ...counters };
}

function subtract_counters(after: OperationCounters, before: OperationCounters): OperationCounters {
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => {
      return [key, value - before[key as keyof OperationCounters]];
    }),
  ) as OperationCounters;
}

function summarize_samples(samples: number[]): LatencySummary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min_ms: round(sorted[0] ?? 0),
    median_ms: round(percentile(sorted, 50)),
    p95_ms: round(percentile(sorted, 95)),
    p99_ms: round(percentile(sorted, 99)),
    max_ms: round(sorted.at(-1) ?? 0),
  };
}

function percentile(sorted: number[], percentage: number): number {
  const index = Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function force_gc(): void {
  if (typeof globalThis.gc !== "function") {
    throw new Error("校对缓存基准要求 Node --expose-gc。");
  }
  globalThis.gc();
}

function machine_snapshot() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    cpu_model: cpus[0]?.model ?? "unknown",
    logical_cpu_count: cpus.length,
    total_memory_mib: round(os.totalmem() / 1024 / 1024, 1),
    platform: process.platform,
    architecture: process.arch,
    os_release: os.release(),
    node: process.version,
    v8: process.versions.v8,
  };
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
