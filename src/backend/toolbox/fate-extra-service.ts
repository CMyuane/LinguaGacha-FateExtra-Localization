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
import type { ProjectSessionState } from "../project/project-session";
import type { ProjectWriteStore } from "../project/project-write-store";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import {
  has_fate_extra_psp_overflow,
  layout_fate_extra_preview,
} from "../../shared/fate-extra/fate-extra-layout";
import {
  FATE_EXTRA_INDEX_LINE_PATTERN,
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
  read_fate_extra_item_metadata,
  type FateExtraAdapterMetadata,
  type FateExtraFileFormat,
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
  project_mtime_ms: number;
  source_directory: string;
  source_mtime_ms: number;
  classification_database: string;
  database_mtime_ms: number;
  files: ScanFileDraft[];
  items: MutableRecord[];
  report: JsonRecord;
  adapter_meta: FateExtraAdapterMetadata;
  migration_issues: MigrationIssue[];
};

type UnindexedTranslationImport = {
  translations: Map<string, string>;
  issues: string[];
};

const SOURCE_MARKER_PREFIX = "\u0000FE_SOURCE_";
const SOURCE_MARKER_SUFFIX = "\u0000";

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

/**
 * Fate/Extra project adapter. It keeps indexes out of the ordinary Item model,
 * but retains enough namespaced metadata to reconstruct byte-for-byte layout.
 */
export class FateExtraService {
  private readonly scan_drafts = new Map<string, ScanDraft>();

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
    this.assert_directory(source_directory, "索引原稿目录");
    this.assert_file(classification_database, "FE 文本安全分类数据库");

