import { describe, expect, it } from "vitest";

import { NAVIGATION_GROUPS } from "./schema";

describe("NAVIGATION_GROUPS", () => {
  it("按工作流分成五个稳定区域并保持区内功能顺序", () => {
    expect(
      NAVIGATION_GROUPS.map((group) => ({
        id: group.id,
        items: group.items.map((item) => item.id),
      })),
    ).toEqual([
      { id: "project", items: ["model"] },
      { id: "task", items: ["workbench", "proofreading", "fate-extra-preview"] },
      { id: "setting", items: ["basic-settings", "expert-settings"] },
      {
        id: "quality",
        items: ["glossary", "text-preserve", "text-replacement", "custom-prompt"],
      },
      { id: "extra", items: ["laboratory", "toolbox"] },
    ]);
  });

  it("保留文本替换和自定义提示词的二级入口", () => {
    const items = NAVIGATION_GROUPS.flatMap((group) => group.items);

    expect(
      items.find((item) => item.id === "text-replacement")?.children?.map(({ id }) => id),
    ).toEqual(["pre-translation-replacement", "post-translation-replacement"]);
    expect(
      items.find((item) => item.id === "custom-prompt")?.children?.map(({ id }) => id),
    ).toEqual(["translation-prompt", "analysis-prompt"]);
  });
});
