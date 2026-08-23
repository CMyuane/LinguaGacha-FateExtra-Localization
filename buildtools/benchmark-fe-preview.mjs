import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  BenchmarkWorker,
  bundle_benchmark_worker,
  cleanup_temporary_directory,
  copy_sqlite_database,
  machine_snapshot,
  make_temporary_directory,
  monitor_operation,
  option_boolean,
  option_integer,
  option_text,
  option_texts,
  parse_benchmark_arguments,
  round,
  summarize_samples,
  summarize_values,
  write_json_report,
} from "./lib/fe-benchmark-common.mjs";

const options = parse_benchmark_arguments(process.argv.slice(2));
if (option_boolean(options, "help")) {
  process.stdout.write(`Usage:
  npm run benchmark:fe:preview -- --project <project.lg> --query <text> [--query <text>]
  npm run benchmark:fe:preview -- --synthetic-items 941489 [--synthetic-unique 28433]

Options: --index-repetitions 1 --search-repetitions 20 --cancel-repetitions 20
         --cancel-after-ms 25 --output <report.json> --self-check --allow-partial\n`);
  process.exit(0);
}
const self_check = option_boolean(options, "self-check");
const allow_partial = option_boolean(options, "allow-partial");
const project_argument = option_text(options, "project");
const output_path = option_text(options, "output");
const synthetic_item_count = option_integer(
  options,
  "synthetic-items",
  self_check ? 1_000 : 941_489,
  1,
);
const synthetic_unique_count = option_integer(
  options,
  "synthetic-unique",
  Math.min(self_check ? 100 : 28_433, synthetic_item_count),
  1,
);
const index_warmups = option_integer(options, "index-warmups", 0, 0);
const index_repetitions = option_integer(options, "index-repetitions", 1, 1);
const search_warmups = option_integer(options, "search-warmups", self_check ? 0 : 3, 0);
const search_repetitions = option_integer(options, "search-repetitions", self_check ? 2 : 20, 1);
const cancel_repetitions = option_integer(options, "cancel-repetitions", self_check ? 1 : 20, 1);
const cancel_after_ms = option_integer(options, "cancel-after-ms", 25, 0);
const queries = option_texts(options, "query");
if (queries.length === 0) queries.push("日", "日文", "日文测", "RUBY", "\u0001");
if (project_argument !== "" && options["synthetic-items"] !== undefined) {
  throw new Error("--project 与 --synthetic-items 不能同时使用。");
}

