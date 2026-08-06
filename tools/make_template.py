"""Generate study_content.xlsx (the team's single editing surface).

Exposes build_workbook(rows_by_tab, path) so the same styled schema is used
both for a blank/example template (this script's main()) and for one-off
content migrations. Run: python tools/make_template.py  (writes ../study_content.xlsx)
"""
import os
from collections import OrderedDict
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

HEADER_FILL = PatternFill("solid", fgColor="0E7C86")
HEADER_FONT = Font(name="Arial", bold=True, color="FFFFFF", size=11)
BODY_FONT   = Font(name="Arial", size=11)
WRAP        = Alignment(vertical="top", wrap_text=True)
THIN        = Side(style="thin", color="D9DDE2")
BORDER      = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

# Ordered schema: tab -> columns + display widths. This order is the tab order.
TABS = OrderedDict([
    ("settings",         {"cols": ["key", "value", "notes"],
                          "widths": [26, 18, 56]}),
    ("registration",     {"cols": ["field_id", "label", "type", "required", "option_value", "option_text"],
                          "widths": [16, 40, 14, 10, 18, 24]}),
    ("questions",        {"cols": ["id", "section", "type", "prompt", "image",
                                   "max_words", "min_words", "has_other", "choice_text"],
                          "widths": [10, 16, 16, 46, 24, 11, 11, 10, 40]}),
    ("discussion",       {"cols": ["id", "text", "image"],
                          "widths": [10, 64, 28]}),
    ("likert_stimuli",   {"cols": ["id", "title", "body", "image"],
                          "widths": [10, 24, 60, 26]}),
])

NOTES = [
    ["How to edit this file"],
    [""],
    ["Each tab is one kind of study content. Edit the rows, save, then run:"],
    ["   python tools/build_content.py     (publishes your changes to the app)"],
    [""],
    ["Rules that matter:"],
    ["- 'id' / 'field_id' / question 'id': short and unique WITHIN its tab (q1, st1, d1). Don't reuse."],
    ["- Leave optional cells blank (e.g. 'image', or 'max_words' on a choice question)."],
    ["- Do not rename tabs or the header row (row 1)."],
    [""],
    ["settings:        key/value study-wide options. See the 'notes' column on each row."],
    ["registration:    one row PER OPTION. Repeat field_id down the rows; label/type/required taken"],
    ["                 from the field's first row. type = single-choice | text | number."],
    ["                 (text/number need no option rows; only single-choice uses option_value/text.)"],
    ["questions:       the participant questionnaire. One row PER CHOICE (like registration)."],
    ["                 Repeat the same 'id' down the rows; the FIRST row carries type/prompt/image/"],
    ["                 has_other/max_words/min_words, later rows fill only 'choice_text'."],
    ["                 type = single_choice | multiple_choice | word_prompt."],
    ["                 - single_choice / multiple_choice: give 2+ 'choice_text' rows. Set has_other=yes"],
    ["                   to append an 'Other' option with a free-text box (works for both types)."],
    ["                 - word_prompt: one row, no choices. Uses max_words / min_words (open word entry)."],
    ["                 'section' = which questionnaire section this question belongs to (a section id"],
    ["                 from config.json, e.g. questionnaire). Blank = the first questionnaire section."],
    ["                 Rich text in prompt/choices: **bold**. Questions appear in row order."],
    ["discussion:      host-led display shown to everyone (text and/or image). No participant input."],
    ["likert_stimuli:  one row per stimulus shown in the Likert section (title + body and/or image)."],
]


def build_workbook(rows_by_tab, path):
    wb = Workbook()
    # READ ME FIRST
    ws = wb.active
    ws.title = "READ ME FIRST"
    ws.column_dimensions["A"].width = 100
    for r, line in enumerate(NOTES, start=1):
        c = ws.cell(row=r, column=1, value=line[0])
        c.font = Font(name="Arial", bold=(r == 1), size=12 if r == 1 else 11)

    for tab, spec in TABS.items():
        ws = wb.create_sheet(tab)
        cols = spec["cols"]
        for j, (col, w) in enumerate(zip(cols, spec["widths"]), start=1):
            cell = ws.cell(row=1, column=j, value=col)
            cell.fill = HEADER_FILL; cell.font = HEADER_FONT; cell.border = BORDER
            ws.column_dimensions[ws.cell(row=1, column=j).column_letter].width = w
        ws.freeze_panes = "A2"
        for i, row in enumerate(rows_by_tab.get(tab, []), start=2):
            for j, col in enumerate(cols, start=1):
                cell = ws.cell(row=i, column=j, value=row.get(col))
                cell.font = BODY_FONT; cell.border = BORDER; cell.alignment = WRAP
    wb.save(path)


# ---- example rows (used for a blank template; migration supplies real rows) ----
EXAMPLE_ROWS = {
    "settings": [
        {"key": "likert_points", "value": 3, "notes": "Number of points on the Likert scale (e.g. 3 or 5)."},
    ],
    "registration": [
        {"field_id": "age_range", "label": "What is your age range?", "type": "single-choice", "required": "yes", "option_value": "15-29", "option_text": "15-29"},
        {"field_id": "age_range", "option_value": "30-44", "option_text": "30-44"},
        {"field_id": "gender", "label": "What is your gender?", "type": "single-choice", "required": "yes", "option_value": "female", "option_text": "Female"},
        {"field_id": "gender", "option_value": "male", "option_text": "Male"},
    ],
    "questions": [
        # word_prompt: one row, open word entry.
        {"id": "q1", "section": "words", "type": "word_prompt",
         "prompt": "When you hear 'flood warning', what words come to mind?", "max_words": 5, "min_words": 1},
        # single_choice: first row carries prompt/type; each choice is its own row.
        {"id": "q2", "section": "words", "type": "single_choice",
         "prompt": "Which channel do you trust most for flood warnings?", "has_other": "yes",
         "choice_text": "Radio"},
        {"id": "q2", "choice_text": "SMS"},
        {"id": "q2", "choice_text": "Community leader"},
        # multiple_choice: pick any number; has_other adds a free-text 'Other'.
        {"id": "q3", "section": "words", "type": "multiple_choice",
         "prompt": "Which of these have you used before?", "has_other": "yes",
         "choice_text": "Flood map"},
        {"id": "q3", "choice_text": "Evacuation notice"},
        {"id": "q3", "choice_text": "Neighbour's warning"},
    ],
    "discussion": [
        {"id": "d1", "text": "How does your community currently hear about floods?"},
        {"id": "d2", "text": "What makes a flood warning believable?", "image": "images/prompts/d2.jpg"},
    ],
    "likert_stimuli": [
        {"id": "st1", "title": "SMS text alert", "body": "FLOOD ALERT: Heavy rain expected tonight. Move to higher ground."},
    ],
}

if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "study_content.xlsx")
    build_workbook(EXAMPLE_ROWS, out)
    print("Wrote", os.path.abspath(out))
