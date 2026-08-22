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
  parse_benchmark_arguments,
  summarize_samples,
  summarize_values,
  write_json_report,
} from "./lib/fe-benchmark-common.mjs";

const options = parse_benchmark_arguments(process.argv.slice(2));
if (option_boolean(options, "help")) {
  process.stdout.write(`Usage:
  npm run benchmark:fe:scan -- --project <project.lg> --source-directory <dir> \\
    --complete-source <file> --classification-database <sqlite>
  npm run benchmark:fe:scan -- --formal-shape
  npm run benchmark:fe:scan -- --synthetic-complete-items 20000 --synthetic-route-items 4000

Options: --warmups 0 --repetitions 1 --output <report.json>
         --self-check --allow-partial\n`);
  process.exit(0);
}
const self_check = option_boolean(options, "self-check");
const allow_partial = option_boolean(options, "allow-partial");
const project_argument = option_text(options, "project");
const output_path = option_text(options, "output");
const warmups = option_integer(options, "warmups", 0, 0);
const repetitions = option_integer(options, "repetitions", 1, 1);
const has_explicit_synthetic_shape = [
  "synthetic-complete-items",
  "synthetic-route-items",
  "synthetic-unique-indices",
  "synthetic-unique-texts",
].some((key) => options[key] !== undefined);
const formal_shape =
  option_boolean(options, "formal-shape") ||
  (project_argument === "" && !has_explicit_synthetic_shape && !self_check);
if (project_argument !== "" && formal_shape) {
  throw new Error("--project 与 --formal-shape 不能同时使用。");
}
const complete_count = formal_shape
  ? 914_663
  : option_integer(options, "synthetic-complete-items", self_check ? 2_000 : 20_000, 1);
const route_count = formal_shape
  ? 34_693
  : option_integer(options, "synthetic-route-items", self_check ? 400 : 4_000, 1);
const unique_index_count = formal_shape
  ? 7_867
  : option_integer(options, "synthetic-unique-indices", self_check ? 100 : 1_000, 1);
const unique_text_count = formal_shape
  ? 28_433
  : option_integer(
      options,
      "synthetic-unique-texts",
      self_check ? 200 : Math.min(2_000, complete_count),
      1,
    );

