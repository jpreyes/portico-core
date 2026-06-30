GUIDED EXAMPLES FOLDER — PORTICO
================================

Place the example models (.s3d) here, plus an index.json file that
describes them. They appear automatically in Help (F1) ->
"Guided Examples".

index.json format (a JSON list, one entry per example):

[
  {
    "file":        "simple_beam.s3d",
    "title":       "1. Simply supported beam",
    "description": "10 kN/m UDL over 6 m. Check M_mid = wL^2/8 = 45 kN.m.",
    "note":        "Toggle the element FBD and compare with the hand calc."
  },
  {
    "file":        "portal_2d.s3d",
    "title":       "2. Planar frame with lateral load",
    "description": "...",
    "note":        "..."
  }
]

Notes:
- "file" is the .s3d file name inside this same folder.
- "note" is optional: it shows as a teaching hint on the card.
- "title"/"description"/"note" are source strings translated by the
  i18n engine (Spanish source -> English in the dictionary), so the
  list is bilingual.
- Models are created in the app itself: model it and use File -> Save.
