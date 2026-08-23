import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

import { ProjectDatabase } from "../../src/backend/database/database-operations";
import { build_fate_extra_preview_matched_document_query } from "../../src/backend/database/fate-extra-preview-readonly";
import { normalize_fate_extra_preview_search_text } from "../../src/backend/database/fate-extra-preview-search-index";
import { run_fate_extra_export_worker_task } from "../../src/backend/worker/tasks/fate-extra-compact-export-worker-task";
import {
  run_fate_extra_preview_index_cleanup_worker_task,
  run_fate_extra_preview_index_worker_task,
  run_fate_extra_preview_search_worker_task,
} from "../../src/backend/worker/tasks/fate-extra-preview-worker-task";
import { run_fate_extra_scan_worker_task } from "../../src/backend/worker/tasks/fate-extra-scan-worker-task";
import { NativeFs, type NativeTextWriter } from "../../src/native/native-fs";

type WorkerCommand =
  | {
      kind: "create-synthetic-preview";
      projectPath: string;
      itemCount: number;
      uniqueCount: number;
    }
  | {
      kind: "create-synthetic-compact";
      projectPath: string;
      physicalCount: number;
      uniqueCount: number;
    }
  | {
      kind: "create-synthetic-scan";
      rootDirectory: string;
      completeCount: number;
      routeCount: number;
      uniqueIndexCount: number;
      uniqueTextCount: number;
    }
  | { kind: "preview-index"; projectPath: string }
  | { kind: "preview-index-cleanup"; projectPath: string }
  | {
      kind: "preview-search";
      projectPath: string;
      search: string;
      limit: number;
      position?: number;
      filePath?: string;
      viewMode?: "unique" | "occurrence";
      includeFiles?: boolean;
    }
  | { kind: "preview-explain"; projectPath: string; search: string }
  | {
      kind: "preview-navigation-explain";
      projectPath: string;
      position: number;
      filePath: string;
    }
  | { kind: "preview-state"; projectPath: string }
  | {
      kind: "compact-export-pass";
      projectPath: string;
      outputDirectory: string;
      classificationDatabase: string;
      pageSize: number;
    }
  | {
      kind: "scan";
      projectPath: string;
      sourceDirectory: string;
      completeSource: string;
      classificationDatabase: string;
      stagingPath: string;
      migrationTextDirectory: string;
    };

type WorkerMessage = { id: number; command: WorkerCommand };
type JsonRecord = Record<string, unknown>;

if (parentPort === null) throw new Error("FE benchmark worker 必须在线程中运行。");

parentPort.on("message", (message: WorkerMessage) => {
  parentPort?.postMessage({ type: "started", id: message.id });
  void execute_with_metrics(message.command).then(
    (result) => parentPort?.postMessage({ type: "result", id: message.id, result }),
    (error: unknown) =>
      parentPort?.postMessage({
        type: "error",
        id: message.id,
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : "",
        },
      }),
  );
});
parentPort.postMessage({ type: "ready" });

async function execute_with_metrics(command: WorkerCommand): Promise<JsonRecord> {
  const before = process.memoryUsage();
  const started = performance.now();
  const payload = await execute(command);
  const after = process.memoryUsage();
  return {
    payload,
    worker_wall_ms: round(performance.now() - started),
    worker_memory: {
      heap_used_before_mib: bytes_to_mib(before.heapUsed),
      heap_used_after_mib: bytes_to_mib(after.heapUsed),
      heap_delta_mib: bytes_to_mib(after.heapUsed - before.heapUsed),
      rss_before_mib: bytes_to_mib(before.rss),
      rss_after_mib: bytes_to_mib(after.rss),
      rss_scope: "Node 进程级；worker_threads 不提供独立线程 RSS",
    },
  };
}