const temporary_directory = make_temporary_directory("linguagacha-fe-scan-benchmark-");
let worker;
try {
  const worker_file = await bundle_benchmark_worker(temporary_directory);
  worker = new BenchmarkWorker(worker_file);
  const worker_start = await worker.wait_until_ready();
  let fixture;
  let data_source;
  let source_project = "";
  if (project_argument !== "") {
    source_project = path.resolve(project_argument);
    const source_directory = required_path_option(options, "source-directory", true);
    const complete_source = required_path_option(options, "complete-source", false);
    const classification_database = required_path_option(options, "classification-database", false);
    const project_copy = path.join(temporary_directory, "external-project-copy.lg");
    await copy_sqlite_database(source_project, project_copy);
    fixture = {
      project_path: project_copy,
      source_directory,
      complete_source,
      classification_database,
      migration_text_directory: option_text(
        options,
        "migration-text-directory",
        path.join(temporary_directory, "missing-migration-text"),
      ),
      formal_shape: null,
    };
    data_source = "external-inputs-with-project-copy";
  } else {
    const fixture_result = await worker.call({
      kind: "create-synthetic-scan",
      rootDirectory: path.join(temporary_directory, "synthetic"),
      completeCount: complete_count,
      routeCount: route_count,
      uniqueIndexCount: unique_index_count,
      uniqueTextCount: unique_text_count,
    });
    fixture = fixture_result.payload;
    data_source = fixture.formal_shape ? "synthetic-formal-shape" : "synthetic-small";
  }

  for (let index = 0; index < warmups; index += 1) {
    const staging_path = path.join(temporary_directory, `warmup-${index.toString()}.sqlite`);
    await worker.call(scan_command(fixture, staging_path));
    fs.rmSync(staging_path, { force: true });
  }

  const runs = [];
  for (let index = 0; index < repetitions; index += 1) {
    const staging_path = path.join(temporary_directory, `scan-${index.toString()}.sqlite`);
    const monitored = await monitor_operation(
      async () => await worker.call(scan_command(fixture, staging_path)),
      50,
    );
    const payload = monitored.value.payload;
    const result = payload.result;
    const report = result.report;
    const staging_exists_before_cleanup = payload.candidate_staging_exists;
    fs.rmSync(staging_path, { force: true });
    runs.push({
      wall_ms: monitored.wall_ms,
      heartbeat_drift_ms: monitored.heartbeat_drift_ms,
      maximum_heartbeat_drift_ms: monitored.maximum_heartbeat_drift_ms,
      main_heap_delta_mib: monitored.main_heap_delta_mib,
      maximum_process_rss_mib: monitored.maximum_process_rss_mib,
      worker_wall_ms: monitored.value.worker_wall_ms,
      worker_memory: monitored.value.worker_memory,
      dispatch_ack_ms: monitored.value.dispatch_ack_ms,
      applicable: Boolean(report.applicable),
      report_counts: {
        source_file_count: report.source_file_count,
        logical_text_count: report.logical_text_count,
        route_logical_text_count: report.route_logical_text_count,
        complete_jp_text_count: report.complete_jp_text_count,
        route_unique_index_count: report.route_unique_index_count,
        structural_issue_count: report.structural_issue_count,
      },
      ready_handle_bytes: payload.ready_handle_bytes,
      staging_bytes: payload.staging_bytes,
      progress_event_count: payload.progress_event_count,
      last_progress: payload.last_progress,
      staging_exists_before_cleanup,
      staging_exists_after_cleanup: fs.existsSync(staging_path),
    });
  }

  const maximum_main_heap_delta = Math.max(...runs.map((run) => run.main_heap_delta_mib));
  const maximum_heartbeat_drift = Math.max(...runs.map((run) => run.maximum_heartbeat_drift_ms));
  const maximum_handle_bytes = Math.max(...runs.map((run) => run.ready_handle_bytes));
  const all_applicable = runs.every((run) => run.applicable);
  const gates = {
    scan_applicable:
      data_source === "synthetic-small"
        ? "not-evaluated-small-fixture-is-intentionally-not-applicable"
        : all_applicable,
    main_50ms_heartbeat_max_drift_at_most_100ms: maximum_heartbeat_drift <= 100,
    main_heap_delta_less_than_128mib: maximum_main_heap_delta < 128,
    ready_handle_less_than_5mib: all_applicable
      ? maximum_handle_bytes < 5 * 1024 * 1024
      : "not-evaluated-scan-not-applicable",
    worker_rss_target_less_than_512mib:
      "not-independently-evaluable-with-worker_threads-process-rss-only",
    staging_created_for_ready_draft: all_applicable
      ? runs.every((run) => run.staging_exists_before_cleanup)
      : "not-evaluated-scan-not-applicable",
    staging_removed_after_benchmark: runs.every((run) => !run.staging_exists_after_cleanup),
    formal_shape_logical_count_941489: fixture.formal_shape
      ? runs.every((run) => run.report_counts.logical_text_count === 941_489)
      : "not-evaluated-input-is-not-formal-shape",
    progress_was_reported: runs.every((run) => run.progress_event_count > 0),
  };
  const gate_summary = build_gate_summary({
    gates,
    formal_profile_observed:
      fixture.formal_shape === true &&
      fixture.unique_text_count === 28_433 &&
      runs.every((run) => run.report_counts.logical_text_count === 941_489),
    require_complete_profile: project_argument === "" && !self_check && !allow_partial,
  });
  const report = {
    benchmark: "FE isolated scan worker and staging",
    generated_at: new Date().toISOString(),
    machine: machine_snapshot(),
    data_source,
    source_project: source_project === "" ? null : source_project,
    fixture: {
      complete_count: fixture.complete_count ?? null,
      route_count: fixture.route_count ?? null,
      route_unique_index_count: fixture.route_unique_index_count ?? null,
      unique_text_count: fixture.unique_text_count ?? null,
      formal_shape: fixture.formal_shape,
    },
    methodology: {
      scope:
        "通过独立 worker thread 调用生产 run_fate_extra_scan_worker_task；主线程以 50ms 心跳采样。",
      rss_scope:
        "worker_threads 仅暴露进程 RSS，因此报告 process-wide peak；独立 worker RSS 门槛需在 Electron/进程采样器中复核。",
      external_project_mutation: "none; project is copied through SQLite backup before scan",
      warmups,
      repetitions,
    },
    worker_start_ack_ms: worker_start.worker_start_ack_ms,
    wall_ms: summarize_samples(runs.map((run) => run.wall_ms)),
    dispatch_ack_ms: summarize_samples(runs.map((run) => run.dispatch_ack_ms)),
    main_heap_delta_mib: summarize_values(runs.map((run) => run.main_heap_delta_mib)),
    process_rss_mib: summarize_values(runs.map((run) => run.maximum_process_rss_mib)),
    heartbeat_drift_ms: summarize_samples(runs.map((run) => run.maximum_heartbeat_drift_ms)),
    runs,
    io_accounting: {
      candidate_staging_artifact_count_per_run: 1,
      sqlite_statement_count:
        "not-instrumented; node:sqlite does not expose a per-connection statement trace through the production worker boundary",
      progress_event_count: summarize_values(runs.map((run) => run.progress_event_count)),
    },
    gates,
    gate_summary,
    self_check: self_check
      ? {
          requested: true,
          scope:
            "以 2,000 complete / 400 route 的缩小 fixture 验证生产 scan worker、staging、进度、清理和报告聚合；不作为正式形状性能证据。",
        }
      : null,
    formal_data_acceptance: "not-executed-by-this-benchmark",
    warning: data_source.startsWith("synthetic")
      ? "这是合成输入结果，不得标记为正式数据实测。"
      : "该脚本测量扫描链路，但不替代正式数据的零错配/零孤儿一致性审计。",
  };
  write_json_report(report, output_path);
  if (!self_check && gate_summary.acceptance !== true) {
    process.exitCode = 1;
  }
} finally {
  if (worker !== undefined) await worker.terminate();
  cleanup_temporary_directory(temporary_directory);
}

