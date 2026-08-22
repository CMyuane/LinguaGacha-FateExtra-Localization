import { DatabaseSync } from "node:sqlite";

import { FATE_EXTRA_SUPPLEMENT_FILE } from "../../shared/fate-extra/fate-extra-types";
import { read_fate_extra_item_metadata } from "../../shared/fate-extra/fate-extra-types";
import {
  has_fate_extra_preview_warning,
  is_fate_extra_preview_warning_code,
  type FateExtraPreviewWarningCode,
} from "../../shared/fate-extra/fate-extra-warning";
import { JsonTool } from "../../shared/utils/json-tool";
import type { DatabaseJsonValue } from "./database-types";
import {
  build_fate_extra_preview_search_match_query,
  fate_extra_preview_search_length,
  normalize_fate_extra_preview_search_text,
  read_fate_extra_preview_search_index_state,
} from "./fate-extra-preview-search-index";

type DatabaseRow = Record<string, unknown>;
type QueryValue = string | number;

export type FateExtraPreviewReadonlyQuery = {
  projectPath: string;
  search: string;
  filePath: string;
  category: string;
  warning?: string;
  encodedWidths?: Array<[string, number]>;
  projectEpoch?: number;
  offset: number;
  limit: number;
  includeFiles: boolean;
  includeTotal: boolean;
  viewMode: "unique" | "occurrence";
  expectedGeneration: number;
  expectedItemsRevision: number;
};

/**
 * 预览 worker 的真正只读边界。readOnly + query_only 保证它既不迁移 schema，
 * 也不能通过意外 SQL 修改工程；同一 read transaction 固定 generation/revision 快照。
 */
export function query_fate_extra_preview_readonly(
  input: FateExtraPreviewReadonlyQuery,
): DatabaseJsonValue {
  const db = new DatabaseSync(input.projectPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
    const state = read_fate_extra_preview_search_index_state(db);
    assert_query_identity(state, input);
    const page = read_preview_page(db, input, state.generation);
    const final_state = read_fate_extra_preview_search_index_state(db);
    assert_query_identity(final_state, input);
    db.exec("COMMIT");
    return {
      ...as_record(page),
      index_generation: state.generation,
      applied_items_revision: query_requires_index(input)
        ? state.indexed_items_revision
        : state.items_revision,
    } as DatabaseJsonValue;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // BEGIN 之前失败时没有事务可回滚，关闭只读句柄即可。
    }
    throw error;
  } finally {
    db.close();
  }
}

function assert_query_identity(
  state: ReturnType<typeof read_fate_extra_preview_search_index_state>,
  input: FateExtraPreviewReadonlyQuery,
): void {
  const matches = query_requires_index(input)
    ? state.ready &&
      state.generation === Math.trunc(input.expectedGeneration) &&
      state.indexed_items_revision === Math.trunc(input.expectedItemsRevision)
    : state.items_revision === Math.trunc(input.expectedItemsRevision);
  if (!matches) {
    throw new Error("fate_extra_preview_query_identity_changed");
  }
}

function query_requires_index(input: FateExtraPreviewReadonlyQuery): boolean {
  return (
    input.viewMode === "unique" ||
    input.search !== "" ||
    input.filePath !== "" ||
    input.category !== ""
  );
}

function read_preview_page(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
): DatabaseJsonValue {
  const compact = db.prepare("SELECT 1 FROM meta WHERE key = 'fate_extra.compact.v1'").get();
  const warning = input.warning ?? "";
  if (is_fate_extra_preview_warning_code(warning)) {
    return read_warning_filtered_page(db, input, generation, warning, compact !== undefined);
  }
  if (compact !== undefined) return read_compact_page(db, input, generation);
  if (input.viewMode === "unique") return read_unique_page(db, input, generation);
  return read_occurrence_page(db, input, generation);
}

const WARNING_SCAN_BATCH_SIZE = 2_000;

type WarningUnitMatch = {
  unit_id: number;
  physical_occurrence_id: number;
  order_id: number;
};

type WarningMatchIndex =
  | { kind: "normal-occurrence"; ids: number[] }
  | { kind: "compact-occurrence"; ids: number[] }
  | { kind: "normal-unique"; units: WarningUnitMatch[] }
  | { kind: "compact-unique"; units: WarningUnitMatch[] };

let warning_match_cache: { key: string; index: WarningMatchIndex } | null = null;

/**
 * Warning 依赖 FE 控制符布局和自定义编码，无法安全下推为 JSON SQL 表达式。
 * 专用可终止 worker 因而用稳定主键游标扫描候选 occurrence，只把命中页返回主进程。
 */
