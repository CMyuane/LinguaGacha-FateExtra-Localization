import { DatabaseSync } from "node:sqlite";

import {
  FATE_EXTRA_SUPPLEMENT_FILE,
  read_fate_extra_item_metadata,
  resolve_fate_extra_compact_machine_translation,
} from "../../shared/fate-extra/fate-extra-types";
import {
  has_fate_extra_preview_warning,
  is_fate_extra_preview_warning_code,
  type FateExtraPreviewWarningCode,
} from "../../shared/fate-extra/fate-extra-warning";
import { JsonTool } from "../../shared/utils/json-tool";
import type { DatabaseJsonValue } from "./database-types";
import { read_fate_extra_preview_navigation_state } from "./fate-extra-preview-navigation-index";
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
  position: number;
  limit: number;
  includeFiles: boolean;
  includeTotal: boolean;
  viewMode: "unique" | "occurrence";
  expectedGeneration: number;
  expectedItemsRevision: number;
  expectedNavigationGeneration: number;
  expectedNavigationRevision: number;
};

let persistent_readonly_connection: {
  project_path: string;
  project_epoch: number;
  db: DatabaseSync;
} | null = null;

/**
 * 预览 worker 的真正只读边界。readOnly + query_only 保证它既不迁移 schema，
 * 也不能通过意外 SQL 修改工程；同一 read transaction 固定 generation/revision 快照。
 */
export function query_fate_extra_preview_readonly(
  input: FateExtraPreviewReadonlyQuery,
): DatabaseJsonValue {
  const persistent = input.projectEpoch !== undefined;
  const db = persistent
    ? read_persistent_connection(input)
    : open_readonly_connection(input.projectPath);
  try {
    db.exec("BEGIN");
    const state = read_fate_extra_preview_search_index_state(db);
    const navigation = read_fate_extra_preview_navigation_state(db);
    assert_query_identity(state, navigation, input);
    const page = read_preview_page(db, input, state.generation, navigation.generation);
    const final_state = read_fate_extra_preview_search_index_state(db);
    const final_navigation = read_fate_extra_preview_navigation_state(db);
    assert_query_identity(final_state, final_navigation, input);
    db.exec("COMMIT");
    return {
      ...as_record(page),
      index_generation: state.generation,
      navigation_generation: navigation.generation,
      applied_items_revision: query_requires_index(input)
        ? state.indexed_items_revision
        : state.items_revision,
      applied_navigation_revision: navigation.indexed_items_revision,
    } as DatabaseJsonValue;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // BEGIN 之前失败时没有事务可回滚，关闭只读句柄即可。
    }
    if (persistent) close_persistent_connection();
    throw error;
  } finally {
    if (!persistent) db.close();
  }
}

function open_readonly_connection(project_path: string): DatabaseSync {
  const db = new DatabaseSync(project_path, { readOnly: true });
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
  return db;
}

function read_persistent_connection(input: FateExtraPreviewReadonlyQuery): DatabaseSync {
  const project_epoch = Math.trunc(input.projectEpoch ?? 0);
  if (
    persistent_readonly_connection !== null &&
    (persistent_readonly_connection.project_path !== input.projectPath ||
      persistent_readonly_connection.project_epoch !== project_epoch)
  ) {
    close_persistent_connection();
  }
  if (persistent_readonly_connection === null) {
    persistent_readonly_connection = {
      project_path: input.projectPath,
      project_epoch,
      db: open_readonly_connection(input.projectPath),
    };
  }
  return persistent_readonly_connection.db;
}

function close_persistent_connection(): void {
  const connection = persistent_readonly_connection;
  persistent_readonly_connection = null;
  connection?.db.close();
}

function assert_query_identity(
  state: ReturnType<typeof read_fate_extra_preview_search_index_state>,
  navigation: ReturnType<typeof read_fate_extra_preview_navigation_state>,
  input: FateExtraPreviewReadonlyQuery,
): void {
  const search_matches = query_requires_index(input)
    ? state.ready &&
      state.generation === Math.trunc(input.expectedGeneration) &&
      state.indexed_items_revision === Math.trunc(input.expectedItemsRevision)
    : state.items_revision === Math.trunc(input.expectedItemsRevision);
  const navigation_matches =
    navigation.ready &&
    navigation.generation === Math.trunc(input.expectedNavigationGeneration) &&
    navigation.indexed_items_revision === Math.trunc(input.expectedNavigationRevision);
  if (!search_matches || !navigation_matches) {
    throw new Error("fate_extra_preview_query_identity_changed");
  }
}

