import type { JsonValue } from "../utils/json-tool";

export const FATE_EXTRA_ADAPTER_META_KEY = "fate_extra.adapter.v1";
export const FATE_EXTRA_ITEM_NAMESPACE = "__linguagacha_fe_v1";
export const FATE_EXTRA_SCHEMA_VERSION = 1;

export const FATE_EXTRA_DEFAULT_CLASSIFICATION_DATABASE =
  "D:\\AA_Fe_Transition\\文本安全分类\\FE文本安全分类.sqlite";
export const FATE_EXTRA_DEFAULT_INDEXED_SOURCE_DIRECTORY =
  "D:\\AA_Fe_Transition\\灵瓜处理\\最终文本分支_带索引日文原版";
export const FATE_EXTRA_DEFAULT_LEGACY_PROJECT = "D:\\灵瓜\\FE_尼禄线_凛分支_保留索引日文.lg";
export const FATE_EXTRA_DEFAULT_UNINDEXED_TRANSLATION_DIRECTORY = "D:\\AA_Fe_Transition\\灵瓜处理";

export type FateExtraClassification = {
  category: string;
  category_zh: string;
  confidence: string;
  reason: string;
  resource_path: string;
  byte_offset: number | null;
  source_bytes: number | null;
  slot_capacity: number | null;
  slot_end: number | null;
  allow_overlength: boolean;
  allow_relocation: boolean;
  translator_message: string;
  pointer_offsets: number[];
  address_limit: number | null;
  preserve_high16: boolean;
  shared_storage_group: string;
  shared_group_start: number | null;
  shared_group_end: number | null;
  shared_group_members: number | null;
  format_handler: string;
};

export type FateExtraPassThroughLine = {
  after_source_line: number;
  text: string;
};

export type FateExtraItemMetadata = {
  schema_version: 1;
  path: string;
  char_offset: number;
  original_prefix: string;
  source_hash: string;
  source_line_numbers: number[];
  pass_through: FateExtraPassThroughLine[];
  classification: FateExtraClassification;
  migration_review: boolean;
  migration_source: string;
};

export type FateExtraAdapterMetadata = {
  schema_version: 1;
  enabled: true;
  applied_at: string;
  source_directory: string;
  classification_database: string;
  source_file_count: number;
  logical_text_count: number;
  unique_index_count: number;
  matched_classification_count: number;
  rules_version: string;
  file_formats: FateExtraFileFormat[];
  font_corpus_hash: string;
  font_manifest_hash: string;
  remaining_extension_slots: number;
};

export type FateExtraFileFormat = {
  relative_path: string;
  encoding: "utf-8" | "utf-8-bom";
  eol: "\r\n" | "\n" | "\r";
  trailing_eol: boolean;
};

export function read_fate_extra_item_metadata(
  extra_field: JsonValue | undefined,
): FateExtraItemMetadata | null {
  if (typeof extra_field !== "object" || extra_field === null || Array.isArray(extra_field)) {
    return null;
  }
  const namespaced = extra_field[FATE_EXTRA_ITEM_NAMESPACE];
  if (typeof namespaced !== "object" || namespaced === null || Array.isArray(namespaced)) {
    return null;
  }
  const candidate = namespaced as Record<string, JsonValue>;
  const path = candidate["path"];
  const char_offset = candidate["char_offset"];
  const classification = candidate["classification"];
  if (
    candidate["schema_version"] !== FATE_EXTRA_SCHEMA_VERSION ||
    typeof path !== "string" ||
    typeof char_offset !== "number" ||
    typeof classification !== "object" ||
    classification === null ||
    Array.isArray(classification)
  ) {
    return null;
  }
  return namespaced as unknown as FateExtraItemMetadata;
}

export function merge_fate_extra_item_metadata(
  extra_field: JsonValue | undefined,
  metadata: FateExtraItemMetadata,
): JsonValue {
  const base =
    typeof extra_field === "object" && extra_field !== null && !Array.isArray(extra_field)
      ? { ...extra_field }
      : {};
  return {
    ...base,
    [FATE_EXTRA_ITEM_NAMESPACE]: metadata as unknown as JsonValue,
  };
}
