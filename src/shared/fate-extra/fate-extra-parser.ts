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

export type FateExtraStreamingParser = {
  push_line(text: string, line_number: number): void;
  finish(): { issues: string[]; physical_line_count: number };
};

/**
 * 完整主库的逐行解析状态机。调用方可以把每个逻辑条目立即写入 SQLite，
 * 无需为了返回数组而长期持有整个主库。
 */
export function create_fate_extra_complete_source_parser(
  on_entry: (entry: FateExtraParsedIndexedText) => void,
  on_issue?: (issue: string) => void,
): FateExtraStreamingParser {
  const issues: string[] = [];
  let seen_section = false;
  let physical_line_count = 0;
  let finished = false;
  let current:
    | {
        path: string;
        char_offset: number;
        original_prefix: string;
        source_lines: string[];
        source_line_numbers: number[];
      }
    | undefined;
  const finish_current = (drop_section_separator: boolean): void => {
    if (current === undefined) return;
    if (drop_section_separator && current.source_lines.at(-1) === "") {
      current.source_lines.pop();
      current.source_line_numbers.pop();
    }
    on_entry({
      path: current.path,
      char_offset: current.char_offset,
      original_prefix: current.original_prefix,
      source: current.source_lines.join("\n"),
      source_line_numbers: current.source_line_numbers,
      pass_through: [],
      header_line_number: current.source_line_numbers[0] ?? 1,
    });
    current = undefined;
  };
  return {
    push_line(text, line_number): void {
      if (finished) throw new Error("FE 完整主库解析器已经结束。");
      physical_line_count = line_number;
      if (FATE_EXTRA_SECTION_HEADER_PATTERN.test(text)) {
        finish_current(true);
        seen_section = true;
        return;
      }
      if (!seen_section) return;
      const header = FATE_EXTRA_INDEX_LINE_PATTERN.exec(text);
      if (header !== null) {
        finish_current(false);
        const indexed_path = header[1] ?? "";
        const char_offset = Number(header[2] ?? Number.NaN);
        current = {
          path: indexed_path,
          char_offset,
          original_prefix: `${indexed_path} | char:${char_offset} | `,
          source_lines: [header[3] ?? ""],
          source_line_numbers: [line_number],
        };
        return;
      }
      if (current === undefined) {
        if (text !== "") {
          const issue = `第 ${line_number} 行不是合法索引头或文件块标题。`;
          if (on_issue === undefined) issues.push(issue);
          else on_issue(issue);
        }
        return;
      }
      current.source_lines.push(text);
      current.source_line_numbers.push(line_number);
    },
    finish(): { issues: string[]; physical_line_count: number } {
      if (!finished) {
        finish_current(false);
        finished = true;
      }
      return { issues, physical_line_count };
    },
  };
}

/**
 * 路线文本的逐行解析状态机。expected 按索引惰性读取，避免构造百万级 Map。
 */
