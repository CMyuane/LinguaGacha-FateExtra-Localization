import { describe, expect, it } from "vitest";

import { FateExtraGameTextCodec } from "./fate-extra-text-codec";

describe("FateExtraGameTextCodec", () => {
  it("uses explicit glyph widths before native and future-extension defaults", () => {
    const codec = FateExtraGameTextCodec.from_records([
      { char: "}", encoded_hex: "F044" },
      { char: "日", encoded_hex: "93FA" },
      { char: "中", encoded_hex: "F040" },
    ]);

    expect(codec.encoded_length("Aｱ}日中新")).toBe(1 + 1 + 2 + 2 + 2 + 2);
  });

  it("counts literal controls and physical line breaks as game bytes", () => {
    const codec = FateExtraGameTextCodec.from_records([]);

    expect(codec.encoded_length("#CDEF\n中")).toBe(6 + 2);
  });

  it("returns remaining and exceeded bytes without adding terminators or padding", () => {
    const codec = FateExtraGameTextCodec.from_records([]);

    expect(codec.measure("中文", 5)).toEqual({
      encoded_bytes: 4,
      slot_capacity: 5,
      remaining_bytes: 1,
      exceeded_bytes: 0,
      over_capacity: false,
    });
    expect(codec.measure("中文本", 5)).toEqual({
      encoded_bytes: 6,
      slot_capacity: 5,
      remaining_bytes: -1,
      exceeded_bytes: 1,
      over_capacity: true,
    });
  });
});
