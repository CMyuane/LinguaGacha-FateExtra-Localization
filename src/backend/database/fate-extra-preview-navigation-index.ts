import type { FateExtraIndexProgressReporter } from "../../shared/fate-extra/fate-extra-index-progress";
import type { DatabaseSync } from "node:sqlite";

import { JsonTool } from "../../shared/utils/json-tool";

export const FATE_EXTRA_PREVIEW_NAVIGATION_GENERATION_META_KEY =
  "fate_extra.preview-navigation.generation";
export const FATE_EXTRA_PREVIEW_NAVIGATION_ITEMS_REVISION_META_KEY =
  "fate_extra.preview-navigation.items-revision";
export const FATE_EXTRA_PREVIEW_INDEX_FORMAT_META_KEY = "fate_extra.preview-index.format-version";
export const FATE_EXTRA_PREVIEW_INDEX_FORMAT_VERSION = 2;

export function build_fate_extra_preview_index_identity(adapter_value: string): string {
  return JsonTool.stringifyStrict({
    format_version: FATE_EXTRA_PREVIEW_INDEX_FORMAT_VERSION,
    adapter_value,
  });
}

type DatabaseRow = Record<string, unknown>;

export type FateExtraPreviewNavigationState = {
  ready: boolean;
  generation: number;
  items_revision: number;
  indexed_items_revision: number;
  item_count: number;
  unique_count: number;
  occurrence_count: number;
  file_count: number;
};

export function read_fate_extra_preview_navigation_state(
  db: DatabaseSync,
): FateExtraPreviewNavigationState {
  const items_revision = read_json_number_meta(db, "project_runtime_revision.items");
  const generation = read_json_number_meta(db, FATE_EXTRA_PREVIEW_NAVIGATION_GENERATION_META_KEY);
  const row = db
    .prepare(`
      SELECT adapter_value, items_revision, item_count, unique_count,
        occurrence_count, file_count, complete
      FROM fate_extra_preview_navigation_generation
      WHERE generation = ?
    `)
    .get(generation);
  const adapter_value = read_meta_text(db, "fate_extra.adapter.v1");
  const format_version = read_json_number_meta(db, FATE_EXTRA_PREVIEW_INDEX_FORMAT_META_KEY);
  const indexed_items_revision = row_number(row ?? {}, "items_revision");
  return {
    ready:
      generation > 0 &&
      format_version === FATE_EXTRA_PREVIEW_INDEX_FORMAT_VERSION &&
      row_number(row ?? {}, "complete") === 1 &&
      adapter_value !== null &&
      build_fate_extra_preview_index_identity(adapter_value) ===
        row_text(row ?? {}, "adapter_value") &&
      items_revision === indexed_items_revision,
    generation,
    items_revision,
    indexed_items_revision,
    item_count: row_number(row ?? {}, "item_count"),
    unique_count: row_number(row ?? {}, "unique_count"),
    occurrence_count: row_number(row ?? {}, "occurrence_count"),
    file_count: row_number(row ?? {}, "file_count"),
  };
}

/**
 * 在维护 worker 中构建非活动导航 generation。项目打开阶段只建表，
 * 百万物理位置的排序和映射不会在 Electron 主进程执行。
 */
