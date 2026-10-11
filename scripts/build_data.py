#!/usr/bin/env python3
"""Build encrypted data files for the Soloh Jobs Board.

Reads a Master Jobs workbook (sheet "Master") and an optional Chief of Jobs
PDF, then writes AES-GCM payloads the static site can decrypt in the browser.

The password is taken from the SOLOH_JOBS_PASSWORD environment variable.
Do not pass it on the command line, and do not store it in this repository.

Discipline is derived (the workbook has no Discipline column). First match wins:

1. LPN/LVN — LPN, LVN, Licensed Practical Nurse, or Licensed Vocational Nurse
   in the standard title or profession.
2. CNA — CNA, STNA, GNA, PCT, certified nursing assistant, nursing assistant,
   nurse aide, or patient care tech. PCT is grouped here because this desk
   treats patient-care techs with aides rather than with imaging/lab techs.
3. RN — standard title starts with "RN", the text says RN or Registered Nurse,
   or the profession starts with "Nursing" and was not already LPN/LVN or CNA.
4. Allied — lab, imaging/radiology, therapy (PT, OT, SLP, respiratory),
   surgical tech, and the other clinical titles this desk keeps with allied:
   pharmacy, dietetics, dental hygiene, sleep, EEG/neurodiagnostics, medical
   physics, social work, and tumor registry. A profession explicitly marked
   Allied is allied even if a future title is unfamiliar.
5. Other — anything else (non-clinical titles that match none of the above).

Specialty for the filter is the Standard Title (the normalized specialty from
the Chief of Jobs process). If that cell is blank, the script uses the text
after the last " | " or " - " in Profession - Specialty.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

try:
    import openpyxl
except ImportError:
    sys.exit("Install dependencies: python3 -m pip install -r scripts/requirements.txt")

try:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
except ImportError:
    sys.exit("Install dependencies: python3 -m pip install -r scripts/requirements.txt")

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "site" / "data"
ITERATIONS = 600_000
PASSWORD_ENV = "SOLOH_JOBS_PASSWORD"

REQUIRED_HEADERS = [
    "Job Key",
    "Source",
    "Job ID",
    "Profession - Specialty",
    "Standard Title",
    "City",
    "State",
    "Shift",
    "Hours/week",
    "Weeks",
    "BR",
    "NBO",
    "MSP %",
    "Weekly Per Diem",
    "W2 RT",
    "Gross Weekly Pay",
    "Openings",
    "Target Margin Used",
    "Per Diem Month",
    "First Seen",
    "Last Seen",
    "Status",
    "Facility",
]

# Recruiting-review order. Every workbook column is still included; unknown
# future columns are appended after these.
COLUMN_ORDER = [
    "Standard Title",
    "Discipline",
    "Facility",
    "City",
    "State",
    "Status",
    "Shift",
    "Hours/week",
    "Weeks",
    "Openings",
    "BR",
    "W2 RT",
    "Weekly Per Diem",
    "Gross Weekly Pay",
    "Target Margin Used",
    "MSP %",
    "NBO",
    "Source",
    "Job ID",
    "Profession - Specialty",
    "Per Diem Month",
    "First Seen",
    "Last Seen",
    "Job Key",
]

LPN_RE = re.compile(
    r"\b(LPN|LVN)\b|Licensed Practical Nurse|Licensed Vocational Nurse",
    re.IGNORECASE,
)
CNA_RE = re.compile(
    r"\b(CNA|STNA|GNA|PCT)\b|"
    r"Certified Nursing Assistant|Nursing Assistant|Nurse Aide|Nurses' Aide|"
    r"Patient Care Tech",
    re.IGNORECASE,
)
RN_RE = re.compile(r"\bRN\b|Registered Nurse", re.IGNORECASE)
ALLIED_RE = re.compile(
    r"\b("
    r"Allied|SLP|CST|MLT|MLS|RRT|EEG|MRI|"
    r"Tech|Technician|Technologist|Therapist|Therapy|"
    r"Sonograph|Ultrasound|Radiolog|Mammograph|X-Ray|Xray|"
    r"Nuclear Medicine|Nuc Med|Cath Lab|Echo|Phlebotom|"
    r"Surgical|Respiratory|Physical Therapist|Occupational|Speech|Pathologist|"
    r"Dietit|Pharmac|Hygienist|Physicist|Sleep|"
    r"Tumor Registrar|Social Worker|Special Procedures|Instrument|"
    r"OT|PT"
    r")\b",
    re.IGNORECASE,
)
NUMERIC_RE = re.compile(r"-?\d+(?:\.\d+)?")
DATE_RE = re.compile(r"(20\d{2}-\d{2}-\d{2})")
CORE_HEADERS = ["Standard Title", "Facility", "City", "State", "Status", "Source"]


def header_key(text: str) -> str:
    text = text.replace("\u00a0", " ").replace("–", "-").replace("—", "-").replace("−", "-")
    text = re.sub(r"\s*([/%\-])\s*", r"\1", text)
    text = re.sub(r"\s+", " ", text).strip().lower()
    return text


# Case, spacing, and a few renames still map onto the columns the board expects.
ALIASES = {header_key(name): name for name in REQUIRED_HEADERS}
ALIASES.update(
    {
        "bill rate": "BR",
        "billrate": "BR",
        "hours per week": "Hours/week",
        "weekly hours": "Hours/week",
        "hrs/week": "Hours/week",
        "hours/wk": "Hours/week",
        "msp": "MSP %",
        "msp percent": "MSP %",
        "msp percentage": "MSP %",
        "per diem": "Weekly Per Diem",
        "weekly pd": "Weekly Per Diem",
        "w2 rate": "W2 RT",
        "gross weekly": "Gross Weekly Pay",
        "gross pay": "Gross Weekly Pay",
        "target margin": "Target Margin Used",
        "tnm": "Target Margin Used",
        "nbo hours": "NBO",
        "non-billable orientation": "NBO",
        "profession specialty": "Profession - Specialty",
        "profession/specialty": "Profession - Specialty",
        "jobid": "Job ID",
    }
)


def canon_header(raw) -> str:
    if raw is None:
        return ""
    text = re.sub(r"\s+", " ", str(raw).replace("\u00a0", " ")).strip()
    if not text:
        return ""
    return ALIASES.get(header_key(text), text)


def discipline_for(title: str, profession: str) -> str:
    blob = f"{title}\n{profession}"
    if LPN_RE.search(blob):
        return "LPN/LVN"
    if CNA_RE.search(blob):
        return "CNA"
    if title.upper().startswith("RN") or RN_RE.search(blob) or profession.startswith("Nursing"):
        return "RN"
    if "(Allied)" in profession or profession.startswith("Allied") or ALLIED_RE.search(blob):
        return "Allied"
    return "Other"


def specialty_for(title: str, profession: str) -> str:
    if title.strip():
        return title.strip()
    text = profession.strip()
    if "|" in text:
        return text.split("|")[-1].strip() or "Unspecified"
    if " - " in text:
        return text.split(" - ")[-1].strip() or "Unspecified"
    return text or "Unspecified"


def coerce(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        if value.is_integer():
            return int(value)
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        numeric = text.replace("$", "").replace(",", "").strip()
        if NUMERIC_RE.fullmatch(numeric):
            number = float(numeric)
            return int(number) if number.is_integer() else number
        return text
    return str(value)


def encrypt_bytes(plaintext: bytes, password: str) -> dict:
    salt = os.urandom(16)
    iv = os.urandom(12)
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=ITERATIONS,
    )
    key = kdf.derive(password.encode("utf-8"))
    ciphertext = AESGCM(key).encrypt(iv, plaintext, None)
    return {
        "v": 1,
        "alg": "AES-256-GCM",
        "kdf": "PBKDF2-HMAC-SHA256",
        "iterations": ITERATIONS,
        "salt": base64.b64encode(salt).decode("ascii"),
        "iv": base64.b64encode(iv).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
    }


def decrypt_envelope(envelope: dict, password: str) -> bytes:
    salt = base64.b64decode(envelope["salt"])
    iv = base64.b64decode(envelope["iv"])
    ciphertext = base64.b64decode(envelope["ciphertext"])
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=int(envelope["iterations"]),
    )
    key = kdf.derive(password.encode("utf-8"))
    return AESGCM(key).decrypt(iv, ciphertext, None)


def order_columns(headers: list[str]) -> list[str]:
    present = set(headers)
    ordered = [col for col in COLUMN_ORDER if col == "Discipline" or col in present]
    ordered.extend(col for col in headers if col not in ordered)
    return ordered


def find_master(workbook):
    for name in workbook.sheetnames:
        if str(name).strip().lower() == "master":
            return workbook[name]
    if len(workbook.sheetnames) == 1:
        only = workbook.sheetnames[0]
        print(f"Warning: no sheet named Master; using {only!r}.", file=sys.stderr)
        return workbook[only]
    raise SystemExit(f"Workbook has no 'Master' sheet (found {workbook.sheetnames})")


def load_jobs(xlsx_path: Path) -> tuple[list[str], list[dict]]:
    workbook = openpyxl.load_workbook(xlsx_path, data_only=True, read_only=True)
    sheet = find_master(workbook)
    rows = sheet.iter_rows(values_only=True)
    try:
        header_row = next(rows)
    except StopIteration:
        raise SystemExit("The Master sheet is empty")
    index = {}
    header_order = []
    for pos, cell in enumerate(header_row):
        name = canon_header(cell)
        if not name:
            continue
        if name in index:
            print(f"Warning: duplicate column {name!r}; keeping the first.", file=sys.stderr)
            continue
        index[name] = pos
        header_order.append(name)
    matched = [name for name in CORE_HEADERS if name in index]
    if len(matched) < 4:
        found = ", ".join(header_order) or "(none)"
        raise SystemExit(f"These headers don't look like a Master Jobs sheet: {found}")
    missing = [name for name in REQUIRED_HEADERS if name not in index]
    if missing:
        print("Warning: missing columns left blank: " + ", ".join(missing), file=sys.stderr)
    jobs = []
    for raw in rows:
        if raw is None or all(cell is None or str(cell).strip() == "" for cell in raw):
            continue
        record = {}
        for name, pos in index.items():
            value = raw[pos] if pos < len(raw) else None
            record[name] = coerce(value)
        title = str(record.get("Standard Title") or "")
        profession = str(record.get("Profession - Specialty") or "")
        record["Discipline"] = discipline_for(title, profession)
        if not title.strip():
            record["Standard Title"] = specialty_for(title, profession)
        if isinstance(record.get("State"), str) and len(record["State"]) == 2:
            record["State"] = record["State"].upper()
        jobs.append(record)
    workbook.close()
    if not jobs:
        raise SystemExit("No job rows found on the Master sheet")
    return order_columns(header_order), jobs


def infer_date(*paths: Path | None) -> str | None:
    for path in paths:
        if path is None:
            continue
        match = DATE_RE.search(path.name)
        if match:
            return match.group(1)
    return None


def write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def representative_cases() -> None:
    cases = {
        ("LPN", "LPN / LVN (LPN)"): "LPN/LVN",
        ("RN - ICU", "Registered Nurse - ICU (RN)"): "RN",
        ("RN - Nurse Manager", "Nursing - Nurse Manager, Cardiac Cath Lab"): "RN",
        ("CNA", "Certified Nursing Assistant"): "CNA",
        ("SLP", "Speech Language Pathologist (Allied)"): "Allied",
        ("CT Tech", "CT Technologist (Allied)"): "Allied",
        ("Surgical Tech", "Allied - Surgical Tech"): "Allied",
        ("Social Worker", "Social Worker (Allied)"): "Allied",
        ("Tumor Registrar", "Certified Tumor Registrar / Oncology Data Specialist (Allied)"): "Allied",
        ("Cook", "Dietary Aide"): "Other",
    }
    for (title, profession), expected in cases.items():
        got = discipline_for(title, profession)
        if got != expected:
            raise SystemExit(f"Discipline self-check failed for {title!r}: {got} != {expected}")
    if specialty_for("", "ER | RN-ED") != "RN-ED":
        raise SystemExit("Specialty fallback self-check failed")
    header_cases = {
        "Hours/week": "Hours/week",
        "hours / week": "Hours/week",
        "Bill Rate": "BR",
        "MSP": "MSP %",
        "msp %": "MSP %",
        "Target Margin": "Target Margin Used",
        "JobID": "Job ID",
        "Profession - Specialty": "Profession - Specialty",
        "Extra Column": "Extra Column",
    }
    for raw, expected in header_cases.items():
        got = canon_header(raw)
        if got != expected:
            raise SystemExit(f"Header self-check failed for {raw!r}: {got!r} != {expected!r}")


def parse_updated_at(text: str | None) -> str:
    if not text:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    raw = text.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise SystemExit(
            "--updated-at must be an ISO timestamp, for example 2026-10-13T12:12:00Z"
        ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Encrypt a Master Jobs workbook for the Soloh Jobs Board.")
    parser.add_argument("--xlsx", required=True, type=Path, help="Path to the Master Jobs workbook")
    parser.add_argument("--pdf", type=Path, help="Optional Chief of Jobs PDF report")
    parser.add_argument("--data-date", help="Board date, YYYY-MM-DD. Defaults to a date found in the file name.")
    parser.add_argument(
        "--updated-at",
        help="When this drop was produced, as an ISO timestamp. Defaults to now. Stored in the encrypted payload and public.json.",
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output directory (default: site/data)")
    return parser.parse_args()


def main() -> None:
    representative_cases()
    args = parse_args()
    password = os.environ.get(PASSWORD_ENV, "")
    if not password:
        raise SystemExit(
            f"Set {PASSWORD_ENV} in the environment. The password is not read from the repo."
        )
    xlsx_path = args.xlsx.expanduser().resolve()
    if not xlsx_path.is_file():
        raise SystemExit(f"Workbook not found: {xlsx_path}")
    pdf_path = args.pdf.expanduser().resolve() if args.pdf else None
    if pdf_path is not None:
        if not pdf_path.is_file():
            raise SystemExit(f"PDF not found: {pdf_path}")
        if pdf_path.suffix.lower() != ".pdf":
            raise SystemExit("The report must be a .pdf file")
    data_date = args.data_date or infer_date(pdf_path, xlsx_path)
    if not data_date or not DATE_RE.fullmatch(data_date):
        raise SystemExit("Pass --data-date YYYY-MM-DD (it was not in the file names).")
    updated_at = parse_updated_at(args.updated_at)

    columns, jobs = load_jobs(xlsx_path)
    counts: dict[str, int] = {}
    for job in jobs:
        counts[job["Discipline"]] = counts.get(job["Discipline"], 0) + 1
    others = sorted({job["Standard Title"] for job in jobs if job["Discipline"] == "Other"})

    payload = {
        "meta": {
            "dataDate": data_date,
            "updatedAt": updated_at,
            "columns": columns,
            "disciplines": ["RN", "LPN/LVN", "CNA", "Allied", "Other"],
        },
        "jobs": [{col: job.get(col) for col in columns} for job in jobs],
    }
    plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    jobs_envelope = encrypt_bytes(plaintext, password)
    if decrypt_envelope(jobs_envelope, password) != plaintext:
        raise SystemExit("Job payload failed the encryption round-trip check")

    args.out.mkdir(parents=True, exist_ok=True)
    jobs_path = args.out / "jobs.enc.json"
    write_json(jobs_path, jobs_envelope)

    report_name = None
    if pdf_path is not None:
        report_bytes = pdf_path.read_bytes()
        if not report_bytes.startswith(b"%PDF"):
            raise SystemExit("The report file is not a PDF")
        report_envelope = encrypt_bytes(report_bytes, password)
        if decrypt_envelope(report_envelope, password) != report_bytes:
            raise SystemExit("Report payload failed the encryption round-trip check")
        write_json(args.out / "report.enc.json", report_envelope)
        report_name = pdf_path.name

    existing_name = None
    existing_public = args.out / "public.json"
    if report_name is None and existing_public.is_file():
        try:
            existing_name = json.loads(existing_public.read_text(encoding="utf-8")).get("reportFilename")
        except json.JSONDecodeError:
            existing_name = None
    public = {
        "dataDate": data_date,
        "updatedAt": updated_at,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "hasReport": (args.out / "report.enc.json").is_file(),
        "reportFilename": report_name or existing_name,
        "reportFile": "report.enc.json",
    }
    write_json(existing_public, public)

    labels = ["RN", "LPN/LVN", "CNA", "Allied", "Other"]
    print(f"Jobs: {len(jobs)}")
    print("Disciplines: " + ", ".join(f"{name}={counts.get(name, 0)}" for name in labels))
    if others:
        print("Other titles: " + "; ".join(others))
    print(f"Wrote {jobs_path} ({jobs_path.stat().st_size} bytes)")
    if report_name:
        report_path = args.out / "report.enc.json"
        print(f"Wrote {report_path} ({report_path.stat().st_size} bytes)")
    print(f"Data date: {data_date}")
    print(f"Updated at: {updated_at}")


if __name__ == "__main__":
    main()
