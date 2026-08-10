from __future__ import annotations

import argparse
import json
import sqlite3
import time
from pathlib import Path


def count(connection: sqlite3.Connection, table: str) -> int:
    return int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark the derived Fate/Extra preview index")
    parser.add_argument("project", type=Path)
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()

    started = time.perf_counter()
    connection = sqlite3.connect(args.project)
    connection.execute("PRAGMA busy_timeout = 30000")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS fate_extra_text_unit (
          unit_id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL UNIQUE,
          representative_item_id INTEGER NOT NULL,
          occurrence_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fate_extra_text_occurrence (
          item_id INTEGER PRIMARY KEY,
          unit_id INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fate_extra_file_summary (
          file_path TEXT PRIMARY KEY,
          occurrence_count INTEGER NOT NULL,
          first_item_id INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fate_extra_text_occurrence_unit_id
          ON fate_extra_text_occurrence(unit_id);
        CREATE INDEX IF NOT EXISTS idx_fate_extra_file_summary_first_item_id
          ON fate_extra_file_summary(first_item_id);
        """
    )
    opened = time.perf_counter()

    if args.rebuild:
        connection.executescript(
            """
            BEGIN IMMEDIATE;
            DELETE FROM fate_extra_text_occurrence;
            DELETE FROM fate_extra_text_unit;
            DELETE FROM fate_extra_file_summary;
            DELETE FROM sqlite_sequence WHERE name = 'fate_extra_text_unit';
            INSERT INTO fate_extra_text_unit (source, representative_item_id, occurrence_count)
            SELECT COALESCE(json_extract(data, '$.src'), ''), MIN(id), COUNT(*)
            FROM items
            GROUP BY COALESCE(json_extract(data, '$.src'), '');
            INSERT INTO fate_extra_text_occurrence (item_id, unit_id)
            SELECT item.id, unit.unit_id
            FROM items AS item
            JOIN fate_extra_text_unit AS unit
              ON unit.source = COALESCE(json_extract(item.data, '$.src'), '');
            INSERT INTO fate_extra_file_summary (file_path, occurrence_count, first_item_id)
            SELECT COALESCE(json_extract(data, '$.file_path'), ''), COUNT(*), MIN(id)
            FROM items
            GROUP BY COALESCE(json_extract(data, '$.file_path'), '');
            COMMIT;
            """
        )
    rebuilt = time.perf_counter()

    first_page = connection.execute(
        """
        SELECT unit.unit_id, unit.occurrence_count, item.id, item.data
        FROM fate_extra_text_unit AS unit
        JOIN items AS item ON item.id = unit.representative_item_id
        ORDER BY unit.unit_id
        LIMIT 120
        """
    ).fetchall()
    files = connection.execute(
        """
        SELECT file_path, occurrence_count
        FROM fate_extra_file_summary
        ORDER BY first_item_id
        LIMIT 200
        """
    ).fetchall()
    queried = time.perf_counter()
    result = {
        "project": str(args.project),
        "items": count(connection, "items"),
        "units": count(connection, "fate_extra_text_unit"),
        "occurrences": count(connection, "fate_extra_text_occurrence"),
        "files": count(connection, "fate_extra_file_summary"),
        "first_page_rows": len(first_page),
        "file_option_rows": len(files),
        "open_seconds": round(opened - started, 3),
        "rebuild_seconds": round(rebuilt - opened, 3),
        "first_page_seconds": round(queried - rebuilt, 3),
        "total_seconds": round(queried - started, 3),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    connection.close()


if __name__ == "__main__":
    main()