    const source_files = this.native_fs
      .read_dirents(source_directory)
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".txt"))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
    const classification_cache = new Map<string, FateExtraClassificationRow>();
    const unique_keys = new Set<string>();
    const indexed_offsets_by_path = new Map<string, number[]>();
    const source_inputs = source_files.map((source_file) => {
      const source_path = path.join(source_directory, source_file.name);
      const decoded = this.decode_source_file(source_path, source_file.name);
      for (const line of decoded.text.split(/\r\n|\n|\r/gu)) {
        const header = FATE_EXTRA_INDEX_LINE_PATTERN.exec(line);
        if (header === null) continue;
        const indexed_path = header[1] ?? "";
        const char_offset = Number(header[2] ?? Number.NaN);
        const key = `${indexed_path}\u0000${char_offset}`;
        if (!unique_keys.has(key)) {
          unique_keys.add(key);
          const offsets = indexed_offsets_by_path.get(indexed_path) ?? [];
          offsets.push(char_offset);
          indexed_offsets_by_path.set(indexed_path, offsets);
        }
      }
      return { source_file, source_path, decoded };
    });
    const files: ScanFileDraft[] = [];
    const structural_issues: string[] = [];
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
        const row = classification_cache.get(key);
        if (row === undefined) {
          structural_issues.push(
            `${input.source_file.name}: 索引 ${indexed_path} / char:${char_offset} 未匹配分类库。`,
          );
          continue;
        }
        expected.push({ path: row.path, char_offset: row.char_offset, source: row.source });
        matched_classification_count += 1;
        category_counts[row.classification.category] =
          (category_counts[row.classification.category] ?? 0) + 1;
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
      });
    }

    const logical_text_count = files.reduce((sum, file) => sum + file.entries.length, 0);
    const applicable =
      structural_issues.length === 0 &&
      matched_classification_count === logical_text_count &&
      source_files.length === 6 &&
      logical_text_count === 34_693 &&
      unique_keys.size === 7_867;
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
      source_file_count: files.length,
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
      unique_index_count: unique_keys.size,
      matched_classification_count,
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
        logical_text_count: 34693,
        unique_index_count: 7867,
        classification_match_rate: 1,
      },
    };
    const corpus = this.font_service.build_corpus(migration.items);
    const adapter_meta: FateExtraAdapterMetadata = {
      schema_version: FATE_EXTRA_SCHEMA_VERSION,
      enabled: true,
      applied_at: "",
      source_directory,
      classification_database,
      source_file_count: files.length,
      logical_text_count,
      unique_index_count: unique_keys.size,
      matched_classification_count,
      rules_version: "fe.1",
      file_formats: files.map((file) => file.format),
      font_corpus_hash: corpus.corpus_sha256,
      font_manifest_hash: "",
      remaining_extension_slots: 0,
    };
    if (applicable) {
      this.scan_drafts.set(scan_id, {
        id: scan_id,
        project_path,
        project_mtime_ms: this.native_fs.stat(project_path).mtimeMs,
        source_directory,
        source_mtime_ms: this.native_fs.stat(source_directory).mtimeMs,
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
      throw new Error("FE 扫描报告已失效，请重新扫描。");
    }
    return await this.operation_gate.run_exclusive_project_write(async () => {
      this.assert_draft_unchanged(draft);
      const backup_path = this.create_project_backup(project_path);
      const asset_records = this.read_array_operation("getAllAssetRecords", project_path);
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
      const write_result = await this.write_store.replace_workbench_items_and_files({
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
      const reports = this.write_migration_reports(project_path, draft.migration_issues);
      this.scan_drafts.delete(scan_id);
      return {
        ...write_result,
        backup_path,
        migration_report_json: reports.json,
        migration_report_csv: reports.csv,
        logical_text_count: draft.items.length,
      } as unknown as JsonRecord;
    });
  }

  public list_items(body: JsonRecord): JsonRecord {
    const project_path = this.require_loaded_project(body);
    const search = this.optional_string(body, "search", "").toLocaleLowerCase();
    const file_filter = this.optional_string(body, "file_path", "");
    const warning_filter = this.optional_string(body, "warning", "");
    const offset = Math.max(0, Math.trunc(Number(body["offset"] ?? 0)));
    const limit = Math.max(1, Math.min(500, Math.trunc(Number(body["limit"] ?? 120))));
    const rows = this.read_array_operation("getAllItems", project_path)
      .flatMap((item) => {
        const metadata = read_fate_extra_item_metadata(
          item["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
        );
        if (metadata === null) return [];
        const src = String(item["src"] ?? "");
        const dst = String(item["dst"] ?? "");
        const effective = dst === "" ? src : dst;
        const overflow = has_fate_extra_psp_overflow(effective);
        const warnings = [
          ...(overflow ? [FATE_EXTRA_OVERFLOW_WARNING_CODE] : []),
          ...(metadata.migration_review ? ["FE_MIGRATION_REVIEW"] : []),
        ];
        return [
          {
            item_id: Number(item["id"] ?? item["item_id"] ?? 0),
            file_path: String(item["file_path"] ?? ""),
            row_number: Number(item["row"] ?? item["row_number"] ?? 0),
            src,
            dst,
            status: String(item["status"] ?? "NONE"),
            warnings,
            overflow,
            index: { path: metadata.path, char_offset: metadata.char_offset },
          },
        ];
      })
      .filter((item) => {
        if (file_filter !== "" && item.file_path !== file_filter) return false;
        if (warning_filter !== "" && !item.warnings.includes(warning_filter)) return false;
        if (
          search !== "" &&
          !`${item.src}\n${item.dst}\n${item.file_path}`.toLocaleLowerCase().includes(search)
        ) {
          return false;
        }
        return true;
      });
    return {
      total: rows.length,
      offset,
      items: rows.slice(offset, offset + limit),
      files: [...new Set(rows.map((item) => item.file_path))],
    } as unknown as JsonRecord;
  }

  public preview(body: JsonRecord): JsonRecord {
    const text = String(body["text"] ?? "");
    return layout_fate_extra_preview({
      text,
      state: {
        servant_index: Number(body["servant_index"] ?? 0),
        gender_index: Number(body["gender_index"] ?? 0),
      },
    }) as unknown as JsonRecord;
  }

  public async export_project(body: JsonRecord): Promise<JsonRecord> {
    const project_path = this.require_loaded_project(body);
    const output_directory = this.require_string(body, "output_directory");
    const restore_index = body["restore_index"] === true || body["mode"] === "restore-index";
    const items = this.read_array_operation("getAllItems", project_path);
    const meta = this.read_record_operation("getAllMeta", project_path);
    const adapter = read_record(meta[FATE_EXTRA_ADAPTER_META_KEY]);
    if (adapter["enabled"] !== true || Number(adapter["schema_version"]) !== 1) {
      throw new Error("当前项目尚未启用 Fate/Extra 汉化适配。");
    }
    const item_rows = items.map((item) => ({
      item,
      metadata: read_fate_extra_item_metadata(
        item["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
      ),
    }));
    if (item_rows.some((row) => row.metadata === null)) {
      throw new Error("FE 索引结构已损坏：项目中存在缺少索引元数据的文本。");
    }
    const expected_count = Number(adapter["logical_text_count"] ?? 0);
    if (expected_count !== item_rows.length) {
      throw new Error("FE 索引结构已损坏：逻辑文本数量与适配清单不一致。");
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
            translation: String(row.item["dst"] ?? ""),
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
    this.atomic_write(
      qa_path,
      `${JSON.stringify(
        {
          schema_version: 1,
          exported_at: new Date().toISOString(),
          mode: restore_index ? "restore-index" : "without-index",
          warning_count: warnings.length,
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
      warning_count: warnings.length,
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
          migration_review: !can_migrate,
          migration_source,
        };
        output.push({
          id: item_id,
          src: entry.source,
          dst: migrated_text,
          name_src: null,
          name_dst: null,
          extra_field: merge_fate_extra_item_metadata("", item_metadata),
          tag: can_migrate ? "" : "迁移待确认",
          row: entry.header_line_number - 1,
          file_type: "TXT",
          file_path: file.relative_path,
          text_type: "NONE",
          status: can_migrate ? "PROCESSED" : "NONE",
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
      const text =
        String(row.item["dst"] ?? "") === ""
          ? String(row.item["src"] ?? "")
          : String(row.item["dst"] ?? "");
      const base = {
        file_path: String(row.item["file_path"] ?? ""),
        row_number: Number(row.item["row"] ?? 0),
        path: row.metadata.path,
        char_offset: row.metadata.char_offset,
      };
      if (has_fate_extra_psp_overflow(text)) {
        warnings.push({
          ...base,
          warning: FATE_EXTRA_OVERFLOW_WARNING_CODE,
          message: "任一从者或性别条件分支超过 432px、3 行或 Ruby 宽度上限。",
        });
      }
      const ruby_open = text.match(/#RUBS/gu)?.length ?? 0;
      const ruby_base = text.match(/#RUBE/gu)?.length ?? 0;
      const ruby_end = text.match(/#REND/gu)?.length ?? 0;
      if (ruby_open !== ruby_base || ruby_open !== ruby_end) {
        warnings.push({
          ...base,
          warning: "FE_CONTROL_SYNTAX",
          message: "Ruby 控制符数量不闭合。",
        });
      }
      if (row.metadata.migration_review) {
        warnings.push({
          ...base,
          warning: "FE_MIGRATION_REVIEW",
          message: "旧译文无法唯一迁移，需要人工确认。",
        });
      }
      const capacity = row.metadata.classification.slot_capacity;
      if (
        capacity !== null &&
        !row.metadata.classification.allow_overlength &&
        Buffer.byteLength(text, "utf-8") > capacity
      ) {
        warnings.push({
          ...base,
          warning: "FE_STORAGE_CAPACITY",
          message: `文本可能超过固定槽位 ${capacity} 字节；重新导入前需要确认。`,
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
    const unchanged =
      state.loaded &&
      this.native_fs.to_identity_path(state.projectPath) ===
        this.native_fs.to_identity_path(draft.project_path) &&
      this.native_fs.stat(draft.project_path).mtimeMs === draft.project_mtime_ms &&
      this.native_fs.stat(draft.source_directory).mtimeMs === draft.source_mtime_ms &&
      this.native_fs.stat(draft.classification_database).mtimeMs === draft.database_mtime_ms;
    if (!unchanged) {
      throw new Error("项目、索引原稿或分类数据库已变化，请重新扫描。");
    }
  }

  private require_loaded_project(body: JsonRecord): string {
    const state = this.session_state.snapshot();
    if (!state.loaded || state.projectPath === "") {
      throw new Error("请先打开一个 .lg 项目。");
    }
    const requested = this.optional_string(body, "project_path", "");
    if (
      requested !== "" &&
      this.native_fs.to_identity_path(requested) !==
        this.native_fs.to_identity_path(state.projectPath)
    ) {
      throw new Error("项目已切换，请重新执行 FE 操作。");
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
    if (value === "") throw new Error(`缺少参数：${key}`);
    return value;
  }

  private optional_string(body: JsonRecord, key: string, fallback: string): string {
    return typeof body[key] === "string" && body[key].trim() !== "" ? body[key].trim() : fallback;
  }

  private assert_file(file_path: string, label: string): void {
    if (!this.native_fs.exists(file_path) || !this.native_fs.stat(file_path).isFile()) {
      throw new Error(`${label}不存在：${file_path}`);
    }
  }

  private assert_directory(directory: string, label: string): void {
    if (!this.native_fs.exists(directory) || !this.native_fs.stat(directory).isDirectory()) {
      throw new Error(`${label}不存在：${directory}`);
    }
  }
}
