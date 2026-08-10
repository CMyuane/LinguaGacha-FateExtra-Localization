from __future__ import annotations

import argparse
import collections
import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path


INDEX_PATTERN = re.compile(r"^(?P<path>.+?) \| char:(?P<char>\d+) \| (?P<source>.*)$")
KNOWN_CORRUPT_MARKERS = ("渉后", "蓮囮", "痙搬", "囮僉")
INVALID_CONTROL_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
HALFWIDTH_KATAKANA_PATTERN = re.compile(r"[\uff61-\uff9f]")
JAPANESE_PATTERN = re.compile(r"[\u3040-\u30ff]")


@dataclass(frozen=True)
class IndexedText:
    path: str
    char_offset: int
    source: str
    representative_id: int


def normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def definite_corruption(text: str) -> bool:
    if "\ufffd" in text or INVALID_CONTROL_PATTERN.search(text):
        return True
    if any(marker in text for marker in KNOWN_CORRUPT_MARKERS):
        return True
    halfwidth_count = len(HALFWIDTH_KATAKANA_PATTERN.findall(text))
    return halfwidth_count >= 2 and JAPANESE_PATTERN.search(text) is None


def parse_indexed_file(file_path: Path) -> list[IndexedText]:
    text = file_path.read_text(encoding="utf-8-sig")
    result: list[IndexedText] = []
    current_path: str | None = None
    current_char = -1
    current_lines: list[str] = []

    def flush() -> None:
        nonlocal current_path, current_char, current_lines
        if current_path is None:
            return
        while len(current_lines) > 1 and current_lines[-1] == "":
            current_lines.pop()
        result.append(
            IndexedText(
                path=current_path,
                char_offset=current_char,
                source="\n".join(current_lines),
                representative_id=len(result),
            )
        )
        current_path = None
        current_char = -1
        current_lines = []

    # splitlines() drops the file's terminal EOL but preserves deliberate blank
    # lines inside an entry, so the last source does not acquire a false newline.
    for line in normalize_newlines(text).splitlines():
        match = INDEX_PATTERN.match(line)
        if match is not None:
            flush()
            current_path = match.group("path")
            current_char = int(match.group("char"))
            current_lines = [match.group("source")]
            continue
        if line.startswith("====="):
            flush()
            continue
        if current_path is not None:
            current_lines.append(line)
    flush()
    return result


def read_metadata(data: dict[str, object]) -> tuple[str, int]:
    extra = data.get("extra_field")
    if not isinstance(extra, dict):
        return "", -1
    metadata = extra.get("__linguagacha_fe_v1")
    if not isinstance(metadata, dict):
        return "", -1
    path = str(metadata.get("path") or "")
    try:
        char_offset = int(metadata.get("char_offset", -1))
    except (TypeError, ValueError):
        char_offset = -1
    return path, char_offset


def main() -> None:
    parser = argparse.ArgumentParser(description="Export effective FE sources missing from six routes")
    parser.add_argument("project", type=Path)
    parser.add_argument("route_directory", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    route_files = sorted(args.route_directory.glob("*.txt"))
    if len(route_files) != 6:
        raise RuntimeError(f"Expected six route files, found {len(route_files)}")

    route_sources: set[str] = set()
    route_entry_count = 0
    for route_file in route_files:
        entries = parse_indexed_file(route_file)
        route_entry_count += len(entries)
        route_sources.update(normalize_newlines(entry.source) for entry in entries)

    connection = sqlite3.connect(f"file:{args.project}?mode=ro", uri=True)
    grouped_rows = connection.execute(
        """
        SELECT
          COALESCE(json_extract(data, '$.src'), '') AS source,
          MIN(id) AS representative_id
        FROM items
        GROUP BY COALESCE(json_extract(data, '$.src'), '')
        ORDER BY representative_id
        """
    ).fetchall()

    missing: list[IndexedText] = []
    effective_sources: set[str] = set()
    corrupt_count = 0
    missing_metadata_count = 0
    for source_value, representative_id in grouped_rows:
        source = normalize_newlines(str(source_value or ""))
        if source == "" or definite_corruption(source):
            corrupt_count += 1
            continue
        effective_sources.add(source)
        if source in route_sources:
            continue
        row = connection.execute(
            "SELECT data FROM items WHERE id = ?",
            (int(representative_id),),
        ).fetchone()
        data = json.loads(str(row[0])) if row is not None else {}
        path, char_offset = read_metadata(data)
        if path == "" or char_offset < 0:
            missing_metadata_count += 1
            continue
        missing.append(
            IndexedText(
                path=path,
                char_offset=char_offset,
                source=source,
                representative_id=int(representative_id),
            )
        )
    connection.close()

    groups: collections.OrderedDict[str, list[IndexedText]] = collections.OrderedDict()
    for entry in missing:
        groups.setdefault(entry.path, []).append(entry)

    blocks: list[str] = []
    for path, entries in groups.items():
        blocks.append(f"===== {path} ({len(entries)} strings) =====")
        for entry in entries:
            source_lines = entry.source.split("\n")
            blocks.append(f"{entry.path} | char:{entry.char_offset} | {source_lines[0]}")
            blocks.extend(source_lines[1:])
        blocks.append("")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(blocks), encoding="utf-8", newline="\n")

    report = {
        "project_unique_sources": len(grouped_rows),
        "effective_unique_sources": len(effective_sources),
        "excluded_corrupt_or_empty_sources": corrupt_count,
        "route_files": [file.name for file in route_files],
        "route_physical_entries": route_entry_count,
        "route_unique_sources": len(route_sources),
        "effective_sources_present_in_routes": len(effective_sources & route_sources),
        "effective_sources_missing_from_routes": len(missing),
        "missing_sources_without_index_metadata": missing_metadata_count,
        "route_sources_not_in_effective_master": len(route_sources - effective_sources),
        "output": str(args.output),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