const temporary_directory = make_temporary_directory("linguagacha-fe-preview-benchmark-");
let worker;
try {
  const worker_file = await bundle_benchmark_worker(temporary_directory);
  worker = new BenchmarkWorker(worker_file);
  const worker_start = await worker.wait_until_ready();
  const base_project = path.join(temporary_directory, "base.lg");
  let data_source;
  let source_project = null;
  let setup = null;
  if (project_argument !== "") {
    source_project = path.resolve(project_argument);
    assert_file(source_project, "FE .lg project");
    await copy_sqlite_database(source_project, base_project);
    data_source = "external-project-copy";
  } else {
    const setup_result = await worker.call({
      kind: "create-synthetic-preview",
      projectPath: base_project,
      itemCount: synthetic_item_count,
      uniqueCount: Math.min(synthetic_unique_count, synthetic_item_count),
    });
    setup = setup_result.payload;
    data_source = "synthetic";
  }

  for (let index = 0; index < index_warmups; index += 1) {
    const project_copy = path.join(temporary_directory, `index-warmup-${index.toString()}.lg`);
    await copy_sqlite_database(base_project, project_copy);
    await worker.call({ kind: "preview-index", projectPath: project_copy });
  }

  const index_runs = [];
  let indexed_project = "";
  for (let index = 0; index < index_repetitions; index += 1) {
    const project_copy = path.join(temporary_directory, `index-run-${index.toString()}.lg`);
    await copy_sqlite_database(base_project, project_copy);
    const monitored = await monitor_operation(
      async () => await worker.call({ kind: "preview-index", projectPath: project_copy }),
      50,
    );
    const state = await worker.call({ kind: "preview-state", projectPath: project_copy });
    index_runs.push({
      wall_ms: monitored.wall_ms,
      worker_wall_ms: monitored.value.worker_wall_ms,
      dispatch_ack_ms: monitored.value.dispatch_ack_ms,
      maximum_heartbeat_drift_ms: monitored.maximum_heartbeat_drift_ms,
      heartbeat_drift_ms: monitored.heartbeat_drift_ms,
      main_heap_delta_mib: monitored.main_heap_delta_mib,
      maximum_process_rss_mib: monitored.maximum_process_rss_mib,
      worker_memory: monitored.value.worker_memory,
      index_result: monitored.value.payload,
      state: state.payload,
    });
    if (indexed_project === "") indexed_project = project_copy;
  }

  const search_results = [];
  const navigation_probe = await worker.call({
    kind: "preview-search",
    projectPath: indexed_project,
    search: "",
    position: 0,
    limit: 160,
    includeFiles: true,
    viewMode: "occurrence",
  });
  const probe_files = Array.isArray(navigation_probe.payload.files)
    ? navigation_probe.payload.files.map(String)
    : [];
  const probe_file_counts = navigation_probe.payload.file_counts ?? {};
  const first_file = probe_files[0] ?? "";
  const occurrence_count = Number(
    index_runs[0]?.index_result.navigation_occurrence_count ?? navigation_probe.payload.total ?? 0,
  );
  const first_file_count = Number(probe_file_counts[first_file] ?? 0);
  const navigation_scenarios = [
    { name: "initial-load", position: 0, file_path: "" },
    {
      name: "global-far-jump",
      position: Math.max(0, Math.floor(occurrence_count * 0.9)),
      file_path: "",
    },
    ...(first_file === ""
      ? []
      : [
          { name: "file-switch", position: 0, file_path: first_file },
          {
            name: "file-far-jump",
            position: Math.max(0, Math.floor(first_file_count * 0.9)),
            file_path: first_file,
          },
        ]),
  ];
  const navigation_results = [];
  for (const scenario of navigation_scenarios) {
    const samples = [];
    const totals = [];
    for (let index = 0; index < search_repetitions; index += 1) {
      const started = performance.now();
      const result = await worker.call({
        kind: "preview-search",
        projectPath: indexed_project,
        search: "",
        position: scenario.position,
        filePath: scenario.file_path,
        limit: 160,
        viewMode: "occurrence",
      });
      samples.push(performance.now() - started);
      totals.push(Number(result.payload.total ?? -1));
    }
    const latency = summarize_samples(samples);
    const explain = await worker.call({
      kind: "preview-navigation-explain",
      projectPath: indexed_project,
      position: scenario.position,
      filePath: scenario.file_path,
    });
    navigation_results.push({
      ...scenario,
      repetitions: search_repetitions,
      latency_ms: latency,
      exact_totals: [...new Set(totals)],
      explain_query_plan: explain.payload,
      gates: {
        latency_p95_at_most_200ms: latency.p95_ms <= 200,
        exact_total_stable_and_nonnegative:
          new Set(totals).size === 1 && totals.every((total) => total >= 0),
        no_offset_or_items_json_scan:
          explain.payload.sql_uses_offset === false &&
          explain.payload.sql_reads_item_json === false &&
          explain.payload.scans_items === false,
      },
    });
  }
  for (const query of queries) {
    for (let index = 0; index < search_warmups; index += 1) {
      await worker.call({
        kind: "preview-search",
        projectPath: indexed_project,
        search: query,
        limit: 160,
      });
    }
    const samples = [];
    const query_counts = [];
    const worker_heap_deltas = [];
    for (let index = 0; index < search_repetitions; index += 1) {
      const started = performance.now();
      const result = await worker.call({
        kind: "preview-search",
        projectPath: indexed_project,
        search: query,
        limit: 160,
      });
      samples.push(performance.now() - started);
      query_counts.push(Number(result.payload.total ?? -1));
      worker_heap_deltas.push(Number(result.worker_memory.heap_delta_mib));
    }
    const explain = await worker.call({
      kind: "preview-explain",
      projectPath: indexed_project,
      search: query,
    });
    const latency = summarize_samples(samples);
    const code_point_length = Array.from(query.toLowerCase()).length;
    search_results.push({
      query,
      normalized_query: query.toLowerCase(),
      code_point_length,
      warmups: search_warmups,
      repetitions: search_repetitions,
      latency_ms: latency,
      exact_totals: [...new Set(query_counts)],
      worker_heap_delta_mib: summarize_values(worker_heap_deltas),
      explain_query_plan: explain.payload,
      gates: {
        latency:
          code_point_length >= 3
            ? latency.p95_ms <= 200 && latency.p99_ms <= 500
            : latency.p95_ms <= 500,
        no_items_json_candidate_scan:
          !explain.payload.scans_items_or_filtered_item && !explain.payload.sql_reads_item_json,
        exact_total_stable_and_nonnegative:
          new Set(query_counts).size === 1 && query_counts.every((count) => count >= 0),
        sample_count_at_least_20:
          search_repetitions >= 20 ? true : "not-evaluated-fewer-than-20-repetitions",
      },
    });
  }

  const cancellation = await run_cancellation_probes({
    worker_file,
    inspection_worker: worker,
    base_project,
    temporary_directory,
    cancel_after_ms,
    repetitions: cancel_repetitions,
  });
  const gate_summary = build_gate_summary({
    index_runs,
    search_results,
    navigation_results,
    cancellation,
    formal_profile_observed: index_runs.every(
      (run) =>
        run.state.item_count === 941_489 &&
        run.index_result.navigation_occurrence_count === 941_489 &&
        run.index_result.unit_count === 28_433,
    ),
    require_complete_profile: !self_check && !allow_partial,
  });
  const report = {
    benchmark: "FE generation index, indexed substring search, and worker cancellation",
    generated_at: new Date().toISOString(),
    machine: machine_snapshot(),
    data_source,
    source_project,
    setup,
    methodology: {
      index_scope: "每次从 SQLite backup 生成独立副本，并通过生产 preview index worker task 冷建。",
      search_scope:
        "通过生产只读 preview worker task 构建或复用精确结果位置缓存，并返回 160 行分页。",
      main_health_proxy:
        "50ms 主线程心跳用于测量阻塞；本脚本不启动 HTTP 服务，/health p95 需在 Electron 集成验收复核。",
      cancellation_scope:
        "cancel_dispatch_ack_ms 测量主线程发出 terminate 请求的同步 ACK；worker_exit_ms 单独测量线程完全退出；退出后由新 worker 执行生产 cleanup task。",
      external_project_mutation: "none; all index writes target SQLite backup copies",
      index_warmups,
      index_repetitions,
      search_warmups,
      search_repetitions,
      cancel_repetitions,
    },
    worker_start_ack_ms: worker_start.worker_start_ack_ms,
    index: {
      wall_ms: summarize_samples(index_runs.map((run) => run.wall_ms)),
      dispatch_ack_ms: summarize_samples(index_runs.map((run) => run.dispatch_ack_ms)),
      maximum_heartbeat_drift_ms: round(
        Math.max(...index_runs.map((run) => run.maximum_heartbeat_drift_ms)),
        3,
      ),
      maximum_main_heap_delta_mib: round(
        Math.max(...index_runs.map((run) => run.main_heap_delta_mib)),
        3,
      ),
      maximum_process_rss_mib: round(
        Math.max(...index_runs.map((run) => run.maximum_process_rss_mib)),
        3,
      ),
      runs: index_runs,
      gates: {
        dispatch_ack_p95_at_most_100ms:
          summarize_samples(index_runs.map((run) => run.dispatch_ack_ms)).p95_ms <= 100,
        main_heartbeat_max_drift_at_most_100ms:
          Math.max(...index_runs.map((run) => run.maximum_heartbeat_drift_ms)) <= 100,
        all_generations_complete_after_success: index_runs.every(
          (run) => run.state.incomplete_generation_count === 0,
        ),
        health_endpoint_p95_at_most_100ms: "not-executed-http-server-not-started",
      },
    },
    search: search_results,
    navigation: navigation_results,
    query_accounting: {
      index_worker_dispatch_count: index_warmups + index_repetitions + cancel_repetitions,
      index_cleanup_worker_dispatch_count: cancel_repetitions,
      search_worker_request_count: queries.length * (search_warmups + search_repetitions),
      navigation_worker_request_count: 1 + navigation_scenarios.length * search_repetitions,
      sqlite_statement_count:
        "not-instrumented; navigation and filtered match caches use different hydration shapes",
    },
    cancellation,
    gate_summary,
    self_check: self_check
      ? {
          requested: true,
          scope:
            "以 1,000 items、两次搜索和一次取消验证生产索引/搜索/清理、报告结构与查询计划；不对正式规模时延作进程断言。",
        }
      : null,
    continuous_input_latest_wins:
      "covered-by-worker-client-and-preview-page-tests; browser queue telemetry not measured here",
    formal_data_acceptance: "not-executed-by-this-benchmark",
    warning:
      data_source === "synthetic"
        ? "合成索引结果不能替代正式近百万项目验收。"
        : "外部项目副本用于性能测量；正式零错配/零孤儿一致性仍需执行专用审计。",
  };
  write_json_report(report, output_path);
  if (!self_check && gate_summary.acceptance !== true) {
    process.exitCode = 1;
  }
} finally {
  if (worker !== undefined) await worker.terminate();
  cleanup_temporary_directory(temporary_directory);
}

