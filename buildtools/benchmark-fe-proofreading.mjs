import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const options = parse_arguments(process.argv.slice(2));
if (read_boolean(options, "help")) {
  process.stdout.write(`Usage:
  npm run benchmark:fe:proofreading
  npm run benchmark:fe:proofreading -- --items 28433 --warmups 5 --repetitions 100

Options: --window-count 160 --output <report.json> --self-check\n`);
  process.exit(0);
}
if (typeof globalThis.gc !== "function") {
  throw new Error(
    "校对缓存基准必须使用 --expose-gc；请通过 npm run benchmark:fe:proofreading 执行。",
  );
}

const self_check = read_boolean(options, "self-check");
const benchmark_options = {
  item_count: read_integer(options, "items", self_check ? 64 : 28_433, 1),
  warmups: read_integer(options, "warmups", self_check ? 1 : 5, 0),
  repetitions: read_integer(options, "repetitions", self_check ? 3 : 100, 1),
  window_count: read_integer(options, "window-count", self_check ? 16 : 160, 1),
};
const output_path = read_text(options, "output");
const temporary_directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "linguagacha-fe-proofreading-benchmark-"),
);

try {
  const bundled_entry = path.join(temporary_directory, "proofreading-benchmark-entry.mjs");
  await build({
    entryPoints: [path.resolve("buildtools", "lib", "fe-proofreading-benchmark-entry.ts")],
    outfile: bundled_entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
  });
  const { run_proofreading_benchmark } = await import(pathToFileURL(bundled_entry).href);
  const report = await run_proofreading_benchmark(benchmark_options);
  if (self_check) {
    verify_report_shape(report, benchmark_options);
    report.self_check = {
      requested: true,
      passed: true,
      scope: "仅校验报告结构、样本数和热路径计数；不对易受机器抖动影响的时延门槛作进程断言。",
    };
  }
  write_report(report, output_path);
  if (!self_check && report.gates.acceptance !== true) {
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(temporary_directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function parse_arguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`无法识别的位置参数：${argument}`);
    }
    const separator = argument.indexOf("=");
    if (separator >= 0) {
      result[argument.slice(2, separator)] = argument.slice(separator + 1);
      continue;
    }
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function read_text(parsed_options, key, fallback = "") {
  const value = parsed_options[key];
  return value === undefined || value === true ? fallback : String(value);
}

function read_integer(parsed_options, key, fallback, minimum) {
  const value = Number(read_text(parsed_options, key, String(fallback)));
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${key} 必须是大于等于 ${minimum.toString()} 的整数。`);
  }
  return value;
}

function read_boolean(parsed_options, key) {
  const value = parsed_options[key];
  if (value === undefined) return false;
  if (value === true) return true;
  const normalized = String(value).toLowerCase();
  return normalized !== "false" && normalized !== "0" && normalized !== "no";
}

function verify_report_shape(report, expected) {
  const failures = [];
  if (report.data.item_count !== expected.item_count) failures.push("item_count");
  for (const operation of ["sync", "list", "filter_panel", "window"]) {
    if (report.latency_ms[operation].count !== expected.repetitions) {
      failures.push(`${operation}.count`);
    }
  }
  if (report.accounting.cold.read_items !== 1) failures.push("cold.read_items");
  if (report.accounting.cold.get_all_items !== 0) failures.push("cold.get_all_items");
  if (report.accounting.cold.worker_sync !== 1) failures.push("cold.worker_sync");
  if (report.cold_sync.synced_row_count !== expected.item_count) {
    failures.push("cold_sync.synced_row_count");
  }
  if (report.result_shape.list_row_count !== expected.item_count) {
    failures.push("result_shape.list_row_count");
  }
  if (
    report.result_shape.window_row_count !== Math.min(expected.window_count, expected.item_count)
  ) {
    failures.push("result_shape.window_row_count");
  }
  for (const counter of ["read_items", "get_all_items", "worker_sync"]) {
    if (report.accounting.measured_hot_delta[counter] !== 0) {
      failures.push(`measured_hot_delta.${counter}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`校对缓存基准自检失败：${failures.join(", ")}`);
  }
}

function write_report(report, requested_output_path) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (requested_output_path !== "") {
    const resolved = path.resolve(requested_output_path);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, text, "utf-8");
  }
  process.stdout.write(text);
}
