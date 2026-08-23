import { useEffect, useState } from "react";
import { Database, FileCheck2, FolderOpen, PackageMinus, ScanSearch, Upload } from "lucide-react";

import { api_fetch } from "@frontend/app/desktop/desktop-api";
import { useI18n } from "@frontend/app/locale/locale-provider";
import type { ScreenComponentProps } from "@frontend/app/navigation/types";
import { useDesktopState } from "@frontend/app/state/use-desktop-state";
import { Badge } from "@frontend/shadcn/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@frontend/shadcn/card";
import { Input } from "@frontend/shadcn/input";
import { Spinner } from "@frontend/shadcn/spinner";
import { AppButton } from "@frontend/widgets/app-button";
import "@frontend/pages/fate-extra-page/fate-extra-page.css";

const DEFAULT_SOURCE = "";
const DEFAULT_DATABASE = "";
const DEFAULT_MIGRATION = "";
const DEFAULT_MIGRATION_TEXT = "";

type ScanReport = {
  scan_id?: string;
  applicable?: boolean;
  source_file_count?: number;
  logical_text_count?: number;
  route_logical_text_count?: number;
  complete_jp_text_count?: number;
  supplemental_text_count?: number;
  unique_index_count?: number;
  matched_classification_count?: number;
  missing_classification_count?: number;
  classification_match_rate?: number;
  structural_issue_count?: number;
  migration_pending?: number;
  migrated_exact?: number;
  migrated_high_confidence?: number;
  migrated_unindexed_text?: number;
  migration_text_issues?: string[];
  structural_issues?: string[];
};

type Manifest = {
  sectionRevisions?: Record<string, number>;
};

type FontReport = {
  main_character_count?: number;
  ruby_character_count?: number;
  missing_main_characters?: string[];
  missing_ruby_characters?: string[];
  remaining_extension_slots?: number;
};

type ApplyPayload = {
  accepted?: unknown;
  changes?: unknown;
  backup_path?: string;
  migration_report_json?: string;
};

type FateExtraJobSnapshot = {
  job_id: string;
  kind: "scan" | "scan-apply" | "preview-index";
  status: "queued" | "running" | "cancelling" | "succeeded" | "cancelled" | "failed";
  phase: string;
  completed: number;
  total: number | null;
  project_epoch: number;
  source_revision: number;
  cancellable: boolean;
  result?: ScanReport | ApplyPayload;
  error?: {
    message?: string;
    details?: { scan_draft_retryable?: boolean };
  };
};

const FE_JOB_POLL_INTERVAL_MS = 500;

type CompactPayload = {
  target_project_path?: string;
  physical_item_count?: number;
  unique_source_count?: number;
  compact_item_count?: number;
  excluded_source_count?: number;
  excluded_occurrence_count?: number;
  machine_conflict_count?: number;
  proofread_conflict_count?: number;
  safety_conflict_count?: number;
};

function error_message(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "details" in error &&
    typeof error.details === "object" &&
    error.details !== null &&
    "reason" in error.details &&
    typeof error.details.reason === "string"
  ) {
    return error.details.reason;
  }
  return error instanceof Error ? error.message : String(error);
}