async function run_cancellation_probes(args) {
  const project_path = path.join(args.temporary_directory, "cancel-probe.lg");
  await copy_sqlite_database(args.base_project, project_path);
  const runs = [];
  for (let index = 0; index < args.repetitions; index += 1) {
    runs.push(
      await run_single_cancellation_probe({
        worker_file: args.worker_file,
        inspection_worker: args.inspection_worker,
        project_path,
        cancel_after_ms: args.cancel_after_ms,
      }),
    );
  }
  const active_runs = runs.filter((run) => !run.completed_before_cancel);
  return {
    repetitions: args.repetitions,
    completed_before_cancel_count: runs.length - active_runs.length,
    cancel_dispatch_ack_ms: summarize_samples(active_runs.map((run) => run.cancel_dispatch_ack_ms)),
    worker_exit_ms: summarize_samples(active_runs.map((run) => run.worker_exit_ms)),
    cleanup_completed_after_cancel_ms: summarize_samples(
      active_runs.map((run) => run.cleanup_completed_after_cancel_ms),
    ),
    runs,
    gates: {
      cancel_dispatch_ack_p95_at_most_100ms:
        active_runs.length > 0
          ? summarize_samples(active_runs.map((run) => run.cancel_dispatch_ack_ms)).p95_ms <= 100
          : "not-evaluated-all-index-runs-finished-before-cancel",
      worker_exit_at_most_500ms:
        active_runs.length > 0
          ? active_runs.every((run) => run.worker_exit_ms <= 500)
          : "not-evaluated-all-index-runs-finished-before-cancel",
      cleanup_completed_within_1_second:
        active_runs.length > 0
          ? active_runs.every((run) => run.cleanup_completed_after_cancel_ms <= 1_000)
          : "not-evaluated-all-index-runs-finished-before-cancel",
      no_incomplete_generation_after_1_second: runs.every(
        (run) => run.state_after_1_second.incomplete_generation_count === 0,
      ),
      cancellation_sample_count_at_least_20:
        args.repetitions >= 20 ? true : "not-evaluated-fewer-than-20-repetitions",
    },
  };
}