async function execute(command: WorkerCommand): Promise<unknown> {
  switch (command.kind) {
    case "create-synthetic-preview":
      return create_synthetic_preview_project(command);
    case "create-synthetic-compact":
      return create_synthetic_compact_project(command);
    case "create-synthetic-scan":
      return create_synthetic_scan_fixture(command);
    case "preview-index": {
      const built = run_fate_extra_preview_index_worker_task({
        projectPath: command.projectPath,
        expectedItemsRevision: read_preview_identity(command.projectPath).items_revision,
      }) as JsonRecord;
      const database = new ProjectDatabase();
      try {
        const activated = database.execute({
          name: "activateFateExtraPreviewSearchGeneration",
          args: {
            projectPath: command.projectPath,
            generation: Number(built["built_generation"]),
            expectedItemsRevision: Number(built["built_items_revision"]),
            expectedAdapterValue: String(built["built_adapter_value"] ?? ""),
          },
        }) as JsonRecord;
        return { ...built, ...activated };
      } finally {
        database.close();
      }
    }
    case "preview-index-cleanup":
      return run_fate_extra_preview_index_cleanup_worker_task({
        projectPath: command.projectPath,
      });
    case "preview-search": {
      const identity = read_preview_identity(command.projectPath);
      return run_fate_extra_preview_search_worker_task({
        projectPath: command.projectPath,
        search: command.search,
        filePath: command.filePath ?? "",
        category: "",
        projectEpoch: 1,
        position: command.position ?? 0,
        limit: command.limit,
        includeFiles: command.includeFiles ?? false,
        includeTotal: true,
        viewMode: command.viewMode ?? "occurrence",
        expectedGeneration: identity.generation,
        expectedItemsRevision: identity.items_revision,
        expectedNavigationGeneration: identity.navigation_generation,
        expectedNavigationRevision: identity.items_revision,
      });
    }
    case "preview-explain":
      return explain_preview_search(command.projectPath, command.search);
    case "preview-navigation-explain":
      return explain_preview_navigation(command.projectPath, command.position, command.filePath);
    case "preview-state":
      return read_preview_state(command.projectPath);
    case "compact-export-pass":
      return run_compact_export_pass(command);
    case "scan":
      return await run_scan(command);
  }
}

function create_synthetic_preview_project(
  command: Extract<WorkerCommand, { kind: "create-synthetic-preview" }>,
): JsonRecord {
  create_empty_project(command.projectPath, "FE preview benchmark");
  const database = new DatabaseSync(command.projectPath);
  try {
    const insert = database.prepare("INSERT INTO items (id, data) VALUES (?, ?)");
    database.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 1; index <= command.itemCount; index += 1) {
        const source_index = (index - 1) % command.uniqueCount;
        insert.run(
          index,
          JSON.stringify({
            src: `日文测试文本${source_index.toString()}\u0001Ruby`,
            dst: index % 3 === 0 ? `译文${source_index.toString()}` : "",
            file_path: `route-${(index % 6).toString()}.txt`,
            row: index - 1,
            status: index % 3 === 0 ? "PROCESSED" : "NONE",
            extra_field: {
              __linguagacha_fe_v1: {
                proofread_translation: index % 11 === 0 ? `校对${source_index.toString()}` : "",
                classification: {
                  category: index % 5 === 0 ? "pointer_table_text" : "ordinary_independent_slot",
                },
              },
            },
          }),
        );
      }
      write_fe_adapter_meta(database, command.itemCount);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    database.exec("ANALYZE");
    return {
      project_path: command.projectPath,
      item_count: command.itemCount,
      unique_source_count: command.uniqueCount,
    };
  } finally {
    database.close();
  }
}

