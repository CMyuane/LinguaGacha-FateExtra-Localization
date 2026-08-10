export const FATE_EXTRA_PSP_WIDTH = 480;
export const FATE_EXTRA_PSP_HEIGHT = 272;
export const FATE_EXTRA_TEXT_WIDTH = 432;
export const FATE_EXTRA_MAX_VISIBLE_LINES = 3;
export const FATE_EXTRA_GLYPH_ADVANCE = 21;
export const FATE_EXTRA_RUBY_GLYPH_ADVANCE = 12;
export const FATE_EXTRA_RUBY_MAX_WIDTH = 192;

export type FateExtraResolvedDisplayMode = "dialogue" | "fullscreen" | "poem" | "unknown";

export const FATE_EXTRA_LAYOUT_PROFILES = {
  dialogue: { line_limits: [20, 20, 20], max_lines: 3 },
  fullscreen: { line_limits: [30, 30, 30, 30, 30, 30, 30, 30], max_lines: 8 },
  poem: { line_limits: [24, 24, 24, 24, 24, 24, 24, 24], max_lines: 8 },
  unknown: { line_limits: [Number.POSITIVE_INFINITY], max_lines: Number.POSITIVE_INFINITY },
} as const;

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
  line_has_ruby: boolean[];
  max_width_px: number;
  visible_line_count: number;
  line_visible_units: number[];
  display_mode: FateExtraResolvedDisplayMode;
  glyph_advance_px: number;
  ruby_overflow: boolean;
  overflow: boolean;
  issues: string[];
};

const FATE_EXTRA_GLYPH_ADVANCE_BY_MODE: Record<FateExtraResolvedDisplayMode, number> = {
  dialogue: FATE_EXTRA_GLYPH_ADVANCE,
  fullscreen: 14,
  poem: 18,
  unknown: FATE_EXTRA_GLYPH_ADVANCE,
};

const FATE_EXTRA_CONTROL_TOKEN_PATTERN =
  /#(?:RUBS|RUBE|REND|C(?:DEF|\d{8,9})|ROFS-?\d+|SIZE\([^)]*\)|SP(?:\([^)]*\)|\d+)|SVT|FAMILY\d*|GIVEN\d*|NICK\d*|ITEM\d*|TITM\d*|TVAL\d*|VAL\d*|TRG\d*|ITALICS|[12])|<ICON[^>]*>/gu;

export function collect_fate_extra_control_tokens(text: string): string[] {
  return text.match(FATE_EXTRA_CONTROL_TOKEN_PATTERN) ?? [];
}

export function has_fate_extra_control_sequence_mismatch(source: string, target: string): boolean {
  const source_tokens = collect_fate_extra_control_tokens(source);
  const target_tokens = collect_fate_extra_control_tokens(target);
  return (
    source_tokens.length !== target_tokens.length ||
    source_tokens.some((token, index) => token !== target_tokens[index])
  );
}

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
  display_mode?: FateExtraResolvedDisplayMode;
  line_limit?: number;
}): FateExtraPreviewLayout {
  const runs = resolve_fate_extra_preview_runs(args);
  const display_mode = args.display_mode ?? "dialogue";
  const base_profile = FATE_EXTRA_LAYOUT_PROFILES[display_mode];
  const glyph_advance_px = FATE_EXTRA_GLYPH_ADVANCE_BY_MODE[display_mode];
  const requested_limit = Math.trunc(Number(args.line_limit ?? 0));
  const profile =
    requested_limit > 0 && Number.isFinite(requested_limit)
      ? {
          line_limits: Array.from({ length: base_profile.max_lines }, () => requested_limit),
          max_lines: base_profile.max_lines,
        }
      : base_profile;
  const line_widths_px = [0];
  const line_visible_units = [0];
  const line_has_ruby = [false];
  const visible_parts: string[] = [];
  let line = 0;
  let ruby_overflow = false;

  for (const run of runs) {
    if (run.text === "\n") {
      visible_parts.push("\n");
      line += 1;
      line_widths_px.push(0);
      line_visible_units.push(0);
      line_has_ruby.push(false);
      continue;
    }
    const width =
      run.advance_px ?? (run.icon ? glyph_advance_px : [...run.text].length * glyph_advance_px);
    line_widths_px[line] = (line_widths_px[line] ?? 0) + width;
    line_visible_units[line] =
      (line_visible_units[line] ?? 0) +
      (run.advance_px !== null
        ? Math.ceil(run.advance_px / glyph_advance_px)
        : run.icon
          ? 1
          : [...run.text].length);
    visible_parts.push(run.text);
    if (run.ruby !== "") {
      line_has_ruby[line] = true;
    }
    if ([...run.ruby].length * FATE_EXTRA_RUBY_GLYPH_ADVANCE > FATE_EXTRA_RUBY_MAX_WIDTH) {
      ruby_overflow = true;
    }
  }

  const max_width_px = Math.max(...line_widths_px);
  const width_overflow =
    display_mode !== "unknown" &&
    line_visible_units.some(
      (units, index) => units > (profile.line_limits[index] ?? profile.line_limits.at(-1) ?? 0),
    );
  const line_overflow = display_mode !== "unknown" && line_widths_px.length > profile.max_lines;
  const issues: string[] = [];
  if (width_overflow) {
    const details = line_visible_units
      .map((units, index) => `${index + 1}:${units}/${profile.line_limits[index] ?? "-"}`)
      .join("，");
    issues.push(`${display_mode} 文本可见字符超过当前行上限（${details}）。`);
  }
  if (line_overflow) {
    issues.push(
      `正文共有 ${line_widths_px.length} 行，超过 ${display_mode} 模式上限 ${profile.max_lines} 行。`,
    );
  }
  if (ruby_overflow) {
    issues.push(`Ruby 读音宽度超过 ${FATE_EXTRA_RUBY_MAX_WIDTH}px。`);
  }
  if (display_mode === "unknown") {
    issues.push("脚本显示类型尚未解析；请人工确认对白、全屏文本或诗文模式后再判定溢出。");
  }
  return {
    runs,
    visible_text: visible_parts.join(""),
    line_widths_px,
    line_has_ruby,
    max_width_px,
    visible_line_count: line_widths_px.length,
    line_visible_units,
    display_mode,
    glyph_advance_px,
    ruby_overflow,
    overflow: width_overflow || line_overflow || ruby_overflow,
    issues,
  };
}

export function has_fate_extra_psp_overflow(
  text: string,
  display_mode: FateExtraResolvedDisplayMode = "dialogue",
): boolean {
  for (let servant_index = 0; servant_index < 4; servant_index += 1) {
    for (let gender_index = 0; gender_index < 2; gender_index += 1) {
      if (
        layout_fate_extra_preview({
          text,
          display_mode,
          state: { servant_index, gender_index },
        }).overflow
      ) {
        return true;
      }
    }
  }
  return false;
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
