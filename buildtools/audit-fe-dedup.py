from __future__ import annotations

import argparse
import collections
import json
import re
import sqlite3
from pathlib import Path


KNOWN_CORRUPT_MARKERS = ("渉后", "蓮囮", "痙搬", "囮僉")
INVALID_CONTROL_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
HALFWIDTH_KATAKANA_PATTERN = re.compile(r"[\uff61-\uff9f]")
JAPANESE_PATTERN = re.compile(r"[\u3040-\u30ff]")


def read_text(data: str, key: str) -> str:
    value = json.loads(data).get(key, "")
    return value if isinstance(value, str) else str(value or "")


def definite_corruption_reason(text: str) -> str | None:
    if "\ufffd" in text:
        return "replacement_character"
    if INVALID_CONTROL_PATTERN.search(text):
        return "invalid_control_character"
    marker = next((value for value in KNOWN_CORRUPT_MARKERS if value in text), None)
    if marker is not None:
        return f"known_marker:{marker}"
    # FE Japanese strings normally use full-width kana. Dense half-width kana mixed
    # with CJK is a stable signature of bytes decoded through the wrong code page.
    halfwidth_count = len(HALFWIDTH_KATAKANA_PATTERN.findall(text))
    if halfwidth_count >= 2 and not JAPANESE_PATTERN.search(text):
        return "halfwidth_mojibake"
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit Fate/Extra duplicate and corrupt sources")
    parser.add_argument("project", type=Path)
    parser.add_argument("--samples", type=int, default=20)
    args = parser.parse_args()

    connection = sqlite3.connect(f"file:{args.project}?mode=ro", uri=True)
    physical_count = int(connection.execute("SELECT COUNT(*) FROM items").fetchone()[0])
    rows = connection.execute(
        """
        SELECT
          COALESCE(json_extract(data, '$.src'), '') AS source,
          COUNT(*) AS occurrence_count,
          MIN(id) AS representative_id,
          MIN(COALESCE(json_extract(data, '$.file_path'), '')) AS file_path,
          MIN(COALESCE(json_extract(data, '$.extra_field.__linguagacha_fe_v1.path'), '')) AS resource_path,
          MIN(COALESCE(json_extract(data, '$.extra_field.__linguagacha_fe_v1.char_offset'), -1)) AS char_offset,
          COUNT(DISTINCT COALESCE(json_extract(data, '$.file_path'), '')) AS file_path_count,
          COUNT(DISTINCT COALESCE(json_extract(data, '$.extra_field.__linguagacha_fe_v1.classification.category'), '')) AS category_count,
          COUNT(DISTINCT CASE WHEN COALESCE(json_extract(data, '$.dst'), '') <> '' THEN json_extract(data, '$.dst') END) AS machine_translation_count,
          COUNT(DISTINCT CASE WHEN COALESCE(json_extract(data, '$.extra_field.__linguagacha_fe_v1.proofread_translation'), '') <> '' THEN json_extract(data, '$.extra_field.__linguagacha_fe_v1.proofread_translation') END) AS proofread_translation_count
        FROM items
        GROUP BY COALESCE(json_extract(data, '$.src'), '')
        ORDER BY representative_id
        """
    )

    unique_count = 0
    empty_unique_count = 0
    corrupt_unique_count = 0
    corrupt_physical_count = 0
    reason_counts: collections.Counter[str] = collections.Counter()
    samples: list[dict[str, object]] = []
    duplicate_unique_count = 0
    cross_file_unique_count = 0
    category_conflict_unique_count = 0
    machine_translation_conflict_unique_count = 0
    proofread_translation_conflict_unique_count = 0
    maximum_occurrences = 0
    for (
        source,
        occurrence_count,
        representative_id,
        file_path,
        resource_path,
        char_offset,
        file_path_count,
        category_count,
        machine_translation_count,
        proofread_translation_count,
    ) in rows:
        unique_count += 1
        occurrence_count = int(occurrence_count)
        maximum_occurrences = max(maximum_occurrences, occurrence_count)
        duplicate_unique_count += occurrence_count > 1
        cross_file_unique_count += int(file_path_count) > 1
        category_conflict_unique_count += int(category_count) > 1
        machine_translation_conflict_unique_count += int(machine_translation_count) > 1
        proofread_translation_conflict_unique_count += int(proofread_translation_count) > 1
        text = str(source or "")
        if text == "":
            empty_unique_count += 1
        reason = definite_corruption_reason(text)
        if reason is None:
            continue
        corrupt_unique_count += 1
        corrupt_physical_count += occurrence_count
        reason_counts[reason] += 1
        if len(samples) < max(0, args.samples):
            samples.append(
                {
                    "representative_id": int(representative_id),
                    "occurrences": int(occurrence_count),
                    "file_path": str(file_path),
                    "resource_path": str(resource_path),
                    "char_offset": int(char_offset),
                    "reason": reason,
                    "source": text,
                }
            )

    result = {
        "project": str(args.project),
        "physical_items": physical_count,
        "unique_sources": unique_count,
        "duplicate_physical_items": physical_count - unique_count,
        "unique_sources_with_duplicates": duplicate_unique_count,
        "maximum_occurrences_for_one_source": maximum_occurrences,
        "unique_sources_spanning_multiple_input_files": cross_file_unique_count,
        "unique_sources_with_safety_category_conflicts": category_conflict_unique_count,
        "unique_sources_with_multiple_machine_translations": machine_translation_conflict_unique_count,
        "unique_sources_with_multiple_proofread_translations": proofread_translation_conflict_unique_count,
        "empty_unique_sources": empty_unique_count,
        "definite_corrupt_unique_sources": corrupt_unique_count,
        "definite_corrupt_physical_items": corrupt_physical_count,
        "effective_unique_sources_excluding_definite_corruption": unique_count
        - corrupt_unique_count
        - empty_unique_count,
        "reduction_percent": round((1 - unique_count / physical_count) * 100, 4),
        "corruption_reasons": dict(reason_counts),
        "samples": samples,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    connection.close()


if __name__ == "__main__":
    main()
