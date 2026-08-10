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
import { AppPageDialog } from "@frontend/widgets/app-page-dialog";
import { useActionShortcut } from "@frontend/widgets/interactions/use-action-shortcut";
import { ShortcutKbd } from "@frontend/widgets/interactions/shortcut-kbd";
import {
  has_fate_extra_control_sequence_mismatch,
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

const PREVIEW_PAGE_SIZE = 120;

type PreviewItem = {
  item_id: number;
  text_unit_id: number;
  occurrence_count: number;
  file_path: string;
  row_number: number;
  src: string;
  dst: string;
  machine_translation: string;
  proofread_translation: string;
  effective_translation: string;
  status: string;
  warnings: string[];
  overflow: boolean;
  display_mode: "auto" | "dialogue" | "fullscreen" | "poem";
  resolved_display_mode: "dialogue" | "fullscreen" | "poem" | "unknown";
  display_resolution: {
    source: "manual" | "script" | "format-handler" | "unresolved";
    confidence: "high" | "medium" | "low" | "unknown";
    reason: string;
    opcode: number | null;
    portrait_id: number | null;
  };
  encoded_bytes: number;
  machine_encoded_bytes: number;
  proofread_encoded_bytes: number;
  slot_capacity: number | null;
  classification: {
    category: string;
    category_zh: string;
    confidence: string;
    reason: string;
    translator_message: string;
    shared_storage_group: string;
    format_handler: string;
    allow_overlength: boolean;
  };
  index: { path: string; char_offset: number };
};

type PreviewList = {
  total?: number;
  items?: PreviewItem[];
  files?: string[];
  file_counts?: Record<string, number>;
  view_mode?: "unique" | "occurrence";
  requested_view_mode?: "unique" | "occurrence";
  index_ready?: boolean;
};

type ContextItem = {
  item_id: number;
  char_offset: number;
  block_ordinal: number;
  is_current: boolean;
  source: string;
  machine_translation: string;
  proofread_translation: string;
  status: string;
};

type ContextPayload = {
  found?: boolean;
  resource_path?: string;
  target_ordinal?: number;
  block_count?: number;
  radius?: number;
  items?: ContextItem[];
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

export function calculate_preview_line_baselines(args: {
  first_y: number;
  line_gap: number;
  base_font_size: number;
  ruby_font_size: number;
  line_has_ruby: readonly boolean[];
  visible_line_count: number;
}): number[] {
  const baselines = [args.first_y];
  const ruby_baseline_offset = args.base_font_size + 3;
  for (let index = 1; index < args.visible_line_count; index += 1) {
    const previous_baseline = baselines[index - 1] ?? args.first_y;
    const normal_baseline = previous_baseline + args.line_gap;
    // A ruby reading belongs to the current line.  Move that complete line
    // down when necessary so its reading cannot overlap the previous base line.
    const ruby_safe_baseline =
      previous_baseline + 4 + 3 + args.ruby_font_size + ruby_baseline_offset;
    baselines.push(
      args.line_has_ruby[index]
        ? Math.max(normal_baseline, ruby_safe_baseline)
        : normal_baseline,
    );
  }
  return baselines;
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

  const frame =
    layout.display_mode === "fullscreen"
      ? { x: 8, y: 12, width: 464, height: 248, text_x: 18, first_y: 39, line_gap: 28, font: 17 }
      : layout.display_mode === "poem"
        ? { x: 42, y: 28, width: 396, height: 216, text_x: 60, first_y: 65, line_gap: 29, font: 18 }
        : {
            x: 12,
            y: 69,
            width: 456,
            height: 135,
            text_x: 24,
            first_y: 111,
            line_gap: 36,
            font: 22,
          };

  context.fillStyle =
    layout.display_mode === "poem" ? "rgba(0, 0, 0, .38)" : "rgba(4, 11, 23, .86)";
  context.strokeStyle = layout.display_mode === "unknown" ? "#e5a84b" : "#9fc3e9";
  context.lineWidth = 1;
  context.fillRect(frame.x, frame.y, frame.width, frame.height);
  context.strokeRect(frame.x + 0.5, frame.y + 0.5, frame.width - 1, frame.height - 1);
  context.fillStyle = "rgba(126, 180, 231, .2)";
  context.fillRect(frame.x + 6, frame.y + 7, frame.width - 12, 2);

  let x = frame.text_x;
  let line = 0;
  const ruby_font_size = 12;
  const ruby_baseline_offset = frame.font + 3;
  const line_baselines = calculate_preview_line_baselines({
    first_y: frame.first_y,
    line_gap: frame.line_gap,
    base_font_size: frame.font,
    ruby_font_size,
    line_has_ruby: layout.line_has_ruby,
    visible_line_count: layout.visible_line_count,
  });
  for (const run of layout.runs) {
    if (run.text === "\n") {
      x = frame.text_x;
      line += 1;
      continue;
    }
    const y = line_baselines[line] ?? frame.first_y + line * frame.line_gap;
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
      x += layout.glyph_advance_px;
      continue;
    }
    const base_width = [...run.text].length * layout.glyph_advance_px;
    if (run.ruby !== "") {
      context.fillStyle = run.color;
      context.font = `${ruby_font_size}px 'Noto Sans CJK SC', sans-serif`;
      context.textAlign = "center";
      context.fillText(run.ruby, x + base_width / 2, y - ruby_baseline_offset);
      context.textAlign = "start";
    }
    context.fillStyle = run.color;
    context.font = `${frame.font}px 'Noto Sans CJK SC', sans-serif`;
    context.textBaseline = "alphabetic";
    for (const char of run.text) {
      context.fillText(char, x, y);
      x += layout.glyph_advance_px;
    }
  }
  if (layout.overflow) {
    context.strokeStyle = "#ff8b8b";
    context.lineWidth = 2;
    context.strokeRect(frame.x + 5, frame.y + 13, frame.width - 10, frame.height - 26);
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
  const [file_counts, set_file_counts] = useState<Record<string, number>>({});
  const [total, set_total] = useState(0);
  const [offset, set_offset] = useState(0);
  const [selected, set_selected] = useState(0);
  const [jump_value, set_jump_value] = useState("0");
  const [search, set_search] = useState("");
  const [view_mode, set_view_mode] = useState<"unique" | "occurrence">("unique");
  const [actual_view_mode, set_actual_view_mode] = useState<"unique" | "occurrence">("unique");
  const [index_ready, set_index_ready] = useState<boolean | null>(null);
  const [index_building, set_index_building] = useState(false);
  const [reload_seq, set_reload_seq] = useState(0);
  const index_rebuild_project_ref = useRef("");
  const [review_scope, set_review_scope] = useState<"unit" | "occurrence">("unit");
  const [file_path, set_file_path] = useState("");
  const [warning, set_warning] = useState("");
  const [category, set_category] = useState("");
  const [preview_layer, set_preview_layer] = useState<"source" | "machine" | "proofread">(
    "proofread",
  );
  const [servant_index, set_servant_index] = useState(0);
  const [gender_index, set_gender_index] = useState(0);
  const [draft_proofread, set_draft_proofread] = useState("");
  const [draft_display_mode, set_draft_display_mode] = useState<
    "auto" | "dialogue" | "fullscreen" | "poem"
  >("auto");
  const [dialogue_line_limit, set_dialogue_line_limit] = useState(20);
  const [fullscreen_line_limit, set_fullscreen_line_limit] = useState(30);
  const [draft_encoded_bytes, set_draft_encoded_bytes] = useState(0);
  const [busy, set_busy] = useState("");
  const [feedback, set_feedback] = useState("");
  const [error, set_error] = useState("");
  const [pending_confirmation, set_pending_confirmation] =
    useState<ProofreadingPendingConfirmation | null>(null);
  const [context_open, set_context_open] = useState(false);
  const [context_loading, set_context_loading] = useState(false);
  const [context_error, set_context_error] = useState("");
  const [context_payload, set_context_payload] = useState<ContextPayload | null>(null);
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
        view_mode,
        file_path,
        warning,
        category,
        offset,
        limit: PREVIEW_PAGE_SIZE,
      })
        .then((payload) => {
          if (!alive) return;
          const next_items = payload.items ?? [];
          set_items(next_items);
          set_total(Number(payload.total ?? 0));
          set_actual_view_mode(payload.view_mode ?? view_mode);
          set_index_ready(payload.index_ready ?? true);
          if (file_path === "") {
            set_files(payload.files ?? []);
            set_file_counts(payload.file_counts ?? {});
          }
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
  }, [
    category,
    file_path,
    offset,
    project_change_signal.seq,
    project_path,
    reload_seq,
    search,
    t,
    view_mode,
    warning,
  ]);

  useEffect(() => {
    if (
      project_path === "" ||
      view_mode !== "unique" ||
      index_ready !== false ||
      index_rebuild_project_ref.current === project_path
    ) {
      return;
    }
    let alive = true;
    index_rebuild_project_ref.current = project_path;
    set_index_building(true);
    void api_fetch<{ ready?: boolean }>("/api/toolbox/fate-extra/index/rebuild", {
      project_path,
    })
      .then((result) => {
        if (!alive) return;
        const ready = result.ready === true;
        set_index_ready(ready);
        if (ready) {
          set_offset(0);
          set_selected(0);
          set_reload_seq((value) => value + 1);
        } else {
          index_rebuild_project_ref.current = "";
          set_error("FE 严格去重索引未能完整建立，可继续使用物理位置视图。");
        }
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        index_rebuild_project_ref.current = "";
        set_error(error_message(reason, "FE 严格去重索引建立失败。"));
      })
      .finally(() => {
        if (alive) set_index_building(false);
      });
    return () => {
      alive = false;
    };
  }, [index_ready, project_path, view_mode]);

  const current = items[selected] ?? null;
  const current_position = current === null ? 0 : offset + selected + 1;
  useEffect(() => {
    set_draft_proofread(current?.proofread_translation ?? "");
    set_draft_display_mode(current?.display_mode ?? "auto");
    set_feedback("");
    set_error("");
    set_draft_encoded_bytes(current?.proofread_encoded_bytes ?? 0);
  }, [current?.display_mode, current?.item_id, current?.proofread_translation]);

  useEffect(() => {
    if (!context_open || current === null || project_path === "") return;
    let alive = true;
    set_context_loading(true);
    set_context_error("");
    void api_fetch<ContextPayload>("/api/toolbox/fate-extra/context", {
      project_path,
      resource_path: current.index.path,
      char_offset: current.index.char_offset,
      radius: 2,
    })
      .then((payload) => {
        if (!alive) return;
        set_context_payload(payload);
        if (payload.found !== true) {
          set_context_error(t("fate_extra_preview_page.context_not_found"));
        }
      })
      .catch((reason: unknown) => {
        if (alive) {
          set_context_error(
            error_message(reason, t("fate_extra_preview_page.context_load_failed")),
          );
        }
      })
      .finally(() => {
        if (alive) set_context_loading(false);
      });
    return () => {
      alive = false;
    };
  }, [context_open, current?.index.char_offset, current?.index.path, project_path]);

  useEffect(() => {
    set_review_scope(actual_view_mode === "unique" ? "unit" : "occurrence");
  }, [actual_view_mode]);

  useEffect(() => {
    set_jump_value(String(current_position));
  }, [current_position]);

  const proofread_dirty = current !== null && draft_proofread !== current.proofread_translation;
  const display_mode_dirty = current !== null && draft_display_mode !== current.display_mode;
  const dirty = proofread_dirty || display_mode_dirty;
  const writing = busy !== "" || readonly || index_building;
  const navigation_blocked = proofread_dirty || writing;
  const text =
    current === null
      ? ""
      : preview_layer === "source"
        ? current.src
        : preview_layer === "machine"
          ? current.machine_translation || current.src
          : draft_proofread || current.machine_translation || current.src;
  const resolved_display_mode =
    draft_display_mode === "auto"
      ? (current?.resolved_display_mode ?? "unknown")
      : draft_display_mode;
  const active_line_limit =
    resolved_display_mode === "dialogue"
      ? dialogue_line_limit
      : resolved_display_mode === "fullscreen"
        ? fullscreen_line_limit
        : undefined;
  const automatic_display_label =
    resolved_display_mode === "dialogue"
      ? `${t("fate_extra_preview_page.display_dialogue")}（${t("fate_extra_preview_page.display_auto")}）`
      : resolved_display_mode === "fullscreen"
        ? `${t("fate_extra_preview_page.display_fullscreen")}（${t("fate_extra_preview_page.display_auto")}）`
        : resolved_display_mode === "poem"
          ? `${t("fate_extra_preview_page.display_poem")}（${t("fate_extra_preview_page.display_auto")}）`
          : t("fate_extra_preview_page.display_auto");
  const layout = useMemo(
    () =>
      layout_fate_extra_preview({
        text,
        display_mode: resolved_display_mode,
        line_limit: active_line_limit,
        state: { servant_index, gender_index },
      }),
    [active_line_limit, gender_index, resolved_display_mode, servant_index, text],
  );
  const machine_layout = useMemo(
    () =>
      layout_fate_extra_preview({
        text: current?.machine_translation || current?.src || "",
        display_mode: resolved_display_mode,
        line_limit: active_line_limit,
        state: { servant_index, gender_index },
      }),
    [
      active_line_limit,
      current?.machine_translation,
      current?.src,
      gender_index,
      resolved_display_mode,
      servant_index,
    ],
  );
  const proofread_layout = useMemo(
    () =>
      layout_fate_extra_preview({
        text: draft_proofread || current?.machine_translation || current?.src || "",
        display_mode: resolved_display_mode,
        line_limit: active_line_limit,
        state: { servant_index, gender_index },
      }),
    [
      active_line_limit,
      current?.machine_translation,
      current?.src,
      draft_proofread,
      gender_index,
      resolved_display_mode,
      servant_index,
    ],
  );
  const machine_control_mismatch =
    current !== null &&
    current.machine_translation !== "" &&
    has_fate_extra_control_sequence_mismatch(current.src, current.machine_translation);
  const proofread_control_mismatch =
    current !== null &&
    draft_proofread !== "" &&
    has_fate_extra_control_sequence_mismatch(current.src, draft_proofread);
  const machine_issues = [
    ...machine_layout.issues,
    ...(machine_control_mismatch ? [t("fate_extra_preview_page.control_sequence_mismatch")] : []),
  ];
  const proofread_issues = [
    ...proofread_layout.issues,
    ...(proofread_control_mismatch ? [t("fate_extra_preview_page.control_sequence_mismatch")] : []),
  ];

  useEffect(() => {
    if (current === null) return;
    if (draft_proofread === current.proofread_translation) {
      set_draft_encoded_bytes(current.proofread_encoded_bytes);
      return;
    }
    let alive = true;
    const timeout = window.setTimeout(() => {
      void api_fetch<{ encoded_bytes?: number }>("/api/toolbox/fate-extra/preview", {
        text: draft_proofread || current.machine_translation || current.src,
        display_mode: resolved_display_mode,
        line_limit: active_line_limit ?? 0,
        servant_index,
        gender_index,
      })
        .then((result) => {
          if (alive) set_draft_encoded_bytes(Number(result.encoded_bytes ?? 0));
        })
        .catch(() => undefined);
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timeout);
    };
  }, [
    active_line_limit,
    current,
    draft_proofread,
    gender_index,
    resolved_display_mode,
    servant_index,
  ]);

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
    const next_proofread = draft_proofread;
    const next_display_mode = draft_display_mode;
    set_busy("save");
    set_feedback("");
    set_error("");
    try {
      await run_item_write("fate-extra.preview.save", "/api/toolbox/fate-extra/review/save", {
        item_id: target_id,
        text_unit_id: current.text_unit_id,
        review_scope,
        proofread_translation: next_proofread,
        display_mode: next_display_mode,
      });
      set_items((previous) =>
        previous.map((item) =>
          item.item_id === target_id
            ? {
                ...item,
                proofread_translation: next_proofread,
                effective_translation: next_proofread || item.machine_translation,
                display_mode: next_display_mode,
                status: "PROCESSED",
              }
            : item,
        ),
      );
      set_feedback(t("app.feedback.save_success"));
    } catch (reason) {
      set_error(error_message(reason, t("proofreading_page.feedback.save_failed")));
    } finally {
      set_busy("");
    }
  }

  async function save_display_mode(
    next_display_mode: "auto" | "dialogue" | "fullscreen" | "poem",
  ): Promise<void> {
    if (current === null || writing || next_display_mode === current.display_mode) {
      set_draft_display_mode(next_display_mode);
      return;
    }
    const target_id = current.item_id;
    const previous_display_mode = current.display_mode;
    set_draft_display_mode(next_display_mode);
    set_busy("display-mode");
    set_feedback("");
    set_error("");
    try {
      await run_item_write(
        "fate-extra.preview.save-display-mode",
        "/api/toolbox/fate-extra/review/save",
        {
          item_id: target_id,
          text_unit_id: current.text_unit_id,
          review_scope,
          proofread_translation: current.proofread_translation,
          display_mode: next_display_mode,
        },
      );
      set_items((previous) =>
        previous.map((item) =>
          item.item_id === target_id ? { ...item, display_mode: next_display_mode } : item,
        ),
      );
      set_feedback(t("app.feedback.save_success"));
    } catch (reason) {
      set_draft_display_mode(previous_display_mode);
      set_error(error_message(reason, t("proofreading_page.feedback.save_failed")));
    } finally {
      set_busy("");
    }
  }

  async function clear_translation(target_id: number): Promise<void> {
    await run_item_write("fate-extra.preview.clear-review", "/api/toolbox/fate-extra/review/save", {
      item_id: target_id,
      text_unit_id: current?.text_unit_id ?? 0,
      review_scope,
      proofread_translation: "",
      display_mode: current?.display_mode ?? "auto",
    });
    set_items((previous) =>
      previous.map((item) =>
        item.item_id === target_id
          ? { ...item, proofread_translation: "", effective_translation: item.machine_translation }
          : item,
      ),
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

  function jump_to_entry(): void {
    if (navigation_blocked || total <= 0) return;
    const requested_position = Number(jump_value);
    if (!Number.isFinite(requested_position)) {
      set_jump_value(String(current_position));
      return;
    }
    const target_position = Math.min(total, Math.max(1, Math.trunc(requested_position)));
    const target_index = target_position - 1;
    set_offset(Math.floor(target_index / PREVIEW_PAGE_SIZE) * PREVIEW_PAGE_SIZE);
    set_selected(target_index % PREVIEW_PAGE_SIZE);
    set_jump_value(String(target_position));
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
  const machine_storage_overflow =
    current !== null &&
    current.slot_capacity !== null &&
    !current.classification.allow_overlength &&
    current.machine_encoded_bytes > current.slot_capacity;
  const proofread_storage_overflow =
    current !== null &&
    current.slot_capacity !== null &&
    !current.classification.allow_overlength &&
    draft_encoded_bytes > current.slot_capacity;

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
        <Badge
          variant={
            resolved_display_mode === "unknown" || layout.overflow ? "destructive" : "outline"
          }
        >
          {resolved_display_mode === "unknown"
            ? t("fate_extra_preview_page.display_pending")
            : layout.overflow
              ? t("fate_extra_preview_page.overflow")
              : t("fate_extra_preview_page.safe")}
        </Badge>
      </header>

      <div className="fate-extra-preview__filters">
        <select
          value={view_mode}
          disabled={navigation_blocked}
          onChange={(event) => {
            set_view_mode(event.target.value as "unique" | "occurrence");
            set_offset(0);
            set_selected(0);
          }}
        >
          <option value="unique">{t("fate_extra_preview_page.unique_text_view")}</option>
          <option value="occurrence">{t("fate_extra_preview_page.occurrence_view")}</option>
        </select>
        <Input
          value={search}
          disabled={navigation_blocked}
          placeholder={t("fate_extra_preview_page.search")}
          onChange={(event) => {
            set_search(event.target.value);
            set_offset(0);
            set_selected(0);
          }}
        />
        <select
          value={file_path}
          disabled={navigation_blocked}
          onChange={(event) => {
            set_file_path(event.target.value);
            set_offset(0);
            set_selected(0);
          }}
        >
          <option value="">{t("fate_extra_preview_page.all_files")}</option>
          {files.map((file) => (
            <option key={file} value={file}>
              {file === "FE_补漏.txt"
                ? t("fate_extra_preview_page.supplement_option", {
                    count: String(file_counts[file] ?? 0),
                  })
                : file}
            </option>
          ))}
        </select>
        <select
          value={warning}
          disabled={navigation_blocked}
          onChange={(event) => {
            set_warning(event.target.value);
            set_offset(0);
            set_selected(0);
          }}
        >
          <option value="">{t("fate_extra_preview_page.all_warnings")}</option>
          <option value="FE_PSP_OVERFLOW">{t("fate_extra_preview_page.overflow_only")}</option>
          <option value="FE_STORAGE_CAPACITY">
            {t("fate_extra_preview_page.storage_overflow_only")}
          </option>
          <option value="FE_SAFETY_BLOCKER">{t("fate_extra_preview_page.blocker_only")}</option>
        </select>
        <select
          value={category}
          disabled={navigation_blocked}
          onChange={(event) => {
            set_category(event.target.value);
            set_offset(0);
            set_selected(0);
          }}
        >
          <option value="">{t("fate_extra_preview_page.all_categories")}</option>
          <option value="ordinary_independent_slot">
            {t("fate_extra_preview_page.category_ordinary")}
          </option>
          <option value="confirmed_u32_pointer">{t("fate_extra_preview_page.category_u32")}</option>
          <option value="packed_u16_pointer">{t("fate_extra_preview_page.category_u16")}</option>
          <option value="shared_overlapping_view">
            {t("fate_extra_preview_page.category_shared")}
          </option>
          <option value="dynamic_cursor_no_static_ref">
            {t("fate_extra_preview_page.category_dynamic")}
          </option>
          <option value="fixed_layout_text">{t("fate_extra_preview_page.category_fixed")}</option>
          <option value="unresolved_candidate">
            {t("fate_extra_preview_page.category_unresolved")}
          </option>
        </select>
      </div>

      {index_building ? (
        <p className="fate-extra-preview__index-status">
          {t("fate_extra_preview_page.index_building")}
        </p>
      ) : view_mode === "unique" && index_ready === false ? (
        <p className="fate-extra-preview__index-status">
          {t("fate_extra_preview_page.index_fallback")}
        </p>
      ) : null}

      <main className="fate-extra-preview__main">
        <section className="fate-extra-preview__stage">
          {current === null ? null : (
            <div className="fate-extra-preview__identity">
              <strong>{current.file_path}</strong>
              <span>
                row {current.row_number + 1} · char:{current.index.char_offset}
              </span>
              {current.occurrence_count > 1 ? (
                <Badge variant="secondary">
                  {t("fate_extra_preview_page.occurrence_count", {
                    count: String(current.occurrence_count),
                  })}
                </Badge>
              ) : null}
              <code>{current.index.path}</code>
              {current.file_path === "FE_补漏.txt" ? (
                <span className="fate-extra-preview__supplement-note">
                  {t("fate_extra_preview_page.supplement_note")}
                </span>
              ) : null}
            </div>
          )}
          <canvas
            ref={canvas_ref}
            width={480}
            height={272}
            aria-label={t("fate_extra_preview_page.title")}
          />
          <div className="fate-extra-preview__branch-controls">
            <AppButton
              type="button"
              variant="outline"
              size="sm"
              disabled={current === null}
              onClick={() => set_context_open(true)}
            >
              {t("fate_extra_preview_page.view_context")}
            </AppButton>
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
              {t("fate_extra_preview_page.preview_layer")}
              <select
                value={preview_layer}
                onChange={(event) =>
                  set_preview_layer(event.target.value as "source" | "machine" | "proofread")
                }
              >
                <option value="source">{t("fate_extra_preview_page.source_japanese")}</option>
                <option value="machine">{t("fate_extra_preview_page.machine_translation")}</option>
                <option value="proofread">
                  {t("fate_extra_preview_page.proofread_translation")}
                </option>
              </select>
            </label>
            <label>
              {t("fate_extra_preview_page.display_mode")}
              <select
                value={draft_display_mode}
                disabled={writing}
                onChange={(event) =>
                  void save_display_mode(
                    event.target.value as "auto" | "dialogue" | "fullscreen" | "poem",
                  )
                }
              >
                <option value="auto">{automatic_display_label}</option>
                <option value="dialogue">{t("fate_extra_preview_page.display_dialogue")}</option>
                <option value="fullscreen">
                  {t("fate_extra_preview_page.display_fullscreen")}
                </option>
                <option value="poem">{t("fate_extra_preview_page.display_poem")}</option>
              </select>
            </label>
            {resolved_display_mode === "dialogue" ? (
              <label>
                {t("fate_extra_preview_page.dialogue_line_limit")}
                <Input
                  type="number"
                  min={1}
                  max={40}
                  value={dialogue_line_limit}
                  onChange={(event) =>
                    set_dialogue_line_limit(Math.max(1, Number(event.target.value) || 20))
                  }
                />
              </label>
            ) : null}
            {resolved_display_mode === "fullscreen" ? (
              <label>
                {t("fate_extra_preview_page.fullscreen_line_limit")}
                <Input
                  type="number"
                  min={21}
                  max={60}
                  value={fullscreen_line_limit}
                  onChange={(event) =>
                    set_fullscreen_line_limit(Math.max(21, Number(event.target.value) || 30))
                  }
                />
              </label>
            ) : null}
          </div>
          <div className="fate-extra-preview__measurements">
            <span>480×272</span>
            <span>{layout.max_width_px}/432px</span>
            <span>
              {layout.visible_line_count} lines · {layout.display_mode}
            </span>
          </div>
          {current === null ? null : (
            <section className="fate-extra-preview__base-safety">
              <div className="fate-extra-preview__badges">
                <Badge variant="outline">
                  {current.classification.category_zh || current.classification.category}
                </Badge>
                <Badge variant="outline">
                  {t("fate_extra_preview_page.confidence")} {current.classification.confidence}
                </Badge>
                <Badge variant={resolved_display_mode === "unknown" ? "destructive" : "outline"}>
                  {t("fate_extra_preview_page.display_mode")}: {resolved_display_mode}
                </Badge>
              </div>
              <p>{current.display_resolution.reason}</p>
              {current.classification.translator_message !== "" ? (
                <p>{current.classification.translator_message}</p>
              ) : null}
            </section>
          )}
        </section>

        <aside className="fate-extra-preview__details">
          {current === null ? (
            <p>{t("fate_extra_preview_page.empty")}</p>
          ) : (
            <>
              <section className="fate-extra-preview__editor-section">
                <h3>{t("fate_extra_preview_page.source_japanese")}</h3>
                <AppEditor
                  value={current.src}
                  aria_label={t("fate_extra_preview_page.source")}
                  read_only
                  class_name="fate-extra-preview__editor"
                />
              </section>

              <section className="fate-extra-preview__editor-section">
                <h3>{t("fate_extra_preview_page.machine_translation")}</h3>
                <AppEditor
                  value={current.machine_translation}
                  aria_label={t("fate_extra_preview_page.machine_translation")}
                  read_only
                  class_name="fate-extra-preview__editor"
                />
              </section>

              <section className="fate-extra-preview__editor-section">
                <h3>{t("fate_extra_preview_page.proofread_translation")}</h3>
                <AppEditor
                  value={draft_proofread}
                  aria_label={t("fate_extra_preview_page.proofread_translation")}
                  read_only={writing}
                  class_name="fate-extra-preview__editor"
                  on_change={set_draft_proofread}
                />
              </section>

              <div className="fate-extra-preview__assessments">
                <section className="fate-extra-preview__assessment-card">
                  <h3>{t("fate_extra_preview_page.machine_assessment")}</h3>
                  <div className="fate-extra-preview__badges">
                    <Badge
                      variant={
                        resolved_display_mode === "unknown" ||
                        machine_layout.overflow ||
                        machine_control_mismatch
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {resolved_display_mode === "unknown"
                        ? t("fate_extra_preview_page.display_pending")
                        : machine_layout.overflow
                          ? t("fate_extra_preview_page.overflow")
                          : machine_control_mismatch
                            ? t("fate_extra_preview_page.control_sequence_pending")
                            : t("fate_extra_preview_page.safe")}
                    </Badge>
                    <Badge variant={machine_storage_overflow ? "destructive" : "outline"}>
                      {t("fate_extra_preview_page.encoded_bytes")} {current.machine_encoded_bytes}/
                      {current.slot_capacity ?? "∞"}
                    </Badge>
                  </div>
                  {machine_issues.map((issue) => (
                    <p className="fate-extra-preview__issue" key={`machine-${issue}`}>
                      {issue}
                    </p>
                  ))}
                </section>
                <section className="fate-extra-preview__assessment-card">
                  <h3>{t("fate_extra_preview_page.proofread_assessment")}</h3>
                  <div className="fate-extra-preview__badges">
                    <Badge
                      variant={
                        resolved_display_mode === "unknown" ||
                        proofread_layout.overflow ||
                        proofread_control_mismatch
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {resolved_display_mode === "unknown"
                        ? t("fate_extra_preview_page.display_pending")
                        : proofread_layout.overflow
                          ? t("fate_extra_preview_page.overflow")
                          : proofread_control_mismatch
                            ? t("fate_extra_preview_page.control_sequence_pending")
                            : t("fate_extra_preview_page.safe")}
                    </Badge>
                    <Badge variant={proofread_storage_overflow ? "destructive" : "outline"}>
                      {t("fate_extra_preview_page.encoded_bytes")} {draft_encoded_bytes}/
                      {current.slot_capacity ?? "∞"}
                    </Badge>
                    <Badge variant="outline">{status_label}</Badge>
                    {dirty ? (
                      <Badge variant="secondary">{t("fate_extra_preview_page.unsaved")}</Badge>
                    ) : null}
                  </div>
                  {proofread_issues.map((issue) => (
                    <p className="fate-extra-preview__issue" key={`proofread-${issue}`}>
                      {issue}
                    </p>
                  ))}
                </section>
              </div>

              <section className="fate-extra-preview__status-section">
                <h3>{t("fate_extra_preview_page.other_warnings")}</h3>
                <div className="fate-extra-preview__badges">
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
                </div>
              </section>

              <div className="fate-extra-preview__actions">
                {current.text_unit_id > 0 && current.occurrence_count > 1 ? (
                  <label className="fate-extra-preview__review-scope">
                    {t("fate_extra_preview_page.save_scope")}
                    <select
                      value={review_scope}
                      disabled={writing}
                      onChange={(event) =>
                        set_review_scope(event.target.value as "unit" | "occurrence")
                      }
                    >
                      <option value="unit">
                        {t("fate_extra_preview_page.save_all_occurrences")}
                      </option>
                      <option value="occurrence">
                        {t("fate_extra_preview_page.save_current_occurrence")}
                      </option>
                    </select>
                  </label>
                ) : null}
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
          disabled={navigation_blocked || (offset === 0 && selected <= 0)}
          onClick={show_previous}
        >
          <ChevronLeft data-icon="inline-start" />
          {t("fate_extra_preview_page.previous")}
        </AppButton>
        <div className="fate-extra-preview__jump-control">
          <Input
            type="number"
            inputMode="numeric"
            min={total > 0 ? 1 : 0}
            max={total}
            step={1}
            value={jump_value}
            disabled={navigation_blocked || total <= 0}
            aria-label={t("fate_extra_preview_page.jump_to")}
            onChange={(event) => set_jump_value(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                jump_to_entry();
              }
            }}
          />
          <span>/ {total}</span>
          <AppButton
            variant="outline"
            size="sm"
            disabled={navigation_blocked || total <= 0 || jump_value.trim() === ""}
            onClick={jump_to_entry}
          >
            {t("fate_extra_preview_page.jump")}
          </AppButton>
        </div>
        <AppButton
          variant="outline"
          disabled={navigation_blocked || offset + selected + 1 >= total}
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
      <AppPageDialog
        open={context_open}
        size="xl"
        title={t("fate_extra_preview_page.context_title")}
        onClose={() => set_context_open(false)}
        bodyClassName="fate-extra-preview__context-dialog"
      >
        <header className="fate-extra-preview__context-header">
          <div>
            <h2>{t("fate_extra_preview_page.context_title")}</h2>
            <p>{t("fate_extra_preview_page.context_description")}</p>
          </div>
          {context_payload?.found === true ? (
            <code>
              {context_payload.resource_path} · {(context_payload.target_ordinal ?? 0) + 1}/
              {context_payload.block_count ?? 0}
            </code>
          ) : null}
        </header>
        {context_loading ? (
          <p>{t("fate_extra_preview_page.context_loading")}</p>
        ) : context_error !== "" ? (
          <p className="fate-extra-preview__error">{context_error}</p>
        ) : (
          <div className="fate-extra-preview__context-grid">
            <div className="fate-extra-preview__context-head">
              <span />
              <strong>{t("fate_extra_preview_page.source_japanese")}</strong>
              <strong>{t("fate_extra_preview_page.machine_translation")}</strong>
              <strong>{t("fate_extra_preview_page.proofread_translation")}</strong>
            </div>
            {(context_payload?.items ?? []).map((item) => (
              <div
                className={`fate-extra-preview__context-row${item.is_current ? " fate-extra-preview__context-row--current" : ""}`}
                key={`${item.char_offset}-${item.item_id}`}
              >
                <div className="fate-extra-preview__context-position">
                  <Badge variant={item.is_current ? "default" : "outline"}>
                    {item.is_current
                      ? t("fate_extra_preview_page.context_current")
                      : item.block_ordinal < (context_payload?.target_ordinal ?? 0)
                        ? t("fate_extra_preview_page.context_previous")
                        : t("fate_extra_preview_page.context_next")}
                  </Badge>
                  <code>char:{item.char_offset}</code>
                </div>
                <pre>{item.source}</pre>
                <pre>{item.machine_translation}</pre>
                <pre>
                  {item.proofread_translation || t("fate_extra_preview_page.context_empty_proofread")}
                </pre>
              </div>
            ))}
          </div>
        )}
      </AppPageDialog>
    </div>
  );
}