export function build_fate_extra_preview_navigation_generation(
  db: DatabaseSync,
  args: {
    generation: number;
    adapter_value: string;
    items_revision: number;
    item_count: number;
    compact: boolean;
    report_progress?: FateExtraIndexProgressReporter;
  },
): void {
  db.prepare(`
    INSERT INTO fate_extra_preview_navigation_generation (
      generation, adapter_value, items_revision, item_count,
      unique_count, occurrence_count, file_count, complete
    ) VALUES (?, ?, ?, ?, 0, 0, 0, 0)
  `).run(args.generation, args.adapter_value, args.items_revision, args.item_count);

  let step = 0;
  const on_step = () =>
    args.report_progress?.({ phase: "navigation", completed: ++step, total: 5 });
  if (args.compact) {
    build_compact_navigation(db, args.generation, on_step);
  } else {
    build_standard_navigation(db, args.generation, on_step);
  }

  db.prepare(`
    INSERT INTO fate_extra_preview_navigation_file_summary (
      generation, file_path, occurrence_count, unique_count, first_occurrence_id
    )
    SELECT occurrence.generation, occurrence.file_path, COUNT(*),
      COALESCE(unit_summary.unique_count, 0), MIN(occurrence.occurrence_id)
    FROM fate_extra_preview_navigation_occurrence AS occurrence
    LEFT JOIN (
      SELECT generation, file_path, COUNT(*) AS unique_count
      FROM fate_extra_preview_navigation_unit_file
      WHERE generation = ?
      GROUP BY generation, file_path
    ) AS unit_summary
      ON unit_summary.generation = occurrence.generation
      AND unit_summary.file_path = occurrence.file_path
    WHERE occurrence.generation = ?
    GROUP BY occurrence.generation, occurrence.file_path
  `).run(args.generation, args.generation);
  on_step();

  const unique_count = generation_count(db, "fate_extra_preview_navigation_unit", args.generation);
  const occurrence_count = generation_count(
    db,
    "fate_extra_preview_navigation_occurrence",
    args.generation,
  );
  const file_count = generation_count(
    db,
    "fate_extra_preview_navigation_file_summary",
    args.generation,
  );
  db.prepare(`
    UPDATE fate_extra_preview_navigation_generation
    SET unique_count = ?, occurrence_count = ?, file_count = ?, complete = 1
    WHERE generation = ? AND complete = 0
  `).run(unique_count, occurrence_count, file_count, args.generation);
  on_step();
}

function build_standard_navigation(
  db: DatabaseSync,
  generation: number,
  on_step: () => void,
): void {
  db.prepare(`
    INSERT INTO fate_extra_preview_navigation_unit (
      generation, position, unit_id, item_id, occurrence_count
    )
    WITH visible_unit AS (
      SELECT text_occurrence.unit_id, MIN(item.id) AS representative_item_id,
        COUNT(*) AS occurrence_count
      FROM fate_extra_text_occurrence AS text_occurrence
      JOIN items AS item ON item.id = text_occurrence.item_id
      WHERE COALESCE(json_extract(item.data, '$.status'), '') <> 'EXCLUDED'
      GROUP BY text_occurrence.unit_id
    )
    SELECT ?, ROW_NUMBER() OVER (ORDER BY representative_item_id) - 1,
      unit_id, representative_item_id, occurrence_count
    FROM visible_unit
    ORDER BY representative_item_id
  `).run(generation);
  on_step();
  db.prepare(`
    INSERT INTO fate_extra_preview_navigation_occurrence (
      generation, occurrence_id, item_id, unit_id, file_path,
      global_position, file_position
    )
    SELECT ?, item.id, item.id, text_occurrence.unit_id,
      COALESCE(json_extract(item.data, '$.file_path'), ''),
      ROW_NUMBER() OVER (ORDER BY item.id) - 1,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(json_extract(item.data, '$.file_path'), '') ORDER BY item.id
      ) - 1
    FROM items AS item
    JOIN fate_extra_text_occurrence AS text_occurrence ON text_occurrence.item_id = item.id
    WHERE COALESCE(json_extract(item.data, '$.status'), '') <> 'EXCLUDED'
    ORDER BY item.id
  `).run(generation);
  on_step();
  db.prepare(`
    INSERT INTO fate_extra_preview_navigation_unit_file (
      generation, file_path, position, unit_id, item_id, occurrence_id
    )
    WITH first_in_file AS (
      SELECT COALESCE(json_extract(item.data, '$.file_path'), '') AS file_path,
        text_occurrence.unit_id, MIN(item.id) AS item_id,
        MIN(item.id) AS occurrence_id
      FROM items AS item
      JOIN fate_extra_text_occurrence AS text_occurrence ON text_occurrence.item_id = item.id
      WHERE COALESCE(json_extract(item.data, '$.status'), '') <> 'EXCLUDED'
      GROUP BY file_path, text_occurrence.unit_id
    )
    SELECT ?, file_path,
      ROW_NUMBER() OVER (PARTITION BY file_path ORDER BY item_id) - 1,
      unit_id, item_id, occurrence_id
    FROM first_in_file
    ORDER BY file_path, item_id
  `).run(generation);
  on_step();
}