function query_requires_index(input: FateExtraPreviewReadonlyQuery): boolean {
  return input.search !== "" || input.category !== "";
}

function read_preview_page(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  search_generation: number,
  navigation_generation: number,
): DatabaseJsonValue {
  const compact = read_compact_enabled(db);
  const warning = input.warning ?? "";
  if (is_fate_extra_preview_warning_code(warning)) {
    return read_warning_filtered_page(
      db,
      input,
      search_generation,
      navigation_generation,
      warning,
      compact,
    );
  }
  if (input.search !== "" || input.category !== "") {
    return read_index_filtered_page(db, input, search_generation, navigation_generation, compact);
  }
  return read_navigation_page(db, input, navigation_generation, compact);
}

const WARNING_SCAN_BATCH_SIZE = 2_000;

type WarningUnitMatch = {
  unit_id: number;
  representative_item_id: number;
  occurrence_count: number;
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
  search_generation: number,
  navigation_generation: number,
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
  const position = safe_position(input.position);
  const limit = safe_limit(input.limit);
  const cache_key = build_warning_cache_key(
    input,
    search_generation,
    navigation_generation,
    warning,
    compact,
  );
  let index = warning_match_cache?.key === cache_key ? warning_match_cache.index : null;
  if (index === null) {
    index = unique_scope
      ? scan_unique_warning_index(
          db,
          input,
          search_generation,
          navigation_generation,
          warning,
          compact,
          measure_encoded_bytes,
        )
      : scan_occurrence_warning_index(
          db,
          input,
          search_generation,
          warning,
          compact,
          measure_encoded_bytes,
        );
    warning_match_cache = { key: cache_key, index };
  }
  const total = "units" in index ? index.units.length : index.ids.length;
  const rows = hydrate_warning_page(db, index, position, limit).map((row) => ({
    ...row,
    fe_warning_codes: [warning],
  }));
  const file_rows = input.includeFiles
    ? compact
      ? read_navigation_file_rows(db, navigation_generation, input.viewMode, true)
      : read_navigation_file_rows(db, navigation_generation, input.viewMode, false)
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
  const conditions = ["COALESCE(json_extract(item.data, '$.status'), '') <> 'EXCLUDED'"];
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
  const conditions = [
    "compact_source.excluded_reason = ''",
    "COALESCE(json_extract(item.data, '$.status'), '') <> 'EXCLUDED'",
  ];
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
  search_generation: number,
  navigation_generation: number,
  warning: FateExtraPreviewWarningCode,
  compact: boolean,
  measure_encoded_bytes: (text: string) => number,
): WarningMatchIndex {
  const unit_conditions: string[] = [];
  const unit_parameters: QueryValue[] = [];
  append_unique_index_conditions(unit_conditions, unit_parameters, input, search_generation);
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
              unit.item_id AS representative_item_id,
              unit.occurrence_count,
              unit.position AS unit_position,
              ${compact_occurrence_select_columns_sql()}
            FROM fate_extra_preview_navigation_occurrence AS visible_occurrence
            JOIN fate_extra_compact_occurrence AS occurrence
              ON occurrence.original_item_id = visible_occurrence.occurrence_id
            JOIN fate_extra_compact_source AS compact_source
              ON compact_source.source_hash = occurrence.source_hash
            JOIN items AS item ON item.id = compact_source.compact_item_id
            JOIN fate_extra_text_occurrence AS text_occurrence
              ON text_occurrence.item_id = item.id
            JOIN fate_extra_preview_navigation_unit AS unit
              ON unit.generation = visible_occurrence.generation
              AND unit.unit_id = text_occurrence.unit_id
            WHERE visible_occurrence.generation = ?
              AND occurrence.original_item_id > ?${candidate_unit_where}
            ORDER BY occurrence.original_item_id
            LIMIT ?
          `)
          .all(
            navigation_generation,
            after_occurrence_id,
            ...unit_parameters,
            WARNING_SCAN_BATCH_SIZE,
          )
      : db
          .prepare(`
            SELECT
              unit.unit_id AS candidate_unit_id,
              unit.item_id AS representative_item_id,
              unit.occurrence_count,
              unit.position AS unit_position,
              item.id,
              item.data
            FROM fate_extra_preview_navigation_occurrence AS visible_occurrence
            JOIN items AS item ON item.id = visible_occurrence.item_id
            JOIN fate_extra_preview_navigation_unit AS unit
              ON unit.generation = visible_occurrence.generation
              AND unit.unit_id = visible_occurrence.unit_id
            WHERE visible_occurrence.generation = ?
              AND item.id > ?${candidate_unit_where}
            ORDER BY item.id
            LIMIT ?
          `)
          .all(
            navigation_generation,
            after_occurrence_id,
            ...unit_parameters,
            WARNING_SCAN_BATCH_SIZE,
          );
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
        representative_item_id: row_number(raw, "representative_item_id"),
        occurrence_count: row_number(raw, "occurrence_count"),
        physical_occurrence_id: physical_id,
        order_id: row_number(raw, "unit_position"),
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
  search_generation: number,
  navigation_generation: number,
  warning: FateExtraPreviewWarningCode,
  compact: boolean,
): string {
  return JSON.stringify([
    input.projectPath,
    input.projectEpoch ?? 0,
    input.expectedItemsRevision,
    search_generation,
    navigation_generation,
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
    const read = db.prepare("SELECT id, data FROM items WHERE id = ?");
    return index.units.slice(offset, offset + limit).flatMap((match) => {
      const raw = read.get(match.representative_item_id);
      return raw === undefined
        ? []
        : [
            {
              ...as_record(parse_json(raw["data"])),
              id: row_number(raw, "id"),
              fe_text_unit_id: match.unit_id,
              fe_occurrence_count: match.occurrence_count,
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
    const filter = build_fate_extra_preview_search_filter(
      input.search,
      item_expression,
      generation,
    );
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
    const filter = build_fate_extra_preview_search_filter(
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

/** 保存回执只投影一个已验证的物理位置，不扫描或加载页面集合。 */
export function read_fate_extra_preview_occurrence(
  db: DatabaseSync,
  occurrence_id: number,
): DatabaseJsonValue {
  if (read_compact_enabled(db)) {
    const row = db
      .prepare(`${compact_occurrence_select_sql()} WHERE occurrence.original_item_id = ?`)
      .get(occurrence_id);
    return row === undefined ? null : (project_compact_row(row) as DatabaseJsonValue);
  }
  const row = db
    .prepare(`
    SELECT item.id, item.data, occurrence.unit_id, unit.occurrence_count
    FROM items AS item LEFT JOIN fate_extra_text_occurrence AS occurrence ON occurrence.item_id = item.id
    LEFT JOIN fate_extra_text_unit AS unit ON unit.unit_id = occurrence.unit_id
    WHERE item.id = ?
  `)
    .get(occurrence_id);
  return row === undefined ? null : (project_navigation_unit_row(row) as DatabaseJsonValue);
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
    compact_source.representative_translation_authoritative,
    text_occurrence.unit_id,
    item.data
  `;
}

