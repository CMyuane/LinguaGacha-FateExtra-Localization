import path from "node:path";

import { ProjectDatabase } from "../../database/database-operations";
import {
  create_stable_fate_extra_classification_snapshot,
  remove_fate_extra_sqlite_file_set,
  type FateExtraClassificationSnapshot,
  type FateExtraSqliteInputFingerprint,
} from "../../database/fate-extra-compact-export-database";
import {
  read_fate_extra_classifications,
  type FateExtraClassificationRow,
} from "../../database/fate-extra-database-reader";
import { get_section_revision } from "../../project/project-data";
import { default_native_fs, type NativeFs, type NativeTextWriter } from "../../../native/native-fs";
import {
  has_fate_extra_psp_overflow,
  type FateExtraResolvedDisplayMode,
} from "../../../shared/fate-extra/fate-extra-layout";
import { resolve_fate_extra_display_mode } from "../../../shared/fate-extra/fate-extra-display-mode";
import { rebuild_fate_extra_indexed_block } from "../../../shared/fate-extra/fate-extra-parser";
import { resolve_fate_extra_export_path } from "../../../shared/fate-extra/fate-extra-export-path";
import {
  FATE_EXTRA_OVERFLOW_WARNING_CODE,
  FATE_EXTRA_SCHEMA_VERSION,
  merge_fate_extra_item_metadata,
  read_fate_extra_display_mode,
  read_fate_extra_item_metadata,
  resolve_fate_extra_effective_translation,
  type FateExtraFileFormat,
  type FateExtraItemMetadata,
} from "../../../shared/fate-extra/fate-extra-types";
import type { ApiJsonValue } from "../../api/api-types";
import type { BackendWorkerTaskProgressReporter } from "../worker-task";
import {
  build_fate_extra_font_corpus_from_resolved_texts,
  sync_fate_extra_font_corpus,
  type FateExtraFontBuildInput,
  type FateExtraFontCorpus,
} from "../../toolbox/fate-extra-font-service";

type JsonRecord = Record<string, ApiJsonValue>;
type MutableRecord = Record<string, unknown>;
type GuardedSection = "files" | "items" | "analysis" | "proofreading";

export type FateExtraExportWorkerTaskInput = {
  projectPath: string;
  stagingDirectory: string;
  classificationDatabase: string;
  projectMode: "full" | "compact";
  restoreIndex: boolean;
  adapter: JsonRecord;
  expectedItemCount: number;
  guardedRevisions: Record<GuardedSection, number>;
  fontBuildInput: FateExtraFontBuildInput;
  encodedWidths: Array<[string, number]>;
};

export type FateExtraExportWorkerTaskResult = {
  output_files: string[];
  qa_report: string;
  qa_report_csv: string;
  safety_manifest: string;
  warning_count: number;
  blocker_count: number;
  exported_count: number;
  font_manifest: JsonRecord;
  classification_fingerprints: FateExtraSqliteInputFingerprint[];
};

export type FateExtraFontCorpusSync = (
  corpus: FateExtraFontCorpus,
  output_directory: string,
  build_input: FateExtraFontBuildInput,
  native_fs: NativeFs,
) => JsonRecord;

const PAGE_SIZE = 5_000;
const FE_CONTROL_TOKEN_PATTERN =
  /#(?:RUBS|RUBE|REND|C(?:DEF|\d{8,9})|ROFS-?\d+|SIZE\([^)]*\)|SP(?:\([^)]*\)|\d+)|SVT|FAMILY\d*|GIVEN\d*|NICK\d*|ITEM\d*|TITM\d*|TVAL\d*|VAL\d*|TRG\d*|ITALICS|[12])|<ICON[^>]*>/gu;

