"""One-off authoring/migration for the merged-questionnaire overhaul.

Rewrites study_content.xlsx into the new single-flow schema:
  - the registration tab is retired; demographics become profile=yes questions
  - one ordered `questions` tab holds the whole participant flow
  - settings / discussion / likert_stimuli are carried forward unchanged

It reuses build_workbook() so the output matches a fresh template exactly, and
writes a timestamped backup of the current workbook first.

Run once:  python tools/migrate_content.py   (then: python tools/build_content.py)
"""
import os
import shutil
import time

from make_template import build_workbook

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
XLSX = os.path.join(ROOT, "study_content.xlsx")

# ---- the participant flow, in order -------------------------------------------------
# Each choice question: (id, prompt, [choices], {flags}). Flags: profile, review,
# has_other, section. Word prompts use type "word".
PROFILE = "profile"      # ungated demographic section id (config.json)
MAIN = "questions"       # gated main section id

CHOICE = [
    # --- profile section (ungated), grouping attributes -----------------------------
    ("accra_tenure", "How long have you lived in Accra?",
     ["0-1", "1-3", "3-5", "5-10", "over 10"], dict(section=PROFILE, profile=True)),
    ("comm_tenure", "How long have you lived in this community?",
     ["0-1", "1-3", "3-5", "5-10", "over 10"], dict(section=PROFILE, profile=True)),
    ("age", "What is your age group?",
     ["18-24", "25-34", "35-44", "45-54", "55-70"], dict(section=PROFILE, profile=True)),
    ("gender", "What is your gender?",
     ["Woman", "Man", "Prefer not to say"], dict(section=PROFILE, profile=True)),
    ("education", "What is the highest level of education you completed?",
     ["No formal education", "Primary school", "Middle school", "High school", "Higher education"],
     dict(section=PROFILE, profile=True)),
    ("role", "Do you have any special role in your community?",
     ["Community leader", "Youth representative", "Religious leader", "School representative",
      "Health worker", "First responder", "Caregiver", "Trader", "NGO member"],
     dict(section=PROFILE, profile=True, multi=True, has_other=True, review=True)),
    # --- main section (gated), experience responses ---------------------------------
    ("flood_freq", "How often have floods affected you or your household?",
     ["Never", "Once", "A few times", "Every rainy season"], dict(section=MAIN)),
    ("last_flood", "When was the last time it occurred?",
     ["This June", "This year", "Last year", "I don't remember/know"], dict(section=MAIN)),
    ("impacts", "Which of the following impacts have you experienced?",
     ["Property damage", "Displacement", "Loss of livelihood", "Stress", "Anxiety",
      "Road disruption", "Diseases"], dict(section=MAIN, multi=True, has_other=True)),
    ("share_info", "Do you share flood information with others?",
     ["Yes", "No"], dict(section=MAIN)),
    ("when_use", "When do you normally use the flood-related information?",
     ["Before floods", "During floods", "After floods", "I don't use them"], dict(section=MAIN)),
]

WORD = [
    ("info_recv", "Which type of flood-related information do you currently receive?", MAIN),
    ("info_source", "Where does the information usually come from?", MAIN),
    ("info_use", "What did you use the flood-related information for?", MAIN),
]

# Host-paced word-cloud prompts (its own section). One row per prompt.
WORDCLOUD = [
    ("wc1", "Through which channels would you prefer to receive flood information?"),
    ("wc2", "Which format would be most useful?"),
    ("wc3", "What is the most important improvement needed in the current flood communication approach you have in place?"),
    ("wc4", "Is there anything we are missing in today's discussion?"),
]

# Assessment figures shown in the merged discussion + Likert section. Each entry
# is (id, title, [ (image, caption), ... ]). Multiple slides -> a carousel the
# participant flips through; the Likert score attaches to the id.
STIMULI = [
    ("st1", "SMS text alert", [
        ("images/prompts/sms.png",
         "A phone SMS: 'FLOOD ALERT: Heavy rain expected tonight. Move to higher ground if you are near the river.'"),
    ]),
    # Demo carousel: one stimulus, two slides (depth + extent maps).
    ("st2", "Flood map", [
        ("images/prompts/fd_map.jpg", "Flood depth map: colour-coded water depth by area."),
        ("images/prompts/fe_map.jpg", "Flood extent map: which areas are expected to flood."),
    ]),
    ("st3", "Community radio notice", [
        ("images/prompts/radio.png",
         "A spoken radio announcement warning residents of rising water over the next 12 hours."),
    ]),
]