export function FateExtraPage(_props: ScreenComponentProps): JSX.Element {
  const { t } = useI18n();
  const { project_snapshot } = useDesktopState();
  const [source_directory, set_source_directory] = useState(DEFAULT_SOURCE);
  const [complete_jp_source_file, set_complete_jp_source_file] = useState("");
  const [classification_database, set_classification_database] = useState(DEFAULT_DATABASE);
  const [migration_project, set_migration_project] = useState(DEFAULT_MIGRATION);
  const [migration_text_directory, set_migration_text_directory] = useState(DEFAULT_MIGRATION_TEXT);
  const [output_directory, set_output_directory] = useState("");
  const [scan_report, set_scan_report] = useState<ScanReport | null>(null);
  const [font_report, set_font_report] = useState<FontReport | null>(null);
  const [adapter_enabled, set_adapter_enabled] = useState(false);
  const [compact_enabled, set_compact_enabled] = useState(false);
  const [busy, set_busy] = useState("");
  const [active_job, set_active_job] = useState<FateExtraJobSnapshot | null>(null);
  const [scan_requested_for_apply, set_scan_requested_for_apply] = useState(false);
  const [feedback, set_feedback] = useState("");
  const [error, set_error] = useState("");

  const project_path = project_snapshot.loaded ? project_snapshot.path : "";

  useEffect(() => {
    let active = true;
    set_scan_report(null);
    set_active_job(null);
    set_busy("");
    set_adapter_enabled(false);
    set_compact_enabled(false);
    if (project_path === "") return;
    void api_fetch<{ enabled?: boolean; compact_enabled?: boolean }>(
      "/api/toolbox/fate-extra/status",
      {
        project_path,
      },
    )
      .then((status) => {
        if (active) {
          set_adapter_enabled(status.enabled === true);
          set_compact_enabled(status.compact_enabled === true);
        }
      })
      .catch(() => {
        if (active) set_adapter_enabled(false);
      });
    return () => {
      active = false;
    };
  }, [project_path]);

  useEffect(() => {
    const initial_job = active_job;
    if (initial_job === null || !["queued", "running", "cancelling"].includes(initial_job.status)) {
      return;
    }
    let disposed = false;
    let timeout = 0;
    const abort_controller = new AbortController();

    const finish_job = (snapshot: FateExtraJobSnapshot): void => {
      if (snapshot.status === "succeeded") {
        if (snapshot.kind === "scan") {
          const report = (snapshot.result ?? {}) as ScanReport;
          set_scan_report(report);
          set_feedback(
            report.applicable
              ? scan_requested_for_apply
                ? t("fate_extra_page.scan_ready_apply_again")
                : t("fate_extra_page.scan_ready")
              : "",
          );
          set_scan_requested_for_apply(false);
        } else if (snapshot.kind === "scan-apply") {
          const result = (snapshot.result ?? {}) as ApplyPayload;
          set_feedback(`${t("fate_extra_page.apply_done")} ${String(result.backup_path ?? "")}`);
          set_adapter_enabled(true);
          set_scan_report(null);
        }
      } else if (snapshot.status === "failed") {
        if (
          snapshot.kind === "scan" ||
          (snapshot.kind === "scan-apply" && snapshot.error?.details?.scan_draft_retryable !== true)
        ) {
          set_scan_report(null);
        }
        set_error(snapshot.error?.message ?? t("fate_extra_page.job_failed"));
      } else if (snapshot.status === "cancelled") {
        if (snapshot.kind === "scan" || snapshot.kind === "scan-apply") {
          set_scan_report(null);
        }
        set_feedback(t("fate_extra_page.job_cancelled"));
      }
      if (snapshot.kind === "scan") set_scan_requested_for_apply(false);
      set_busy("");
      set_active_job(null);
    };

    const poll = async (): Promise<void> => {
      try {
        const snapshot = await api_fetch<FateExtraJobSnapshot>(
          "/api/toolbox/fate-extra/jobs/status",
          { job_id: initial_job.job_id },
          { signal: abort_controller.signal },
        );
        if (disposed) return;
        set_active_job(snapshot);
        if (["queued", "running", "cancelling"].includes(snapshot.status)) {
          timeout = window.setTimeout(() => void poll(), FE_JOB_POLL_INTERVAL_MS);
          return;
        }
        finish_job(snapshot);
      } catch (reason) {
        if (disposed || abort_controller.signal.aborted) return;
        set_error(error_message(reason));
        set_busy("");
        set_active_job(null);
      }
    };
    timeout = window.setTimeout(() => void poll(), FE_JOB_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      abort_controller.abort();
      window.clearTimeout(timeout);
    };
  }, [active_job?.job_id, scan_requested_for_apply, t]);

  async function choose_directory(
    current: string,
    update: (value: string) => void,
  ): Promise<string | null> {
    const result = await window.desktopApp.pickFixedProjectDirectory(current);
    const selected = result.paths[0];
    if (!result.canceled && selected !== undefined) {
      update(selected);
      return selected;
    }
    return null;
  }

  async function choose_file(update: (value: string) => void): Promise<string | null> {
    const result = await window.desktopApp.pickWorkbenchFilePath();
    const selected = result.paths[0];
    if (!result.canceled && selected !== undefined) {
      update(selected);
      return selected;
    }
    return null;
  }

  async function request_scan(for_apply: boolean): Promise<void> {
    if (project_path === "") {
      set_error(t("fate_extra_page.no_project"));
      return;
    }
    set_busy("scan");
    set_scan_report(null);
    set_scan_requested_for_apply(for_apply);
    set_error("");
    set_feedback("");
    try {
      const job = await api_fetch<FateExtraJobSnapshot>("/api/toolbox/fate-extra/scan", {
        project_path,
        source_directory,
        complete_jp_source_file,
        classification_database,
        migration_project,
        migration_text_directory,
      });
      set_active_job(job);
    } catch (reason) {
      set_error(error_message(reason));
      set_busy("");
    }
  }

  async function run_scan(): Promise<void> {
    await request_scan(false);
  }

  async function apply_adapter(): Promise<void> {
    if (scan_report?.applicable !== true || scan_report.scan_id === undefined) {
      await request_scan(true);
      return;
    }
    set_busy("apply");
    set_error("");
    try {
      const manifest = await api_fetch<Manifest>("/api/session/project/manifest", {});
      const revisions = manifest.sectionRevisions ?? {};
      const job = await api_fetch<FateExtraJobSnapshot>("/api/toolbox/fate-extra/apply", {
        project_path,
        scan_id: scan_report.scan_id,
        expected_section_revisions: {
          files: revisions.files ?? 0,
          items: revisions.items ?? 0,
          analysis: revisions.analysis ?? 0,
          proofreading: revisions.proofreading ?? 0,
        },
      });
      set_active_job(job);
    } catch (reason) {
      set_error(error_message(reason));
      set_busy("");
    }
  }

  async function cancel_active_job(): Promise<void> {
    if (active_job === null) return;
    try {
      const snapshot = await api_fetch<FateExtraJobSnapshot>(
        "/api/toolbox/fate-extra/jobs/cancel",
        { job_id: active_job.job_id },
      );
      set_active_job(snapshot);
    } catch (reason) {
      set_error(error_message(reason));
    }
  }

  async function scan_font(): Promise<void> {
    set_busy("font");
    set_error("");
    try {
      const report = await api_fetch<FontReport>("/api/toolbox/fate-extra/font/scan", {
        project_path,
      });
      set_font_report(report);
      set_feedback(t("fate_extra_page.font_ready"));
    } catch (reason) {
      set_error(error_message(reason));
    } finally {
      set_busy("");
    }
  }

  async function create_compact_project(): Promise<void> {
    const source_name =
      project_path === ""
        ? "Fate-Extra"
        : (project_path.split(/[\\/]/u).at(-1)?.replace(/\.lg$/iu, "") ?? "Fate-Extra");
    const selected = await window.desktopApp.pickProjectSavePath(`${source_name}-精简工程.lg`);
    const target_project_path = selected.paths[0];
    if (selected.canceled || target_project_path === undefined) return;
    set_busy("compact");
    set_error("");
    set_feedback("");
    try {
      const result = await api_fetch<CompactPayload>("/api/toolbox/fate-extra/compact/create", {
        project_path,
        target_project_path,
      });
      set_feedback(
        `${t("fate_extra_page.compact_done")} ${String(result.target_project_path ?? "")} ` +
          `(${Number(result.physical_item_count ?? 0).toLocaleString()} → ` +
          `${Number(result.compact_item_count ?? 0).toLocaleString()})`,
      );
    } catch (reason) {
      set_error(error_message(reason));
    } finally {
      set_busy("");
    }
  }

  async function export_project(restore_index: boolean): Promise<void> {
    let target_directory = output_directory.trim();
    if (target_directory === "") {
      const selected = await choose_directory(output_directory, set_output_directory);
      if (selected === null) return;
      target_directory = selected;
    }
    set_busy(restore_index ? "restore" : "export");
    set_error("");
    try {
      const result = await api_fetch<{ warning_count?: number; qa_report?: string }>(
        "/api/toolbox/fate-extra/export",
        {
          project_path,
          output_directory: target_directory,
          restore_index,
        },
      );
      set_feedback(
        `${t("fate_extra_page.export_done")} QA: ${String(result.qa_report ?? "")} (${Number(
          result.warning_count ?? 0,
        )})`,
      );
    } catch (reason) {
      set_error(error_message(reason));
    } finally {
      set_busy("");
    }
  }

  const fields = [
    {
      label: t("fate_extra_page.source_directory"),
      value: source_directory,
      update: (value: string) => {
        set_source_directory(value);
        set_scan_report(null);
      },
      picker: "directory" as const,
    },
    {
      label: t("fate_extra_page.classification_database"),
      value: classification_database,
      update: (value: string) => {
        set_classification_database(value);
        set_scan_report(null);
      },
      picker: "file" as const,
    },
    {
      label: t("fate_extra_page.complete_jp_source_file"),
      value: complete_jp_source_file,
      update: (value: string) => {
        set_complete_jp_source_file(value);
        set_scan_report(null);
      },
      picker: "file" as const,
    },
    {
      label: t("fate_extra_page.migration_project"),
      value: migration_project,
      update: (value: string) => {
        set_migration_project(value);
        set_scan_report(null);
      },
      picker: "file" as const,
    },
    {
      label: t("fate_extra_page.migration_text_directory"),
      value: migration_text_directory,
      update: (value: string) => {
        set_migration_text_directory(value);
        set_scan_report(null);
      },
      picker: "directory" as const,
    },
    {
      label: t("fate_extra_page.output_directory"),
      value: output_directory,
      update: set_output_directory,
      picker: "directory" as const,
    },
  ];

  return (
    <div className="fate-extra-page page-shell page-shell--full">
      <Card className="fate-extra-page__intro">
        <CardHeader>
          <CardTitle>{t("fate_extra_page.title")}</CardTitle>
          <CardDescription>{t("fate_extra_page.description")}</CardDescription>
        </CardHeader>
        <CardContent className="fate-extra-page__fields">
          {fields.map((field) => (
            <label className="fate-extra-page__field" key={field.label}>
              <span>{field.label}</span>
              <div className="fate-extra-page__field-control">
                <Input
                  value={field.value}
                  disabled={busy !== ""}
                  onChange={(event) => field.update(event.target.value)}
                />
                {field.picker !== undefined ? (
                  <AppButton
                    size="sm"
                    variant="outline"
                    disabled={busy !== ""}
                    onClick={() =>
                      void (field.picker === "file"
                        ? choose_file(field.update)
                        : choose_directory(field.value, field.update))
                    }
                  >
                    <FolderOpen data-icon="inline-start" />
                    {t("fate_extra_page.browse")}
                  </AppButton>
                ) : null}
              </div>
            </label>
          ))}
        </CardContent>
      </Card>

      <div className="fate-extra-page__actions">
        <AppButton disabled={busy !== "" || project_path === ""} onClick={() => void run_scan()}>
          {busy === "scan" ? <Spinner /> : <ScanSearch data-icon="inline-start" />}
          {busy === "scan" ? t("fate_extra_page.busy") : t("fate_extra_page.scan")}
        </AppButton>
        <AppButton
          disabled={busy !== "" || project_path === ""}
          onClick={() => void apply_adapter()}
        >
          {busy === "apply" ? <Spinner /> : <Database data-icon="inline-start" />}
          {t("fate_extra_page.apply")}
        </AppButton>
        <AppButton
          variant="outline"
          disabled={busy !== "" || project_path === ""}
          onClick={() => void scan_font()}
        >
          {busy === "font" ? <Spinner /> : <FileCheck2 data-icon="inline-start" />}
          {t("fate_extra_page.font_scan")}
        </AppButton>
        <AppButton
          variant="outline"
          disabled={busy !== "" || project_path === "" || !adapter_enabled || compact_enabled}
          title={
            compact_enabled
              ? t("fate_extra_page.compact_already")
              : !adapter_enabled
                ? t("fate_extra_page.export_requires_adapter")
                : undefined
          }
          onClick={() => void create_compact_project()}
        >
          {busy === "compact" ? <Spinner /> : <PackageMinus data-icon="inline-start" />}
          {t("fate_extra_page.compact_create")}
        </AppButton>
        <AppButton
          variant="outline"
          disabled={busy !== "" || project_path === "" || !adapter_enabled}
          title={!adapter_enabled ? t("fate_extra_page.export_requires_adapter") : undefined}
          onClick={() => void export_project(false)}
        >
          <Upload data-icon="inline-start" />
          {t("fate_extra_page.export_without_index")}
        </AppButton>
        <AppButton
          variant="outline"
          disabled={busy !== "" || project_path === "" || !adapter_enabled}
          title={!adapter_enabled ? t("fate_extra_page.export_requires_adapter") : undefined}
          onClick={() => void export_project(true)}
        >
          <Upload data-icon="inline-start" />
          {t("fate_extra_page.export_restore_index")}
        </AppButton>
      </div>

      <p className="fate-extra-page__workflow-hint">{t("fate_extra_page.workflow_hint")}</p>
      {active_job !== null ? (
        <div className="fate-extra-page__job" role="status">
          <span>
            {t("fate_extra_page.job_progress")}：{active_job.phase}
            {active_job.total === null
              ? ""
              : ` ${active_job.completed.toLocaleString()}/${active_job.total.toLocaleString()}`}
          </span>
          {active_job.cancellable &&
          ["queued", "running", "cancelling"].includes(active_job.status) ? (
            <AppButton
              size="sm"
              variant="outline"
              disabled={active_job.status === "cancelling"}
              onClick={() => void cancel_active_job()}
            >
              {t("fate_extra_page.job_cancel")}
            </AppButton>
          ) : null}
        </div>
      ) : null}
      {error !== "" ? <p className="fate-extra-page__error">{error}</p> : null}
      {feedback !== "" ? <p className="fate-extra-page__feedback">{feedback}</p> : null}

      {scan_report !== null ? (
        <Card className="fate-extra-page__report">
          <CardHeader>
            <CardTitle>{t("fate_extra_page.report")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="fate-extra-page__metrics">
              <Badge variant="outline">文件 {scan_report.source_file_count ?? 0}/6</Badge>
              <Badge variant="outline">
                路线文本 {scan_report.route_logical_text_count ?? 0}/34,693
              </Badge>
              <Badge variant="outline">
                完整主库 {scan_report.complete_jp_text_count ?? 0}/914,663
              </Badge>
              <Badge variant="outline">
                主库差集补漏 {scan_report.supplemental_text_count ?? 0}
              </Badge>
              <Badge variant="outline">总文本 {scan_report.logical_text_count ?? 0}</Badge>
              <Badge variant="outline">唯一索引 {scan_report.unique_index_count ?? 0}</Badge>
              <Badge variant="outline">
                分类匹配 {Math.round(Number(scan_report.classification_match_rate ?? 0) * 100)}%
              </Badge>
              <Badge variant="outline">
                缺少安全分类 {scan_report.missing_classification_count ?? 0}
              </Badge>
              <Badge variant="outline">待确认 {scan_report.migration_pending ?? 0}</Badge>
              <Badge variant="outline">无索引迁移 {scan_report.migrated_unindexed_text ?? 0}</Badge>
            </div>
            {(scan_report.structural_issues ?? []).length > 0 ||
            (scan_report.migration_text_issues ?? []).length > 0 ? (
              <pre className="fate-extra-page__issues">
                {[
                  ...(scan_report.structural_issues ?? []),
                  ...(scan_report.migration_text_issues ?? []),
                ].join("\n")}
              </pre>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {font_report !== null ? (
        <Card>
          <CardContent className="fate-extra-page__font-report">
            <span>主字库字符：{font_report.main_character_count ?? 0}</span>
            <span>Ruby 字符：{font_report.ruby_character_count ?? 0}</span>
            <span>主字库待补：{font_report.missing_main_characters?.length ?? 0}</span>
            <span>Ruby 待补：{font_report.missing_ruby_characters?.length ?? 0}</span>
            <span>剩余编码槽：{font_report.remaining_extension_slots ?? 0}</span>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
