import { DatabaseSync, type StatementSync } from "node:sqlite";

import { JsonTool } from "../../shared/utils/json-tool";

export const FATE_EXTRA_PREVIEW_SEARCH_ADAPTER_META_KEY = "fate_extra.preview-search.adapter";
export const FATE_EXTRA_PREVIEW_SEARCH_ITEMS_REVISION_META_KEY =
  "fate_extra.preview-search.items-revision";
export const FATE_EXTRA_PREVIEW_SEARCH_GENERATION_META_KEY = "fate_extra.preview-search.generation";
export const FATE_EXTRA_PREVIEW_SEARCH_ITEM_COUNT_META_KEY = "fate_extra.preview-search.item-count";
export const FATE_EXTRA_PREVIEW_SEARCH_DOCUMENT_COUNT_META_KEY =
  "fate_extra.preview-search.document-count";
export const FATE_EXTRA_PREVIEW_SEARCH_SHORT_GRAM_COUNT_META_KEY =
  "fate_extra.preview-search.short-gram-count";
const FATE_EXTRA_TEXT_UNIT_ITEM_COUNT_META_KEY = "fate_extra.text-unit-index.item-count";
const FATE_EXTRA_TEXT_UNIT_UNIT_COUNT_META_KEY = "fate_extra.text-unit-index.unit-count";
const FATE_EXTRA_TEXT_UNIT_FILE_COUNT_META_KEY = "fate_extra.text-unit-index.file-count";

const SEARCH_BUILD_BATCH_SIZE = 5_000;
const SEARCH_COMPACT_BUILD_BATCH_SIZE = 250;
const SEARCH_DOCUMENT_BATCH_SIZE = 1_000;
const SEARCH_CLEANUP_BATCH_SIZE = 500;

type DatabaseRow = Record<string, unknown>;

export type FateExtraPreviewSearchIndexState = {
  ready: boolean;
  generation: number;
  item_count: number;
  indexed_item_count: number;
  document_count: number;
  short_gram_count: number;
  items_revision: number;
  indexed_items_revision: number;
};

export type FateExtraIndexState = {
  ready: boolean;
  item_count: number;
  occurrence_count: number;
  unit_count: number;
  file_count: number;
  text_unit_items_revision: number;
  search_ready: boolean;
  search_generation: number;
  search_document_count: number;
  search_short_gram_count: number;
  search_items_revision: number;
  items_revision: number;
};

export type FateExtraInactiveIndexBuild = {
  generation: number;
  adapter_value: string;
  items_revision: number;
  item_count: number;
  document_count: number;
  short_gram_count: number;
};

type FateExtraIndexSourceIdentity = {
  adapter_value: string;
  compact_value: string | null;
  item_count: number;
  items_revision: number;
};

/**
 * FE 搜索唯一规范化入口。索引和查询都在 JS 使用相同的 Unicode 默认大小写折叠；
 * 不裁剪文本，也不执行 Unicode 归一化。
 */
export function normalize_fate_extra_preview_search_text(value: string): string {
  return value.toLowerCase();
}

/** 读取 active generation 身份；未完成 generation 永远不会被查询视为 ready。 */
export function read_fate_extra_preview_search_index_state(
  db: DatabaseSync,
): FateExtraPreviewSearchIndexState {
  const items_revision = read_json_number_meta(db, "project_runtime_revision.items");
  const generation = read_json_number_meta(db, FATE_EXTRA_PREVIEW_SEARCH_GENERATION_META_KEY);
  const row = db
    .prepare(`
      SELECT adapter_value, items_revision, item_count, document_count, short_gram_count, complete
      FROM fate_extra_preview_search_generation
      WHERE generation = ?
    `)
    .get(generation);
  const indexed_item_count = row === undefined ? 0 : row_number(row, "item_count");
  const indexed_items_revision = row === undefined ? 0 : row_number(row, "items_revision");
  const adapter_value = read_meta_text(db, "fate_extra.adapter.v1");
  return {
    ready:
      generation > 0 &&
      row_number(row ?? {}, "complete") === 1 &&
      indexed_item_count > 0 &&
      adapter_value !== null &&
      adapter_value === row_text(row ?? {}, "adapter_value") &&
      items_revision === indexed_items_revision,
    generation,
    item_count: indexed_item_count,
    indexed_item_count,
    document_count: row === undefined ? 0 : row_number(row, "document_count"),
    short_gram_count: row === undefined ? 0 : row_number(row, "short_gram_count"),
    items_revision,
    indexed_items_revision,
  };
}

/** 读取文本单元和搜索 generation 的统一身份，供主进程和维护 worker 复用。 */
export function read_fate_extra_index_state(db: DatabaseSync): FateExtraIndexState {
  const search = read_fate_extra_preview_search_index_state(db);
  const occurrence_count = read_json_number_meta(db, FATE_EXTRA_TEXT_UNIT_ITEM_COUNT_META_KEY);
  const unit_count = read_json_number_meta(db, FATE_EXTRA_TEXT_UNIT_UNIT_COUNT_META_KEY);
  const file_count = read_json_number_meta(db, FATE_EXTRA_TEXT_UNIT_FILE_COUNT_META_KEY);
  const adapter_value = read_meta_text(db, "fate_extra.adapter.v1");
  const indexed_adapter_value = read_meta_text(db, "fate_extra.text-unit-index.adapter");
  const indexed_revision_value = read_meta_text(db, "fate_extra.text-unit-index.items-revision");
  let text_unit_items_revision = -1;
  if (indexed_revision_value !== null) {
    try {
      text_unit_items_revision = Number(JsonTool.parseStrict<unknown>(indexed_revision_value));
    } catch {
      text_unit_items_revision = -1;
    }
  }
  return {
    ready:
      search.item_count > 0 &&
      search.item_count === occurrence_count &&
      file_count > 0 &&
      adapter_value !== null &&
      adapter_value === indexed_adapter_value &&
      text_unit_items_revision === search.items_revision,
    item_count: search.item_count,
    occurrence_count,
    unit_count,
    file_count,
    text_unit_items_revision,
    search_ready: search.ready,
    search_generation: search.generation,
    search_document_count: search.document_count,
    search_short_gram_count: search.short_gram_count,
    search_items_revision: search.indexed_items_revision,
    items_revision: search.items_revision,
  };
}