function read_warning_filtered_page(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
  warning: FateExtraPreviewWarningCode,
  compact: boolean,
): DatabaseJsonValue {
  const encoded_widths = new Map(input.encodedWidths ?? []);
  const measure_encoded_bytes = (text: string): number => {
    let total = 0;
    for (const char of text) {
      const mapped = encoded_widths.get(char);
      total += mapped ?? ((char.codePointAt(0) ?? 0) <= 0x7f ? 1 : 2);
    }
    return total;
  };
  const unique_scope = input.viewMode === "unique" && (!compact || input.filePath === "");
  const offset = safe_offset(input.offset);
  const limit = safe_limit(input.limit);
  const cache_key = build_warning_cache_key(input, generation, warning, compact);
  let index = warning_match_cache?.key === cache_key ? warning_match_cache.index : null;
  if (index === null) {
    index = unique_scope
      ? scan_unique_warning_index(db, input, generation, warning, compact, measure_encoded_bytes)
      : scan_occurrence_warning_index(
          db,
          input,
          generation,
          warning,
          compact,
          measure_encoded_bytes,
        );
    warning_match_cache = { key: cache_key, index };
  }
  const total = "units" in index ? index.units.length : index.ids.length;
  const rows = hydrate_warning_page(db, index, offset, limit).map((row) => ({
    ...row,
    fe_warning_codes: [warning],
  }));
  const file_rows = input.includeFiles
    ? compact
      ? read_compact_file_rows(db)
      : (db
          .prepare(`
            SELECT file_path, occurrence_count AS count
            FROM fate_extra_file_summary
            ORDER BY first_item_id
            LIMIT 200
          `)
          .all() as DatabaseRow[])
    : [];
  return {
    ...as_record(page_result(rows, { count: total }, file_rows, input.viewMode)),
    review_scope: unique_scope ? "unit" : input.viewMode === "unique" ? "unit" : "occurrence",
    ...(compact && !unique_scope ? { compact_route_projection: true } : {}),
  } as DatabaseJsonValue;
}

function scan_occurrence_warning_index(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
  warning: FateExtraPreviewWarningCode,
  compact: boolean,
  measure_encoded_bytes: (text: string) => number,
): WarningMatchIndex {
  return compact
    ? {
        kind: "compact-occurrence",
        ids: scan_compact_occurrence_warning_ids(
          db,
          input,
          generation,
          warning,
          measure_encoded_bytes,
        ),
      }
    : {
        kind: "normal-occurrence",
        ids: scan_normal_occurrence_warning_ids(
          db,
          input,
          generation,
          warning,
          measure_encoded_bytes,
        ),
      };
}