function read_navigation_page(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
  compact: boolean,
): DatabaseJsonValue {
  const position = safe_position(input.position);
  const limit = safe_limit(input.limit);
  const compact_file_uses_occurrences =
    compact && input.filePath !== "" && input.filePath !== FATE_EXTRA_SUPPLEMENT_FILE;
  const unique_scope = input.viewMode === "unique" && !compact_file_uses_occurrences;
  const rows = unique_scope
    ? read_navigation_unit_page(db, input, generation, compact, position, limit)
    : read_navigation_occurrence_page(db, input, generation, compact, position, limit);
  const total = read_navigation_total(db, input, generation, compact, unique_scope);
  const file_rows = input.includeFiles
    ? read_navigation_file_rows(db, generation, input.viewMode, compact)
    : [];
  return {
    ...as_record(page_result(rows, { count: total }, file_rows, input.viewMode)),
    review_scope: unique_scope ? "unit" : input.viewMode === "unique" ? "unit" : "occurrence",
    ...(compact && !unique_scope ? { compact_route_projection: true } : {}),
  } as DatabaseJsonValue;
}

function read_navigation_occurrence_page(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
  compact: boolean,
  position: number,
  limit: number,
): DatabaseRow[] {
  const position_column = input.filePath === "" ? "global_position" : "file_position";
  const file_condition = input.filePath === "" ? "" : " AND navigation.file_path = ?";
  const parameters: QueryValue[] =
    input.filePath === ""
      ? [generation, position, limit]
      : [generation, input.filePath, position, limit];
  if (!compact) {
    return db
      .prepare(`
        SELECT item.id, item.data
        FROM fate_extra_preview_navigation_occurrence AS navigation
        JOIN items AS item ON item.id = navigation.item_id
        WHERE navigation.generation = ?${file_condition}
          AND navigation.${position_column} >= ?
        ORDER BY navigation.${position_column}
        LIMIT ?
      `)
      .all(...parameters)
      .map((row) => ({ ...as_record(parse_json(row["data"])), id: row_number(row, "id") }));
  }
  return db
    .prepare(`
      SELECT ${compact_occurrence_select_columns_sql()}
      FROM fate_extra_preview_navigation_occurrence AS navigation
      JOIN fate_extra_compact_occurrence AS occurrence
        ON occurrence.original_item_id = navigation.occurrence_id
      JOIN fate_extra_compact_source AS compact_source
        ON compact_source.source_hash = occurrence.source_hash
      JOIN items AS item ON item.id = compact_source.compact_item_id
      LEFT JOIN fate_extra_text_occurrence AS text_occurrence
        ON text_occurrence.item_id = item.id
      WHERE navigation.generation = ?${file_condition}
        AND navigation.${position_column} >= ?
      ORDER BY navigation.${position_column}
      LIMIT ?
    `)
    .all(...parameters)
    .map(project_compact_row);
}

