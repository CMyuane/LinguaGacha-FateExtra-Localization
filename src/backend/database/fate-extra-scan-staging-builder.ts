import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ApiJsonValue } from "../api/api-types";
import {
  count_fate_extra_legacy_item_rows,
  iterate_fate_extra_classifications,
  iterate_fate_extra_legacy_item_rows,
} from "./fate-extra-database-reader";
import {
  create_stable_fate_extra_classification_snapshot,
  remove_fate_extra_sqlite_file_set,
  type FateExtraClassificationSnapshot,
} from "./fate-extra-compact-export-database";
import type { FateExtraInputFingerprint } from "./fate-extra-scan-staging";
import { get_section_revision } from "../project/project-data";
import { build_fate_extra_font_corpus_from_resolved_texts } from "../toolbox/fate-extra-font-service";
import { default_native_fs, type NativeFs } from "../../native/native-fs";
import {
  create_fate_extra_complete_source_parser,
  create_fate_extra_indexed_text_parser,
  FATE_EXTRA_INDEX_LINE_PATTERN,
  rebuild_fate_extra_indexed_block,
  type FateExtraParsedIndexedText,
} from "../../shared/fate-extra/fate-extra-parser";
import {
  FATE_EXTRA_DEFAULT_CLASSIFICATION_DATABASE,
  FATE_EXTRA_DEFAULT_INDEXED_SOURCE_DIRECTORY,
  FATE_EXTRA_DEFAULT_LEGACY_PROJECT,
  FATE_EXTRA_DEFAULT_UNINDEXED_TRANSLATION_DIRECTORY,
  FATE_EXTRA_ITEM_NAMESPACE,
  FATE_EXTRA_SCHEMA_VERSION,
  FATE_EXTRA_SUPPLEMENT_FILE,
  type FateExtraAdapterMetadata,
  type FateExtraClassification,
  type FateExtraFileFormat,
  type FateExtraItemMetadata,
} from "../../shared/fate-extra/fate-extra-types";
import { JsonTool } from "../../shared/utils/json-tool";
import { ZstdTool } from "../../shared/utils/zstd-tool";

type JsonRecord = Record<string, ApiJsonValue>;

export type FateExtraScanStagingBuildInput = {
  projectPath: string;
  projectEpoch: number;
  projectMeta: JsonRecord;
  body: JsonRecord;
  stagingPath: string;
};

export type FateExtraScanStagingBuildResult = {
  scan_id: string;
  report: JsonRecord;
  staging_path: string;
  project_path: string;
  project_epoch: number;
  project_section_revisions: Record<string, number>;
  fingerprints: FateExtraInputFingerprint[];
  logical_text_count: number;
};

export type FateExtraScanProgress = {
  phase: string;
  completed: number;
  total: number | null;
};

export type FateExtraScanProgressReporter = (progress: FateExtraScanProgress) => void;

type RouteFile = {
  file_id: number;
  source_path: string;
  relative_path: string;
  signature: string;
  format: FateExtraFileFormat;
};

type MigrationCounters = {
  exact: number;
  high_confidence: number;
  indexed: number;
  unindexed: number;
  pending: number;
  matched_classification: number;
};

type StructuralIssueCollector = {
  add(issue: string): void;
  readonly count: number;
  readonly visible: string[];
};

const GUARDED_SECTIONS = ["files", "items", "analysis", "proofreading"] as const;
const MAX_VISIBLE_STRUCTURAL_ISSUES = 500;
const SUPPLEMENT_WRITE_BATCH_SIZE = 1024 * 1024;
const PROGRESS_BATCH_SIZE = 10_000;
const SOURCE_MARKER_PREFIX = "\u0000FE_SOURCE_";
const SOURCE_MARKER_SUFFIX = "\u0000";

/**
 * FE 专用扫描管线：完整主库和路线文件逐行解析，逻辑条目直接写入 staging。
 * 内存工作集只与一个逻辑块、一个 SQLite 页批次和唯一字形集合相关。
 */
