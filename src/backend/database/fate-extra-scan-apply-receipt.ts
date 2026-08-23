import path from "node:path";

export const FATE_EXTRA_SCAN_APPLY_RECEIPT_META_KEY = "fate_extra.scan_apply_receipt.v1";

export const FATE_EXTRA_SCAN_APPLY_RECEIPT_SCHEMA_VERSION = 1;

export const FATE_EXTRA_SCAN_APPLY_PENDING_MANIFEST_SCHEMA_VERSION = 1;

const APPLY_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const RECEIPT_SECTIONS = ["files", "items", "analysis", "proofreading"] as const;

export type FateExtraScanApplyReceipt = {
  schema_version: typeof FATE_EXTRA_SCAN_APPLY_RECEIPT_SCHEMA_VERSION;
  apply_token: string;
  scan_id: string;
  committed_at: string;
  backup_path: string;
  migration_report_json: string;
  migration_report_csv: string;
  logical_text_count: number;
  section_revisions: Record<(typeof RECEIPT_SECTIONS)[number], number>;
};

export type FateExtraScanApplyArtifactPaths = {
  backup_path: string;
  migration_report_json: string;
  migration_report_csv: string;
  migration_report_json_temporary: string;
  migration_report_csv_temporary: string;
  pending_manifest_path: string;
};

export type FateExtraScanApplyPendingManifest = {
  schema_version: typeof FATE_EXTRA_SCAN_APPLY_PENDING_MANIFEST_SCHEMA_VERSION;
  apply_token: string;
  project_path: string;
  backup_path: string;
  migration_report_json_temporary: string;
  migration_report_csv_temporary: string;
  previous_receipt_apply_token: string | null;
  created_at: string;
};

export function build_fate_extra_scan_apply_artifact_paths(
  project_path: string,
  apply_token: string,
): FateExtraScanApplyArtifactPaths {
  const extension = path.extname(project_path);
  const base = project_path.slice(0, -extension.length);
  const migration_report_json = `${base}.fe-migration-report.json`;
  const migration_report_csv = `${base}.fe-migration-report.csv`;
  return {
    backup_path: `${base}.fe-backup-${apply_token}${extension}`,
    migration_report_json,
    migration_report_csv,
    migration_report_json_temporary: `${migration_report_json}.${apply_token}.tmp`,
    migration_report_csv_temporary: `${migration_report_csv}.${apply_token}.tmp`,
    pending_manifest_path: `${base}.fe-apply-${apply_token}.pending.json`,
  };
}

export function build_fate_extra_scan_apply_pending_manifest(
  project_path: string,
  apply_token: string,
  previous_receipt_apply_token: string | null,
): FateExtraScanApplyPendingManifest {
  const artifacts = build_fate_extra_scan_apply_artifact_paths(project_path, apply_token);
  return {
    schema_version: FATE_EXTRA_SCAN_APPLY_PENDING_MANIFEST_SCHEMA_VERSION,
    apply_token,
    project_path,
    backup_path: artifacts.backup_path,
    migration_report_json_temporary: artifacts.migration_report_json_temporary,
    migration_report_csv_temporary: artifacts.migration_report_csv_temporary,
    previous_receipt_apply_token,
    created_at: new Date().toISOString(),
  };
}

/**
 * 启动恢复只认当前项目专属前缀和 UUID token；相似用户文件不会进入清理集合。
 */
export function parse_fate_extra_scan_apply_pending_manifest_name(
  project_path: string,
  file_name: string,
): string | null {
  const extension = path.extname(project_path);
  const project_name = path.basename(project_path, extension);
  const prefix = `${project_name}.fe-apply-`;
  const suffix = ".pending.json";
  if (!file_name.startsWith(prefix) || !file_name.endsWith(suffix)) return null;
  const apply_token = file_name.slice(prefix.length, -suffix.length);
  return APPLY_TOKEN_PATTERN.test(apply_token) ? apply_token : null;
}

export function read_fate_extra_scan_apply_pending_manifest(
  value: unknown,
): FateExtraScanApplyPendingManifest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record["schema_version"] !== FATE_EXTRA_SCAN_APPLY_PENDING_MANIFEST_SCHEMA_VERSION ||
    !is_non_empty_string(record["apply_token"]) ||
    !APPLY_TOKEN_PATTERN.test(record["apply_token"]) ||
    !is_non_empty_string(record["project_path"]) ||
    !is_non_empty_string(record["backup_path"]) ||
    !is_non_empty_string(record["migration_report_json_temporary"]) ||
    !is_non_empty_string(record["migration_report_csv_temporary"]) ||
    (record["previous_receipt_apply_token"] !== null &&
      !is_non_empty_string(record["previous_receipt_apply_token"])) ||
    !is_non_empty_string(record["created_at"])
  ) {
    return null;
  }
  return {
    schema_version: FATE_EXTRA_SCAN_APPLY_PENDING_MANIFEST_SCHEMA_VERSION,
    apply_token: record["apply_token"],
    project_path: record["project_path"],
    backup_path: record["backup_path"],
    migration_report_json_temporary: record["migration_report_json_temporary"],
    migration_report_csv_temporary: record["migration_report_csv_temporary"],
    previous_receipt_apply_token: record["previous_receipt_apply_token"],
    created_at: record["created_at"],
  };
}

/**
 * receipt 是 apply 事务内的持久提交证明；恢复路径只接受完整、版本匹配的值。
 */
export function read_fate_extra_scan_apply_receipt(
  value: unknown,
): FateExtraScanApplyReceipt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const revisions = record["section_revisions"];
  if (typeof revisions !== "object" || revisions === null || Array.isArray(revisions)) {
    return null;
  }
  const revision_record = revisions as Record<string, unknown>;
  const section_revisions = Object.fromEntries(
    RECEIPT_SECTIONS.map((section) => [section, revision_record[section]]),
  ) as Record<(typeof RECEIPT_SECTIONS)[number], unknown>;
  if (
    record["schema_version"] !== FATE_EXTRA_SCAN_APPLY_RECEIPT_SCHEMA_VERSION ||
    !is_non_empty_string(record["apply_token"]) ||
    !is_non_empty_string(record["scan_id"]) ||
    !is_non_empty_string(record["committed_at"]) ||
    !is_non_empty_string(record["backup_path"]) ||
    !is_non_empty_string(record["migration_report_json"]) ||
    !is_non_empty_string(record["migration_report_csv"]) ||
    !is_non_negative_integer(record["logical_text_count"]) ||
    !RECEIPT_SECTIONS.every((section) => is_non_negative_integer(section_revisions[section]))
  ) {
    return null;
  }
  return {
    schema_version: FATE_EXTRA_SCAN_APPLY_RECEIPT_SCHEMA_VERSION,
    apply_token: record["apply_token"],
    scan_id: record["scan_id"],
    committed_at: record["committed_at"],
    backup_path: record["backup_path"],
    migration_report_json: record["migration_report_json"],
    migration_report_csv: record["migration_report_csv"],
    logical_text_count: record["logical_text_count"],
    section_revisions: Object.fromEntries(
      RECEIPT_SECTIONS.map((section) => [section, section_revisions[section] as number]),
    ) as FateExtraScanApplyReceipt["section_revisions"],
  };
}

function is_non_empty_string(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function is_non_negative_integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
