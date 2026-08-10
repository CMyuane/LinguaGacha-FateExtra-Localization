import { describe, expect, it } from "vitest";

import {
  has_fate_extra_control_sequence_mismatch,
  has_fate_extra_psp_overflow,
  layout_fate_extra_preview,
  resolve_fate_extra_preview_runs,
} from "./fate-extra-layout";

describe("fate extra PSP layout", () => {
  it("accepts exactly 20 visible glyphs on a dialogue line", () => {
    const layout = layout_fate_extra_preview({ text: "全".repeat(20) });

    expect(layout.max_width_px).toBe(20 * 21);
    expect(layout.visible_line_count).toBe(1);
    expect(layout.overflow).toBe(false);
  });

  it("marks the twenty-first dialogue glyph as overflow", () => {
    const layout = layout_fate_extra_preview({ text: "全".repeat(21) });

    expect(layout.max_width_px).toBe(21 * 21);
    expect(layout.overflow).toBe(true);
  });

  it("uses an independent 30-character fullscreen limit", () => {
    expect(
      layout_fate_extra_preview({ text: "全".repeat(30), display_mode: "fullscreen" }).overflow,
    ).toBe(false);
    expect(
      layout_fate_extra_preview({ text: "全".repeat(31), display_mode: "fullscreen" }).overflow,
    ).toBe(true);
  });

  it("marks a fourth visible line as overflow", () => {
    const layout = layout_fate_extra_preview({ text: "一\n二\n三\n四" });

    expect(layout.visible_line_count).toBe(4);
    expect(layout.overflow).toBe(true);
  });

  it("marks the item when any servant branch overflows", () => {
    const text = `#SVT[短][短][短][${"长".repeat(23)}]#`;

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

  it("records ruby ownership on the current visual line", () => {
    const layout = layout_fate_extra_preview({
      text: "上一行\n#RUBSりゅうどう#RUBE柳洞#REND一成",
      display_mode: "fullscreen",
    });

    expect(layout.line_has_ruby).toEqual([false, true]);
    expect(layout.line_visible_units).toEqual([3, 4]);
  });

  it("applies FE decimal RGB color controls and resets after ruby", () => {
    const runs = resolve_fate_extra_preview_runs({
      text: "白#C120200255#RUBSりゅうどう#RUBE柳洞一成#REND#CDEF白",
    });

    expect(runs).toEqual([
      { text: "白", ruby: "", color: "#ffffff", icon: false, advance_px: null },
      {
        text: "柳洞一成",
        ruby: "りゅうどう",
        color: "#78c8ff",
        icon: false,
        advance_px: null,
      },
      { text: "白", ruby: "", color: "#ffffff", icon: false, advance_px: null },
    ]);
  });

  it("detects color and ruby control loss in a translated layer", () => {
    const source = "#C120200255#RUBSりゅうどう#RUBE柳洞一成#REND#CDEF";
    expect(has_fate_extra_control_sequence_mismatch(source, source)).toBe(false);
    expect(has_fate_extra_control_sequence_mismatch(source, "柳洞一成")).toBe(true);
  });
});
