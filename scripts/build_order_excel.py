import json
import sys
from pathlib import Path

try:
    import openpyxl
except Exception as e:
    print(f"openpyxl missing: {e}", file=sys.stderr)
    sys.exit(2)

if len(sys.argv) < 3:
    print("usage: build_order_excel.py <input_json> <output_xlsx>", file=sys.stderr)
    sys.exit(1)

in_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])

payload = json.loads(in_path.read_text())
headers = payload.get("headers", [])
rows = payload.get("rows", [])

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Sheet1"

# header row
for col, name in enumerate(headers, start=1):
    ws.cell(row=1, column=col, value=name)

# data rows
for r_idx, row in enumerate(rows, start=2):
    for c_idx, value in enumerate(row, start=1):
        ws.cell(row=r_idx, column=c_idx, value=value)

out_path.parent.mkdir(parents=True, exist_ok=True)
wb.save(out_path)