export async function build_fate_extra_scan_staging(
  input: FateExtraScanStagingBuildInput,
  native_fs: NativeFs = default_native_fs,
  report_progress: FateExtraScanProgressReporter = () => {},
): Promise<FateExtraScanStagingBuildResult> {
  const source_directory = optional_string(
    input.body,
    "source_directory",
    FATE_EXTRA_DEFAULT_INDEXED_SOURCE_DIRECTORY,
  );
  const classification_database = optional_string(
    input.body,
    "classification_database",
    FATE_EXTRA_DEFAULT_CLASSIFICATION_DATABASE,
  );
  const complete_jp_source_file = require_string(input.body, "complete_jp_source_file");
  assert_directory(native_fs, source_directory, "索引原稿目录");
  assert_file(native_fs, complete_jp_source_file, "Fate_Extra_JP_完整文本汇总.txt");
  assert_file(native_fs, classification_database, "FE 文本安全分类数据库");

  const source_files = native_fs
    .read_dirents(source_directory)
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".txt") &&
        entry.name !== FATE_EXTRA_SUPPLEMENT_FILE,
    )
    .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
  const source_paths = source_files.map((entry) => path.join(source_directory, entry.name));
  const migration_text_directory = optional_string(
    input.body,
    "migration_text_directory",
    FATE_EXTRA_DEFAULT_UNINDEXED_TRANSLATION_DIRECTORY,
  );
  const migration_project = resolve_migration_project(input, native_fs);
  const migration_text_inputs = list_migration_text_inputs(migration_text_directory, native_fs);
  const external_migration_project =
    migration_project !== "" &&
    native_fs.exists(migration_project) &&
    native_fs.to_identity_path(migration_project) !== native_fs.to_identity_path(input.projectPath)
      ? migration_project
      : "";
  const classification_snapshot_path = `${input.stagingPath}.classification.sqlite`;
  const migration_snapshot_path = `${input.stagingPath}.migration.sqlite`;
  native_fs.ensure_parent_dir(input.stagingPath);
  let classification_identity: FateExtraClassificationSnapshot;
  let migration_identity: FateExtraClassificationSnapshot | null = null;
  try {
    classification_identity = await create_stable_fate_extra_classification_snapshot(
      classification_database,
      classification_snapshot_path,
      native_fs,
    );
    migration_identity =
      external_migration_project === ""
        ? null
        : await create_stable_fate_extra_classification_snapshot(
            external_migration_project,
            migration_snapshot_path,
            native_fs,
          );
  } catch (error) {
    remove_fate_extra_sqlite_file_set(classification_snapshot_path, native_fs);
    remove_fate_extra_sqlite_file_set(migration_snapshot_path, native_fs);
    throw error;
  }
  let ordinary_fingerprints: FateExtraInputFingerprint[];
  try {
    ordinary_fingerprints = await fingerprint_paths(
      [
        source_directory,
        ...source_paths,
        complete_jp_source_file,
        ...(native_fs.exists(migration_text_directory) ? [migration_text_directory] : []),
        ...migration_text_inputs,
      ],
      native_fs,
      (completed, total) => report_progress({ phase: "fingerprint", completed, total }),
    );
  } catch (error) {
    remove_fate_extra_sqlite_file_set(classification_snapshot_path, native_fs);
    remove_fate_extra_sqlite_file_set(migration_snapshot_path, native_fs);
    throw error;
  }
  const fingerprints = [
    ...ordinary_fingerprints,
    sqlite_identity_fingerprint(classification_database, classification_identity),
    ...(migration_identity === null
      ? []
      : [sqlite_identity_fingerprint(external_migration_project, migration_identity)]),
  ];
  const project_section_revisions = Object.fromEntries(
    GUARDED_SECTIONS.map((section) => [section, get_section_revision(input.projectMeta, section)]),
  );
  const scan_id = randomUUID();
  const supplement_temporary_path = `${input.stagingPath}.supplement.tmp`;

  native_fs.ensure_parent_dir(input.stagingPath);
  native_fs.remove(input.stagingPath, { force: true });
  native_fs.remove(supplement_temporary_path, { force: true });
  const database = new DatabaseSync(native_fs.to_native_path(input.stagingPath));
  try {
    create_staging_schema(database);
    database.exec("BEGIN;");
    const structural = create_structural_issue_collector();
    const complete_count = await stage_complete_source(
      database,
      complete_jp_source_file,
      structural,
      native_fs,
      (completed) => report_progress({ phase: "parse-complete-source", completed, total: null }),
    );
    report_progress({
      phase: "parse-complete-source",
      completed: complete_count,
      total: complete_count,
    });
    stage_classifications(database, classification_snapshot_path, (completed) =>
      report_progress({ phase: "stage-classifications", completed, total: null }),
    );
    const route_files = await stage_route_files(
      database,
      source_files.map((entry) => ({ name: entry.name })),
      source_directory,
      structural,
      native_fs,
      (completed, total) => report_progress({ phase: "parse-route-files", completed, total }),
    );
    await stage_translation_imports(database, route_files, migration_text_directory, native_fs);
    report_progress({
      phase: "stage-translations",
      completed: route_files.length,
      total: route_files.length,
    });
    stage_legacy_items(
      database,
      external_migration_project === "" ? migration_project : migration_snapshot_path,
      route_files,
      native_fs,
      (completed) => report_progress({ phase: "stage-legacy", completed, total: null }),
    );

    const counters: MigrationCounters = {
      exact: 0,
      high_confidence: 0,
      indexed: 0,
      unindexed: 0,
      pending: 0,
      matched_classification: 0,
    };
    const category_counts: Record<string, number> = {};
    const build_context = create_item_build_context(database, counters, category_counts);
    const route_item_total = read_table_count(database, "work_route_entries");
    const supplement_item_total = Number(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM work_complete_entries AS complete
           WHERE NOT EXISTS (
             SELECT 1 FROM work_route_keys AS route
             WHERE route.path = complete.path AND route.char_offset = complete.char_offset
           )`,
        )
        .get()?.["count"] ?? 0,
    );
    const item_total = route_item_total + supplement_item_total;
    const item_progress = (completed: number): void =>
      report_progress({ phase: "stage-items", completed, total: item_total });
    let next_item_id = stage_route_items(database, route_files, build_context, 1, item_progress);
    const supplement = stage_supplement_items(
      database,
      build_context,
      next_item_id,
      supplement_temporary_path,
      native_fs,
      route_item_total,
      item_progress,
    );
    next_item_id = supplement.next_item_id;
    const logical_text_count = next_item_id - 1;
    const route_logical_text_count = Number(
      database.prepare("SELECT COUNT(*) AS count FROM work_route_entries").get()?.["count"] ?? 0,
    );
    const route_unique_index_count = Number(
      database.prepare("SELECT COUNT(*) AS count FROM work_route_keys").get()?.["count"] ?? 0,
    );
    const unique_index_count = Number(
      database.prepare("SELECT COUNT(*) AS count FROM work_complete_keys").get()?.["count"] ?? 0,
    );
    const missing_classification_count = Number(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM work_complete_keys AS keys
           LEFT JOIN work_classifications AS classification
             ON classification.path = keys.path
            AND classification.char_offset = keys.char_offset
           WHERE classification.path IS NULL`,
        )
        .get()?.["count"] ?? 0,
    );
    const matched_classification_count = counters.matched_classification;
    const physical_line_count =
      Number(
        database
          .prepare(
            `SELECT COALESCE(SUM(source_line_count + pass_through_count), 0) AS count
           FROM work_route_entries`,
          )
          .get()?.["count"] ?? 0,
      ) + supplement.physical_line_count;
    const translation_issues = read_work_string_list(database, "work_translation_issues");
    const applicable =
      structural.count === 0 &&
      route_files.length === 6 &&
      route_logical_text_count === 34_693 &&
      route_unique_index_count === 7_867 &&
      complete_count === 914_663;
    const report: JsonRecord = {
      scan_id,
      applicable,
      source_file_count: route_files.length,
      physical_line_count,
      logical_text_count,
      route_logical_text_count,
      complete_jp_text_count: complete_count,
      supplemental_text_count: supplement.count,
      unique_index_count,
      route_unique_index_count,
      matched_classification_count,
      missing_classification_count,
      classification_match_rate:
        logical_text_count === 0 ? 0 : matched_classification_count / logical_text_count,
      category_counts,
      structural_issues: structural.visible,
      structural_issue_count: structural.count,
      migration_project,
      migration_text_directory,
      migrated_exact: counters.exact,
      migrated_high_confidence: counters.high_confidence,
      migrated_indexed_text: counters.indexed,
      migrated_unindexed_text: counters.unindexed,
      migration_pending: counters.pending,
      migration_text_issues: translation_issues,
      expected_acceptance: {
        source_file_count: 6,
        route_logical_text_count: 34_693,
        route_unique_index_count: 7_867,
        complete_jp_text_count: 914_663,
      },
    };
    const corpus = build_fate_extra_font_corpus_from_resolved_texts(iterate_work_corpus(database));
    const formats = route_files.map((file) => file.format);
    if (supplement.count > 0) formats.push(supplement.format);
    const adapter_meta: FateExtraAdapterMetadata = {
      schema_version: FATE_EXTRA_SCHEMA_VERSION,
      enabled: true,
      applied_at: "",
      source_directory,
      complete_jp_source_file,
      classification_database,
      source_file_count: route_files.length,
      logical_text_count,
      unique_index_count,
      matched_classification_count,
      supplemental_text_count: supplement.count,
      rules_version: "fe.3",
      file_formats: formats,
      font_corpus_hash: corpus.corpus_sha256,
      font_manifest_hash: "",
      remaining_extension_slots: 0,
    };
    write_final_meta(database, report, adapter_meta, project_section_revisions, fingerprints);
    report_progress({ phase: "finalize-staging", completed: 0, total: 1 });
    drop_work_tables(database);
    database.exec("COMMIT;");
    report_progress({ phase: "finalize-staging", completed: 1, total: 1 });
    database.close();
    return {
      scan_id,
      report,
      staging_path: applicable ? input.stagingPath : "",
      project_path: input.projectPath,
      project_epoch: input.projectEpoch,
      project_section_revisions,
      fingerprints,
      logical_text_count,
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // staging 是派生数据；连接关闭和整文件删除共同兜底。
    }
    try {
      database.close();
    } catch {
      // 关闭失败不应遮蔽原始扫描错误。
    }
    native_fs.remove(input.stagingPath, { force: true });
    throw error;
  } finally {
    native_fs.remove(supplement_temporary_path, { force: true });
    remove_fate_extra_sqlite_file_set(classification_snapshot_path, native_fs);
    remove_fate_extra_sqlite_file_set(migration_snapshot_path, native_fs);
  }
}

