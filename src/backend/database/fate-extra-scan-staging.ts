import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ApiJsonValue } from "../api/api-types";
import { default_native_fs, type NativeFs, type NativeTextWriter } from "../../native/native-fs";
import { JsonTool } from "../../shared/utils/json-tool";
import {
  build_fate_extra_scan_apply_artifact_paths,
  build_fate_extra_scan_apply_pending_manifest,
  FATE_EXTRA_SCAN_APPLY_RECEIPT_META_KEY,
  FATE_EXTRA_SCAN_APPLY_RECEIPT_SCHEMA_VERSION,
  read_fate_extra_scan_apply_receipt,
  type FateExtraScanApplyArtifactPaths,
  type FateExtraScanApplyReceipt,
} from "./fate-extra-scan-apply-receipt";
import {
  create_stable_fate_extra_classification_snapshot,
  remove_fate_extra_sqlite_file_set,
} from "./fate-extra-compact-export-database";

type JsonRecord = Record<string, ApiJsonValue>;

export type FateExtraInputFingerprint = {
  path: string;
  kind?: "file" | "directory" | "sqlite";
  size: number;
  mtime_ms: number;
  sha256: string;
  sqlite_files?: Array<{ path: string; size: number; mtime_ms: number; sha256: string }>;
};

export type ApplyFateExtraScanStagingInput = {
  projectPath: string;
  stagingPath: string;
  scanId: string;
  applyToken: string;
  expectedSectionRevisions: Record<string, number>;
};

export type ApplyFateExtraScanStagingResult = {
  accepted: true;
  backup_path: string;
  migration_report_json: string;
  migration_report_csv: string;
  migration_report_status: "succeeded" | "failed";
  migration_report_error?: string;
  logical_text_count: number;
  section_revisions: Record<string, number>;
};

export type FateExtraApplyProgress = {
  phase: string;
  completed: number;
  total: number | null;
};

export type FateExtraApplyProgressReporter = (progress: FateExtraApplyProgress) => void;

const REVISION_META_KEY_BY_SECTION = {
  files: "project_runtime_revision.files",
  items: "project_runtime_revision.items",
  analysis: "project_runtime_revision.analysis",
  proofreading: "proofreading_revision.proofreading",
} as const;
const MIGRATION_REPORT_WRITE_BATCH_SIZE = 1024 * 1024;
const FATE_EXTRA_SCAN_STAGING_SCHEMA_VERSION = 1;

/**
 * 在单个 SQLite 事务内从 staging 发布项目事实；worker 终止会触发连接回滚。
 */