async function run_single_cancellation_probe(args) {
  const cancellation_worker = new BenchmarkWorker(args.worker_file);
  const startup = await cancellation_worker.wait_until_ready();
  let completed_before_cancel = false;
  const task = cancellation_worker
    .call({ kind: "preview-index", projectPath: args.project_path })
    .then(
      () => {
        completed_before_cancel = true;
      },
      () => {},
    );
  await new Promise((resolve) => setTimeout(resolve, args.cancel_after_ms));
  const cancellation_requested_at = performance.now();
  const termination_request = cancellation_worker.begin_termination();
  const termination = await termination_request.completion;
  await task;
  const recovery_worker = new BenchmarkWorker(args.worker_file);
  try {
    const recovery_start = await recovery_worker.wait_until_ready();
    const cleanup = recovery_worker
      .call({ kind: "preview-index-cleanup", projectPath: args.project_path })
      .then(
        (result) => ({
          ok: true,
          result,
          completed_after_cancel_ms: round(performance.now() - cancellation_requested_at),
        }),
        (error) => ({
          ok: false,
          error,
          completed_after_cancel_ms: round(performance.now() - cancellation_requested_at),
        }),
      );
    const remaining_until_one_second = Math.max(
      0,
      1_000 - (performance.now() - cancellation_requested_at),
    );
    if (remaining_until_one_second > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining_until_one_second));
    }
    const state = await args.inspection_worker.call({
      kind: "preview-state",
      projectPath: args.project_path,
    });
    const state_observed_after_cancel_ms = round(performance.now() - cancellation_requested_at);
    const cleanup_outcome = await cleanup;
    if (!cleanup_outcome.ok) throw cleanup_outcome.error;
    const cleanup_result = cleanup_outcome.result;
    return {
      requested_after_ms: args.cancel_after_ms,
      worker_start_ack_ms: startup.worker_start_ack_ms,
      completed_before_cancel,
      cancel_dispatch_ack_ms: termination_request.cancel_dispatch_ack_ms,
      worker_exit_ms: termination.worker_exit_ms,
      recovery_worker_start_ack_ms: recovery_start.worker_start_ack_ms,
      cleanup_dispatch_ack_ms: cleanup_result.dispatch_ack_ms,
      cleanup_completed_after_cancel_ms: cleanup_outcome.completed_after_cancel_ms,
      cleanup_result: cleanup_result.payload,
      state_observed_after_cancel_ms,
      state_after_1_second: state.payload,
    };
  } finally {
    await recovery_worker.terminate();
  }
}

