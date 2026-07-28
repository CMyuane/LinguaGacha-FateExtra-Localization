import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, MonitorPlay } from "lucide-react";

import { api_fetch } from "@frontend/app/desktop/desktop-api";
import { useI18n } from "@frontend/app/locale/locale-provider";
import type { ScreenComponentProps } from "@frontend/app/navigation/types";
import { useDesktopState } from "@frontend/app/state/use-desktop-state";
import { Badge } from "@frontend/shadcn/badge";
import { Input } from "@frontend/shadcn/input";
import { AppButton } from "@frontend/widgets/app-button";
import {
  layout_fate_extra_preview,
  type FateExtraPreviewLayout,
} from "@shared/fate-extra/fate-extra-layout";
import "@frontend/pages/fate-extra-preview-page/fate-extra-preview-page.css";

type PreviewItem = {
  item_id: number;
  file_path: string;
  row_number: number;
  src: string;
  dst: string;
  status: string;
  warnings: string[];
  overflow: boolean;
  index: { path: string; char_offset: number };
};

type PreviewList = {
  total?: number;
  items?: PreviewItem[];
  files?: string[];
};

function draw_preview(canvas: HTMLCanvasElement, layout: FateExtraPreviewLayout): void {
  const context = canvas.getContext("2d");
  if (context === null) return;
  context.clearRect(0, 0, 480, 272);
  const gradient = context.createLinearGradient(0, 0, 480, 272);
  gradient.addColorStop(0, "#09111f");
  gradient.addColorStop(0.55, "#142742");
  gradient.addColorStop(1, "#060a12");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 480, 272);

  context.fillStyle = "rgba(4, 11, 23, .86)";
  context.strokeStyle = "#9fc3e9";
  context.lineWidth = 1;
  context.fillRect(12, 69, 456, 135);
  context.strokeRect(12.5, 69.5, 455, 134);
  context.fillStyle = "rgba(126, 180, 231, .2)";
  context.fillRect(18, 76, 444, 2);

  let x = 24;
  let line = 0;
  const line_y = [111, 147, 183];
  for (const run of layout.runs) {
    if (run.text === "\n") {
      x = 24;
      line += 1;
      continue;
    }
    const y = line_y[line] ?? 219 + (line - 3) * 36;
    if (run.advance_px !== null) {
      x += run.advance_px;
      continue;
    }
    if (run.icon) {
      context.strokeStyle = run.color;
      context.strokeRect(x + 3, y - 20, 18, 18);
      context.fillStyle = run.color;
      context.font = "11px 'Noto Sans CJK SC', sans-serif";
      context.fillText("◆", x + 8, y - 6);
      x += 24;
      continue;
    }
    const base_width = [...run.text].length * 24;
    if (run.ruby !== "") {
      context.fillStyle = run.color;
      context.font = "12px 'Noto Sans CJK SC', sans-serif";
      context.textAlign = "center";
      context.fillText(run.ruby, x + base_width / 2, y - 25);
      context.textAlign = "start";
    }
    context.fillStyle = run.color;
    context.font = "24px 'Noto Sans CJK SC', sans-serif";
    context.textBaseline = "alphabetic";
    for (const char of run.text) {
      context.fillText(char, x, y);
      x += 24;
    }
  }
  if (layout.overflow) {
    context.strokeStyle = "#ff8b8b";
    context.lineWidth = 2;
    context.strokeRect(17, 82, 446, 108);
  }
}

