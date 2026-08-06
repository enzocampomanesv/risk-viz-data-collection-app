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
    ("word_prompts",     {"cols": ["id", "section", "text", "image", "max_words", "min_words"],
                          "widths": [10, 16, 52, 26, 12, 12]}),
    ("discussion",       {"cols": ["id", "text", "image"],
                          "widths": [10, 64, 28]}),
    ("likert_stimuli",   {"cols": ["id", "title", "body", "image"],
                          "widths": [10, 24, 60, 26]}),
    ("comparison_items", {"cols": ["id", "label", "file", "text", "group"],
                          "widths": [10, 26, 20, 50, 16]}),
    ("choice_questions", {"cols": ["id", "prompt", "choice_1", "choice_2", "choice_3", "choice_4"],
                          "widths": [10, 44, 22, 22, 22, 22]}),
])

NOTES = [
    ["How to edit this file"],
    [""],
    ["Each tab is one kind of study content. Edit the rows, save, then run:"],
    ["   python tools/build_content.py     (publishes your changes to the app)"],
    [""],
    ["Rules that matter:"],
    ["- 'id' / 'field_id' / question 'id': short and unique WITHIN its tab (wp1, st1, c01, q1). Don't reuse."],
    ["- Leave optional cells blank (e.g. 'image', or 'file' when an item is text-only)."],
    ["- Do not rename tabs or the header row (row 1)."],
    [""],
    ["settings:        key/value study-wide options. See the 'notes' column on each row."],
    ["registration:    one row PER OPTION. Repeat field_id down the rows; label/type/required taken"],
    ["                 from the field's first row. type = single-choice | text | number."],
    ["                 (text/number need no option rows; only single-choice uses option_value/text.)"],
    ["word_prompts:    'section' = which word_association section this prompt belongs to (a section id"],
    ["                 from config.json, e.g. words / words_future). Blank = the first word section."],
    ["discussion:      host-led display shown to everyone (text and/or image). No participant input."],
    ["comparison_items: the pairwise items. Give a 'file' (image in images/visual_v1) OR 'text'."],
    ["                 'group' restricts pairing: items are only ever compared WITHIN the same group."],
    ["                 Put warm-up items in group 'preparation' (shown first, never saved)."],
    ["choice_questions: post-pairwise. 'prompt' + up to 4 choices (leave extra choice cells blank)."],
    ["                 Rich text in prompt/choices: **bold** and [[name:words]] for colour"],
    ["                 (name = red | green | blue | amber | teal). Combine: [[red:**high chance**]]."],
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
        {"key": "pairwise_sequence_mode", "value": "grouped", "notes": "grouped = all of one group's pairs, then the next | shuffled = mix groups."},
        {"key": "pairwise_loop", "value": "no", "notes": "shuffled only: yes = keep looping (reshuffled laps) until host releases."},
        {"key": "comparisons_per_group", "value": 0, "notes": "Max comparisons per group (0 = all possible pairs)."},
        {"key": "prep_comparisons", "value": 0, "notes": "Warm-up comparisons from the 'preparation' group (0 = all)."},
        {"key": "pairwise_landscape", "value": "yes", "notes": "yes = require landscape (rotate prompt) for the comparison task."},
        {"key": "pairwise_prompt", "value": "Which option do you prefer?", "notes": "Question shown above each comparison."},
    ],
    "registration": [
        {"field_id": "age_range", "label": "What is your age range?", "type": "single-choice", "required": "yes", "option_value": "15-29", "option_text": "15-29"},
        {"field_id": "age_range", "option_value": "30-44", "option_text": "30-44"},
        {"field_id": "gender", "label": "What is your gender?", "type": "single-choice", "required": "yes", "option_value": "female", "option_text": "Female"},
        {"field_id": "gender", "option_value": "male", "option_text": "Male"},
    ],
    "word_prompts": [
        {"id": "wp1", "section": "words", "text": "When you hear 'flood warning', what words come to mind?", "max_words": 5, "min_words": 1},
        {"id": "wpf1", "section": "words_future", "text": "In an ideal future, how would you want to receive flood information?", "max_words": 5, "min_words": 1},
    ],
    "discussion": [
        {"id": "d1", "text": "How does your community currently hear about floods?"},
        {"id": "d2", "text": "What makes a flood warning believable?", "image": "images/prompts/d2.jpg"},
    ],
    "likert_stimuli": [
        {"id": "st1", "title": "SMS text alert", "body": "FLOOD ALERT: Heavy rain expected tonight. Move to higher ground."},
    ],
    "comparison_items": [
        {"id": "c01", "label": "Hazard map", "file": "c01.jpg", "group": "visual"},
        {"id": "c02", "label": "Plain SMS", "text": "Flood likely tonight. Move valuables up.", "group": "wording"},
        {"id": "p01", "label": "Warm-up A", "text": "A short example message.", "group": "preparation"},
        {"id": "p02", "label": "Warm-up B", "text": "Another example message.", "group": "preparation"},
    ],
    "choice_questions": [
        {"id": "q1", "prompt": "Which option was easiest to understand?",
         "choice_1": "The map", "choice_2": "The SMS", "choice_3": "The radio notice", "choice_4": "None of them"},
    ],
}

if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "study_content.xlsx")
    build_workbook(EXAMPLE_ROWS, out)
    print("Wrote", os.path.abspath(out))
