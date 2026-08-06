# Dashboard (Python side of Path C)

Quick-look analytics + clean export over the live Firebase data. The Bradley-
Terry fit here is an **approximate sanity-check** (same `sigmoid(strength_a −
strength_b)` model as the AI-voter training, but strengths fit by MLE directly
to the human comparisons). The **comparison export is the real deliverable**
for your full BT pipeline.

## One-time setup
1. `pip install -r requirements.txt`  (reuse your dashboard/.venv)
2. Put the service-account key here as `serviceAccountKey.json`
   (Firebase console → Project settings → Service accounts → Generate new private key).
   **Gitignored — never commit it.**
3. Grant the host admin (if not done): `python set_admin_claim.py host@yourstudy.org`

## Run
```bash
streamlit run dashboard/app.py
```

## Notes
- Config (attribute filters, Likert dimensions, item labels) is fetched **live**
  from Hosting so it matches what participants saw; falls back to the local
  `config/` files if offline. Override the URL with `DASHBOARD_HOSTING_URL`.
- Everything filters by **session**. New `participant_fields` appear as filters
  automatically — no code change.
- Tabs: Overview · Word clouds · Likert · Pairwise rankings · Export (CSV per
  table + a single SQLite `.db`).