export function FateExtraPreviewPage(_props: ScreenComponentProps): JSX.Element {
  const { t } = useI18n();
  const { project_snapshot, project_change_signal } = useDesktopState();
  const canvas_ref = useRef<HTMLCanvasElement | null>(null);
  const [items, set_items] = useState<PreviewItem[]>([]);
  const [files, set_files] = useState<string[]>([]);
  const [total, set_total] = useState(0);
  const [selected, set_selected] = useState(0);
  const [search, set_search] = useState("");
  const [file_path, set_file_path] = useState("");
  const [warning, set_warning] = useState("");
  const [show_source, set_show_source] = useState(false);
  const [servant_index, set_servant_index] = useState(0);
  const [gender_index, set_gender_index] = useState(0);
  const [error, set_error] = useState("");
  const project_path = project_snapshot.loaded ? project_snapshot.path : "";

  useEffect(() => {
    let alive = true;
    if (project_path === "") {
      set_items([]);
      return;
    }
    const timeout = window.setTimeout(() => {
      void api_fetch<PreviewList>("/api/toolbox/fate-extra/items", {
        project_path,
        search,
        file_path,
        warning,
        offset: 0,
        limit: 500,
      })
        .then((payload) => {
          if (!alive) return;
          set_items(payload.items ?? []);
          set_total(Number(payload.total ?? 0));
          if (file_path === "") set_files(payload.files ?? []);
          set_selected(0);
          set_error("");
        })
        .catch((reason: unknown) => {
          if (alive) set_error(reason instanceof Error ? reason.message : String(reason));
        });
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(timeout);
    };
  }, [file_path, project_change_signal.seq, project_path, search, warning]);

  const current = items[selected] ?? null;
  const text =
    current === null ? "" : show_source || current.dst === "" ? current.src : current.dst;
  const layout = useMemo(
    () =>
      layout_fate_extra_preview({
        text,
        state: { servant_index, gender_index },
      }),
    [gender_index, servant_index, text],
  );

  useEffect(() => {
    const canvas = canvas_ref.current;
    if (canvas !== null) draw_preview(canvas, layout);
  }, [layout]);

  return (
    <div className="fate-extra-preview page-shell page-shell--full">
      <header className="fate-extra-preview__header">
        <div>
          <h2>
            <MonitorPlay aria-hidden="true" />
            {t("fate_extra_preview_page.title")}
          </h2>
          <p>{t("fate_extra_preview_page.description")}</p>
        </div>
        <Badge variant={layout.overflow ? "destructive" : "outline"}>
          {layout.overflow
            ? t("fate_extra_preview_page.overflow")
            : t("fate_extra_preview_page.safe")}
        </Badge>
      </header>

      <div className="fate-extra-preview__filters">
        <Input
          value={search}
          placeholder={t("fate_extra_preview_page.search")}
          onChange={(event) => set_search(event.target.value)}
        />
        <select value={file_path} onChange={(event) => set_file_path(event.target.value)}>
          <option value="">{t("fate_extra_preview_page.all_files")}</option>
          {files.map((file) => (
            <option key={file} value={file}>
              {file}
            </option>
          ))}
        </select>
        <select value={warning} onChange={(event) => set_warning(event.target.value)}>
          <option value="">{t("fate_extra_preview_page.all_warnings")}</option>
          <option value="FE_PSP_OVERFLOW">{t("fate_extra_preview_page.overflow_only")}</option>
        </select>
      </div>

      <main className="fate-extra-preview__main">
        <section className="fate-extra-preview__stage">
          <canvas
            ref={canvas_ref}
            width={480}
            height={272}
            aria-label={t("fate_extra_preview_page.title")}
          />
          <div className="fate-extra-preview__branch-controls">
            <label>
              {t("fate_extra_preview_page.servant")}
              <select
                value={servant_index}
                onChange={(event) => set_servant_index(Number(event.target.value))}
              >
                <option value={0}>Saber</option>
                <option value={1}>Archer</option>
                <option value={2}>Caster</option>
                <option value={3}>Other</option>
              </select>
            </label>
            <label>
              {t("fate_extra_preview_page.gender")}
              <select
                value={gender_index}
                onChange={(event) => set_gender_index(Number(event.target.value))}
              >
                <option value={0}>{t("fate_extra_preview_page.male")}</option>
                <option value={1}>{t("fate_extra_preview_page.female")}</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={show_source}
                onChange={(event) => set_show_source(event.target.checked)}
              />
              {show_source
                ? t("fate_extra_preview_page.source")
                : t("fate_extra_preview_page.translation")}
            </label>
          </div>
          <div className="fate-extra-preview__measurements">
            <span>480×272</span>
            <span>{layout.max_width_px}/432px</span>
            <span>{layout.visible_line_count}/3 lines</span>
          </div>
        </section>

        <aside className="fate-extra-preview__details">
          {current === null ? (
            <p>{t("fate_extra_preview_page.empty")}</p>
          ) : (
            <>
              <strong>{current.file_path}</strong>
              <span>
                row {current.row_number + 1} · char:{current.index.char_offset}
              </span>
              <code>{current.index.path}</code>
              <h3>{t("fate_extra_preview_page.source")}</h3>
              <pre>{current.src}</pre>
              <h3>{t("fate_extra_preview_page.translation")}</h3>
              <pre>{current.dst}</pre>
              {layout.issues.map((issue) => (
                <p className="fate-extra-preview__issue" key={issue}>
                  {issue}
                </p>
              ))}
            </>
          )}
        </aside>
      </main>

      <footer className="fate-extra-preview__footer">
        <AppButton
          variant="outline"
          disabled={selected <= 0}
          onClick={() => set_selected((value) => Math.max(0, value - 1))}
        >
          <ChevronLeft data-icon="inline-start" />
          {t("fate_extra_preview_page.previous")}
        </AppButton>
        <span>
          {items.length === 0 ? 0 : selected + 1} / {total}
        </span>
        <AppButton
          variant="outline"
          disabled={selected >= items.length - 1}
          onClick={() => set_selected((value) => Math.min(items.length - 1, value + 1))}
        >
          {t("fate_extra_preview_page.next")}
          <ChevronRight data-icon="inline-end" />
        </AppButton>
      </footer>
      {error !== "" ? <p className="fate-extra-preview__error">{error}</p> : null}
    </div>
  );
}