function read_navigation_unit_page(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
  compact: boolean,
  position: number,
  limit: number,
): DatabaseRow[] {
  if (input.filePath === "") {
    if (compact) {
      return db
        .prepare(`
          SELECT ${compact_occurrence_select_columns_sql()}
          FROM fate_extra_preview_navigation_unit AS navigation
          JOIN fate_extra_preview_navigation_occurrence AS first_occurrence
            ON first_occurrence.generation = navigation.generation
            AND first_occurrence.unit_id = navigation.unit_id
            AND first_occurrence.occurrence_id = (
              SELECT MIN(candidate.occurrence_id)
              FROM fate_extra_preview_navigation_occurrence AS candidate
              WHERE candidate.generation = navigation.generation
                AND candidate.unit_id = navigation.unit_id
            )
          JOIN fate_extra_compact_occurrence AS occurrence
            ON occurrence.original_item_id = first_occurrence.occurrence_id
          JOIN fate_extra_compact_source AS compact_source
            ON compact_source.source_hash = occurrence.source_hash
          JOIN items AS item ON item.id = compact_source.compact_item_id
          LEFT JOIN fate_extra_text_occurrence AS text_occurrence
            ON text_occurrence.item_id = item.id
          WHERE navigation.generation = ? AND navigation.position >= ?
          ORDER BY navigation.position
          LIMIT ?
        `)
        .all(generation, position, limit)
        .map(project_compact_row);
    }
    return db
      .prepare(`
        SELECT navigation.unit_id, navigation.occurrence_count, item.id, item.data
        FROM fate_extra_preview_navigation_unit AS navigation
        JOIN items AS item ON item.id = navigation.item_id
        WHERE navigation.generation = ? AND navigation.position >= ?
        ORDER BY navigation.position
        LIMIT ?
      `)
      .all(generation, position, limit)
      .map(project_navigation_unit_row);
  }
  if (!compact) {
    return db
      .prepare(`
        SELECT navigation.unit_id, unit.occurrence_count, item.id, item.data
        FROM fate_extra_preview_navigation_unit_file AS navigation
        JOIN fate_extra_text_unit AS unit ON unit.unit_id = navigation.unit_id
        JOIN items AS item ON item.id = navigation.item_id
        WHERE navigation.generation = ? AND navigation.file_path = ?
          AND navigation.position >= ?
        ORDER BY navigation.position
        LIMIT ?
      `)
      .all(generation, input.filePath, position, limit)
      .map(project_navigation_unit_row);
  }
  return db
    .prepare(`
      SELECT ${compact_occurrence_select_columns_sql()}
      FROM fate_extra_preview_navigation_unit_file AS navigation
      JOIN fate_extra_compact_occurrence AS occurrence
        ON occurrence.original_item_id = navigation.occurrence_id
      JOIN fate_extra_compact_source AS compact_source
        ON compact_source.source_hash = occurrence.source_hash
      JOIN items AS item ON item.id = compact_source.compact_item_id
      LEFT JOIN fate_extra_text_occurrence AS text_occurrence
        ON text_occurrence.item_id = item.id
      WHERE navigation.generation = ? AND navigation.file_path = ?
        AND navigation.position >= ?
      ORDER BY navigation.position
      LIMIT ?
    `)
    .all(generation, input.filePath, position, limit)
    .map(project_compact_row);
}

