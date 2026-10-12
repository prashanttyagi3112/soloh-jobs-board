# Soloh Jobs Board

Internal job board for the SoloH Partners recruiting team. It is a static site: filters, sorting, and Excel/PDF exports all run in the browser. Job rows and the original Chief of Jobs PDF are stored only as AES-GCM ciphertext.

The password is not in this repository. Set it in the environment when you rebuild the data files, and share it with the team outside of git.

## Preview locally

WebCrypto only works on a secure page (`https` or `http://127.0.0.1`), so open the site through a local server rather than as a file.

```bash
cd site
python3 -m http.server 8080
```

Then open `http://127.0.0.1:8080`. Enter the team password on the launch screen. The board keeps decrypted rows in memory for that tab only. **Lock** reloads the page and drops them.

## Refresh the daily file

Install the build tools once:

```bash
python3 -m pip install -r scripts/requirements.txt
```

Put the new workbook and the optional Chief of Jobs PDF somewhere outside this repo. Then regenerate the encrypted files with the same team password already in use:

```bash
export SOLOH_JOBS_PASSWORD='your-team-password'
python3 scripts/build_data.py \
  --xlsx /path/to/Master_Jobs.xlsx \
  --pdf /path/to/Chief_of_Jobs_Report_YYYY-MM-DD.pdf \
  --data-date YYYY-MM-DD \
  --updated-at YYYY-MM-DDTHH:MM:SSZ
```

`--pdf` is optional. If you omit `--data-date`, the script uses a `YYYY-MM-DD` it finds in the PDF or workbook file name. `--updated-at` is the run timestamp in ISO form (timezone offsets are accepted; a value with no zone is treated as UTC). If you omit it, the script uses the current time. That timestamp is stored in the encrypted payload and in `public.json`. The clock time alone is not job data. The board formats it in US Eastern and labels it EST or EDT.

The script reads the `Master` sheet (any capitalization; a workbook with a single sheet is used if it is not named Master). Headers are matched without case sensitivity, and a few common renames still map to the expected columns (`Bill Rate`, `Hours/week`, `MSP`, `JobID`, and similar). Extra columns are kept and show up in the table and the job detail panel. A missing column is left blank and printed as a warning. The build stops only when the headers no longer look like a Master Jobs sheet. It writes:

- `site/data/jobs.enc.json` — encrypted jobs, including the update timestamp
- `site/data/report.enc.json` — encrypted PDF, when you passed one
- `site/data/public.json` — data date, update timestamp, build time, and the report’s download name only

A data refresh is published by committing those files and pushing them **directly to `main`**. Do not open a pull request for a data-only update. Design and feature changes stay on a pull request until the owner approves them. The workflow does not rebuild the workbook, because the password and the spreadsheet are not in the repo. After the Actions run finishes, confirm the live site shows the new “Jobs last updated” time.

The script prints job and discipline counts. It does not print row contents.

Do not commit `.xlsx` or `.pdf` files, an `.env` file, a decrypted JSON extract, or the password (including in the commit message). `.gitignore` already ignores the data files and env files.

## What the board shows

Every workbook column is included, plus the derived Discipline column. Default view is **Status = Open**. **Show all statuses** includes hold and closed rows. The header shows the data date and the per-source counts for the whole drop (HWL, BudE, Magnit, plus any future source). The stat tiles and the source chips follow the current filters.

Filters are Specialty, Discipline, City, State, and VMS. VMS is the Source column (HWL, BudE, Magnit, and any later source). Each is a searchable multi-select. Options narrow to values that still exist given the other selections: Discipline narrows Specialty, State narrows City, VMS narrows the locations and specialties that source actually has, and a choice that no longer matches is cleared. There is also a free-text search across every column. Column headers sort; empty values stay at the bottom. Jobs in view and openings count up when the filter changes.

**Export Excel** and **Export PDF** download the rows in the current view, with every column. The PDF is landscape. **Chief of Jobs report** downloads the original report after decrypting it in the browser. None of these calls a server.

On a narrow screen the table becomes cards. **Expand cards** or **All columns** opens the rest of the fields.

The header shows **Jobs last updated** in US Eastern (EST or EDT), plus the weekday refresh schedule: Monday to Friday at 8 AM, 12 PM, 2 PM, 4 PM, and 8 PM ET.

**Target margin** recalculates W2 RT and gross weekly pay for every row. Every visit starts at $4,000. The board does not save a changed margin in the browser or the address bar, and it clears any margin value that was stored before. Shortcuts are $3,000, $3,500, and $4,000. Clearing the box, or entering zero, a negative, or anything that is not a number, snaps back to $4,000 on blur or Enter and recalculates. **Reset filters** does the same and also clears custom margins. Check a job and **Apply to selected** to give those rows a different margin for this visit. The original pay stays available on hover, and a delta shows when the new figure differs. If the rounded W2 RT is not positive, the cell says “Not viable at target margin.” Excel and PDF exports use the figures on screen and include **Margin Used**. The workbook column Target Margin Used stays in the encrypted file and is not shown, so the only margin on screen is the live one. **Selected only** limits the export to checked rows in the current view.

