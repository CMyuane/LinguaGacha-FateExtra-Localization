import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  FATE_EXTRA_INDEX_LINE_PATTERN,
  parse_fate_extra_indexed_text,
  rebuild_fate_extra_indexed_block,
  type FateExtraExpectedIndexedText,
  type FateExtraParsedIndexedText,
} from "../src/shared/fate-extra/fate-extra-parser";

const source_directory =
  process.argv[2] ?? String.raw`D:\AA_Fe_Transition\灵瓜处理\最终文本分支_带索引日文原版`;
const database_path =
  process.argv[3] ?? String.raw`D:\AA_Fe_Transition\文本安全分类\FE文本安全分类.sqlite`;
const unindexed_directory = process.argv[4] ?? String.raw`D:\AA_Fe_Transition\灵瓜处理`;
const source_marker_prefix = "\u0000FE_SOURCE_";
const source_marker_suffix = "\u0000";

function route_signature(file_name: string): string {
  const normalized = file_name.normalize("NFKC");
  const servant = normalized.includes("尼禄")
    ? "nero"
    : normalized.includes("无铭")
      ? "archer"
      : normalized.includes("玉藻")
        ? "caster"
        : "";
  const branch = normalized.includes("拉妮") ? "rani" : normalized.includes("凛") ? "rin" : "";
  return `${servant}:${branch}`;
}

const database = new DatabaseSync(database_path, { readOnly: true });
const files = fs
  .readdirSync(source_directory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".txt"))
  .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
const unique_keys = new Set<string>();
const classification_cache = new Map<string, FateExtraExpectedIndexedText | null>();
const indexed_offsets_by_path = new Map<string, number[]>();
const issues: string[] = [];
let logical_text_count = 0;
let matched_classification_count = 0;
const parsed_files: Array<{ file_name: string; entries: FateExtraParsedIndexedText[] }> = [];

try {
  const inputs = files.map((file) => {
    const text = fs
      .readFileSync(path.join(source_directory, file.name), "utf8")
      .replace(/^\uFEFF/u, "");
    for (const line of text.split(/\r\n|\n|\r/gu)) {
      const header = FATE_EXTRA_INDEX_LINE_PATTERN.exec(line);
      if (header === null) continue;
      const indexed_path = header[1] ?? "";
      const char_offset = Number(header[2]);
      const key = `${indexed_path}\u0000${char_offset}`;
      if (!unique_keys.has(key)) {
        unique_keys.add(key);
        const offsets = indexed_offsets_by_path.get(indexed_path) ?? [];
        offsets.push(char_offset);
        indexed_offsets_by_path.set(indexed_path, offsets);
      }
    }
    return { file, text };
  });
  for (const [indexed_path, all_offsets] of indexed_offsets_by_path) {
    for (let start = 0; start < all_offsets.length; start += 500) {
      const offsets = all_offsets.slice(start, start + 500);
      const values = offsets.map(() => "?").join(", ");
      const rows = database
        .prepare(
          `SELECT path, char_offset, source
           FROM entries
           WHERE path = ? AND char_offset IN (${values})`,
        )
        .all(indexed_path, ...offsets);
      for (const row of rows) {
        const key = `${row["path"]}\u0000${row["char_offset"]}`;
        classification_cache.set(key, {
          path: String(row["path"]),
          char_offset: Number(row["char_offset"]),
          source: String(row["source"]),
        });
      }
    }
  }
  for (const { file, text } of inputs) {
    const expected: FateExtraExpectedIndexedText[] = [];
    for (const line of text.split(/\r\n|\n|\r/gu)) {
      const header = FATE_EXTRA_INDEX_LINE_PATTERN.exec(line);
      if (header === null) continue;
      const indexed_path = header[1] ?? "";
      const char_offset = Number(header[2]);
      const key = `${indexed_path}\u0000${char_offset}`;
      const classification = classification_cache.get(key);
      if (classification === undefined || classification === null) {
        issues.push(`${file.name}: missing ${indexed_path} / char:${char_offset}`);
        continue;
      }
      expected.push(classification);
      matched_classification_count += 1;
    }
    const parsed = parse_fate_extra_indexed_text({ text, expected });
    logical_text_count += parsed.entries.length;
    parsed_files.push({ file_name: file.name, entries: parsed.entries });
    issues.push(...parsed.issues.map((issue) => `${file.name}: ${issue}`));
  }
} finally {
  database.close();
}

const unindexed_files = fs
  .readdirSync(unindexed_directory, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.toLowerCase().endsWith(".txt") &&
      entry.name.includes("无索引译文"),
  );
let unindexed_logical_text_count = 0;
const unindexed_issues: string[] = [];
for (const indexed of parsed_files) {
  const matching = unindexed_files.filter(
    (file) => route_signature(file.name) === route_signature(indexed.file_name),
  );
  if (matching.length !== 1) {
    unindexed_issues.push(`${indexed.file_name}: expected one unindexed translation`);
    continue;
  }
  const text = fs
    .readFileSync(path.join(unindexed_directory, matching[0]!.name), "utf8")
    .replace(/^\uFEFF/u, "");
  const lines = text.split(/\r\n|\n|\r/gu);
  if (lines.at(-1) === "") lines.pop();
  let cursor = 0;
  for (const entry of indexed.entries) {
    const source_lines = entry.source.split(/\r\n|\n|\r/gu);
    const markers = source_lines.map((_, index) => `\u0000FE_SOURCE_${index}\u0000`);
    const pattern = rebuild_fate_extra_indexed_block({
      entry,
      translation: markers.join("\n"),
      restore_index: false,
    });
    let valid = true;
    for (const expected of pattern) {
      const marker =
        expected.startsWith(source_marker_prefix) && expected.endsWith(source_marker_suffix);
      const actual = lines[cursor];
      if (actual === undefined || (!marker && actual !== expected)) {
        unindexed_issues.push(
          `${matching[0]!.name}: structure mismatch at ${entry.path} / char:${entry.char_offset}`,
        );
        valid = false;
        break;
      }
      cursor += 1;
    }
    if (!valid) break;
    unindexed_logical_text_count += 1;
  }
  if (cursor !== lines.length) {
    unindexed_issues.push(
      `${matching[0]!.name}: ${lines.length - cursor} trailing lines could not be mapped`,
    );
  }
}

const result = {
  source_file_count: files.length,
  logical_text_count,
  unique_index_count: unique_keys.size,
  matched_classification_count,
  classification_match_rate:
    logical_text_count === 0 ? 0 : matched_classification_count / logical_text_count,
  issue_count: issues.length,
  issues: issues.slice(0, 20),
  unindexed_file_count: unindexed_files.length,
  unindexed_logical_text_count,
  unindexed_issue_count: unindexed_issues.length,
  unindexed_issues: unindexed_issues.slice(0, 20),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (
  result.source_file_count !== 6 ||
  result.logical_text_count !== 34_693 ||
  result.unique_index_count !== 7_867 ||
  result.classification_match_rate !== 1 ||
  result.issue_count !== 0 ||
  result.unindexed_file_count !== 6 ||
  result.unindexed_logical_text_count !== 34_683 ||
  result.unindexed_issue_count !== 1
) {
  process.exitCode = 1;
}