export async function apply_fate_extra_scan_staging(
  input: ApplyFateExtraScanStagingInput,
  native_fs: NativeFs = default_native_fs,
  report_progress: FateExtraApplyProgressReporter = () => undefined,
): Promise<ApplyFateExtraScanStagingResult> {
  if (input.scanId === "" || input.applyToken === "") {
    throw new Error("FE staging apply 缺少 scanId 或 applyToken。");
  }
  const stage = new DatabaseSync(native_fs.to_native_path(input.stagingPath), { readOnly: true });
  try {
    const staging_schema_version = read_stage_json<number>(stage, "schema_version", 0);
    if (staging_schema_version !== FATE_EXTRA_SCAN_STAGING_SCHEMA_VERSION) {
      throw new Error(
        `FE staging schema 已失效：预期 ${FATE_EXTRA_SCAN_STAGING_SCHEMA_VERSION.toString()}，实际 ${staging_schema_version.toString()}。`,
      );
    }
    const fingerprints = read_stage_json<FateExtraInputFingerprint[]>(stage, "fingerprints", []);
    report_progress({ phase: "verify-inputs", completed: 0, total: fingerprints.length });
    await verify_fingerprints(fingerprints, input.stagingPath, native_fs, (completed) => {
      report_progress({ phase: "verify-inputs", completed, total: fingerprints.length });
    });
    const adapter_meta = read_stage_json<JsonRecord>(stage, "adapter_meta", {});
    const logical_text_count = read_count(stage, "scan_items");
    const processed_line = Number(
      stage
        .prepare(
          `SELECT COUNT(*) AS count
           FROM scan_items
           WHERE json_extract(data, '$.status') = 'PROCESSED'`,
        )
        .get()?.["count"] ?? 0,
    );

    const artifacts = build_fate_extra_scan_apply_artifact_paths(
      input.projectPath,
      input.applyToken,
    );
    const section_revisions = commit_stage_to_project(
      stage,
      input.projectPath,
      input.scanId,
      input.applyToken,
      adapter_meta,
      logical_text_count,
      processed_line,
      input.expectedSectionRevisions,
      artifacts,
      native_fs,
      report_progress,
    );
    // 报告不是项目事实。数据库提交后报告 IO 即使失败也必须返回 accepted，
    // 让 ProjectWriteStore 始终发布已提交 revision 与 section-invalidated 事件。
    report_progress({ phase: "write-migration-reports", completed: 0, total: 1 });
    const reports = write_migration_reports_safely(stage, artifacts, native_fs);
    report_progress({ phase: "write-migration-reports", completed: 1, total: 1 });
    return {
      accepted: true,
      backup_path: artifacts.backup_path,
      migration_report_json: reports.json,
      migration_report_csv: reports.csv,
      migration_report_status: reports.status,
      ...(reports.error === undefined ? {} : { migration_report_error: reports.error }),
      logical_text_count,
      section_revisions,
    };
  } finally {
    stage.close();
  }
}

