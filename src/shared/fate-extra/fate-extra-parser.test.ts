import { describe, expect, it } from "vitest";

import {
  parse_fate_extra_indexed_text,
  rebuild_fate_extra_indexed_block,
} from "./fate-extra-parser";

describe("fate extra indexed text", () => {
  const path = String.raw`FE_完整提取\pak_unpacked\field\001\0000.dat`;

  it("validates the indexed first line and merges every physical continuation", () => {
    const parsed = parse_fate_extra_indexed_text({
      text: `${path} | char:42 | 第一行\n#CONTROL\n第二行\n`,
      expected: [{ path, char_offset: 42, source: "第一行\n第二行" }],
    });

    expect(parsed.issues).toEqual([]);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({
      path,
      char_offset: 42,
      source: "第一行\n#CONTROL\n第二行",
      source_line_numbers: [1, 2, 3],
      pass_through: [],
    });
  });

  it("rebuilds both index-free and restored-index output", () => {
    const [entry] = parse_fate_extra_indexed_text({
      text: `${path} | char:42 | 第一行\n#CONTROL\n第二行`,
      expected: [{ path, char_offset: 42, source: "第一行" }],
    }).entries;
    expect(entry).toBeDefined();

    expect(
      rebuild_fate_extra_indexed_block({
        entry: entry!,
        translation: "译文一\n#CONTROL\n译文二",
        restore_index: false,
      }),
    ).toEqual(["译文一", "#CONTROL", "译文二"]);
    expect(
      rebuild_fate_extra_indexed_block({
        entry: entry!,
        translation: "译文一\n#CONTROL\n译文二",
        restore_index: true,
      }),
    ).toEqual([`${path} | char:42 | 译文一`, "#CONTROL", "译文二"]);
  });

  it("rejects a source block that cannot be reconciled reliably", () => {
    const parsed = parse_fate_extra_indexed_text({
      text: `${path} | char:42 | 不匹配`,
      expected: [{ path, char_offset: 42, source: "分类库原文" }],
    });

    expect(parsed.entries).toEqual([]);
    expect(parsed.issues).toHaveLength(1);
  });
});