function create_staging_schema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = FILE;
    PRAGMA auto_vacuum = FULL;
    CREATE TABLE scan_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE scan_items (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE scan_assets (
      sort_order INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      data BLOB NOT NULL,
      original_size INTEGER NOT NULL,
      compressed_size INTEGER NOT NULL
    );
    CREATE TABLE scan_migration_issues (issue_order INTEGER PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE work_complete_entries (
      entry_order INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      char_offset INTEGER NOT NULL,
      original_prefix TEXT NOT NULL,
      source TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      source_line_count INTEGER NOT NULL
    );
    CREATE INDEX work_complete_entries_key
      ON work_complete_entries(path, char_offset, entry_order);
    CREATE TABLE work_complete_keys (
      path TEXT NOT NULL,
      char_offset INTEGER NOT NULL,
      first_entry_order INTEGER NOT NULL,
      PRIMARY KEY(path, char_offset)
    ) WITHOUT ROWID;
    CREATE TABLE work_classifications (
      path TEXT NOT NULL,
      char_offset INTEGER NOT NULL,
      confidence TEXT NOT NULL,
      category TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY(path, char_offset)
    ) WITHOUT ROWID;
    CREATE TABLE work_route_files (
      file_id INTEGER PRIMARY KEY,
      source_path TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      signature TEXT NOT NULL,
      format TEXT NOT NULL
    );
    CREATE TABLE work_route_entries (
      file_id INTEGER NOT NULL,
      entry_order INTEGER NOT NULL,
      path TEXT NOT NULL,
      char_offset INTEGER NOT NULL,
      original_prefix TEXT NOT NULL,
      source TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      source_line_numbers TEXT NOT NULL,
      pass_through TEXT NOT NULL,
      header_line_number INTEGER NOT NULL,
      source_line_count INTEGER NOT NULL,
      pass_through_count INTEGER NOT NULL,
      PRIMARY KEY(file_id, entry_order)
    ) WITHOUT ROWID;
    CREATE INDEX work_route_entries_key
      ON work_route_entries(file_id, path, char_offset, entry_order);
    CREATE TABLE work_route_keys (
      path TEXT NOT NULL,
      char_offset INTEGER NOT NULL,
      PRIMARY KEY(path, char_offset)
    ) WITHOUT ROWID;
    CREATE TABLE work_translations (
      signature TEXT NOT NULL,
      path TEXT NOT NULL,
      char_offset INTEGER NOT NULL,
      text TEXT NOT NULL,
      indexed INTEGER NOT NULL,
      PRIMARY KEY(signature, path, char_offset)
    ) WITHOUT ROWID;
    CREATE TABLE work_translation_ambiguous (
      signature TEXT NOT NULL,
      path TEXT NOT NULL,
      char_offset INTEGER NOT NULL,
      PRIMARY KEY(signature, path, char_offset)
    ) WITHOUT ROWID;
    CREATE TABLE work_translation_issues (
      issue_order INTEGER PRIMARY KEY AUTOINCREMENT,
      issue TEXT NOT NULL
    );
    CREATE TABLE work_legacy (
      id INTEGER PRIMARY KEY,
      signature TEXT NOT NULL,
      row_number INTEGER NOT NULL,
      source TEXT NOT NULL,
      destination TEXT NOT NULL
    );
    CREATE INDEX work_legacy_row ON work_legacy(signature, row_number);
    CREATE INDEX work_legacy_source ON work_legacy(signature, source);
    CREATE TABLE work_corpus (text TEXT PRIMARY KEY) WITHOUT ROWID;
  `);
}

async function stage_complete_source(
  database: DatabaseSync,
  source_path: string,
  structural: StructuralIssueCollector,
  native_fs: NativeFs,
  report_progress: (completed: number) => void,
): Promise<number> {
  const insert_entry = database.prepare(`
    INSERT INTO work_complete_entries
      (entry_order, path, char_offset, original_prefix, source, source_hash, source_line_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const read_key = database.prepare(`
    SELECT complete.source
    FROM work_complete_keys AS keys
    JOIN work_complete_entries AS complete ON complete.entry_order = keys.first_entry_order
    WHERE keys.path = ? AND keys.char_offset = ?
  `);
  const insert_key = database.prepare(`
    INSERT INTO work_complete_keys (path, char_offset, first_entry_order) VALUES (?, ?, ?)
  `);
  let entry_order = 0;
  const parser = create_fate_extra_complete_source_parser(
    (entry) => {
      entry_order += 1;
      if (entry_order % PROGRESS_BATCH_SIZE === 0) report_progress(entry_order);
      const source_hash = createHash("sha256").update(entry.source, "utf-8").digest("hex");
      insert_entry.run(
        entry_order,
        entry.path,
        entry.char_offset,
        entry.original_prefix,
        entry.source,
        source_hash,
        entry.source_line_numbers.length,
      );
      const previous = read_key.get(entry.path, entry.char_offset);
      if (previous === undefined) {
        insert_key.run(entry.path, entry.char_offset, entry_order);
      } else {
        structural.add(
          String(previous["source"] ?? "") === entry.source
            ? `完整日文主库存在重复索引：${entry.path} / char:${entry.char_offset}`
            : `完整日文主库索引相同但原文冲突：${entry.path} / char:${entry.char_offset}`,
        );
      }
    },
    (issue) => structural.add(issue),
  );
  await native_fs.read_utf8_lines(source_path, (line, line_number) => {
    parser.push_line(line, line_number);
  });
  parser.finish();
  return entry_order;
}

function stage_classifications(
  database: DatabaseSync,
  classification_path: string,
  report_progress: (completed: number) => void,
): void {
  const insert = database.prepare(`
    INSERT OR REPLACE INTO work_classifications
      (path, char_offset, confidence, category, data)
    VALUES (?, ?, ?, ?, ?)
  `);
  let completed = 0;
  for (const row of iterate_fate_extra_classifications(classification_path)) {
    insert.run(
      row.path,
      row.char_offset,
      row.classification.confidence,
      row.classification.category,
      JsonTool.stringifyStrict(row.classification as unknown as ApiJsonValue),
    );
    completed += 1;
    if (completed % PROGRESS_BATCH_SIZE === 0) report_progress(completed);
  }
  report_progress(completed);
}

async function stage_route_files(
  database: DatabaseSync,
  source_files: Array<{ name: string }>,
  source_directory: string,
  structural: StructuralIssueCollector,
  native_fs: NativeFs,
  report_progress: (completed: number, total: number) => void,
): Promise<RouteFile[]> {
  const insert_file = database.prepare(`
    INSERT INTO work_route_files
      (file_id, source_path, relative_path, signature, format)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insert_entry = database.prepare(`
    INSERT INTO work_route_entries
      (file_id, entry_order, path, char_offset, original_prefix, source, source_hash,
       source_line_numbers, pass_through, header_line_number, source_line_count, pass_through_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insert_route_key = database.prepare(
    "INSERT OR IGNORE INTO work_route_keys (path, char_offset) VALUES (?, ?)",
  );
  const read_expected = database.prepare(`
    SELECT complete.path, complete.char_offset, complete.source
    FROM work_complete_keys AS keys
    JOIN work_complete_entries AS complete ON complete.entry_order = keys.first_entry_order
    WHERE keys.path = ? AND keys.char_offset = ?
  `);
  const insert_asset = database.prepare(`
    INSERT INTO scan_assets (sort_order, path, data, original_size, compressed_size)
    VALUES (?, ?, ?, ?, ?)
  `);
  const output: RouteFile[] = [];
  for (const [index, source_file] of source_files.entries()) {
    const file_id = index + 1;
    const source_path = path.join(source_directory, source_file.name);
    let entry_order = 0;
    const parser = create_fate_extra_indexed_text_parser({
      resolve_expected: (indexed_path, char_offset) => {
        const row = read_expected.get(indexed_path, char_offset);
        return row === undefined
          ? undefined
          : {
              path: String(row["path"] ?? ""),
              char_offset: Number(row["char_offset"] ?? 0),
              source: String(row["source"] ?? ""),
            };
      },
      on_entry: (entry) => {
        entry_order += 1;
        insert_entry.run(
          file_id,
          entry_order,
          entry.path,
          entry.char_offset,
          entry.original_prefix,
          entry.source,
          createHash("sha256").update(entry.source, "utf-8").digest("hex"),
          JsonTool.stringifyStrict(entry.source_line_numbers),
          JsonTool.stringifyStrict(entry.pass_through),
          entry.header_line_number,
          entry.source_line_numbers.length,
          entry.pass_through.length,
        );
      },
      on_issue: (issue) => structural.add(`${source_file.name}: ${issue}`),
    });
    const format_result = await native_fs.read_utf8_lines(source_path, (line, line_number) => {
      const header = FATE_EXTRA_INDEX_LINE_PATTERN.exec(line);
      if (header !== null) {
        insert_route_key.run(header[1] ?? "", Number(header[2] ?? Number.NaN));
      }
      parser.push_line(line, line_number);
    });
    parser.finish();
    const format: FateExtraFileFormat = {
      relative_path: source_file.name,
      encoding: format_result.has_bom ? "utf-8-bom" : "utf-8",
      eol: format_result.eol,
      trailing_eol: format_result.trailing_eol,
    };
    const signature = route_signature(source_file.name);
    insert_file.run(
      file_id,
      source_path,
      source_file.name,
      signature,
      JsonTool.stringifyStrict(format as unknown as ApiJsonValue),
    );
    const raw = native_fs.read_file(source_path);
    const compressed = ZstdTool.compress(raw);
    insert_asset.run(index, source_file.name, compressed, raw.byteLength, compressed.byteLength);
    output.push({ file_id, source_path, relative_path: source_file.name, signature, format });
    report_progress(output.length, source_files.length);
  }
  return output;
}

async function stage_translation_imports(
  database: DatabaseSync,
  route_files: RouteFile[],
  directory: string,
  native_fs: NativeFs,
): Promise<void> {
  if (!native_fs.exists(directory) || !native_fs.stat(directory).isDirectory()) return;
  const text_files = native_fs
    .read_dirents(directory)
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".txt"));
  const indexed = text_files.filter(
    (entry) => entry.name.includes("初翻") && entry.name.includes("带索引"),
  );
  const unindexed = text_files.filter((entry) => entry.name.includes("无索引译文"));
  for (const file of route_files) {
    const indexed_matches = indexed.filter(
      (entry) => route_signature(entry.name) === file.signature,
    );
    if (indexed_matches.length > 1) {
      add_translation_issue(
        database,
        `${file.relative_path}: 找到多份同分支带索引初翻，已拒绝自动迁移。`,
      );
    } else if (indexed_matches.length === 1) {
      await stage_indexed_translation_file(
        database,
        file,
        path.join(directory, indexed_matches[0]!.name),
        native_fs,
      );
    }
    const unindexed_matches = unindexed.filter(
      (entry) => route_signature(entry.name) === file.signature,
    );
    if (unindexed_matches.length > 1) {
      add_translation_issue(
        database,
        `${file.relative_path}: 找到多份同分支无索引译文，已拒绝自动迁移。`,
      );
    } else if (unindexed_matches.length === 1) {
      await stage_unindexed_translation_file(
        database,
        file,
        path.join(directory, unindexed_matches[0]!.name),
        native_fs,
      );
    }
  }
}

async function stage_indexed_translation_file(
  database: DatabaseSync,
  file: RouteFile,
  translation_path: string,
  native_fs: NativeFs,
): Promise<void> {
  const read_entry = database.prepare(`
    SELECT pass_through
    FROM work_route_entries
    WHERE file_id = ? AND path = ? AND char_offset = ?
    ORDER BY entry_order DESC LIMIT 1
  `);
  let current: { path: string; char_offset: number; lines: string[] } | undefined;
  const prefix = path.basename(translation_path);
  const finish = (): void => {
    if (current === undefined) return;
    const row = read_entry.get(file.file_id, current.path, current.char_offset);
    if (row === undefined) {
      add_translation_issue(
        database,
        `${prefix}: 索引 ${current.path} / char:${current.char_offset} 不在对应日文分支中。`,
      );
      current = undefined;
      return;
    }
    const pass_through = JsonTool.parseStrict<FateExtraParsedIndexedText["pass_through"]>(
      String(row["pass_through"] ?? "[]"),
    );
    remove_pass_through_lines(current.lines, pass_through);
    stage_translation_value(
      database,
      file.signature,
      current.path,
      current.char_offset,
      current.lines.join("\n"),
      true,
    );
    current = undefined;
  };
  await native_fs.read_utf8_lines(translation_path, (line, line_number) => {
    const header = FATE_EXTRA_INDEX_LINE_PATTERN.exec(line);
    if (header === null) {
      if (current === undefined) {
        if (line !== "")
          add_translation_issue(database, `${prefix}: 第 ${line_number} 行不是合法索引头。`);
      } else {
        current.lines.push(line);
      }
      return;
    }
    finish();
    current = {
      path: header[1] ?? "",
      char_offset: Number(header[2] ?? Number.NaN),
      lines: [header[3] ?? ""],
    };
  });
  finish();
  const ambiguous_count = Number(
    database
      .prepare(`SELECT COUNT(*) AS count FROM work_translation_ambiguous WHERE signature = ?`)
      .get(file.signature)?.["count"] ?? 0,
  );
  if (ambiguous_count > 0) {
    add_translation_issue(
      database,
      `${prefix}: ${ambiguous_count} 个重复索引存在不同译文，已留空待确认。`,
    );
    // 带索引文件的歧义只代表该输入不可用；无索引结构迁移仍可作为后续来源。
    database
      .prepare("DELETE FROM work_translation_ambiguous WHERE signature = ?")
      .run(file.signature);
  }
}

async function stage_unindexed_translation_file(
  database: DatabaseSync,
  file: RouteFile,
  translation_path: string,
  native_fs: NativeFs,
): Promise<void> {
  database.exec(`
    DROP TABLE IF EXISTS work_import_lines;
    DROP TABLE IF EXISTS work_import_candidates;
    DROP TABLE IF EXISTS work_import_ambiguous;
    CREATE TABLE work_import_lines (line_number INTEGER PRIMARY KEY, text TEXT NOT NULL);
    CREATE TABLE work_import_candidates (
      path TEXT NOT NULL,
      char_offset INTEGER NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY(path, char_offset)
    ) WITHOUT ROWID;
    CREATE TABLE work_import_ambiguous (
      path TEXT NOT NULL,
      char_offset INTEGER NOT NULL,
      PRIMARY KEY(path, char_offset)
    ) WITHOUT ROWID;
  `);
  const insert_line = database.prepare(
    "INSERT INTO work_import_lines (line_number, text) VALUES (?, ?)",
  );
  const format = await native_fs.read_utf8_lines(translation_path, (line, line_number) => {
    insert_line.run(line_number, line);
  });
  const line_count = format.physical_line_count;
  const read_line = database.prepare("SELECT text FROM work_import_lines WHERE line_number = ?");
  let cursor = 1;
  let failure = "";
  for (const row of database
    .prepare(
      `SELECT path, char_offset, original_prefix, source, source_line_numbers, pass_through,
              header_line_number
       FROM work_route_entries WHERE file_id = ? ORDER BY entry_order`,
    )
    .iterate(file.file_id)) {
    const entry = read_staged_entry(row);
    const source_lines = entry.source.split(/\r\n|\n|\r/gu);
    const markers = source_lines.map(
      (_line, index) => `${SOURCE_MARKER_PREFIX}${index}${SOURCE_MARKER_SUFFIX}`,
    );
    const pattern = rebuild_fate_extra_indexed_block({
      entry,
      translation: markers.join("\n"),
      restore_index: false,
    });
    const translated: string[] = [];
    for (const expected of pattern) {
      const actual_row = read_line.get(cursor);
      if (actual_row === undefined) {
        failure = `在逻辑文本 ${entry.path} / char:${entry.char_offset} 前提前结束。`;
        break;
      }
      const actual = String(actual_row["text"] ?? "");
      const marker = read_source_marker(expected);
      if (marker === null) {
        if (actual !== expected) {
          failure = `透传行在 ${entry.path} / char:${entry.char_offset} 处不一致。`;
          break;
        }
      } else {
        translated[marker] = actual;
      }
      cursor += 1;
    }
    if (failure !== "") break;
    stage_import_candidate(database, entry.path, entry.char_offset, translated.join("\n"));
  }
  if (failure === "" && cursor - 1 !== line_count) {
    failure = `文件末尾多出 ${line_count - cursor + 1} 行，无法可靠对应。`;
  }
  const prefix = path.basename(translation_path);
  if (failure !== "") {
    add_translation_issue(database, `${prefix}: ${failure}`);
  } else {
    const ambiguous = Number(
      database.prepare("SELECT COUNT(*) AS count FROM work_import_ambiguous").get()?.["count"] ?? 0,
    );
    if (ambiguous > 0) {
      add_translation_issue(
        database,
        `${prefix}: ${ambiguous} 个重复索引存在不同译文，已留空待确认。`,
      );
    }
    const insert = database.prepare(`
      INSERT OR IGNORE INTO work_translations (signature, path, char_offset, text, indexed)
      VALUES (?, ?, ?, ?, 0)
    `);
    for (const row of database
      .prepare("SELECT path, char_offset, text FROM work_import_candidates")
      .iterate()) {
      insert.run(
        file.signature,
        String(row["path"] ?? ""),
        Number(row["char_offset"] ?? 0),
        String(row["text"] ?? ""),
      );
    }
  }
  database.exec(`
    DROP TABLE work_import_lines;
    DROP TABLE work_import_candidates;
    DROP TABLE work_import_ambiguous;
  `);
}

function stage_translation_value(
  database: DatabaseSync,
  signature: string,
  indexed_path: string,
  char_offset: number,
  text: string,
  indexed: boolean,
): void {
  const ambiguous = database
    .prepare(
      `SELECT 1 FROM work_translation_ambiguous
       WHERE signature = ? AND path = ? AND char_offset = ?`,
    )
    .get(signature, indexed_path, char_offset);
  if (ambiguous !== undefined) return;
  const existing = database
    .prepare(
      `SELECT text FROM work_translations
       WHERE signature = ? AND path = ? AND char_offset = ?`,
    )
    .get(signature, indexed_path, char_offset);
  if (existing !== undefined && String(existing["text"] ?? "") !== text) {
    database
      .prepare(
        `DELETE FROM work_translations
         WHERE signature = ? AND path = ? AND char_offset = ?`,
      )
      .run(signature, indexed_path, char_offset);
    database
      .prepare(
        `INSERT INTO work_translation_ambiguous (signature, path, char_offset)
         VALUES (?, ?, ?)`,
      )
      .run(signature, indexed_path, char_offset);
    return;
  }
  if (existing === undefined) {
    database
      .prepare(
        `INSERT INTO work_translations (signature, path, char_offset, text, indexed)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(signature, indexed_path, char_offset, text, indexed ? 1 : 0);
  }
}

function stage_import_candidate(
  database: DatabaseSync,
  indexed_path: string,
  char_offset: number,
  text: string,
): void {
  const ambiguous = database
    .prepare("SELECT 1 FROM work_import_ambiguous WHERE path = ? AND char_offset = ?")
    .get(indexed_path, char_offset);
  if (ambiguous !== undefined) return;
  const previous = database
    .prepare("SELECT text FROM work_import_candidates WHERE path = ? AND char_offset = ?")
    .get(indexed_path, char_offset);
  if (previous !== undefined && String(previous["text"] ?? "") !== text) {
    database
      .prepare("DELETE FROM work_import_candidates WHERE path = ? AND char_offset = ?")
      .run(indexed_path, char_offset);
    database
      .prepare("INSERT INTO work_import_ambiguous (path, char_offset) VALUES (?, ?)")
      .run(indexed_path, char_offset);
  } else if (previous === undefined) {
    database
      .prepare("INSERT INTO work_import_candidates (path, char_offset, text) VALUES (?, ?, ?)")
      .run(indexed_path, char_offset, text);
  }
}

function stage_legacy_items(
  database: DatabaseSync,
  migration_project: string,
  route_files: RouteFile[],
  native_fs: NativeFs,
  report_progress: (completed: number) => void,
): void {
  if (migration_project === "" || !native_fs.exists(migration_project)) {
    report_progress(0);
    return;
  }
  const accepted_signatures = new Set(route_files.map((file) => file.signature));
  const insert = database.prepare(`
    INSERT INTO work_legacy (id, signature, row_number, source, destination)
    VALUES (?, ?, ?, ?, ?)
  `);
  let completed = 0;
  for (const row of iterate_fate_extra_legacy_item_rows(
    native_fs.to_native_path(migration_project),
  )) {
    const item = read_record(JsonTool.parseStrict<ApiJsonValue>(row.data));
    const signature = route_signature(String(item["file_path"] ?? ""));
    if (!accepted_signatures.has(signature)) continue;
    insert.run(
      row.id,
      signature,
      Number(item["row"] ?? -1),
      String(item["src"] ?? ""),
      String(item["dst"] ?? ""),
    );
    completed += 1;
    if (completed % PROGRESS_BATCH_SIZE === 0) report_progress(completed);
  }
  report_progress(completed);
}

function create_item_build_context(
  database: DatabaseSync,
  counters: MigrationCounters,
  category_counts: Record<string, number>,
): {
  insert_item(args: {
    item_id: number;
    entry: FateExtraParsedIndexedText;
    relative_path: string;
    signature: string;
    supplement: boolean;
    source_hash: string;
  }): void;
} {
  const insert_item = database.prepare("INSERT INTO scan_items (id, data) VALUES (?, ?)");
  const insert_issue = database.prepare(
    "INSERT INTO scan_migration_issues (issue_order, data) VALUES (?, ?)",
  );
  const insert_corpus = database.prepare("INSERT OR IGNORE INTO work_corpus (text) VALUES (?)");
  const read_classification = database.prepare(`
    SELECT confidence, category, data FROM work_classifications
    WHERE path = ? AND char_offset = ?
  `);
  const read_row = database.prepare(`
    SELECT source, destination FROM work_legacy
    WHERE signature = ? AND row_number = ?
    ORDER BY id DESC LIMIT 1
  `);
  const read_unique_source = database.prepare(`
    SELECT row_number, destination FROM work_legacy
    WHERE signature = ? AND source = ?
    ORDER BY id LIMIT 2
  `);
  const has_legacy = database.prepare("SELECT 1 FROM work_legacy WHERE signature = ? LIMIT 1");
  const read_translation = database.prepare(`
    SELECT text, indexed FROM work_translations
    WHERE signature = ? AND path = ? AND char_offset = ?
  `);
  return {
    insert_item(args): void {
      let can_migrate = args.supplement;
      let migrated_text = args.supplement ? args.entry.source : "";
      let migration_source = args.supplement ? "supplement-source-copy" : "";
      if (!args.supplement) {
        const source_lines = args.entry.source.split(/\r\n|\n|\r/gu);
        const exact_rows = source_lines.map((line, index) => {
          const source_row = (args.entry.source_line_numbers[index] ?? 1) - 1;
          const row = read_row.get(args.signature, source_row);
          return row !== undefined && String(row["source"] ?? "") === line ? row : null;
        });
        let migrated_rows: Array<Record<string, unknown>> | null = exact_rows.every(
          (row): row is Record<string, unknown> => row !== null,
        )
          ? exact_rows
          : null;
        if (migrated_rows !== null) {
          counters.exact += 1;
          migration_source = "exact-row";
        } else {
          const unique_rows = source_lines.map((line, index) => {
            const rows = read_unique_source.all(args.signature, line);
            if (rows.length !== 1) return null;
            const source_row = (args.entry.source_line_numbers[index] ?? 1) - 1;
            return Math.abs(Number(rows[0]?.["row_number"] ?? -10_000) - source_row) <= 500
              ? rows[0]!
              : null;
          });
          if (
            unique_rows.every((row): row is Record<string, unknown> => row !== null) &&
            unique_rows.every(
              (row, index) =>
                index === 0 ||
                Number(row["row_number"] ?? 0) >
                  Number((unique_rows[index - 1] as Record<string, unknown>)["row_number"] ?? 0),
            )
          ) {
            migrated_rows = unique_rows;
            counters.high_confidence += 1;
            migration_source = "unique-high-confidence";
          }
        }
        can_migrate =
          migrated_rows !== null &&
          migrated_rows.every((row) => String(row["destination"] ?? "") !== "");
        migrated_text = can_migrate
          ? migrated_rows!.map((row) => String(row["destination"] ?? "")).join("\n")
          : "";
        const imported = read_translation.get(
          args.signature,
          args.entry.path,
          args.entry.char_offset,
        );
        if (imported !== undefined && String(imported["text"] ?? "") !== "") {
          can_migrate = true;
          migrated_text = String(imported["text"] ?? "");
          if (Number(imported["indexed"] ?? 0) !== 0) {
            migration_source = "indexed-text-exact";
            counters.indexed += 1;
          } else {
            migration_source = "unindexed-text-structural";
            counters.unindexed += 1;
          }
        }
      }
      if (!can_migrate) {
        counters.pending += 1;
        const issue = {
          file_path: args.relative_path,
          path: args.entry.path,
          char_offset: args.entry.char_offset,
          source: args.entry.source,
          reason:
            has_legacy.get(args.signature) === undefined
              ? "未找到对应旧译文分支"
              : "源文或行号无法唯一对应，已留空",
        };
        insert_issue.run(counters.pending - 1, JsonTool.stringifyStrict(issue));
      }
      const classification_row = read_classification.get(args.entry.path, args.entry.char_offset);
      const classification =
        classification_row === undefined
          ? unresolved_classification(args.entry)
          : JsonTool.parseStrict<FateExtraClassification>(String(classification_row["data"]));
      category_counts[classification.category] =
        (category_counts[classification.category] ?? 0) + 1;
      if (classification.confidence !== "none") {
        counters.matched_classification += 1;
      }
      const metadata: FateExtraItemMetadata = {
        schema_version: FATE_EXTRA_SCHEMA_VERSION,
        path: args.entry.path,
        char_offset: args.entry.char_offset,
        original_prefix: args.entry.original_prefix,
        source_hash: args.source_hash,
        source_line_numbers: args.entry.source_line_numbers,
        pass_through: args.entry.pass_through,
        classification,
        migration_review: !can_migrate && !args.supplement,
        migration_source,
        proofread_translation: "",
        display_mode: "auto",
      };
      const item: JsonRecord = {
        src: args.entry.source,
        dst: migrated_text,
        name_src: null,
        name_dst: null,
        extra_field: { [FATE_EXTRA_ITEM_NAMESPACE]: metadata as unknown as ApiJsonValue },
        tag: args.supplement ? "补漏" : can_migrate ? "" : "迁移待确认",
        row: args.entry.header_line_number - 1,
        file_type: "TXT",
        file_path: args.relative_path,
        text_type: "NONE",
        status: args.supplement ? "NONE" : can_migrate ? "PROCESSED" : "NONE",
        retry_count: 0,
        skip_internal_filter: false,
      };
      insert_item.run(args.item_id, JsonTool.stringifyStrict(item));
      insert_corpus.run(migrated_text === "" ? args.entry.source : migrated_text);
    },
  };
}

function stage_route_items(
  database: DatabaseSync,
  files: RouteFile[],
  context: ReturnType<typeof create_item_build_context>,
  first_item_id: number,
  report_progress: (completed: number) => void,
): number {
  let item_id = first_item_id;
  for (const file of files) {
    for (const row of database
      .prepare(
        `SELECT path, char_offset, original_prefix, source, source_hash, source_line_numbers,
                pass_through, header_line_number
         FROM work_route_entries WHERE file_id = ? ORDER BY entry_order`,
      )
      .iterate(file.file_id)) {
      context.insert_item({
        item_id,
        entry: read_staged_entry(row),
        relative_path: file.relative_path,
        signature: file.signature,
        supplement: false,
        source_hash: String(row["source_hash"] ?? ""),
      });
      item_id += 1;
      if ((item_id - first_item_id) % PROGRESS_BATCH_SIZE === 0) {
        report_progress(item_id - first_item_id);
      }
    }
  }
  report_progress(item_id - first_item_id);
  return item_id;
}

function stage_supplement_items(
  database: DatabaseSync,
  context: ReturnType<typeof create_item_build_context>,
  first_item_id: number,
  temporary_path: string,
  native_fs: NativeFs,
  completed_offset: number,
  report_progress: (completed: number) => void,
): {
  next_item_id: number;
  count: number;
  physical_line_count: number;
  format: FateExtraFileFormat;
} {
  const writer = native_fs.open_text_writer(temporary_path);
  let item_id = first_item_id;
  let count = 0;
  let physical_line_count = 0;
  let supplemental_line_number = 1;
  let write_buffer = "";
  let write_buffer_bytes = 0;
  const append_output = (text: string): void => {
    const bytes = Buffer.byteLength(text, "utf-8");
    if (write_buffer_bytes > 0 && write_buffer_bytes + bytes > SUPPLEMENT_WRITE_BATCH_SIZE) {
      writer.write(write_buffer);
      write_buffer = "";
      write_buffer_bytes = 0;
    }
    if (bytes >= SUPPLEMENT_WRITE_BATCH_SIZE) {
      writer.write(text);
      return;
    }
    write_buffer += text;
    write_buffer_bytes += bytes;
  };
  try {
    for (const row of database
      .prepare(
        `SELECT complete.path, complete.char_offset, complete.original_prefix,
                complete.source, complete.source_hash, complete.source_line_count
         FROM work_complete_entries AS complete
         WHERE NOT EXISTS (
           SELECT 1 FROM work_route_keys AS route
           WHERE route.path = complete.path AND route.char_offset = complete.char_offset
         )
         ORDER BY complete.entry_order`,
      )
      .iterate()) {
      const source = String(row["source"] ?? "");
      const source_lines = source.split(/\r\n|\n|\r/gu);
      const entry: FateExtraParsedIndexedText = {
        path: String(row["path"] ?? ""),
        char_offset: Number(row["char_offset"] ?? 0),
        original_prefix: String(row["original_prefix"] ?? ""),
        source,
        source_line_numbers: source_lines.map((_line, index) => supplemental_line_number + index),
        pass_through: [],
        header_line_number: supplemental_line_number,
      };
      append_output(
        `${count > 0 ? "\r\n" : ""}${entry.original_prefix}${source_lines.join("\r\n")}`,
      );
      context.insert_item({
        item_id,
        entry,
        relative_path: FATE_EXTRA_SUPPLEMENT_FILE,
        signature: ":",
        supplement: true,
        source_hash: String(row["source_hash"] ?? ""),
      });
      item_id += 1;
      count += 1;
      if (count % PROGRESS_BATCH_SIZE === 0) report_progress(completed_offset + count);
      physical_line_count += source_lines.length;
      supplemental_line_number += source_lines.length;
    }
    if (count > 0) append_output("\r\n");
    if (write_buffer !== "") writer.write(write_buffer);
  } finally {
    writer.close();
  }
  const format: FateExtraFileFormat = {
    relative_path: FATE_EXTRA_SUPPLEMENT_FILE,
    encoding: "utf-8",
    eol: "\r\n",
    trailing_eol: true,
  };
  if (count > 0) {
    const raw = native_fs.read_file(temporary_path);
    const compressed = ZstdTool.compress(raw);
    const next_sort_order = Number(
      database.prepare("SELECT COUNT(*) AS count FROM scan_assets").get()?.["count"] ?? 0,
    );
    database
      .prepare(
        `INSERT INTO scan_assets (sort_order, path, data, original_size, compressed_size)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(next_sort_order, FATE_EXTRA_SUPPLEMENT_FILE, compressed, raw.length, compressed.length);
  }
  report_progress(completed_offset + count);
  return { next_item_id: item_id, count, physical_line_count, format };
}

function read_staged_entry(row: Record<string, unknown>): FateExtraParsedIndexedText {
  return {
    path: String(row["path"] ?? ""),
    char_offset: Number(row["char_offset"] ?? 0),
    original_prefix: String(row["original_prefix"] ?? ""),
    source: String(row["source"] ?? ""),
    source_line_numbers: JsonTool.parseStrict<number[]>(String(row["source_line_numbers"] ?? "[]")),
    pass_through: JsonTool.parseStrict<FateExtraParsedIndexedText["pass_through"]>(
      String(row["pass_through"] ?? "[]"),
    ),
    header_line_number: Number(row["header_line_number"] ?? 1),
  };
}

function unresolved_classification(entry: FateExtraParsedIndexedText): FateExtraClassification {
  return {
    category: "unresolved_candidate",
    category_zh: "未解析候选",
    confidence: "none",
    reason: "完整日文主库存在该条目，但当前安全分类数据库没有对应记录。",
    resource_path: entry.path,
    byte_offset: null,
    source_bytes: null,
    slot_capacity: null,
    slot_end: null,
    allow_overlength: false,
    allow_relocation: false,
    translator_message: "可以翻译和校对，但在补充安全分类前禁止自动注入。",
    pointer_offsets: [],
    address_limit: null,
    preserve_high16: false,
    shared_storage_group: "",
    shared_group_start: null,
    shared_group_end: null,
    shared_group_members: null,
    format_handler: "",
    display_opcode: null,
    portrait_id: null,
    display_evidence: "canonical-jp-source-only",
  };
}

function write_final_meta(
  database: DatabaseSync,
  report: JsonRecord,
  adapter_meta: FateExtraAdapterMetadata,
  revisions: Record<string, number>,
  fingerprints: FateExtraInputFingerprint[],
): void {
  const insert = database.prepare("INSERT INTO scan_meta (key, value) VALUES (?, ?)");
  insert.run("schema_version", "1");
  insert.run("report", JsonTool.stringifyStrict(report));
  insert.run("adapter_meta", JsonTool.stringifyStrict(adapter_meta as unknown as ApiJsonValue));
  insert.run("project_section_revisions", JsonTool.stringifyStrict(revisions));
  insert.run("fingerprints", JsonTool.stringifyStrict(fingerprints));
}

function drop_work_tables(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE work_complete_entries;
    DROP TABLE work_complete_keys;
    DROP TABLE work_classifications;
    DROP TABLE work_route_files;
    DROP TABLE work_route_entries;
    DROP TABLE work_route_keys;
    DROP TABLE work_translations;
    DROP TABLE work_translation_ambiguous;
    DROP TABLE work_translation_issues;
    DROP TABLE work_legacy;
    DROP TABLE work_corpus;
  `);
}

function* iterate_work_corpus(database: DatabaseSync): Generator<string> {
  for (const row of database.prepare("SELECT text FROM work_corpus ORDER BY text").iterate()) {
    yield String(row["text"] ?? "");
  }
}

function create_structural_issue_collector(): StructuralIssueCollector {
  let count = 0;
  const visible: string[] = [];
  return {
    add(issue): void {
      count += 1;
      if (visible.length < MAX_VISIBLE_STRUCTURAL_ISSUES) visible.push(issue);
    },
    get count(): number {
      return count;
    },
    visible,
  };
}

async function fingerprint_paths(
  paths: string[],
  native_fs: NativeFs,
  report_progress: (completed: number, total: number) => void,
): Promise<FateExtraInputFingerprint[]> {
  const output: FateExtraInputFingerprint[] = [];
  for (const file_path of paths) {
    const stat = native_fs.stat(file_path);
    output.push({
      path: file_path,
      kind: stat.isFile() ? "file" : "directory",
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      sha256: stat.isFile() ? await native_fs.sha256_file(file_path) : "",
    });
    report_progress(output.length, paths.length);
  }
  return output;
}

function list_migration_text_inputs(directory: string, native_fs: NativeFs): string[] {
  if (!native_fs.exists(directory) || !native_fs.stat(directory).isDirectory()) return [];
  return native_fs
    .read_dirents(directory)
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".txt"))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
}

function sqlite_identity_fingerprint(
  database_path: string,
  identity: FateExtraClassificationSnapshot,
): FateExtraInputFingerprint {
  return {
    path: database_path,
    kind: "sqlite",
    size: identity.fingerprints.reduce((total, fingerprint) => total + fingerprint.size, 0),
    mtime_ms: Math.max(...identity.fingerprints.map((fingerprint) => fingerprint.mtime_ms), 0),
    sha256: identity.snapshot_sha256,
    sqlite_files: identity.fingerprints,
  };
}

function resolve_migration_project(
  input: FateExtraScanStagingBuildInput,
  native_fs: NativeFs,
): string {
  const requested = optional_string(input.body, "migration_project", "");
  if (requested !== "") return requested;
  if (
    native_fs.exists(input.projectPath) &&
    count_fate_extra_legacy_item_rows(native_fs.to_native_path(input.projectPath)) > 0
  ) {
    return input.projectPath;
  }
  return native_fs.exists(FATE_EXTRA_DEFAULT_LEGACY_PROJECT)
    ? FATE_EXTRA_DEFAULT_LEGACY_PROJECT
    : "";
}

function add_translation_issue(database: DatabaseSync, issue: string): void {
  database.prepare("INSERT INTO work_translation_issues (issue) VALUES (?)").run(issue);
}

function read_work_string_list(database: DatabaseSync, table: "work_translation_issues"): string[] {
  return [...database.prepare(`SELECT issue FROM ${table} ORDER BY issue_order`).iterate()].map(
    (row) => String(row["issue"] ?? ""),
  );
}

function read_table_count(database: DatabaseSync, table: "work_route_entries"): number {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.["count"] ?? 0);
}

function remove_pass_through_lines(
  lines: string[],
  pass_through: FateExtraParsedIndexedText["pass_through"],
): void {
  for (const pass_line of [...pass_through].reverse()) {
    const preferred = Math.max(0, Math.min(lines.length - 1, pass_line.after_source_line + 1));
    let found = lines[preferred] === pass_line.text ? preferred : -1;
    if (found < 0) {
      for (let distance = 1; distance < lines.length; distance += 1) {
        const after = preferred + distance;
        const before = preferred - distance;
        if (after < lines.length && lines[after] === pass_line.text) {
          found = after;
          break;
        }
        if (before >= 0 && lines[before] === pass_line.text) {
          found = before;
          break;
        }
      }
    }
    if (found >= 0) lines.splice(found, 1);
  }
}

function read_source_marker(value: string): number | null {
  if (!value.startsWith(SOURCE_MARKER_PREFIX) || !value.endsWith(SOURCE_MARKER_SUFFIX)) return null;
  const marker = Number(value.slice(SOURCE_MARKER_PREFIX.length, -SOURCE_MARKER_SUFFIX.length));
  return Number.isSafeInteger(marker) && marker >= 0 ? marker : null;
}

function route_signature(file_name: string): string {
  const name = file_name.normalize("NFKC");
  const servant = name.includes("尼禄")
    ? "nero"
    : name.includes("无铭")
      ? "archer"
      : name.includes("玉藻")
        ? "caster"
        : "";
  const branch = name.includes("拉妮") ? "rani" : name.includes("凛") ? "rin" : "";
  return `${servant}:${branch}`;
}

function optional_string(body: JsonRecord, key: string, fallback: string): string {
  const value = body[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function require_string(body: JsonRecord, key: string): string {
  const value = optional_string(body, key, "");
  if (value === "") throw new Error(`缺少参数：${key}`);
  return value;
}

function assert_file(native_fs: NativeFs, file_path: string, label: string): void {
  if (!native_fs.exists(file_path) || !native_fs.stat(file_path).isFile()) {
    throw new Error(`${label}不存在：${file_path}`);
  }
}

function assert_directory(native_fs: NativeFs, directory: string, label: string): void {
  if (!native_fs.exists(directory) || !native_fs.stat(directory).isDirectory()) {
    throw new Error(`${label}不存在：${directory}`);
  }
}

function read_record(value: unknown): Record<string, ApiJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, ApiJsonValue>)
    : {};
}
