# VYNE — Consultant's Guide

_v5.32.74_

VYNE runs an AI Readiness Diagnostic end to end: you brief an engagement,
interview stakeholders, get a scored maturity picture, verify it, choose the use
cases worth doing, and produce a client-ready roadmap and deck.

This guide follows that order, because the product does. Each stage feeds the
next, and skipping one leaves the next one guessing.

---

## Before you start

**Sign in** at the firm URL with your email and password, plus your authenticator
code if your firm requires MFA. Your session lasts twelve hours, or thirty
minutes idle.

**Your work saves itself.** There is no Save button. The pill at the top right
tells you the truth: *Saving*, *Saved*, or *Not saved — retrying*. If it says
retrying, it genuinely is; leave the tab open until it clears. If you ever see a
console warning about state never having loaded, reload the page before doing
more work rather than typing into a page that cannot save.

**One client at a time.** Every module works on the engagement currently loaded.
The client name is shown at the top of each page. If it is not the client you
think you are working on, stop and load the right one.

---

## 1. Pre-Engagement — the briefing

Open **Pre-Engagement** and enter the client name and what they actually do. Be
specific: "Regional Hair Salon Chain" produces a far better diagnostic than
"Services". The industry you type here drives the use-case catalog, the
benchmarks, and the interview questions.

Generate the briefing. You get the client context, the industry's AI landscape,
sector benchmarks per dimension, and a set of hypotheses to test in interviews.

**The benchmarks are estimates.** They are hand-authored per sector or
model-estimated — never measured. They are shown with an "estimate" badge
everywhere they appear, and they are there to calibrate your judgement, not to
substitute for it.

Review the hypotheses before you interview. They shape what gets asked.

---

## 2. Interviews

Open **Interviews** and invite stakeholders by name, role and email. Each gets a
private link.

**What they see is deliberately less than what you see.** Interviewees get a
sanitized slice of the briefing: no political-sensitivity flags, no field
observations, no private-equity context. In follow-up rounds they cannot see what
earlier rounds concluded about them — otherwise you are interviewing someone who
has read their own report.

You can run an interview yourself in the live agent, or send the link and let
them complete it in their own time.

**Rounds.** A diagnostic can have several. Later rounds carry a focused agenda
built from what the earlier ones left open.

### Reading a transcript

Open any completed interview and you get the words exchanged — and beside them,
the reasoning. The score journal shows every point where a dimension actually
*moved*, anchored to the exchange that moved it, and the findings recorded
against the answer that produced them.

Only movements are journalled, not restatements. The model reports all seven
dimensions after every turn; recording each of those would bury four real
movements under three hundred repetitions.

An empty panel on an older interview means the trail predates the feature, not
that nothing was found. The two are shown differently.

---

## 3. Maturity Targets — verify before you build

This is the first tab of the AI Roadmap Builder, and it opens there on purpose:
everything downstream rests on these scores being right.

Seven dimensions, each scored 1.0–5.0 to one decimal. Each row shows the current
score, whether it was **measured** in interviews or is still the **placeholder**,
your target, and the sector benchmarks.

Targets default to the industry best from pre-engagement. Type over any of them.

### Closing the gap

Generate the gap list for a dimension — or all of them at once — and you get the
specific capabilities standing between this client and 5.0. Each carries a weight
in score points, and a dimension's weights sum exactly to the distance from its
current score to 5.0.

**There is no ladder and no prerequisite order.** A real organisation often runs a
mature model-risk committee while its data catalogue is a spreadsheet. Each item
stands alone.

Two controls, and they mean different things:

**We have this** — the interview missed it. This *corrects the measured score*,
and the correction flows everywhere the score goes: the sliders, the matrix, the
use-case readiness. Use it when you know something the interview did not surface.

**We would do this** — prospective. Moves a projection and nothing else.

Keeping those apart is the point. Conflating them either inflates a client's
assessed maturity from a wish, or buries a real gap in a hypothetical.

---

## 4. Use cases

**Use case matrix** shows the AI use cases for the client's industry, grouped by
business function, with impact and complexity you can override.

If the industry has no catalog yet, you are offered one. Generation takes a
minute or two and runs in two passes — the value chain first, then each function
in detail — so a wide industry is never quietly cut short. The catalog is saved
for your whole firm and reused for every future client in that segment.

Tick the use cases for this roadmap.

---

## 5. Gap analysis, requirements and stages

**Gap analysis** shows what your selected use cases require versus what the
client has, using the verified scores from step 3. Generate requirements for each
use case, then confirm them.

**Implementation stages** breaks each use case into stages with durations.
Confirm each.

Both confirmations are required before the roadmap unlocks. This is deliberate:
a roadmap built on unconfirmed requirements is a guess with a Gantt chart on it.
If the Roadmap tab bounces you back with a message, it is naming what is missing.

---

## 6. Roadmap & Synthesis

Once requirements and stages are confirmed, run **Synthesis**. You get the
narrative, the sequenced roadmap and the Gantt.

A brand-new engagement opens this tab **blank**, waiting for you to synthesize.
If you ever see content here before running synthesis, something is wrong —
report it.

**Export the deck** when you are satisfied. Internal and client-facing modes
differ in what they include; check the mode before sending anything outside your
firm.

---

## Things worth knowing

**Scores are measured to one decimal** because they come from a weighted average
over an interview. A number ending in .5 is not more real than one ending in .3.

**Anything estimated says so.** Benchmarks, gap weights and generated catalogs
all carry a badge. Weights are a model's judgement on the same scale the
interviews score on — not measurements.

**Regenerating a gap list clears its ticks.** The item identities change, so the
old ticks would credit the client for capabilities nobody assessed.

**If a catalog generates fewer use cases than you expected**, the toast says so
explicitly, including which functions failed. A quietly thinner catalog is the
one failure mode that release exists to remove.

---

## When something looks wrong

Report it rather than working around it, especially any of these:

- Content appearing under a client that belongs to a different client
- The save pill stuck on *Not saved* for more than a minute
- A score that changed without you changing anything
- An interviewee reporting they can see something they should not

The first and last are confidentiality matters and are worth an immediate call
rather than an email.