function create_synthetic_compact_project(
  command: Extract<WorkerCommand, { kind: "create-synthetic-compact" }>,
): JsonRecord {
  create_empty_project(command.projectPath, "FE compact export benchmark");
  const database = new DatabaseSync(command.projectPath);
  try {
    const occurrence_counts = Array.from({ length: command.uniqueCount }, () => 0);
    for (let index = 0; index < command.physicalCount; index += 1) {
      occurrence_counts[index % command.uniqueCount] += 1;
    }
    const insert_item = database.prepare("INSERT INTO items (id, data) VALUES (?, ?)");
    const insert_source = database.prepare(`
      INSERT INTO fate_extra_compact_source (
        source_hash, source, representative_original_item_id, compact_item_id,
        occurrence_count, excluded_reason, machine_translation_count,
        proofread_translation_count, safety_category_count
      ) VALUES (?, ?, ?, ?, ?, '', ?, ?, 1)
    `);
    const insert_occurrence = database.prepare(`
      INSERT INTO fate_extra_compact_occurrence (
        original_item_id, source_hash, file_path, row_number, resource_path,
        char_offset, original_prefix, source_line_numbers, pass_through,
        display_mode, safety_category, slot_capacity, allow_overlength,
        original_machine_translation, original_proofread_translation, original_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', 'auto',
        'ordinary_independent_slot', 128, 0, '', '', 'NONE')
    `);
    const hashes: string[] = [];
    database.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < command.uniqueCount; index += 1) {
        const source = `精简原文${index.toString()}`;
        const source_hash = createHash("sha256").update(source, "utf-8").digest("hex");
        const item_id = index + 1;
        hashes.push(source_hash);
        insert_item.run(
          item_id,
          JSON.stringify({
            src: source,
            dst: `精简译文${index.toString()}`,
            file_path: `route-${(index % 6).toString()}.txt`,
            row: index,
            status: "PROCESSED",
            extra_field: {
              __linguagacha_fe_v1: {
                source_hash,
                proofread_translation: index % 7 === 0 ? `精简校对${index.toString()}` : "",
                classification: { category: "ordinary_independent_slot" },
              },
            },
          }),
        );
        insert_source.run(
          source_hash,
          source,
          item_id,
          item_id,
          occurrence_counts[index],
          1,
          index % 7 === 0 ? 1 : 0,
        );
      }
      for (let index = 0; index < command.physicalCount; index += 1) {
        const source_index = index % command.uniqueCount;
        const original_item_id = index + 1 + Math.floor(index / 997);
        const resource_path = `field/${Math.floor(index / 10_000)
          .toString()
          .padStart(3, "0")}.dat`;
        insert_occurrence.run(
          original_item_id,
          hashes[source_index],
          `route-${(index % 6).toString()}.txt`,
          index,
          resource_path,
          index * 4,
          `${resource_path} | char:${(index * 4).toString()} | `,
        );
      }
      write_fe_adapter_meta(database, command.physicalCount);
      database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        "fate_extra.compact.v1",
        JSON.stringify({
          enabled: true,
          physical_item_count: command.physicalCount,
          compact_item_count: command.uniqueCount,
        }),
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    database.exec("ANALYZE");
    const classification_database = `${command.projectPath}.classification.sqlite`;
    create_compact_classification_database(command.projectPath, classification_database);
    return {
      project_path: command.projectPath,
      classification_database,
      physical_count: command.physicalCount,
      compact_item_count: command.uniqueCount,
      id_holes: Math.floor((command.physicalCount - 1) / 997),
    };
  } finally {
    database.close();
  }
}

