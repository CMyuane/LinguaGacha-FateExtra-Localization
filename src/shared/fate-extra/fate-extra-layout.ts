export const FATE_EXTRA_PSP_WIDTH = 480;
export const FATE_EXTRA_PSP_HEIGHT = 272;
export const FATE_EXTRA_GLYPH_ADVANCE = 24;

export type FateExtraPreviewVariables = {
  family: string;
  given: string;
  nick: string;
  item: string;
  value: string;
};

export type FateExtraBranchState = {
  servant_index: number;
  gender_index: number;
};

export type FateExtraPreviewRun = {
  text: string;
  color: string;
  ruby: string;
  icon: boolean;
  advance_px: number | null;
};

export type FateExtraPreviewLayout = {
  runs: FateExtraPreviewRun[];
  visible_text: string;
  line_widths_px: number[];
  max_width_px: number;
  visible_line_count: number;
};

export const FATE_EXTRA_DEFAULT_PREVIEW_VARIABLES: FateExtraPreviewVariables = {
  family: "岸波",
  given: "白野",
  nick: "御主",
  item: "灵子",
  value: "999",
};

type BracketGroups = {
  groups: string[];
  cursor: number;
};

function read_bracket_groups(text: string, start: number): BracketGroups | null {
  const groups: string[] = [];
  let cursor = start;
  while (cursor < text.length && text[cursor] === "[") {
    const content_start = cursor + 1;
    let depth = 1;
    cursor += 1;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === "[") {
        depth += 1;
      } else if (text[cursor] === "]") {
        depth -= 1;
      }
      cursor += 1;
    }
    if (depth !== 0) {
      return null;
    }
    groups.push(text.slice(content_start, cursor - 1));
  }
  return groups.length > 0 ? { groups, cursor } : null;
}

function split_inline_options(text: string): string[] {
  const output: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "[") {
      depth += 1;
    } else if (char === "]" && depth > 0) {
      depth -= 1;
    } else if (char === "/" && depth === 0) {
      output.push(text.slice(start, index));
      start = index + 1;
    }
  }
  output.push(text.slice(start));
  return output;
}

function is_shared_branch_hash(text: string, cursor: number): boolean {
  if (text[cursor] !== "#") {
    return false;
  }
  return /^(?:#SVT\[|#\[|#C|#RUB|#REND|#ROFS|#SIZE|#VAL|#ITEM|#TITM|#TVAL|#TRG|#SP|#T|#S|#ITALICS|#[12])/u.test(
    text.slice(cursor),
  );
}

