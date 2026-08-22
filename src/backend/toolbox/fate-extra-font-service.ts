import { spawnSync } from "node:child_process";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { AppPathService } from "../app/app-path-service";
import type { ApiJsonValue } from "../api/api-types";
import type { ProjectDatabase } from "../database/database-operations";
import type { ProjectSessionState } from "../project/project-session";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import { resolve_fate_extra_preview_runs } from "../../shared/fate-extra/fate-extra-layout";
import {
  read_fate_extra_item_metadata,
  resolve_fate_extra_effective_translation,
} from "../../shared/fate-extra/fate-extra-types";

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

export type FateExtraFontBuildInput = {
  baseline_dir: string;
  font_path: string;
  helper_executable: string;
  helper_source: string;
  helper_working_directory: string;
};

const EXTENSION_CAPACITY = 1880;

function read_record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 已在数据库侧去重的有效文本可以逐条生成字库 corpus，避免构造百万 item payload。
 */
export function build_fate_extra_font_corpus_from_resolved_texts(
  texts: Iterable<string>,
): FateExtraFontCorpus {
  const main = new Set<string>();
  const ruby = new Set<string>();
  for (const text of texts) {
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
    corpus_sha256: createHash("sha256").update(main_characters.join(""), "utf-8").digest("hex"),
  };
}

/**
 * 字库构建器的纯边界，可由隔离 worker 调用；调用方负责提供资源路径与 staging 输出目录。
 */
export function sync_fate_extra_font_corpus(
  corpus: FateExtraFontCorpus,
  output_dir: string,
  build_input: FateExtraFontBuildInput,
  native_fs: NativeFs = default_native_fs,
): JsonRecord {
  native_fs.make_dir(output_dir);
  const request_path = path.join(output_dir, `.font-job-${randomUUID()}.json`);
  const request = {
    baseline_dir: build_input.baseline_dir,
    output_dir,
    font_path: build_input.font_path,
    main_characters: corpus.main_characters,
    ruby_characters: corpus.ruby_characters,
  };
  native_fs.write_file_sync(request_path, `${JSON.stringify(request)}\n`);
  try {
    const executable_available = native_fs.exists(build_input.helper_executable);
    const result = spawnSync(
      executable_available ? build_input.helper_executable : "python",
      executable_available ? [request_path] : [build_input.helper_source, request_path],
      {
        cwd: build_input.helper_working_directory,
        encoding: "utf-8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
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
    const parsed = JSON.parse(output) as { ok?: boolean; error?: string; result?: JsonRecord };
    if (parsed.ok !== true || parsed.result === undefined) {
      throw new Error(parsed.error ?? "FE 字库生成器返回了无效结果。");
    }
    return parsed.result;
  } finally {
    native_fs.remove(request_path, { force: true });
  }
}

/**
 * Owns FE font coverage checks and the packaged deterministic helper process.
 * Missing glyphs are export infrastructure, never proofreading warnings.
 */
export class FateExtraFontService {
  private encoded_widths: Map<string, number> | null = null;
  public constructor(
    private readonly paths: AppPathService,
    private readonly database: ProjectDatabase,
    private readonly session_state: ProjectSessionState,
    private readonly native_fs: NativeFs = default_native_fs,
  ) {}

  public scan(body: JsonRecord): JsonRecord {
    const project_path = this.require_loaded_project(body);
    const corpus = this.read_project_corpus(project_path);
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
    return this.sync_corpus(
      this.read_project_corpus(project_path),
      output_dir,
    ) as unknown as JsonRecord;
  }

  public sync_items(items: Record<string, unknown>[], output_dir: string): JsonRecord {
    return this.sync_corpus(this.build_corpus(items), output_dir);
  }

  public read_worker_build_input(): FateExtraFontBuildInput {
    return {
      baseline_dir: this.paths.get_resource_path("fate-extra", "fontpack", "NPJH50247"),
      font_path: this.paths.get_resource_path("fate-extra", "fonts", "NotoSansCJKsc-Regular.otf"),
      helper_executable: this.paths.get_resource_path(
        "fate-extra",
        "bin",
        "fate-extra-font-builder.exe",
      ),
      helper_source: path.join(
        this.paths.get_app_root(),
        "buildtools",
        "fate-extra-font",
        "font_builder.py",
      ),
      helper_working_directory: this.paths.get_app_root(),
    };
  }

  private sync_corpus(corpus: FateExtraFontCorpus, output_dir: string): JsonRecord {
    return sync_fate_extra_font_corpus(
      corpus,
      output_dir,
      this.read_worker_build_input(),
      this.native_fs,
    );
  }

  public build_corpus(items: Record<string, unknown>[]): FateExtraFontCorpus {
    const resolved_texts = new Set<string>();
    for (const item of items) {
      const dst = String(item["dst"] ?? "");
      const src = String(item["src"] ?? "");
      const metadata = read_fate_extra_item_metadata(
        item["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
      );
      const translated =
        metadata === null ? dst : resolve_fate_extra_effective_translation(dst, metadata);
      const text = translated === "" ? src : translated;
      resolved_texts.add(text);
    }
    return build_fate_extra_font_corpus_from_resolved_texts(resolved_texts);
  }

  /** Measure the bytes that FE's custom Shift-JIS-compatible codec will emit. */
  public measure_encoded_bytes(text: string): number {
    const widths = this.read_encoded_widths();
    let total = 0;
    for (const char of text) {
      const mapped = widths.get(char);
      if (mapped !== undefined) {
        total += mapped;
      } else if ((char.codePointAt(0) ?? 0) <= 0x7f) {
        total += 1;
      } else {
        // New visible CJK glyphs are allocated from the two-byte FE extension area.
        total += 2;
      }
    }
    return total;
  }

  /** Structured-clone-safe codec snapshot for the isolated preview query worker. */
  public read_encoded_width_snapshot(): Array<[string, number]> {
    return [...this.read_encoded_widths().entries()];
  }

  private read_encoded_widths(): Map<string, number> {
    if (this.encoded_widths !== null) return this.encoded_widths;
    const baseline_dir = this.paths.get_resource_path("fate-extra", "fontpack", "NPJH50247");
    const codec = this.read_json_file(path.join(baseline_dir, "chinese-glyph-codec.json"));
    const records = Array.isArray(codec["records"]) ? codec["records"] : [];
    this.encoded_widths = new Map(
      records.flatMap((raw) => {
        const record = read_record(raw);
        const char = String(record["char"] ?? "");
        const encoded = String(record["encoded_hex"] ?? "");
        return char === "" || encoded.length % 2 !== 0 ? [] : [[char, encoded.length / 2] as const];
      }),
    );
    return this.encoded_widths;
  }

  private read_project_corpus(project_path: string): FateExtraFontCorpus {
    const value = this.database.execute({
      name: "getFateExtraFontCorpusTexts",
      args: { projectPath: project_path },
    });
    return build_fate_extra_font_corpus_from_resolved_texts(
      Array.isArray(value) ? value.map((text) => String(text ?? "")) : [],
    );
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
}