/** 普通与 compact 大规模导出均在专用 worker 中执行，主进程不接收 item payload。 */
export async function run_fate_extra_export_worker_task(
  input: FateExtraExportWorkerTaskInput,
  report_progress: BackendWorkerTaskProgressReporter = () => undefined,
  native_fs: NativeFs = default_native_fs,
  database_override?: ProjectDatabase,
  sync_font_corpus: FateExtraFontCorpusSync = sync_fate_extra_font_corpus,
): Promise<FateExtraExportWorkerTaskResult> {
  const database = database_override ?? new ProjectDatabase(native_fs);
  const classification_snapshot = path.join(
    input.stagingDirectory,
    `.classification-snapshot-${process.pid.toString()}.sqlite`,
  );
  const final_classification_snapshot = `${classification_snapshot}.final`;
  const open_writers = new Set<NativeTextWriter>();
  const close_writers = (): void => {
    let first_error: unknown;
    for (const writer of open_writers) {
      try {
        writer.close();
      } catch (error) {
        first_error ??= error;
      }
    }
    open_writers.clear();
    if (first_error !== undefined) throw first_error;
  };
  try {
    assert_project_revisions(database, input.projectPath, input.guardedRevisions);
    const classification_identity: FateExtraClassificationSnapshot | null =
      input.projectMode === "compact"
        ? await create_stable_fate_extra_classification_snapshot(
            input.classificationDatabase,
            classification_snapshot,
            native_fs,
          )
        : null;
    const formats = Array.isArray(input.adapter["file_formats"])
      ? (input.adapter["file_formats"] as unknown as FateExtraFileFormat[])
      : [];
    for (const format of formats) {
      resolve_fate_extra_export_path(input.stagingDirectory, format.relative_path);
    }
    const format_by_path = new Map(formats.map((format) => [format.relative_path, format]));
    const output_writers = new Map<string, NativeTextWriter>();
    const output_has_content = new Set<string>();
    const output_order: string[] = [];
    const representative_metadata_by_source_hash = new Map<string, FateExtraItemMetadata | null>();
    const qa_relative_path = "fate-extra-qa-report.json";
    const qa_csv_relative_path = "fate-extra-qa-report.csv";
    const safety_relative_path = "fate-extra-injection-safety.json";
    const compact_export = input.projectMode === "compact";
    const generated_at = new Date().toISOString();
    const qa_payload_relative_path = compact_export
      ? qa_relative_path
      : ".fate-extra-qa-warnings.partial";
    const safety_payload_relative_path = compact_export
      ? safety_relative_path
      : ".fate-extra-safety-entries.partial";
    const qa_writer = native_fs.open_text_writer(
      path.join(input.stagingDirectory, qa_payload_relative_path),
      compact_export ? '{"schema_version":1,"compact_export":true,"warnings":[' : "",
    );
    open_writers.add(qa_writer);
    const qa_csv_header = ["file_path", "row_number", "path", "char_offset", "warning", "message"]
      .map(csv_cell)
      .join(",");
    const qa_csv_writer = native_fs.open_text_writer(
      path.join(input.stagingDirectory, qa_csv_relative_path),
      `${qa_csv_header}${compact_export ? "\r\n" : ""}`,
    );
    open_writers.add(qa_csv_writer);
    const safety_writer = native_fs.open_text_writer(
      path.join(input.stagingDirectory, safety_payload_relative_path),
      compact_export ? '{"schema_version":1,"compact_export":true,"entries":[' : "",
    );
    open_writers.add(safety_writer);
    const encoded_widths = new Map(input.encodedWidths);
    const measure_encoded_bytes = (text: string): number =>
      measure_encoded_text_bytes(text, encoded_widths);
    let after_original_item_id = 0;
    let exported_count = 0;
    let warning_count = 0;
    let blocker_count = 0;
    let safety_count = 0;
    const resolved_texts = new Set<string>();
    report_progress({
      phase: `${input.projectMode}-export-items`,
      completed: 0,
      total: input.expectedItemCount,
    });
    while (true) {
      const page = read_record(
        database.execute({
          name:
            input.projectMode === "compact"
              ? "getFateExtraCompactExportPage"
              : "getFateExtraFullExportPage",
          args: {
            projectPath: input.projectPath,
            afterOriginalItemId: after_original_item_id,
            limit: PAGE_SIZE,
          },
        }),
      );
      const rows = Array.isArray(page["rows"])
        ? page["rows"].map((value) => read_record(value))
        : [];
      if (rows.length === 0) break;
      let last_original_item_id = after_original_item_id;
      for (const row of rows) {
        const original_item_id = Number(row["original_item_id"] ?? 0);
        if (!Number.isSafeInteger(original_item_id) || original_item_id <= last_original_item_id) {
          throw new Error("FE 工程导出游标顺序无效，请重新检查工程。");
        }
        last_original_item_id = original_item_id;
      }
      if (Number(page["next_original_item_id"] ?? 0) !== last_original_item_id) {
        throw new Error("FE 工程导出游标状态无效，请重新检查工程。");
      }
      const offsets_by_path = new Map<string, number[]>();
      if (compact_export) {
        for (const row of rows) {
          const resource_path = String(row["resource_path"] ?? "");
          const offsets = offsets_by_path.get(resource_path) ?? [];
          offsets.push(Number(row["char_offset"] ?? -1));
          offsets_by_path.set(resource_path, offsets);
        }
      }
      const classifications = new Map<string, FateExtraClassificationRow>();
      if (compact_export) {
        for (const classification_row of read_fate_extra_classifications(
          native_fs.to_native_path(classification_snapshot),
          offsets_by_path,
        )) {
          classifications.set(
            `${classification_row.path}\u0000${classification_row.char_offset.toString()}`,
            classification_row,
          );
        }
      }
      const page_output_fragments = new Map<string, string[]>();
      const page_qa_fragments: string[] = [];
      const page_qa_csv_lines: string[] = [];
      const page_safety_fragments: string[] = [];
      for (const row of rows) {
        const prepared = prepare_export_row(
          row,
          input.projectMode,
          classifications,
          representative_metadata_by_source_hash,
        );
        const {
          file_path,
          resource_path,
          char_offset,
          source,
          source_line_numbers,
          pass_through,
          metadata,
          effective,
          export_item,
          row_number,
        } = prepared;
        if (prepared.font_text !== null) resolved_texts.add(prepared.font_text);
        const format = format_by_path.get(file_path) ?? {
          relative_path: file_path,
          encoding: "utf-8" as const,
          eol: "\n" as const,
          trailing_eol: true,
        };
        if (!output_writers.has(file_path)) {
          const writer = native_fs.open_text_writer(
            resolve_fate_extra_export_path(input.stagingDirectory, file_path),
            format.encoding === "utf-8-bom" ? "\uFEFF" : "",
          );
          output_writers.set(file_path, writer);
          output_order.push(file_path);
          open_writers.add(writer);
        }
        const block = rebuild_fate_extra_indexed_block({
          entry: {
            path: resource_path,
            char_offset,
            original_prefix: metadata.original_prefix,
            source,
            source_line_numbers,
            pass_through,
            header_line_number: row_number + 1,
          },
          translation: effective,
          restore_index: input.restoreIndex,
        }).join(format.eol);
        const output_fragments = page_output_fragments.get(file_path) ?? [];
        if (output_has_content.has(file_path)) output_fragments.push(format.eol);
        output_fragments.push(block);
        page_output_fragments.set(file_path, output_fragments);
        output_has_content.add(file_path);
        for (const warning of build_qa_warnings(export_item, metadata, measure_encoded_bytes)) {
          page_qa_fragments.push(
            compact_export
              ? `${warning_count > 0 ? "," : ""}${JSON.stringify(warning)}`
              : `${warning_count > 0 ? ",\n" : ""}${indent_json(warning, 4)}`,
          );
          const csv_line = [
            warning.file_path,
            warning.row_number,
            warning.path,
            warning.char_offset,
            warning.warning,
            warning.message,
          ]
            .map(csv_cell)
            .join(",");
          page_qa_csv_lines.push(compact_export ? `${csv_line}\r\n` : `\r\n${csv_line}`);
          warning_count += 1;
          if (warning.severity === "blocker") blocker_count += 1;
        }
        const safety_entry = {
          path: resource_path,
          char_offset,
          category: metadata.classification.category,
          category_zh: metadata.classification.category_zh,
          display_mode: resolve_display_mode(metadata),
          encoded_bytes: measure_encoded_bytes(effective),
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
        page_safety_fragments.push(
          compact_export
            ? `${safety_count > 0 ? "," : ""}${JSON.stringify(safety_entry)}`
            : `${safety_count > 0 ? ",\n" : ""}${indent_json(safety_entry, 4)}`,
        );
        safety_count += 1;
        exported_count += 1;
      }
      for (const [file_path, fragments] of page_output_fragments) {
        output_writers.get(file_path)!.write(fragments.join(""));
      }
      qa_writer.write(page_qa_fragments.join(""));
      qa_csv_writer.write(page_qa_csv_lines.join(""));
      safety_writer.write(page_safety_fragments.join(""));
      after_original_item_id = last_original_item_id;
      report_progress({
        phase: `${input.projectMode}-export-items`,
        completed: exported_count,
        total: input.expectedItemCount,
      });
    }
    if (exported_count !== input.expectedItemCount) {
      throw new Error(
        `FE 工程导出条目数量已变化：预期 ${input.expectedItemCount.toString()}，实际 ${exported_count.toString()}。`,
      );
    }
    for (const [file_path, writer] of output_writers) {
      const format = format_by_path.get(file_path);
      if ((format?.trailing_eol ?? true) && output_has_content.has(file_path)) {
        writer.write(format?.eol ?? "\n");
      }
    }
    report_progress({ phase: "build-font", completed: 0, total: 1 });
    const font_manifest = sync_font_corpus(
      build_fate_extra_font_corpus_from_resolved_texts(resolved_texts),
      path.join(input.stagingDirectory, "fate-extra-font", "NPJH50247"),
      input.fontBuildInput,
      native_fs,
    );
    report_progress({ phase: "build-font", completed: 1, total: 1 });
    if (compact_export) {
      qa_writer.write(
        `],"warning_count":${warning_count.toString()},"blocker_count":${blocker_count.toString()},"font_manifest":${JSON.stringify(font_manifest)}}\n`,
      );
      safety_writer.write(
        `],"entry_count":${safety_count.toString()},"blocker_count":${blocker_count.toString()}}\n`,
      );
    }
    close_writers();
    if (!compact_export) {
      await write_full_export_reports({
        staging_directory: input.stagingDirectory,
        qa_relative_path,
        qa_payload_relative_path,
        safety_relative_path,
        safety_payload_relative_path,
        generated_at,
        restore_index: input.restoreIndex,
        warning_count,
        blocker_count,
        safety_count,
        font_manifest,
        native_fs,
      });
    }
    assert_project_revisions(database, input.projectPath, input.guardedRevisions);
    if (classification_identity !== null) {
      const final_classification_identity = await create_stable_fate_extra_classification_snapshot(
        input.classificationDatabase,
        final_classification_snapshot,
        native_fs,
      );
      if (
        classification_identity.snapshot_sha256 !== final_classification_identity.snapshot_sha256
      ) {
        throw new Error("导出期间安全分类数据库主库、WAL 或 SHM 已变化，请重新导出。");
      }
    }
    return {
      output_files: output_order,
      qa_report: qa_relative_path,
      qa_report_csv: qa_csv_relative_path,
      safety_manifest: safety_relative_path,
      warning_count,
      blocker_count,
      exported_count,
      font_manifest,
      classification_fingerprints: classification_identity?.fingerprints ?? [],
    };
  } finally {
    close_writers();
    database.close();
    if (input.projectMode === "compact") {
      remove_fate_extra_sqlite_file_set(classification_snapshot, native_fs);
      remove_fate_extra_sqlite_file_set(final_classification_snapshot, native_fs);
    }
  }
}

async function write_full_export_reports(args: {
  staging_directory: string;
  qa_relative_path: string;
  qa_payload_relative_path: string;
  safety_relative_path: string;
  safety_payload_relative_path: string;
  generated_at: string;
  restore_index: boolean;
  warning_count: number;
  blocker_count: number;
  safety_count: number;
  font_manifest: JsonRecord;
  native_fs: NativeFs;
}): Promise<void> {
  const qa_payload_path = path.join(args.staging_directory, args.qa_payload_relative_path);
  const safety_payload_path = path.join(args.staging_directory, args.safety_payload_relative_path);
  const qa_writer = args.native_fs.open_text_writer(
    path.join(args.staging_directory, args.qa_relative_path),
    [
      "{",
      '  "schema_version": 1,',
      `  "exported_at": ${JSON.stringify(args.generated_at)},`,
      `  "mode": ${JSON.stringify(args.restore_index ? "restore-index" : "without-index")},`,
      `  "warning_count": ${args.warning_count.toString()},`,
      `  "blocker_count": ${args.blocker_count.toString()},`,
      args.warning_count === 0 ? '  "warnings": [],' : '  "warnings": [',
    ].join("\n") + "\n",
  );
  try {
    if (args.warning_count > 0) {
      await args.native_fs.stream_text_file_to_writer(qa_payload_path, qa_writer);
      qa_writer.write("\n  ],\n");
    }
    qa_writer.write(`  "font_manifest": ${indent_json_tail(args.font_manifest, 2)}\n}\n`);
  } finally {
    qa_writer.close();
  }

  const safety_writer = args.native_fs.open_text_writer(
    path.join(args.staging_directory, args.safety_relative_path),
    [
      "{",
      '  "schema_version": 1,',
      `  "generated_at": ${JSON.stringify(args.generated_at)},`,
      `  "entry_count": ${args.safety_count.toString()},`,
      `  "blocker_count": ${args.blocker_count.toString()},`,
      args.safety_count === 0 ? '  "entries": []' : '  "entries": [',
    ].join("\n") + "\n",
  );
  try {
    if (args.safety_count > 0) {
      await args.native_fs.stream_text_file_to_writer(safety_payload_path, safety_writer);
      safety_writer.write("\n  ]\n");
    }
    safety_writer.write("}\n");
  } finally {
    safety_writer.close();
  }
  args.native_fs.remove(qa_payload_path, { force: true });
  args.native_fs.remove(safety_payload_path, { force: true });
}

function indent_json(value: unknown, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function indent_json_tail(value: unknown, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return JSON.stringify(value, null, 2).replaceAll("\n", `\n${prefix}`);
}

type PreparedExportRow = {
  file_path: string;
  resource_path: string;
  char_offset: number;
  source: string;
  source_line_numbers: number[];
  pass_through: FateExtraItemMetadata["pass_through"];
  metadata: FateExtraItemMetadata;
  effective: string;
  font_text: string | null;
  export_item: MutableRecord;
  row_number: number;
};

function prepare_export_row(
  row: MutableRecord,
  project_mode: "full" | "compact",
  classifications: ReadonlyMap<string, FateExtraClassificationRow>,
  representative_metadata_by_source_hash: Map<string, FateExtraItemMetadata | null>,
): PreparedExportRow {
  if (project_mode === "full") {
    const item = read_record(row["item"]);
    const metadata = read_fate_extra_item_metadata(
      item["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
    );
    if (metadata === null) {
      throw new Error("FE 索引结构已损坏：项目中存在缺少索引元数据的文本。");
    }
    const source = String(item["src"] ?? "");
    const translation = resolve_fate_extra_effective_translation(
      String(item["dst"] ?? ""),
      metadata,
    );
    return {
      file_path: String(item["file_path"] ?? ""),
      resource_path: metadata.path,
      char_offset: metadata.char_offset,
      source,
      source_line_numbers: metadata.source_line_numbers,
      pass_through: metadata.pass_through,
      metadata,
      effective: translation === "" ? source : translation,
      font_text: translation === "" ? source : translation,
      export_item: item,
      row_number: Number(item["row"] ?? 0),
    };
  }

  const file_path = String(row["file_path"] ?? "");
  const resource_path = String(row["resource_path"] ?? "");
  const char_offset = Number(row["char_offset"] ?? -1);
  const classification = classifications.get(`${resource_path}\u0000${char_offset.toString()}`);
  if (classification === undefined) {
    throw new Error(`精简映射缺少安全分类：${resource_path} / char:${char_offset.toString()}`);
  }
  const compact_item = read_record(row["compact_item"]);
  const source_hash = String(row["source_hash"] ?? "");
  let representative_metadata = representative_metadata_by_source_hash.get(source_hash);
  if (!representative_metadata_by_source_hash.has(source_hash)) {
    representative_metadata = read_fate_extra_item_metadata(
      compact_item["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
    );
    representative_metadata_by_source_hash.set(source_hash, representative_metadata);
  }
  const source = String(row["source"] ?? "");
  const source_line_numbers = Array.isArray(row["source_line_numbers"])
    ? row["source_line_numbers"].map((value) => Number(value))
    : [];
  const pass_through = Array.isArray(row["pass_through"])
    ? (row["pass_through"] as unknown as FateExtraItemMetadata["pass_through"])
    : [];
  const stored_display_mode = String(row["display_mode"] ?? "auto");
  const metadata: FateExtraItemMetadata = {
    schema_version: FATE_EXTRA_SCHEMA_VERSION,
    path: resource_path,
    char_offset,
    original_prefix: String(row["original_prefix"] ?? ""),
    source_hash,
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
  const occurrence_machine_translation = String(row["original_machine_translation"] ?? "");
  const machine_translation =
    occurrence_machine_translation === ""
      ? String(compact_item["dst"] ?? "")
      : occurrence_machine_translation;
  const override_translation = String(row["override_translation"] ?? "");
  const translation =
    String(row["excluded_reason"] ?? "") !== ""
      ? source
      : override_translation !== ""
        ? override_translation
        : resolve_fate_extra_effective_translation(machine_translation, metadata);
  const representative_translation =
    representative_metadata === null || representative_metadata === undefined
      ? ""
      : resolve_fate_extra_effective_translation(
          String(compact_item["dst"] ?? ""),
          representative_metadata,
        );
  const row_number = Number(row["row_number"] ?? 0);
  return {
    file_path,
    resource_path,
    char_offset,
    source,
    source_line_numbers,
    pass_through,
    metadata,
    effective: translation === "" ? source : translation,
    font_text:
      representative_metadata === null || representative_metadata === undefined
        ? null
        : representative_translation === ""
          ? String(compact_item["src"] ?? source)
          : representative_translation,
    export_item: {
      ...compact_item,
      id: Number(row["original_item_id"] ?? 0),
      src: source,
      dst: machine_translation,
      file_path,
      row: row_number,
      extra_field: merge_fate_extra_item_metadata(
        compact_item["extra_field"] as Parameters<typeof merge_fate_extra_item_metadata>[0],
        metadata,
      ),
    },
    row_number,
  };
}

function assert_project_revisions(
  database: ProjectDatabase,
  project_path: string,
  expected: Record<GuardedSection, number>,
): void {
  const meta = read_record(
    database.execute({ name: "getAllMeta", args: { projectPath: project_path } }),
  );
  for (const section of ["files", "items", "analysis", "proofreading"] as const) {
    if (get_section_revision(meta as JsonRecord, section) !== expected[section]) {
      throw new Error(`FE 工程 ${section} revision 已变化，请重新导出。`);
    }
  }
}

function build_qa_warnings(
  item: MutableRecord,
  metadata: FateExtraItemMetadata,
  measure_encoded_bytes: (text: string) => number,
): Array<Record<string, string | number>> {
  const warnings: Array<Record<string, string | number>> = [];
  const source = String(item["src"] ?? "");
  const machine = String(item["dst"] ?? "");
  const translated = resolve_fate_extra_effective_translation(machine, metadata);
  const text = translated === "" ? source : translated;
  const display_mode = resolve_display_mode(metadata);
  const base = {
    file_path: String(item["file_path"] ?? ""),
    row_number: Number(item["row"] ?? 0),
    path: metadata.path,
    char_offset: metadata.char_offset,
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
  if (!same_string_array(collect_control_tokens(source), collect_control_tokens(text))) {
    warnings.push({
      ...base,
      warning: "FE_CONTROL_SEQUENCE",
      severity: "blocker",
      message: "译文控制符的数量、内容或顺序与原文不一致。",
    });
  }
  if (metadata.migration_review) {
    warnings.push({
      ...base,
      warning: "FE_MIGRATION_REVIEW",
      severity: "warning",
      message: "旧译文无法唯一迁移，需要人工确认。",
    });
  }
  const capacity = metadata.classification.slot_capacity;
  const encoded_bytes = measure_encoded_bytes(text);
  if (capacity !== null && !metadata.classification.allow_overlength && encoded_bytes > capacity) {
    warnings.push({
      ...base,
      warning: "FE_STORAGE_CAPACITY",
      severity: "blocker",
      message: `FE 实际编码 ${encoded_bytes.toString()} 字节，超过固定槽位 ${capacity.toString()} 字节。`,
    });
  }
  const classification = metadata.classification;
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
  return warnings;
}

function measure_encoded_text_bytes(text: string, widths: Map<string, number>): number {
  let total = 0;
  for (const char of text) {
    total += widths.get(char) ?? ((char.codePointAt(0) ?? 0) <= 0x7f ? 1 : 2);
  }
  return total;
}

function read_record(value: unknown): MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as MutableRecord)
    : {};
}

function csv_cell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function collect_control_tokens(text: string): string[] {
  return text.match(FE_CONTROL_TOKEN_PATTERN) ?? [];
}

function same_string_array(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolve_display_mode(metadata: FateExtraItemMetadata): FateExtraResolvedDisplayMode {
  return resolve_fate_extra_display_mode(metadata, read_fate_extra_display_mode(metadata)).mode;
}
