"""Convert the FAKE test-data workbook into backend/seed/seed-data.json.

Usage:
    pip install openpyxl
    python tools/xlsx_to_seed_data.py docs/RFID_Test_Data.xlsx
    node tools/build_apps_script.mjs      # turns the JSON into SeedData.gs

Every value is exported as text, matching how the Google Sheet stores it.
The result is loaded into EMPTY tabs by setupSheets() — use a TEST Sheet only.
Never put real people's data or real/default passwords in the workbook.
"""
import json
import sys
from pathlib import Path

from openpyxl import load_workbook

OUTPUT = Path(__file__).resolve().parent.parent / "backend" / "seed" / "seed-data.json"
SKIPPED_SHEETS = {"README"}


def sheet_to_records(worksheet):
    rows = list(worksheet.iter_rows(values_only=True))
    if not rows:
        return []
    headers = [str(h).strip() for h in rows[0] if h is not None]
    records = []
    for row in rows[1:]:
        values = ["" if v is None else str(v) for v in row[: len(headers)]]
        if not any(values):
            continue
        records.append(dict(zip(headers, values)))
    return records


def main():
    if len(sys.argv) != 2:
        sys.exit("Usage: python tools/xlsx_to_seed_data.py path/to/RFID_Test_Data.xlsx")
    workbook = load_workbook(sys.argv[1], read_only=True)
    data = {ws.title: sheet_to_records(ws) for ws in workbook.worksheets if ws.title not in SKIPPED_SHEETS}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    counts = ", ".join(f"{name}: {len(rows)}" for name, rows in data.items())
    print(f"Wrote {OUTPUT}\n{counts}\nNow run: node tools/build_apps_script.mjs")


if __name__ == "__main__":
    main()
