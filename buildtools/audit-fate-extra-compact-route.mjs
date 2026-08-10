import { DatabaseSync } from "node:sqlite";

const [project_path, route_file] = process.argv.slice(2);
if (!project_path || !route_file) {
  throw new Error("usage: node audit-fate-extra-compact-route.mjs <project.lg> <route-file>");
}

const db = new DatabaseSync(project_path, { readOnly: true });
try {
  const rows = db
    .prepare(`
      SELECT
        occurrence.original_item_id,
        occurrence.row_number,
        compact_source.source,
        compact_source.compact_item_id,
        occurrence.original_machine_translation
      FROM fate_extra_compact_occurrence AS occurrence
      JOIN fate_extra_compact_source AS compact_source
        ON compact_source.source_hash = occurrence.source_hash
      WHERE occurrence.file_path = ? AND compact_source.excluded_reason = ''
      ORDER BY occurrence.row_number, occurrence.original_item_id
    `)
    .all(route_file);
  let order_descents = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (Number(rows[index]?.["row_number"]) < Number(rows[index - 1]?.["row_number"])) {
      order_descents += 1;
    }
  }
  const missing = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM fate_extra_compact_occurrence AS occurrence
      JOIN fate_extra_compact_source AS compact_source
        ON compact_source.source_hash = occurrence.source_hash
      LEFT JOIN items AS item ON item.id = compact_source.compact_item_id
      WHERE occurrence.file_path = ?
        AND compact_source.excluded_reason = ''
        AND item.id IS NULL
    `)
    .get(route_file);
  const sample = (row) => ({
    row: Number(row?.["row_number"]),
    source: String(row?.["source"] ?? "").slice(0, 60),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        physical: rows.length,
        distinct_edit_groups: new Set(rows.map((row) => Number(row["compact_item_id"]))).size,
        order_descents,
        missing_compact_items: Number(missing?.["count"] ?? 0),
        physical_machine_translations: rows.filter(
          (row) => String(row["original_machine_translation"] ?? "") !== "",
        ).length,
        source_copy_machine_translations: rows.filter(
          (row) =>
            String(row["original_machine_translation"] ?? "") === String(row["source"] ?? ""),
        ).length,
        first: rows.slice(0, 3).map(sample),
        last: rows.slice(-3).map(sample),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  db.close();
}