function scan_normal_occurrence_warning_ids(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
  warning: FateExtraPreviewWarningCode,
  measure_encoded_bytes: (text: string) => number,
): number[] {
  const conditions: string[] = [];
  const parameters: QueryValue[] = [];
  append_occurrence_index_conditions(conditions, parameters, input, generation, "item.id");
  const ids: number[] = [];
  let after_item_id = -1;
  while (true) {
    const where = [...conditions, "item.id > ?"];
    const rows = db
      .prepare(`
        SELECT item.id, item.data
        FROM items AS item
        WHERE ${where.join(" AND ")}
        ORDER BY item.id
        LIMIT ?
      `)
      .all(...parameters, after_item_id, WARNING_SCAN_BATCH_SIZE);
    if (rows.length === 0) break;
    for (const raw of rows) {
      const id = row_number(raw, "id");
      after_item_id = id;
      const row = { ...as_record(parse_json(raw["data"])), id };
      if (row_has_warning(row, warning, measure_encoded_bytes)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

function scan_compact_occurrence_warning_ids(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
  warning: FateExtraPreviewWarningCode,
  measure_encoded_bytes: (text: string) => number,
): number[] {
  const conditions = ["compact_source.excluded_reason = ''"];
  const parameters: QueryValue[] = [];
  append_compact_index_conditions(conditions, parameters, input, generation);
  if (input.viewMode === "unique" && input.filePath === FATE_EXTRA_SUPPLEMENT_FILE) {
    conditions.push(`occurrence.original_item_id = (
      SELECT MIN(candidate.original_item_id)
      FROM fate_extra_compact_occurrence AS candidate
      WHERE candidate.file_path = occurrence.file_path
        AND candidate.source_hash = occurrence.source_hash
    )`);
  }
  const ids: number[] = [];
  let after_item_id = -1;
  let after_row_number = -1;
  while (true) {
    const cursor_condition =
      input.filePath === ""
        ? "occurrence.original_item_id > ?"
        : `(occurrence.row_number > ? OR (
            occurrence.row_number = ? AND occurrence.original_item_id > ?
          ))`;
    const cursor_parameters =
      input.filePath === "" ? [after_item_id] : [after_row_number, after_row_number, after_item_id];
    const order_by =
      input.filePath === ""
        ? "occurrence.original_item_id"
        : "occurrence.row_number, occurrence.original_item_id";
    const rows = db
      .prepare(`
        ${compact_occurrence_select_sql()}
        WHERE ${[...conditions, cursor_condition].join(" AND ")}
        ORDER BY ${order_by}
        LIMIT ?
      `)
      .all(...parameters, ...cursor_parameters, WARNING_SCAN_BATCH_SIZE);
    if (rows.length === 0) break;
    for (const raw of rows) {
      after_item_id = row_number(raw, "original_item_id");
      after_row_number = row_number(raw, "occurrence_row_number");
      const row = project_compact_row(raw);
      if (row_has_warning(row, warning, measure_encoded_bytes)) {
        ids.push(after_item_id);
      }
    }
  }
  return ids;
}

function scan_unique_warning_index(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
  warning: FateExtraPreviewWarningCode,
  compact: boolean,
  measure_encoded_bytes: (text: string) => number,
): WarningMatchIndex {
  const unit_conditions: string[] = [];
  const unit_parameters: QueryValue[] = [];
  append_unique_index_conditions(unit_conditions, unit_parameters, input, generation);
  const candidate_unit_where =
    unit_conditions.length === 0 ? "" : ` AND ${unit_conditions.join(" AND ")}`;
  const first_match_by_unit = new Map<number, WarningUnitMatch>();
  let after_occurrence_id = -1;
  while (true) {
    const rows = compact
      ? db
          .prepare(`
            SELECT
              unit.unit_id AS candidate_unit_id,
              unit.representative_item_id,
              ${compact_occurrence_select_columns_sql()}
            FROM fate_extra_compact_occurrence AS occurrence
            JOIN fate_extra_compact_source AS compact_source
              ON compact_source.source_hash = occurrence.source_hash
            JOIN items AS item ON item.id = compact_source.compact_item_id
            JOIN fate_extra_text_occurrence AS text_occurrence
              ON text_occurrence.item_id = item.id
            JOIN fate_extra_text_unit AS unit ON unit.unit_id = text_occurrence.unit_id
            WHERE compact_source.excluded_reason = ''
              AND occurrence.original_item_id > ?${candidate_unit_where}
            ORDER BY occurrence.original_item_id
            LIMIT ?
          `)
          .all(after_occurrence_id, ...unit_parameters, WARNING_SCAN_BATCH_SIZE)
      : db
          .prepare(`
            SELECT
              unit.unit_id AS candidate_unit_id,
              unit.representative_item_id,
              unit.occurrence_count,
              item.id,
              item.data
            FROM items AS item
            JOIN fate_extra_text_occurrence AS occurrence ON occurrence.item_id = item.id
            JOIN fate_extra_text_unit AS unit ON unit.unit_id = occurrence.unit_id
            WHERE item.id > ?${candidate_unit_where}
            ORDER BY item.id
            LIMIT ?
          `)
          .all(after_occurrence_id, ...unit_parameters, WARNING_SCAN_BATCH_SIZE);
    if (rows.length === 0) break;
    for (const raw of rows) {
      const physical_id = compact ? row_number(raw, "original_item_id") : row_number(raw, "id");
      after_occurrence_id = physical_id;
      const unit_id = row_number(raw, "candidate_unit_id");
      if (first_match_by_unit.has(unit_id)) continue;
      const row = compact
        ? project_compact_row(raw)
        : { ...as_record(parse_json(raw["data"])), id: physical_id };
      if (!row_has_warning(row, warning, measure_encoded_bytes)) continue;
      first_match_by_unit.set(unit_id, {
        unit_id,
        physical_occurrence_id: physical_id,
        order_id: row_number(raw, "representative_item_id"),
      });
    }
  }
  return {
    kind: compact ? "compact-unique" : "normal-unique",
    units: [...first_match_by_unit.values()].sort((left, right) => left.order_id - right.order_id),
  };
}

function build_warning_cache_key(
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
  warning: FateExtraPreviewWarningCode,
  compact: boolean,
): string {
  return JSON.stringify([
    input.projectPath,
    input.projectEpoch ?? 0,
    input.expectedItemsRevision,
    generation,
    compact,
    input.viewMode,
    input.search,
    input.filePath,
    input.category,
    warning,
    input.encodedWidths ?? [],
  ]);
}

function hydrate_warning_page(
  db: DatabaseSync,
  index: WarningMatchIndex,
  offset: number,
  limit: number,
): DatabaseRow[] {
  if (index.kind === "normal-occurrence") {
    const read = db.prepare("SELECT id, data FROM items WHERE id = ?");
    return index.ids.slice(offset, offset + limit).flatMap((id) => {
      const raw = read.get(id);
      return raw === undefined
        ? []
        : [{ ...as_record(parse_json(raw["data"])), id: row_number(raw, "id") }];
    });
  }
  if (index.kind === "compact-occurrence") {
    const read = db.prepare(`
      ${compact_occurrence_select_sql()}
      WHERE occurrence.original_item_id = ?
    `);
    return index.ids.slice(offset, offset + limit).flatMap((id) => {
      const raw = read.get(id);
      return raw === undefined ? [] : [project_compact_row(raw)];
    });
  }
  if (index.kind === "normal-unique") {
    const read = db.prepare(`
      SELECT unit.unit_id, unit.occurrence_count, item.id, item.data
      FROM fate_extra_text_unit AS unit
      JOIN items AS item ON item.id = unit.representative_item_id
      WHERE unit.unit_id = ?
    `);
    return index.units.slice(offset, offset + limit).flatMap((match) => {
      const raw = read.get(match.unit_id);
      return raw === undefined
        ? []
        : [
            {
              ...as_record(parse_json(raw["data"])),
              id: row_number(raw, "id"),
              fe_text_unit_id: match.unit_id,
              fe_occurrence_count: row_number(raw, "occurrence_count"),
              fe_warning_occurrence_id: match.physical_occurrence_id,
            },
          ];
    });
  }
  const read = db.prepare(`
    ${compact_occurrence_select_sql()}
    WHERE occurrence.original_item_id = ?
  `);
  return index.units.slice(offset, offset + limit).flatMap((match) => {
    const raw = read.get(match.physical_occurrence_id);
    if (raw === undefined) return [];
    return [
      {
        ...project_compact_row(raw),
        fe_text_unit_id: match.unit_id,
        fe_warning_occurrence_id: match.physical_occurrence_id,
      },
    ];
  });
}

function row_has_warning(
  row: DatabaseRow,
  warning: FateExtraPreviewWarningCode,
  measure_encoded_bytes: (text: string) => number,
): boolean {
  const metadata = read_fate_extra_item_metadata(
    row["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
  );
  if (metadata === null) return false;
  return has_fate_extra_preview_warning({
    warning,
    src: row_text(row, "src"),
    dst: row_text(row, "dst"),
    metadata,
    measure_encoded_bytes,
  });
}

function append_occurrence_index_conditions(
  conditions: string[],
  parameters: QueryValue[],
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
  item_expression: string,
): void {
  if (input.filePath !== "") {
    conditions.push(`${item_expression} IN (
      SELECT mapping.item_id
      FROM fate_extra_preview_search_mapping AS mapping
      JOIN fate_extra_preview_search_document AS document
        ON document.document_id = mapping.document_id
        AND document.generation = mapping.generation
      WHERE mapping.generation = ?
        AND mapping.field = 'file-exact'
        AND document.search_text = ?
    )`);
    parameters.push(generation, input.filePath);
  }
  if (input.category !== "") {
    conditions.push(`${item_expression} IN (
      SELECT item_id FROM fate_extra_preview_search_item
      WHERE generation = ? AND category = ?
    )`);
    parameters.push(generation, input.category);
  }
  if (input.search !== "") {
    const filter = build_search_filter(input.search, item_expression, generation);
    conditions.push(filter.sql);
    parameters.push(...filter.parameters);
  }
}

function append_compact_index_conditions(
  conditions: string[],
  parameters: QueryValue[],
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
): void {
  if (input.filePath !== "") {
    conditions.push("occurrence.file_path = ?");
    parameters.push(input.filePath);
  }
  if (input.category !== "") {
    conditions.push("occurrence.safety_category = ?");
    parameters.push(input.category);
  }
  if (input.search !== "") {
    const filter = build_compact_search_filter(input.search, generation);
    conditions.push(filter.sql);
    parameters.push(...filter.parameters);
  }
}

function append_unique_index_conditions(
  conditions: string[],
  parameters: QueryValue[],
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
): void {
  if (input.filePath !== "") {
    conditions.push(`EXISTS (
      SELECT 1
      FROM fate_extra_preview_search_item AS filtered_item
      JOIN fate_extra_preview_search_mapping AS mapping
        ON mapping.generation = filtered_item.generation
        AND mapping.item_id = filtered_item.item_id
      JOIN fate_extra_preview_search_document AS document
        ON document.generation = mapping.generation
        AND document.document_id = mapping.document_id
      WHERE filtered_item.generation = ?
        AND filtered_item.unit_id = unit.unit_id
        AND mapping.field = 'file-exact'
        AND document.search_text = ?
    )`);
    parameters.push(generation, input.filePath);
  }
  if (input.category !== "") {
    conditions.push(`EXISTS (
      SELECT 1
      FROM fate_extra_preview_search_item AS filtered_item
      WHERE filtered_item.generation = ?
        AND filtered_item.unit_id = unit.unit_id
        AND filtered_item.category = ?
    )`);
    parameters.push(generation, input.category);
  }
  if (input.search !== "") {
    const filter = build_search_filter(
      input.search,
      "unit.unit_id",
      generation,
      "search_item.unit_id",
    );
    conditions.push(filter.sql);
    parameters.push(...filter.parameters);
  }
}

function compact_occurrence_select_sql(): string {
  return `
    SELECT ${compact_occurrence_select_columns_sql()}
    FROM fate_extra_compact_occurrence AS occurrence
    JOIN fate_extra_compact_source AS compact_source
      ON compact_source.source_hash = occurrence.source_hash
    JOIN items AS item ON item.id = compact_source.compact_item_id
    LEFT JOIN fate_extra_text_occurrence AS text_occurrence
      ON text_occurrence.item_id = item.id
  `;
}

function compact_occurrence_select_columns_sql(): string {
  return `
    occurrence.original_item_id,
    occurrence.file_path AS occurrence_file_path,
    occurrence.row_number AS occurrence_row_number,
    occurrence.resource_path,
    occurrence.char_offset,
    occurrence.original_prefix,
    occurrence.source_line_numbers,
    occurrence.pass_through,
    occurrence.display_mode AS occurrence_display_mode,
    occurrence.safety_category,
    occurrence.slot_capacity,
    occurrence.allow_overlength,
    occurrence.original_machine_translation,
    compact_source.source,
    compact_source.occurrence_count,
    compact_source.compact_item_id,
    text_occurrence.unit_id,
    item.data
  `;
}

function read_occurrence_page(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
): DatabaseJsonValue {
  if (input.search !== "" && input.filePath === "" && input.category === "") {
    return read_indexed_occurrence_search_page(db, input, generation);
  }
  const conditions: string[] = [];
  const parameters: QueryValue[] = [];
  if (input.filePath !== "") {
    conditions.push(`item.id IN (
      SELECT mapping.item_id
      FROM fate_extra_preview_search_mapping AS mapping
      JOIN fate_extra_preview_search_document AS document
        ON document.document_id = mapping.document_id
        AND document.generation = mapping.generation
      WHERE mapping.generation = ?
        AND mapping.field = 'file-exact'
        AND document.search_text = ?
    )`);
    parameters.push(generation, input.filePath);
  }
  if (input.category !== "") {
    conditions.push(`item.id IN (
      SELECT item_id FROM fate_extra_preview_search_item
      WHERE generation = ? AND category = ?
    )`);
    parameters.push(generation, input.category);
  }
  if (input.search !== "") {
    const filter = build_search_filter(input.search, "item.id", generation);
    conditions.push(filter.sql);
    parameters.push(...filter.parameters);
  }
  const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
  const total_row = input.includeTotal
    ? db.prepare(`SELECT COUNT(*) AS count FROM items AS item${where}`).get(...parameters)
    : undefined;
  const rows = db
    .prepare(
      `SELECT item.id, item.data FROM items AS item${where} ORDER BY item.id LIMIT ? OFFSET ?`,
    )
    .all(...parameters, safe_limit(input.limit), safe_offset(input.offset))
    .map((row) => ({ ...as_record(parse_json(row["data"])), id: row_number(row, "id") }));
  const file_rows = input.includeFiles
    ? db
        .prepare(`
          SELECT file_path, occurrence_count AS count
          FROM fate_extra_file_summary
          ORDER BY first_item_id
          LIMIT 200
        `)
        .all()
    : [];
  return page_result(rows, total_row, file_rows, input.viewMode);
}

function read_indexed_occurrence_search_page(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
): DatabaseJsonValue {
  const matched = build_fate_extra_preview_matched_document_query(input.search, generation);
  const common_table = `WITH matched_document(document_id, field) AS MATERIALIZED (
    ${matched.sql}
  )`;
  const matched_summary = as_record(
    db
      .prepare(`${common_table}
        SELECT COUNT(*) AS document_count, COUNT(DISTINCT field) AS field_count
        FROM matched_document`)
      .get(...matched.parameters),
  );
  const document_count = row_number(matched_summary, "document_count");
  const total_row =
    !input.includeTotal || document_count === 0
      ? input.includeTotal
        ? ({ count: 0 } as DatabaseRow)
        : undefined
      : db
          .prepare(`${common_table}
            ${
              row_number(matched_summary, "field_count") === 1
                ? `SELECT COALESCE(SUM(summary.occurrence_count), 0) AS count
                   FROM matched_document
                   JOIN fate_extra_preview_search_file_summary AS summary
                     ON summary.generation = ?
                     AND summary.document_id = matched_document.document_id`
                : `SELECT COUNT(DISTINCT mapping.item_id) AS count
                   FROM matched_document
                   CROSS JOIN fate_extra_preview_search_mapping AS mapping
                     INDEXED BY idx_fate_extra_preview_search_item_document
                   WHERE mapping.generation = ?
                     AND mapping.document_id = matched_document.document_id`
            }`)
          .get(...matched.parameters, generation);
  const rows =
    document_count === 0
      ? []
      : db
          .prepare(`${common_table}
            SELECT item.id, item.data
            FROM fate_extra_preview_search_mapping AS mapping
              INDEXED BY idx_fate_extra_preview_search_mapping_item
            JOIN items AS item ON item.id = mapping.item_id
            WHERE mapping.generation = ?
              AND mapping.document_id IN (SELECT document_id FROM matched_document)
            GROUP BY mapping.item_id
            ORDER BY mapping.item_id
            LIMIT ? OFFSET ?`)
          .all(
            ...matched.parameters,
            generation,
            safe_limit(input.limit),
            safe_offset(input.offset),
          )
          .map((row) => ({ ...as_record(parse_json(row["data"])), id: row_number(row, "id") }));
  const file_rows = input.includeFiles
    ? (db
        .prepare(`
          SELECT file_path, occurrence_count AS count
          FROM fate_extra_file_summary
          ORDER BY first_item_id
          LIMIT 200
        `)
        .all() as DatabaseRow[])
    : [];
  return page_result(rows, total_row, file_rows, "occurrence");
}

function read_compact_page(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
): DatabaseJsonValue {
  if (input.viewMode === "unique" && input.filePath === "") {
    const page = as_record(read_unique_page(db, { ...input, includeFiles: false }, generation));
    if (!input.includeFiles) return page as DatabaseJsonValue;
    const file_rows = read_compact_file_rows(db);
    page["files"] = file_rows.map((row) => row_text(row, "file_path"));
    page["file_counts"] = Object.fromEntries(
      file_rows.map((row) => [row_text(row, "file_path"), row_number(row, "count")]),
    );
    page["review_scope"] = "unit";
    return page as DatabaseJsonValue;
  }

  const conditions = ["compact_source.excluded_reason = ''"];
  const parameters: QueryValue[] = [];
  const deduplicate_supplement =
    input.viewMode === "unique" && input.filePath === FATE_EXTRA_SUPPLEMENT_FILE;
  if (input.filePath !== "") {
    conditions.push("occurrence.file_path = ?");
    parameters.push(input.filePath);
  }
  if (input.category !== "") {
    conditions.push("occurrence.safety_category = ?");
    parameters.push(input.category);
  }
  if (input.search !== "") {
    const filter = build_compact_search_filter(input.search, generation);
    conditions.push(filter.sql);
    parameters.push(...filter.parameters);
  }
  if (deduplicate_supplement) {
    conditions.push(`occurrence.original_item_id = (
      SELECT MIN(candidate.original_item_id)
      FROM fate_extra_compact_occurrence AS candidate
      WHERE candidate.file_path = occurrence.file_path
        AND candidate.source_hash = occurrence.source_hash
    )`);
  }
  const where = ` WHERE ${conditions.join(" AND ")}`;
  const from = `
    FROM fate_extra_compact_occurrence AS occurrence
    JOIN fate_extra_compact_source AS compact_source
      ON compact_source.source_hash = occurrence.source_hash
    JOIN items AS item ON item.id = compact_source.compact_item_id
    LEFT JOIN fate_extra_text_occurrence AS text_occurrence
      ON text_occurrence.item_id = item.id
  `;
  const total_row = input.includeTotal
    ? db.prepare(`SELECT COUNT(*) AS count ${from}${where}`).get(...parameters)
    : undefined;
  const order_by =
    input.filePath === ""
      ? "occurrence.original_item_id"
      : "occurrence.row_number, occurrence.original_item_id";
  const rows = db
    .prepare(`
      SELECT
        occurrence.original_item_id,
        occurrence.file_path AS occurrence_file_path,
        occurrence.row_number AS occurrence_row_number,
        occurrence.resource_path,
        occurrence.char_offset,
        occurrence.original_prefix,
        occurrence.source_line_numbers,
        occurrence.pass_through,
        occurrence.display_mode AS occurrence_display_mode,
        occurrence.safety_category,
        occurrence.slot_capacity,
        occurrence.allow_overlength,
        occurrence.original_machine_translation,
        compact_source.source,
        compact_source.occurrence_count,
        compact_source.compact_item_id,
        text_occurrence.unit_id,
        item.data
      ${from}${where}
      ORDER BY ${order_by}
      LIMIT ? OFFSET ?
    `)
    .all(...parameters, safe_limit(input.limit), safe_offset(input.offset))
    .map(project_compact_row);
  const file_rows = input.includeFiles ? read_compact_file_rows(db) : [];
  return {
    ...as_record(page_result(rows, total_row, file_rows, input.viewMode)),
    review_scope: "unit",
    compact_route_projection: true,
  } as DatabaseJsonValue;
}

function read_unique_page(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
): DatabaseJsonValue {
  const conditions: string[] = [];
  const parameters: QueryValue[] = [];
  if (input.filePath !== "") {
    conditions.push(`EXISTS (
      SELECT 1
      FROM fate_extra_preview_search_item AS filtered_item
      JOIN fate_extra_preview_search_mapping AS mapping
        ON mapping.generation = filtered_item.generation
        AND mapping.item_id = filtered_item.item_id
      JOIN fate_extra_preview_search_document AS document
        ON document.generation = mapping.generation
        AND document.document_id = mapping.document_id
      WHERE filtered_item.generation = ?
        AND filtered_item.unit_id = unit.unit_id
        AND mapping.field = 'file-exact'
        AND document.search_text = ?
    )`);
    parameters.push(generation, input.filePath);
  }
  if (input.category !== "") {
    conditions.push(`EXISTS (
      SELECT 1
      FROM fate_extra_preview_search_item AS filtered_item
      WHERE filtered_item.generation = ?
        AND filtered_item.unit_id = unit.unit_id
        AND filtered_item.category = ?
    )`);
    parameters.push(generation, input.category);
  }
  if (input.search !== "") {
    const filter = build_search_filter(
      input.search,
      "unit.unit_id",
      generation,
      "search_item.unit_id",
    );
    conditions.push(filter.sql);
    parameters.push(...filter.parameters);
  }
  const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
  const total_row = input.includeTotal
    ? db
        .prepare(`SELECT COUNT(*) AS count FROM fate_extra_text_unit AS unit${where}`)
        .get(...parameters)
    : undefined;
  const rows = db
    .prepare(`
      SELECT unit.unit_id, unit.occurrence_count, item.id, item.data
      FROM fate_extra_text_unit AS unit
      JOIN items AS item ON item.id = unit.representative_item_id
      ${where}
      ORDER BY unit.representative_item_id
      LIMIT ? OFFSET ?
    `)
    .all(...parameters, safe_limit(input.limit), safe_offset(input.offset))
    .map((row) => ({
      ...as_record(parse_json(row["data"])),
      id: row_number(row, "id"),
      fe_text_unit_id: row_number(row, "unit_id"),
      fe_occurrence_count: row_number(row, "occurrence_count"),
    }));
  const file_rows = input.includeFiles
    ? db
        .prepare(`
          SELECT file_path, occurrence_count AS count
          FROM fate_extra_file_summary
          ORDER BY first_item_id
          LIMIT 200
        `)
        .all()
    : [];
  return {
    ...as_record(page_result(rows, total_row, file_rows, "unique")),
    review_scope: "unit",
  } as DatabaseJsonValue;
}

function build_search_filter(
  search: string,
  target_expression: string,
  generation: number,
  candidate_expression = "search_item.item_id",
  field_condition = "search_mapping.field <> 'file-exact'",
): { sql: string; parameters: QueryValue[] } {
  const matched = build_fate_extra_preview_matched_document_query(search, generation);
  const candidate_from = `
    FROM matched_document
    CROSS JOIN fate_extra_preview_search_mapping AS search_mapping
      INDEXED BY idx_fate_extra_preview_search_item_document
    JOIN fate_extra_preview_search_item AS search_item
      ON search_item.generation = search_mapping.generation
      AND search_item.item_id = search_mapping.item_id
    WHERE search_mapping.generation = ?
      AND search_mapping.document_id = matched_document.document_id
      AND ${field_condition}
  `;
  return {
    sql: `${target_expression} IN (
      WITH matched_document(document_id, field) AS MATERIALIZED (
        ${matched.sql}
      )
      SELECT ${candidate_expression}
      ${candidate_from}
    )`,
    parameters: [...matched.parameters, generation],
  };
}

/** 生产查询与查询计划基准共享同一候选 SQL，避免基准悄悄测量旧实现。 */
export function build_fate_extra_preview_matched_document_query(
  search: string,
  generation: number,
): { sql: string; parameters: QueryValue[] } {
  const normalized = normalize_fate_extra_preview_search_text(search);
  if (fate_extra_preview_search_length(normalized) <= 2) {
    return {
      sql: `
        SELECT short_gram.document_id, search_document.field
        FROM fate_extra_preview_search_short_gram AS short_gram
        JOIN fate_extra_preview_search_document AS search_document
          ON search_document.document_id = short_gram.document_id
          AND search_document.generation = short_gram.generation
        WHERE short_gram.generation = ?
          AND short_gram.gram = ?
          AND search_document.field <> 'file-exact'
          AND INSTR(search_document.search_text, ?) > 0
      `,
      parameters: [generation, normalized, normalized],
    };
  }
  return {
    sql: `
      WITH fts_hit(document_id) AS MATERIALIZED (
        SELECT rowid
        FROM fate_extra_preview_search_fts
        WHERE search_text MATCH ?
      )
      SELECT search_document.document_id, search_document.field
      FROM fts_hit
      CROSS JOIN fate_extra_preview_search_document AS search_document
      WHERE search_document.document_id = fts_hit.document_id
        AND search_document.generation = ?
        AND search_document.field <> 'file-exact'
        AND INSTR(search_document.search_text, ?) > 0
    `,
    parameters: [build_fate_extra_preview_search_match_query(normalized), generation, normalized],
  };
}

function build_compact_search_filter(
  search: string,
  generation: number,
): { sql: string; parameters: QueryValue[] } {
  return build_search_filter(
    search,
    "occurrence.original_item_id",
    generation,
    "search_mapping.occurrence_id",
  );
}

function project_compact_row(row: DatabaseRow): DatabaseRow {
  const item = as_record(parse_json(row["data"]));
  const occurrence_translation = row_text(row, "original_machine_translation");
  if (occurrence_translation !== "") item["dst"] = occurrence_translation;
  const extra_field = as_record(item["extra_field"]);
  const metadata = as_record(extra_field["__linguagacha_fe_v1"]);
  const classification = as_record(metadata["classification"]);
  metadata["path"] = row_text(row, "resource_path");
  metadata["char_offset"] = row_number(row, "char_offset");
  metadata["original_prefix"] = row_text(row, "original_prefix");
  metadata["source_line_numbers"] = parse_json(row["source_line_numbers"]);
  metadata["pass_through"] = parse_json(row["pass_through"]);
  metadata["display_mode"] = row_text(row, "occurrence_display_mode");
  classification["category"] = row_text(row, "safety_category");
  classification["slot_capacity"] = row_number(row, "slot_capacity");
  classification["allow_overlength"] = row_number(row, "allow_overlength") === 1;
  metadata["classification"] = classification;
  extra_field["__linguagacha_fe_v1"] = metadata;
  return {
    ...item,
    id: row_number(row, "compact_item_id"),
    src: row_text(row, "source"),
    file_path: row_text(row, "occurrence_file_path"),
    row: row_number(row, "occurrence_row_number"),
    extra_field,
    fe_text_unit_id: row_number(row, "unit_id"),
    fe_occurrence_count: row_number(row, "occurrence_count"),
    fe_physical_occurrence_id: row_number(row, "original_item_id"),
  };
}

function read_compact_file_rows(db: DatabaseSync): DatabaseRow[] {
  return db
    .prepare(`
      SELECT
        occurrence.file_path,
        CASE WHEN occurrence.file_path = ?
          THEN COUNT(DISTINCT occurrence.source_hash)
          ELSE COUNT(*)
        END AS count,
        MIN(occurrence.original_item_id) AS first_item_id
      FROM fate_extra_compact_occurrence AS occurrence
      JOIN fate_extra_compact_source AS compact_source
        ON compact_source.source_hash = occurrence.source_hash
      WHERE compact_source.excluded_reason = ''
      GROUP BY occurrence.file_path
      ORDER BY first_item_id
      LIMIT 200
    `)
    .all(FATE_EXTRA_SUPPLEMENT_FILE) as DatabaseRow[];
}

function page_result(
  rows: DatabaseRow[],
  total_row: DatabaseRow | undefined,
  file_rows: DatabaseRow[],
  view_mode: "unique" | "occurrence",
): DatabaseJsonValue {
  return {
    total: total_row === undefined ? -1 : row_number(total_row, "count"),
    items: rows as DatabaseJsonValue,
    files: file_rows.map((row) => row_text(row, "file_path")),
    file_counts: Object.fromEntries(
      file_rows.map((row) => [row_text(row, "file_path"), row_number(row, "count")]),
    ),
    view_mode,
  };
}

function safe_offset(value: number): number {
  return Math.max(0, Math.trunc(value));
}

function safe_limit(value: number): number {
  return Math.max(1, Math.min(2_000, Math.trunc(value)));
}

function parse_json(value: unknown): DatabaseJsonValue {
  return typeof value === "string" ? JsonTool.parseStrict<DatabaseJsonValue>(value) : null;
}

function as_record(value: unknown): DatabaseRow {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as DatabaseRow)
    : {};
}

function row_text(row: DatabaseRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : String(value ?? "");
}

function row_number(row: DatabaseRow, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number(value ?? 0);
}
