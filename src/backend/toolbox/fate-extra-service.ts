import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type { AppPathService } from "../app/app-path-service";
import type { ApiJsonValue } from "../api/api-types";
import type { ProjectDatabase } from "../database/database-operations";
import {
  read_fate_extra_classifications,
  read_fate_extra_legacy_item_rows,
  type FateExtraClassificationRow,
} from "../database/fate-extra-database-reader";
import type { ProjectOperationGate } from "../project/project-gate";
import { get_section_revision } from "../project/project-data";
import type { ProjectSessionState } from "../project/project-session";
import type { ProjectWriteStore } from "../project/project-write-store";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import * as AppErrors from "../../shared/error";
import {
  has_fate_extra_psp_overflow,
  layout_fate_extra_preview,
  type FateExtraResolvedDisplayMode,
} from "../../shared/fate-extra/fate-extra-layout";
import { resolve_fate_extra_display_mode } from "../../shared/fate-extra/fate-extra-display-mode";
import {
  FATE_EXTRA_INDEX_LINE_PATTERN,
  parse_fate_extra_complete_source,
  parse_fate_extra_indexed_text,
  rebuild_fate_extra_indexed_block,
  type FateExtraExpectedIndexedText,
  type FateExtraParsedIndexedText,
} from "../../shared/fate-extra/fate-extra-parser";
import {
  FATE_EXTRA_ADAPTER_META_KEY,
  FATE_EXTRA_DEFAULT_CLASSIFICATION_DATABASE,
  FATE_EXTRA_DEFAULT_INDEXED_SOURCE_DIRECTORY,
  FATE_EXTRA_DEFAULT_LEGACY_PROJECT,
  FATE_EXTRA_DEFAULT_UNINDEXED_TRANSLATION_DIRECTORY,
  FATE_EXTRA_OVERFLOW_WARNING_CODE,
  FATE_EXTRA_SCHEMA_VERSION,
  merge_fate_extra_item_metadata,
  read_fate_extra_display_mode,
  read_fate_extra_item_metadata,
  read_fate_extra_proofread_translation,
  resolve_fate_extra_effective_translation,
  type FateExtraAdapterMetadata,
  type FateExtraFileFormat,
  type FateExtraDisplayMode,
  type FateExtraItemMetadata,
} from "../../shared/fate-extra/fate-extra-types";
import type { FateExtraFontService } from "./fate-extra-font-service";

type JsonRecord = Record<string, ApiJsonValue>;
type MutableRecord = Record<string, unknown>;

type ScanFileDraft = {
  source_path: string;
  relative_path: string;
  format: FateExtraFileFormat;
  entries: FateExtraParsedIndexedText[];
  kind: "route" | "supplement";
  synthetic_text?: string;
};

type MigrationIssue = {
  file_path: string;
  path: string;
  char_offset: number;
  source: string;
  reason: string;
};

type ScanDraft = {
  id: string;
  project_path: string;
  project_section_revisions: Record<FateExtraGuardedSection, number>;
  source_directory: string;
  source_mtime_ms: number;
  complete_jp_source_file: string;
  complete_jp_source_mtime_ms: number;
  classification_database: string;
  database_mtime_ms: number;
  files: ScanFileDraft[];
  items: MutableRecord[];
  report: JsonRecord;
  adapter_meta: FateExtraAdapterMetadata;
  migration_issues: MigrationIssue[];
};

type FateExtraGuardedSection = "files" | "items" | "analysis" | "proofreading";

type UnindexedTranslationImport = {
  translations: Map<string, string>;
  issues: string[];
};

const SOURCE_MARKER_PREFIX = "\u0000FE_SOURCE_";
const SOURCE_MARKER_SUFFIX = "\u0000";
const FATE_EXTRA_SUPPLEMENT_FILE = "FE_补漏.txt";
const FATE_EXTRA_GUARDED_SECTIONS: readonly FateExtraGuardedSection[] = [
  "files",
  "items",
  "analysis",
  "proofreading",
];

function read_source_marker(value: string): number | null {
  if (!value.startsWith(SOURCE_MARKER_PREFIX) || !value.endsWith(SOURCE_MARKER_SUFFIX)) {
    return null;
  }
  const marker = Number(value.slice(SOURCE_MARKER_PREFIX.length, -SOURCE_MARKER_SUFFIX.length));
  return Number.isSafeInteger(marker) && marker >= 0 ? marker : null;
}

function read_record(value: unknown): MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as MutableRecord)
    : {};
}

