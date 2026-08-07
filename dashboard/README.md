# Dashboard

Quick-look analytics + clean export over the live Firebase data, with a
**cross-filter** that restricts every analytical view to the respondents
matching conditions on their answers.

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

## Cross-filter
Pick a number of conditions in the sidebar. Each condition is a question plus one
or more of its values. For multi-select questions you can require the answer to
**include any** or **include all** of the chosen values; conditions **AND**
together. Example: `impacts includes Property damage` AND `impacts includes
Stress` restricts the Word clouds, Likert and Choices tabs to just those
respondents. The sidebar shows how many of the in-session respondents match.

Any single- or multiple-choice question can be a filter condition (profile
demographics and ordinary questions alike). Word prompts are free text and are
not filterable.

## Notes
- Config (attribute filters, dimensions, labels) is fetched **live** from
  Hosting so it matches what participants saw; falls back to the local `config/`
  files if offline. Override the URL with `DASHBOARD_HOSTING_URL`.
- Everything filters by **session**. Profile questions become group-by
  attributes automatically; a multi-select attribute uses overlapping membership
  (a respondent appears in every group they belong to), so grouped counts can
  exceed the respondent total.
- Tabs: Overview · Word clouds · Likert · Choices · Export (CSV per table + a
  single SQLite `.db`). The Export tab is session-filtered only, not
  cross-filtered, so you always get the full session dataset.
