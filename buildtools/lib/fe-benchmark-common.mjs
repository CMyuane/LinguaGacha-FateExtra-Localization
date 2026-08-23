import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { backup, DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { build } from "esbuild";

const WORKER_ENTRY = path.resolve("buildtools", "lib", "fe-benchmark-worker-entry.ts");

export function parse_benchmark_arguments(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      result._.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    if (separator >= 0) {
      append_option(result, argument.slice(2, separator), argument.slice(separator + 1));
      continue;
    }
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      append_option(result, key, next);
      index += 1;
    } else {
      append_option(result, key, true);
    }
  }
  return result;
}

export function option_text(options, key, fallback = "") {
  const value = options[key];
  if (Array.isArray(value)) return String(value.at(-1) ?? fallback);
  return value === undefined || value === true ? fallback : String(value);
}

export function option_texts(options, key) {
  const value = options[key];
  if (value === undefined || value === true) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

export function option_integer(options, key, fallback, minimum = 0) {
  const text = option_text(options, key, String(fallback));
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${key} 必须是大于等于 ${minimum.toString()} 的整数。`);
  }
  return value;
}

export function option_boolean(options, key) {
  const value = options[key];
  if (value === undefined) return false;
  if (value === true) return true;
  const text = String(Array.isArray(value) ? value.at(-1) : value).toLowerCase();
  return text !== "false" && text !== "0" && text !== "no";
}

export function machine_snapshot() {
  const cpu = os.cpus();
  return {
    hostname: os.hostname(),
    cpu_model: cpu[0]?.model ?? "unknown",
    logical_cpu_count: cpu.length,
    total_memory_mib: round(os.totalmem() / 1024 / 1024, 1),
    platform: process.platform,
    architecture: process.arch,
    os_release: os.release(),
    node: process.version,
    v8: process.versions.v8,
    sqlite: DatabaseSync.prototype.constructor.name === "DatabaseSync" ? "node:sqlite" : "unknown",
    sqlite_version: process.versions.sqlite ?? "unknown",
  };
}

export function summarize_samples(samples) {
  if (samples.length === 0) {
    return { count: 0, min_ms: null, median_ms: null, p95_ms: null, p99_ms: null, max_ms: null };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min_ms: round(sorted[0], 3),
    median_ms: round(percentile(sorted, 50), 3),
    p95_ms: round(percentile(sorted, 95), 3),
    p99_ms: round(percentile(sorted, 99), 3),
    max_ms: round(sorted.at(-1), 3),
  };
}

export function summarize_values(samples) {
  if (samples.length === 0) {
    return { count: 0, min: null, median: null, p95: null, p99: null, max: null };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min: round(sorted[0], 3),
    median: round(percentile(sorted, 50), 3),
    p95: round(percentile(sorted, 95), 3),
    p99: round(percentile(sorted, 99), 3),
    max: round(sorted.at(-1), 3),
  };
}

export function memory_snapshot() {
  const memory = process.memoryUsage();
  return {
    heap_used_mib: round(memory.heapUsed / 1024 / 1024, 3),
    heap_total_mib: round(memory.heapTotal / 1024 / 1024, 3),
    rss_mib: round(memory.rss / 1024 / 1024, 3),
    external_mib: round(memory.external / 1024 / 1024, 3),
  };
}

export async function bundle_benchmark_worker(temporary_directory) {
  const outfile = path.join(temporary_directory, "fe-benchmark-worker.mjs");
  await build({
    entryPoints: [WORKER_ENTRY],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    logLevel: "silent",
  });
  return outfile;
}

export class BenchmarkWorker {
  constructor(worker_file) {
    this.worker = new Worker(worker_file);
    this.sequence = 0;
    this.pending = new Map();
    this.ready = null;
    this.ready_promise = new Promise((resolve, reject) => {
      this.ready = { resolve, reject, started_at: performance.now() };
    });
    this.worker.on("message", (message) => this.handle_message(message));
    this.worker.on("error", (error) => this.handle_terminal_error(error));
    this.worker.on("exit", (code) => {
      if (code !== 0) this.handle_terminal_error(new Error(`benchmark worker exited ${code}`));
    });
  }

  async wait_until_ready() {
    return await this.ready_promise;
  }

  async call(command) {
    const request = await this.start_call(command);
    await request.started;
    return await request.completion;
  }

  async start_call(command) {
    await this.wait_until_ready();
    const id = (this.sequence += 1);
    let resolve_started;
    let reject_started;
    const started = new Promise((resolve, reject) => {
      resolve_started = resolve;
      reject_started = reject;
    });
    const completion = new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        resolve_started,
        reject_started,
        started_settled: false,
        sent_at: performance.now(),
        dispatch_ack_ms: null,
      });
      this.worker.postMessage({ id, command });
    });
    return { started, completion };
  }

  async terminate() {
    return await this.begin_termination().completion;
  }

  begin_termination() {
    const started = performance.now();
    const completion = this.worker.terminate().then((exit_code) => ({
      exit_code,
      worker_exit_ms: round(performance.now() - started, 3),
    }));
    return {
      cancel_dispatch_ack_ms: round(performance.now() - started, 3),
      completion,
    };
  }

  handle_message(message) {
    if (message?.type === "ready") {
      if (this.ready !== null) {
        this.ready.resolve({
          worker_start_ack_ms: round(performance.now() - this.ready.started_at, 3),
        });
        this.ready = null;
      }
      return;
    }
    const record = this.pending.get(message?.id);
    if (record === undefined) return;
    if (message.type === "started") {
      record.dispatch_ack_ms = round(performance.now() - record.sent_at, 3);
      record.started_settled = true;
      record.resolve_started({ dispatch_ack_ms: record.dispatch_ack_ms });
      return;
    }
    this.pending.delete(message.id);
    if (message.type === "result") {
      record.resolve({ ...message.result, dispatch_ack_ms: record.dispatch_ack_ms });
    } else {
      const error = new Error(message.error?.message ?? "benchmark worker failed");
      error.stack = message.error?.stack ?? error.stack;
      record.reject(error);
    }
  }

  handle_terminal_error(error) {
    if (this.ready !== null) {
      this.ready.reject(error);
      this.ready = null;
    }
    for (const record of this.pending.values()) {
      if (!record.started_settled) record.reject_started(error);
      record.reject(error);
    }
    this.pending.clear();
  }
}

export async function monitor_operation(work, interval_ms = 50) {
  const memory_before = memory_snapshot();
  let maximum_rss_mib = memory_before.rss_mib;
  let maximum_heartbeat_drift_ms = 0;
  const heartbeat_drift_samples = [];
  let last_heartbeat = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maximum_heartbeat_drift_ms = Math.max(
      maximum_heartbeat_drift_ms,
      now - last_heartbeat - interval_ms,
    );
    heartbeat_drift_samples.push(Math.max(0, now - last_heartbeat - interval_ms));
    last_heartbeat = now;
    maximum_rss_mib = Math.max(maximum_rss_mib, memory_snapshot().rss_mib);
  }, interval_ms);
  const started = performance.now();
  try {
    const value = await work();
    const memory_after = memory_snapshot();
    maximum_rss_mib = Math.max(maximum_rss_mib, memory_after.rss_mib);
    return {
      value,
      wall_ms: round(performance.now() - started, 3),
      heartbeat_interval_ms: interval_ms,
      maximum_heartbeat_drift_ms: round(maximum_heartbeat_drift_ms, 3),
      heartbeat_drift_ms: summarize_samples(heartbeat_drift_samples),
      memory_before,
      memory_after,
      main_heap_delta_mib: round(memory_after.heap_used_mib - memory_before.heap_used_mib, 3),
      maximum_process_rss_mib: round(maximum_rss_mib, 3),
    };
  } finally {
    clearInterval(timer);
  }
}

export async function copy_sqlite_database(source, target) {
  const database = new DatabaseSync(path.resolve(source), { readOnly: true });
  try {
    await backup(database, path.resolve(target));
  } finally {
    database.close();
  }
}

export function make_temporary_directory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup_temporary_directory(directory) {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function write_json_report(report, output_path) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output_path !== "") {
    const resolved = path.resolve(output_path);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, text, "utf-8");
  }
  process.stdout.write(text);
}

export function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function append_option(result, key, value) {
  const previous = result[key];
  if (previous === undefined) {
    result[key] = value;
  } else if (Array.isArray(previous)) {
    previous.push(value);
  } else {
    result[key] = [previous, value];
  }
}

function percentile(sorted, percentage) {
  const index = Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1);
  return sorted[index];
}
