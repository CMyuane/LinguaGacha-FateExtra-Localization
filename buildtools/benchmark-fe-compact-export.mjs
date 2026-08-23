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
  round,
  summarize_samples,
  write_json_report,
} from "./lib/fe-benchmark-common.mjs";

const options = parse_benchmark_arguments(process.argv.slice(2));
if (option_boolean(options, "help")) {
  process.stdout.write(`Usage:
  npm run benchmark:fe:compact -- --project <compact.lg> --classification-database <sqlite>
  npm run benchmark:fe:compact -- --synthetic-items 100000,941489,1000000 [--synthetic-unique 28433]

Options: --page-size 5000 --warmups 0 --repetitions 3 --output <report.json>
         --self-check --allow-partial\n`);
  process.exit(0);
}
const self_check = option_boolean(options, "self-check");
const allow_partial = option_boolean(options, "allow-partial");
const project_argument = option_text(options, "project");
const classification_argument = option_text(options, "classification-database");
const page_size = option_integer(options, "page-size", 5_000, 1);
if (page_size !== 5_000) {
  throw new Error("生产精简导出 worker 的页大小固定为 5000；基准不得改写该常量。");
}
const warmups = option_integer(options, "warmups", 0, 0);
const repetitions = option_integer(options, "repetitions", self_check ? 1 : 3, 1);
const output_path = option_text(options, "output");
const synthetic_counts = parse_counts(
  option_text(options, "synthetic-items", self_check ? "1000,10000" : "100000,941489,1000000"),
);
const requested_unique_count = option_integer(
  options,
  "synthetic-unique",
  self_check ? 284 : 28_433,
  1,
);

if (project_argument !== "" && options["synthetic-items"] !== undefined) {
  throw new Error("--project 与 --synthetic-items 不能同时使用。");
}
if (project_argument !== "" && classification_argument === "") {
  throw new Error("外部 compact 工程基准必须提供 --classification-database。");
}
if (project_argument === "" && classification_argument !== "") {
  throw new Error("合成 compact 基准会创建匹配分类库，不接受 --classification-database。");
}

