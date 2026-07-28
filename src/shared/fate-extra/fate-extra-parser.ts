import type { FateExtraPassThroughLine } from "./fate-extra-types";

export const FATE_EXTRA_INDEX_LINE_PATTERN = /^(.*?) \| char:(\d+) \| ?(.*)$/u;

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
    for (const block_line of block_lines) {
      if (block_line === classified_source_lines[classified_cursor]) {
        classified_cursor += 1;
      }
    }
    if (classified_cursor !== classified_source_lines.length) {
      issues.push(
        `第 ${cursor + 1} 行索引 ${path} / char:${char_offset} 无法按分类库 source 可靠还原。`,
      );
      cursor = block_end;
      continue;
    }
    const source_line_numbers = block_lines.map((_, block_cursor) => cursor + block_cursor + 1);

    entries.push({
      path,
      char_offset,
      original_prefix,
      source: block_lines.join("\n"),
      source_line_numbers,
      pass_through: [],
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
