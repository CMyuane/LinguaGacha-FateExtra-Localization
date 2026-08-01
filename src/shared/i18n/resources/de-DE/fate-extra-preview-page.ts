import { zh_cn_fate_extra_preview_page } from "../zh-CN/fate-extra-preview-page";
import type { LocaleMessageSchema } from "../../types";

export const de_de_fate_extra_preview_page = {
  title: "PSP-Bildvorschau",
  description:
    "Quelltext, Übersetzung und alle Bedingungen im 480×272-Dialoglayout von Fate/Extra prüfen.",
  source: "Quelle",
  translation: "Übersetzung",
  previous: "Zurück",
  next: "Weiter",
  jump_to: "Zu Eintrag springen",
  jump: "Los",
  search: "Text oder Datei suchen",
  all_files: "Alle Dateien",
  all_warnings: "Alle Hinweise",
  overflow_only: "Nur Überlauf",
  servant: "Servant",
  gender: "Geschlecht",
  male: "Männlicher Protagonist",
  female: "Weibliche Protagonistin",
  empty: "Dieses Projekt enthält keine FE-adaptierten Texte.",
  overflow: "Überlauf",
  safe: "Passt",
  unsaved: "Nicht gespeichert",
  load_failed: "PSP-Vorschautext konnte nicht geladen werden",
  retranslate_started: "Neuübersetzung für den aktuellen Eintrag gestartet",
} satisfies LocaleMessageSchema<typeof zh_cn_fate_extra_preview_page>;