function project_navigation_unit_row(row: DatabaseRow): DatabaseRow {
  return {
    ...as_record(parse_json(row["data"])),
    id: row_number(row, "id"),
    fe_text_unit_id: row_number(row, "unit_id"),
    fe_occurrence_count: row_number(row, "occurrence_count"),
  };
}

function read_navigation_total(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  generation: number,
  compact: boolean,
  unique_scope: boolean,
): number {
  if (input.filePath === "") {
    const key = unique_scope ? "unique_count" : "occurrence_count";
    return row_number(
      db
        .prepare(`SELECT ${key} FROM fate_extra_preview_navigation_generation WHERE generation = ?`)
        .get(generation) ?? {},
      key,
    );
  }
  const row =
    db
      .prepare(`
        SELECT unique_count, occurrence_count
        FROM fate_extra_preview_navigation_file_summary
        WHERE generation = ? AND file_path = ?
      `)
      .get(generation, input.filePath) ?? {};
  const use_unique = unique_scope && (!compact || input.filePath === FATE_EXTRA_SUPPLEMENT_FILE);
  return row_number(row, use_unique ? "unique_count" : "occurrence_count");
}

type FilteredMatchIndex = WarningMatchIndex;

let filtered_match_cache: { key: string; index: FilteredMatchIndex } | null = null;

function read_index_filtered_page(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  search_generation: number,
  navigation_generation: number,
  compact: boolean,
): DatabaseJsonValue {
  const compact_file_uses_occurrences =
    compact && input.filePath !== "" && input.filePath !== FATE_EXTRA_SUPPLEMENT_FILE;
  const unique_scope = input.viewMode === "unique" && !compact_file_uses_occurrences;
  const key = JSON.stringify([
    input.projectPath,
    input.projectEpoch ?? 0,
    input.expectedItemsRevision,
    search_generation,
    navigation_generation,
    compact,
    input.viewMode,
    input.search,
    input.filePath,
    input.category,
  ]);
  let index = filtered_match_cache?.key === key ? filtered_match_cache.index : null;
  if (index === null) {
    index = unique_scope
      ? scan_navigation_unit_matches(db, input, search_generation, navigation_generation, compact)
      : scan_navigation_occurrence_matches(
          db,
          input,
          search_generation,
          navigation_generation,
          compact,
        );
    filtered_match_cache = { key, index };
  }
  const total = "units" in index ? index.units.length : index.ids.length;
  const rows = hydrate_warning_page(
    db,
    index,
    safe_position(input.position),
    safe_limit(input.limit),
  );
  const file_rows = input.includeFiles
    ? read_navigation_file_rows(db, navigation_generation, input.viewMode, compact)
    : [];
  return {
    ...as_record(page_result(rows, { count: total }, file_rows, input.viewMode)),
    review_scope: unique_scope ? "unit" : input.viewMode === "unique" ? "unit" : "occurrence",
    ...(compact && !unique_scope ? { compact_route_projection: true } : {}),
  } as DatabaseJsonValue;
}

