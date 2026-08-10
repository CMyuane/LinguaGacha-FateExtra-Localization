import type { FateExtraPassThroughLine } from "./fate-extra-types";

export const FATE_EXTRA_INDEX_LINE_PATTERN = /^(.*?) \| char:(\d+) \| ?(.*)$/u;
export const FATE_EXTRA_SECTION_HEADER_PATTERN = /^===== .* \(\d+ strings\) =====$/u;

export type FateExtraExpectedIndexedText = {
  path: string;
  char_offset: number;
  source: string;
};

export type FateExtraParsedIndexedText = {
  path: string;
  char_offset: number;
  original_prefix: string;
  source: string;
  source_line_numbers: number[];
  pass_through: FateExtraPassThroughLine[];
  header_line_number: number;
};

export type FateExtraIndexedParseResult = {
  entries: FateExtraParsedIndexedText[];
  issues: string[];
  physical_line_count: number;
};

/**
 * Parse the canonical full JP extraction directly.  Unlike the route parser,
 * this source is the authority for text, so it must not depend on the safety
 * database's `source` column.  Section headers and separator blank lines are
 * structural and are not attached to the preceding game string.
 */
export function parse_fate_extra_complete_source(text: string): FateExtraIndexedParseResult {
  const lines = split_physical_lines(text);
  const entries: FateExtraParsedIndexedText[] = [];
  const issues: string[] = [];
  let cursor = 0;
  let seen_section = false;

  while (cursor < lines.length) {
    const line = lines[cursor] ?? "";
    if (FATE_EXTRA_SECTION_HEADER_PATTERN.test(line)) {
      seen_section = true;
      cursor += 1;
      continue;
    }
    if (line === "" || !seen_section) {
      cursor += 1;
      continue;
    }
    const header = FATE_EXTRA_INDEX_LINE_PATTERN.exec(line);
    if (header === null) {
      issues.push(`第 ${cursor + 1} 行不是合法索引头或文件块标题。`);
      cursor += 1;
      continue;
    }

    const path = header[1] ?? "";
    const char_offset = Number(header[2] ?? Number.NaN);
    const original_prefix = `${path} | char:${char_offset} | `;
    const source_lines = [header[3] ?? ""];
    const source_line_numbers = [cursor + 1];
    cursor += 1;
    while (cursor < lines.length) {
      const next = lines[cursor] ?? "";
      if (
        FATE_EXTRA_INDEX_LINE_PATTERN.test(next) ||
        FATE_EXTRA_SECTION_HEADER_PATTERN.test(next)
      ) {
        break;
      }
      // The extraction uses a single empty separator before every section
      // header.  Do not make that separator part of the game string.
      if (next === "" && FATE_EXTRA_SECTION_HEADER_PATTERN.test(lines[cursor + 1] ?? "")) {
        cursor += 1;
        break;
      }
      source_lines.push(next);
      source_line_numbers.push(cursor + 1);
      cursor += 1;
    }
    entries.push({
      path,
      char_offset,
      original_prefix,
      source: source_lines.join("\n"),
      source_line_numbers,
      pass_through: [],
      header_line_number: source_line_numbers[0] ?? 1,
    });
  }

  return { entries, issues, physical_line_count: lines.length };
}

function split_physical_lines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/gu);
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function build_index_key(path: string, char_offset: number): string {
  return `${path}\u0000${char_offset}`;
}

/**
 * Parse Fate/Extra indexed text without treating the index prefix as content.
 * The classification source validates the indexed first line; all following
 * physical lines belong to the same logical game text until the next index.
 */
export function parse_fate_extra_indexed_text(args: {
  text: string;
  expected: FateExtraExpectedIndexedText[];
}): FateExtraIndexedParseResult {
  const lines = split_physical_lines(args.text);
  const expected_by_key = new Map(
    args.expected.map((entry) => [build_index_key(entry.path, entry.char_offset), entry]),
  );
  const entries: FateExtraParsedIndexedText[] = [];
  const issues: string[] = [];

  for (let cursor = 0; cursor < lines.length;) {
    const header = FATE_EXTRA_INDEX_LINE_PATTERN.exec(lines[cursor] ?? "");
    if (header === null) {
      issues.push(`第 ${cursor + 1} 行不是合法索引头。`);
      cursor += 1;
      continue;
    }

    const path = header[1] ?? "";
    const char_offset = Number(header[2] ?? Number.NaN);
    const original_prefix = `${path} | char:${char_offset} | `;
    let block_end = cursor + 1;
    while (
      block_end < lines.length &&
      FATE_EXTRA_INDEX_LINE_PATTERN.exec(lines[block_end] ?? "") === null
    ) {
      block_end += 1;
    }

    const expected = expected_by_key.get(build_index_key(path, char_offset));
    if (expected === undefined) {
      issues.push(`第 ${cursor + 1} 行索引 ${path} / char:${char_offset} 不在分类库中。`);
      cursor = block_end;
      continue;
    }

    const block_lines = [header[3] ?? "", ...lines.slice(cursor + 1, block_end)];
    const classified_source_lines = expected.source.split(/\r\n|\n|\r/gu);
    let classified_cursor = 0;
    const source_line_numbers: number[] = [];
    const pass_through: FateExtraPassThroughLine[] = [];
    for (let block_cursor = 0; block_cursor < block_lines.length; block_cursor += 1) {
      const block_line = block_lines[block_cursor] ?? "";
      if (block_line === classified_source_lines[classified_cursor]) {
        source_line_numbers.push(cursor + block_cursor + 1);
        classified_cursor += 1;
      } else {
        pass_through.push({ after_source_line: classified_cursor - 1, text: block_line });
      }
    }
    if (classified_cursor !== classified_source_lines.length) {
      issues.push(
        `第 ${cursor + 1} 行索引 ${path} / char:${char_offset} 无法按分类库 source 可靠还原。`,
      );
      cursor = block_end;
      continue;
    }
    entries.push({
      path,
      char_offset,
      original_prefix,
      source: expected.source,
      source_line_numbers,
      pass_through,
      header_line_number: cursor + 1,
    });
    cursor = block_end;
  }

  return {
    entries,
    issues,
    physical_line_count: lines.length,
  };
}

export function rebuild_fate_extra_indexed_block(args: {
  entry: FateExtraParsedIndexedText;
  translation: string;
  restore_index: boolean;
}): string[] {
  const source_lines = args.entry.source.split(/\r\n|\n|\r/gu);
  const translated_lines = (args.translation === "" ? args.entry.source : args.translation).split(
    /\r\n|\n|\r/gu,
  );
  const output: string[] = [];
  const line_count = Math.max(source_lines.length, translated_lines.length);

  for (let index = 0; index < line_count; index += 1) {
    const line = translated_lines[index] ?? "";
    output.push(index === 0 && args.restore_index ? `${args.entry.original_prefix}${line}` : line);
    for (const pass_line of args.entry.pass_through) {
      if (pass_line.after_source_line === index) {
        output.push(pass_line.text);
      }
    }
  }

  for (const pass_line of args.entry.pass_through) {
    if (pass_line.after_source_line < 0) {
      output.unshift(pass_line.text);
    }
    if (pass_line.after_source_line >= line_count) {
      output.push(pass_line.text);
    }
  }
  return output;
}