# Settings: scale config + the between-activity notice copy (editable by the team).
SETTINGS = [
    ("likert_points", 5, "Points on the scale. Must be odd (3, 5, or 7)."),
    ("anchor_low", "Not at all", "Label at the low end of the scale."),
    ("anchor_mid", "Partially", "Label at the midpoint of the scale."),
    ("anchor_high", "Very much", "Label at the high end of the scale."),
    ("notice_completion1_title", "Great work \u2013 session one is done!",
     "Shown after the questionnaire."),
    ("notice_completion1_body",
     "You can leave the app and move on to the group activity. We will reconnect back in the app later.",
     "Body for the completion-1 screen."),
    ("notice_welcome_title", "Welcome back!", "Shown when the host brings the room back."),
    ("notice_welcome_body",
     "Up next are examples of flood communication formats and channels. Review and score each one. "
     "The SPACE4ALL team will later tailor the project outputs based on your preferences. We will begin shortly \U0001f60a",
     "Body for the welcome-back screen."),
    ("notice_completion2_title", "Well done!", "Shown after the assessment section."),
    ("notice_completion2_body",
     "We will now move into our last activity of the day, where we will talk about your preferences "
     "and identify shared views within the group. Let's go!",
     "Body for the completion-2 screen."),
]

# Explicit flow order (interleaves choice + word prompts as the study runs).
ORDER = [
    "accra_tenure", "comm_tenure", "age", "gender", "education", "role",
    "flood_freq", "last_flood", "impacts",
    "info_recv", "info_source",
    "share_info", "when_use",
    "info_use",
]


def build_question_rows():
    choice_by_id = {c[0]: c for c in CHOICE}
    word_by_id = {w[0]: w for w in WORD}
    rows = []
    for qid in ORDER:
        if qid in choice_by_id:
            _id, prompt, choices, flags = choice_by_id[qid]
            head = {"id": qid, "section": flags.get("section"),
                    "type": "multiple_choice" if flags.get("multi") else "single_choice",
                    "prompt": prompt}
            if flags.get("profile"):   head["profile"] = "yes"
            if flags.get("review"):    head["review"] = "yes"
            if flags.get("has_other"): head["has_other"] = "yes"
            head["choice_text"] = choices[0]
            rows.append(head)
            for c in choices[1:]:
                rows.append({"id": qid, "choice_text": c})
        else:
            _id, prompt, section = word_by_id[qid]
            rows.append({"id": qid, "section": section, "type": "word_prompt",
                         "prompt": prompt, "max_words": 5, "min_words": 1, "max_chars": 30})
    return rows


def main():
    if not os.path.exists(XLSX):
        raise SystemExit(f"ERROR: {XLSX} not found.")
    backup = XLSX.replace(".xlsx", f".pre-merge-{time.strftime('%Y%m%d-%H%M%S')}.xlsx")
    shutil.copy2(XLSX, backup)
    print(f"Backed up original -> {os.path.relpath(backup, ROOT)}")

    stimuli_rows = []
    for (sid, title, slides) in STIMULI:
        for j, (img, cap) in enumerate(slides):
            row = {"id": sid, "image": img, "caption": cap}
            if j == 0:
                row["title"] = title
            stimuli_rows.append(row)

    rows_by_tab = {
        "settings": [{"key": k, "value": v, "notes": note} for (k, v, note) in SETTINGS],
        "questions": build_question_rows(),
        "stimuli": stimuli_rows,
        "wordcloud": [{"id": i, "section": "wordcloud", "prompt": pr,
                       "max_words": 5, "min_words": 1, "max_chars": 30} for (i, pr) in WORDCLOUD],
    }
    build_workbook(rows_by_tab, XLSX)

    nprofile = sum(1 for c in CHOICE if c[3].get("profile"))
    nslides = sum(len(sl) for (_, _, sl) in STIMULI)
    print(f"Authored {os.path.relpath(XLSX, ROOT)}:")
    print(f"  questions : {len(ORDER)} questions ({len(WORD)} word prompts, {nprofile} profile)")
    print(f"  wordcloud : {len(WORDCLOUD)} prompts | stimuli: {len(STIMULI)} ({nslides} slides) | settings: {len(SETTINGS)} keys")
    print("Dropped tabs: registration, discussion, likert_stimuli.")
    print("Next: python tools/build_content.py")


if __name__ == "__main__":
    main()