function scan_navigation_occurrence_matches(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  search_generation: number,
  navigation_generation: number,
  compact: boolean,
): FilteredMatchIndex {
  const conditions = ["navigation.generation = ?"];
  const parameters: QueryValue[] = [navigation_generation];
  if (input.filePath !== "") {
    conditions.push("navigation.file_path = ?");
    parameters.push(input.filePath);
  }
  if (input.category !== "") {
    conditions.push(
      compact
        ? "occurrence.safety_category = ?"
        : `navigation.item_id IN (
            SELECT item_id FROM fate_extra_preview_search_item
            WHERE generation = ? AND category = ?
          )`,
    );
    if (!compact) parameters.push(search_generation);
    parameters.push(input.category);
  }
  if (input.search !== "") {
    const filter = compact
      ? build_compact_search_filter(input.search, search_generation)
      : build_fate_extra_preview_search_filter(
          input.search,
          "navigation.item_id",
          search_generation,
        );
    conditions.push(filter.sql);
    parameters.push(...filter.parameters);
  }
  const order_by =
    input.filePath === "" ? "navigation.global_position" : "navigation.file_position";
  const rows = db
    .prepare(`
      SELECT navigation.occurrence_id
      FROM fate_extra_preview_navigation_occurrence AS navigation
      ${
        compact
          ? "JOIN fate_extra_compact_occurrence AS occurrence ON occurrence.original_item_id = navigation.occurrence_id"
          : ""
      }
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${order_by}
    `)
    .all(...parameters);
  return {
    kind: compact ? "compact-occurrence" : "normal-occurrence",
    ids: rows.map((row) => row_number(row, "occurrence_id")),
  };
}

function scan_navigation_unit_matches(
  db: DatabaseSync,
  input: FateExtraPreviewReadonlyQuery,
  search_generation: number,
  navigation_generation: number,
  compact: boolean,
): FilteredMatchIndex {
  if (compact && input.filePath === FATE_EXTRA_SUPPLEMENT_FILE) {
    const conditions = ["navigation.generation = ?", "navigation.file_path = ?"];
    const parameters: QueryValue[] = [navigation_generation, input.filePath];
    if (input.category !== "") {
      conditions.push("occurrence.safety_category = ?");
      parameters.push(input.category);
    }
    if (input.search !== "") {
      const filter = build_compact_search_filter(input.search, search_generation);
      conditions.push(filter.sql);
      parameters.push(...filter.parameters);
    }
    return {
      kind: "compact-unique",
      units: db
        .prepare(`
          SELECT navigation.unit_id, unit.item_id AS representative_item_id,
            unit.occurrence_count,
            navigation.occurrence_id AS physical_occurrence_id,
            navigation.position AS order_id
          FROM fate_extra_preview_navigation_unit_file AS navigation
          JOIN fate_extra_compact_occurrence AS occurrence
            ON occurrence.original_item_id = navigation.occurrence_id
          JOIN fate_extra_preview_navigation_unit AS unit
            ON unit.generation = navigation.generation
            AND unit.unit_id = navigation.unit_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY navigation.position
        `)
        .all(...parameters)
        .map((row) => ({
          unit_id: row_number(row, "unit_id"),
          representative_item_id: row_number(row, "representative_item_id"),
          occurrence_count: row_number(row, "occurrence_count"),
          physical_occurrence_id: row_number(row, "physical_occurrence_id"),
          order_id: row_number(row, "order_id"),
        })),
    };
  }
  const conditions = ["navigation.generation = ?"];
  const parameters: QueryValue[] = [navigation_generation];
  if (input.filePath !== "") {
    conditions.push(`EXISTS (
      SELECT 1 FROM fate_extra_preview_navigation_unit_file AS unit_file
      WHERE unit_file.generation = navigation.generation
        AND unit_file.file_path = ? AND unit_file.unit_id = navigation.unit_id
    )`);
    parameters.push(input.filePath);
  }
  if (input.category !== "") {
    conditions.push(`EXISTS (
      SELECT 1 FROM fate_extra_preview_search_item AS search_item
      WHERE search_item.generation = ? AND search_item.unit_id = navigation.unit_id
        AND search_item.category = ?
    )`);
    parameters.push(search_generation, input.category);
  }
  if (input.search !== "") {
    const filter = build_fate_extra_preview_search_filter(
      input.search,
      "navigation.unit_id",
      search_generation,
      "search_item.unit_id",
    );
    conditions.push(filter.sql);
    parameters.push(...filter.parameters);
  }
  const rows = db
    .prepare(`
      SELECT navigation.unit_id, navigation.item_id AS representative_item_id,
        navigation.occurrence_count,
        (SELECT MIN(occurrence.occurrence_id)
         FROM fate_extra_preview_navigation_occurrence AS occurrence
         WHERE occurrence.generation = navigation.generation
           AND occurrence.unit_id = navigation.unit_id) AS physical_occurrence_id,
        navigation.position AS order_id
      FROM fate_extra_preview_navigation_unit AS navigation
      WHERE ${conditions.join(" AND ")}
      ORDER BY navigation.position
    `)
    .all(...parameters);
  return {
    kind: compact ? "compact-unique" : "normal-unique",
    units: rows.map((row) => ({
      unit_id: row_number(row, "unit_id"),
      representative_item_id: row_number(row, "representative_item_id"),
      occurrence_count: row_number(row, "occurrence_count"),
      physical_occurrence_id: compact
        ? row_number(row, "physical_occurrence_id")
        : row_number(row, "representative_item_id"),
      order_id: row_number(row, "order_id"),
    })),
  };
}

