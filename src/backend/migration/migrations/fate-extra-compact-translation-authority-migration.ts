import type { DatabaseSync } from "node:sqlite";

import { JsonTool } from "../../../shared/utils/json-tool";
import type { MigrationDescriptor, ProjectDatabaseMigrationContext } from "../migration-types";

/**
 * 旧精简工程没有记录代表项初翻是否已经被用户修改。schema 9 迁移只遍历代表组，
 * 通过代表 occurrence 主键恢复创建时基线，不触碰百万级物理映射。
 */
export const fate_extra_compact_translation_authority_migration: MigrationDescriptor = {
  id: "fate-extra-compact-translation-authority",
  order: 500,
  run_project_database_writeback(context: ProjectDatabaseMigrationContext): void {
    FateExtraCompactTranslationAuthorityMigration.run(context.db);
  },
};

export class FateExtraCompactTranslationAuthorityMigration {
  public static run(db: DatabaseSync): void {
    const raw_compact_meta = db
      .prepare("SELECT value FROM meta WHERE key = 'fate_extra.compact.v1'")
      .get()?.["value"];
    if (typeof raw_compact_meta !== "string") {
      return;
    }
    try {
      const compact_meta = JsonTool.parseStrict<unknown>(raw_compact_meta);
      if (
        typeof compact_meta !== "object" ||
        compact_meta === null ||
        Array.isArray(compact_meta) ||
        (compact_meta as Record<string, unknown>)["enabled"] !== true
      ) {
        return;
      }
    } catch {
      return;
    }
    db.exec(`
      UPDATE fate_extra_compact_source AS source
      SET representative_translation_authoritative = 1
      WHERE source.compact_item_id IS NOT NULL
        AND source.excluded_reason = ''
        AND EXISTS (
          SELECT 1
          FROM items AS item
          LEFT JOIN fate_extra_compact_occurrence AS representative
            ON representative.original_item_id = source.representative_original_item_id
          WHERE item.id = source.compact_item_id
            AND COALESCE(json_extract(item.data, '$.dst'), '') <> CASE
              WHEN COALESCE(representative.original_machine_translation, '') = ''
              THEN source.source
              ELSE representative.original_machine_translation
            END
        )
    `);
  }
}
