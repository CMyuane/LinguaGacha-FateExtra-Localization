import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Eraser,
  ListChecks,
  MonitorPlay,
  RefreshCcw,
  Save,
} from "lucide-react";

import { api_fetch } from "@frontend/app/desktop/desktop-api";
import { useI18n } from "@frontend/app/locale/locale-provider";
import type { ScreenComponentProps } from "@frontend/app/navigation/types";
import { is_project_write_locked } from "@frontend/app/state/task-snapshot-store";
import { useDesktopState } from "@frontend/app/state/use-desktop-state";
import { ProofreadingConfirmDialog } from "@frontend/pages/proofreading-page/components/proofreading-confirm-dialog";
import type { ProofreadingPendingConfirmation } from "@frontend/pages/proofreading-page/proofreading-page-ui-types";
import { Badge } from "@frontend/shadcn/badge";
import { Input } from "@frontend/shadcn/input";
import { AppButton } from "@frontend/widgets/app-button";
import {
  AppDropdownMenu,
  AppDropdownMenuContent,
  AppDropdownMenuGroup,
  AppDropdownMenuItem,
  AppDropdownMenuTrigger,
} from "@frontend/widgets/app-dropdown-menu";
import { AppEditor } from "@frontend/widgets/app-editor/app-editor";
import { useActionShortcut } from "@frontend/widgets/interactions/use-action-shortcut";
import { ShortcutKbd } from "@frontend/widgets/interactions/shortcut-kbd";
import {
  layout_fate_extra_preview,
  type FateExtraPreviewLayout,
} from "@shared/fate-extra/fate-extra-layout";
import {
  PROOFREADING_MANUAL_STATUS_CODES,
  PROOFREADING_STATUS_LABEL_KEY_BY_CODE,
  PROOFREADING_WARNING_LABEL_KEY_BY_CODE,
  type ProofreadingManualStatusCode,
} from "@shared/proofreading/proofreading-types";
import "@frontend/pages/fate-extra-preview-page/fate-extra-preview-page.css";

const PREVIEW_PAGE_SIZE = 500;

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

type ProjectManifest = {
  sectionRevisions?: Record<string, number>;
};

type ProjectWritePayload = {
  accepted?: unknown;
  changes?: unknown;
};

