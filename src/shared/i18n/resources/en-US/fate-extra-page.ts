import { zh_cn_fate_extra_page } from "../zh-CN/fate-extra-page";
import type { LocaleMessageSchema } from "../../types";

export const en_us_fate_extra_page = {
  title: "Fate/Extra Localization Adapter",
  description:
    "Scan indexed sources and classification data, migrate translations safely, and export PSP reimport text and fonts.",
  source_directory: "Indexed Japanese source folder",
  classification_database: "FE text safety database",
  migration_project: "Legacy translation project (optional)",
  migration_text_directory: "Six unindexed translations folder (optional)",
  output_directory: "Export folder",
  scan: "Create scan report",
  apply: "Apply FE adapter",
  font_scan: "Check font coverage",
  export_without_index: "Export without indexes",
  export_restore_index: "Export with restored indexes",
  browse: "Browse",
  busy: "Working…",
  report: "Scan report",
  no_project: "Open an .lg project first.",
  scan_ready: "Scan complete. The adapter can be applied.",
  apply_done: "FE adapter applied; the original project was backed up.",
  export_done: "Export complete. Advisory FE warnings did not block output.",
  font_ready: "Font coverage scan completed for the current corpus.",
} satisfies LocaleMessageSchema<typeof zh_cn_fate_extra_page>;
