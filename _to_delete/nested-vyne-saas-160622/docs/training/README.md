# VYNE™ training material

Three narration scripts and 120 screenshots captured from the running product.
Intended to be fed to NotebookLM (or a human narrator) to produce training videos.

## What is here

| File | Audience | Length | Scenes |
|---|---|---|---|
| `01-consultant-training-script.md` | A consultant at your firm, new to VYNE | ~35–40 min | 8 modules, 96 scenes |
| `02-interviewee-training-script.md` | A client executive who has been invited to an interview | ~4–5 min | 8 scenes |
| `03-buyer-overview-script.md` | A principal at a firm evaluating VYNE | ~8–10 min | 12 scenes |
| `shots/` | — | — | 120 PNGs, 2× retina |
| `contact-sheet.png` | — | — | every shot as a thumbnail, for picking |
| `manifest.json` | — | — | one entry per shot: id, page, title, note, audience |

Every screenshot referenced in a script exists in `shots/`, and every shot in
`shots/` is referenced by at least one script. That is checked, not assumed.

## Feeding this to NotebookLM

NotebookLM's Video Overview produces an **AI-narrated slide-style video**, not a
screen recording. It takes the sources you give it and builds its own visuals
and voice track. So:

1. Upload the script you want (one at a time — do not mix audiences in one
   notebook, the output blurs).
2. Upload the screenshots it references. NotebookLM will use them as slides.
3. In the Video Overview prompt, tell it to follow the scene order and to show
   the screenshot named in each scene while reading that scene's narration.

If you want an actual screen recording with your own voice, the scripts work
unchanged — read the narration, show the screenshot named above it. The
`On screen` line is the caption to burn in.

## The screenshots are of an invented client

Every image was captured from the real, running frontend against a seeded stub
backend. The client is **Northwind Freight Group**, a fictional logistics
operator, with a second fictional client (Harbourline Health) present so the
client-picker screens have something to pick between. Names, numbers, findings
and quotes are all invented, and internally consistent, so the walkthrough
holds together as one engagement from first screen to last.

This is deliberate. These are real screens, and a real client's material must
not leave the building in a training video.

## Regenerating the screenshots

The harness lives in `frontend/test/training/`:

```
node frontend/test/training/shoot.mjs              # all 120
node frontend/test/training/shoot.mjs roadmap.html # one page
SHOT_PORT=8901 node frontend/test/training/shoot.mjs 04-   # a parallel run
```

- `harness.mjs` — the stub backend, the browser, the runner
- `fixture.mjs` — the invented world (engagements, briefing, synthesis, interviews)
- `shots.*.mjs` — one shot-list file per group; add a group by adding a file
- Output goes to `docs/training/shots/` and rewrites `manifest.json`

Requires `playwright` and a Chromium. It rebuilds every shot from scratch, so
re-running after a UI change is how these stay current.

To add a screen: add an entry to the relevant `shots.*.mjs`, run the harness
filtered to its id, **look at the PNG**, and only then write its `note`. A shot
that captures without erroring but shows an empty panel is the failure mode to
watch for, and the runner cannot detect it.

## Known limits

Some states cannot be reached against a stub backend and are deliberately absent
rather than faked. Each shot-list file ends with a `// CANNOT REACH:` block
explaining its own omissions. The main ones:

- **A live voice interview** — needs a real microphone and a real Gemini
  realtime socket. The live interview screens are shown with a seeded
  conversation instead.
- **Native browser dialogs** (`prompt`, `confirm`) — cannot be photographed.
- **Generated content whose schema the single stub LLM response does not
  match** — those screens are reached by writing the object the product itself
  stores and calling the product's own render function, so the pixels are real
  and only the content is invented.
- **Popup print windows** — the harness screenshots the main page only.