function rebuild_fate_extra_text_unit_index(db: DatabaseSync, items_revision: number): void {
  db.exec(`
    DELETE FROM fate_extra_text_occurrence;
    DELETE FROM fate_extra_text_unit;
    DELETE FROM fate_extra_file_summary;
    DELETE FROM sqlite_sequence WHERE name = 'fate_extra_text_unit';
    INSERT INTO fate_extra_text_unit (source, representative_item_id, occurrence_count)
    SELECT COALESCE(json_extract(data, '$.src'), ''), MIN(id), COUNT(*)
    FROM items
    GROUP BY COALESCE(json_extract(data, '$.src'), '');
    INSERT INTO fate_extra_text_occurrence (item_id, unit_id)
    SELECT item.id, unit.unit_id
    FROM items AS item
    JOIN fate_extra_text_unit AS unit
      ON unit.source = COALESCE(json_extract(item.data, '$.src'), '');
    INSERT INTO fate_extra_file_summary (file_path, occurrence_count, first_item_id)
    SELECT COALESCE(json_extract(data, '$.file_path'), ''), COUNT(*), MIN(id)
    FROM items
    GROUP BY COALESCE(json_extract(data, '$.file_path'), '');
    INSERT OR REPLACE INTO meta (key, value)
    SELECT 'fate_extra.text-unit-index.adapter', value
    FROM meta
    WHERE key = 'fate_extra.adapter.v1';
  `);
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('fate_extra.text-unit-index.items-revision', ?)",
  ).run(JsonTool.stringifyStrict(items_revision));
  const upsert_meta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  upsert_meta.run(
    FATE_EXTRA_TEXT_UNIT_ITEM_COUNT_META_KEY,
    JsonTool.stringifyStrict(
      scalar_count(db, "SELECT COUNT(*) AS count FROM fate_extra_text_occurrence"),
    ),
  );
  upsert_meta.run(
    FATE_EXTRA_TEXT_UNIT_UNIT_COUNT_META_KEY,
    JsonTool.stringifyStrict(
      scalar_count(db, "SELECT COUNT(*) AS count FROM fate_extra_text_unit"),
    ),
  );
  upsert_meta.run(
    FATE_EXTRA_TEXT_UNIT_FILE_COUNT_META_KEY,
    JsonTool.stringifyStrict(
      scalar_count(db, "SELECT COUNT(*) AS count FROM fate_extra_file_summary"),
    ),
  );
}

/**
 * 索引维护 worker 的数据库落点边界。连接、事务和失败回滚都留在 database 层，
 * worker task 只负责调度，不能直接取得 SQLite 句柄。
 */