export function build_fate_extra_preview_search_filter(
  search: string,
  target_expression: string,
  generation: number,
  candidate_expression = "search_item.item_id",
  field_condition = "search_mapping.field <> 'file-exact'",
): { sql: string; parameters: QueryValue[] } {
  const matched = build_fate_extra_preview_matched_document_query(search, generation);
  // UNION 分支也固定连接顺序，避免 SQLite 把百万 navigation 行置于命中文档之前。
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
      UNION
      SELECT ${candidate_expression === "search_mapping.occurrence_id" ? "navigation.occurrence_id" : candidate_expression}
      FROM matched_document
      CROSS JOIN fate_extra_preview_search_shared_mapping AS search_mapping
        INDEXED BY idx_fate_extra_preview_search_shared_document
      CROSS JOIN fate_extra_preview_search_item AS search_item
        ON search_item.generation = search_mapping.generation AND search_item.item_id = search_mapping.item_id
      ${
        candidate_expression === "search_mapping.occurrence_id"
          ? `CROSS JOIN fate_extra_preview_navigation_occurrence AS navigation
        ON navigation.generation = search_mapping.generation AND navigation.item_id = search_mapping.item_id`
          : ""
      }
      WHERE search_mapping.generation = ? AND search_mapping.document_id = matched_document.document_id
        AND ${field_condition}
    )`,
    parameters: [...matched.parameters, generation, generation],
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
  return build_fate_extra_preview_search_filter(
    search,
    "occurrence.original_item_id",
    generation,
    "search_mapping.occurrence_id",
  );
}

function project_compact_row(row: DatabaseRow): DatabaseRow {
  const item = as_record(parse_json(row["data"]));
  item["dst"] = resolve_fate_extra_compact_machine_translation({
    representativeTranslation: String(item["dst"] ?? ""),
    originalMachineTranslation: row_text(row, "original_machine_translation"),
    representativeTranslationAuthoritative:
      row_number(row, "representative_translation_authoritative") === 1,
  });
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

function read_navigation_file_rows(
  db: DatabaseSync,
  generation: number,
  view_mode: "unique" | "occurrence",
  compact: boolean,
): DatabaseRow[] {
  const count_expression =
    view_mode === "occurrence"
      ? "occurrence_count"
      : compact
        ? `CASE WHEN file_path = ? THEN unique_count ELSE occurrence_count END`
        : "occurrence_count";
  const parameters: QueryValue[] =
    compact && view_mode === "unique" ? [FATE_EXTRA_SUPPLEMENT_FILE] : [];
  return db
    .prepare(`
      SELECT file_path, ${count_expression} AS count, first_occurrence_id AS first_item_id
      FROM fate_extra_preview_navigation_file_summary
      WHERE generation = ?
      ORDER BY first_occurrence_id
      LIMIT 200
    `)
    .all(...parameters, generation) as DatabaseRow[];
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

function safe_position(value: number): number {
  return Math.max(0, Math.trunc(value));
}

function safe_limit(value: number): number {
  return Math.max(1, Math.min(2_000, Math.trunc(value)));
}

function parse_json(value: unknown): DatabaseJsonValue {
  return typeof value === "string" ? JsonTool.parseStrict<DatabaseJsonValue>(value) : null;
}

function read_compact_enabled(db: DatabaseSync): boolean {
  const value = db.prepare("SELECT value FROM meta WHERE key = 'fate_extra.compact.v1'").get()?.[
    "value"
  ];
  if (typeof value !== "string") return false;
  try {
    const parsed = JsonTool.parseStrict<unknown>(value);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as DatabaseRow)["enabled"] === true
    );
  } catch {
    return false;
  }
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
