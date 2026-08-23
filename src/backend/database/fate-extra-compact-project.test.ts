import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectDatabase } from "./database-operations";

const test_root = path.resolve("build", "test-temp", "fate-extra-compact-project");
const cleanup_paths: string[] = [];

afterEach(() => {
  for (const cleanup_path of cleanup_paths.splice(0)) {
    fs.rmSync(cleanup_path, { recursive: true, force: true });
  }
});

describe("Fate/Extra compact project", () => {
  it("keeps one editable item per exact source and preserves every occurrence", () => {
    fs.mkdirSync(test_root, { recursive: true });
    cleanup_paths.push(test_root);
    const source_path = path.join(test_root, "source.lg");
    const target_path = path.join(test_root, "compact.lg");
    const database = new ProjectDatabase();
    database.execute({ name: "createProject", args: { projectPath: source_path, name: "source" } });
    database.execute({
      name: "setMeta",
      args: {
        projectPath: source_path,
        key: "fate_extra.adapter.v1",
        value: { schema_version: 1, enabled: true, logical_text_count: 3 },
      },
    });
    const metadata = (resource_path: string, char_offset: number) => ({
      __linguagacha_fe_v1: {
        schema_version: 1,
        path: resource_path,
        char_offset,
        original_prefix: `${resource_path} | char:${char_offset}`,
        source_line_numbers: [1],
        pass_through: [],
        proofread_translation: "",
        display_mode: "auto",
        classification: {
          category: "ordinary_independent_slot",
          slot_capacity: 64,
          allow_overlength: false,
        },
      },
    });
    database.execute({
      name: "setItems",
      args: {
        projectPath: source_path,
        items: [
          {
            id: 1,
            src: "同文",
            dst: "",
            file_path: "a.txt",
            row: 0,
            status: "NONE",
            extra_field: metadata("a.dat", 10),
          },
          {
            id: 2,
            src: "同文",
            dst: "译文",
            file_path: "b.txt",
            row: 1,
            status: "PROCESSED",
            extra_field: metadata("b.dat", 20),
          },
          {
            id: 3,
            src: "独立",
            dst: "",
            file_path: "b.txt",
            row: 2,
            status: "NONE",
            extra_field: metadata("b.dat", 30),
          },
        ],
      },
    });

    const result = database.execute({
      name: "createFateExtraCompactProject",
      args: {
        projectPath: source_path,
        targetProjectPath: target_path,
        name: "compact",
      },
    }) as Record<string, unknown>;
    expect(result).toMatchObject({
      physical_item_count: 3,
      unique_source_count: 2,
      compact_item_count: 2,
    });
    expect(database.execute({ name: "getItemCount", args: { projectPath: source_path } })).toBe(3);
    expect(database.execute({ name: "getItemCount", args: { projectPath: target_path } })).toBe(2);
    const compact_items = database.execute({
      name: "getAllItems",
      args: { projectPath: target_path },
    }) as Array<Record<string, unknown>>;
    expect(compact_items.find((item) => item["src"] === "同文")).toMatchObject({
      id: 2,
      dst: "译文",
      status: "PROCESSED",
    });
    expect(compact_items.find((item) => item["id"] === 3)).toMatchObject({
      dst: "独立",
      status: "NONE",
    });
    const page = database.execute({
      name: "getFateExtraCompactExportPage",
      args: { projectPath: target_path, afterOriginalItemId: 0, limit: 2 },
    }) as { next_original_item_id: number; rows: unknown[] };
    expect(page.next_original_item_id).toBe(2);
    expect(page.rows).toHaveLength(2);
    const last_page = database.execute({
      name: "getFateExtraCompactExportPage",
      args: {
        projectPath: target_path,
        afterOriginalItemId: page.next_original_item_id,
        limit: 2,
      },
    }) as { next_original_item_id: number; rows: unknown[] };
    expect(last_page.next_original_item_id).toBe(3);
    expect(last_page.rows).toHaveLength(1);
    expect([...page.rows, ...last_page.rows]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          original_item_id: 1,
          original_machine_translation: "",
          original_status: "NONE",
          source_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({
          original_item_id: 2,
          original_machine_translation: "译文",
          original_status: "PROCESSED",
        }),
      ]),
    );
    const context = database.execute({
      name: "getFateExtraContext",
      args: {
        projectPath: target_path,
        resourcePath: "b.dat",
        charOffset: 30,
        radius: 2,
      },
    }) as Record<string, unknown>;
    expect(context).toMatchObject({ found: true, target_ordinal: 1, block_count: 2 });
    expect(context["items"]).toEqual([
      expect.objectContaining({ char_offset: 20, block_ordinal: 0 }),
      expect.objectContaining({ char_offset: 30, block_ordinal: 1 }),
    ]);
    database.close();
  });
});