function normalize_color(token: string, fallback: string): string {
  if (token === "#CDEF") {
    return "#ffffff";
  }
  const digits = token.slice(2);
  if (!/^\d{8,9}$/u.test(digits)) {
    return fallback;
  }
  const rgb =
    digits.length === 9
      ? [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)]
      : [digits.slice(0, 2), digits.slice(2, 5), digits.slice(5, 8)];
  return `#${rgb
    .map((part) =>
      Math.max(0, Math.min(255, Number(part)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function read_variable(token: string, variables: FateExtraPreviewVariables): string {
  if (token.startsWith("#FAMILY")) return variables.family;
  if (token.startsWith("#GIVEN")) return variables.given;
  if (token.startsWith("#NICK")) return variables.nick;
  if (token.startsWith("#ITEM") || token.startsWith("#TITM")) return variables.item;
  return variables.value;
}

export function resolve_fate_extra_preview_runs(args: {
  text: string;
  state?: Partial<FateExtraBranchState>;
  variables?: Partial<FateExtraPreviewVariables>;
}): FateExtraPreviewRun[] {
  const variables = { ...FATE_EXTRA_DEFAULT_PREVIEW_VARIABLES, ...args.variables };
  const state = {
    servant_index: Math.max(0, Math.trunc(args.state?.servant_index ?? 0)),
    gender_index: Math.max(0, Math.trunc(args.state?.gender_index ?? 0)),
  };

  function parse(
    value: string,
    inherited_color: string,
  ): {
    runs: FateExtraPreviewRun[];
    color: string;
  } {
    const runs: FateExtraPreviewRun[] = [];
    let color = inherited_color;
    let plain = "";
    const flush = (): void => {
      if (plain !== "") {
        runs.push({ text: plain, color, ruby: "", icon: false, advance_px: null });
        plain = "";
      }
    };

    for (let cursor = 0; cursor < value.length;) {
      if (value[cursor] === "\n" || value.startsWith("\\n", cursor)) {
        flush();
        runs.push({ text: "\n", color, ruby: "", icon: false, advance_px: null });
        cursor += value[cursor] === "\n" ? 1 : 2;
        continue;
      }

      if (value.startsWith("#RUBS", cursor)) {
        const base_marker = value.indexOf("#RUBE", cursor + 5);
        const end_marker = base_marker < 0 ? -1 : value.indexOf("#REND", base_marker + 5);
        if (base_marker >= 0 && end_marker >= 0) {
          flush();
          const ruby = value.slice(cursor + 5, base_marker);
          let base = value.slice(base_marker + 5, end_marker);
          if (/^ [A-Z]/u.test(base)) {
            base = base.slice(1);
          }
          runs.push({ text: base, color, ruby, icon: false, advance_px: null });
          cursor = end_marker + 5;
          continue;
        }
      }

      if (value.startsWith("#SVT[", cursor) || value.startsWith("#[", cursor)) {
        const servant = value.startsWith("#SVT[", cursor);
        const parsed = read_bracket_groups(value, cursor + (servant ? 4 : 1));
        const valid_count = servant
          ? parsed !== null && (parsed.groups.length === 3 || parsed.groups.length === 4)
          : parsed !== null && parsed.groups.length === 2;
        if (valid_count && parsed !== null && value[parsed.cursor] === "#") {
          flush();
          const branch_index = servant ? state.servant_index : state.gender_index;
          const selected = parsed.groups[Math.min(branch_index, parsed.groups.length - 1)] ?? "";
          const branch = parse(selected, color);
          runs.push(...branch.runs);
          color = branch.color;
          cursor = is_shared_branch_hash(value, parsed.cursor) ? parsed.cursor : parsed.cursor + 1;
          continue;
        }
      }

      if (value[cursor] === "[") {
        const parsed = read_bracket_groups(value, cursor);
        if (parsed !== null && parsed.groups.length === 1 && value[parsed.cursor] === "#") {
          const choices = split_inline_options(parsed.groups[0] ?? "");
          if (choices.length >= 2) {
            flush();
            const selected = choices[Math.min(state.gender_index, choices.length - 1)] ?? "";
            const branch = parse(selected, color);
            runs.push(...branch.runs);
            color = branch.color;
            cursor = is_shared_branch_hash(value, parsed.cursor)
              ? parsed.cursor
              : parsed.cursor + 1;
            continue;
          }
        }
      }

      const tail = value.slice(cursor);
      const color_match = /^#C(?:DEF|\d{8,9})/u.exec(tail);
      if (color_match !== null) {
        flush();
        color = normalize_color(color_match[0], color);
        cursor += color_match[0].length;
        continue;
      }
      const space_match = /^#SP(?:\((\d+)\)|(\d+))/u.exec(tail);
      if (space_match !== null) {
        flush();
        runs.push({
          text: "",
          color,
          ruby: "",
          icon: false,
          advance_px: Number(space_match[1] ?? space_match[2] ?? 0),
        });
        cursor += space_match[0].length;
        continue;
      }
      const variable_match = /^#(?:FAMILY|GIVEN|NICK|ITEM|TITM|TVAL|VAL)\d*/u.exec(tail);
      if (variable_match !== null) {
        flush();
        runs.push({
          text: read_variable(variable_match[0], variables),
          color,
          ruby: "",
          icon: false,
          advance_px: null,
        });
        cursor += variable_match[0].length;
        continue;
      }
      const icon_match = /^<ICON[^>]*>/u.exec(tail);
      if (icon_match !== null) {
        flush();
        runs.push({ text: "", color, ruby: "", icon: true, advance_px: null });
        cursor += icon_match[0].length;
        continue;
      }
      const control_match =
        /^(?:#SIZE\([^)]*\)|#ROFS(?:-\d{3}|\d{4})|#TRG\d|#T\d|#S\d|#[12]|#ITALICS|#RUB(?![A-Z])|#[A-Z][A-Z0-9_]*)/u.exec(
          tail,
        );
      if (control_match !== null) {
        flush();
        cursor += control_match[0].length;
        continue;
      }
      if (value[cursor] === "#") {
        flush();
        cursor += 1;
        continue;
      }
      plain += value[cursor] ?? "";
      cursor += 1;
    }
    flush();
    return { runs, color };
  }

  return parse(args.text, "#ffffff").runs;
}

export function layout_fate_extra_preview(args: {
  text: string;
  state?: Partial<FateExtraBranchState>;
  variables?: Partial<FateExtraPreviewVariables>;
}): FateExtraPreviewLayout {
  const runs = resolve_fate_extra_preview_runs(args);
  const line_widths_px = [0];
  const visible_parts: string[] = [];
  let line = 0;

  for (const run of runs) {
    if (run.text === "\n") {
      visible_parts.push("\n");
      line += 1;
      line_widths_px.push(0);
      continue;
    }
    const width =
      run.advance_px ??
      (run.icon ? FATE_EXTRA_GLYPH_ADVANCE : [...run.text].length * FATE_EXTRA_GLYPH_ADVANCE);
    line_widths_px[line] = (line_widths_px[line] ?? 0) + width;
    visible_parts.push(run.text);
  }

  const max_width_px = Math.max(...line_widths_px);
  return {
    runs,
    visible_text: visible_parts.join(""),
    line_widths_px,
    max_width_px,
    visible_line_count: line_widths_px.length,
  };
}

export function collect_fate_extra_visible_characters(text: string): Set<string> {
  const output = new Set<string>();
  for (let servant_index = 0; servant_index < 4; servant_index += 1) {
    for (let gender_index = 0; gender_index < 2; gender_index += 1) {
      const layout = layout_fate_extra_preview({
        text,
        state: { servant_index, gender_index },
      });
      for (const char of layout.visible_text.replace(/\n/gu, "")) {
        if (char.trim() !== "") {
          output.add(char);
        }
      }
      for (const run of layout.runs) {
        for (const char of run.ruby) {
          if (char.trim() !== "") {
            output.add(char);
          }
        }
      }
    }
  }
  return output;
}
