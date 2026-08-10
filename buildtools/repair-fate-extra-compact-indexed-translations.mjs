import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const INDEX_LINE = /^(.*?) \| char:(\d+) \| ?(.*)$/u;

const [source_project, translation_directory, target_project] = process.argv.slice(2);
if (!source_project || !translation_directory || !target_project) {
  throw new Error(
    "usage: node repair-fate-extra-compact-indexed-translations.mjs <source.lg> <translations> <target.lg>",
  );
}
if (existsSync(target_project)) {
  throw new Error(`target project already exists: ${target_project}`);
}

function route_signature(file_name) {
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

function remove_pass_through(lines, pass_through) {
  for (const pass_line of [...pass_through].reverse()) {
    const preferred = Math.max(
      0,
      Math.min(lines.length - 1, Number(pass_line.after_source_line) + 1),
    );
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

copyFileSync(source_project, target_project);
const db = new DatabaseSync(target_project);
const report = {
  source_project,
  target_project,
  indexed_files: 0,
  indexed_blocks: 0,
  mapped_blocks: 0,
  missing_blocks: 0,
  edit_groups: 0,
  conflicting_groups: 0,
  updated_groups: 0,
  integrity_check: "",
};

try {
  const route_files = db
    .prepare("SELECT DISTINCT file_path FROM fate_extra_compact_occurrence")
    .all()
    .map((row) => String(row.file_path));
  const route_by_signature = new Map(
    route_files.map((file_path) => [route_signature(file_path), file_path]),
  );
  const occurrence_rows = db
    .prepare(`
      SELECT
        occurrence.original_item_id,
        occurrence.file_path,
        occurrence.resource_path,
        occurrence.char_offset,
        occurrence.pass_through,
        compact_source.compact_item_id
      FROM fate_extra_compact_occurrence AS occurrence
      JOIN fate_extra_compact_source AS compact_source
        ON compact_source.source_hash = occurrence.source_hash
      WHERE compact_source.excluded_reason = ''
    `)
    .all();
  const occurrence_by_key = new Map();
  for (const row of occurrence_rows) {
    occurrence_by_key.set(
      `${row.file_path}\u0000${row.resource_path}\u0000${row.char_offset}`,
      row,
    );
  }

  const candidates = new Map();
  const translation_files = readdirSync(translation_directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".txt") &&
        entry.name.includes("初翻") &&
        entry.name.includes("带索引"),
    )
    .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
  report.indexed_files = translation_files.length;

  for (const translation_file of translation_files) {
    const route_file = route_by_signature.get(route_signature(translation_file.name));
    if (!route_file) continue;
    const lines = readFileSync(path.join(translation_directory, translation_file.name), "utf8")
      .replace(/^\uFEFF/u, "")
      .split(/\r\n|\n|\r/gu);
    if (lines.at(-1) === "") lines.pop();
    let cursor = 0;
    while (cursor < lines.length) {
      const header = INDEX_LINE.exec(lines[cursor] ?? "");
      if (!header) {
        cursor += 1;
        continue;
      }
      report.indexed_blocks += 1;
      let block_end = cursor + 1;
      while (block_end < lines.length && INDEX_LINE.exec(lines[block_end] ?? "") === null) {
        block_end += 1;
      }
      const resource_path = header[1] ?? "";
      const char_offset = Number(header[2]);
      const occurrence = occurrence_by_key.get(
        `${route_file}\u0000${resource_path}\u0000${char_offset}`,
      );
      if (!occurrence) {
        report.missing_blocks += 1;
        cursor = block_end;
        continue;
      }
      const translated_lines = [header[3] ?? "", ...lines.slice(cursor + 1, block_end)];
      const pass_through = JSON.parse(String(occurrence.pass_through || "[]"));
      remove_pass_through(translated_lines, pass_through);
      const translation = translated_lines.join("\n");
      if (translation !== "") {
        const compact_item_id = Number(occurrence.compact_item_id);
        const group = candidates.get(compact_item_id) ?? [];
        group.push({
          translation,
          original_item_id: Number(occurrence.original_item_id),
        });
        candidates.set(compact_item_id, group);
      }
      report.mapped_blocks += 1;
      cursor = block_end;
    }
  }

  report.edit_groups = candidates.size;
  const read_item = db.prepare(
    "SELECT json_extract(data, '$.src') AS src, json_extract(data, '$.dst') AS dst FROM items WHERE id = ?",
  );
  const update_item = db.prepare(`
    UPDATE items
    SET data = json_set(
      data,
      '$.dst', ?,
      '$.status', 'PROCESSED',
      '$.extra_field.__linguagacha_fe_v1.migration_source', 'indexed-text-exact-repair',
      '$.extra_field.__linguagacha_fe_v1.migration_review', 0
    )
    WHERE id = ?
  `);
  const update_occurrence = db.prepare(`
    UPDATE fate_extra_compact_occurrence
    SET original_machine_translation = ?
    WHERE original_item_id = ?
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [compact_item_id, group] of candidates) {
      for (const candidate of group) {
        update_occurrence.run(candidate.translation, candidate.original_item_id);
      }
      const by_text = new Map();
      for (const candidate of group) {
        const existing = by_text.get(candidate.translation);
        if (!existing || candidate.original_item_id < existing.original_item_id) {
          by_text.set(candidate.translation, candidate);
        }
      }
      if (by_text.size > 1) report.conflicting_groups += 1;
      const item = read_item.get(compact_item_id);
      const current_dst = String(item?.dst ?? "");
      const source = String(item?.src ?? "");
      const current_candidate = by_text.get(current_dst);
      const selected =
        current_dst !== "" && current_dst !== source && current_candidate
          ? current_candidate
          : [...by_text.values()].sort(
              (left, right) => left.original_item_id - right.original_item_id,
            )[0];
      if (!selected) continue;
      update_item.run(selected.translation, compact_item_id);
      report.updated_groups += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  report.integrity_check = String(
    db.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "",
  );
} finally {
  db.close();
}

const report_path = `${target_project}.indexed-import-report.json`;
writeFileSync(report_path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...report, report_path }, null, 2)}\n`);