function scan_command(fixture, staging_path) {
  return {
    kind: "scan",
    projectPath: fixture.project_path,
    sourceDirectory: fixture.source_directory,
    completeSource: fixture.complete_source,
    classificationDatabase: fixture.classification_database,
    stagingPath: staging_path,
    migrationTextDirectory: fixture.migration_text_directory,
  };
}

function required_path_option(parsed_options, key, directory) {
  const value = option_text(parsed_options, key);
  if (value === "") throw new Error(`外部扫描模式必须提供 --${key}。`);
  const resolved = path.resolve(value);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (directory ? !stat?.isDirectory() : !stat?.isFile()) {
    throw new Error(`--${key} 路径无效：${resolved}`);
  }
  return resolved;
}

function build_gate_summary({ gates, formal_profile_observed, require_complete_profile }) {
  const evaluated = [];
  const not_evaluated = [];
  for (const [key, value] of Object.entries(gates)) {
    if (typeof value === "boolean") {
      evaluated.push({ path: `gates.${key}`, value });
    } else if (typeof value === "string" && value.startsWith("not-")) {
      not_evaluated.push(`gates.${key}`);
    }
  }
  const failed_boolean_gates = evaluated
    .filter((entry) => entry.value === false)
    .map((entry) => entry.path);
  const missing_required_coverage =
    require_complete_profile && !formal_profile_observed ? ["formal_shape_941489_28433"] : [];
  return {
    evaluated_boolean_gate_count: evaluated.length,
    failed_boolean_gates,
    not_evaluated_gate_paths: not_evaluated,
    coverage: {
      formal_shape_941489_physical_and_28433_unique: formal_profile_observed,
      worker_rss: "requires-electron-or-process-level-worker-sampler",
    },
    complete_profile_required: require_complete_profile,
    missing_required_coverage,
    acceptance: failed_boolean_gates.length === 0 && missing_required_coverage.length === 0,
  };
}