function build_gate_summary({
  index_runs,
  search_results,
  navigation_results,
  cancellation,
  formal_profile_observed,
  require_complete_profile,
}) {
  const gate_groups = [
    {
      prefix: "index.gates",
      value: {
        dispatch_ack_p95_at_most_100ms:
          summarize_samples(index_runs.map((run) => run.dispatch_ack_ms)).p95_ms <= 100,
        main_heartbeat_max_drift_at_most_100ms:
          Math.max(...index_runs.map((run) => run.maximum_heartbeat_drift_ms)) <= 100,
        all_generations_complete_after_success: index_runs.every(
          (run) => run.state.incomplete_generation_count === 0,
        ),
      },
    },
    ...search_results.map((result, index) => ({
      prefix: `search[${index.toString()}].gates`,
      value: result.gates,
    })),
    ...navigation_results.map((result, index) => ({
      prefix: `navigation[${index.toString()}].gates`,
      value: result.gates,
    })),
    { prefix: "cancellation.gates", value: cancellation.gates },
  ];
  const evaluated = [];
  const not_evaluated = [];
  for (const group of gate_groups) {
    for (const [key, value] of Object.entries(group.value)) {
      const gate_path = `${group.prefix}.${key}`;
      if (typeof value === "boolean") {
        evaluated.push({ path: gate_path, value });
      } else if (typeof value === "string" && value.startsWith("not-")) {
        not_evaluated.push(gate_path);
      }
    }
  }
  const coverage = {
    formal_shape_941489_occurrences_and_28433_units: formal_profile_observed,
    cjk_lengths_1_2_and_3: [1, 2, 3].every((length) =>
      search_results.some(
        (result) =>
          result.code_point_length === length &&
          Array.from(result.query).every((character) => /\p{Script=Han}/u.test(character)),
      ),
    ),
    includes_ascii_case_fold_query: search_results.some(
      (result) => /[A-Z]/u.test(result.query) && /[a-z]/u.test(result.normalized_query),
    ),
    includes_control_character_query: search_results.some((result) =>
      Array.from(result.query).some((character) => /\p{Cc}/u.test(character)),
    ),
    search_repetitions_at_least_20: search_results.every((result) => result.repetitions >= 20),
    cancellation_repetitions_at_least_20: cancellation.repetitions >= 20,
    active_cancellation_samples_at_least_20:
      cancellation.repetitions - cancellation.completed_before_cancel_count >= 20,
  };
  const failed_boolean_gates = evaluated
    .filter((entry) => entry.value === false)
    .map((entry) => entry.path);
  const missing_required_coverage = require_complete_profile
    ? Object.entries(coverage)
        .filter(([, value]) => !value)
        .map(([key]) => key)
    : [];
  return {
    evaluated_boolean_gate_count: evaluated.length,
    failed_boolean_gates,
    not_evaluated_gate_paths: not_evaluated,
    coverage,
    complete_profile_required: require_complete_profile,
    missing_required_coverage,
    unmeasured_workflow_gates: [
      "cold-build /health HTTP p95（本脚本仅报告 50ms 主线程心跳代理）",
      "浏览器十次连续输入 latest-wins 与 1 active + 1 pending（由页面/worker 集成测试覆盖）",
    ],
    acceptance: failed_boolean_gates.length === 0 && missing_required_coverage.length === 0,
  };
}

function assert_file(file_path, label) {
  if (!fs.statSync(file_path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${label} 不存在：${file_path}`);
  }
}