const temporary_directory = make_temporary_directory("linguagacha-fe-compact-benchmark-");
let worker;
try {
  const worker_file = await bundle_benchmark_worker(temporary_directory);
  worker = new BenchmarkWorker(worker_file);
  const worker_start = await worker.wait_until_ready();
  const datasets = [];
  if (project_argument !== "") {
    const source_project = path.resolve(project_argument);
    const classification_database = path.resolve(classification_argument);
    assert_file(source_project, "compact .lg project");
    assert_file(classification_database, "classification SQLite");
    const project_path = path.join(temporary_directory, "external-compact-copy.lg");
    await copy_sqlite_database(source_project, project_path);
    datasets.push({
      source: "external-copy",
      source_project,
      project_path,
      classification_database,
      physical_count_hint: null,
      setup: null,
    });
  } else {
    for (const physical_count of synthetic_counts) {
      const unique_count =
        requested_unique_count > 0
          ? Math.min(requested_unique_count, physical_count)
          : Math.max(1, Math.min(28_433, Math.round((physical_count * 28_433) / 941_489)));
      const project_path = path.join(
        temporary_directory,
        `compact-${physical_count.toString()}.lg`,
      );
      const setup = await worker.call({
        kind: "create-synthetic-compact",
        projectPath: project_path,
        physicalCount: physical_count,
        uniqueCount: unique_count,
      });
      datasets.push({
        source: "synthetic",
        project_path,
        classification_database: setup.payload.classification_database,
        physical_count_hint: physical_count,
        setup: setup.payload,
      });
    }
  }

  const results = [];
  for (const [dataset_index, dataset] of datasets.entries()) {
    for (let index = 0; index < warmups; index += 1) {
      const output_directory = path.join(
        temporary_directory,
        `warmup-${dataset_index.toString()}-${index.toString()}`,
      );
      await worker.call({
        kind: "compact-export-pass",
        projectPath: dataset.project_path,
        outputDirectory: output_directory,
        classificationDatabase: dataset.classification_database,
        pageSize: page_size,
      });
      fs.rmSync(output_directory, { recursive: true, force: true });
    }

    const runs = [];
    for (let index = 0; index < repetitions; index += 1) {
      const output_directory = path.join(
        temporary_directory,
        `run-${dataset_index.toString()}-${index.toString()}`,
      );
      const monitored = await monitor_operation(
        async () =>
          await worker.call({
            kind: "compact-export-pass",
            projectPath: dataset.project_path,
            outputDirectory: output_directory,
            classificationDatabase: dataset.classification_database,
            pageSize: page_size,
          }),
      );
      fs.rmSync(output_directory, { recursive: true, force: true });
      runs.push({
        ...monitored,
        value: monitored.value.payload,
        worker: {
          wall_ms: monitored.value.worker_wall_ms,
          memory: monitored.value.worker_memory,
          dispatch_ack_ms: monitored.value.dispatch_ack_ms,
        },
      });
    }
    const representative = runs[0].value;
    const writer_gate = runs.every(
      (run) =>
        run.value.writer_counts.json <= run.value.page_count + 2 &&
        run.value.writer_counts.csv <= run.value.page_count + 2 &&
        run.value.writer_counts.safety <= run.value.page_count + 2 &&
        run.value.writer_counts.maximum_route <= run.value.page_count + 2 &&
        run.value.writer_counts.every_file_opened_once,
    );
    results.push({
      data_source: dataset.source,
      project: dataset.source === "synthetic" ? dataset.project_path : dataset.source_project,
      setup: dataset.setup,
      physical_row_count: representative.physical_row_count,
      page_size,
      page_count: representative.page_count,
      warmups,
      repetitions,
      wall_ms: summarize_samples(runs.map((run) => run.wall_ms)),
      page_query_latency_ms: representative.query_latency_ms,
      query_count: representative.query_count,
      writer_counts: representative.writer_counts,
      output_bytes: representative.output_bytes,
      classification_fingerprint_file_count: representative.classification_fingerprint_file_count,
      progress_event_count: representative.progress_event_count,
      last_progress: representative.last_progress,
      maximum_main_heap_delta_mib: round(
        Math.max(...runs.map((run) => run.main_heap_delta_mib)),
        3,
      ),
      maximum_process_rss_mib: round(
        Math.max(...runs.map((run) => run.maximum_process_rss_mib)),
        3,
      ),
      maximum_heartbeat_drift_ms: round(
        Math.max(...runs.map((run) => run.maximum_heartbeat_drift_ms)),
        3,
      ),
      heartbeat_drift_ms: summarize_samples(
        runs.flatMap((run) => [run.maximum_heartbeat_drift_ms]),
      ),
      worker_runs: runs.map((run) => run.worker),
      explain_query_plan: representative.explain,
      gates: {
        keyset_cursor_without_offset:
          representative.cursor_strictly_increasing &&
          representative.explain.sql_uses_keyset &&
          !representative.explain.sql_uses_offset,
        writer_calls_at_most_pages_plus_two: writer_gate,
        formal_189_page_writer_limit:
          representative.page_count === 189
            ? runs.every(
                (run) =>
                  run.value.writer_counts.json <= 191 &&
                  run.value.writer_counts.csv <= 191 &&
                  run.value.writer_counts.safety <= 191 &&
                  run.value.writer_counts.maximum_route <= 191,
              )
            : "not-evaluated-page-count-is-not-189",
        query_count_equals_pages_plus_terminal_empty_page: runs.every(
          (run) => run.value.query_count === run.value.page_count + 1,
        ),
      },
    });
  }

  const scale_growth = build_scale_growth(results);
  const gate_summary = build_gate_summary({
    results,
    scale_growth,
    require_complete_profile: project_argument === "" && !self_check && !allow_partial,
  });
  const report = {
    benchmark: "FE compact keyset pagination and batched text writers",
    generated_at: new Date().toISOString(),
    machine: machine_snapshot(),
    worker_start_ack_ms: worker_start.worker_start_ack_ms,
    methodology: {
      scope:
        "在独立 benchmark worker 内直接调用生产 run_fate_extra_export_worker_task，生成完整路线、QA JSON/CSV 与安全清单，并对分类 SQLite 主库/WAL/SHM 建立稳定快照。",
      external_project_mutation: "none; SQLite backup copy is benchmarked",
      warmups,
      repetitions,
      page_size,
    },
    results,
    scale_growth,
    gate_summary,
    self_check: self_check
      ? {
          requested: true,
          scope:
            "使用 1,000/10,000 物理位置验证完整生产 export worker、主键游标、writer/查询计数、分类快照和报告聚合；不作为 189 页或 100k→1m 时延证据。",
        }
      : null,
    formal_data_acceptance: "not-executed-by-this-benchmark",
    warning:
      "合成结果只能作为性能门禁证据；正式 941,489/28,433 数据一致性仍需在外部副本上单独验收。",
  };
  write_json_report(report, output_path);
  if (!self_check && gate_summary.acceptance !== true) {
    process.exitCode = 1;
  }
} finally {
  if (worker !== undefined) await worker.terminate();
  cleanup_temporary_directory(temporary_directory);
}