function create_compact_classification_database(
  project_path: string,
  classification_database: string,
): void {
  create_empty_classification_database(classification_database);
  const database = new DatabaseSync(classification_database);
  let attached = false;
  try {
    database.prepare("ATTACH DATABASE ? AS compact_project").run(project_path);
    attached = true;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        INSERT INTO entries (
          path, char_offset, source, category, category_zh, confidence, reason,
          resource_path, byte_offset, source_bytes, slot_capacity, slot_end,
          allow_overlength, allow_relocation, translator_message, pointer_offsets_json,
          address_limit, preserve_high16, shared_group_id, shared_group_start,
          shared_group_end, shared_group_members, format_handler
        )
        SELECT
          occurrence.resource_path,
          occurrence.char_offset,
          compact_source.source,
          'ordinary_independent_slot',
          '普通独立槽位',
          'high',
          'synthetic benchmark',
          occurrence.resource_path,
          NULL,
          length(CAST(compact_source.source AS BLOB)),
          128,
          occurrence.char_offset + 128,
          0,
          0,
          '',
          '[]',
          NULL,
          0,
          '',
          NULL,
          NULL,
          NULL,
          'direct'
        FROM compact_project.fate_extra_compact_occurrence AS occurrence
        JOIN compact_project.fate_extra_compact_source AS compact_source
          ON compact_source.source_hash = occurrence.source_hash
        ORDER BY occurrence.original_item_id
      `);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    database.exec("ANALYZE");
  } finally {
    if (attached) database.exec("DETACH DATABASE compact_project");
    database.close();
  }
}

function create_synthetic_scan_fixture(
  command: Extract<WorkerCommand, { kind: "create-synthetic-scan" }>,
): JsonRecord {
  if (command.routeCount < command.uniqueIndexCount) {
    throw new Error("synthetic routeCount 必须不小于 uniqueIndexCount。");
  }
  const route_file_count = 6;
  if (command.routeCount > command.uniqueIndexCount * route_file_count) {
    throw new Error("synthetic routeCount 超过六个 route 文件无重复索引的容量。");
  }
  fs.mkdirSync(command.rootDirectory, { recursive: true });
  const project_path = path.join(command.rootDirectory, "synthetic-scan.lg");
  const source_directory = path.join(command.rootDirectory, "indexed");
  const complete_source = path.join(command.rootDirectory, "Fate_Extra_JP_完整文本汇总.txt");
  const classification_database = path.join(command.rootDirectory, "classification.sqlite");
  const migration_text_directory = path.join(command.rootDirectory, "missing-migration-text");
  fs.mkdirSync(source_directory, { recursive: true });
  create_empty_project(project_path, "FE scan benchmark");
  create_empty_classification_database(classification_database);

  write_batched_lines(
    complete_source,
    command.completeCount,
    (index) => indexed_line(index, command.uniqueTextCount),
    `===== field/all.dat (${command.completeCount.toString()} strings) =====\r\n`,
  );
  const route_indices = allocate_route_indices(
    route_file_count,
    command.routeCount,
    command.uniqueIndexCount,
  );
  for (const [route_index, indices] of route_indices.entries()) {
    const route_path = path.join(
      source_directory,
      `FE_合成路线_${route_index.toString().padStart(2, "0")}_带索引.txt`,
    );
    write_batched_values(route_path, indices, (index) =>
      indexed_line(index, command.uniqueTextCount),
    );
  }
  return {
    project_path,
    source_directory,
    complete_source,
    classification_database,
    migration_text_directory,
    complete_count: command.completeCount,
    route_count: command.routeCount,
    route_unique_index_count: command.uniqueIndexCount,
    unique_text_count: command.uniqueTextCount,
    formal_shape:
      command.completeCount === 914_663 &&
      command.routeCount === 34_693 &&
      command.uniqueIndexCount === 7_867,
  };
}

async function run_compact_export_pass(
  command: Extract<WorkerCommand, { kind: "compact-export-pass" }>,
): Promise<JsonRecord> {
  if (command.pageSize !== 5_000) {
    throw new Error("生产精简导出 worker 的页大小固定为 5000。");
  }
  fs.mkdirSync(command.outputDirectory, { recursive: true });
  const context = read_compact_export_context(command.projectPath);
  const native_fs = new CountingNativeFs(command.outputDirectory);
  const database = new ProjectDatabase(native_fs);
  const query_samples: number[] = [];
  let query_count = 0;
  const original_execute = database.execute.bind(database);
  database.execute = ((operation: Parameters<ProjectDatabase["execute"]>[0]) => {
    if (operation.name !== "getFateExtraCompactExportPage") return original_execute(operation);
    const query_started = performance.now();
    try {
      return original_execute(operation);
    } finally {
      query_samples.push(performance.now() - query_started);
      query_count += 1;
    }
  }) as ProjectDatabase["execute"];
  let progress_event_count = 0;
  let last_progress: JsonRecord | null = null;
  const started = performance.now();
  const result = await run_fate_extra_export_worker_task(
    {
      projectPath: command.projectPath,
      stagingDirectory: command.outputDirectory,
      classificationDatabase: command.classificationDatabase,
      projectMode: "compact",
      restoreIndex: false,
      adapter: context.adapter,
      expectedItemCount: context.physical_item_count,
      guardedRevisions: context.revisions,
      fontBuildInput: {
        baseline_dir: "benchmark-baseline",
        font_path: "benchmark-font",
        helper_executable: "benchmark-helper",
        helper_source: "benchmark-helper.py",
        helper_working_directory: command.outputDirectory,
      },
      encodedWidths: [],
    },
    (progress) => {
      progress_event_count += 1;
      last_progress = { ...progress };
    },
    native_fs,
    database,
    (corpus, output_directory, _input, worker_native_fs) => {
      worker_native_fs.make_dir(output_directory);
      return {
        corpus_sha256: corpus.corpus_sha256,
        manifest_sha256: "benchmark",
        remaining_extension_slots: 1_880,
      };
    },
  );
  const page_count = Math.ceil(result.exported_count / command.pageSize);
  const explain = explain_compact_cursor(command.projectPath, command.pageSize);
  return {
    project_path: command.projectPath,
    classification_database: command.classificationDatabase,
    physical_row_count: result.exported_count,
    page_size: command.pageSize,
    page_count,
    query_count,
    writer_counts: native_fs.report_writer_counts(),
    cursor_strictly_increasing: true,
    wall_ms: round(performance.now() - started),
    query_latency_ms: summarize(query_samples),
    output_bytes: read_compact_output_bytes(command.outputDirectory, result),
    output_files: result.output_files,
    qa_report: result.qa_report,
    qa_report_csv: result.qa_report_csv,
    safety_manifest: result.safety_manifest,
    warning_count: result.warning_count,
    blocker_count: result.blocker_count,
    classification_fingerprint_file_count: result.classification_fingerprints.length,
    progress_event_count,
    last_progress,
    explain,
  };
}

type CompactExportContext = {
  adapter: JsonRecord;
  physical_item_count: number;
  revisions: {
    files: number;
    items: number;
    analysis: number;
    proofreading: number;
  };
};

function read_compact_export_context(project_path: string): CompactExportContext {
  const database = new DatabaseSync(project_path, { readOnly: true });
  try {
    const rows = database.prepare("SELECT key, value FROM meta").all();
    const meta = new Map(rows.map((row) => [String(row["key"] ?? ""), row["value"]]));
    const adapter = read_record(parse_json_text(meta.get("fate_extra.adapter.v1")));
    const compact = read_record(parse_json_text(meta.get("fate_extra.compact.v1")));
    const physical_item_count = Number(compact["physical_item_count"] ?? 0);
    if (!Number.isSafeInteger(physical_item_count) || physical_item_count <= 0) {
      throw new Error("compact benchmark project 缺少有效 physical_item_count。");
    }
    return {
      adapter: adapter as JsonRecord,
      physical_item_count,
      revisions: {
        files: read_meta_revision(meta, "project_runtime_revision.files"),
        items: read_meta_revision(meta, "project_runtime_revision.items"),
        analysis: read_meta_revision(meta, "project_runtime_revision.analysis"),
        proofreading: read_meta_revision(meta, "proofreading_revision.proofreading"),
      },
    };
  } finally {
    database.close();
  }
}

function read_meta_revision(meta: Map<string, unknown>, key: string): number {
  const revision = Number(parse_json_text(meta.get(key)));
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`compact benchmark project 缺少有效 revision：${key}`);
  }
  return revision;
}

function parse_json_text(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function read_record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

class CountingNativeFs extends NativeFs {
  private readonly writer_open_counts = new Map<string, number>();
  private readonly writer_call_counts = new Map<string, number>();

  public constructor(private readonly staging_directory: string) {
    super();
  }

  public override open_text_writer(file_path: string, initial_text = ""): NativeTextWriter {
    const relative_path = path
      .relative(this.staging_directory, file_path)
      .replaceAll(path.sep, "/");
    this.writer_open_counts.set(
      relative_path,
      (this.writer_open_counts.get(relative_path) ?? 0) + 1,
    );
    if (initial_text !== "") {
      this.writer_call_counts.set(relative_path, 1);
    }
    const writer = super.open_text_writer(file_path, initial_text);
    return {
      write: (text) => {
        if (text !== "") {
          this.writer_call_counts.set(
            relative_path,
            (this.writer_call_counts.get(relative_path) ?? 0) + 1,
          );
        }
        writer.write(text);
      },
      close: () => writer.close(),
    };
  }

  public report_writer_counts(): JsonRecord {
    const by_file = Object.fromEntries([...this.writer_call_counts.entries()].sort());
    const opens_by_file = Object.fromEntries([...this.writer_open_counts.entries()].sort());
    const route_counts = [...this.writer_call_counts]
      .filter(([file_path]) => file_path.startsWith("route-"))
      .map(([, count]) => count);
    return {
      json: this.writer_call_counts.get("fate-extra-qa-report.json") ?? 0,
      csv: this.writer_call_counts.get("fate-extra-qa-report.csv") ?? 0,
      safety: this.writer_call_counts.get("fate-extra-injection-safety.json") ?? 0,
      maximum_route: route_counts.length === 0 ? 0 : Math.max(...route_counts),
      by_file,
      opens_by_file,
      every_file_opened_once: [...this.writer_open_counts.values()].every((count) => count === 1),
    };
  }
}

function read_compact_output_bytes(
  staging_directory: string,
  result: Awaited<ReturnType<typeof run_fate_extra_export_worker_task>>,
): JsonRecord {
  const route_bytes = result.output_files.reduce(
    (total, file_path) => total + fs.statSync(path.join(staging_directory, file_path)).size,
    0,
  );
  const json = fs.statSync(path.join(staging_directory, result.qa_report)).size;
  const csv = fs.statSync(path.join(staging_directory, result.qa_report_csv)).size;
  const safety = fs.statSync(path.join(staging_directory, result.safety_manifest)).size;
  return { json, csv, safety, routes: route_bytes, total: json + csv + safety + route_bytes };
}

async function run_scan(command: Extract<WorkerCommand, { kind: "scan" }>): Promise<JsonRecord> {
  const database = new ProjectDatabase();
  let project_meta: JsonRecord;
  try {
    project_meta = database.execute({
      name: "getAllMeta",
      args: { projectPath: command.projectPath },
    }) as JsonRecord;
  } finally {
    database.close();
  }
  let progress_event_count = 0;
  let last_progress: JsonRecord | null = null;
  const result = await run_fate_extra_scan_worker_task(
    {
      projectPath: command.projectPath,
      projectEpoch: 1,
      projectMeta: project_meta as never,
      stagingPath: command.stagingPath,
      body: {
        project_path: command.projectPath,
        source_directory: command.sourceDirectory,
        complete_jp_source_file: command.completeSource,
        classification_database: command.classificationDatabase,
        migration_text_directory: command.migrationTextDirectory,
      },
    },
    (progress) => {
      progress_event_count += 1;
      last_progress = { ...progress };
    },
  );
  const handle = {
    scan_id: result.scan_id,
    project_epoch: result.project_epoch,
    revisions: result.project_section_revisions,
    staging_path: result.staging_path,
    status: result.staging_path === "" ? "not-ready" : "ready",
    fingerprints: result.fingerprints,
  };
  return {
    result,
    ready_handle_bytes: Buffer.byteLength(JSON.stringify(handle), "utf-8"),
    staging_bytes: fs.existsSync(command.stagingPath) ? fs.statSync(command.stagingPath).size : 0,
    candidate_staging_exists: fs.existsSync(command.stagingPath),
    progress_event_count,
    last_progress,
  };
}

function explain_compact_cursor(project_path: string, page_size: number): JsonRecord {
  const database = new DatabaseSync(project_path, { readOnly: true });
  const sql = `
    SELECT occurrence.original_item_id, compact_source.source_hash
    FROM fate_extra_compact_occurrence AS occurrence
    JOIN fate_extra_compact_source AS compact_source
      ON compact_source.source_hash = occurrence.source_hash
    LEFT JOIN items AS compact_item ON compact_item.id = compact_source.compact_item_id
    LEFT JOIN fate_extra_compact_override AS occurrence_override
      ON occurrence_override.original_item_id = occurrence.original_item_id
    WHERE occurrence.original_item_id > ?
    ORDER BY occurrence.original_item_id
    LIMIT ?
  `;
  try {
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(0, page_size)
      .map((row) => String(row["detail"] ?? ""));
    return {
      sql_uses_offset: /\bOFFSET\b/iu.test(sql),
      sql_uses_keyset: /original_item_id\s*>\s*\?/iu.test(sql),
      plan,
    };
  } finally {
    database.close();
  }
}

function explain_preview_search(project_path: string, search: string): JsonRecord {
  const database = new DatabaseSync(project_path, { readOnly: true });
  try {
    const generation = read_json_meta_number(database, "fate_extra.preview-search.generation");
    const normalized = normalize_fate_extra_preview_search_text(search);
    const is_short = Array.from(normalized).length <= 2;
    const matched = build_fate_extra_preview_matched_document_query(search, generation);
    const common_table = `WITH matched_document(document_id, field) AS MATERIALIZED (
      ${matched.sql}
    )`;
    const field_count = Number(
      database
        .prepare(`${common_table} SELECT COUNT(DISTINCT field) AS count FROM matched_document`)
        .get(...matched.parameters)?.["count"] ?? 0,
    );
    const count_sql =
      field_count === 1
        ? `${common_table}
          SELECT COALESCE(SUM(summary.occurrence_count), 0)
          FROM matched_document
          JOIN fate_extra_preview_search_file_summary AS summary
            ON summary.generation = ?
            AND summary.document_id = matched_document.document_id`
        : `${common_table}
          SELECT COUNT(DISTINCT mapping.item_id)
          FROM matched_document
          CROSS JOIN fate_extra_preview_search_mapping AS mapping
            INDEXED BY idx_fate_extra_preview_search_item_document
          WHERE mapping.generation = ?
            AND mapping.document_id = matched_document.document_id`;
    const page_sql = `${common_table}
      SELECT item.id
      FROM fate_extra_preview_search_mapping AS mapping
        INDEXED BY idx_fate_extra_preview_search_mapping_item
      JOIN items AS item ON item.id = mapping.item_id
      WHERE mapping.generation = ?
        AND mapping.document_id IN (SELECT document_id FROM matched_document)
      GROUP BY mapping.item_id
      ORDER BY mapping.item_id
      LIMIT 160`;
    const query_parameters = [...matched.parameters, generation];
    const count_plan = database
      .prepare(`EXPLAIN QUERY PLAN ${count_sql}`)
      .all(...query_parameters)
      .map((row) => String(row["detail"] ?? ""));
    const page_plan = database
      .prepare(`EXPLAIN QUERY PLAN ${page_sql}`)
      .all(...query_parameters)
      .map((row) => String(row["detail"] ?? ""));
    const all_details = [...count_plan, ...page_plan];
    return {
      query: search,
      normalized,
      strategy: is_short ? "short-gram" : "fts5-trigram",
      count_plan,
      page_plan,
      scans_items_or_filtered_item: all_details.some((detail) =>
        /\bSCAN(?: TABLE)? (?:items|item|filtered_item)\b/iu.test(detail),
      ),
      sql_reads_item_json: /(?:json_extract|lower\s*\()/iu.test(`${count_sql}\n${page_sql}`),
    };
  } finally {
    database.close();
  }
}

function explain_preview_navigation(
  project_path: string,
  position: number,
  file_path: string,
): JsonRecord {
  const database = new DatabaseSync(project_path, { readOnly: true });
  try {
    const generation = read_json_meta_number(database, "fate_extra.preview-navigation.generation");
    const position_column = file_path === "" ? "global_position" : "file_position";
    const file_condition = file_path === "" ? "" : " AND navigation.file_path = ?";
    const sql = `
      SELECT item.id
      FROM fate_extra_preview_navigation_occurrence AS navigation
      JOIN items AS item ON item.id = navigation.item_id
      WHERE navigation.generation = ?${file_condition}
        AND navigation.${position_column} >= ?
      ORDER BY navigation.${position_column}
      LIMIT ?
    `;
    const parameters =
      file_path === "" ? [generation, position, 160] : [generation, file_path, position, 160];
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...parameters)
      .map((row) => String(row["detail"] ?? ""));
    return {
      sql_uses_offset: /\bOFFSET\b/iu.test(sql),
      sql_reads_item_json: /json_extract/iu.test(sql),
      scans_items: plan.some((detail) => /\bSCAN(?: TABLE)? items\b/iu.test(detail)),
      plan,
    };
  } finally {
    database.close();
  }
}

function read_preview_state(project_path: string): JsonRecord {
  const database = new DatabaseSync(project_path, { readOnly: true });
  try {
    const active_generation = read_json_meta_number(
      database,
      "fate_extra.preview-search.generation",
    );
    const generations = database
      .prepare(`
        SELECT generation, items_revision, item_count, document_count, short_gram_count, complete
        FROM fate_extra_preview_search_generation
        ORDER BY generation
      `)
      .all()
      .map((row) => ({ ...row }));
    const navigation_generations = database
      .prepare(`
        SELECT generation, items_revision, item_count, unique_count,
          occurrence_count, file_count, complete
        FROM fate_extra_preview_navigation_generation
        ORDER BY generation
      `)
      .all()
      .map((row) => ({ ...row }));
    return {
      active_generation,
      generation_count: generations.length,
      incomplete_generation_count:
        generations.filter((row) => Number(row["complete"]) !== 1).length +
        navigation_generations.filter((row) => Number(row["complete"]) !== 1).length,
      generations,
      navigation_generations,
      item_count: Number(
        database.prepare("SELECT COUNT(*) AS count FROM items").get()?.["count"] ?? 0,
      ),
    };
  } finally {
    database.close();
  }
}

function read_preview_identity(project_path: string): {
  generation: number;
  navigation_generation: number;
  items_revision: number;
} {
  const database = new DatabaseSync(project_path, { readOnly: true });
  try {
    return {
      generation: read_json_meta_number(database, "fate_extra.preview-search.generation"),
      navigation_generation: read_json_meta_number(
        database,
        "fate_extra.preview-navigation.generation",
      ),
      items_revision: read_json_meta_number(database, "project_runtime_revision.items"),
    };
  } finally {
    database.close();
  }
}

function create_empty_project(project_path: string, name: string): void {
  fs.mkdirSync(path.dirname(project_path), { recursive: true });
  const database = new ProjectDatabase();
  try {
    database.execute({ name: "createProject", args: { projectPath: project_path, name } });
  } finally {
    database.close();
  }
}

function write_fe_adapter_meta(database: DatabaseSync, logical_text_count: number): void {
  const upsert = database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  upsert.run(
    "fate_extra.adapter.v1",
    JSON.stringify({
      schema_version: 1,
      enabled: true,
      logical_text_count,
      file_formats: [],
    }),
  );
  upsert.run("project_runtime_revision.files", "1");
  upsert.run("project_runtime_revision.items", "1");
  upsert.run("project_runtime_revision.analysis", "1");
  upsert.run("proofreading_revision.proofreading", "1");
}

function create_empty_classification_database(database_path: string): void {
  const database = new DatabaseSync(database_path);
  try {
    database.exec(`
      CREATE TABLE entries (
        path TEXT NOT NULL,
        char_offset INTEGER NOT NULL,
        source TEXT NOT NULL,
        category TEXT NOT NULL,
        category_zh TEXT NOT NULL,
        confidence TEXT NOT NULL,
        reason TEXT NOT NULL,
        resource_path TEXT NOT NULL,
        byte_offset INTEGER,
        source_bytes INTEGER,
        slot_capacity INTEGER,
        slot_end INTEGER,
        allow_overlength INTEGER NOT NULL,
        allow_relocation INTEGER NOT NULL,
        translator_message TEXT NOT NULL,
        pointer_offsets_json TEXT NOT NULL,
        address_limit INTEGER,
        preserve_high16 INTEGER NOT NULL,
        shared_group_id TEXT NOT NULL,
        shared_group_start INTEGER,
        shared_group_end INTEGER,
        shared_group_members INTEGER,
        format_handler TEXT NOT NULL
      );
      CREATE INDEX idx_entries_path_offset ON entries(path, char_offset);
    `);
  } finally {
    database.close();
  }
}

function allocate_route_indices(
  file_count: number,
  total: number,
  unique_count: number,
): number[][] {
  const sets = Array.from({ length: file_count }, () => new Set<number>());
  for (let index = 0; index < unique_count; index += 1) sets[index % file_count]!.add(index);
  let remaining = total - unique_count;
  const candidates = Array.from({ length: file_count }, () => 0);
  let route_index = 0;
  while (remaining > 0) {
    const values = sets[route_index]!;
    let candidate = candidates[route_index]!;
    while (values.has(candidate) && candidate < unique_count) candidate += 1;
    if (candidate < unique_count) {
      values.add(candidate);
      candidates[route_index] = candidate + 1;
      remaining -= 1;
    }
    route_index = (route_index + 1) % file_count;
  }
  return sets.map((values) => [...values].sort((left, right) => left - right));
}

function indexed_line(index: number, unique_text_count: number): string {
  return `field/all.dat | char:${index.toString()} | 日文文本${(index % unique_text_count).toString()}\r\n`;
}

function write_batched_lines(
  file_path: string,
  count: number,
  line: (index: number) => string,
  initial_text = "",
): void {
  const file = fs.openSync(file_path, "w");
  try {
    let buffer = initial_text;
    let buffer_bytes = Buffer.byteLength(initial_text, "utf-8");
    for (let index = 0; index < count; index += 1) {
      const next_line = line(index);
      buffer += next_line;
      buffer_bytes += Buffer.byteLength(next_line, "utf-8");
      if (buffer_bytes >= 1024 * 1024) {
        fs.writeSync(file, buffer, undefined, "utf-8");
        buffer = "";
        buffer_bytes = 0;
      }
    }
    if (buffer !== "") fs.writeSync(file, buffer, undefined, "utf-8");
  } finally {
    fs.closeSync(file);
  }
}

function write_batched_values(
  file_path: string,
  values: readonly number[],
  line: (value: number) => string,
): void {
  const file = fs.openSync(file_path, "w");
  try {
    let buffer = "";
    let buffer_bytes = 0;
    for (const value of values) {
      const next_line = line(value);
      buffer += next_line;
      buffer_bytes += Buffer.byteLength(next_line, "utf-8");
      if (buffer_bytes >= 1024 * 1024) {
        fs.writeSync(file, buffer, undefined, "utf-8");
        buffer = "";
        buffer_bytes = 0;
      }
    }
    if (buffer !== "") fs.writeSync(file, buffer, undefined, "utf-8");
  } finally {
    fs.closeSync(file);
  }
}

function read_json_meta_number(database: DatabaseSync, key: string): number {
  const value = database.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.["value"];
  if (typeof value !== "string") return 0;
  return Number(JSON.parse(value));
}

function summarize(samples: readonly number[]): JsonRecord {
  if (samples.length === 0) return { count: 0 };
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (percentage: number): number =>
    sorted[Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1)]!;
  return {
    count: sorted.length,
    min_ms: round(sorted[0]!),
    median_ms: round(at(50)),
    p95_ms: round(at(95)),
    p99_ms: round(at(99)),
    max_ms: round(sorted.at(-1)!),
  };
}

function bytes_to_mib(value: number): number {
  return round(value / 1024 / 1024);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
