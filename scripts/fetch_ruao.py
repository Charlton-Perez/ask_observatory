#!/usr/bin/env python3
"""
Fetch daily data from the Reading University Atmospheric Observatory
CGI interface and keep the CSV up to date.

Default behaviour (no arguments): fetch the last 10 days.
For each day returned by the CGI:
  - If the date is missing from the CSV: add it.
  - If the date is present but has x (missing) values: update those fields.
  - If the date is complete: leave it untouched.

Usage:
  python fetch_ruao.py                        # fetch/update last 10 days
  python fetch_ruao.py 2026-06-01             # fetch a specific date
  python fetch_ruao.py 2026-05-01 2026-06-01  # fetch a date range
"""

import sys
import re
import csv
import io
import requests
from datetime import date, datetime, timedelta
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

CGI_URL = "https://metdata.reading.ac.uk/cgi-bin/climate_extract.cgi"
BACKFILL_DAYS = 10   # how many recent days to re-check for filled-in x values

# Variables to fetch — must match the column names in ruao_data.csv
VARIABLES = {
    "Pmsl": "y",   # MSL pressure (mb)
    "Tdry": "y",   # Dry bulb temp (degC)
    "Twet": "y",   # Wet bulb temp (degC)
    "RH":   "y",   # Relative humidity (%)
    "Tx":   "y",   # Maximum temperature (degC)
    "Tn":   "y",   # Minimum temperature (degC)
    "RR":   "y",   # Rainfall 24h from 09GMT (mm)
    "rd":   "y",   # Rain day (1=yes)
    "af":   "y",   # Air frost
    "gf":   "y",   # Ground frost
    "sd_cm":"y",   # Total snow depth (cm)
    "sss":  "y",   # Sunshine duration (h)
    "ff_ms":"y",   # Wind speed (m/s)
    "dd":   "y",   # Wind direction (deg/10)
    "ww":   "y",   # Present weather code (WMO)
}

# Fields that can meaningfully be backfilled (skip metadata columns)
BACKFILL_FIELDS = list(VARIABLES.keys())

SCRIPT_DIR = Path(__file__).parent
CSV_PATH = SCRIPT_DIR.parent / "public" / "ruao_data.csv"

# ── Fetch ─────────────────────────────────────────────────────────────────────

def fetch_data(start: date, end: date) -> str:
    """POST to the CGI and return reassembled CSV text."""
    MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun",
                  "Jul","Aug","Sep","Oct","Nov","Dec"]
    payload = {
        "daybeg":   f"{start.day:02d}",
        "monthbeg": MONTH_ABBR[start.month - 1],
        "yearbeg":  str(start.year),
        "dayend":   f"{end.day:02d}",
        "monthend": MONTH_ABBR[end.month - 1],
        "yearend":  str(end.year),
        "nexttask": "retrieve",
        **VARIABLES,
    }
    resp = requests.post(CGI_URL, data=payload, timeout=30)
    resp.raise_for_status()

    match = re.search(
        r"=+A copy of your extracted data follows=+<br>\s*(.*?)\s*={4,}",
        resp.text, re.DOTALL
    )
    if not match:
        raise ValueError("Could not find data in response. The CGI may have changed.")

    raw = re.sub(r"<[^>]+>", "", match.group(1)).strip()

    # CGI splits each row across multiple lines; continuation lines start with ','
    joined_lines = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith(",") and joined_lines:
            joined_lines[-1] += line
        else:
            joined_lines.append(line)

    return "\n".join(joined_lines)

# ── Parse ─────────────────────────────────────────────────────────────────────

def parse_csv_text(text: str) -> list[dict]:
    """Parse the reassembled CGI CSV text into a list of row dicts."""
    reader = csv.DictReader(io.StringIO(text))
    return [{k: (v.strip() if v is not None else "x") for k, v in row.items()}
            for row in reader]

