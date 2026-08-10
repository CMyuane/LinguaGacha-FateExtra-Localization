import type { FateExtraDisplayMode, FateExtraItemMetadata } from "./fate-extra-types";
import type { FateExtraResolvedDisplayMode } from "./fate-extra-layout";

export type FateExtraDisplayModeResolution = {
  mode: FateExtraResolvedDisplayMode;
  source: "manual" | "script" | "format-handler" | "unresolved";
  confidence: "high" | "medium" | "low" | "unknown";
  reason: string;
  opcode: number | null;
  portrait_id: number | null;
};

function normalize_opcode(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

export function resolve_fate_extra_display_mode(
  metadata: FateExtraItemMetadata,
  selected: FateExtraDisplayMode,
): FateExtraDisplayModeResolution {
  const opcode = normalize_opcode(metadata.classification.display_opcode);
  const portrait_id = metadata.classification.portrait_id ?? null;
  if (selected !== "auto") {
    return {
      mode: selected,
      source: "manual",
      confidence: "high",
      reason: "使用当前条目的人工显示类型覆盖。",
      opcode,
      portrait_id,
    };
  }
  if (opcode === 0x0126) {
    return {
      mode: "poem",
      source: "script",
      confidence: "high",
      reason: "脚本指令 0x0126：文本运动/诗文演出。",
      opcode,
      portrait_id,
    };
  }
  if (opcode === 0x3926 && portrait_id !== null) {
    return {
      mode: portrait_id === 0 ? "fullscreen" : "dialogue",
      source: "script",
      confidence: "high",
      reason:
        portrait_id === 0
          ? "脚本指令 0x3926，变量块第 4 槽（当前立绘 ID）为 0：无立绘全屏文本。"
          : `脚本指令 0x3926，变量块第 4 槽（当前立绘 ID）为 ${portrait_id}：角色对白。`,
      opcode,
      portrait_id,
    };
  }
  const handler = metadata.classification.format_handler.toLocaleLowerCase();
  if (handler.includes("poem") || handler.includes("verse") || handler.includes("0x0126")) {
    return {
      mode: "poem",
      source: "format-handler",
      confidence: "medium",
      reason: "格式处理器将该条目标记为诗文/固定演出。",
      opcode,
      portrait_id,
    };
  }
  return {
    mode: "unknown",
    source: "unresolved",
    confidence: "unknown",
    reason: "尚未取得 0x3926/0x0126 脚本指令与当前立绘 ID，禁止自动套用对白换行规则。",
    opcode,
    portrait_id,
  };
}