function csv_cell(value: unknown): string {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function unresolved_classification_row(
  entry: FateExtraParsedIndexedText,
): FateExtraClassificationRow {
  return {
    path: entry.path,
    char_offset: entry.char_offset,
    source: entry.source,
    classification: {
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
    },
  };
}

const FE_CONTROL_TOKEN_PATTERN =
  /#(?:RUBS|RUBE|REND|C(?:DEF|\d{8,9})|ROFS-?\d+|SIZE\([^)]*\)|SP(?:\([^)]*\)|\d+)|SVT|FAMILY\d*|GIVEN\d*|NICK\d*|ITEM\d*|TITM\d*|TVAL\d*|VAL\d*|TRG\d*|ITALICS|[12])|<ICON[^>]*>/gu;

function collect_control_tokens(text: string): string[] {
  return text.match(FE_CONTROL_TOKEN_PATTERN) ?? [];
}

function same_string_array(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

function resolve_display_mode(metadata: FateExtraItemMetadata): FateExtraResolvedDisplayMode {
  return resolve_fate_extra_display_mode(metadata, read_fate_extra_display_mode(metadata)).mode;
}

/**
 * Fate/Extra project adapter. It keeps indexes out of the ordinary Item model,
 * but retains enough namespaced metadata to reconstruct byte-for-byte layout.
 */
export class FateExtraService {
  private readonly scan_drafts = new Map<string, ScanDraft>();
  private readonly display_classification_cache = new Map<
    string,
    {
      database_path: string;
      database_mtime_ms: number;
      rows: Map<string, FateExtraClassificationRow>;
    }
  >();
  private readonly display_file_summary_cache = new Map<
    string,
    { files: string[]; file_counts: MutableRecord; total: number }
  >();
  private readonly duplicate_index_ready = new Set<string>();

  public constructor(
    private readonly paths: AppPathService,
    private readonly database: ProjectDatabase,
    private readonly session_state: ProjectSessionState,
    private readonly operation_gate: ProjectOperationGate,
    private readonly write_store: ProjectWriteStore,
    private readonly font_service: FateExtraFontService,
    private readonly native_fs: NativeFs = default_native_fs,
  ) {}

  public scan(body: JsonRecord): JsonRecord {
    const project_path = this.require_loaded_project(body);
    const source_directory = this.optional_string(
      body,
      "source_directory",
      FATE_EXTRA_DEFAULT_INDEXED_SOURCE_DIRECTORY,
    );
    const classification_database = this.optional_string(
      body,
      "classification_database",
      FATE_EXTRA_DEFAULT_CLASSIFICATION_DATABASE,
    );
    const complete_jp_source_file = this.require_string(body, "complete_jp_source_file");
    this.assert_directory(source_directory, "索引原稿目录");
    this.assert_file(complete_jp_source_file, "Fate_Extra_JP_完整文本汇总.txt");
    this.assert_file(classification_database, "FE 文本安全分类数据库");

    const source_files = this.native_fs
      .read_dirents(source_directory)
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.toLowerCase().endsWith(".txt") &&
          entry.name !== FATE_EXTRA_SUPPLEMENT_FILE,
      )
      .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
    const complete_decoded = this.decode_source_file(
      complete_jp_source_file,
      path.basename(complete_jp_source_file),
    );
    const complete_parsed = parse_fate_extra_complete_source(complete_decoded.text);
    const classification_cache = new Map<string, FateExtraClassificationRow>();
    const canonical_by_key = new Map<string, FateExtraParsedIndexedText>();
    const route_unique_keys = new Set<string>();
    const indexed_offsets_by_path = new Map<string, number[]>();
    const structural_issues = [...complete_parsed.issues];
    for (const entry of complete_parsed.entries) {
      const key = `${entry.path}\u0000${entry.char_offset}`;
      const previous = canonical_by_key.get(key);
      if (previous !== undefined) {
        structural_issues.push(
          previous.source === entry.source
            ? `完整日文主库存在重复索引：${entry.path} / char:${entry.char_offset}`
            : `完整日文主库索引相同但原文冲突：${entry.path} / char:${entry.char_offset}`,
        );
        continue;
      }
      canonical_by_key.set(key, entry);
      const offsets = indexed_offsets_by_path.get(entry.path) ?? [];
      offsets.push(entry.char_offset);
      indexed_offsets_by_path.set(entry.path, offsets);
    }
    const source_inputs = source_files.map((source_file) => {
      const source_path = path.join(source_directory, source_file.name);
      const decoded = this.decode_source_file(source_path, source_file.name);
      for (const line of decoded.text.split(/\r\n|\n|\r/gu)) {
        const header = FATE_EXTRA_INDEX_LINE_PATTERN.exec(line);
        if (header === null) continue;
        const indexed_path = header[1] ?? "";
        const char_offset = Number(header[2] ?? Number.NaN);
        const key = `${indexed_path}\u0000${char_offset}`;
        route_unique_keys.add(key);
      }
      return { source_file, source_path, decoded };
    });
    const files: ScanFileDraft[] = [];
    const category_counts: Record<string, number> = {};
    let matched_classification_count = 0;

    for (const row of read_fate_extra_classifications(
      this.native_fs.to_native_path(classification_database),
      indexed_offsets_by_path,
    )) {
      classification_cache.set(`${row.path}\u0000${row.char_offset}`, row);
    }

    for (const input of source_inputs) {
      const expected: FateExtraExpectedIndexedText[] = [];
      for (const line of input.decoded.text.split(/\r\n|\n|\r/gu)) {
        const header = FATE_EXTRA_INDEX_LINE_PATTERN.exec(line);
        if (header === null) continue;
        const indexed_path = header[1] ?? "";
        const char_offset = Number(header[2] ?? Number.NaN);
        const key = `${indexed_path}\u0000${char_offset}`;
        const canonical = canonical_by_key.get(key);
        if (canonical === undefined) {
          structural_issues.push(
            `${input.source_file.name}: 索引 ${indexed_path} / char:${char_offset} 不存在于完整日文主库。`,
          );
          continue;
        }
        expected.push({
          path: canonical.path,
          char_offset: canonical.char_offset,
          source: canonical.source,
        });
      }
      const parsed = parse_fate_extra_indexed_text({
        text: input.decoded.text,
        expected,
      });
      structural_issues.push(
        ...parsed.issues.map((issue) => `${input.source_file.name}: ${issue}`),
      );
      files.push({
        source_path: input.source_path,
        relative_path: input.source_file.name,
        format: input.decoded.format,
        entries: parsed.entries,
        kind: "route",
      });
    }

    const route_logical_text_count = files.reduce((sum, file) => sum + file.entries.length, 0);
    const route_unique_index_count = route_unique_keys.size;
    const supplemental_entries: FateExtraParsedIndexedText[] = [];
    const supplemental_blocks: string[] = [];
    let supplemental_line_number = 1;
    for (const entry of complete_parsed.entries) {
      const key = `${entry.path}\u0000${entry.char_offset}`;
      if (route_unique_keys.has(key)) continue;
      const source_lines = entry.source.split(/\r\n|\n|\r/gu);
      supplemental_entries.push({
        path: entry.path,
        char_offset: entry.char_offset,
        original_prefix: entry.original_prefix,
        source: entry.source,
        source_line_numbers: source_lines.map((_line, index) => supplemental_line_number + index),
        pass_through: [],
        header_line_number: supplemental_line_number,
      });
      supplemental_blocks.push(`${entry.original_prefix}${source_lines.join("\r\n")}`);
      supplemental_line_number += source_lines.length;
    }

    let missing_classification_count = 0;
    for (const entry of complete_parsed.entries) {
      const key = `${entry.path}\u0000${entry.char_offset}`;
      if (classification_cache.has(key)) continue;
      classification_cache.set(key, unresolved_classification_row(entry));
      missing_classification_count += 1;
    }
    for (const file of files) {
      for (const entry of file.entries) {
        const row = classification_cache.get(`${entry.path}\u0000${entry.char_offset}`);
        if (row === undefined) continue;
        matched_classification_count += row.classification.confidence === "none" ? 0 : 1;
        category_counts[row.classification.category] =
          (category_counts[row.classification.category] ?? 0) + 1;
      }
    }
    for (const entry of supplemental_entries) {
      const row = classification_cache.get(`${entry.path}\u0000${entry.char_offset}`);
      if (row === undefined) continue;
      matched_classification_count += row.classification.confidence === "none" ? 0 : 1;
      category_counts[row.classification.category] =
        (category_counts[row.classification.category] ?? 0) + 1;
    }
    if (supplemental_entries.length > 0) {
      files.push({
        source_path: "",
        relative_path: FATE_EXTRA_SUPPLEMENT_FILE,
        format: {
          relative_path: FATE_EXTRA_SUPPLEMENT_FILE,
          encoding: "utf-8",
          eol: "\r\n",
          trailing_eol: true,
        },
        entries: supplemental_entries,
        kind: "supplement",
        synthetic_text: `${supplemental_blocks.join("\r\n")}\r\n`,
      });
    }

    const logical_text_count = files.reduce((sum, file) => sum + file.entries.length, 0);
    const applicable =
      structural_issues.length === 0 &&
      source_files.length === 6 &&
      route_logical_text_count === 34_693 &&
      route_unique_index_count === 7_867 &&
      complete_parsed.entries.length === 914_663;
    const migration_project = this.resolve_migration_project(body, project_path);
    const legacy_items = this.read_legacy_items(migration_project, project_path);
    const migration_text_directory = this.optional_string(
      body,
      "migration_text_directory",
      FATE_EXTRA_DEFAULT_UNINDEXED_TRANSLATION_DIRECTORY,
    );
    const unindexed = this.read_unindexed_translations(migration_text_directory, files);
    const migration = this.build_items(
      files,
      classification_cache,
      legacy_items,
      unindexed.translations,
    );
    const scan_id = randomUUID();
    const report: JsonRecord = {
      scan_id,
      applicable,
      source_file_count: source_files.length,
      physical_line_count: files.reduce(
        (sum, file) =>
          sum +
          file.entries.reduce(
            (entry_sum, entry) =>
              entry_sum + entry.source_line_numbers.length + entry.pass_through.length,
            0,
          ),
        0,
      ),
      logical_text_count,
      route_logical_text_count,
      complete_jp_text_count: complete_parsed.entries.length,
      supplemental_text_count: supplemental_entries.length,
      unique_index_count: canonical_by_key.size,
      route_unique_index_count,
      matched_classification_count,
      missing_classification_count,
      classification_match_rate:
        logical_text_count === 0 ? 0 : matched_classification_count / logical_text_count,
      category_counts,
      structural_issues: structural_issues.slice(0, 500),
      structural_issue_count: structural_issues.length,
      migration_project,
      migration_text_directory,
      migrated_exact: migration.exact,
      migrated_high_confidence: migration.high_confidence,
      migrated_unindexed_text: migration.unindexed,
      migration_pending: migration.issues.length,
      migration_text_issues: unindexed.issues,
      expected_acceptance: {
        source_file_count: 6,
        route_logical_text_count: 34_693,
        route_unique_index_count: 7_867,
        complete_jp_text_count: 914_663,
      },
    };
    const corpus = this.font_service.build_corpus(migration.items);
    const adapter_meta: FateExtraAdapterMetadata = {
      schema_version: FATE_EXTRA_SCHEMA_VERSION,
      enabled: true,
      applied_at: "",
      source_directory,
      complete_jp_source_file,
      classification_database,
      source_file_count: source_files.length,
      logical_text_count,
      unique_index_count: canonical_by_key.size,
      matched_classification_count,
      supplemental_text_count: supplemental_entries.length,
      rules_version: "fe.3",
      file_formats: files.map((file) => file.format),
      font_corpus_hash: corpus.corpus_sha256,
      font_manifest_hash: "",
      remaining_extension_slots: 0,
    };
    if (applicable) {
      this.scan_drafts.set(scan_id, {
        id: scan_id,
        project_path,
        project_section_revisions: this.read_guarded_project_revisions(project_path),
        source_directory,
        source_mtime_ms: this.native_fs.stat(source_directory).mtimeMs,
        complete_jp_source_file,
        complete_jp_source_mtime_ms: this.native_fs.stat(complete_jp_source_file).mtimeMs,
        classification_database,
        database_mtime_ms: this.native_fs.stat(classification_database).mtimeMs,
        files,
        items: migration.items,
        report,
        adapter_meta,
        migration_issues: migration.issues,
      });
    }
    return report;
  }

  public async apply(body: JsonRecord): Promise<JsonRecord> {
    const project_path = this.require_loaded_project(body);
    const scan_id = this.require_string(body, "scan_id");
    const draft = this.scan_drafts.get(scan_id);
    if (draft === undefined || draft.project_path !== project_path) {
      this.throw_validation_error("FE 扫描报告已失效，请重新扫描。");
    }
    return await this.operation_gate.run_exclusive_project_write(async () => {
      this.assert_draft_unchanged(draft);
      const backup_path = this.create_project_backup(project_path);
      const asset_records = this.read_array_operation("getAllAssetRecords", project_path);
      const generated_assets: string[] = [];
      for (const file of draft.files) {
        if (file.synthetic_text === undefined) continue;
        const generated_path = path.join(
          path.dirname(project_path),
          `.fe-generated-${randomUUID()}-${file.relative_path}`,
        );
        this.native_fs.write_file_sync(generated_path, file.synthetic_text);
        file.source_path = generated_path;
        generated_assets.push(generated_path);
      }
      const asset_writes = [
        ...asset_records.map((record) => ({
          kind: "delete" as const,
          path: String(record["path"] ?? ""),
        })),
        ...draft.files.map((file, index) => ({
          kind: "add_from_source" as const,
          path: file.relative_path,
          sourcePath: file.source_path,
          sortOrder: index,
        })),
      ];
      const processed_line = draft.items.filter((item) => item["status"] === "PROCESSED").length;
      draft.adapter_meta.applied_at = new Date().toISOString();
      let write_result: Record<string, unknown>;
      try {
        write_result = await this.write_store.replace_workbench_items_and_files({
          projectPath: project_path,
          expectedSectionRevisions: body["expected_section_revisions"],
          revisionSections: ["files", "items", "analysis", "proofreading"],
          source: "fate_extra_adapter_apply",
          updatedSections: ["files", "items", "analysis", "proofreading"],
          assetWrites: asset_writes,
          items: draft.items as Record<string, ApiJsonValue>[],
          meta: {
            [FATE_EXTRA_ADAPTER_META_KEY]: draft.adapter_meta as unknown as ApiJsonValue,
            translation_extras: {
              line: processed_line,
              processed_line,
              error_line: 0,
              total_line: draft.items.length,
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
              total_line: draft.items.length,
            },
            analysis_candidate_count: 0,
          },
          resetAnalysis: true,
        });
      } finally {
        for (const generated_path of generated_assets) {
          if (this.native_fs.exists(generated_path)) this.native_fs.unlink(generated_path);
        }
      }
      const reports = this.write_migration_reports(project_path, draft.migration_issues);
      this.scan_drafts.delete(scan_id);
      this.display_file_summary_cache.delete(project_path);
      this.display_classification_cache.delete(project_path);
      this.duplicate_index_ready.delete(project_path);
      return {
        ...write_result,
        backup_path,
        migration_report_json: reports.json,
        migration_report_csv: reports.csv,
        logical_text_count: draft.items.length,
      } as unknown as JsonRecord;
    });
  }

  public status(body: JsonRecord): JsonRecord {
    const project_path = this.require_loaded_project(body);
    const meta = this.read_record_operation("getAllMeta", project_path);
    const adapter = read_record(meta[FATE_EXTRA_ADAPTER_META_KEY]);
    const enabled =
      adapter["enabled"] === true &&
      Number(adapter["schema_version"]) === FATE_EXTRA_SCHEMA_VERSION;
    const compact = read_record(
      this.database.execute({
        name: "getFateExtraCompactState",
        args: { projectPath: project_path },
      }),
    );
    return {
      enabled,
      schema_version: enabled ? FATE_EXTRA_SCHEMA_VERSION : 0,
      logical_text_count: enabled ? Number(adapter["logical_text_count"] ?? 0) : 0,
      applied_at: enabled ? String(adapter["applied_at"] ?? "") : "",
      compact_enabled: compact["enabled"] === true,
      compact_item_count: Number(compact["compact_item_count"] ?? 0),
      physical_item_count: Number(compact["physical_item_count"] ?? 0),
    };
  }

  public async create_compact_project(body: JsonRecord): Promise<JsonRecord> {
    const project_path = this.require_loaded_project(body);
    const target_project_path = this.require_string(body, "target_project_path");
    const target_with_extension =
      path.extname(target_project_path).toLocaleLowerCase() === ".lg"
        ? target_project_path
        : `${target_project_path}.lg`;
    const project_name = this.optional_string(
      body,
      "name",
      `${path.parse(project_path).name}-FE-精简工程`,
    );
    return await this.operation_gate.run_exclusive_project_write(async () => {
      return read_record(
        this.database.execute({
          name: "createFateExtraCompactProject",
          args: {
            projectPath: project_path,
            targetProjectPath: target_with_extension,
            name: project_name,
          },
        }),
      ) as unknown as JsonRecord;
    });
  }

  public list_items(body: JsonRecord): JsonRecord {
    const project_path = this.require_loaded_project(body);
    const requested_view_mode =
      String(body["view_mode"] ?? "unique") === "occurrence" ? "occurrence" : "unique";
    let index_state = {
      ready: requested_view_mode === "occurrence",
      item_count: 0,
      occurrence_count: 0,
      unit_count: 0,
    };
    if (requested_view_mode === "unique") {
      index_state = read_record(
        this.database.execute({
          name: "getFateExtraTextUnitIndexState",
          args: { projectPath: project_path },
        }),
      ) as typeof index_state;
      if (index_state.ready) this.duplicate_index_ready.add(project_path);
    }
    // Never rebuild a near-million-row derived index inside the first preview
    // request.  An old project can be browsed immediately in occurrence mode
    // while the renderer explicitly starts the background rebuild endpoint.
    const view_mode =
      requested_view_mode === "unique" && index_state.ready !== true
        ? "occurrence"
        : requested_view_mode;
    const search = this.optional_string(body, "search", "").toLocaleLowerCase();
    const file_filter = this.optional_string(body, "file_path", "");
    const warning_filter = this.optional_string(body, "warning", "");
    const category_filter = this.optional_string(body, "category", "");
    const offset = Math.max(0, Math.trunc(Number(body["offset"] ?? 0)));
    const limit = Math.max(1, Math.min(500, Math.trunc(Number(body["limit"] ?? 120))));
    const cached_file_summary = this.display_file_summary_cache.get(project_path);
    const should_read_file_summary =
      index_state.ready === true &&
      cached_file_summary === undefined &&
      search === "" &&
      file_filter === "" &&
      category_filter === "";
    const has_base_filters = search !== "" || file_filter !== "" || category_filter !== "";
    const page = read_record(
      this.database.execute({
        name: "getFateExtraItemsPage",
        args: {
          projectPath: project_path,
          search,
          filePath: file_filter,
          category: category_filter,
          offset,
          limit,
          includeFiles: should_read_file_summary,
          includeTotal:
            view_mode === "unique" || cached_file_summary === undefined || has_base_filters,
          viewMode: view_mode,
        },
      }),
    );
    const source_items = Array.isArray(page["items"])
      ? page["items"].filter(
          (item): item is MutableRecord =>
            typeof item === "object" && item !== null && !Array.isArray(item),
        )
      : [];
    if (should_read_file_summary) {
      this.display_file_summary_cache.set(project_path, {
        files: Array.isArray(page["files"]) ? page["files"].map((value) => String(value)) : [],
        file_counts: read_record(page["file_counts"]),
        total: Number(page["total"] ?? 0),
      });
    }
    const file_summary =
      this.display_file_summary_cache.get(project_path) ??
      ({ files: [], file_counts: {}, total: 0 } as const);
    const display_classifications = this.read_display_classifications(project_path, source_items);
    const rows = source_items
      .flatMap((item) => {
        const stored_metadata = read_fate_extra_item_metadata(
          item["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
        );
        if (stored_metadata === null) return [];
        const live_classification = display_classifications.get(
          `${stored_metadata.path}\u0000${stored_metadata.char_offset}`,
        )?.classification;
        const metadata: FateExtraItemMetadata =
          live_classification === undefined
            ? stored_metadata
            : { ...stored_metadata, classification: live_classification };
        const src = String(item["src"] ?? "");
        const dst = String(item["dst"] ?? "");
        const proofread_translation = read_fate_extra_proofread_translation(metadata);
        const translated = resolve_fate_extra_effective_translation(dst, metadata);
        const effective = translated === "" ? src : translated;
        const display_resolution = resolve_fate_extra_display_mode(
          metadata,
          read_fate_extra_display_mode(metadata),
        );
        const display_mode = display_resolution.mode;
        const encoded_bytes = this.font_service.measure_encoded_bytes(effective);
        const machine_encoded_bytes = this.font_service.measure_encoded_bytes(dst || src);
        const proofread_encoded_bytes = this.font_service.measure_encoded_bytes(
          proofread_translation || dst || src,
        );
        const capacity = metadata.classification.slot_capacity;
        const storage_overflow =
          capacity !== null &&
          !metadata.classification.allow_overlength &&
          encoded_bytes > capacity;
        const safety_blocker = metadata.classification.category === "unresolved_candidate";
        const overflow = has_fate_extra_psp_overflow(effective, display_mode);
        const warnings = [
          ...(overflow ? [FATE_EXTRA_OVERFLOW_WARNING_CODE] : []),
          ...(storage_overflow ? ["FE_STORAGE_CAPACITY"] : []),
          ...(safety_blocker ? ["FE_SAFETY_BLOCKER"] : []),
          ...(metadata.migration_review ? ["FE_MIGRATION_REVIEW"] : []),
        ];
        return [
          {
            item_id: Number(item["id"] ?? item["item_id"] ?? 0),
            text_unit_id: Number(item["fe_text_unit_id"] ?? 0),
            occurrence_count: Math.max(1, Number(item["fe_occurrence_count"] ?? 1)),
            file_path: String(item["file_path"] ?? ""),
            row_number: Number(item["row"] ?? item["row_number"] ?? 0),
            src,
            dst,
            machine_translation: dst,
            proofread_translation,
            effective_translation: translated,
            status: String(item["status"] ?? "NONE"),
            warnings,
            overflow,
            display_mode: read_fate_extra_display_mode(metadata),
            resolved_display_mode: display_mode,
            display_resolution,
            encoded_bytes,
            machine_encoded_bytes,
            proofread_encoded_bytes,
            slot_capacity: capacity,
            classification: metadata.classification,
            index: { path: metadata.path, char_offset: metadata.char_offset },
          },
        ];
      })
      .filter((item) => {
        if (file_filter !== "" && item.file_path !== file_filter) return false;
        if (category_filter !== "" && item.classification.category !== category_filter)
          return false;
        if (warning_filter !== "" && !item.warnings.includes(warning_filter)) return false;
        if (
          search !== "" &&
          !`${item.src}\n${item.machine_translation}\n${item.proofread_translation}\n${item.file_path}`
            .toLocaleLowerCase()
            .includes(search)
        ) {
          return false;
        }
        return true;
      });
    const visible_rows =
      warning_filter === "" ? rows : rows.filter((item) => item.warnings.includes(warning_filter));
    return {
      // Warning filters are evaluated after the bounded database page because the
      // PSP byte encoder and layout engine are not available to SQLite.  Normal
      // browsing/searching remains exact and never materialises the whole project.
      total:
        warning_filter !== ""
          ? visible_rows.length
          : Number(page["total"] ?? -1) >= 0
            ? Number(page["total"] ?? 0)
            : file_summary.total,
      offset,
      items: visible_rows,
      files: file_summary.files,
      file_counts: file_summary.file_counts,
      view_mode,
      requested_view_mode,
      index_ready: index_state.ready === true,
      index_state,
    } as unknown as JsonRecord;
  }

  public rebuild_duplicate_index(body: JsonRecord): JsonRecord {
    const project_path = this.require_loaded_project(body);
    this.ensure_duplicate_index(project_path);
    return read_record(
      this.database.execute({
        name: "getFateExtraTextUnitIndexState",
        args: { projectPath: project_path },
      }),
    ) as unknown as JsonRecord;
  }

  /** Return the current master-script entry with two neighbours on each side.
   * The order is DAT-local and follows char offsets from the complete JP source,
   * not route-file order or exact-source deduplication order.
   */
  public context(body: JsonRecord): JsonRecord {
    const project_path = this.require_loaded_project(body);
    const resource_path = this.require_string(body, "resource_path");
    const char_offset = Math.trunc(Number(body["char_offset"] ?? -1));
    const radius = Math.max(0, Math.min(20, Math.trunc(Number(body["radius"] ?? 2))));
    if (resource_path === "" || char_offset < 0) {
      this.throw_validation_error("Invalid Fate/Extra context index.");
    }
    const result = read_record(
      this.database.execute({
        name: "getFateExtraContext",
        args: {
          projectPath: project_path,
          resourcePath: resource_path,
          charOffset: char_offset,
          radius,
        },
      }),
    );
    const rows = Array.isArray(result["items"]) ? result["items"] : [];
    return {
      found: result["found"] === true,
      resource_path: String(result["resource_path"] ?? resource_path),
      target_ordinal: Number(result["target_ordinal"] ?? -1),
      block_count: Number(result["block_count"] ?? 0),
      radius,
      items: rows.map((value) => {
        const row = read_record(value);
        const item = read_record(row["item"]);
        const fallback_source = String(row["fallback_source"] ?? "");
        const source = String(item["src"] ?? fallback_source);
        const machine_translation = String(item["dst"] ?? "") || source;
        const metadata = read_fate_extra_item_metadata(
          item["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
        );
        return {
          item_id: Number(item["id"] ?? row["representative_item_id"] ?? 0),
          char_offset: Number(row["char_offset"] ?? -1),
          block_ordinal: Number(row["block_ordinal"] ?? -1),
          is_current: Number(row["char_offset"] ?? -1) === char_offset,
          source,
          machine_translation,
          proofread_translation: metadata === null
            ? ""
            : read_fate_extra_proofread_translation(metadata),
          status: String(item["status"] ?? "NONE"),
        };
      }),
    } as unknown as JsonRecord;
  }

  private ensure_duplicate_index(project_path: string): void {
    if (this.duplicate_index_ready.has(project_path)) return;
    const state = read_record(
      this.database.execute({
        name: "getFateExtraTextUnitIndexState",
        args: { projectPath: project_path },
      }),
    );
    if (state["ready"] !== true) {
      this.database.execute_transaction([
        {
          name: "rebuildFateExtraTextUnitIndex",
          args: { projectPath: project_path },
        },
      ]);
    }
    const verified = read_record(
      this.database.execute({
        name: "getFateExtraTextUnitIndexState",
        args: { projectPath: project_path },
      }),
    );
    if (verified["ready"] !== true) {
      throw new AppErrors.InternalInvariantError({
        diagnostic_context: {
          reason: "fate_extra_duplicate_index_incomplete",
          item_count: verified["item_count"],
          occurrence_count: verified["occurrence_count"],
        },
      });
    }
    this.duplicate_index_ready.add(project_path);
  }

  private read_display_classifications(
    project_path: string,
    items: readonly Record<string, unknown>[],
  ): ReadonlyMap<string, FateExtraClassificationRow> {
    const meta = this.read_record_operation("getAllMeta", project_path);
    const adapter = read_record(meta[FATE_EXTRA_ADAPTER_META_KEY]);
    const database_path = String(adapter["classification_database"] ?? "");
    if (database_path === "" || !this.native_fs.exists(database_path)) return new Map();
    const database_mtime_ms = this.native_fs.stat(database_path).mtimeMs;
    const cached = this.display_classification_cache.get(project_path);
    const cache_is_current =
      cached !== undefined &&
      cached.database_path === database_path &&
      cached.database_mtime_ms === database_mtime_ms;
    const rows = cache_is_current ? cached.rows : new Map<string, FateExtraClassificationRow>();

    const indexed_offsets_by_path = new Map<string, number[]>();
    for (const item of items) {
      const metadata = read_fate_extra_item_metadata(
        item["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
      );
      if (metadata === null) continue;
      if (rows.has(`${metadata.path}\u0000${metadata.char_offset}`)) continue;
      const offsets = indexed_offsets_by_path.get(metadata.path) ?? [];
      if (!offsets.includes(metadata.char_offset)) offsets.push(metadata.char_offset);
      indexed_offsets_by_path.set(metadata.path, offsets);
    }
    if (indexed_offsets_by_path.size > 0) {
      for (const row of read_fate_extra_classifications(
        this.native_fs.to_native_path(database_path),
        indexed_offsets_by_path,
      )) {
        rows.set(`${row.path}\u0000${row.char_offset}`, row);
      }
    }
    this.display_classification_cache.set(project_path, {
      database_path,
      database_mtime_ms,
      rows,
    });
    return rows;
  }

  public preview(body: JsonRecord): JsonRecord {
    const text = String(body["text"] ?? "");
    const requested_mode = String(body["display_mode"] ?? "unknown");
    const display_mode: FateExtraResolvedDisplayMode =
      requested_mode === "dialogue" || requested_mode === "fullscreen" || requested_mode === "poem"
        ? requested_mode
        : "unknown";
    const layout = layout_fate_extra_preview({
      text,
      display_mode,
      line_limit: Number(body["line_limit"] ?? 0),
      state: {
        servant_index: Number(body["servant_index"] ?? 0),
        gender_index: Number(body["gender_index"] ?? 0),
      },
    });
    return {
      ...layout,
      encoded_bytes: this.font_service.measure_encoded_bytes(text),
    } as unknown as JsonRecord;
  }

  public async save_review(body: JsonRecord): Promise<JsonRecord> {
    const project_path = this.require_loaded_project(body);
    const item_id = Math.trunc(Number(body["item_id"] ?? 0));
    if (!Number.isInteger(item_id) || item_id <= 0) {
      this.throw_validation_error("无效的 FE 文本条目编号。");
    }
    const rows = this.database.execute({
      name: "getItemsByIds",
      args: { projectPath: project_path, itemIds: [item_id] },
    });
    const item = Array.isArray(rows) ? read_record(rows[0]) : {};
    const metadata = read_fate_extra_item_metadata(
      item["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
    );
    if (metadata === null) this.throw_validation_error("该条目不是有效的 FE 文本。");
    const requested_mode = String(body["display_mode"] ?? "auto");
    const display_mode: FateExtraDisplayMode =
      requested_mode === "dialogue" || requested_mode === "fullscreen" || requested_mode === "poem"
        ? requested_mode
        : "auto";
    const review_scope = String(body["review_scope"] ?? "occurrence");
    const unit_id = Math.trunc(Number(body["text_unit_id"] ?? 0));
    const proofread_translation = String(body["proofread_translation"] ?? "");
    if (review_scope === "unit") {
      if (!Number.isInteger(unit_id) || unit_id <= 0) {
        this.throw_validation_error("无效的 FE 严格重复组编号。");
      }
      if (proofread_translation === read_fate_extra_proofread_translation(metadata)) {
        const display_only_metadata: FateExtraItemMetadata = {
          ...metadata,
          display_mode,
        };
        return (await this.write_store.apply_fate_extra_item_metadata({
          projectPath: project_path,
          expectedSectionRevisions: body["expected_section_revisions"],
          itemId: item_id,
          extraField: merge_fate_extra_item_metadata(
            item["extra_field"] as Parameters<typeof merge_fate_extra_item_metadata>[0],
            display_only_metadata,
          ) as ApiJsonValue,
        })) as unknown as JsonRecord;
      }
      this.ensure_duplicate_index(project_path);
      return (await this.write_store.apply_fate_extra_text_unit_review({
        projectPath: project_path,
        expectedSectionRevisions: body["expected_section_revisions"],
        unitId: unit_id,
        itemId: item_id,
        proofreadTranslation: proofread_translation,
        displayMode: display_mode,
      })) as unknown as JsonRecord;
    }
    const next_metadata: FateExtraItemMetadata = {
      ...metadata,
      proofread_translation,
      display_mode,
    };
    const result = await this.write_store.apply_fate_extra_item_metadata({
      projectPath: project_path,
      expectedSectionRevisions: body["expected_section_revisions"],
      itemId: item_id,
      extraField: merge_fate_extra_item_metadata(
        item["extra_field"] as Parameters<typeof merge_fate_extra_item_metadata>[0],
        next_metadata,
      ) as ApiJsonValue,
    });
    return result as unknown as JsonRecord;
  }

  public async export_project(body: JsonRecord): Promise<JsonRecord> {
    const project_path = this.require_loaded_project(body);
    const output_directory = this.require_string(body, "output_directory");
    const restore_index = body["restore_index"] === true || body["mode"] === "restore-index";
    const meta = this.read_record_operation("getAllMeta", project_path);
    const adapter = read_record(meta[FATE_EXTRA_ADAPTER_META_KEY]);
    const compact_state = read_record(
      this.database.execute({
        name: "getFateExtraCompactState",
        args: { projectPath: project_path },
      }),
    );
    if (compact_state["enabled"] === true) {
      return await this.export_compact_project({
        project_path,
        output_directory,
        restore_index,
        adapter,
      });
    }
    const items = this.read_array_operation("getAllItems", project_path);
    if (adapter["enabled"] !== true || Number(adapter["schema_version"]) !== 1) {
      this.throw_validation_error(
        "当前项目尚未启用 Fate/Extra 汉化适配。请先生成扫描报告，再应用 FE 适配。",
      );
    }
    const item_rows = items.map((item) => ({
      item,
      metadata: read_fate_extra_item_metadata(
        item["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
      ),
    }));
    if (item_rows.some((row) => row.metadata === null)) {
      this.throw_validation_error("FE 索引结构已损坏：项目中存在缺少索引元数据的文本。");
    }
    const expected_count = Number(adapter["logical_text_count"] ?? 0);
    if (expected_count !== item_rows.length) {
      this.throw_validation_error("FE 索引结构已损坏：逻辑文本数量与适配清单不一致。");
    }
    this.native_fs.make_dir(output_directory);
    const font_output = path.join(output_directory, "fate-extra-font", "NPJH50247");
    const font_manifest = this.font_service.sync_items(items, font_output);
    const warnings = this.build_qa_warnings(
      item_rows as Array<{
        item: MutableRecord;
        metadata: FateExtraItemMetadata;
      }>,
    );
    const blocker_count = warnings.filter((warning) => warning.severity === "blocker").length;
    const formats = Array.isArray(adapter["file_formats"])
      ? (adapter["file_formats"] as unknown as FateExtraFileFormat[])
      : [];
    const format_by_path = new Map(formats.map((format) => [format.relative_path, format]));
    const grouped = new Map<
      string,
      Array<{ item: MutableRecord; metadata: FateExtraItemMetadata }>
    >();
    for (const row of item_rows as Array<{
      item: MutableRecord;
      metadata: FateExtraItemMetadata;
    }>) {
      const file_path = String(row.item["file_path"] ?? "");
      const group = grouped.get(file_path) ?? [];
      group.push(row);
      grouped.set(file_path, group);
    }
    const outputs: string[] = [];
    for (const [file_path, group] of grouped) {
      group.sort((left, right) => Number(left.item["row"] ?? 0) - Number(right.item["row"] ?? 0));
      const lines: string[] = [];
      for (const row of group) {
        lines.push(
          ...rebuild_fate_extra_indexed_block({
            entry: {
              path: row.metadata.path,
              char_offset: row.metadata.char_offset,
              original_prefix: row.metadata.original_prefix,
              source: String(row.item["src"] ?? ""),
              source_line_numbers: row.metadata.source_line_numbers,
              pass_through: row.metadata.pass_through,
              header_line_number: Number(row.item["row"] ?? 0) + 1,
            },
            translation: resolve_fate_extra_effective_translation(
              String(row.item["dst"] ?? ""),
              row.metadata,
            ),
            restore_index,
          }),
        );
      }
      const format = format_by_path.get(file_path) ?? {
        relative_path: file_path,
        encoding: "utf-8" as const,
        eol: "\n" as const,
        trailing_eol: true,
      };
      const text = `${format.encoding === "utf-8-bom" ? "\uFEFF" : ""}${lines.join(
        format.eol,
      )}${format.trailing_eol ? format.eol : ""}`;
      const output_path = path.join(output_directory, file_path);
      this.atomic_write(output_path, text);
      outputs.push(output_path);
    }
    const qa_path = path.join(output_directory, "fate-extra-qa-report.json");
    const qa_csv_path = path.join(output_directory, "fate-extra-qa-report.csv");
    const safety_manifest_path = path.join(output_directory, "fate-extra-injection-safety.json");
    const safety_entries = (
      item_rows as Array<{
        item: MutableRecord;
        metadata: FateExtraItemMetadata;
      }>
    ).map((row) => {
      const machine = String(row.item["dst"] ?? "");
      const translated = resolve_fate_extra_effective_translation(machine, row.metadata);
      const effective = translated === "" ? String(row.item["src"] ?? "") : translated;
      return {
        path: row.metadata.path,
        char_offset: row.metadata.char_offset,
        category: row.metadata.classification.category,
        category_zh: row.metadata.classification.category_zh,
        display_mode: resolve_display_mode(row.metadata),
        encoded_bytes: this.font_service.measure_encoded_bytes(effective),
        slot_capacity: row.metadata.classification.slot_capacity,
        source_bytes: row.metadata.classification.source_bytes,
        allow_overlength: row.metadata.classification.allow_overlength,
        allow_relocation: row.metadata.classification.allow_relocation,
        pointer_offsets: row.metadata.classification.pointer_offsets,
        address_limit: row.metadata.classification.address_limit,
        preserve_high16: row.metadata.classification.preserve_high16,
        shared_storage_group: row.metadata.classification.shared_storage_group,
        format_handler: row.metadata.classification.format_handler,
      };
    });
    this.atomic_write(
      qa_path,
      `${JSON.stringify(
        {
          schema_version: 1,
          exported_at: new Date().toISOString(),
          mode: restore_index ? "restore-index" : "without-index",
          warning_count: warnings.length,
          blocker_count,
          warnings,
          font_manifest,
        },
        null,
        2,
      )}\n`,
    );
    this.atomic_write(
      qa_csv_path,
      [
        ["file_path", "row_number", "path", "char_offset", "warning", "message"]
          .map(csv_cell)
          .join(","),
        ...warnings.map((warning) =>
          [
            warning.file_path,
            warning.row_number,
            warning.path,
            warning.char_offset,
            warning.warning,
            warning.message,
          ]
            .map(csv_cell)
            .join(","),
        ),
      ].join("\r\n"),
    );
    this.atomic_write(
      safety_manifest_path,
      `${JSON.stringify(
        {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          entry_count: safety_entries.length,
          blocker_count,
          entries: safety_entries,
        },
        null,
        2,
      )}\n`,
    );
    await this.write_store.apply_project_settings_meta({
      projectPath: project_path,
      meta: {
        [FATE_EXTRA_ADAPTER_META_KEY]: {
          ...adapter,
          font_corpus_hash: String(font_manifest["corpus_sha256"] ?? ""),
          font_manifest_hash: String(font_manifest["manifest_sha256"] ?? ""),
          remaining_extension_slots: Number(font_manifest["remaining_extension_slots"] ?? 0),
        } as unknown as ApiJsonValue,
      },
    });
    return {
      accepted: true,
      mode: restore_index ? "restore-index" : "without-index",
      output_files: outputs,
      qa_report: qa_path,
      qa_report_csv: qa_csv_path,
      safety_manifest: safety_manifest_path,
      warning_count: warnings.length,
      blocker_count,
      font_output,
      font_manifest,
    } as unknown as JsonRecord;
  }

  /** Expand a compact project back to every physical FE occurrence without ever
   * materialising the near-million-row corpus in JavaScript at once. */
  private async export_compact_project(args: {
    project_path: string;
    output_directory: string;
    restore_index: boolean;
    adapter: MutableRecord;
  }): Promise<JsonRecord> {
    const compact_items = this.read_array_operation("getAllItems", args.project_path);
    this.native_fs.make_dir(args.output_directory);
    const font_output = path.join(args.output_directory, "fate-extra-font", "NPJH50247");
    const font_manifest = this.font_service.sync_items(compact_items, font_output);
    const formats = Array.isArray(args.adapter["file_formats"])
      ? (args.adapter["file_formats"] as unknown as FateExtraFileFormat[])
      : [];
    const format_by_path = new Map(formats.map((format) => [format.relative_path, format]));
    const output_paths = new Map<string, string>();
    const output_buffers = new Map<string, string>();
    const output_has_content = new Set<string>();
    const output_order: string[] = [];
    const qa_path = path.join(args.output_directory, "fate-extra-qa-report.json");
    const qa_csv_path = path.join(args.output_directory, "fate-extra-qa-report.csv");
    const safety_path = path.join(args.output_directory, "fate-extra-injection-safety.json");
    this.native_fs.write_file_sync(
      qa_csv_path,
      ["file_path", "row_number", "path", "char_offset", "warning", "message"]
        .map(csv_cell)
        .join(",") + "\r\n",
    );
    this.native_fs.write_file_sync(
      qa_path,
      '{"schema_version":1,"compact_export":true,"warnings":[',
    );
    this.native_fs.write_file_sync(
      safety_path,
      '{"schema_version":1,"compact_export":true,"entries":[',
    );
    const classification_database = String(args.adapter["classification_database"] ?? "");
    if (classification_database === "" || !this.native_fs.exists(classification_database)) {
      this.throw_validation_error("精简工程导出需要有效的 FE 文本安全分类数据库。");
    }
    const flush_output = (file_path: string): void => {
      const buffered = output_buffers.get(file_path) ?? "";
      if (buffered === "") return;
      this.native_fs.append_text_file(output_paths.get(file_path)!, buffered);
      output_buffers.set(file_path, "");
    };
    let offset = 0;
    let exported_count = 0;
    let warning_count = 0;
    let blocker_count = 0;
    let safety_count = 0;
    while (true) {
      const page = read_record(
        this.database.execute({
          name: "getFateExtraCompactExportPage",
          args: { projectPath: args.project_path, offset, limit: 5_000 },
        }),
      );
      const rows = Array.isArray(page["rows"])
        ? page["rows"].map((value) => read_record(value))
        : [];
      if (rows.length === 0) break;
      const offsets_by_path = new Map<string, number[]>();
      for (const row of rows) {
        const resource_path = String(row["resource_path"] ?? "");
        const offsets = offsets_by_path.get(resource_path) ?? [];
        offsets.push(Number(row["char_offset"] ?? -1));
        offsets_by_path.set(resource_path, offsets);
      }
      const classifications = new Map<string, FateExtraClassificationRow>();
      for (const classification_row of read_fate_extra_classifications(
        this.native_fs.to_native_path(classification_database),
        offsets_by_path,
      )) {
        classifications.set(
          `${classification_row.path}\u0000${classification_row.char_offset}`,
          classification_row,
        );
      }
      for (const row of rows) {
        const file_path = String(row["file_path"] ?? "");
        const resource_path = String(row["resource_path"] ?? "");
        const char_offset = Number(row["char_offset"] ?? -1);
        const classification = classifications.get(`${resource_path}\u0000${char_offset}`);
        if (classification === undefined) {
          this.throw_validation_error(
            `精简映射缺少安全分类：${resource_path} / char:${char_offset}`,
          );
        }
        const compact_item = read_record(row["compact_item"]);
        const representative_metadata = read_fate_extra_item_metadata(
          compact_item["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
        );
        const source = String(row["source"] ?? "");
        const source_line_numbers = Array.isArray(row["source_line_numbers"])
          ? row["source_line_numbers"].map((value) => Number(value))
          : [];
        const pass_through = Array.isArray(row["pass_through"])
          ? (row["pass_through"] as FateExtraItemMetadata["pass_through"])
          : [];
        const stored_display_mode = String(row["display_mode"] ?? "auto");
        const metadata: FateExtraItemMetadata = {
          schema_version: FATE_EXTRA_SCHEMA_VERSION,
          path: resource_path,
          char_offset,
          original_prefix: String(row["original_prefix"] ?? ""),
          source_hash: createHash("sha256").update(source, "utf-8").digest("hex"),
          source_line_numbers,
          pass_through,
          classification: classification.classification,
          migration_review: representative_metadata?.migration_review ?? false,
          migration_source: representative_metadata?.migration_source ?? "compact-source",
          proofread_translation: representative_metadata?.proofread_translation ?? "",
          display_mode:
            stored_display_mode === "dialogue" ||
            stored_display_mode === "fullscreen" ||
            stored_display_mode === "poem"
              ? stored_display_mode
              : (representative_metadata?.display_mode ?? "auto"),
        };
        const machine_translation = String(compact_item["dst"] ?? "");
        const override_translation = String(row["override_translation"] ?? "");
        const translation =
          String(row["excluded_reason"] ?? "") !== ""
            ? source
            : override_translation !== ""
              ? override_translation
              : resolve_fate_extra_effective_translation(machine_translation, metadata);
        const effective = translation === "" ? source : translation;
        const format = format_by_path.get(file_path) ?? {
          relative_path: file_path,
          encoding: "utf-8" as const,
          eol: "\n" as const,
          trailing_eol: true,
        };
        if (!output_paths.has(file_path)) {
          const output_path = path.join(args.output_directory, file_path);
          this.native_fs.write_file_sync(
            output_path,
            format.encoding === "utf-8-bom" ? "\uFEFF" : "",
          );
          output_paths.set(file_path, output_path);
          output_order.push(output_path);
        }
        const block = rebuild_fate_extra_indexed_block({
          entry: {
            path: resource_path,
            char_offset,
            original_prefix: metadata.original_prefix,
            source,
            source_line_numbers,
            pass_through,
            header_line_number: Number(row["row_number"] ?? 0) + 1,
          },
          translation: effective,
          restore_index: args.restore_index,
        }).join(format.eol);
        output_buffers.set(
          file_path,
          `${output_buffers.get(file_path) ?? ""}${output_has_content.has(file_path) ? format.eol : ""}${block}`,
        );
        output_has_content.add(file_path);
        if ((output_buffers.get(file_path)?.length ?? 0) >= 1_000_000) flush_output(file_path);
        const export_item: MutableRecord = {
          ...compact_item,
          id: Number(row["original_item_id"] ?? 0),
          src: source,
          dst: machine_translation,
          file_path,
          row: Number(row["row_number"] ?? 0),
          extra_field: merge_fate_extra_item_metadata(
            compact_item["extra_field"] as Parameters<typeof merge_fate_extra_item_metadata>[0],
            metadata,
          ),
        };
        for (const warning of this.build_qa_warnings([{ item: export_item, metadata }])) {
          if (warning_count > 0) this.native_fs.append_text_file(qa_path, ",");
          this.native_fs.append_text_file(qa_path, JSON.stringify(warning));
          this.native_fs.append_text_file(
            qa_csv_path,
            [
              warning.file_path,
              warning.row_number,
              warning.path,
              warning.char_offset,
              warning.warning,
              warning.message,
            ]
              .map(csv_cell)
              .join(",") + "\r\n",
          );
          warning_count += 1;
          if (warning.severity === "blocker") blocker_count += 1;
        }
        const safety_entry = {
          path: resource_path,
          char_offset,
          category: metadata.classification.category,
          category_zh: metadata.classification.category_zh,
          display_mode: resolve_display_mode(metadata),
          encoded_bytes: this.font_service.measure_encoded_bytes(effective),
          slot_capacity: metadata.classification.slot_capacity,
          source_bytes: metadata.classification.source_bytes,
          allow_overlength: metadata.classification.allow_overlength,
          allow_relocation: metadata.classification.allow_relocation,
          pointer_offsets: metadata.classification.pointer_offsets,
          address_limit: metadata.classification.address_limit,
          preserve_high16: metadata.classification.preserve_high16,
          shared_storage_group: metadata.classification.shared_storage_group,
          format_handler: metadata.classification.format_handler,
        };
        if (safety_count > 0) this.native_fs.append_text_file(safety_path, ",");
        this.native_fs.append_text_file(safety_path, JSON.stringify(safety_entry));
        safety_count += 1;
        exported_count += 1;
      }
      offset += rows.length;
    }
    for (const file_path of output_paths.keys()) {
      flush_output(file_path);
      const format = format_by_path.get(file_path);
      if ((format?.trailing_eol ?? true) && output_has_content.has(file_path)) {
        this.native_fs.append_text_file(output_paths.get(file_path)!, format?.eol ?? "\n");
      }
    }
    this.native_fs.append_text_file(
      qa_path,
      `],"warning_count":${warning_count},"blocker_count":${blocker_count},"font_manifest":${JSON.stringify(font_manifest)}}\n`,
    );
    this.native_fs.append_text_file(
      safety_path,
      `],"entry_count":${safety_count},"blocker_count":${blocker_count}}\n`,
    );
    await this.write_store.apply_project_settings_meta({
      projectPath: args.project_path,
      meta: {
        [FATE_EXTRA_ADAPTER_META_KEY]: {
          ...args.adapter,
          font_corpus_hash: String(font_manifest["corpus_sha256"] ?? ""),
          font_manifest_hash: String(font_manifest["manifest_sha256"] ?? ""),
          remaining_extension_slots: Number(font_manifest["remaining_extension_slots"] ?? 0),
        } as unknown as ApiJsonValue,
      },
    });
    return {
      accepted: true,
      compact_export: true,
      mode: args.restore_index ? "restore-index" : "without-index",
      output_files: output_order,
      qa_report: qa_path,
      qa_report_csv: qa_csv_path,
      safety_manifest: safety_path,
      warning_count,
      blocker_count,
      exported_count,
      font_output,
      font_manifest,
    } as unknown as JsonRecord;
  }

  private build_items(
    files: ScanFileDraft[],
    classifications: Map<string, FateExtraClassificationRow>,
    legacy_items: MutableRecord[],
    unindexed_translations: Map<string, string>,
  ): {
    items: MutableRecord[];
    issues: MigrationIssue[];
    exact: number;
    high_confidence: number;
    unindexed: number;
  } {
    const legacy_by_signature = new Map<string, MutableRecord[]>();
    for (const item of legacy_items) {
      const signature = route_signature(String(item["file_path"] ?? ""));
      const group = legacy_by_signature.get(signature) ?? [];
      group.push(item);
      legacy_by_signature.set(signature, group);
    }
    for (const group of legacy_by_signature.values()) {
      group.sort((left, right) => Number(left["row"] ?? 0) - Number(right["row"] ?? 0));
    }
    const output: MutableRecord[] = [];
    const issues: MigrationIssue[] = [];
    let exact = 0;
    let high_confidence = 0;
    let unindexed = 0;
    let item_id = 1;

    for (const file of files) {
      const legacy = legacy_by_signature.get(route_signature(file.relative_path)) ?? [];
      const legacy_by_row = new Map(legacy.map((item) => [Number(item["row"] ?? -1), item]));
      const unique_by_src = new Map<string, MutableRecord[]>();
      for (const item of legacy) {
        const src = String(item["src"] ?? "");
        const group = unique_by_src.get(src) ?? [];
        group.push(item);
        unique_by_src.set(src, group);
      }
      for (const entry of file.entries) {
        const is_supplement = file.kind === "supplement";
        const source_lines = entry.source.split(/\r\n|\n|\r/gu);
        const exact_rows = entry.source_line_numbers.map((line_number, index) => {
          const candidate = legacy_by_row.get(line_number - 1);
          return candidate !== undefined && String(candidate["src"] ?? "") === source_lines[index]
            ? candidate
            : null;
        });
        let migrated_rows: MutableRecord[] | null = exact_rows.every(
          (candidate): candidate is MutableRecord => candidate !== null,
        )
          ? exact_rows
          : null;
        let migration_source = "";
        if (migrated_rows !== null) {
          exact += 1;
          migration_source = "exact-row";
        } else {
          const unique_rows = source_lines.map((line, index) => {
            const candidates = unique_by_src.get(line) ?? [];
            if (candidates.length !== 1) return null;
            const candidate = candidates[0]!;
            const source_row = (entry.source_line_numbers[index] ?? 1) - 1;
            return Math.abs(Number(candidate["row"] ?? -10000) - source_row) <= 500
              ? candidate
              : null;
          });
          if (
            unique_rows.every((candidate): candidate is MutableRecord => candidate !== null) &&
            unique_rows.every(
              (candidate, index) =>
                index === 0 ||
                Number(candidate["row"] ?? 0) >
                  Number((unique_rows[index - 1] as MutableRecord)["row"] ?? 0),
            )
          ) {
            migrated_rows = unique_rows;
            high_confidence += 1;
            migration_source = "unique-high-confidence";
          }
        }

        let can_migrate =
          migrated_rows !== null && migrated_rows.every((item) => String(item["dst"] ?? "") !== "");
        let migrated_text = can_migrate
          ? migrated_rows!.map((item) => String(item["dst"] ?? "")).join("\n")
          : "";
        if (is_supplement) {
          can_migrate = true;
          migrated_text = entry.source;
          migration_source = "supplement-source-copy";
        }
        if (!can_migrate) {
          const imported = unindexed_translations.get(
            `${route_signature(file.relative_path)}\u0000${entry.path}\u0000${entry.char_offset}`,
          );
          if (imported !== undefined && imported !== "") {
            can_migrate = true;
            migrated_text = imported;
            migration_source = "unindexed-text-structural";
            unindexed += 1;
          }
        }
        if (!can_migrate) {
          issues.push({
            file_path: file.relative_path,
            path: entry.path,
            char_offset: entry.char_offset,
            source: entry.source,
            reason: legacy.length === 0 ? "未找到对应旧译文分支" : "源文或行号无法唯一对应，已留空",
          });
        }
        const key = `${entry.path}\u0000${entry.char_offset}`;
        const classification = classifications.get(key)?.classification;
        if (classification === undefined) {
          throw new Error(`扫描草稿缺少分类：${entry.path} / char:${entry.char_offset}`);
        }
        const item_metadata: FateExtraItemMetadata = {
          schema_version: FATE_EXTRA_SCHEMA_VERSION,
          path: entry.path,
          char_offset: entry.char_offset,
          original_prefix: entry.original_prefix,
          source_hash: createHash("sha256").update(entry.source, "utf-8").digest("hex"),
          source_line_numbers: entry.source_line_numbers,
          pass_through: entry.pass_through,
          classification,
          migration_review: !can_migrate && !is_supplement,
          migration_source,
          proofread_translation: "",
          display_mode: "auto",
        };
        output.push({
          id: item_id,
          src: entry.source,
          dst: migrated_text,
          name_src: null,
          name_dst: null,
          extra_field: merge_fate_extra_item_metadata("", item_metadata),
          tag: is_supplement ? "补漏" : can_migrate ? "" : "迁移待确认",
          row: entry.header_line_number - 1,
          file_type: "TXT",
          file_path: file.relative_path,
          text_type: "NONE",
          status: is_supplement ? "NONE" : can_migrate ? "PROCESSED" : "NONE",
          retry_count: 0,
          skip_internal_filter: false,
        });
        item_id += 1;
      }
    }
    return { items: output, issues, exact, high_confidence, unindexed };
  }

  private read_unindexed_translations(
    directory: string,
    files: ScanFileDraft[],
  ): UnindexedTranslationImport {
    const translations = new Map<string, string>();
    const issues: string[] = [];
    if (!this.native_fs.exists(directory) || !this.native_fs.stat(directory).isDirectory()) {
      return { translations, issues };
    }
    const candidates = this.native_fs
      .read_dirents(directory)
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.toLowerCase().endsWith(".txt") &&
          entry.name.includes("无索引译文"),
      );
    const by_signature = new Map<string, string[]>();
    for (const candidate of candidates) {
      const signature = route_signature(candidate.name);
      const group = by_signature.get(signature) ?? [];
      group.push(path.join(directory, candidate.name));
      by_signature.set(signature, group);
    }

    for (const file of files) {
      const signature = route_signature(file.relative_path);
      const matching = by_signature.get(signature) ?? [];
      if (matching.length !== 1) {
        if (matching.length > 1) {
          issues.push(`${file.relative_path}: 找到多份同分支无索引译文，已拒绝自动迁移。`);
        }
        continue;
      }
      const decoded = this.decode_source_file(matching[0]!, path.basename(matching[0]!));
      const lines = decoded.text.split(/\r\n|\n|\r/gu);
      if (lines.at(-1) === "") lines.pop();
      let cursor = 0;
      const staged = new Map<string, string>();
      const ambiguous_keys = new Set<string>();
      let failure = "";

      for (const entry of file.entries) {
        const source_lines = entry.source.split(/\r\n|\n|\r/gu);
        const markers = source_lines.map((_, index) => `\u0000FE_SOURCE_${index}\u0000`);
        const pattern = rebuild_fate_extra_indexed_block({
          entry,
          translation: markers.join("\n"),
          restore_index: false,
        });
        const translated: string[] = [];
        for (const expected of pattern) {
          const marker = read_source_marker(expected);
          const actual = lines[cursor];
          if (actual === undefined) {
            failure = `在逻辑文本 ${entry.path} / char:${entry.char_offset} 前提前结束。`;
            break;
          }
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
        const key = `${signature}\u0000${entry.path}\u0000${entry.char_offset}`;
        const translated_text = translated.join("\n");
        const existing = staged.get(key);
        if (existing !== undefined && existing !== translated_text) {
          staged.delete(key);
          ambiguous_keys.add(key);
        } else if (!ambiguous_keys.has(key)) {
          staged.set(key, translated_text);
        }
      }
      if (failure === "" && cursor !== lines.length) {
        failure = `文件末尾多出 ${lines.length - cursor} 行，无法可靠对应。`;
      }
      if (failure !== "") {
        issues.push(`${path.basename(matching[0]!)}: ${failure}`);
      }
      if (ambiguous_keys.size > 0) {
        issues.push(
          `${path.basename(matching[0]!)}: ${ambiguous_keys.size} 个重复索引存在不同译文，已留空待确认。`,
        );
      }
      for (const [key, value] of staged) translations.set(key, value);
    }
    return { translations, issues };
  }

  private read_legacy_items(legacy_path: string, project_path: string): MutableRecord[] {
    if (legacy_path === "" || !this.native_fs.exists(legacy_path)) return [];
    if (
      this.native_fs.to_identity_path(legacy_path) === this.native_fs.to_identity_path(project_path)
    ) {
      return this.read_array_operation("getAllItems", project_path);
    }
    return read_fate_extra_legacy_item_rows(this.native_fs.to_native_path(legacy_path)).map(
      (row) => ({
        id: row.id,
        ...read_record(JSON.parse(row.data)),
      }),
    );
  }

  private resolve_migration_project(body: JsonRecord, project_path: string): string {
    const requested = this.optional_string(body, "migration_project", "");
    if (requested !== "") return requested;
    const current_items = this.read_array_operation("getAllItems", project_path);
    if (current_items.length > 0) return project_path;
    return this.native_fs.exists(FATE_EXTRA_DEFAULT_LEGACY_PROJECT)
      ? FATE_EXTRA_DEFAULT_LEGACY_PROJECT
      : "";
  }

  private decode_source_file(
    source_path: string,
    relative_path: string,
  ): { text: string; format: FateExtraFileFormat } {
    const bytes = this.native_fs.read_file(source_path);
    const has_bom =
      bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const text = bytes.subarray(has_bom ? 3 : 0).toString("utf-8");
    if (text.includes("\uFFFD")) {
      throw new Error(`${relative_path} 不是可可靠解码的 UTF-8 文本。`);
    }
    const eol: "\r\n" | "\n" | "\r" = text.includes("\r\n")
      ? "\r\n"
      : text.includes("\n")
        ? "\n"
        : "\r";
    return {
      text,
      format: {
        relative_path,
        encoding: has_bom ? "utf-8-bom" : "utf-8",
        eol,
        trailing_eol: text.endsWith("\r\n") || text.endsWith("\n") || text.endsWith("\r"),
      },
    };
  }

  private build_qa_warnings(
    rows: Array<{ item: MutableRecord; metadata: FateExtraItemMetadata }>,
  ): Array<Record<string, string | number>> {
    const warnings: Array<Record<string, string | number>> = [];
    for (const row of rows) {
      const source = String(row.item["src"] ?? "");
      const machine = String(row.item["dst"] ?? "");
      const translated = resolve_fate_extra_effective_translation(machine, row.metadata);
      const text = translated === "" ? source : translated;
      const display_mode = resolve_display_mode(row.metadata);
      const base = {
        file_path: String(row.item["file_path"] ?? ""),
        row_number: Number(row.item["row"] ?? 0),
        path: row.metadata.path,
        char_offset: row.metadata.char_offset,
      };
      if (has_fate_extra_psp_overflow(text, display_mode)) {
        warnings.push({
          ...base,
          warning: FATE_EXTRA_OVERFLOW_WARNING_CODE,
          severity: "warning",
          message: `任一从者或性别条件分支超过 ${display_mode} 显示规则。`,
        });
      }
      const ruby_open = text.match(/#RUBS/gu)?.length ?? 0;
      const ruby_base = text.match(/#RUBE/gu)?.length ?? 0;
      const ruby_end = text.match(/#REND/gu)?.length ?? 0;
      if (ruby_open !== ruby_base || ruby_open !== ruby_end) {
        warnings.push({
          ...base,
          warning: "FE_CONTROL_SYNTAX",
          severity: "blocker",
          message: "Ruby 控制符数量不闭合。",
        });
      }
      const source_controls = collect_control_tokens(source);
      const translated_controls = collect_control_tokens(text);
      if (!same_string_array(source_controls, translated_controls)) {
        warnings.push({
          ...base,
          warning: "FE_CONTROL_SEQUENCE",
          severity: "blocker",
          message: "译文控制符的数量、内容或顺序与原文不一致。",
        });
      }
      if (row.metadata.migration_review) {
        warnings.push({
          ...base,
          warning: "FE_MIGRATION_REVIEW",
          severity: "warning",
          message: "旧译文无法唯一迁移，需要人工确认。",
        });
      }
      const capacity = row.metadata.classification.slot_capacity;
      const encoded_bytes = this.font_service.measure_encoded_bytes(text);
      if (
        capacity !== null &&
        !row.metadata.classification.allow_overlength &&
        encoded_bytes > capacity
      ) {
        warnings.push({
          ...base,
          warning: "FE_STORAGE_CAPACITY",
          severity: "blocker",
          message: `FE 实际编码 ${encoded_bytes} 字节，超过固定槽位 ${capacity} 字节。`,
        });
      }
      const classification = row.metadata.classification;
      if (classification.category === "unresolved_candidate") {
        warnings.push({
          ...base,
          warning: "FE_SAFETY_BLOCKER",
          severity: "blocker",
          message: classification.translator_message || "未解析候选：禁止直接进入自动注入。",
        });
      } else if (
        classification.category === "shared_overlapping_view" ||
        classification.category === "dynamic_cursor_no_static_ref" ||
        classification.category === "fixed_layout_text" ||
        classification.category === "packed_u16_pointer"
      ) {
        warnings.push({
          ...base,
          warning: `FE_SAFETY_${classification.category.toLocaleUpperCase()}`,
          severity: "warning",
          message: classification.translator_message || classification.reason,
        });
      }
    }
    return warnings;
  }

  private create_project_backup(project_path: string): string {
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const extension = path.extname(project_path);
    const backup_path = `${project_path.slice(0, -extension.length)}.fe-backup-${stamp}${extension}`;
    this.native_fs.copy_file(project_path, backup_path);
    return backup_path;
  }

  private write_migration_reports(
    project_path: string,
    issues: MigrationIssue[],
  ): { json: string; csv: string } {
    const base = project_path.slice(0, -path.extname(project_path).length);
    const json_path = `${base}.fe-migration-report.json`;
    const csv_path = `${base}.fe-migration-report.csv`;
    this.native_fs.write_file_sync(
      json_path,
      `${JSON.stringify({ schema_version: 1, pending_count: issues.length, issues }, null, 2)}\n`,
    );
    this.native_fs.write_file_sync(
      csv_path,
      [
        ["file_path", "path", "char_offset", "source", "reason"].map(csv_cell).join(","),
        ...issues.map((issue) =>
          [issue.file_path, issue.path, issue.char_offset, issue.source, issue.reason]
            .map(csv_cell)
            .join(","),
        ),
      ].join("\r\n"),
    );
    return { json: json_path, csv: csv_path };
  }

  private atomic_write(file_path: string, data: string): void {
    const temporary = `${file_path}.${randomUUID()}.tmp`;
    this.native_fs.write_file_sync(temporary, data);
    if (this.native_fs.exists(file_path)) {
      this.native_fs.remove(file_path, { force: true });
    }
    this.native_fs.rename(temporary, file_path);
  }

  private assert_draft_unchanged(draft: ScanDraft): void {
    const state = this.session_state.snapshot();
    const current_revisions = this.read_guarded_project_revisions(draft.project_path);
    const unchanged =
      state.loaded &&
      this.native_fs.to_identity_path(state.projectPath) ===
        this.native_fs.to_identity_path(draft.project_path) &&
      FATE_EXTRA_GUARDED_SECTIONS.every(
        (section) => current_revisions[section] === draft.project_section_revisions[section],
      ) &&
      this.native_fs.stat(draft.source_directory).mtimeMs === draft.source_mtime_ms &&
      this.native_fs.stat(draft.complete_jp_source_file).mtimeMs ===
        draft.complete_jp_source_mtime_ms &&
      this.native_fs.stat(draft.classification_database).mtimeMs === draft.database_mtime_ms;
    if (!unchanged) {
      this.throw_validation_error("项目、索引原稿或分类数据库已变化，请重新扫描。");
    }
  }

  private read_guarded_project_revisions(
    project_path: string,
  ): Record<FateExtraGuardedSection, number> {
    const meta = this.read_record_operation("getAllMeta", project_path) as JsonRecord;
    return Object.fromEntries(
      FATE_EXTRA_GUARDED_SECTIONS.map((section) => [section, get_section_revision(meta, section)]),
    ) as Record<FateExtraGuardedSection, number>;
  }

  private require_loaded_project(body: JsonRecord): string {
    const state = this.session_state.snapshot();
    if (!state.loaded || state.projectPath === "") {
      this.throw_validation_error("请先打开一个 .lg 项目。");
    }
    const requested = this.optional_string(body, "project_path", "");
    if (
      requested !== "" &&
      this.native_fs.to_identity_path(requested) !==
        this.native_fs.to_identity_path(state.projectPath)
    ) {
      this.throw_validation_error("项目已切换，请重新执行 FE 操作。");
    }
    return state.projectPath;
  }

  private read_array_operation(name: string, project_path: string): MutableRecord[] {
    const value = this.database.execute({ name, args: { projectPath: project_path } });
    return Array.isArray(value) ? value.map(read_record) : [];
  }

  private read_record_operation(name: string, project_path: string): MutableRecord {
    return read_record(this.database.execute({ name, args: { projectPath: project_path } }));
  }

  private require_string(body: JsonRecord, key: string): string {
    const value = this.optional_string(body, key, "");
    if (value === "") this.throw_validation_error(`缺少参数：${key}`);
    return value;
  }

  private optional_string(body: JsonRecord, key: string, fallback: string): string {
    return typeof body[key] === "string" && body[key].trim() !== "" ? body[key].trim() : fallback;
  }

  private assert_file(file_path: string, label: string): void {
    if (!this.native_fs.exists(file_path) || !this.native_fs.stat(file_path).isFile()) {
      this.throw_validation_error(`${label}不存在：${file_path}`);
    }
  }

  private assert_directory(directory: string, label: string): void {
    if (!this.native_fs.exists(directory) || !this.native_fs.stat(directory).isDirectory()) {
      this.throw_validation_error(`${label}不存在：${directory}`);
    }
  }

  private throw_validation_error(reason: string): never {
    throw new AppErrors.RequestValidationError({
      public_details: { reason },
      diagnostic_context: { reason },
    });
  }
}