def row_date_key(row: dict) -> str | None:
    """Return 'YYYY-MM-DD' for a row dict, or None if unparseable."""
    try:
        y  = row.get("year",   "").strip()
        mo = row.get(" month", row.get("month", "")).strip()
        da = row.get(" day",   row.get("day",   "")).strip()
        return f"{y}-{int(mo):02d}-{int(da):02d}"
    except (ValueError, AttributeError):
        return None

# ── Read / write full CSV ─────────────────────────────────────────────────────

def read_csv(csv_path: Path) -> tuple[list[str], list[dict]]:
    """Return (header_list, rows_as_dicts) for the full file."""
    with open(csv_path, newline="") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames or []
        rows = [dict(row) for row in reader]
    return header, rows

def write_csv(csv_path: Path, header: list[str], rows: list[dict]) -> None:
    """Overwrite the file with header + rows."""
    with open(csv_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=header, extrasaction="raise")
        writer.writeheader()
        writer.writerows(rows)

# ── Merge fresh CGI data into CSV ─────────────────────────────────────────────

def merge_into_csv(fresh_rows: list[dict]) -> tuple[int, int]:
    """
    For each row returned by the CGI:
      - If the date is missing from the CSV: append it.
      - If the date exists but has x values: overwrite those fields with real values.
      - If the date is complete: leave it.
    Also extends the CSV header if the CGI returns new columns not yet in the file.
    Returns (rows_added, fields_updated).
    """
    if not fresh_rows:
        return 0, 0

    header, all_rows = read_csv(CSV_PATH)

    # Extend header with any new fields present in fresh data but not yet in the file.
    # Fill existing rows with 'x' for those columns.
    new_cols = [k for k in fresh_rows[0].keys() if k not in header]
    if new_cols:
        print(f"  Adding new column(s) to CSV: {new_cols}")
        header = header + new_cols
        for row in all_rows:
            for col in new_cols:
                row.setdefault(col, 'x')

    by_date = {row_date_key(r): r for r in all_rows}

    rows_added     = 0
    fields_updated = 0
    file_changed   = False

    for fresh in fresh_rows:
        key = row_date_key(fresh)
        if not key:
            continue

        if key not in by_date:
            # Date missing entirely — append
            all_rows.append(fresh)
            by_date[key] = fresh
            print(f"  Added   {key}")
            rows_added += 1
            file_changed = True
        else:
            # Date exists — fill any x values
            existing = by_date[key]
            updated_fields = []
            for field in BACKFILL_FIELDS:
                existing_val = existing.get(field, "x").strip()
                fresh_val    = fresh.get(field, "x").strip()
                if existing_val == "x" and fresh_val != "x":
                    existing[field] = fresh_val
                    fields_updated += 1
                    updated_fields.append(field)
                    file_changed = True
            if updated_fields:
                print(f"  Updated {key}: filled in {updated_fields}")

    if file_changed:
        # Sort by date before writing to keep the file in order
        all_rows.sort(key=lambda r: row_date_key(r) or "")
        write_csv(CSV_PATH, header, all_rows)

    return rows_added, fields_updated

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    today = date.today()

    if len(args) == 0:
        # Default: fetch the last BACKFILL_DAYS days — adds any missing dates
        # and fills in x values that observers have since updated.
        end   = today - timedelta(days=1)
        start = end - timedelta(days=BACKFILL_DAYS - 1)
    elif len(args) == 1:
        start = end = datetime.strptime(args[0], "%Y-%m-%d").date()
    elif len(args) == 2:
        start = datetime.strptime(args[0], "%Y-%m-%d").date()
        end   = datetime.strptime(args[1], "%Y-%m-%d").date()
    else:
        print("Usage: fetch_ruao.py [start-date [end-date]]  (dates as YYYY-MM-DD)")
        sys.exit(1)

    print(f"Fetching {start} to {end} from {CGI_URL}")
    raw  = fetch_data(start, end)
    rows = parse_csv_text(raw)
    print(f"  Got {len(rows)} row(s) from CGI")

    added, updated = merge_into_csv(rows)
    print(f"\nDone — {added} row(s) added, {updated} field(s) updated.")

if __name__ == "__main__":
    main()
