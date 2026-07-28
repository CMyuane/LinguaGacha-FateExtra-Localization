import { describe, expect, it } from "vitest";

import { layout_fate_extra_preview, resolve_fate_extra_preview_runs } from "./fate-extra-layout";

describe("fate extra PSP layout", () => {
  it("keeps width as a neutral measurement without a universal threshold", () => {
    const layout = layout_fate_extra_preview({ text: "全".repeat(19) });

    expect(layout.max_width_px).toBe(456);
    expect(layout.visible_line_count).toBe(1);
  });

  it("keeps all physical lines as a neutral measurement", () => {
    const layout = layout_fate_extra_preview({ text: "一\n二\n三\n四" });

    expect(layout.visible_line_count).toBe(4);
  });

  it("measures the selected servant branch without assigning a warning", () => {
    const text = `#SVT[短][短][短][${"长".repeat(19)}]#`;

    expect(layout_fate_extra_preview({ text, state: { servant_index: 0 } }).max_width_px).toBe(24);
    expect(layout_fate_extra_preview({ text, state: { servant_index: 3 } }).max_width_px).toBe(456);
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
