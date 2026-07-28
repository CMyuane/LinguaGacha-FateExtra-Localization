import { spawnSync } from "node:child_process";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { AppPathService } from "../app/app-path-service";
import type { ApiJsonValue } from "../api/api-types";
import type { ProjectDatabase } from "../database/database-operations";
import type { ProjectSessionState } from "../project/project-session";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import { resolve_fate_extra_preview_runs } from "../../shared/fate-extra/fate-extra-layout";

type JsonRecord = Record<string, ApiJsonValue>;

export type FateExtraFontCorpus = {
  main_characters: string[];
  ruby_characters: string[];
  corpus_sha256: string;
};

export type FateExtraFontScanResult = {
  main_character_count: number;
  ruby_character_count: number;
  missing_main_characters: string[];
  missing_ruby_characters: string[];
  remaining_extension_slots: number;
  corpus_sha256: string;
};

const EXTENSION_CAPACITY = 1880;

function read_record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Owns FE font coverage checks and the packaged deterministic helper process.
 * Missing glyphs are export infrastructure, never proofreading warnings.
 */
export class FateExtraFontService {
  public constructor(
    private readonly paths: AppPathService,
    private readonly database: ProjectDatabase,
    private readonly session_state: ProjectSessionState,
    private readonly native_fs: NativeFs = default_native_fs,
  ) {}

  public scan(body: JsonRecord): JsonRecord {
    const project_path = this.require_loaded_project(body);
    const items = this.read_items(project_path);
    const corpus = this.build_corpus(items);
    const baseline_dir = this.paths.get_resource_path("fate-extra", "fontpack", "NPJH50247");
    const codec = this.read_json_file(path.join(baseline_dir, "chinese-glyph-codec.json"));
    const ruby_map = this.read_json_file(path.join(baseline_dir, "ruby-font-map.json"));
    const codec_records = Array.isArray(codec["records"]) ? codec["records"] : [];
    const ruby_records = Array.isArray(ruby_map["records"]) ? ruby_map["records"] : [];
    const covered_main = new Set(
      codec_records.map((record) => String(read_record(record)["char"] ?? "")),
    );
    const covered_ruby = new Set(
      ruby_records.map((record) => String(read_record(record)["char"] ?? "")),
    );
    const used_extensions = codec_records.filter((record) => {
      const encoded = String(read_record(record)["encoded_hex"] ?? "");
      return encoded.length === 4 && /^F[0-9A-F]/u.test(encoded);
    }).length;
    const result: FateExtraFontScanResult = {
      main_character_count: corpus.main_characters.length,
      ruby_character_count: corpus.ruby_characters.length,
      missing_main_characters: corpus.main_characters.filter((char) => !covered_main.has(char)),
      missing_ruby_characters: corpus.ruby_characters.filter((char) => !covered_ruby.has(char)),
      remaining_extension_slots: EXTENSION_CAPACITY - used_extensions,
      corpus_sha256: corpus.corpus_sha256,
    };
    return result as unknown as JsonRecord;
  }

  public sync(body: JsonRecord): JsonRecord {
    const project_path = this.require_loaded_project(body);
    const output_dir = this.require_string(body, "output_directory");
    const items = this.read_items(project_path);
    return this.sync_items(items, output_dir) as unknown as JsonRecord;
  }

  public sync_items(items: Record<string, unknown>[], output_dir: string): JsonRecord {
    const corpus = this.build_corpus(items);
    const baseline_dir = this.paths.get_resource_path("fate-extra", "fontpack", "NPJH50247");
    const font_path = this.paths.get_resource_path(
      "fate-extra",
      "fonts",
      "NotoSansCJKsc-Regular.otf",
    );
    const request_dir = this.paths.get_user_data_path("fate-extra", "font-jobs");
    this.native_fs.make_dir(request_dir);
    const request_path = path.join(request_dir, `${randomUUID()}.json`);
    const request = {
      baseline_dir,
      output_dir,
      font_path,
      main_characters: corpus.main_characters,
      ruby_characters: corpus.ruby_characters,
    };
    this.native_fs.write_file_sync(request_path, `${JSON.stringify(request)}\n`);
    try {
      const result = this.run_helper(request_path);
      const parsed = JSON.parse(result) as { ok?: boolean; error?: string; result?: JsonRecord };
      if (parsed.ok !== true || parsed.result === undefined) {
        throw new Error(parsed.error ?? "FE 字库生成器返回了无效结果。");
      }
      return parsed.result;
    } finally {
      this.native_fs.remove(request_path, { force: true });
    }
  }

