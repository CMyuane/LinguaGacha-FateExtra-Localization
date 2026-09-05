export const FATE_EXTRA_INDEX_PHASES = [
  "checking",
  "cleanup",
  "text-units",
  "navigation",
  "search-mappings",
  "search-documents",
  "publishing",
] as const;

export type FateExtraIndexPhase = (typeof FATE_EXTRA_INDEX_PHASES)[number];

export type FateExtraIndexProgress = {
  phase: FateExtraIndexPhase;
  completed: number;
  total: number | null;
};

export type FateExtraIndexProgressReporter = (progress: FateExtraIndexProgress) => void;

export function is_fate_extra_index_phase(value: string): value is FateExtraIndexPhase {
  return FATE_EXTRA_INDEX_PHASES.some((phase) => phase === value);
}
