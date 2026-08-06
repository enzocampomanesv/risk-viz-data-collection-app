# Editing study content (Excel)

Your team edits **`study_content.xlsx`** (one tab per content type). The
participant app never reads Excel directly — before deploying, convert it:

```bash
pip install -r tools/requirements.txt      # once
python tools/build_content.py              # Excel -> config/content.json
firebase deploy --only hosting             # publish
```

`build_content.py` validates ids and required columns and warns about missing
image files; it refuses to write if anything is broken, so problems surface
on your machine, not on a participant's phone.

To regenerate a fresh blank template: `python tools/make_template.py`.