function error_message(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.trim() !== "" ? reason.message : fallback;
}

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
  const {
    project_snapshot,
    project_change_signal,
    task_snapshot,
    commit_project_write,
    refresh_task,
  } = useDesktopState();
  const canvas_ref = useRef<HTMLCanvasElement | null>(null);
  const [items, set_items] = useState<PreviewItem[]>([]);
  const [files, set_files] = useState<string[]>([]);
  const [total, set_total] = useState(0);
  const [offset, set_offset] = useState(0);
  const [selected, set_selected] = useState(0);
  const [search, set_search] = useState("");
  const [file_path, set_file_path] = useState("");
  const [warning, set_warning] = useState("");
  const [show_source, set_show_source] = useState(false);
  const [servant_index, set_servant_index] = useState(0);
  const [gender_index, set_gender_index] = useState(0);
  const [draft_dst, set_draft_dst] = useState("");
  const [busy, set_busy] = useState("");
  const [feedback, set_feedback] = useState("");
  const [error, set_error] = useState("");
  const [pending_confirmation, set_pending_confirmation] =
    useState<ProofreadingPendingConfirmation | null>(null);
  const project_path = project_snapshot.loaded ? project_snapshot.path : "";
  const readonly = is_project_write_locked(task_snapshot);

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
        offset,
        limit: PREVIEW_PAGE_SIZE,
      })
        .then((payload) => {
          if (!alive) return;
          const next_items = payload.items ?? [];
          set_items(next_items);
          set_total(Number(payload.total ?? 0));
          if (file_path === "") set_files(payload.files ?? []);
          set_selected((value) => Math.min(value, Math.max(0, next_items.length - 1)));
          set_error("");
        })
        .catch((reason: unknown) => {
          if (alive) {
            set_error(error_message(reason, t("fate_extra_preview_page.load_failed")));
          }
        });
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(timeout);
    };
  }, [file_path, offset, project_change_signal.seq, project_path, search, t, warning]);

  const current = items[selected] ?? null;
  useEffect(() => {
    set_draft_dst(current?.dst ?? "");
    set_feedback("");
    set_error("");
  }, [current?.dst, current?.item_id]);

  const dirty = current !== null && draft_dst !== current.dst;
  const writing = busy !== "" || readonly;
  const text = current === null ? "" : show_source || draft_dst === "" ? current.src : draft_dst;
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

  useActionShortcut({
    action: "save",
    enabled: dirty && !writing,
    on_trigger: save_translation,
  });

  async function read_revisions(): Promise<Record<string, number>> {
    const manifest = await api_fetch<ProjectManifest>("/api/session/project/manifest", {});
    return manifest.sectionRevisions ?? {};
  }

  async function run_item_write(
    operation: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const revisions = await read_revisions();
    await commit_project_write<ProjectWritePayload>({
      operation,
      run: async () =>
        await api_fetch<ProjectWritePayload>(path, {
          ...body,
          expected_section_revisions: {
            items: revisions["items"] ?? 0,
            proofreading: revisions["proofreading"] ?? 0,
          },
        }),
    });
  }

  async function save_translation(): Promise<void> {
    if (current === null || !dirty || writing) return;
    const target_id = current.item_id;
    const next_dst = draft_dst;
    set_busy("save");
    set_feedback("");
    set_error("");
    try {
      await run_item_write("fate-extra.preview.save", "/api/proofreading/item/save", {
        item_id: target_id,
        dst: next_dst,
      });
      set_items((previous) =>
        previous.map((item) =>
          item.item_id === target_id ? { ...item, dst: next_dst, status: "PROCESSED" } : item,
        ),
      );
      set_feedback(t("app.feedback.save_success"));
    } catch (reason) {
      set_error(error_message(reason, t("proofreading_page.feedback.save_failed")));
    } finally {
      set_busy("");
    }
  }

  async function clear_translation(target_id: number): Promise<void> {
    await run_item_write(
      "fate-extra.preview.clear-translation",
      "/api/proofreading/translations/clear",
      { item_ids: [target_id] },
    );
    set_items((previous) =>
      previous.map((item) => (item.item_id === target_id ? { ...item, dst: "" } : item)),
    );
  }

  async function set_translation_status(status: ProofreadingManualStatusCode): Promise<void> {
    if (current === null || writing) return;
    const target_id = current.item_id;
    set_busy("status");
    set_feedback("");
    set_error("");
    try {
      await run_item_write("fate-extra.preview.set-status", "/api/proofreading/items/set-status", {
        item_ids: [target_id],
        status,
      });
      set_items((previous) =>
        previous.map((item) => (item.item_id === target_id ? { ...item, status } : item)),
      );
      set_feedback(
        t("proofreading_page.feedback.set_status_success")
          .replace("{COUNT}", "1")
          .replace("{STATUS}", t(PROOFREADING_STATUS_LABEL_KEY_BY_CODE[status])),
      );
    } catch (reason) {
      set_error(error_message(reason, t("proofreading_page.feedback.set_status_failed")));
    } finally {
      set_busy("");
    }
  }

  function request_confirmation(kind: ProofreadingPendingConfirmation["kind"]): void {
    if (current === null || writing) return;
    set_pending_confirmation({
      kind,
      target_row_ids: [String(current.item_id)],
      preferred_row_id: String(current.item_id),
      submitting: false,
    });
  }

  async function confirm_pending_confirmation(): Promise<void> {
    const confirmation = pending_confirmation;
    if (confirmation === null || confirmation.submitting) return;
    const target_id = Number(confirmation.target_row_ids[0]);
    if (!Number.isInteger(target_id)) {
      set_pending_confirmation(null);
      return;
    }
    set_pending_confirmation({ ...confirmation, submitting: true });
    set_busy(confirmation.kind);
    set_feedback("");
    set_error("");
    try {
      if (confirmation.kind === "clear-translations") {
        await clear_translation(target_id);
        set_feedback(
          t("proofreading_page.feedback.clear_translation_success").replace("{COUNT}", "1"),
        );
      } else {
        const revisions = await read_revisions();
        await api_fetch("/api/tasks/start", {
          task_type: "translation",
          mode: "new",
          scope: { kind: "items", item_ids: [target_id] },
          expected_section_revisions: {
            items: revisions["items"] ?? 0,
            proofreading: revisions["proofreading"] ?? 0,
            quality: revisions["quality"] ?? 0,
            prompts: revisions["prompts"] ?? 0,
          },
        });
        await refresh_task("translation");
        set_feedback(t("fate_extra_preview_page.retranslate_started"));
      }
      set_pending_confirmation(null);
    } catch (reason) {
      const fallback =
        confirmation.kind === "clear-translations"
          ? t("proofreading_page.feedback.clear_translation_failed")
          : t("proofreading_page.feedback.retranslate_failed");
      set_error(error_message(reason, fallback));
      set_pending_confirmation({ ...confirmation, submitting: false });
    } finally {
      set_busy("");
    }
  }

  function show_previous(): void {
    if (selected > 0) {
      set_selected((value) => value - 1);
      return;
    }
    if (offset > 0) {
      set_offset(Math.max(0, offset - PREVIEW_PAGE_SIZE));
      set_selected(PREVIEW_PAGE_SIZE - 1);
    }
  }

  function show_next(): void {
    if (selected < items.length - 1) {
      set_selected((value) => value + 1);
      return;
    }
    if (offset + items.length < total) {
      set_offset(offset + PREVIEW_PAGE_SIZE);
      set_selected(0);
    }
  }

  const status_label =
    current !== null &&
    Object.prototype.hasOwnProperty.call(PROOFREADING_STATUS_LABEL_KEY_BY_CODE, current.status)
      ? t(
          PROOFREADING_STATUS_LABEL_KEY_BY_CODE[
            current.status as keyof typeof PROOFREADING_STATUS_LABEL_KEY_BY_CODE
          ],
        )
      : (current?.status ?? "");

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
          disabled={dirty || writing}
          placeholder={t("fate_extra_preview_page.search")}
          onChange={(event) => {
            set_search(event.target.value);
            set_offset(0);
            set_selected(0);
          }}
        />
        <select
          value={file_path}
          disabled={dirty || writing}
          onChange={(event) => {
            set_file_path(event.target.value);
            set_offset(0);
            set_selected(0);
          }}
        >
          <option value="">{t("fate_extra_preview_page.all_files")}</option>
          {files.map((file) => (
            <option key={file} value={file}>
              {file}
            </option>
          ))}
        </select>
        <select
          value={warning}
          disabled={dirty || writing}
          onChange={(event) => {
            set_warning(event.target.value);
            set_offset(0);
            set_selected(0);
          }}
        >
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
              <div className="fate-extra-preview__identity">
                <strong>{current.file_path}</strong>
                <span>
                  row {current.row_number + 1} · char:{current.index.char_offset}
                </span>
                <code>{current.index.path}</code>
              </div>

              <section className="fate-extra-preview__editor-section">
                <h3>{t("fate_extra_preview_page.source")}</h3>
                <AppEditor
                  value={current.src}
                  aria_label={t("fate_extra_preview_page.source")}
                  read_only
                  class_name="fate-extra-preview__editor"
                />
              </section>

              <section className="fate-extra-preview__editor-section">
                <h3>{t("fate_extra_preview_page.translation")}</h3>
                <AppEditor
                  value={draft_dst}
                  aria_label={t("fate_extra_preview_page.translation")}
                  read_only={writing}
                  class_name="fate-extra-preview__editor"
                  on_change={set_draft_dst}
                />
              </section>

              <section className="fate-extra-preview__status-section">
                <h3>{t("proofreading_page.fields.status")}</h3>
                <div className="fate-extra-preview__badges">
                  <Badge variant="outline">{status_label}</Badge>
                  {layout.overflow ? (
                    <Badge variant="destructive">{t("fate_extra_preview_page.overflow")}</Badge>
                  ) : null}
                  {current.warnings
                    .filter((warning_code) => warning_code !== "FE_PSP_OVERFLOW")
                    .map((warning_code) => {
                      const label = Object.prototype.hasOwnProperty.call(
                        PROOFREADING_WARNING_LABEL_KEY_BY_CODE,
                        warning_code,
                      )
                        ? t(
                            PROOFREADING_WARNING_LABEL_KEY_BY_CODE[
                              warning_code as keyof typeof PROOFREADING_WARNING_LABEL_KEY_BY_CODE
                            ],
                          )
                        : warning_code;
                      return (
                        <Badge variant="outline" key={warning_code}>
                          {label}
                        </Badge>
                      );
                    })}
                  {dirty ? (
                    <Badge variant="secondary">{t("fate_extra_preview_page.unsaved")}</Badge>
                  ) : null}
                </div>
              </section>

              {layout.issues.map((issue) => (
                <p className="fate-extra-preview__issue" key={issue}>
                  {issue}
                </p>
              ))}

              <div className="fate-extra-preview__actions">
                <AppButton
                  size="sm"
                  disabled={!dirty || writing}
                  onClick={() => void save_translation()}
                >
                  <Save data-icon="inline-start" />
                  {t("proofreading_page.action.save")}
                  <ShortcutKbd action="save" className="bg-background/18 text-primary-foreground" />
                </AppButton>
                <AppButton
                  variant="outline"
                  size="sm"
                  disabled={writing}
                  onClick={() => request_confirmation("retranslate")}
                >
                  <RefreshCcw data-icon="inline-start" />
                  {t("proofreading_page.action.retranslate")}
                </AppButton>
                <AppButton
                  variant="outline"
                  size="sm"
                  disabled={writing}
                  onClick={() => request_confirmation("clear-translations")}
                >
                  <Eraser data-icon="inline-start" />
                  {t("proofreading_page.action.clear_translation")}
                </AppButton>
                <AppDropdownMenu>
                  <AppDropdownMenuTrigger asChild>
                    <AppButton variant="outline" size="sm" disabled={writing}>
                      <ListChecks data-icon="inline-start" />
                      {t("proofreading_page.action.set_translation_status")}
                    </AppButton>
                  </AppDropdownMenuTrigger>
                  <AppDropdownMenuContent align="start" matchTriggerWidth={false}>
                    <AppDropdownMenuGroup>
                      {PROOFREADING_MANUAL_STATUS_CODES.map((status) => (
                        <AppDropdownMenuItem
                          key={status}
                          onSelect={() => void set_translation_status(status)}
                        >
                          {t(PROOFREADING_STATUS_LABEL_KEY_BY_CODE[status])}
                        </AppDropdownMenuItem>
                      ))}
                    </AppDropdownMenuGroup>
                  </AppDropdownMenuContent>
                </AppDropdownMenu>
              </div>
            </>
          )}
        </aside>
      </main>

      <footer className="fate-extra-preview__footer">
        <AppButton
          variant="outline"
          disabled={dirty || writing || (offset === 0 && selected <= 0)}
          onClick={show_previous}
        >
          <ChevronLeft data-icon="inline-start" />
          {t("fate_extra_preview_page.previous")}
        </AppButton>
        <span>
          {items.length === 0 ? 0 : offset + selected + 1} / {total}
        </span>
        <AppButton
          variant="outline"
          disabled={dirty || writing || offset + selected + 1 >= total}
          onClick={show_next}
        >
          {t("fate_extra_preview_page.next")}
          <ChevronRight data-icon="inline-end" />
        </AppButton>
      </footer>

      <div className="fate-extra-preview__feedback" aria-live="polite">
        {feedback !== "" ? <p>{feedback}</p> : null}
        {error !== "" ? <p className="fate-extra-preview__error">{error}</p> : null}
      </div>

      <ProofreadingConfirmDialog
        state={pending_confirmation}
        on_confirm={confirm_pending_confirmation}
        on_close={() => {
          if (pending_confirmation?.submitting !== true) set_pending_confirmation(null);
        }}
      />
    </div>
  );
}