function build_compact_navigation(db: DatabaseSync, generation: number, on_step: () => void): void {
  db.prepare(`
    INSERT INTO fate_extra_preview_navigation_unit (
      generation, position, unit_id, item_id, occurrence_count
    )
    WITH visible_unit AS (
      SELECT text_occurrence.unit_id, compact_source.compact_item_id AS item_id,
        compact_source.occurrence_count
      FROM fate_extra_compact_source AS compact_source
      JOIN items AS item ON item.id = compact_source.compact_item_id
      JOIN fate_extra_text_occurrence AS text_occurrence
        ON text_occurrence.item_id = compact_source.compact_item_id
      WHERE compact_source.excluded_reason = ''
        AND compact_source.compact_item_id IS NOT NULL
        AND COALESCE(json_extract(item.data, '$.status'), '') <> 'EXCLUDED'
    )
    SELECT ?, ROW_NUMBER() OVER (ORDER BY item_id) - 1,
      unit_id, item_id, occurrence_count
    FROM visible_unit
    ORDER BY item_id
  `).run(generation);
  on_step();
  const source = `
    FROM fate_extra_compact_occurrence AS occurrence
    JOIN fate_extra_compact_source AS compact_source
      ON compact_source.source_hash = occurrence.source_hash
    JOIN items AS item ON item.id = compact_source.compact_item_id
    JOIN fate_extra_text_occurrence AS text_occurrence
      ON text_occurrence.item_id = compact_source.compact_item_id
    WHERE compact_source.excluded_reason = ''
      AND compact_source.compact_item_id IS NOT NULL
      AND COALESCE(json_extract(item.data, '$.status'), '') <> 'EXCLUDED'
  `;
  db.prepare(`
    INSERT INTO fate_extra_preview_navigation_occurrence (
      generation, occurrence_id, item_id, unit_id, file_path,
      global_position, file_position
    )
    SELECT ?, occurrence.original_item_id, compact_source.compact_item_id,
      text_occurrence.unit_id, occurrence.file_path,
      ROW_NUMBER() OVER (ORDER BY occurrence.original_item_id) - 1,
      ROW_NUMBER() OVER (
        PARTITION BY occurrence.file_path
        ORDER BY occurrence.row_number, occurrence.original_item_id
      ) - 1
    ${source}
    ORDER BY occurrence.original_item_id
  `).run(generation);
  on_step();
  db.prepare(`
    INSERT INTO fate_extra_preview_navigation_unit_file (
      generation, file_path, position, unit_id, item_id, occurrence_id
    )
    WITH first_in_file AS (
      SELECT occurrence.file_path, text_occurrence.unit_id,
        compact_source.compact_item_id AS item_id,
        MIN(occurrence.original_item_id) AS occurrence_id,
        MIN(occurrence.row_number) AS first_row
      ${source}
      GROUP BY occurrence.file_path, text_occurrence.unit_id, compact_source.compact_item_id
    )
    SELECT ?, file_path,
      ROW_NUMBER() OVER (
        PARTITION BY file_path ORDER BY first_row, occurrence_id
      ) - 1,
      unit_id, item_id, occurrence_id
    FROM first_in_file
    ORDER BY file_path, first_row, occurrence_id
  `).run(generation);
  on_step();
}

export function activate_fate_extra_preview_navigation_generation(
  db: DatabaseSync,
  generation: number,
  expected_items_revision: number,
  expected_adapter_value: string,
): FateExtraPreviewNavigationState {
  const current_adapter_value = read_meta_text(db, "fate_extra.adapter.v1");
  const row = db
    .prepare(`
      SELECT adapter_value, items_revision, complete
      FROM fate_extra_preview_navigation_generation
      WHERE generation = ?
    `)
    .get(generation);
  if (
    row === undefined ||
    row_number(row, "complete") !== 1 ||
    row_number(row, "items_revision") !== expected_items_revision ||
    row_text(row, "adapter_value") !== expected_adapter_value ||
    read_json_number_meta(db, "project_runtime_revision.items") !== expected_items_revision ||
    current_adapter_value === null ||
    build_fate_extra_preview_index_identity(current_adapter_value) !== expected_adapter_value
  ) {
    throw new Error("fate_extra_preview_navigation_activation_identity_changed");
  }
  write_navigation_identity(db, generation, expected_items_revision);
  const state = read_fate_extra_preview_navigation_state(db);
  if (!state.ready || state.generation !== generation) {
    throw new Error("fate_extra_preview_navigation_activation_incomplete");
  }
  return state;
}

