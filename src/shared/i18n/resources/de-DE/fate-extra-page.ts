import { zh_cn_fate_extra_page } from "../zh-CN/fate-extra-page";
import type { LocaleMessageSchema } from "../../types";

export const de_de_fate_extra_page = {
  title: "Fate/Extra-Lokalisierungsadapter",
  description:
    "Indizierte Quellen und Klassifikationsdaten prüfen, Übersetzungen sicher migrieren und PSP-Reimporttexte sowie Schriften exportieren.",
  source_directory: "Ordner der indizierten japanischen Quellen",
  classification_database: "FE-Textsicherheitsdatenbank",
  migration_project: "Altes Übersetzungsprojekt (optional)",
  migration_text_directory: "Ordner mit sechs Übersetzungen ohne Index (optional)",
  output_directory: "Exportordner",
  scan: "Prüfbericht erstellen",
  apply: "FE-Adapter anwenden",
  font_scan: "Schriftabdeckung prüfen",
  export_without_index: "Ohne Indizes exportieren",
  export_restore_index: "Mit Indizes exportieren",
  browse: "Auswählen",
  busy: "Wird verarbeitet…",
  report: "Prüfbericht",
  no_project: "Öffnen Sie zuerst ein .lg-Projekt.",
  scan_ready: "Prüfung abgeschlossen. Der Adapter kann angewendet werden.",
  apply_done: "FE-Adapter angewendet; das ursprüngliche Projekt wurde gesichert.",
  export_done: "Export abgeschlossen. Hinweise haben die Ausgabe nicht blockiert.",
  font_ready: "Schriftabdeckung für den aktuellen Textbestand wurde geprüft.",
} satisfies LocaleMessageSchema<typeof zh_cn_fate_extra_page>;
