import { resolve_fate_extra_display_mode } from "./fate-extra-display-mode";
import { has_fate_extra_psp_overflow } from "./fate-extra-layout";
import {
  FATE_EXTRA_OVERFLOW_WARNING_CODE,
  FATE_EXTRA_SAFETY_BLOCKER_CODE,
  FATE_EXTRA_STORAGE_WARNING_CODE,
  read_fate_extra_display_mode,
  read_fate_extra_proofread_translation,
  resolve_fate_extra_effective_translation,
  type FateExtraItemMetadata,
} from "./fate-extra-types";

export const FATE_EXTRA_MIGRATION_WARNING_CODE = "FE_MIGRATION_REVIEW";

export const FATE_EXTRA_PREVIEW_WARNING_CODES = [
  FATE_EXTRA_OVERFLOW_WARNING_CODE,
  FATE_EXTRA_STORAGE_WARNING_CODE,
  FATE_EXTRA_SAFETY_BLOCKER_CODE,
  FATE_EXTRA_MIGRATION_WARNING_CODE,
] as const;

export type FateExtraPreviewWarningCode = (typeof FATE_EXTRA_PREVIEW_WARNING_CODES)[number];

export type FateExtraPreviewWarningEvaluation = {
  warnings: FateExtraPreviewWarningCode[];
  overflow: boolean;
  storage_overflow: boolean;
  safety_blocker: boolean;
  translated: string;
  effective: string;
  proofread_translation: string;
  resolved_display_mode: ReturnType<typeof resolve_fate_extra_display_mode>["mode"];
  encoded_bytes: number;
};

export function is_fate_extra_preview_warning_code(
  value: string,
): value is FateExtraPreviewWarningCode {
  return (FATE_EXTRA_PREVIEW_WARNING_CODES as readonly string[]).includes(value);
}

/** Evaluate one selected warning without paying for unrelated layout/codec work. */
export function has_fate_extra_preview_warning(args: {
  warning: FateExtraPreviewWarningCode;
  src: string;
  dst: string;
  metadata: FateExtraItemMetadata;
  measure_encoded_bytes: (text: string) => number;
}): boolean {
  if (args.warning === FATE_EXTRA_MIGRATION_WARNING_CODE) return args.metadata.migration_review;
  if (args.warning === FATE_EXTRA_SAFETY_BLOCKER_CODE) {
    return args.metadata.classification.category === "unresolved_candidate";
  }
  const translated = resolve_fate_extra_effective_translation(args.dst, args.metadata);
  const effective = translated === "" ? args.src : translated;
  if (args.warning === FATE_EXTRA_STORAGE_WARNING_CODE) {
    const capacity = args.metadata.classification.slot_capacity;
    return (
      capacity !== null &&
      !args.metadata.classification.allow_overlength &&
      args.measure_encoded_bytes(effective) > capacity
    );
  }
  const resolved_display_mode = resolve_fate_extra_display_mode(
    args.metadata,
    read_fate_extra_display_mode(args.metadata),
  ).mode;
  return has_fate_extra_psp_overflow(effective, resolved_display_mode);
}

/**
 * 预览列表与只读查询 worker 共用同一 warning 语义，避免分页条件和响应徽标发生漂移。
 */
export function evaluate_fate_extra_preview_warnings(args: {
  src: string;
  dst: string;
  metadata: FateExtraItemMetadata;
  measure_encoded_bytes: (text: string) => number;
}): FateExtraPreviewWarningEvaluation {
  const proofread_translation = read_fate_extra_proofread_translation(args.metadata);
  const translated = resolve_fate_extra_effective_translation(args.dst, args.metadata);
  const effective = translated === "" ? args.src : translated;
  const resolved_display_mode = resolve_fate_extra_display_mode(
    args.metadata,
    read_fate_extra_display_mode(args.metadata),
  ).mode;
  const encoded_bytes = args.measure_encoded_bytes(effective);
  const capacity = args.metadata.classification.slot_capacity;
  const storage_overflow =
    capacity !== null && !args.metadata.classification.allow_overlength && encoded_bytes > capacity;
  const safety_blocker = args.metadata.classification.category === "unresolved_candidate";
  const overflow = has_fate_extra_psp_overflow(effective, resolved_display_mode);
  const warnings: FateExtraPreviewWarningCode[] = [];
  if (overflow) warnings.push(FATE_EXTRA_OVERFLOW_WARNING_CODE as FateExtraPreviewWarningCode);
  if (storage_overflow)
    warnings.push(FATE_EXTRA_STORAGE_WARNING_CODE as FateExtraPreviewWarningCode);
  if (safety_blocker) warnings.push(FATE_EXTRA_SAFETY_BLOCKER_CODE as FateExtraPreviewWarningCode);
  if (args.metadata.migration_review) warnings.push(FATE_EXTRA_MIGRATION_WARNING_CODE);
  return {
    warnings,
    overflow,
    storage_overflow,
    safety_blocker,
    translated,
    effective,
    proofread_translation,
    resolved_display_mode,
    encoded_bytes,
  };
}
