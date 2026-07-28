import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import type { ApiJsonValue } from "../../../api/api-types";
import { TranslationWorkUnitRunner } from "./translation-runner";
import type { LLMClientPort, LLMRequestBody, LLMRequestResult } from "../../../llm/llm-types";
import type { TranslationWorkUnit } from "../../protocol/work-unit";

/**
 * 构造无条目的翻译 work unit，验证 runner 不会为无效 chunk 请求模型。
 */
function create_empty_translation_unit(): TranslationWorkUnit {
  return {
    kind: "translation",
    unit_id: "translation-unit-1",
    run_id: "run-1",
    model: {},
    config_snapshot: {},
    quality_snapshot: {},
    payload: {
      items: [],
      precedings: [],
    },
    diagnostics: {
      token_threshold: 0,
      split_count: 1,
      retry_count: 0,
      is_initial: true,
    },
  };
}

describe("TranslationWorkUnitRunner", () => {
  it("没有可翻译条目时返回 failed 空结果且不请求 LLM", async () => {
    const llm_client: LLMClientPort = {
      request: vi.fn(),
    };
    const runner = new TranslationWorkUnitRunner(process.cwd(), llm_client);

    await expect(
      runner.execute_unit(create_empty_translation_unit(), new AbortController().signal),
    ).resolves.toMatchObject({
      unit_id: "translation-unit-1",
      kind: "translation",
      outcome: "failed",
      metrics: {
        input_tokens: 0,
        output_tokens: 0,
      },
      output: {
        kind: "translation",
        items: [],
        row_count: 0,
      },
      logs: [],
    });
    expect(llm_client.request).not.toHaveBeenCalled();
  });

  it("SakuraLLM 含姓名请求仍走固定纯文本提示词且不写姓名译文", async () => {
    const captured_requests: LLMRequestBody[] = [];
    const llm_client: LLMClientPort = {
      request: vi.fn(async (body: LLMRequestBody) => {
        captured_requests.push(body);
        return {
          response_think: "",
          response_result: '{"0":"你好"}',
          input_tokens: 1,
          output_tokens: 1,
          cancelled: false,
          timeout: false,
          degraded: false,
        };
      }),
    };
    const runner = new TranslationWorkUnitRunner(await create_template_root(), llm_client);

    const result = await runner.execute_unit(
      {
        kind: "translation",
        unit_id: "translation-unit-1",
        run_id: "run-1",
        model: { api_format: "SakuraLLM" },
        config_snapshot: create_config_payload(),
        quality_snapshot: create_quality_payload(),
        payload: {
          items: [
            {
              id: 1,
              src: "こんにちは",
              name_src: "虎鉄",
              dst: "",
              status: "NONE",
              text_type: "TXT",
            },
          ],
          precedings: [],
        },
        diagnostics: {
          token_threshold: 512,
          split_count: 0,
          retry_count: 0,
          is_initial: true,
        },
      },
      new AbortController().signal,
    );

    if (result.output.kind !== "translation") {
      throw new Error("期望翻译输出");
    }
    expect(captured_requests[0]?.messages[1]?.content).toBe(
      "将下面的日文文本翻译成中文：\nこんにちは",
    );
    expect(result.output.items).toEqual([
      {
        id: 1,
        src: "こんにちは",
        name_src: "虎鉄",
        dst: "你好",
        status: "PROCESSED",
        text_type: "TXT",
      },
    ]);
  });

  it("完全无法解析译文时记录数据结构错误", async () => {
    const runner = new TranslationWorkUnitRunner(
      await create_template_root(),
      create_llm_client({
        response_result: "not a json response",
      }),
    );

    const result = await runner.execute_unit(
      create_translation_unit({
        model: { api_format: "OpenAI" },
        src: "こんにちは\n世界",
      }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    expect(String(result.logs[0]?.message ?? "")).toContain("数据结构错误");
    expect(String(result.logs[0]?.message ?? "")).not.toContain("行数不一致");
  });

  it("部分合法译文无法覆盖请求行时记录行数不一致", async () => {
    const runner = new TranslationWorkUnitRunner(
      await create_template_root(),
      create_llm_client({
        response_result: '{"0":"你好"}',
      }),
    );

    const result = await runner.execute_unit(
      create_translation_unit({
        model: { api_format: "SakuraLLM" },
        src: "こんにちは\n世界",
      }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    expect(String(result.logs[0]?.message ?? "")).toContain("行数不一致");
    expect(String(result.logs[0]?.message ?? "")).not.toContain("数据结构错误");
  });

  it("单条行数不一致达重试阈值时写回 fallback 译文并保留真实日志原因", async () => {
    const runner = new TranslationWorkUnitRunner(
      await create_template_root(),
      create_llm_client({
        response_result: '{"0":" 你好 "}',
      }),
    );

    const result = await runner.execute_unit(
      create_translation_unit({
        model: { api_format: "SakuraLLM" },
        src: "こんにちは\n世界",
        retry_count: 2,
      }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("success");
    expect(result.output).toMatchObject({
      kind: "translation",
      row_count: 1,
      items: [
        {
          id: 1,
          src: "こんにちは\n世界",
          dst: "你好\n",
          status: "PROCESSED",
          text_type: "TXT",
          retry_count: 2,
        },
      ],
    });
    expect(String(result.logs[0]?.message ?? "")).toContain("行数不一致");
  });

  it("单条行数不一致未达重试阈值时继续失败并递增重试次数", async () => {
    const runner = new TranslationWorkUnitRunner(
      await create_template_root(),
      create_llm_client({
        response_result: '{"0":"你好"}',
      }),
    );

    const result = await runner.execute_unit(
      create_translation_unit({
        model: { api_format: "SakuraLLM" },
        src: "こんにちは\n世界",
        retry_count: 1,
      }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    expect(result.output).toMatchObject({
      kind: "translation",
      row_count: 0,
      items: [
        {
          id: 1,
          dst: "",
          status: "NONE",
          retry_count: 2,
        },
      ],
    });
  });

  it("多条行数不一致达重试阈值时不混写 fallback", async () => {
    const runner = new TranslationWorkUnitRunner(
      await create_template_root(),
      create_llm_client({
        response_result: '{"0":"你好"}',
      }),
    );

    const result = await runner.execute_unit(
      create_translation_unit({
        model: { api_format: "SakuraLLM" },
        items: [
          {
            id: 1,
            src: "こんにちは",
            dst: "",
            status: "NONE",
            text_type: "TXT",
            retry_count: 2,
          },
          {
            id: 2,
            src: "世界",
            dst: "",
            status: "NONE",
            text_type: "TXT",
            retry_count: 2,
          },
        ],
      }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    expect(result.output).toMatchObject({
      kind: "translation",
      row_count: 0,
      items: [
        { id: 1, dst: "", status: "NONE", retry_count: 2 },
        { id: 2, dst: "", status: "NONE", retry_count: 2 },
      ],
    });
    expect(String(result.logs[0]?.message ?? "")).toContain("行数不一致");
  });

  it("完全无法解析译文即使达重试阈值也不写 fallback", async () => {
    const runner = new TranslationWorkUnitRunner(
      await create_template_root(),
      create_llm_client({
        response_result: "not a json response",
      }),
    );

    const result = await runner.execute_unit(
      create_translation_unit({
        model: { api_format: "OpenAI" },
        src: "こんにちは",
        retry_count: 2,
      }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    expect(result.output).toMatchObject({
      kind: "translation",
      row_count: 0,
      items: [
        {
          id: 1,
          dst: "",
          status: "NONE",
          retry_count: 3,
        },
      ],
    });
    expect(String(result.logs[0]?.message ?? "")).toContain("数据结构错误");
  });

  it("已对齐逐行质量失败达重试阈值时提交译文但日志保留空行原因", async () => {
    const runner = new TranslationWorkUnitRunner(
      await create_template_root(),
      create_llm_client({
        response_result: '{"0":"你好","1":""}',
      }),
    );

    const result = await runner.execute_unit(
      create_translation_unit({
        model: { api_format: "SakuraLLM" },
        src: "こんにちは\n世界",
        retry_count: 2,
      }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("success");
    expect(result.output).toMatchObject({
      kind: "translation",
      row_count: 1,
      items: [
        {
          id: 1,
          dst: "你好\n",
          status: "PROCESSED",
          retry_count: 2,
        },
      ],
    });
    expect(String(result.logs[0]?.message ?? "")).toContain("存在空行");
  });

  it("FE 固定槽位超长时只保留草稿并等待定向重试", async () => {
    const runner = new TranslationWorkUnitRunner(
      await create_template_root(),
      create_llm_client({ response_result: '{"0":"中文"}' }),
    );

    const result = await runner.execute_unit(
      create_translation_unit({
        model: { api_format: "SakuraLLM" },
        items: [
          {
            id: 1,
            src: "原文",
            dst: "",
            status: "NONE",
            text_type: "TXT",
            extra_field: create_fe_extra_field(2, false),
          },
        ],
      }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    expect(result.output).toMatchObject({
      kind: "translation",
      row_count: 0,
      items: [{ id: 1, dst: "中文", status: "NONE" }],
    });
    expect(String(result.logs.at(-1)?.message ?? "")).toContain(
      "当前 4 字节，容量 2 字节，至少缩短 2 字节",
    );
  });

  it("FE 允许超长和无容量条目不触发容量重试", async () => {
    const runner = new TranslationWorkUnitRunner(
      await create_template_root(),
      create_llm_client({ response_result: '{"0":"中文","1":"更多中文"}' }),
    );

    const result = await runner.execute_unit(
      create_translation_unit({
        model: { api_format: "SakuraLLM" },
        items: [
          {
            id: 1,
            src: "原文",
            dst: "",
            status: "NONE",
            text_type: "TXT",
            extra_field: create_fe_extra_field(2, true),
          },
          {
            id: 2,
            src: "原文二",
            dst: "",
            status: "NONE",
            text_type: "TXT",
            extra_field: create_fe_extra_field(null, false),
          },
        ],
      }),
      new AbortController().signal,
    );

    expect(result.output).toMatchObject({
      kind: "translation",
      row_count: 2,
      items: [
        { id: 1, dst: "中文", status: "PROCESSED" },
        { id: 2, dst: "更多中文", status: "PROCESSED" },
      ],
    });
  });

  it("FE 多条请求只重试超过容量的逻辑条目", async () => {
    const runner = new TranslationWorkUnitRunner(
      await create_template_root(),
      create_llm_client({ response_result: '{"0":"过长","1":"短"}' }),
    );

    const result = await runner.execute_unit(
      create_translation_unit({
        model: { api_format: "SakuraLLM" },
        items: [
          {
            id: 1,
            src: "第一",
            dst: "",
            status: "NONE",
            text_type: "TXT",
            extra_field: create_fe_extra_field(2, false),
          },
          {
            id: 2,
            src: "第二",
            dst: "",
            status: "NONE",
            text_type: "TXT",
            extra_field: create_fe_extra_field(2, false),
          },
        ],
      }),
      new AbortController().signal,
    );

    expect(result.output).toMatchObject({
      kind: "translation",
      row_count: 1,
      items: [
        { id: 1, dst: "过长", status: "NONE" },
        { id: 2, dst: "短", status: "PROCESSED" },
      ],
    });
  });

  it("FE 物理换行硬规则不能被普通重试阈值放行", async () => {
    const runner = new TranslationWorkUnitRunner(
      await create_template_root(),
      create_llm_client({ response_result: '{"0":"新增\\n换行"}' }),
    );

    const result = await runner.execute_unit(
      create_translation_unit({
        model: { api_format: "SakuraLLM" },
        retry_count: 2,
        items: [
          {
            id: 1,
            src: "单行",
            dst: "",
            status: "NONE",
            text_type: "TXT",
            retry_count: 2,
            extra_field: create_fe_extra_field(100, false),
          },
        ],
      }),
      new AbortController().signal,
    );

    expect(result.output).toMatchObject({
      kind: "translation",
      row_count: 0,
      items: [{ id: 1, dst: "", status: "NONE", retry_count: 3 }],
    });
  });

  it("FE 提示词携带逻辑条目容量和上一版字节差，但不泄露索引路径", async () => {
    const captured_requests: LLMRequestBody[] = [];
    const llm_client: LLMClientPort = {
      request: vi.fn(async (body) => {
        captured_requests.push(body);
        return {
          response_think: "",
          response_result: '{"0":"短","1":"短"}',
          input_tokens: 1,
          output_tokens: 1,
          cancelled: false,
          timeout: false,
          degraded: false,
        };
      }),
    };
    const runner = new TranslationWorkUnitRunner(await create_template_root(), llm_client);

    await runner.execute_unit(
      create_translation_unit({
        model: { api_format: "SakuraLLM" },
        items: [
          {
            id: 1,
            src: "原文\n次行",
            dst: "上一版\n第二版",
            status: "NONE",
            text_type: "TXT",
            extra_field: create_fe_extra_field(2, false, "secret/index/path.dat"),
          },
        ],
      }),
      new AbortController().signal,
    );

    const prompt =
      captured_requests[0]?.messages.map((message) => message.content).join("\n") ?? "";
    expect(prompt).toContain('"request_indices":[0,1]');
    expect(prompt).toContain('"slot_capacity":2');
    expect(prompt).toContain('"previous_encoded_bytes":13');
    expect(prompt).toContain('"must_reduce_bytes":11');
    expect(prompt.match(/"slot_capacity":2/gu)).toHaveLength(1);
    expect(prompt).not.toContain("secret/index/path.dat");
    expect(prompt).not.toContain("char_offset");
  });
});

/**
 * 构造 runner 所需配置快照，字段名对齐任务启动载荷。
 */
function create_config_payload(): Record<string, ApiJsonValue> {
  return {
    app_language: "ZH",
    source_language: "JA",
    target_language: "ZH",
    clean_ruby: false,
    auto_process_prefix_suffix_preserved_text: true,
  };
}

/**
 * 构造关闭高级规则的质量快照，避免单测依赖真实项目质量设置。
 */
function create_quality_payload(): Record<string, ApiJsonValue> {
  return {
    quality: {
      glossary: { enabled: false, entries: [] },
      text_preserve: { mode: "OFF", entries: [] },
      pre_replacement: { enabled: false, entries: [] },
      post_replacement: { enabled: false, entries: [] },
    },
    prompts: {
      translation: { enabled: false, text: "" },
      analysis: { enabled: false, text: "" },
    },
  };
}

/**
 * 构造可覆盖响应字段的 LLM 边界 stub，测试只断言 runner 公开结果。
 */
function create_llm_client(overrides: Partial<LLMRequestResult>): LLMClientPort {
  return {
    request: async () => ({
      response_think: "",
      response_result: "",
      input_tokens: 1,
      output_tokens: 1,
      cancelled: false,
      timeout: false,
      degraded: false,
      ...overrides,
    }),
  };
}

/**
 * 构造单条或多条翻译 work unit，便于测试 retry_count 和 chunk 形状差异。
 */
function create_translation_unit(args: {
  model: Record<string, ApiJsonValue>;
  src?: string;
  retry_count?: number;
  items?: Array<Record<string, ApiJsonValue>>;
}): TranslationWorkUnit {
  return {
    kind: "translation",
    unit_id: "translation-unit-1",
    run_id: "run-1",
    model: args.model,
    config_snapshot: create_config_payload(),
    quality_snapshot: create_quality_payload(),
    payload: {
      items: args.items ?? [
        {
          id: 1,
          src: args.src ?? "こんにちは",
          dst: "",
          status: "NONE",
          text_type: "TXT",
          ...(args.retry_count === undefined ? {} : { retry_count: args.retry_count }),
        },
      ],
      precedings: [],
    },
    diagnostics: {
      token_threshold: 512,
      split_count: 0,
      retry_count: args.retry_count ?? 0,
      is_initial: true,
    },
  };
}

/**
 * 构造临时提示词资源根，覆盖 SakuraLLM 专用提示词路径。
 */
async function create_template_root(): Promise<string> {
  const app_root = await mkdtemp(path.join(tmpdir(), "linguagacha-translation-runner-"));
  const dir = path.join(app_root, "resource", "translation_prompt", "template", "zh");
  const rules_dir = path.join(app_root, "resource", "fate-extra", "rules");
  const fontpack_dir = path.join(app_root, "resource", "fate-extra", "fontpack", "NPJH50247");
  await mkdir(dir, { recursive: true });
  await mkdir(rules_dir, { recursive: true });
  await mkdir(fontpack_dir, { recursive: true });
  await writeFile(path.join(dir, "prefix.txt"), "前缀", "utf-8");
  await writeFile(path.join(dir, "base.txt"), "从 {source_language} 到 {target_language}", "utf-8");
  await writeFile(path.join(dir, "thinking.txt"), "", "utf-8");
  await writeFile(
    path.join(dir, "suffix.txt"),
    "输出 JSONLINE\n{translation_output_format}",
    "utf-8",
  );
  await writeFile(path.join(rules_dir, "translation-prompt.md"), "FE 翻译规则", "utf-8");
  await writeFile(path.join(fontpack_dir, "jp-font-map.json"), '{"records":[]}\n', "utf-8");
  await writeFile(path.join(fontpack_dir, "chinese-glyph-codec.json"), '{"records":[]}\n', "utf-8");
  return app_root;
}

function create_fe_extra_field(
  slot_capacity: number | null,
  allow_overlength: boolean,
  indexed_path = "field/test.dat",
): Record<string, ApiJsonValue> {
  return {
    __linguagacha_fe_v1: {
      schema_version: 1,
      path: indexed_path,
      char_offset: 42,
      classification: {
        category: "ordinary_independent_slot",
        category_zh: "普通独立槽位",
        slot_capacity,
        allow_overlength,
        allow_relocation: false,
        address_limit: null,
      },
    },
  };
}