Click a row (not its checkbox) to open the full record. The panel groups job info, location, schedule, rates and margin, the pay package at the current margin, and tracking. Columns that are not in those groups, including ones added in a later workbook, appear under Additional. **Copy job summary** copies one recruiter line, for example `RN - ICU @ Louisville, KY - Gross Pay of $2,500.00 for night shift (36 Hours/week)`. Esc, Close, or a click on the backdrop dismisses it.

## Pay formula

W2 RT and gross weekly pay use the Soloh package formula. Load is 1.18. Straight time is the first 40 hours, and hours above that are overtime at 1.5×. MSP is the workbook fraction (6% is 0.06). W2 RT is rounded down to the cent. Gross weekly pay, which adds weekly per diem, is rounded half-up. The inputs are bill rate, hours/week, weeks, weekly per diem, MSP %, NBO hours, and the target margin on screen.

## Discipline and specialty

The workbook has no Discipline column. `scripts/build_data.py` assigns one from Standard Title and Profession - Specialty. The first match wins:

1. **LPN/LVN** — LPN, LVN, licensed practical nurse, or licensed vocational nurse.
2. **CNA** — CNA, STNA, GNA, PCT, certified nursing assistant, nursing assistant, nurse aide, or patient care tech. Patient-care techs sit with aides, not with imaging or lab techs.
3. **RN** — the standard title starts with `RN`, the text says RN or Registered Nurse, or the profession starts with `Nursing` and was not already LPN/LVN or CNA. That includes bedside, case management, and nursing leadership titles.
4. **Allied** — lab, imaging/radiology, therapy (PT, OT, SLP, respiratory), and surgical tech, plus the other clinical titles this desk keeps with allied: pharmacy, dietetics, dental hygiene, sleep, EEG/neurodiagnostics, medical physics, social work, and tumor registry. A profession explicitly marked Allied stays in this group.
5. **Other** — anything else, such as a non-clinical title that matches none of the rules.

Specialty in the filter is the Standard Title (the normalized specialty already produced by Chief of Jobs). If that cell is blank, the script fills it from the text after the last `|` or ` - ` in Profession - Specialty.

The 2026-10-11 drop (359 jobs) classifies as RN 267, LPN/LVN 2, Allied 90, CNA 0, Other 0. Standard titles in that file:

| Discipline | Standard titles |
| --- | --- |
| RN | RN - Administrative Manager, RN - Antepartum, RN - Burn ICU, RN - CCU, RN - CVICU, RN - CVOR, RN - Case Manager, RN - Cath Lab, RN - Clinic/Ambulatory, RN - Clinical Resource, RN - Diabetes Care, RN - ED, RN - Endoscopy, RN - Endovascular, RN - First Assist, RN - ICU, RN - Infection Control, RN - Infusion, RN - L&D, RN - Med/Surg, RN - Med/Surg-Tele, RN - Mother/Baby, RN - NICU, RN - Neuro, RN - Nurse Coordinator, RN - Nurse Educator, RN - Nurse Manager, RN - Nurse Supervisor, RN - Nursing Director, RN - OR, RN - Observation, RN - Oncology, RN - Outpatient, RN - Outpatient Surgery, RN - PACU, RN - PCU, RN - Peds OR, RN - Perinatal, RN - Special Procedures, RN - Telemetry, RN - Utilization Review, RN - Wound Care |
| LPN/LVN | LPN |
| CNA | none in this drop; the rule is still applied on later files |
| Allied | CST, CT Tech, Cath Lab Tech, Dental Hygienist, Dietitian, EEG Tech, Echo Tech, IR Tech, Instrument Tech, MLT, MLT - Microbiology, MRI Tech, Mammo Tech, Med Tech (MLS), Medical Physicist, Nuc Med Tech, OT, PT, Pharmacist, Pharmacy Tech, RRT, RRT - NICU, Rad Tech, Rad Therapist, SLP, Sleep Tech, Social Worker, Sonographer, Sonographer - Vascular, Special Procedures Tech, Surgical Tech, Surgical Tech - First Assist, Tumor Registrar |
| Other | none in this drop |

## GitHub Pages

The workflow `.github/workflows/pages.yml` deploys the `site/` directory from `main` with GitHub Actions. The live site is [https://prashanttyagi3112.github.io/soloh-jobs-board/](https://prashanttyagi3112.github.io/soloh-jobs-board/). A push to `main` republishes it. Data-only refreshes go straight to `main` so that deploy runs without a pull request.

## Security

Each encrypted file has its own random 16-byte salt and 12-byte IV. The key is PBKDF2-HMAC-SHA256 with 600,000 iterations, and the cipher is AES-256-GCM. The browser decrypts with WebCrypto; the password is not written into the page, the data files, or source control. `site/data/public.json` has the data date, the update timestamp, and the report filename only, so the lock screen can show the date before unlock.

The repository is public. Encryption hides the workbook from casual visitors, but anyone who has the password can decrypt the files. Keep the password off GitHub (including issues, pull requests, and commit messages). `public.json` may include the update timestamp. It must not include job rows, rates, or the password.
