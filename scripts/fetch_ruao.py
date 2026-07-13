#!/usr/bin/env python3
"""
Fetch daily data from the Reading University Atmospheric Observatory
CGI interface and keep the CSV up to date.

Default behaviour (no arguments): fetch the last 10 days.
For each day returned by the CGI:
  - If the date is missing from the CSV: add it.
  - If the date is present but has missing values (blank or x): update those fields.
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

# Variables to fetch — must match the column names in ruao_data.csv.
# The observatory CGI offers every value in its catalogue; we request the full
# set of physical measurements available in SI / metric units. Deliberately
# EXCLUDED: non-SI unit variants (wind in knots, temps in degF, Piche evaporation
# in ml), categorical/coded fields (cloud oktas, visibility code), and the binary
# threshold/event flags (hot-day, warm-night, wet-day, etc.) — the model derives
# those itself from the base measurements via its tools.
VARIABLES = {
    # ── Pressure & humidity ──
    "Pstn":  "y",  # Station pressure (hPa)
    "Pmsl":  "y",  # MSL pressure (hPa)
    "VP":    "y",  # Vapour pressure (hPa)
    "Ptemp": "y",  # Barometer temperature (degC)
    "RH":    "y",  # Relative humidity (%)
    # ── Air / surface temperature ──
    "Tdry":  "y",  # Dry bulb temp (degC)
    "Twet":  "y",  # Wet bulb temp (degC)
    "Tdew":  "y",  # Dew point (degC)
    "Tx":    "y",  # Maximum temperature (degC)
    "Tn":    "y",  # Minimum temperature (degC)
    "Tg":    "y",  # Grass minimum temp (degC)
    "Ts":    "y",  # Soil minimum temp (degC)
    "Tc":    "y",  # Concrete minimum temp (degC)
    "Tbar":  "y",  # Mean daily temp (degC)
    "Tdiur": "y",  # Daily temp range (degC)
    # ── Soil temperature profile ──
    "E5":    "y",  # 5cm soil temp (degC)
    "E10":   "y",  # 10cm soil temp (degC)
    "E20":   "y",  # 20cm soil temp (degC)
    "E30":   "y",  # 30cm soil temp (degC)
    "E50":   "y",  # 50cm soil temp (degC)
    "E1m":   "y",  # 100cm soil temp (degC)
    # ── Wind ──
    "dd":     "y", # Wind direction (deg/10)
    "ff_ms":  "y", # Wind speed (m/s)
    "ggx_ms": "y", # Max 3-sec gust (m/s)
    "ggx_ms1":"y", # Max 1-sec gust (m/s)
    "cc2":    "y", # Cup-counter wind run at 2m (km)
    # ── Rainfall ──
    "RR":     "y", # Rainfall 24h from 09GMT (mm)
    "Rdur":   "y", # Rain duration from 09GMT (h)
    "rd":     "y", # Rain day (1=yes)
    "RR_gl":  "y", # Ground-level rain from 09GMT (mm)
    "RR_int": "y", # Intercepted rain from 09GMT (mm)
    # ── Frost, snow, sunshine, radiation, evaporation ──
    "af":    "y",  # Air frost (air min < 0C)
    "gf":    "y",  # Ground frost (grass min < 0C)
    "sd_cm": "y",  # Total snow depth (cm)
    "sss":   "y",  # Sunshine duration (h)
    "skz":   "y",  # Kipp-Zonen sunshine (h)
    "tev":   "y",  # Tank evaporation (mm)
    "srad":  "y",  # Solar radiation (MJ/m2)
    # ── Cloud & weather ──
    "N8":    "y",  # Cloud cover (oktas, 0-8) — not SI but requested
    "ww":    "y",  # Present weather code (WMO)
}

# Fields that can meaningfully be backfilled (skip metadata columns)
BACKFILL_FIELDS = list(VARIABLES.keys())

# A field counts as "missing" (and so is eligible to be filled in) when it is
# blank or the literal "x". Historic gaps in the record use "x"; recently added
# placeholder rows (date present, readings not yet entered) use empty strings.
def is_missing(val: str) -> bool:
    return val.strip() in ("", "x")

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

    # The CGI lays each field on its own <br>-separated line. Turn <br> into real
    # newlines first, then strip only well-formed HTML tags. Crucially the tag
    # pattern forbids '<' and '>' inside, so a literal '<' in the data (e.g. an
    # observer note "max temp<dry bulb") is NOT mistaken for a tag and the greedy
    # match can't span across fields and swallow real values.
    block = re.sub(r"(?i)<br\s*/?>", "\n", match.group(1))
    raw = re.sub(r"</?[a-zA-Z][^<>\n]*>", "", block).strip()

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
                existing_val = existing.get(field, "x")
                fresh_val    = fresh.get(field, "x")
                if is_missing(existing_val) and not is_missing(fresh_val):
                    existing[field] = fresh_val.strip()
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