function commit_stage_to_project(
  stage: DatabaseSync,
  project_path: string,
  scan_id: string,
  apply_token: string,
  adapter_meta: JsonRecord,
  logical_text_count: number,
  processed_line: number,
  expected_section_revisions: Record<string, number>,
  artifacts: FateExtraScanApplyArtifactPaths,
  native_fs: NativeFs,
  report_progress: FateExtraApplyProgressReporter,
): Record<string, number> {
  const project = new DatabaseSync(native_fs.to_native_path(project_path));
  project.exec("PRAGMA busy_timeout = 30000;");
  let transaction_started = false;
  let backup_created = false;
  let committed = false;
  let pending_manifest_created = false;
  try {
    // 快速拒绝显然过期的请求，避免为已知冲突创建备份；真正的写入判定仍在
    // BEGIN IMMEDIATE 取得写锁后再次执行，不能依赖这次无锁预检。
    assert_and_build_revisions(project, expected_section_revisions);
    // 项目可能处于 WAL 模式；VACUUM INTO 会把已提交 WAL 页一并写入一致备份。
    report_progress({ phase: "backup-project", completed: 0, total: 1 });
    const previous_receipt = read_existing_scan_apply_receipt(project);
    const pending_manifest = build_fate_extra_scan_apply_pending_manifest(
      project_path,
      apply_token,
      previous_receipt?.apply_token ?? null,
    );
    pending_manifest_created = true;
    native_fs.write_file_sync(
      artifacts.pending_manifest_path,
      `${JsonTool.stringifyStrict(pending_manifest)}\n`,
    );
    project.prepare("VACUUM INTO ?").run(native_fs.to_native_path(artifacts.backup_path));
    backup_created = true;
    report_progress({ phase: "backup-project", completed: 1, total: 1 });
    project.exec("BEGIN IMMEDIATE;");
    transaction_started = true;
    const section_revisions = assert_and_build_revisions(project, expected_section_revisions);
    project.prepare("DELETE FROM assets").run();
    project.prepare("DELETE FROM items").run();
    project.prepare("DELETE FROM analysis_item_checkpoint").run();
    project.prepare("DELETE FROM analysis_candidate_aggregate").run();

    const insert_asset = project.prepare(`
      INSERT INTO assets (path, sort_order, data, original_size, compressed_size)
      VALUES (?, ?, ?, ?, ?)
    `);
    const asset_count = Number(
      stage.prepare("SELECT COUNT(*) AS count FROM scan_assets").get()?.["count"] ?? 0,
    );
    let imported_assets = 0;
    report_progress({ phase: "import-assets", completed: 0, total: asset_count });
    for (const row of stage
      .prepare(
        `SELECT sort_order, path, data, original_size, compressed_size
         FROM scan_assets ORDER BY sort_order`,
      )
      .iterate()) {
      insert_asset.run(
        String(row["path"] ?? ""),
        Number(row["sort_order"] ?? 0),
        row["data"] as Uint8Array,
        Number(row["original_size"] ?? 0),
        Number(row["compressed_size"] ?? 0),
      );
      imported_assets += 1;
      report_progress({ phase: "import-assets", completed: imported_assets, total: asset_count });
    }

    const insert_item = project.prepare("INSERT INTO items (id, data) VALUES (?, ?)");
    const item_count = read_count(stage, "scan_items");
    let imported_items = 0;
    report_progress({ phase: "import-items", completed: 0, total: item_count });
    for (const row of stage.prepare("SELECT id, data FROM scan_items ORDER BY id").iterate()) {
      insert_item.run(Number(row["id"] ?? 0), String(row["data"] ?? "{}"));
      imported_items += 1;
      if (imported_items % 10_000 === 0 || imported_items === item_count) {
        report_progress({ phase: "import-items", completed: imported_items, total: item_count });
      }
    }

    const upsert_meta = project.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    const next_adapter_meta = { ...adapter_meta, applied_at: new Date().toISOString() };
    const receipt: FateExtraScanApplyReceipt = {
      schema_version: FATE_EXTRA_SCAN_APPLY_RECEIPT_SCHEMA_VERSION,
      apply_token,
      scan_id,
      committed_at: new Date().toISOString(),
      backup_path: artifacts.backup_path,
      migration_report_json: artifacts.migration_report_json,
      migration_report_csv: artifacts.migration_report_csv,
      logical_text_count,
      section_revisions: {
        files: section_revisions.files ?? 0,
        items: section_revisions.items ?? 0,
        analysis: section_revisions.analysis ?? 0,
        proofreading: section_revisions.proofreading ?? 0,
      },
    };
    const meta: JsonRecord = {
      "fate_extra.adapter.v1": next_adapter_meta,
      [FATE_EXTRA_SCAN_APPLY_RECEIPT_META_KEY]: receipt as unknown as ApiJsonValue,
      translation_extras: {
        line: processed_line,
        processed_line,
        error_line: 0,
        total_line: logical_text_count,
        total_tokens: 0,
        total_output_tokens: 0,
        total_input_tokens: 0,
        time: 0,
        start_time: 0,
        extras: { kind: "translation", scope: { kind: "all" } },
      },
      analysis_extras: {
        line: 0,
        processed_line: 0,
        error_line: 0,
        total_line: logical_text_count,
      },
      analysis_candidate_count: 0,
      ...Object.fromEntries(
        Object.entries(section_revisions).map(([section, revision]) => [
          REVISION_META_KEY_BY_SECTION[section as keyof typeof REVISION_META_KEY_BY_SECTION],
          revision,
        ]),
      ),
    };
    for (const [key, value] of Object.entries(meta)) {
      upsert_meta.run(key, JsonTool.stringifyStrict(value));
    }
    report_progress({ phase: "commit-project", completed: 0, total: 1 });
    project.exec("COMMIT;");
    transaction_started = false;
    committed = true;
    report_progress({ phase: "commit-project", completed: 1, total: 1 });
    return section_revisions;
  } catch (error) {
    if (transaction_started) {
      try {
        project.exec("ROLLBACK;");
      } catch {
        // 连接关闭继续保证未提交事务不会成为可见项目事实。
      }
    }
    if (backup_created && !committed) {
      native_fs.remove(artifacts.backup_path, { force: true });
    }
    if (pending_manifest_created && !committed) {
      native_fs.remove(artifacts.pending_manifest_path, { force: true });
    }
    throw error;
  } finally {
    project.close();
  }
}

