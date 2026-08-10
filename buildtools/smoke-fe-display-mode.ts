import { FateExtraService } from "../src/backend/toolbox/fate-extra-service";

const item = {
  id: 7,
  src: "原文",
  dst: "",
  extra_field: {
    __linguagacha_fe_v1: {
      schema_version: 1,
      path: "field/001/0000.dat",
      char_offset: 123,
      original_prefix: "field/001/0000.dat | char:123 | ",
      source_hash: "",
      source_line_numbers: [1],
      pass_through: [],
      migration_review: false,
      migration_source: "smoke",
      proofread_translation: "",
      display_mode: "auto",
      classification: {
        category: "ordinary_independent_slot",
        category_zh: "普通独立槽位",
        confidence: "confirmed",
        reason: "smoke",
        resource_path: "field/001/0000.dat",
        byte_offset: 123,
        source_bytes: 8,
        slot_capacity: 16,
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
      },
    },
  },
};

let metadataWrites = 0;
let unitWrites = 0;
const service = new FateExtraService(
  {} as never,
  {
    execute(operation: { name: string }) {
      if (operation.name === "getItemsByIds") return [item];
      return [];
    },
  } as never,
  { snapshot: () => ({ loaded: true, projectPath: "smoke.lg" }) } as never,
  {} as never,
  {
    async apply_fate_extra_item_metadata() {
      metadataWrites += 1;
      return { accepted: true, changes: [] };
    },
    async apply_fate_extra_text_unit_review() {
      unitWrites += 1;
      return { accepted: true, changes: [] };
    },
  } as never,
  {} as never,
  {} as never,
);

async function main(): Promise<void> {
  await service.save_review({
    item_id: 7,
    text_unit_id: 3,
    review_scope: "unit",
    proofread_translation: "",
    display_mode: "fullscreen",
    expected_section_revisions: { items: 1, proofreading: 2 },
  });

  if (metadataWrites !== 1 || unitWrites !== 0) {
    throw new Error(JSON.stringify({ metadataWrites, unitWrites }));
  }
  console.log(JSON.stringify({ ok: true, metadataWrites, unitWrites }));
}

void main();