export function run_fate_extra_index_maintenance(
  project_path: string,
  expected_items_revision: number,
  report_progress: (completed: number, total: number) => void = () => undefined,
): FateExtraInactiveIndexBuild {
  const db = new DatabaseSync(project_path);
  let generation: number | null = null;
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.function("fate_extra_preview_casefold", { deterministic: true }, (value: unknown) =>
      normalize_fate_extra_preview_search_text(
        typeof value === "string" ? value : String(value ?? ""),
      ),
    );
    const identity = read_index_source_identity(db, expected_items_revision);
    const reserved_generation = next_search_generation(db);
    cleanup_inactive_search_generations(db);

    // 文本单元仍是现有公开接口的派生事实。它保留一次有界的集合 SQL 事务，
    // 但不再把后续逐页搜索 generation 构建包含在同一个写租约内。
    run_immediate_transaction(db, () => {
      assert_index_source_identity(db, identity);
      rebuild_fate_extra_text_unit_index(db, identity.items_revision);
      assert_index_source_identity(db, identity);
    });

    generation = create_inactive_search_generation(db, identity, reserved_generation);
    build_inactive_search_generation(db, generation, identity, report_progress);
    const counts = complete_inactive_search_generation(db, generation, identity);
    return {
      generation,
      adapter_value: identity.adapter_value,
      items_revision: identity.items_revision,
      item_count: identity.item_count,
      ...counts,
    };
  } catch (error) {
    if (generation !== null) {
      try {
        cleanup_search_generation(db, generation);
      } catch (cleanup_error) {
        throw new AggregateError(
          [error, cleanup_error],
          "FE 预览索引构建失败且非活动 generation 清理失败。",
        );
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

/** worker 被硬终止后，由新 worker 清理已经分批提交的非活动 generation。 */
export function cleanup_fate_extra_inactive_preview_search_generations(
  project_path: string,
): number {
  const db = new DatabaseSync(project_path);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return cleanup_inactive_search_generations(db);
  } finally {
    db.close();
  }
}

function read_index_source_identity(
  db: DatabaseSync,
  expected_items_revision: number,
): FateExtraIndexSourceIdentity {
  const items_revision = read_json_number_meta(db, "project_runtime_revision.items");
  if (items_revision !== Math.trunc(expected_items_revision)) {
    throw new Error("fate_extra_preview_index_revision_changed");
  }
  const adapter_value = read_meta_text(db, "fate_extra.adapter.v1");
  if (adapter_value === null) throw new Error("fate_extra_preview_index_adapter_missing");
  return {
    adapter_value,
    compact_value: read_meta_text(db, "fate_extra.compact.v1"),
    item_count: scalar_count(db, "SELECT COUNT(*) AS count FROM items"),
    items_revision,
  };
}

function assert_index_source_identity(
  db: DatabaseSync,
  expected: FateExtraIndexSourceIdentity,
): void {
  if (
    read_json_number_meta(db, "project_runtime_revision.items") !== expected.items_revision ||
    read_meta_text(db, "fate_extra.adapter.v1") !== expected.adapter_value ||
    read_meta_text(db, "fate_extra.compact.v1") !== expected.compact_value ||
    scalar_count(db, "SELECT COUNT(*) AS count FROM items") !== expected.item_count
  ) {
    throw new Error("fate_extra_preview_index_identity_changed");
  }
}

function create_inactive_search_generation(
  db: DatabaseSync,
  identity: FateExtraIndexSourceIdentity,
  reserved_generation: number,
): number {
  return run_immediate_transaction(db, () => {
    assert_index_source_identity(db, identity);
    const generation = Math.max(
      reserved_generation,
      row_number(
        db
          .prepare(
            "SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM fate_extra_preview_search_generation",
          )
          .get() ?? {},
        "generation",
      ),
    );
    db.prepare(`
      INSERT INTO fate_extra_preview_search_generation (
        generation, adapter_value, items_revision, item_count,
        document_count, short_gram_count, complete
      ) VALUES (?, ?, ?, ?, 0, 0, 0)
    `).run(generation, identity.adapter_value, identity.items_revision, identity.item_count);
    return generation;
  });
}

function next_search_generation(db: DatabaseSync): number {
  return Math.max(
    1,
    row_number(
      db
        .prepare(
          "SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM fate_extra_preview_search_generation",
        )
        .get() ?? {},
      "generation",
    ),
  );
}

function build_inactive_search_generation(
  db: DatabaseSync,
  generation: number,
  identity: FateExtraIndexSourceIdentity,
  report_progress: (completed: number, total: number) => void,
): void {
  const compact_project = identity.compact_value !== null;
  const item_batch_size = compact_project
    ? SEARCH_COMPACT_BUILD_BATCH_SIZE
    : SEARCH_BUILD_BATCH_SIZE;
  let after_item_id = 0;
  let completed_items = 0;
  report_progress(0, identity.item_count);
  while (true) {
    const batch = run_immediate_transaction(db, () => {
      assert_index_source_identity(db, identity);
      const last_item_id = row_number(
        db
          .prepare(`
            SELECT COALESCE(MAX(id), 0) AS id
            FROM (
              SELECT id FROM items WHERE id > ? ORDER BY id LIMIT ?
            ) AS batch
          `)
          .get(after_item_id, item_batch_size) ?? {},
        "id",
      );
      if (last_item_id <= after_item_id) return { count: 0, last_item_id };
      build_search_item_batch(db, generation, after_item_id, last_item_id, compact_project);
      update_search_document_summary_batch(db, generation, after_item_id, last_item_id);
      const count = row_number(
        db
          .prepare("SELECT COUNT(*) AS count FROM items WHERE id > ? AND id <= ?")
          .get(after_item_id, last_item_id) ?? {},
        "count",
      );
      assert_index_source_identity(db, identity);
      return { count, last_item_id };
    });
    if (batch.last_item_id <= after_item_id) break;
    after_item_id = batch.last_item_id;
    completed_items += batch.count;
    report_progress(completed_items, identity.item_count);
  }

  let after_document_id = 0;
  while (true) {
    const last_document_id = run_immediate_transaction(db, () => {
      assert_index_source_identity(db, identity);
      const next_document_id = row_number(
        db
          .prepare(`
            SELECT COALESCE(MAX(document_id), 0) AS document_id
            FROM (
              SELECT document_id
              FROM fate_extra_preview_search_document
              WHERE generation = ? AND document_id > ?
              ORDER BY document_id
              LIMIT ?
            ) AS batch
          `)
          .get(generation, after_document_id, SEARCH_DOCUMENT_BATCH_SIZE) ?? {},
        "document_id",
      );
      if (next_document_id > after_document_id) {
        build_search_document_batch(db, generation, after_document_id, next_document_id);
      }
      assert_index_source_identity(db, identity);
      return next_document_id;
    });
    if (last_document_id <= after_document_id) break;
    after_document_id = last_document_id;
  }
  report_progress(identity.item_count, identity.item_count);
}

function complete_inactive_search_generation(
  db: DatabaseSync,
  generation: number,
  identity: FateExtraIndexSourceIdentity,
): { document_count: number; short_gram_count: number } {
  const indexed_item_count = count_generation_rows(
    db,
    "fate_extra_preview_search_item",
    generation,
  );
  if (indexed_item_count !== identity.item_count) {
    throw new Error("fate_extra_preview_index_item_count_mismatch");
  }
  const document_count = count_generation_rows(
    db,
    "fate_extra_preview_search_document",
    generation,
  );
  const short_gram_count = count_generation_rows(
    db,
    "fate_extra_preview_search_short_gram",
    generation,
  );
  run_immediate_transaction(db, () => {
    assert_index_source_identity(db, identity);
    const generation_row = db
      .prepare(`
        SELECT adapter_value, items_revision, item_count, complete
        FROM fate_extra_preview_search_generation
        WHERE generation = ?
      `)
      .get(generation);
    if (
      generation_row === undefined ||
      row_number(generation_row, "complete") !== 0 ||
      row_text(generation_row, "adapter_value") !== identity.adapter_value ||
      row_number(generation_row, "items_revision") !== identity.items_revision ||
      row_number(generation_row, "item_count") !== identity.item_count
    ) {
      throw new Error("fate_extra_preview_index_generation_changed");
    }
    db.prepare(`
      UPDATE fate_extra_preview_search_generation
      SET document_count = ?, short_gram_count = ?, complete = 1
      WHERE generation = ?
    `).run(document_count, short_gram_count, generation);
    assert_index_source_identity(db, identity);
  });
  return { document_count, short_gram_count };
}

/**
 * 主进程完成 project epoch/revision 复核后调用的短事务发布点。
 * 这里只切换少量 meta；百万行构建和计数均已在维护 worker 完成。
 */
export function activate_fate_extra_preview_search_generation(
  db: DatabaseSync,
  generation: number,
  expected_items_revision: number,
  expected_adapter_value: string,
): FateExtraIndexState {
  return run_immediate_transaction(db, () => {
    const current_items_revision = read_json_number_meta(db, "project_runtime_revision.items");
    const current_adapter_value = read_meta_text(db, "fate_extra.adapter.v1");
    const row = db
      .prepare(`
        SELECT adapter_value, items_revision, item_count, document_count, short_gram_count, complete
        FROM fate_extra_preview_search_generation
        WHERE generation = ?
      `)
      .get(Math.trunc(generation));
    if (
      row === undefined ||
      row_number(row, "complete") !== 1 ||
      current_items_revision !== Math.trunc(expected_items_revision) ||
      current_adapter_value !== expected_adapter_value ||
      row_number(row, "items_revision") !== Math.trunc(expected_items_revision) ||
      row_text(row, "adapter_value") !== expected_adapter_value
    ) {
      throw new Error("fate_extra_preview_index_activation_identity_changed");
    }
    write_identity_meta(
      db,
      Math.trunc(generation),
      Math.trunc(expected_items_revision),
      row_number(row, "item_count"),
      row_number(row, "document_count"),
      row_number(row, "short_gram_count"),
      expected_adapter_value,
    );
    const state = read_fate_extra_index_state(db);
    if (
      !state.ready ||
      !state.search_ready ||
      state.search_generation !== Math.trunc(generation) ||
      state.search_items_revision !== Math.trunc(expected_items_revision)
    ) {
      throw new Error("fate_extra_preview_index_activation_incomplete");
    }
    return state;
  });
}

function run_immediate_transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 连接关闭继续保证未提交事务不会成为可见派生状态。
    }
    throw error;
  }
}

