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

Put the new workbook and the optional Chief of Jobs PDF somewhere outside this repo. Then regenerate the encrypted files:

```bash
export SOLOH_JOBS_PASSWORD='your-team-password'
python3 scripts/build_data.py \
  --xlsx /path/to/Master_Jobs.xlsx \
  --pdf /path/to/Chief_of_Jobs_Report_YYYY-MM-DD.pdf \
  --data-date YYYY-MM-DD
```

`--pdf` is optional. If you omit `--data-date`, the script uses a `YYYY-MM-DD` it finds in the PDF or workbook file name. It reads the `Master` sheet, derives Discipline, and writes:

- `site/data/jobs.enc.json` — encrypted jobs
- `site/data/report.enc.json` — encrypted PDF, when you passed one
- `site/data/public.json` — data date, build time, and the report’s download name only

Commit those three files and push to `main`. GitHub Actions publishes `site/` ; it does not rebuild the workbook, because the password and the spreadsheet are not in the repo. The script prints job and discipline counts. It does not print row contents.

Do not commit `.xlsx` or `.pdf` files, an `.env` file, or a decrypted JSON extract. `.gitignore` already ignores those.

## What the board shows

Every workbook column is included, plus the derived Discipline column. Default view is **Status = Open**. **Show all statuses** includes hold and closed rows. The header shows the data date and the per-source counts for the whole drop (HWL, BudE, Magnit, plus any future source). The stat tiles and the source chips follow the current filters.

Filters are Specialty, Discipline, City, and State. Each is a searchable multi-select. Options narrow to values that still exist given the other selections: Discipline narrows Specialty, State narrows City, and a choice that no longer matches is cleared. There is also a free-text search across every column. Column headers sort; empty values stay at the bottom. Jobs in view and openings count up when the filter changes.

**Export Excel** and **Export PDF** download the rows in the current view, with every column. The PDF is landscape. **Chief of Jobs report** downloads the original report after decrypting it in the browser. None of these calls a server.

On a narrow screen the table becomes cards. **Expand cards** or **All columns** opens the rest of the fields.

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

The workflow `.github/workflows/pages.yml` deploys the `site/` directory from `main` with GitHub Actions.

Pages is not enabled yet. Turn it on once, after this project is on `main`:

1. Open [the repository Pages setting](https://github.com/prashanttyagi3112/soloh-jobs-board/settings/pages).
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.

The live site will be [https://prashanttyagi3112.github.io/soloh-jobs-board/](https://prashanttyagi3112.github.io/soloh-jobs-board/). The first run starts when `main` receives the workflow. Later pushes to `main` republish the site.

## Security

Each encrypted file has its own random 16-byte salt and 12-byte IV. The key is PBKDF2-HMAC-SHA256 with 600,000 iterations, and the cipher is AES-256-GCM. The browser decrypts with WebCrypto; the password is not written into the page, the data files, or source control. `site/data/public.json` has the data date and the report filename only, so the lock screen can show the date before unlock.

The repository is public. Encryption hides the workbook from casual visitors, but anyone who has the password can decrypt the files. Keep the password off GitHub (including issues, pull requests, and commit messages).
