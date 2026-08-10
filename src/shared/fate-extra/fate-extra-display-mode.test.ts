import { describe, expect, it } from "vitest";

import { resolve_fate_extra_display_mode } from "./fate-extra-display-mode";
import type { FateExtraItemMetadata } from "./fate-extra-types";

function metadata(opcode: number | null, portrait_id: number | null): FateExtraItemMetadata {
  return {
    schema_version: 1,
    path: "field/016/0000.dat",
    char_offset: 66674,
    original_prefix: "",
    source_hash: "hash",
    source_line_numbers: [1],
    pass_through: [],
    migration_review: false,
    migration_source: "",
    classification: {
      category: "ordinary_independent_slot",
      category_zh: "普通独立槽位",
      confidence: "high",
      reason: "",
      resource_path: "",
      byte_offset: null,
      source_bytes: null,
      slot_capacity: null,
      slot_end: null,
      allow_overlength: false,
      allow_relocation: false,
      translator_message: "",
      pointer_offsets: [],
      address_limit: null,
      preserve_high16: false,
      shared_storage_group: "",
      shared_group_start: null,
      shared_group_end: null,
      shared_group_members: null,
      format_handler: "",
      display_opcode: opcode,
      portrait_id,
    },
  };
}

describe("resolve_fate_extra_display_mode", () => {
  it("classifies 0x3926 with portrait slot 4 equal to zero as fullscreen", () => {
    expect(resolve_fate_extra_display_mode(metadata(0x3926, 0), "auto").mode).toBe("fullscreen");
  });

  it("classifies 0x3926 with a non-zero portrait as dialogue", () => {
    expect(resolve_fate_extra_display_mode(metadata(0x3926, 9217), "auto").mode).toBe("dialogue");
  });

  it("classifies 0x0126 as poem and leaves missing script evidence unresolved", () => {
    expect(resolve_fate_extra_display_mode(metadata(0x0126, null), "auto").mode).toBe("poem");
    expect(resolve_fate_extra_display_mode(metadata(null, null), "auto").mode).toBe("unknown");
  });
});