/**
 * 只改译文或校对稿时刷新 active generation；结构写入口不调用本函数，revision 不匹配会可靠标 dirty。
 */
export function refresh_fate_extra_preview_search_documents(
  db: DatabaseSync,
  item_ids: readonly number[],
): boolean {
  const normalized_ids = [
    ...new Set(
      item_ids
        .map((item_id) => Math.trunc(item_id))
        .filter((item_id) => Number.isSafeInteger(item_id) && item_id > 0),
    ),
  ];
  if (normalized_ids.length === 0) return false;
  const adapter_value = read_meta_text(db, "fate_extra.adapter.v1");
  const items_revision = read_json_number_meta(db, "project_runtime_revision.items");
  const generation = read_json_number_meta(db, FATE_EXTRA_PREVIEW_SEARCH_GENERATION_META_KEY);
  const active_row = db
    .prepare(
      `SELECT adapter_value, items_revision, complete, item_count
       FROM fate_extra_preview_search_generation
       WHERE generation = ?`,
    )
    .get(generation);
  const indexed_item_count = row_number(active_row ?? {}, "item_count");
  const indexed_items_revision = row_number(active_row ?? {}, "items_revision");
  const text_unit_items_revision = read_json_number_meta_or_null(
    db,
    "fate_extra.text-unit-index.items-revision",
  );
  if (
    generation <= 0 ||
    indexed_item_count === 0 ||
    row_number(active_row ?? {}, "complete") !== 1 ||
    adapter_value === null ||
    adapter_value !== row_text(active_row ?? {}, "adapter_value") ||
    items_revision <= 0 ||
    indexed_items_revision !== items_revision - 1 ||
    text_unit_items_revision !== indexed_items_revision
  ) {
    return false;
  }

  const read_item = db.prepare(`
    SELECT item.data, COALESCE(occurrence.unit_id, 0) AS unit_id
    FROM items AS item
    LEFT JOIN fate_extra_text_occurrence AS occurrence ON occurrence.item_id = item.id
    WHERE item.id = ?
  `);
  const delete_mappings = db.prepare(
    "DELETE FROM fate_extra_preview_search_mapping WHERE generation = ? AND item_id = ? AND field IN ('src', 'dst', 'proofread')",
  );
  const read_old_documents = db.prepare(
    "SELECT DISTINCT document_id FROM fate_extra_preview_search_mapping WHERE generation = ? AND item_id = ? AND field IN ('src', 'dst', 'proofread')",
  );
  const update_item = db.prepare(`
    UPDATE fate_extra_preview_search_item
    SET unit_id = ?, category = ?
    WHERE generation = ? AND item_id = ?
  `);
  const insert_mapping = db.prepare(`
    INSERT OR IGNORE INTO fate_extra_preview_search_mapping (
      generation, item_id, occurrence_id, field, document_id
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const document_statements = prepare_document_statements(db);
  const affected_document_ids = new Set<number>();
  const read_compact_occurrences =
    db.prepare("SELECT 1 FROM meta WHERE key = 'fate_extra.compact.v1'").get() === undefined
      ? null
      : db.prepare(`
          SELECT
            occurrence.original_item_id,
            occurrence.original_machine_translation,
            source.source
          FROM fate_extra_compact_source AS source
          JOIN fate_extra_compact_occurrence AS occurrence
            ON occurrence.source_hash = source.source_hash
          WHERE source.compact_item_id = ?
          ORDER BY occurrence.original_item_id
        `);
  for (const item_id of normalized_ids) {
    const row = read_item.get(item_id);
    if (row === undefined) return false;
    const item = parse_item(row["data"]);
    const metadata = item_metadata(item);
    for (const document of read_old_documents.all(generation, item_id)) {
      affected_document_ids.add(row_number(document, "document_id"));
    }
    delete_mappings.run(generation, item_id);
    update_item.run(
      row_number(row, "unit_id"),
      item_text(item_metadata_classification(metadata), "category"),
      generation,
      item_id,
    );
    const compact_occurrences = read_compact_occurrences?.all(item_id) ?? [];
    if (compact_occurrences.length === 0) {
      for (const [field, text] of read_search_fields(item, metadata).filter(
        ([field]) => field !== "file",
      )) {
        const document_id = ensure_document(generation, field, text, document_statements);
        affected_document_ids.add(document_id);
        insert_mapping.run(generation, item_id, item_id, field, document_id);
      }
      continue;
    }
    for (const occurrence of compact_occurrences) {
      const occurrence_id = row_number(occurrence, "original_item_id");
      const original_dst = row_text(occurrence, "original_machine_translation");
      for (const [field, text] of [
        ["src", row_text(occurrence, "source")],
        ["dst", original_dst === "" ? item_text(item, "dst") : original_dst],
        ["proofread", item_text(metadata, "proofread_translation")],
      ] as const) {
        const document_id = ensure_document(generation, field, text, document_statements);
        affected_document_ids.add(document_id);
        insert_mapping.run(generation, item_id, occurrence_id, field, document_id);
      }
    }
  }
  const document_is_used = db.prepare(
    "SELECT 1 FROM fate_extra_preview_search_mapping WHERE generation = ? AND document_id = ? LIMIT 1",
  );
  const delete_grams = db.prepare(
    "DELETE FROM fate_extra_preview_search_short_gram WHERE generation = ? AND document_id = ?",
  );
  const delete_document = db.prepare(
    "DELETE FROM fate_extra_preview_search_document WHERE generation = ? AND document_id = ?",
  );
  const delete_document_summary = db.prepare(
    "DELETE FROM fate_extra_preview_search_file_summary WHERE generation = ? AND document_id = ?",
  );
  const upsert_document_summary = db.prepare(`
    INSERT INTO fate_extra_preview_search_file_summary (
      generation, document_id, occurrence_count, first_item_id
    )
    SELECT generation, document_id, COUNT(*), MIN(item_id)
    FROM fate_extra_preview_search_mapping
    WHERE generation = ? AND document_id = ?
    GROUP BY generation, document_id
    ON CONFLICT(generation, document_id) DO UPDATE SET
      occurrence_count = excluded.occurrence_count,
      first_item_id = excluded.first_item_id
  `);
  const read_document = db.prepare(`
    SELECT field, search_text
    FROM fate_extra_preview_search_document
    WHERE generation = ? AND document_id = ?
  `);
  const delete_fts = db.prepare(`
    INSERT INTO fate_extra_preview_search_fts(
      fate_extra_preview_search_fts, rowid, search_text
    ) VALUES ('delete', ?, ?)
  `);
  for (const document_id of affected_document_ids) {
    if (document_is_used.get(generation, document_id) !== undefined) {
      upsert_document_summary.run(generation, document_id);
      continue;
    }
    delete_document_summary.run(generation, document_id);
    const document = read_document.get(generation, document_id);
    delete_grams.run(generation, document_id);
    if (document !== undefined && row_text(document, "field") !== "file-exact") {
      delete_fts.run(document_id, row_text(document, "search_text"));
    }
    delete_document.run(generation, document_id);
  }
  const document_count = count_generation_rows(
    db,
    "fate_extra_preview_search_document",
    generation,
  );
  const short_gram_count = count_generation_rows(
    db,
    "fate_extra_preview_search_short_gram",
    generation,
  );
  db.prepare(`
    UPDATE fate_extra_preview_search_generation
    SET items_revision = ?, document_count = ?, short_gram_count = ?
    WHERE generation = ?
  `).run(items_revision, document_count, short_gram_count, generation);
  write_identity_meta(
    db,
    generation,
    items_revision,
    indexed_item_count,
    document_count,
    short_gram_count,
    adapter_value,
  );
  return true;
}

function build_search_item_batch(
  db: DatabaseSync,
  generation: number,
  after_item_id: number,
  last_item_id: number,
  compact_project: boolean,
): void {
  const field_sql = [
    ["src", "COALESCE(json_extract(item.data, '$.src'), '')"],
    ["dst", "COALESCE(json_extract(item.data, '$.dst'), '')"],
    [
      "proofread",
      "COALESCE(json_extract(item.data, '$.extra_field.__linguagacha_fe_v1.proofread_translation'), '')",
    ],
    ["file", "COALESCE(json_extract(item.data, '$.file_path'), '')"],
  ] as const;
  db.prepare(`
    INSERT INTO fate_extra_preview_search_item (generation, item_id, unit_id, category)
    SELECT
      ?, item.id, COALESCE(occurrence.unit_id, 0),
      COALESCE(json_extract(
        item.data,
        '$.extra_field.__linguagacha_fe_v1.classification.category'
      ), '')
    FROM items AS item
    LEFT JOIN fate_extra_text_occurrence AS occurrence ON occurrence.item_id = item.id
    WHERE item.id > ? AND item.id <= ?
    ORDER BY item.id
  `).run(generation, after_item_id, last_item_id);
  for (const [field, value_sql] of field_sql.filter(() => !compact_project)) {
    db.prepare(`
      INSERT OR IGNORE INTO fate_extra_preview_search_document (
        generation, field, search_text
      )
      SELECT ?, ?, fate_extra_preview_casefold(${value_sql})
      FROM items AS item
      WHERE item.id > ? AND item.id <= ?
      GROUP BY fate_extra_preview_casefold(${value_sql})
    `).run(generation, field, after_item_id, last_item_id);
    db.prepare(`
      INSERT OR IGNORE INTO fate_extra_preview_search_mapping (
        generation, item_id, occurrence_id, field, document_id
      )
      SELECT ?, item.id, item.id, ?, document.document_id
      FROM items AS item
      JOIN fate_extra_preview_search_document AS document
        ON document.generation = ? AND document.field = ?
        AND document.search_text = fate_extra_preview_casefold(${value_sql})
      WHERE item.id > ? AND item.id <= ?
    `).run(generation, field, generation, field, after_item_id, last_item_id);
  }

  // 精简项目同一可编辑 item 可映射多条物理路径；路径仍以独立文档和整数映射保存。
  if (compact_project) {
    const compact_field_sql = [
      ["src", "source.source"],
      [
        "dst",
        "CASE WHEN occurrence.original_machine_translation <> '' THEN occurrence.original_machine_translation ELSE COALESCE(json_extract(item.data, '$.dst'), '') END",
      ],
      [
        "proofread",
        "COALESCE(json_extract(item.data, '$.extra_field.__linguagacha_fe_v1.proofread_translation'), '')",
      ],
      ["file", "occurrence.file_path"],
    ] as const;
    for (const [field, value_sql] of compact_field_sql) {
      db.prepare(`
        INSERT OR IGNORE INTO fate_extra_preview_search_document (
          generation, field, search_text
        )
        SELECT ?, ?, fate_extra_preview_casefold(${value_sql})
        FROM fate_extra_compact_occurrence AS occurrence
        JOIN fate_extra_compact_source AS source ON source.source_hash = occurrence.source_hash
        JOIN items AS item ON item.id = source.compact_item_id
        WHERE source.compact_item_id > ? AND source.compact_item_id <= ?
        GROUP BY fate_extra_preview_casefold(${value_sql})
      `).run(generation, field, after_item_id, last_item_id);
      db.prepare(`
        INSERT OR IGNORE INTO fate_extra_preview_search_mapping (
          generation, item_id, occurrence_id, field, document_id
        )
        SELECT
          ?, source.compact_item_id, occurrence.original_item_id, ?, document.document_id
        FROM fate_extra_compact_occurrence AS occurrence
        JOIN fate_extra_compact_source AS source ON source.source_hash = occurrence.source_hash
        JOIN items AS item ON item.id = source.compact_item_id
        JOIN fate_extra_preview_search_document AS document
          ON document.generation = ? AND document.field = ?
          AND document.search_text = fate_extra_preview_casefold(${value_sql})
        WHERE source.compact_item_id > ? AND source.compact_item_id <= ?
      `).run(generation, field, generation, field, after_item_id, last_item_id);
    }
    return;
  }

  db.prepare(`
    INSERT OR IGNORE INTO fate_extra_preview_search_document (generation, field, search_text)
    SELECT ?, 'file-exact', COALESCE(json_extract(item.data, '$.file_path'), '')
    FROM items AS item
    WHERE item.id > ? AND item.id <= ?
    GROUP BY COALESCE(json_extract(item.data, '$.file_path'), '')
  `).run(generation, after_item_id, last_item_id);
  db.prepare(`
    INSERT OR IGNORE INTO fate_extra_preview_search_mapping (
      generation, item_id, occurrence_id, field, document_id
    )
    SELECT ?, item.id, item.id, 'file-exact', document.document_id
    FROM items AS item
    JOIN fate_extra_preview_search_document AS document
      ON document.generation = ? AND document.field = 'file-exact'
      AND document.search_text = COALESCE(json_extract(item.data, '$.file_path'), '')
    WHERE item.id > ? AND item.id <= ?
  `).run(generation, generation, after_item_id, last_item_id);
}

/** 历史表名保留 file_summary；schema 7 中它缓存每个去重搜索文档的物理映射计数。 */
function update_search_document_summary_batch(
  db: DatabaseSync,
  generation: number,
  after_item_id: number,
  last_item_id: number,
): void {
  db.prepare(`
    INSERT INTO fate_extra_preview_search_file_summary (
      generation, document_id, occurrence_count, first_item_id
    )
    SELECT mapping.generation, mapping.document_id, COUNT(*), MIN(mapping.item_id)
    FROM fate_extra_preview_search_mapping AS mapping
    WHERE mapping.generation = ?
      AND mapping.item_id > ?
      AND mapping.item_id <= ?
    GROUP BY mapping.generation, mapping.document_id
    ON CONFLICT(generation, document_id) DO UPDATE SET
      occurrence_count =
        fate_extra_preview_search_file_summary.occurrence_count + excluded.occurrence_count,
      first_item_id = MIN(
        fate_extra_preview_search_file_summary.first_item_id,
        excluded.first_item_id
      )
  `).run(generation, after_item_id, last_item_id);
}

function build_search_document_batch(
  db: DatabaseSync,
  generation: number,
  after_document_id: number,
  last_document_id: number,
): void {
  db.prepare(`
    WITH RECURSIVE short_gram_source(
      document_id, search_text, position, text_length
    ) AS (
      SELECT document_id, search_text, 1, LENGTH(search_text)
      FROM fate_extra_preview_search_document
      WHERE generation = ?
        AND document_id > ?
        AND document_id <= ?
        AND field <> 'file-exact'
        AND search_text <> ''
      UNION ALL
      SELECT document_id, search_text, position + 1, text_length
      FROM short_gram_source
      WHERE position < text_length
    )
    INSERT OR IGNORE INTO fate_extra_preview_search_short_gram (
      generation, gram, document_id
    )
    SELECT ?, SUBSTR(search_text, position, 1), document_id
    FROM short_gram_source
    UNION ALL
    SELECT ?, SUBSTR(search_text, position, 2), document_id
    FROM short_gram_source
    WHERE position < text_length
  `).run(generation, after_document_id, last_document_id, generation, generation);
  db.prepare(`
    INSERT INTO fate_extra_preview_search_fts(rowid, search_text)
    SELECT document_id, search_text
    FROM fate_extra_preview_search_document
    WHERE generation = ?
      AND document_id > ?
      AND document_id <= ?
      AND field <> 'file-exact'
  `).run(generation, after_document_id, last_document_id);
}

function cleanup_inactive_search_generations(db: DatabaseSync): number {
  const active_generation = read_json_number_meta(
    db,
    FATE_EXTRA_PREVIEW_SEARCH_GENERATION_META_KEY,
  );
  const generations = db
    .prepare(`
      SELECT generation
      FROM fate_extra_preview_search_generation
      WHERE generation <> ?
      ORDER BY generation
    `)
    .all(active_generation)
    .map((row) => row_number(row, "generation"));
  for (const generation of generations) cleanup_search_generation(db, generation);
  return generations.length;
}

function cleanup_search_generation(db: DatabaseSync, generation: number): void {
  if (generation <= 0 || is_active_search_generation(db, generation)) return;

  while (
    delete_generation_batch(
      db,
      generation,
      `DELETE FROM fate_extra_preview_search_mapping
       WHERE (generation, occurrence_id, field, document_id) IN (
         SELECT generation, occurrence_id, field, document_id
         FROM fate_extra_preview_search_mapping
         WHERE generation = ?
         ORDER BY occurrence_id, field, document_id
         LIMIT ?
       )`,
    ) > 0
  ) {
    // 每批单独提交，避免清理硬终止残留时重新持有长写事务。
  }
  while (
    delete_generation_batch(
      db,
      generation,
      `DELETE FROM fate_extra_preview_search_file_summary
       WHERE generation = ? AND document_id IN (
         SELECT document_id
         FROM fate_extra_preview_search_file_summary
         WHERE generation = ?
         ORDER BY document_id
         LIMIT ?
       )`,
      true,
    ) > 0
  ) {
    // 继续删除下一批。
  }
  while (
    delete_generation_batch(
      db,
      generation,
      `DELETE FROM fate_extra_preview_search_short_gram
       WHERE (generation, gram, document_id) IN (
         SELECT generation, gram, document_id
         FROM fate_extra_preview_search_short_gram
         WHERE generation = ?
         ORDER BY gram, document_id
         LIMIT ?
       )`,
    ) > 0
  ) {
    // 继续删除下一批。
  }
  while (
    delete_generation_batch(
      db,
      generation,
      `DELETE FROM fate_extra_preview_search_item
       WHERE generation = ? AND item_id IN (
         SELECT item_id
         FROM fate_extra_preview_search_item
         WHERE generation = ?
         ORDER BY item_id
         LIMIT ?
       )`,
      true,
    ) > 0
  ) {
    // 继续删除下一批。
  }

  const read_documents = db.prepare(`
    SELECT
      document.document_id,
      document.field,
      document.search_text,
      EXISTS (
        SELECT 1
        FROM fate_extra_preview_search_fts_docsize AS docsize
        WHERE docsize.id = document.document_id
      ) AS fts_indexed
    FROM fate_extra_preview_search_document AS document
    WHERE document.generation = ?
    ORDER BY document_id
    LIMIT ?
  `);
  while (true) {
    const documents = read_documents.all(generation, SEARCH_CLEANUP_BATCH_SIZE);
    if (documents.length === 0) break;
    run_immediate_transaction(db, () => {
      assert_inactive_search_generation(db, generation);
      const delete_fts = db.prepare(`
        INSERT INTO fate_extra_preview_search_fts(
          fate_extra_preview_search_fts, rowid, search_text
        ) VALUES ('delete', ?, ?)
      `);
      const delete_document = db.prepare(
        "DELETE FROM fate_extra_preview_search_document WHERE generation = ? AND document_id = ?",
      );
      for (const document of documents) {
        const document_id = row_number(document, "document_id");
        if (
          row_number(document, "fts_indexed") === 1 &&
          row_text(document, "field") !== "file-exact"
        ) {
          delete_fts.run(document_id, row_text(document, "search_text"));
        }
        delete_document.run(generation, document_id);
      }
    });
  }

  run_immediate_transaction(db, () => {
    assert_inactive_search_generation(db, generation);
    db.prepare("DELETE FROM fate_extra_preview_search_generation WHERE generation = ?").run(
      generation,
    );
  });
}

function delete_generation_batch(
  db: DatabaseSync,
  generation: number,
  sql: string,
  repeats_generation = false,
): number {
  return run_immediate_transaction(db, () => {
    assert_inactive_search_generation(db, generation);
    const result = repeats_generation
      ? db.prepare(sql).run(generation, generation, SEARCH_CLEANUP_BATCH_SIZE)
      : db.prepare(sql).run(generation, SEARCH_CLEANUP_BATCH_SIZE);
    return Number(result.changes);
  });
}

function is_active_search_generation(db: DatabaseSync, generation: number): boolean {
  return generation === read_json_number_meta(db, FATE_EXTRA_PREVIEW_SEARCH_GENERATION_META_KEY);
}

function assert_inactive_search_generation(db: DatabaseSync, generation: number): void {
  if (is_active_search_generation(db, generation)) {
    throw new Error("fate_extra_preview_index_cleanup_active_generation");
  }
}

type DocumentStatements = {
  insert: StatementSync;
  find: StatementSync;
  insert_gram: StatementSync;
  insert_fts: StatementSync;
};

function prepare_document_statements(db: DatabaseSync): DocumentStatements {
  return {
    insert: db.prepare(`
      INSERT OR IGNORE INTO fate_extra_preview_search_document (
        generation, field, search_text
      ) VALUES (?, ?, ?)
    `),
    find: db.prepare(`
      SELECT document_id
      FROM fate_extra_preview_search_document
      WHERE generation = ? AND field = ? AND search_text = ?
    `),
    insert_gram: db.prepare(`
      INSERT OR IGNORE INTO fate_extra_preview_search_short_gram (
        generation, gram, document_id
      ) VALUES (?, ?, ?)
    `),
    insert_fts: db.prepare(
      "INSERT INTO fate_extra_preview_search_fts(rowid, search_text) VALUES (?, ?)",
    ),
  };
}

function ensure_document(
  generation: number,
  field: string,
  value: string,
  statements: DocumentStatements,
  normalize = true,
): number {
  const search_text = normalize ? normalize_fate_extra_preview_search_text(value) : value;
  const existing = statements.find.get(generation, field, search_text);
  if (existing !== undefined) return row_number(existing, "document_id");
  statements.insert.run(generation, field, search_text);
  const document_id = row_number(
    statements.find.get(generation, field, search_text) ?? {},
    "document_id",
  );
  if (field !== "file-exact") {
    insert_search_document_grams(generation, document_id, search_text, statements.insert_gram);
    statements.insert_fts.run(document_id, search_text);
  }
  return document_id;
}

function insert_search_document_grams(
  generation: number,
  document_id: number,
  search_text: string,
  statement: StatementSync,
): void {
  const code_points = Array.from(search_text);
  for (let index = 0; index < code_points.length; index += 1) {
    statement.run(generation, code_points[index]!, document_id);
    if (index + 1 < code_points.length) {
      statement.run(generation, `${code_points[index]!}${code_points[index + 1]!}`, document_id);
    }
  }
}

function write_identity_meta(
  db: DatabaseSync,
  generation: number,
  items_revision: number,
  item_count: number,
  document_count: number,
  short_gram_count: number,
  adapter_value: string,
): void {
  const upsert = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  upsert.run(FATE_EXTRA_PREVIEW_SEARCH_GENERATION_META_KEY, JsonTool.stringifyStrict(generation));
  upsert.run(
    FATE_EXTRA_PREVIEW_SEARCH_ITEMS_REVISION_META_KEY,
    JsonTool.stringifyStrict(items_revision),
  );
  upsert.run(FATE_EXTRA_PREVIEW_SEARCH_ITEM_COUNT_META_KEY, JsonTool.stringifyStrict(item_count));
  upsert.run(
    FATE_EXTRA_PREVIEW_SEARCH_DOCUMENT_COUNT_META_KEY,
    JsonTool.stringifyStrict(document_count),
  );
  upsert.run(
    FATE_EXTRA_PREVIEW_SEARCH_SHORT_GRAM_COUNT_META_KEY,
    JsonTool.stringifyStrict(short_gram_count),
  );
  upsert.run(FATE_EXTRA_PREVIEW_SEARCH_ADAPTER_META_KEY, adapter_value);
}

function read_search_fields(
  item: DatabaseRow,
  metadata: DatabaseRow,
): ReadonlyArray<["src" | "dst" | "proofread" | "file", string]> {
  return [
    ["src", item_text(item, "src")],
    ["dst", item_text(item, "dst")],
    ["proofread", item_text(metadata, "proofread_translation")],
    ["file", item_text(item, "file_path")],
  ];
}

function parse_item(value: unknown): DatabaseRow {
  if (typeof value !== "string") return {};
  const parsed = JsonTool.parseStrict<unknown>(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as DatabaseRow)
    : {};
}

function item_metadata(item: DatabaseRow): DatabaseRow {
  const extra = item["extra_field"];
  if (typeof extra !== "object" || extra === null || Array.isArray(extra)) return {};
  const metadata = (extra as DatabaseRow)["__linguagacha_fe_v1"];
  return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? (metadata as DatabaseRow)
    : {};
}

function item_metadata_classification(metadata: DatabaseRow): DatabaseRow {
  const value = metadata["classification"];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as DatabaseRow)
    : {};
}

function item_text(record: DatabaseRow, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : String(value ?? "");
}

/** FTS5 MATCH phrase 只生成 trigram 候选集，随后仍以 INSTR 做精确复核。 */
export function build_fate_extra_preview_search_match_query(search: string): string {
  return `"${search.replaceAll('"', '""')}"`;
}

export function fate_extra_preview_search_length(search: string): number {
  return Array.from(search).length;
}

function count_generation_rows(db: DatabaseSync, table: string, generation: number): number {
  return row_number(
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE generation = ?`).get(generation) ?? {},
    "count",
  );
}

function scalar_count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get();
  return row === undefined ? 0 : row_number(row, "count");
}

function read_meta_text(db: DatabaseSync, key: string): string | null {
  const value = db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.["value"];
  return typeof value === "string" ? value : null;
}

function read_json_number_meta(db: DatabaseSync, key: string): number {
  return read_json_number_meta_or_null(db, key) ?? 0;
}

function read_json_number_meta_or_null(db: DatabaseSync, key: string): number | null {
  const value = read_meta_text(db, key);
  if (value === null) return null;
  try {
    const number = Number(JsonTool.parseStrict<unknown>(value));
    return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : null;
  } catch {
    return null;
  }
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
