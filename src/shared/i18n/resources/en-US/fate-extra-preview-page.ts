import { zh_cn_fate_extra_preview_page } from "../zh-CN/fate-extra-preview-page";
import type { LocaleMessageSchema } from "../../types";

export const en_us_fate_extra_preview_page = {
  title: "PSP Screen Preview",
  description:
    "Review source, translation, and every conditional branch in the Fate/Extra 480×272 dialogue layout.",
  source: "Source",
  translation: "Translation",
  previous: "Previous",
  next: "Next",
  jump_to: "Jump to item",
  jump: "Go",
  search: "Search text or file",
  all_files: "All files",
  all_warnings: "All warnings",
  overflow_only: "Overflow only",
  servant: "Servant",
  gender: "Gender",
  male: "Male protagonist",
  female: "Female protagonist",
  empty: "This project contains no FE-adapted text.",
  overflow: "Overflow",
  safe: "Fits",
  unsaved: "Unsaved",
  load_failed: "Failed to load PSP preview text",
  retranslate_started: "Retranslation started for the current item",
} satisfies LocaleMessageSchema<typeof zh_cn_fate_extra_preview_page>;
