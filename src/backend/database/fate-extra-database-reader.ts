import { DatabaseSync } from "node:sqlite";

import type { FateExtraClassification } from "../../shared/fate-extra/fate-extra-types";

export type FateExtraClassificationRow = {
  path: string;
  char_offset: number;
  source: string;
  classification: FateExtraClassification;
};

const REQUIRED_CLASSIFICATION_COLUMNS = `
  path,
  char_offset,
  source,
  category,
  category_zh,
  confidence,
  reason,
  resource_path,
  byte_offset,
  source_bytes,
  slot_capacity,
  slot_end,
  allow_overlength,
  allow_relocation,
  translator_message,
  pointer_offsets_json,
  address_limit,
  preserve_high16,
  shared_group_id,
  shared_group_start,
  shared_group_end,
  shared_group_members,
  format_handler
`;

function nullable_number(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function number_array_from_json(value: unknown): number[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.map(Number).filter((entry) => Number.isFinite(entry))
      : [];
  } catch {
    return [];
  }
}

export function normalize_fate_extra_classification_row(
  row: Record<string, unknown>,
): FateExtraClassificationRow {
  return {
    path: String(row["path"] ?? ""),
    char_offset: Number(row["char_offset"] ?? 0),
    source: String(row["source"] ?? ""),
    classification: {
      category: String(row["category"] ?? ""),
      category_zh: String(row["category_zh"] ?? ""),
      confidence: String(row["confidence"] ?? ""),
      reason: String(row["reason"] ?? ""),
      resource_path: String(row["resource_path"] ?? ""),
      byte_offset: nullable_number(row["byte_offset"]),
      source_bytes: nullable_number(row["source_bytes"]),
      slot_capacity: nullable_number(row["slot_capacity"]),
      slot_end: nullable_number(row["slot_end"]),
      allow_overlength: Number(row["allow_overlength"] ?? 0) !== 0,
      allow_relocation: Number(row["allow_relocation"] ?? 0) !== 0,
      translator_message: String(row["translator_message"] ?? ""),
      pointer_offsets: number_array_from_json(row["pointer_offsets_json"]),
      address_limit: nullable_number(row["address_limit"]),
      preserve_high16: Number(row["preserve_high16"] ?? 0) !== 0,
      shared_storage_group: String(row["shared_group_id"] ?? ""),
      shared_group_start: nullable_number(row["shared_group_start"]),
      shared_group_end: nullable_number(row["shared_group_end"]),
      shared_group_members: nullable_number(row["shared_group_members"]),
      format_handler: String(row["format_handler"] ?? ""),
      display_opcode: nullable_number(row["display_opcode"]),
      portrait_id: nullable_number(row["portrait_id"]),
      display_evidence: String(row["display_evidence"] ?? ""),
    },
  };
}

export function read_fate_extra_classifications(
  database_path: string,
  indexed_offsets_by_path: ReadonlyMap<string, readonly number[]>,
): FateExtraClassificationRow[] {
  const database = new DatabaseSync(database_path, { readOnly: true });
  const output: FateExtraClassificationRow[] = [];
  try {
    const available_columns = new Set(
      database
        .prepare("PRAGMA table_info(entries)")
        .all()
        .map((row) => String(row["name"] ?? "")),
    );
    const optional_columns = ["display_opcode", "portrait_id", "display_evidence"]
      .map((column) => (available_columns.has(column) ? column : `NULL AS ${column}`))
      .join(",\n  ");
    const classification_columns = `${REQUIRED_CLASSIFICATION_COLUMNS},\n  ${optional_columns}`;
    for (const [indexed_path, all_offsets] of indexed_offsets_by_path) {
      for (let start = 0; start < all_offsets.length; start += 500) {
        const offsets = all_offsets.slice(start, start + 500);
        const values = offsets.map(() => "?").join(", ");
        const rows = database
          .prepare(
            `SELECT ${classification_columns}
             FROM entries
             WHERE path = ? AND char_offset IN (${values})`,
          )
          .all(indexed_path, ...offsets);
        output.push(...rows.map(normalize_fate_extra_classification_row));
      }
    }
    return output;
  } finally {
    database.close();
  }
}

/**
 * 分类库全量读取只用于 FE 扫描 staging，使用 rowid 游标而非 OFFSET，并且每批释放数组。
 */
export function* iterate_fate_extra_classifications(
  database_path: string,
  batch_size = 1_000,
): Generator<FateExtraClassificationRow> {
  const database = new DatabaseSync(database_path, { readOnly: true });
  let after_rowid = 0;
  try {
    const available_columns = new Set(
      database
        .prepare("PRAGMA table_info(entries)")
        .all()
        .map((row) => String(row["name"] ?? "")),
    );
    const optional_columns = ["display_opcode", "portrait_id", "display_evidence"]
      .map((column) => (available_columns.has(column) ? column : `NULL AS ${column}`))
      .join(",\n  ");
    const select = database.prepare(
      `SELECT rowid AS _scan_rowid, ${REQUIRED_CLASSIFICATION_COLUMNS}, ${optional_columns}
       FROM entries
       WHERE rowid > ?
       ORDER BY rowid
       LIMIT ?`,
    );
    while (true) {
      const rows = select.all(after_rowid, batch_size);
      if (rows.length === 0) return;
      for (const row of rows) {
        after_rowid = Number(row["_scan_rowid"] ?? after_rowid);
        yield normalize_fate_extra_classification_row(row);
      }
    }
  } finally {
    database.close();
  }
}

/**
 * 旧项目迁移按稳定主键游标读取；生成器提前结束时 finally 仍会关闭只读连接。
 */
export function* iterate_fate_extra_legacy_item_rows(
  database_path: string,
  batch_size = 1_000,
): Generator<{ id: number; data: string }> {
  const database = new DatabaseSync(database_path, { readOnly: true });
  let after_id = -1;
  try {
    const select = database.prepare("SELECT id, data FROM items WHERE id > ? ORDER BY id LIMIT ?");
    while (true) {
      const rows = select.all(after_id, batch_size);
      if (rows.length === 0) return;
      for (const row of rows) {
        const id = Number(row["id"] ?? 0);
        yield { id, data: String(row["data"] ?? "{}") };
        after_id = id;
      }
    }
  } finally {
    database.close();
  }
}

export function count_fate_extra_legacy_item_rows(database_path: string): number {
  const database = new DatabaseSync(database_path, { readOnly: true });
  try {
    return Number(database.prepare("SELECT COUNT(*) AS count FROM items").get()?.["count"] ?? 0);
  } finally {
    database.close();
  }
}
