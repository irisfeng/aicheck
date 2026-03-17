from __future__ import annotations

import argparse
import json
import re
import zipfile
from collections import Counter
from pathlib import Path

from lxml import etree

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def cell_text(cell: etree._Element) -> str:
    return "".join(cell.xpath(".//w:t/text()", namespaces=NS)).strip()


def cell_has_yellow_highlight(cell: etree._Element) -> bool:
    return bool(
        cell.xpath('.//w:rPr/w:highlight[@w:val="yellow"]', namespaces=NS)
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract checklist items from a DOCX review table."
    )
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument(
        "--input", help="Path to the source DOCX file."
    )
    source_group.add_argument(
        "--input-env",
        help="Environment variable name that stores the source DOCX path.",
    )
    parser.add_argument(
        "--output", required=True, help="Path to the output JSON file."
    )
    return parser.parse_args()


def extract_table_items(docx_path: Path) -> dict:
    with zipfile.ZipFile(docx_path) as archive:
        root = etree.fromstring(archive.read("word/document.xml"))

    tables = root.xpath("//w:tbl", namespaces=NS)
    if not tables:
        raise ValueError("No table found in document.")

    rows = tables[0].xpath("./w:tr", namespaces=NS)
    if len(rows) < 2:
        raise ValueError("Checklist table does not contain enough rows.")

    current_category = ""
    items = []

    for row_index, row in enumerate(rows[1:], start=2):
        cells = row.xpath("./w:tc", namespaces=NS)
        if len(cells) < 3:
            continue

        category = cell_text(cells[0]) or current_category
        current_category = category

        requirement_raw = cell_text(cells[1])
        status = cell_text(cells[2])
        mandatory = cell_has_yellow_highlight(cells[1])

        match = re.match(r"(?P<code>\d+(?:\.\d+)+)(?P<body>.*)", requirement_raw)
        code = match.group("code") if match else ""
        requirement = (match.group("body") if match else requirement_raw).strip()

        items.append(
            {
                "row_index": row_index,
                "category": category,
                "code": code,
                "requirement": requirement,
                "mandatory": mandatory,
                "example_status": status,
            }
        )

    return {
        "source_file": str(docx_path),
        "table_index": 1,
        "summary": {
            "total_items": len(items),
            "mandatory_items": sum(1 for item in items if item["mandatory"]),
            "optional_items": sum(1 for item in items if not item["mandatory"]),
            "categories": dict(Counter(item["category"] for item in items)),
            "example_statuses": dict(Counter(item["example_status"] for item in items)),
        },
        "items": items,
    }


def main() -> None:
    args = parse_args()
    source_value = args.input
    if args.input_env:
        source_value = __import__("os").environ.get(args.input_env)
        if not source_value:
            raise ValueError(
                f"Environment variable {args.input_env} is missing or empty."
            )

    docx_path = Path(source_value).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    if not docx_path.exists():
        raise FileNotFoundError(f"Input DOCX not found: {docx_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = extract_table_items(docx_path)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        f"Extracted {payload['summary']['total_items']} checklist items to {output_path}"
    )


if __name__ == "__main__":
    main()
