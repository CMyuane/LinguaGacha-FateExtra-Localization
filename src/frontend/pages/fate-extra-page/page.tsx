import { useEffect, useState } from "react";
import { Database, FileCheck2, FolderOpen, ScanSearch, Upload } from "lucide-react";

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

const DEFAULT_SOURCE = "D:\\AA_Fe_Transition\\灵瓜处理\\最终文本分支_带索引日文原版";
const DEFAULT_DATABASE = "D:\\AA_Fe_Transition\\文本安全分类\\FE文本安全分类.sqlite";
const DEFAULT_MIGRATION = "D:\\灵瓜\\FE_尼禄线_凛分支_保留索引日文.lg";
const DEFAULT_MIGRATION_TEXT = "D:\\AA_Fe_Transition\\灵瓜处理";

type ScanReport = {
  scan_id?: string;
  applicable?: boolean;
  source_file_count?: number;
  logical_text_count?: number;
  unique_index_count?: number;
  matched_classification_count?: number;
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
  const { project_snapshot, commit_project_write } = useDesktopState();
  const [source_directory, set_source_directory] = useState(DEFAULT_SOURCE);
  const [classification_database, set_classification_database] = useState(DEFAULT_DATABASE);
  const [migration_project, set_migration_project] = useState(DEFAULT_MIGRATION);
  const [migration_text_directory, set_migration_text_directory] = useState(DEFAULT_MIGRATION_TEXT);
  const [output_directory, set_output_directory] = useState("");
  const [scan_report, set_scan_report] = useState<ScanReport | null>(null);
  const [font_report, set_font_report] = useState<FontReport | null>(null);
  const [adapter_enabled, set_adapter_enabled] = useState(false);
  const [busy, set_busy] = useState("");
  const [feedback, set_feedback] = useState("");
  const [error, set_error] = useState("");

  const project_path = project_snapshot.loaded ? project_snapshot.path : "";

  useEffect(() => {
    let active = true;
    set_scan_report(null);
    set_adapter_enabled(false);
    if (project_path === "") return;
    void api_fetch<{ enabled?: boolean }>("/api/toolbox/fate-extra/status", {
      project_path,
    })
      .then((status) => {
        if (active) set_adapter_enabled(status.enabled === true);
      })
      .catch(() => {
        if (active) set_adapter_enabled(false);
      });
    return () => {
      active = false;
    };
  }, [project_path]);

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

  async function request_scan(busy_state: "scan" | "apply"): Promise<ScanReport | null> {
    if (project_path === "") {
      set_error(t("fate_extra_page.no_project"));
      return null;
    }
    set_busy(busy_state);
    set_error("");
    set_feedback("");
    try {
      const report = await api_fetch<ScanReport>("/api/toolbox/fate-extra/scan", {
        project_path,
        source_directory,
        classification_database,
        migration_project,
        migration_text_directory,
      });
      set_scan_report(report);
      set_feedback(report.applicable ? t("fate_extra_page.scan_ready") : "");
      return report;
    } catch (reason) {
      set_error(error_message(reason));
      return null;
    } finally {
      set_busy("");
    }
  }

  async function run_scan(): Promise<void> {
    await request_scan("scan");
  }

  async function apply_adapter(): Promise<void> {
    if (scan_report?.applicable !== true || scan_report.scan_id === undefined) {
      const report = await request_scan("apply");
      if (report?.applicable === true) {
        set_feedback(t("fate_extra_page.scan_ready_apply_again"));
      }
      return;
    }
    set_busy("apply");
    set_error("");
    try {
      const manifest = await api_fetch<Manifest>("/api/session/project/manifest", {});
      const revisions = manifest.sectionRevisions ?? {};
      const result = await commit_project_write<ApplyPayload>({
        operation: "fate-extra.apply",
        run: async () =>
          await api_fetch<ApplyPayload>("/api/toolbox/fate-extra/apply", {
            project_path,
            scan_id: scan_report.scan_id,
            expected_section_revisions: {
              files: revisions.files ?? 0,
              items: revisions.items ?? 0,
              analysis: revisions.analysis ?? 0,
              proofreading: revisions.proofreading ?? 0,
            },
          }),
      });
      set_feedback(
        `${t("fate_extra_page.apply_done")} ${String(result.payload.backup_path ?? "")}`,
      );
      set_adapter_enabled(true);
      set_scan_report(null);
    } catch (reason) {
      set_error(error_message(reason));
    } finally {
      set_busy("");
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
      browse: true,
    },
    {
      label: t("fate_extra_page.classification_database"),
      value: classification_database,
      update: (value: string) => {
        set_classification_database(value);
        set_scan_report(null);
      },
      browse: false,
    },
    {
      label: t("fate_extra_page.migration_project"),
      value: migration_project,
      update: (value: string) => {
        set_migration_project(value);
        set_scan_report(null);
      },
      browse: false,
    },
    {
      label: t("fate_extra_page.migration_text_directory"),
      value: migration_text_directory,
      update: (value: string) => {
        set_migration_text_directory(value);
        set_scan_report(null);
      },
      browse: true,
    },
    {
      label: t("fate_extra_page.output_directory"),
      value: output_directory,
      update: set_output_directory,
      browse: true,
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
                {field.browse ? (
                  <AppButton
                    size="sm"
                    variant="outline"
                    disabled={busy !== ""}
                    onClick={() => void choose_directory(field.value, field.update)}
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
              <Badge variant="outline">文本 {scan_report.logical_text_count ?? 0}/34,693</Badge>
              <Badge variant="outline">唯一索引 {scan_report.unique_index_count ?? 0}/7,867</Badge>
              <Badge variant="outline">
                分类匹配 {Math.round(Number(scan_report.classification_match_rate ?? 0) * 100)}%
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
