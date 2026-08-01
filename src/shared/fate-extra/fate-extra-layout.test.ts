import { describe, expect, it } from "vitest";

import {
  FATE_EXTRA_TEXT_WIDTH,
  has_fate_extra_psp_overflow,
  layout_fate_extra_preview,
  resolve_fate_extra_preview_runs,
} from "./fate-extra-layout";

describe("fate extra PSP layout", () => {
  it("accepts exactly 18 full-width glyphs at 432px", () => {
    const layout = layout_fate_extra_preview({ text: "全".repeat(18) });

    expect(layout.max_width_px).toBe(FATE_EXTRA_TEXT_WIDTH);
    expect(layout.visible_line_count).toBe(1);
    expect(layout.overflow).toBe(false);
  });

  it("marks the nineteenth full-width glyph as overflow", () => {
    const layout = layout_fate_extra_preview({ text: "全".repeat(19) });

    expect(layout.max_width_px).toBe(456);
    expect(layout.overflow).toBe(true);
  });

  it("marks a fourth visible line as overflow", () => {
    const layout = layout_fate_extra_preview({ text: "一\n二\n三\n四" });

    expect(layout.visible_line_count).toBe(4);
    expect(layout.overflow).toBe(true);
  });

  it("marks the item when any servant branch overflows", () => {
    const text = `#SVT[短][短][短][${"长".repeat(19)}]#`;

    expect(layout_fate_extra_preview({ text, state: { servant_index: 0 } }).overflow).toBe(false);
    expect(layout_fate_extra_preview({ text, state: { servant_index: 3 } }).overflow).toBe(true);
    expect(has_fate_extra_psp_overflow(text)).toBe(true);
  });

  it("keeps ruby base and reading as one preview run", () => {
    const runs = resolve_fate_extra_preview_runs({
      text: "#RUBS注音#RUBE正文#REND",
    });

    expect(runs).toEqual([
      {
        text: "正文",
        ruby: "注音",
        color: "#ffffff",
        icon: false,
        advance_px: null,
      },
    ]);
  });
});