function parse_counts(text) {
  const raw_counts = text.split(",").map((value) => value.trim());
  const counts = raw_counts.map(Number);
  if (
    raw_counts.length === 0 ||
    raw_counts.some((value) => value === "") ||
    counts.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error("--synthetic-items 必须是逗号分隔的正整数。");
  }
  return [...new Set(counts)];
}

function build_scale_growth(results) {
  if (results.length < 2) {
    return { status: "not-evaluated", reason: "需要至少两个 synthetic scale" };
  }
  const sorted = [...results].sort(
    (left, right) => left.physical_row_count - right.physical_row_count,
  );
  const smallest = sorted[0];
  const largest = sorted.at(-1);
  const row_ratio = largest.physical_row_count / smallest.physical_row_count;
  const time_ratio = largest.wall_ms.median_ms / smallest.wall_ms.median_ms;
  return {
    smallest_rows: smallest.physical_row_count,
    largest_rows: largest.physical_row_count,
    row_ratio: round(row_ratio, 3),
    median_time_ratio: round(time_ratio, 3),
    normalized_growth: round(time_ratio / row_ratio, 3),
    required_100k_to_1m_time_ratio_at_most_12:
      smallest.physical_row_count === 100_000 && largest.physical_row_count === 1_000_000
        ? time_ratio <= 12
        : "not-evaluated-scales-are-not-100k-and-1m",
  };
}

function build_gate_summary({ results, scale_growth, require_complete_profile }) {
  const evaluated = [];
  const not_evaluated = [];
  for (const [result_index, result] of results.entries()) {
    collect_gate_values(
      `results[${result_index.toString()}].gates`,
      result.gates,
      evaluated,
      not_evaluated,
    );
  }
  collect_gate_values("scale_growth", scale_growth, evaluated, not_evaluated);
  const physical_counts = new Set(results.map((result) => result.physical_row_count));
  const coverage = {
    contains_100k_and_1m_scales: physical_counts.has(100_000) && physical_counts.has(1_000_000),
    contains_189_page_dataset: results.some((result) => result.page_count === 189),
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
    acceptance: failed_boolean_gates.length === 0 && missing_required_coverage.length === 0,
  };
}

function collect_gate_values(prefix, value, evaluated, not_evaluated) {
  for (const [key, result] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    if (typeof result === "boolean") {
      evaluated.push({ path, value: result });
    } else if (typeof result === "string" && result.startsWith("not-evaluated")) {
      not_evaluated.push(path);
    }
  }
}

function assert_file(file_path, label) {
  if (!fs.statSync(file_path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${label} 不存在：${file_path}`);
  }
}
