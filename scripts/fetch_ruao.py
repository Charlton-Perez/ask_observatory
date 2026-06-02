#!/usr/bin/env python3
"""
Fetch daily data from the Reading University Atmospheric Observatory
CGI interface and append new rows to the CSV data file.

Usage:
  python fetch_ruao.py                   # fetch yesterday
  python fetch_ruao.py 2026-06-01        # fetch a specific date
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

# Variables to fetch — must match the column names in ruao_data.csv
VARIABLES = {
    "Pmsl": "y",   # MSL pressure (mb)
    "Tdry": "y",   # Dry bulb temp (degC)
    "Twet": "y",   # Wet bulb temp (degC)
    "RH":   "y",   # Relative humidity (%)
    "Tx":   "y",   # Maximum temperature (degC)
    "Tn":   "y",   # Minimum temperature (degC)
    "RR":   "y",   # Rainfall 24h from 09GMT (mm)
    "af":   "y",   # Air frost
    "gf":   "y",   # Ground frost
    "sd_cm":"y",   # Total snow depth (cm)
    "sss":  "y",   # Sunshine duration (h)
}

# Path to the CSV file (relative to this script's location)
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

    # Extract the inline data block
    match = re.search(
        r"=+A copy of your extracted data follows=+<br>\s*(.*?)\s*={4,}",
        resp.text, re.DOTALL
    )
    if not match:
        raise ValueError("Could not find data in response. The CGI may have changed.")

    # Strip HTML tags
    raw = re.sub(r"<[^>]+>", "", match.group(1)).strip()

    # The CGI splits each CSV row across multiple lines:
    # continuation lines start with a comma. Rejoin them.
    joined_lines = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith(",") and joined_lines:
            joined_lines[-1] += line   # append to previous row
        else:
            joined_lines.append(line)

    return "\n".join(joined_lines)

# ── Parse ─────────────────────────────────────────────────────────────────────

def parse_csv_text(text: str) -> list[dict]:
    """Parse the reassembled CSV text into a list of row dicts."""
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for row in reader:
        rows.append({k.strip(): (v.strip() if v is not None else "x")
                     for k, v in row.items()})
    return rows

# ── Append ────────────────────────────────────────────────────────────────────

def load_existing_dates(csv_path: Path) -> set[str]:
    """Return set of 'YYYY-MM-DD' date strings already in the CSV."""
    dates = set()
    if not csv_path.exists():
        return dates
    with open(csv_path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                y = row.get("year", "").strip()
                m = row.get(" month", row.get("month", "")).strip()
                d = row.get(" day", row.get("day", "")).strip()
                dates.add(f"{y}-{int(m):02d}-{int(d):02d}")
            except (ValueError, AttributeError):
                pass
    return dates

def append_rows(csv_path: Path, new_rows: list[dict], existing_dates: set[str]) -> int:
    """Append rows not already present. Returns count of rows added."""
    if not new_rows:
        return 0

    # Read existing header to know column order
    with open(csv_path, newline="") as f:
        header = next(csv.reader(f))

    added = 0
    with open(csv_path, "a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=header, extrasaction="ignore")
        for row in new_rows:
            y  = row.get("year", "").strip()
            mo = row.get(" month", row.get("month", "")).strip()
            da = row.get(" day", row.get("day", "")).strip()
            try:
                key = f"{y}-{int(mo):02d}-{int(da):02d}"
            except ValueError:
                continue
            if key in existing_dates:
                print(f"  Skipping {key} — already in file")
                continue
            writer.writerow(row)
            print(f"  Added {key}")
            added += 1
    return added

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    today = date.today()

    if len(args) == 0:
        start = end = today - timedelta(days=1)
    elif len(args) == 1:
        start = end = datetime.strptime(args[0], "%Y-%m-%d").date()
    elif len(args) == 2:
        start = datetime.strptime(args[0], "%Y-%m-%d").date()
        end   = datetime.strptime(args[1], "%Y-%m-%d").date()
    else:
        print("Usage: fetch_ruao.py [start-date [end-date]]  (dates as YYYY-MM-DD)")
        sys.exit(1)

    print(f"Fetching {start} to {end} from {CGI_URL}")
    raw = fetch_data(start, end)
    rows = parse_csv_text(raw)
    print(f"  Got {len(rows)} row(s) from CGI")

    existing = load_existing_dates(CSV_PATH)
    added = append_rows(CSV_PATH, rows, existing)
    print(f"Done — {added} new row(s) appended to {CSV_PATH}")

if __name__ == "__main__":
    main()