  public build_corpus(items: Record<string, unknown>[]): FateExtraFontCorpus {
    const main = new Set<string>();
    const ruby = new Set<string>();
    for (const item of items) {
      const dst = String(item["dst"] ?? "");
      const src = String(item["src"] ?? "");
      const text = dst === "" ? src : dst;
      for (let servant_index = 0; servant_index < 4; servant_index += 1) {
        for (let gender_index = 0; gender_index < 2; gender_index += 1) {
          const runs = resolve_fate_extra_preview_runs({
            text,
            state: { servant_index, gender_index },
          });
          for (const run of runs) {
            for (const char of run.text) {
              if (!/\s/u.test(char)) main.add(char);
            }
            for (const char of run.ruby) {
              if (!/\s/u.test(char)) {
                ruby.add(char);
                main.add(char);
              }
            }
          }
        }
      }
    }
    const main_characters = [...main].sort(
      (left, right) => left.codePointAt(0)! - right.codePointAt(0)!,
    );
    const ruby_characters = [...ruby].sort(
      (left, right) => left.codePointAt(0)! - right.codePointAt(0)!,
    );
    return {
      main_characters,
      ruby_characters,
      corpus_sha256: this.sha256_text(main_characters.join("")),
    };
  }

  private run_helper(request_path: string): string {
    const executable = this.paths.get_resource_path(
      "fate-extra",
      "bin",
      "fate-extra-font-builder.exe",
    );
    const source = path.join(
      this.paths.get_app_root(),
      "buildtools",
      "fate-extra-font",
      "font_builder.py",
    );
    const command = this.native_fs.exists(executable) ? executable : "python";
    const args = this.native_fs.exists(executable) ? [request_path] : [source, request_path];
    const result = spawnSync(command, args, {
      cwd: this.paths.get_app_root(),
      encoding: "utf-8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = String(result.stdout ?? "").trim();
    if (result.status !== 0) {
      let message = String(result.stderr ?? "").trim();
      try {
        const parsed = JSON.parse(output) as { error?: string };
        message = parsed.error ?? message;
      } catch {
        // Preserve process diagnostics when the helper could not emit JSON.
      }
      throw new Error(message || "FE 字库生成失败。");
    }
    return output;
  }

  private read_items(project_path: string): Record<string, unknown>[] {
    const value = this.database.execute({
      name: "getAllItems",
      args: { projectPath: project_path },
    });
    return Array.isArray(value) ? value.map(read_record) : [];
  }

  private require_loaded_project(body: JsonRecord): string {
    const state = this.session_state.snapshot();
    if (!state.loaded || state.projectPath === "") {
      throw new Error("请先打开一个 .lg 项目。");
    }
    const requested = typeof body["project_path"] === "string" ? body["project_path"].trim() : "";
    if (
      requested !== "" &&
      this.native_fs.to_identity_path(requested) !==
        this.native_fs.to_identity_path(state.projectPath)
    ) {
      throw new Error("项目已切换，请重新执行 FE 字库扫描。");
    }
    return state.projectPath;
  }

  private require_string(body: JsonRecord, key: string): string {
    const value = typeof body[key] === "string" ? body[key].trim() : "";
    if (value === "") throw new Error(`缺少参数：${key}`);
    return value;
  }

  private read_json_file(file_path: string): Record<string, unknown> {
    if (!this.native_fs.exists(file_path)) {
      throw new Error(`FE 字库资源不存在：${file_path}`);
    }
    return read_record(JSON.parse(this.native_fs.read_text_file(file_path)));
  }

  private sha256_text(text: string): string {
    // The corpus is already deterministically sorted. A compact synchronous hash
    // is sufficient and avoids passing mutable helper state across processes.
    return createHash("sha256").update(text, "utf-8").digest("hex");
  }
}