function read_existing_scan_apply_receipt(
  database: DatabaseSync,
): FateExtraScanApplyReceipt | null {
  const row = database
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(FATE_EXTRA_SCAN_APPLY_RECEIPT_META_KEY);
  if (row === undefined) return null;
  const receipt = read_fate_extra_scan_apply_receipt(
    JsonTool.parseStrict(String(row["value"] ?? "null")),
  );
  if (receipt === null) {
    throw new Error("FE scan-apply receipt 已损坏，拒绝覆盖可恢复状态。");
  }
  return receipt;
}

function assert_and_build_revisions(
  database: DatabaseSync,
  expected: Record<string, number>,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [section, meta_key] of Object.entries(REVISION_META_KEY_BY_SECTION)) {
    const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(meta_key);
    const current = row === undefined ? 0 : Number(JsonTool.parseStrict(row["value"] as string));
    if (current !== Number(expected[section] ?? Number.NaN)) {
      throw new Error(`FE staging revision 已失效：${section}`);
    }
    next[section] = current + 1;
  }
  return next;
}

async function verify_fingerprints(
  fingerprints: FateExtraInputFingerprint[],
  staging_path: string,
  native_fs: NativeFs,
  report_progress: (completed: number) => void,
): Promise<void> {
  for (const [index, fingerprint] of fingerprints.entries()) {
    if (fingerprint.kind === "sqlite") {
      const snapshot_path = `${staging_path}.verify-input-${index.toString()}.sqlite`;
      try {
        const identity = await create_stable_fate_extra_classification_snapshot(
          fingerprint.path,
          snapshot_path,
          native_fs,
        );
        if (identity.snapshot_sha256 !== fingerprint.sha256) {
          throw new Error(`FE 扫描输入内容已变化：${path.basename(fingerprint.path)}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("FE 扫描输入内容已变化")) {
          throw error;
        }
        throw new Error(`FE 扫描输入已失效：${path.basename(fingerprint.path)}`, {
          cause: error,
        });
      } finally {
        remove_fate_extra_sqlite_file_set(snapshot_path, native_fs);
      }
      report_progress(index + 1);
      continue;
    }
    let stat: ReturnType<NativeFs["stat"]>;
    try {
      stat = native_fs.stat(fingerprint.path);
    } catch (error) {
      throw new Error(`FE 扫描输入已失效：${path.basename(fingerprint.path)}`, { cause: error });
    }
    const kind_changed =
      (fingerprint.kind === "directory" && !stat.isDirectory()) ||
      (fingerprint.kind === "file" && !stat.isFile());
    if (kind_changed || stat.size !== fingerprint.size || stat.mtimeMs !== fingerprint.mtime_ms) {
      throw new Error(`FE 扫描输入已变化：${path.basename(fingerprint.path)}`);
    }
    if (
      fingerprint.kind !== "directory" &&
      (await native_fs.sha256_file(fingerprint.path)) !== fingerprint.sha256
    ) {
      throw new Error(`FE 扫描输入内容已变化：${path.basename(fingerprint.path)}`);
    }
    report_progress(index + 1);
  }
}

function read_stage_json<T>(database: DatabaseSync, key: string, fallback: T): T {
  const row = database.prepare("SELECT value FROM scan_meta WHERE key = ?").get(key);
  return row === undefined ? fallback : JsonTool.parseStrict<T>(String(row["value"] ?? "null"));
}

function read_count(database: DatabaseSync, table: "scan_items"): number {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.["count"] ?? 0);
}

function write_migration_reports(
  stage: DatabaseSync,
  artifacts: FateExtraScanApplyArtifactPaths,
  native_fs: NativeFs,
): { json: string; csv: string } {
  const json_path = artifacts.migration_report_json;
  const csv_path = artifacts.migration_report_csv;
  const json_temporary = artifacts.migration_report_json_temporary;
  const csv_temporary = artifacts.migration_report_csv_temporary;
  const pending_count = Number(
    stage.prepare("SELECT COUNT(*) AS count FROM scan_migration_issues").get()?.["count"] ?? 0,
  );
  let json_writer: NativeTextWriter | null = null;
  let csv_writer: NativeTextWriter | null = null;
  let issue_index = 0;
  try {
    json_writer = native_fs.open_text_writer(
      json_temporary,
      pending_count === 0
        ? '{\n  "schema_version": 1,\n  "pending_count": 0,\n  "issues": []\n}\n'
        : `{\n  "schema_version": 1,\n  "pending_count": ${pending_count},\n  "issues": [\n`,
    );
    csv_writer = native_fs.open_text_writer(
      csv_temporary,
      ["file_path", "path", "char_offset", "source", "reason"].map(csv_cell).join(","),
    );
    let json_buffer = "";
    let json_buffer_bytes = 0;
    let csv_buffer = "";
    let csv_buffer_bytes = 0;
    const append_json = (text: string): void => {
      const bytes = Buffer.byteLength(text, "utf-8");
      if (json_buffer_bytes > 0 && json_buffer_bytes + bytes > MIGRATION_REPORT_WRITE_BATCH_SIZE) {
        json_writer!.write(json_buffer);
        json_buffer = "";
        json_buffer_bytes = 0;
      }
      json_buffer += text;
      json_buffer_bytes += bytes;
    };
    const append_csv = (text: string): void => {
      const bytes = Buffer.byteLength(text, "utf-8");
      if (csv_buffer_bytes > 0 && csv_buffer_bytes + bytes > MIGRATION_REPORT_WRITE_BATCH_SIZE) {
        csv_writer!.write(csv_buffer);
        csv_buffer = "";
        csv_buffer_bytes = 0;
      }
      csv_buffer += text;
      csv_buffer_bytes += bytes;
    };
    for (const row of stage
      .prepare("SELECT data FROM scan_migration_issues ORDER BY issue_order")
      .iterate()) {
      const issue = JsonTool.parseStrict<Record<string, ApiJsonValue>>(String(row["data"] ?? "{}"));
      const pretty_issue = JSON.stringify(issue, null, 2)
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
      append_json(`${issue_index === 0 ? "" : ",\n"}${pretty_issue}`);
      append_csv(
        `\r\n${[
          issue["file_path"],
          issue["path"],
          issue["char_offset"],
          issue["source"],
          issue["reason"],
        ]
          .map(csv_cell)
          .join(",")}`,
      );
      issue_index += 1;
    }
    if (pending_count > 0) append_json("\n  ]\n}\n");
    if (json_buffer !== "") json_writer.write(json_buffer);
    if (csv_buffer !== "") csv_writer.write(csv_buffer);
    json_writer.close();
    json_writer = null;
    csv_writer.close();
    csv_writer = null;
    native_fs.remove(json_path, { force: true });
    native_fs.remove(csv_path, { force: true });
    native_fs.rename(json_temporary, json_path);
    native_fs.rename(csv_temporary, csv_path);
  } catch (error) {
    json_writer?.close();
    csv_writer?.close();
    native_fs.remove(json_temporary, { force: true });
    native_fs.remove(csv_temporary, { force: true });
    throw error;
  }
  return { json: json_path, csv: csv_path };
}

function write_migration_reports_safely(
  stage: DatabaseSync,
  artifacts: FateExtraScanApplyArtifactPaths,
  native_fs: NativeFs,
): {
  json: string;
  csv: string;
  status: "succeeded" | "failed";
  error?: string;
} {
  const destinations = {
    json: artifacts.migration_report_json,
    csv: artifacts.migration_report_csv,
  };
  try {
    return { ...write_migration_reports(stage, artifacts, native_fs), status: "succeeded" };
  } catch (error) {
    return {
      ...destinations,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function csv_cell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}