export function advance_fate_extra_preview_navigation_revision(
  db: DatabaseSync,
  generation: number,
  previous_items_revision: number,
  items_revision: number,
): boolean {
  const adapter_value = read_meta_text(db, "fate_extra.adapter.v1");
  if (
    adapter_value === null ||
    read_json_number_meta(db, FATE_EXTRA_PREVIEW_INDEX_FORMAT_META_KEY) !==
      FATE_EXTRA_PREVIEW_INDEX_FORMAT_VERSION
  ) {
    return false;
  }
  const changed = db
    .prepare(`
      UPDATE fate_extra_preview_navigation_generation
      SET items_revision = ?
      WHERE generation = ? AND complete = 1 AND items_revision = ? AND adapter_value = ?
    `)
    .run(
      items_revision,
      generation,
      previous_items_revision,
      build_fate_extra_preview_index_identity(adapter_value),
    ).changes;
  if (changed !== 1) return false;
  write_navigation_identity(db, generation, items_revision);
  return true;
}

export function cleanup_fate_extra_preview_navigation_generation(
  db: DatabaseSync,
  generation: number,
): void {
  db.prepare("DELETE FROM fate_extra_preview_navigation_unit WHERE generation = ?").run(generation);
  db.prepare("DELETE FROM fate_extra_preview_navigation_occurrence WHERE generation = ?").run(
    generation,
  );
  db.prepare("DELETE FROM fate_extra_preview_navigation_unit_file WHERE generation = ?").run(
    generation,
  );
  db.prepare("DELETE FROM fate_extra_preview_navigation_file_summary WHERE generation = ?").run(
    generation,
  );
  db.prepare("DELETE FROM fate_extra_preview_navigation_generation WHERE generation = ?").run(
    generation,
  );
}

export function cleanup_inactive_fate_extra_preview_navigation_generations(
  db: DatabaseSync,
): number {
  const active_generation = read_json_number_meta(
    db,
    FATE_EXTRA_PREVIEW_NAVIGATION_GENERATION_META_KEY,
  );
  const generations = db
    .prepare(
      "SELECT generation FROM fate_extra_preview_navigation_generation WHERE generation <> ?",
    )
    .all(active_generation)
    .map((row) => row_number(row, "generation"));
  for (const generation of generations) {
    cleanup_fate_extra_preview_navigation_generation(db, generation);
  }
  return generations.length;
}

function write_navigation_identity(
  db: DatabaseSync,
  generation: number,
  items_revision: number,
): void {
  const upsert = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  upsert.run(
    FATE_EXTRA_PREVIEW_NAVIGATION_GENERATION_META_KEY,
    JsonTool.stringifyStrict(generation),
  );
  upsert.run(
    FATE_EXTRA_PREVIEW_NAVIGATION_ITEMS_REVISION_META_KEY,
    JsonTool.stringifyStrict(items_revision),
  );
  upsert.run(
    FATE_EXTRA_PREVIEW_INDEX_FORMAT_META_KEY,
    JsonTool.stringifyStrict(FATE_EXTRA_PREVIEW_INDEX_FORMAT_VERSION),
  );
}

function generation_count(db: DatabaseSync, table: string, generation: number): number {
  return row_number(
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE generation = ?`).get(generation) ?? {},
    "count",
  );
}

function read_meta_text(db: DatabaseSync, key: string): string | null {
  const value = db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.["value"];
  return typeof value === "string" ? value : null;
}

function read_json_number_meta(db: DatabaseSync, key: string): number {
  const value = read_meta_text(db, key);
  if (value === null) return 0;
  try {
    const parsed = JsonTool.parseStrict<unknown>(value);
    return typeof parsed === "number" && Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  } catch {
    return 0;
  }
}

function row_text(row: DatabaseRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : String(value ?? "");
}

function row_number(row: DatabaseRow, key: string): number {
  const value = row[key];
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}