export function create_fate_extra_indexed_text_parser(args: {
  resolve_expected: (path: string, char_offset: number) => FateExtraExpectedIndexedText | undefined;
  on_entry: (entry: FateExtraParsedIndexedText) => void;
  on_issue?: (issue: string) => void;
}): FateExtraStreamingParser {
  const issues: string[] = [];
  let physical_line_count = 0;
  let finished = false;
  let current:
    | {
        path: string;
        char_offset: number;
        original_prefix: string;
        header_line_number: number;
        block_lines: string[];
      }
    | undefined;
  const finish_current = (): void => {
    if (current === undefined) return;
    const expected = args.resolve_expected(current.path, current.char_offset);
    if (expected === undefined) {
      const issue = `第 ${current.header_line_number} 行索引 ${current.path} / char:${current.char_offset} 不在分类库中。`;
      if (args.on_issue === undefined) issues.push(issue);
      else args.on_issue(issue);
      current = undefined;
      return;
    }
    const classified_source_lines = expected.source.split(/\r\n|\n|\r/gu);
    let classified_cursor = 0;
    const source_line_numbers: number[] = [];
    const pass_through: FateExtraPassThroughLine[] = [];
    for (let block_cursor = 0; block_cursor < current.block_lines.length; block_cursor += 1) {
      const block_line = current.block_lines[block_cursor] ?? "";
      if (block_line === classified_source_lines[classified_cursor]) {
        source_line_numbers.push(current.header_line_number + block_cursor);
        classified_cursor += 1;
      } else {
        pass_through.push({ after_source_line: classified_cursor - 1, text: block_line });
      }
    }
    if (classified_cursor !== classified_source_lines.length) {
      const issue = `第 ${current.header_line_number} 行索引 ${current.path} / char:${current.char_offset} 无法按分类库 source 可靠还原。`;
      if (args.on_issue === undefined) issues.push(issue);
      else args.on_issue(issue);
      current = undefined;
      return;
    }
    args.on_entry({
      path: current.path,
      char_offset: current.char_offset,
      original_prefix: current.original_prefix,
      source: expected.source,
      source_line_numbers,
      pass_through,
      header_line_number: current.header_line_number,
    });
    current = undefined;
  };
  return {
    push_line(text, line_number): void {
      if (finished) throw new Error("FE 路线文本解析器已经结束。");
      physical_line_count = line_number;
      const header = FATE_EXTRA_INDEX_LINE_PATTERN.exec(text);
      if (header !== null) {
        finish_current();
        const indexed_path = header[1] ?? "";
        const char_offset = Number(header[2] ?? Number.NaN);
        current = {
          path: indexed_path,
          char_offset,
          original_prefix: `${indexed_path} | char:${char_offset} | `,
          header_line_number: line_number,
          block_lines: [header[3] ?? ""],
        };
        return;
      }
      if (current === undefined) {
        const issue = `第 ${line_number} 行不是合法索引头。`;
        if (args.on_issue === undefined) issues.push(issue);
        else args.on_issue(issue);
        return;
      }
      current.block_lines.push(text);
    },
    finish(): { issues: string[]; physical_line_count: number } {
      if (!finished) {
        finish_current();
        finished = true;
      }
      return { issues, physical_line_count };
    },
  };
}

/**
 * Parse the canonical full JP extraction directly.  Unlike the route parser,
 * this source is the authority for text, so it must not depend on the safety
 * database's `source` column.  Section headers and separator blank lines are
 * structural and are not attached to the preceding game string.
 */
export function parse_fate_extra_complete_source(text: string): FateExtraIndexedParseResult {
  const entries: FateExtraParsedIndexedText[] = [];
  const parser = create_fate_extra_complete_source_parser((entry) => entries.push(entry));
  for (const physical_line of iterate_physical_lines(text)) {
    parser.push_line(physical_line.text, physical_line.line_number);
  }
  return { entries, ...parser.finish() };
}

function* iterate_physical_lines(text: string): Generator<{ text: string; line_number: number }> {
  let start = 0;
  let line_number = 1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 0x0a && code !== 0x0d) continue;
    yield { text: text.slice(start, index), line_number };
    if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) index += 1;
    start = index + 1;
    line_number += 1;
  }
  if (start < text.length) yield { text: text.slice(start), line_number };
}

function build_index_key(path: string, char_offset: number): string {
  return `${path}\u0000${char_offset}`;
}

export function read_fate_extra_index_headers(
  text: string,
): Array<{ path: string; char_offset: number }> {
  const headers: Array<{ path: string; char_offset: number }> = [];
  for (const line of iterate_physical_lines(text)) {
    const header = FATE_EXTRA_INDEX_LINE_PATTERN.exec(line.text);
    if (header === null) continue;
    headers.push({
      path: header[1] ?? "",
      char_offset: Number(header[2] ?? Number.NaN),
    });
  }
  return headers;
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
  const expected_by_key = new Map(
    args.expected.map((entry) => [build_index_key(entry.path, entry.char_offset), entry]),
  );
  const entries: FateExtraParsedIndexedText[] = [];
  const parser = create_fate_extra_indexed_text_parser({
    resolve_expected: (indexed_path, char_offset) =>
      expected_by_key.get(build_index_key(indexed_path, char_offset)),
    on_entry: (entry) => entries.push(entry),
  });

  for (const physical_line of iterate_physical_lines(args.text)) {
    parser.push_line(physical_line.text, physical_line.line_number);
  }
  return { entries, ...parser.finish() };
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
