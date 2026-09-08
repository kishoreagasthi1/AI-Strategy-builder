# VYNE™ — Consultant Training Script

**Audience:** a consultant at your firm who has never opened VYNE.
**Length:** roughly 35–40 minutes of narration across eight modules.
**Purpose:** to hand to NotebookLM (or a human narrator) together with the `shots/` folder, to produce the consultant training video.

---

## How to use this document

Every scene has four parts:

- **Screenshot** — the file in `shots/` to show while the narration runs.
- **On screen** — the one-line caption to burn in, if your tool supports captions.
- **Narration** — the words. Written to be spoken, not read.
- **Note to producer** — only where something needs care. Skip these in the video.

The scenes are numbered in the order the engagement actually runs, and the screenshot filenames carry the same numbers. Module boundaries are natural chapter breaks.

**About the screenshots.** Every image was captured from the running product, not mocked up. The client is invented — *Northwind Freight Group*, a logistics operator — because these are real screens and a real client's material must not leave the building in a training video. The numbers, names and findings you will see are all fictional, and internally consistent, so the walkthrough holds together as one engagement from first screen to last.

---

# Module 0 — Getting oriented

### Scene 0.1 — Signing in

**Screenshot:** `shots/00-01-signin.png`
**On screen:** Sign in with your firm account

**Narration:**
This is where every session starts. You sign in with your firm account — the same credentials your firm administrator set up for you. There is no separate client login for you to manage and no API key to paste anywhere. All the AI work happens on the server, metered to your firm, which is a point worth remembering when a client's security team asks where their data goes.

---

### Scene 0.2 — Choosing a client engagement

**Screenshot:** `shots/00-02-choose-client.png`
**On screen:** One session works on one client

**Narration:**
The first thing VYNE asks you is which client you are working on. This matters more than it looks. A session works on one client at a time — that choice sits in the left-hand rail on every screen from now on, and everything you generate, save or export belongs to that client. If you switch clients halfway through an afternoon, use "switch client" in the rail rather than opening a second tab, so you always know which engagement you are actually looking at.

There is an "All clients" option there as well. That is the administrator's view for looking across the portfolio. It is not the mode you work in.

---

### Scene 0.3 — The Hub

**Screenshot:** `shots/00-03-hub.png`
**On screen:** The Hub — every stage of the engagement

**Narration:**
This is the Hub, and it is the map for the whole product. The tiles are numbered in the order an engagement actually runs: pre-engagement briefing first, then the interview agent and the interview tracker, then synthesis, then the roadmap builder, then the solution design studio. The left rail is the same list, and it follows you onto every screen.

The order is not a suggestion. Each module reads what the one before it wrote. The roadmap is computed from the scores synthesis produced, synthesis is computed from what the interviews captured, and the interviews are tuned from the briefing you are about to build. Skip a step and the one after it has less to work with — it will still run, it will just be running on less.

**Note to producer:** hold this shot for a beat longer than the others. It is the mental model the rest of the video hangs off.

---

# Module 1 — The pre-engagement briefing

*This is the module that determines the quality of everything downstream. It is also the one people are most tempted to rush.*

### Scene 1.1 — Starting a new engagement

**Screenshot:** `shots/01-01-setup-new-client.png`
**On screen:** Client, industry, revenue band

**Narration:**
A new engagement starts here. Three fields decide a surprising amount: the client name, the industry, and the revenue band. Between them they select which benchmark set the diagnostic scores are compared against and which hypothesis library the system draws from. Get them wrong and everything below is measured against the wrong sector.

Industry is free text on purpose. Describe the business the client is actually in — "third-party logistics, contract freight" — rather than reaching for the nearest tick-box. If the client straddles two sectors, say so; the catalogs resolve each part separately and combine them.

---

### Scene 1.2 — The stated problem, and the engagement code

**Screenshot:** `shots/01-02-setup-filled.png`
**On screen:** What the client says the problem is — in their words

**Narration:**
The stated problem goes in verbatim. Not your summary of it — their words. That sentence is the claim the diagnostic is going to test, and half the value you deliver comes from being able to show, six weeks later, exactly how what they said at the start differs from what the evidence found.

Underneath the name you will see the engagement code. That is the identifier every other module joins on. And this is the important part: if the client changes its name, or you typed it wrong, use **Rename Client** and nothing else. Rename Client moves the engagement, the interviews, the synthesis and the roadmap together. Typing a new name into the box creates a second, empty engagement and quietly strands the first one.

---

### Scene 1.3 — Round mode, for a client you have assessed before

**Screenshot:** `shots/01-03-round-mode.png`
**On screen:** A repeat diagnostic reuses what has not changed

**Narration:**
This panel only appears when the client already has an engagement on file. The table is the prior rounds and the scores they produced. The grid underneath is the scope for this round: deselecting a dimension is you saying "nothing has changed here, do not spend interview time re-asking it."

That is what keeps a second-round diagnostic to forty minutes rather than ninety. It is also what makes the comparison you show the client honest — you are only re-measuring what you deliberately chose to re-measure.

---

### Scene 1.4 — Industry benchmarks

**Screenshot:** `shots/01-10-benchmarks.png`
**On screen:** Is a 2.4 actually bad?

**Narration:**
Here is where the sector sits on each of the seven dimensions for this industry and revenue band — the laggard, the average, and best in class. This is the panel you use to answer the question every CEO asks, which is "is a 2.4 bad?" On its own a 2.4 means nothing. Against a sector average of 2.9 and a best in class of 4.1, it means something specific.

Read the basis line underneath before you quote any of it in front of a client. It tells you whether these are a real, well-documented sector baseline or an estimate from the nearest comparable sectors. Both are useful. Only one of them survives being challenged.

---

### Scene 1.5 — Working hypotheses

**Screenshot:** `shots/01-11-hypotheses-generated.png`
**On screen:** Starting positions, not findings

**Narration:**
Hypotheses come from the industry pattern library combined with the context you typed above. Read them as starting positions — the things a firm like this usually turns out to be true of. They are not findings, and the whole point of the interviews is to confirm or kill them.

The discipline this enforces is worth naming. A hypothesis you wrote down and then disproved is a genuinely valuable thing to show a client. A hypothesis nobody ever tested is worse than one you never wrote down, because it sits in the deck looking like evidence.

---

### Scene 1.6 — Marking hypotheses as evidence arrives

**Screenshot:** `shots/01-12-hypotheses-marked.png`
**On screen:** Confirmed, rejected, unresolved — with the evidence

**Narration:**
As the interviews come in you come back here and mark each one. Confirmed, rejected, or still unresolved — and write down what convinced you. That note is the evidence line you will be asked for in the readout, and it is far easier to write on the day than to reconstruct three weeks later.

Synthesis reads these statuses back. When it works out which hypotheses the round actually settled, this is what it is reading.

---

### Scene 1.7 — Your own hypotheses

**Screenshot:** `shots/01-13-hypothesis-custom.png`
**On screen:** Add what the library did not think of

**Narration:**
Anything you believe about this client that the library did not anticipate goes in here. From the moment you write it, a custom hypothesis is treated exactly like a generated one — it gets tested, marked, and read back by synthesis in the same way. There is no second-class tier for the things you brought to the engagement yourself.

---

### Scene 1.8 — The issue tree

**Screenshot:** `shots/01-20-issue-tree.png`
**On screen:** Every question, under the dimension it belongs to

**Narration:**
This is the coverage check. Every diagnostic question, grouped under the dimension it belongs to. Two rules follow from it, and they are the reason the tree exists: a question that does not trace to a dimension does not get asked, and a dimension with no questions under it is a hole in your diagnostic.

Scan it before the first interview. It takes two minutes and it is the cheapest quality control in the module.

---

### Scene 1.9 — Context documents

**Screenshot:** `shots/01-30-context-docs-empty.png`
**On screen:** Documents attach to the engagement, not to a person

**Narration:**
Documents attach to the engagement, not to whoever handed them over, and they are tagged by the dimensions they inform. That is a deliberate design: if the CFO gives you the operating plan, every interview that covers strategy and finance sees it, not just the CFO's.

---

### Scene 1.10 — Attached, summarised and tagged

**Screenshot:** `shots/01-31-context-docs-attached.png`
**On screen:** Read once, reduced to analyst notes

**Narration:**
Each document is read once and reduced to analyst notes, and the chips on the card decide which interviews see it. Watch those chips. A document with no chips reaches nobody — the card says so plainly rather than sitting there looking attached and doing nothing, but it is easy to skim past.

---

### Scene 1.11 — Renaming a document

**Screenshot:** `shots/01-32-context-doc-rename.png`
**On screen:** Display name only — the original is kept

**Narration:**
The filename a client emails you is rarely the name you want to read for the next six weeks. Rename it to something you will recognise. The rename is display only: the original filename stays in brackets, so the document can always be traced back to exactly what they sent you.

---

### Scene 1.12 — What to ask the client for

**Screenshot:** `shots/01-33-doc-suggestions.png`
**On screen:** The data request, by dimension

**Narration:**
This is the checklist behind your data request. Work down it before the first interview goes in the diary. Every document you get up front is a question you do not have to spend expensive interview time on — and executives notice when you arrive already knowing what their operating plan says.

---

### Scene 1.13 — Field observations

**Screenshot:** `shots/01-40-observations.png`
**On screen:** What you saw, versus what you were told

**Narration:**
The observation log is for what you saw, as distinct from what you were told. These are the entries that settle an argument three weeks later, so record the specific thing — which screen was open, what was on the clipboard by the door, how many times somebody re-keyed the same number — rather than the conclusion you drew from it. The conclusion can change. The observation cannot.

---

### Scene 1.14 — Political sensitivity flags

**Screenshot:** `shots/01-50-political-flags.png`
**On screen:** Patterns to listen for — not conclusions

**Narration:**
These are patterns to listen for during the interviews. Somebody hedging on a question they should be able to answer flat; somebody deflecting to another function; two people describing the same event incompatibly. The flags are prompts to probe. The judgement about what a hedge actually means stays with you, and it should.

---

### Scene 1.15 — Roles and dimension depth

**Screenshot:** `shots/01-60-roles.png`
**On screen:** The stakeholder map that drives everything

**Narration:**
This is the stakeholder map for the engagement, and it deserves more care than it looks like it needs. Ticking a role puts it in scope. The Lead, Cover and Light chips beside it say how deep that role is questioned on each dimension.

This one list drives every interview the agent runs and the coverage analysis you will see in synthesis. If a role is missing here, it is missing everywhere downstream — it will not appear in the invite screen and synthesis will not notice its absence.

---

### Scene 1.16 — Tuning one role's depth

**Screenshot:** `shots/01-61-role-dimension-tiers.png`
**On screen:** Lead / Cover / Light / Off

**Narration:**
Four settings per dimension. Lead means this person is the authority — question them properly. Cover means ask, but do not dwell. Light means one question for completeness. Off means do not ask at all.

Turning things off is how a sixty-minute interview stays sixty minutes. A CFO does not need five questions on data lineage, and asking them anyway costs you the goodwill you will want later for the questions that matter.

---

### Scene 1.17 — Renaming a role

**Screenshot:** `shots/01-62-role-rename.png`
**On screen:** Use the client's own job titles

**Narration:**
Use the client's own titles. People answer to the title they actually hold — "Depot Network Director" lands differently from "COO / VP Operations" when you are sitting in front of one. The rename is cosmetic by design: the underlying key does not move, so scoring and role weighting are completely unaffected by what you call it.

---

### Scene 1.18 — Adding a custom role

**Screenshot:** `shots/01-63-custom-role-form.png`
**On screen:** For titles that exist only at this client

**Narration:**
For titles that only exist at this client. Tick the dimensions this person is the priority voice on, and in every other respect the role behaves like a standard one from that point.

---

### Scene 1.19 — The custom role in the list

**Screenshot:** `shots/01-64-custom-role-added.png`
**On screen:** Custom roles can be deleted; standard roles are unticked

**Narration:**
It joins the same list, marked as custom and removable. Note the asymmetry: only custom roles can actually be deleted. A standard role is unticked instead, which means nothing is lost if you change your mind halfway through the engagement and want it back.

---

### Scene 1.20 — The complete briefing

**Screenshot:** `shots/01-70-briefing-full.png`
**On screen:** Finish this before anyone is invited

**Narration:**
Here is the whole pre-engagement pack in one page, in the order it is meant to be worked: details, benchmarks, hypotheses, issue tree, documents, observations, political flags, roles.

Finish this before you invite anybody. It is what every interview is tuned from — the roles, the depth, the documents, the hypotheses being tested. An interview run against a half-built briefing is a generic interview, and you will feel it in synthesis.

---

### Scene 1.21 — Exporting the pack

**Screenshot:** `shots/01-71-export.png`
**On screen:** JSON to reload, print to hand round

**Narration:**
Two exports. The JSON pack is the portable copy — it loads straight back into this page and brings the roles, hypotheses and document summaries with it, which is how you clone a briefing for a similar client or hand one to a colleague. Print is the version you take into a room.

---

# Module 2 — Inviting the client's people

### Scene 2.1 — The interview tracker

**Screenshot:** `shots/02-01-tracker-full.png`
**On screen:** The roster, in one page

**Narration:**
This is the screen you live on between finishing the briefing and opening synthesis. One page for the whole roster: who on your side has access to this client, who on the client side has been invited, and where each interview has got to.

---

### Scene 2.2 — The interview list

**Screenshot:** `shots/02-02-interview-list.png`
**On screen:** Two people, one job title — kept apart

**Narration:**
Every interview, sortable and filterable. Look at the two VP Operations rows. One job title held by two people is an ordinary situation in any company with regions or business units, and the product keeps them apart as separate voices the whole way through — separate interviews, separate scores, separate findings, right into synthesis.

That matters because the most useful thing you will find at Northwind is that those two people disagree. Average them together and the finding disappears.

---

### Scene 2.3 — Filters

**Screenshot:** `shots/02-03-list-filters.png`
**On screen:** Filters persist between visits

**Narration:**
Filters persist between visits, which is why the bar above the table always tells you which ones are on and gives you one click to clear them. The filter you will use most is "invited" — that is your list of people who have been asked and have not yet turned up.

---

### Scene 2.4 — Editing an interview

**Screenshot:** `shots/02-04-row-editor.png`
**On screen:** Pick the client — never type it

**Narration:**
Client and role are picked from a list here, never typed. A typed client name would silently detach the interview from its engagement, which is exactly the kind of error you would not find until synthesis came up short.

Use this to move a misfiled interview, pin one to a round, or correct the interviewer name, voice or depth. Depth is worth knowing about here: diaries change after an invite goes out, and this is where you shorten a Deep Dive to a Quick Screen when the CFO's ninety minutes becomes thirty. It is editable only while the interview is still *invited* — once they have started, the control shows you what they are running to but will not let you move it, because the agent read its budget when the session opened.

One thing you cannot change at all is the login. If that is wrong, delete the invite and issue a new one.

---

### Scene 2.5 — Inviting an interviewee

**Screenshot:** `shots/02-05-invite.png`
**On screen:** The invite creates their login and their interview

**Narration:**
An invite does two things at once: it creates that person's login, and it prepares an interview already tuned to their role for this client. The role list you see here is the stakeholder map from the briefing — if a role is missing here, go back to pre-engagement, because that is where it is missing from.

The interviewer name and voice on the second row are your firm's choice. They travel with the invite, and they are remembered as the default for the next one, so your interviews sound consistent across an engagement.

Underneath them is **depth**, and it is the field with the most consequence on this screen. Deep Dive is forty to fifty questions, Standard is twenty-eight to thirty-five, Quick Screen is twenty to twenty-five — which in practice is the difference between ninety minutes of a CFO's morning and twenty. It defaults to Deep Dive. Set it from what you have actually been given: if the invite says ninety minutes and their diary says thirty, the diary wins, and you should say so here rather than hope the conversation ends early.

---

### Scene 2.6 — The invite is created

**Screenshot:** `shots/02-06-invite-created.png`
**On screen:** Nothing is sent — that stays with you

**Narration:**
The confirmation carries the login hint for that interviewee. Note what does not happen: nothing is emailed from here. Sending stays with you, deliberately, because the relationship with that executive is yours and the covering note should sound like you.

---

### Scene 2.7 — Client access

**Screenshot:** `shots/02-07-access-panel.png`
**On screen:** Scoped consultants see only their clients

**Narration:**
Consultants see only the clients you assign to them, and that is enforced on the server rather than by hiding things in the page. If you are running a mixed team, or a subcontractor, this is where you scope them.

The delete at the bottom removes a client and everything attached to them — briefing, interviews, synthesis, roadmap. There is no undo. Take an export first; we will come to where that lives in the synthesis module.

---

### Scene 2.8 — Synthetic practice data

**Screenshot:** `shots/02-08-synthetic.png`
**On screen:** Rehearse on a fake engagement built from this briefing

**Narration:**
This builds a complete fake engagement from this client's own briefing — its roles, its industry, its hypotheses — with contradictions and a governance blind spot deliberately seeded in. It exists so you can rehearse synthesis and the roadmap before any real interviews land, and so a new consultant can learn the product on something that behaves like real data.

It is appended alongside the real interviews and marked as synthetic throughout. It never mixes into them, and it can be removed without touching anything real.

---

### Scene 2.9 — Reviewing a follow-up agenda

**Screenshot:** `shots/02-09-agenda-review.png`
**On screen:** The grey block is for you, not for them

**Narration:**
A follow-up interview is drafted from what other people said. That makes review mandatory rather than optional, and nothing reaches the interviewee until you have read it.

The grey block under each topic is the material the topic was drawn from. That is for you only. The interviewee sees the topic text and nothing else — they will never be shown a colleague's answer.

At the bottom is the depth for this follow-up. It arrives set to whatever you gave this person in the first round, and the line beside it tells you how long *this* agenda will actually run — not a generic range, but the number of questions these topics produce, updating as you add and remove them. A follow-up is short because it is narrow, so three topics is a short conversation at any depth; what depth moves is how hard each topic gets pushed. Set it here, while you have just read the agenda and know how much is riding on it.

---

# Module 3 — Running the interviews

### Scene 3.1 — The setup screen

**Screenshot:** `shots/03-01-setup-consultant.png`
**On screen:** Most of this is already decided

**Narration:**
This is where an interview is configured, and most of it is already done. The client comes from your session; the role list comes from the briefing. The only decisions left in front of you are who is being interviewed and how deep to go.

---

### Scene 3.2 — The per-person fields

**Screenshot:** `shots/03-02-per-person-fields.png`
**On screen:** The name is the field people skip

**Narration:**
Role and name are both required, and the name is the one people skip. Here is why it matters: two people can hold the same role. Northwind has two VP Operations. Without the name, the second interview overwrites the first instead of sitting beside it, and you lose a voice without being told you lost it.

Fill in the name. Every time.

---

### Scene 3.3 — Depth

**Screenshot:** `shots/03-03-depth-selector.png`
**On screen:** Quick Screen 25 · Standard 35 · Deep Dive 50

**Narration:**
Depth sets the question budget the agent works to — twenty-five questions for a quick screen, thirty-five for standard, fifty for a deep dive. In practice this is the choice that decides whether an executive is in the chair for twenty minutes or ninety, so make it with their diary in mind, not your curiosity.

One thing to be clear about, because it catches people out. This control governs interviews **you** run in your own tab, with the interviewee in the room. For an executive you *invited*, depth comes from the invite — you set it on the Interview Tracker, alongside the interviewer name and voice, and it travels to their session. Setting it here does not reach them. If you have already sent an invite and want to change how long it runs, the row editor on the tracker is the place.

**Note to producer:** this is a common misunderstanding. A caption contrasting "here — interviews you run" with "the tracker — interviews you send" is worth the two seconds.

---

### Scene 3.4 — The preview sheet

**Screenshot:** `shots/03-04-preview-control.png`
**On screen:** Optional — worth it for senior people

**Narration:**
Optional, and worth doing for senior people. One AI call produces a courtesy sheet you can send ahead of the session. Adding prep notes tells them what would be useful to have to hand.

---

### Scene 3.5 — What they receive

**Screenshot:** `shots/03-05-preview-sheet.png`
**On screen:** Areas and illustrative questions

**Narration:**
This is what lands in their inbox: the areas to be covered and some illustrative questions, labelled plainly as illustrative — because the live conversation follows their answers rather than a script. Print it to PDF and send it with your own note.

---

### Scene 3.6 — The three modes

**Screenshot:** `shots/03-06-mode-toggle.png`
**On screen:** New · Refresh · Mandatory questions

**Narration:**
Three modes on one card. **New Interview** runs a first conversation. **Refresh** runs a focused second one against an agenda synthesis generated when you closed the round. **Mandatory Questions** is where you author the questions that must be asked, whatever else comes up.

The gold line underneath only appears once a round has been closed for the client currently in the box. That is your signal that a refresh is available.

---

### Scene 3.7 — Mandatory questions

**Screenshot:** `shots/03-07-mandatory-questions.png`
**On screen:** Assigned per role — tracked per person

**Narration:**
These are questions the agent must ask. You assign them per role, and — this is the part worth understanding — they are tracked per person. The green chip means that role has been answered and tells you by whom. If two people hold the role, one answering does not silence the question for the other.

An interview cannot be finished while a mandatory question assigned to that person is still unasked.

---

### Scene 3.8 — Refresh setup

**Screenshot:** `shots/03-08-refresh-setup.png`
**On screen:** Nothing to configure — the agenda decides

**Narration:**
A second-round interview. You pick the engagement and the person from what synthesis produced when the round closed, and that is all there is to do. There is nothing to configure because the agenda decides the scope.

---

### Scene 3.9 — The agenda for one person

**Screenshot:** `shots/03-09-refresh-agenda.png`
**On screen:** Read this before you walk in

**Narration:**
Read this before the session. Every line came out of the round that closed: a contradiction between two people, a hypothesis nobody settled, a blind spot, or something you added by hand. Only the dimensions on this agenda can be re-scored — a refresh is a targeted instrument, not a repeat of the first interview.

---

### Scene 3.10 — The live interview

**Screenshot:** `shots/03-10-live-consultant.png`
**On screen:** Conversation left, score forming right

**Narration:**
This is the agent running in your own tab, with the interviewee in the room with you. Conversation on the left, the score forming on the right as they talk.

Two controls, top right: Pause and Finish & Export. And notice the left rail is still the full module navigation — because this is your session, on your machine. Hold that thought; it is going to be different in a moment.

---

### Scene 3.11 — The transcript

**Screenshot:** `shots/03-11-live-transcript.png`
**On screen:** "Clarify this answer" corrects without overwriting

**Narration:**
Every turn as it happens. Answers can be spoken or typed — some executives will talk, some will want to type, and both work.

"Clarify this answer" under any of the interviewee's turns sends a correction that the agent folds into its scoring. It does not overwrite what they said. The original answer and the clarification both stay in the record, which is what you want when somebody misspoke and then corrected themselves.

---

### Scene 3.12 — The scorecard forming

**Screenshot:** `shots/03-12-live-scorecard.png`
**On screen:** Sector average and best-in-class, marked live

**Narration:**
Scores move as the conversation goes, with the industry average and best in class marked on each bar from the briefing benchmarks. A dimension nobody has touched yet stays "Not yet assessed" rather than defaulting to a number — which means an unfinished interview looks unfinished instead of looking like a low score.

---

### Scene 3.13 — Findings

**Screenshot:** `shots/03-13-live-findings.png`
**On screen:** The evidence behind each score

**Narration:**
The evidence line behind each score, tagged to its dimension and captured at the moment it was said. These are what synthesis later clusters into confirmed findings and contradictions, so the quality of what you see here is the quality of what you get there.

---

### Scene 3.14 — Your two controls

**Screenshot:** `shots/03-14-header-controls.png`
**On screen:** Finish & Export is not "submit"

**Narration:**
Save state, elapsed time, Pause, and Finish & Export.

Pause stops the clock and the microphone. Finish & Export writes the interview into the engagement and opens the export screen. Be clear about what it does not do: it does not tell the server the interview has been submitted. Only the interviewee's own Finish button does that, and you will see it in the next scene.

**Note to producer:** this distinction confuses people. Consider a caption card here.

---

### Scene 3.15 — Pausing

**Screenshot:** `shots/03-15-paused-consultant.png`
**On screen:** Clock stopped, mic off, session saved

**Narration:**
Paused. The clock stops, the microphone stops, Send is disabled and the session is saved. Use it for a break or an interruption — resuming picks up in the same conversation with the same context.

---

# Module 4 — What the interviewee sees

*Show this module to your consultants too. They will be asked what the experience is like before they are allowed to send the first invite.*

### Scene 4.1 — Signing in as an interviewee

**Screenshot:** `shots/03-20-interviewee-welcome.png`
**On screen:** One panel, one button

**Narration:**
This is the same product, signed in as a client executive who received an invite. Everything you have just seen is gone. One panel: who you are, what this is, and a single button to begin. Nothing to configure and nothing to choose, because the invite already carries their name, their role and their client.

---

### Scene 4.2 — Previewing the topics

**Screenshot:** `shots/03-21-interviewee-topics.png`
**On screen:** Areas, not a question list

**Narration:**
They can preview the areas that will be covered. Areas, not an exact question list — partly because the interviewer adapts to their answers, and partly because a script invites rehearsed answers, which is not what anybody wants out of this.

---

### Scene 4.3 — The interviewee's live screen

**Screenshot:** `shots/03-22-interviewee-live.png`
**On screen:** Gold bar on top · one item in the rail

**Narration:**
The same conversation you saw a moment ago, with two differences that matter.

First, the gold bar across the top carrying Pause and Finish & Submit — controls the consultant's view does not have. Second, the left rail. It holds one item: their interview. There is no route from here into any other client's work, or into any other part of the platform. That is the answer to the question their IT department is going to ask you.

---

### Scene 4.4 — Their controls

**Screenshot:** `shots/03-23-interviewee-controls.png`
**On screen:** Pause is safe · Submit is final

**Narration:**
Answers save as they go, so Pause simply closes the session and they can come back to it. Finish & Submit is the one that ends it — it sends the interview to the consulting team, and nothing can be edited afterwards. Worth saying that out loud to them before they start, so nobody hits it at question ten.

---

### Scene 4.5 — Pausing

**Screenshot:** `shots/03-24-interviewee-paused.png`
**On screen:** Close the window — come back later

**Narration:**
They can close the window entirely. Signing in again offers "Continue where you left off" and resumes at the same point in the conversation, with everything they have already said intact.

---

### Scene 4.6 — Submitted

**Screenshot:** `shots/03-25-interviewee-submitted.png`
**On screen:** With the consulting team — nothing more to do

**Narration:**
Submitted. The interview is now with the consulting team and every control on the page is disabled. This is the point of no return the confirmation warned about, and there is no ambiguity on screen about whether it happened.

---

### Scene 4.7 — Back on your side: the export screen

**Screenshot:** `shots/03-30-export-screen.png`
**On screen:** Already written into the engagement

**Narration:**
Back on your side of the product. This is what a consultant-run interview ends on. The scores are already written into the engagement and archived — you do not have to do anything here for the interview to count. These buttons are for taking a copy out: the JSON for another system, the transcript for the file, the record file for recovery.

---

### Scene 4.8 — The exported record

**Screenshot:** `shots/03-31-export-json.png`
**On screen:** What synthesis actually reads

**Narration:**
The machine-readable form: dimension scores, findings, and the identifiers that tie it back to the engagement and the round. This is the shape synthesis reads, and it is worth knowing it exists the first time a client's data team asks whether they can have the raw output.

---

# Module 5 — Synthesis

*Five conversations become one argument. This is the module clients pay for.*

### Scene 5.1 — Before a client is loaded

**Screenshot:** `shots/04-01-synthesis-empty.png`
**On screen:** It reads what the interviews wrote

**Narration:**
Synthesis reads what the interviews wrote. Until a client is named it has nothing to read, which is why this screen starts empty rather than starting wrong.

---

### Scene 5.2 — The dashboard

**Screenshot:** `shots/04-02-synthesis-loaded.png`
**On screen:** Nothing here was typed by a consultant

**Narration:**
Five interviews on one page. Progress and coverage at the top, the score with its evidence in the middle, what to do about it at the bottom.

The thing to say to a client about this screen is that nothing on it was typed by a consultant. Every number is derived from the interviews, and every claim can be traced back to who said it. That is a different conversation from presenting a slide.

---

### Scene 5.3 — Overall progress

**Screenshot:** `shots/04-03-overall-progress.png`
**On screen:** Read the interview count first

**Narration:**
The headline number, and how much of the assessment stands behind it. Read the interview count before the score, always. An overall built on two conversations is not the same object as one built on six, and if you quote the first as though it were the second you will be found out.

---

### Scene 5.4 — Who has been interviewed

**Screenshot:** `shots/04-04-interview-tracker.png`
**On screen:** One row per person

**Narration:**
Who has been interviewed, against who was planned in the briefing, with each person's own average.

One row per person, not per role. Northwind's two VP Operations each get their own line and their own number — 2.3 and 3.0, which is a difference you would lose entirely if the panel merged them into one "operations" row. A role nobody has spoken to yet shows as a single Pending line, because there is no person to name.

---

### Scene 5.5 — Dimension scores

**Screenshot:** `shots/04-05-dimension-scores.png`
**On screen:** Weighted by whose view carries authority

**Narration:**
The seven dimensions, weighted by whose view carries most authority on each — a CTO's reading of the technology estate counts for more than the CFO's, and the reverse is true on the business case.

The chips under each bar are every interview that scored that dimension, highest in green, lowest in red. A lightning bolt on the title means the highest and lowest are a point and a half or more apart. Click any dimension and it will show you the arithmetic.

---

### Scene 5.6 — Coverage map

**Screenshot:** `shots/04-06-coverage-map.png`
**On screen:** One interview is an opinion, not a finding

**Narration:**
How many interviews have scored each dimension. The rule of thumb built into this panel is that anything resting on a single interview is one person's opinion rather than a finding — the target is two before you finalise the round. This is where you see which dimensions are short and go and fix it.

---

### Scene 5.7 — Confirmed findings

**Screenshot:** `shots/04-07-confirmed-findings.png`
**On screen:** Two people, independently, in different words

**Narration:**
Findings that more than one person raised independently. Corroboration is the entire test here. The CEO and the CTO describing the same month-end reconciliation in different words is worth far more than either of them saying it twice — and it is what lets you put the finding in front of a board without it becoming an argument about one person's opinion.

---

### Scene 5.8 — Contradictions

**Screenshot:** `shots/04-08-contradictions.png`
**On screen:** The most useful panel on the page

**Narration:**
Dimensions where the people you interviewed disagree by a point or more.

Do not treat these as errors to reconcile. They are the most useful thing on this page. A gap between what leadership believes and what operations experiences is very often the finding itself — and at Northwind, two regional operations leaders three points apart on the same process tells you more than either score does alone.

---

### Scene 5.9 — Unresolved gaps

**Screenshot:** `shots/04-09-unresolved-gaps.png`
**On screen:** Your confidence gap, as a list of people

**Narration:**
Per dimension, the roles with real authority on it that nobody has interviewed. This is your confidence gap, stated as a list of names to go and get.

Look at D6 here. It is the lowest score on the board, and it has been assessed without a General Counsel or a CDO in the room. That is a sentence you want to have said to the client before they say it to you.

---

### Scene 5.10 — Recommended focus

**Screenshot:** `shots/04-10-recommended-focus.png`
**On screen:** Who to interview next, and what to ask

**Narration:**
Who to interview next and what to ask them, derived from the thinnest coverage and the widest disagreement. Underneath is where you add your own focus item — anything you want carried into the next round. It merges into the refresh agenda when you close the round.

---

### Scene 5.11 — The AI synthesis

**Screenshot:** `shots/04-11-ai-synthesis.png`
**On screen:** Which hypotheses survived, and what follows

**Narration:**
The written argument across all the interviews: which hypotheses survived, what the client cannot see about itself, and what follows from that.

A previously generated synthesis is restored when you open the page, with the date it was made, so coming back to review does not silently cost another AI call. Regenerate deliberately, when there are new interviews to fold in.

---

### Scene 5.12 — How a score was calculated

**Screenshot:** `shots/04-12-drill-dimension.png`
**On screen:** The arithmetic, in front of the client

**Narration:**
Click any dimension and the weighted average is shown as arithmetic: every interview, its score, its weight, and the sum. This is the screen you open when a client asks why a number is what it is — and the ability to answer that in ten seconds, from the product, in front of them, is worth a great deal.

---

### Scene 5.13 — A contradiction, side by side

**Screenshot:** `shots/04-13-drill-contradiction.png`
**On screen:** Same title, same company, opposite experience

**Narration:**
The two ends of a disagreement, with what each person actually said underneath their score. Here are Northwind's two regional VP Operations, three points apart on shift handover. Same job title, same company, opposite experience of the same process — and the header names both of them, because "VP Operations disagrees with VP Operations" would tell you nothing.

That is not noise to be averaged away. That is the engagement.

---

### Scene 5.14 — Switching rounds

**Screenshot:** `shots/04-14-round-pills.png`
**On screen:** Always one round — never a blend

**Narration:**
Once a client has been assessed twice, the dashboard opens on the latest scored round and these pills switch the whole page between rounds. What you are looking at is always exactly one round, never a blend of them — which is the only way the comparison you are about to show means anything.

---

### Scene 5.15 — Round-over-round comparison

**Screenshot:** `shots/04-15-comparison-table.png`
**On screen:** What a retained client is paying for

**Narration:**
What actually changed between rounds, per dimension.

This table is the deliverable a retained client is paying for. A score on its own tells them where they are. Only the movement tells them whether the work is landing — and that is the difference between a diagnostic engagement and a relationship.

---

### Scene 5.16 — Editing the narrative

**Screenshot:** `shots/04-16-narrative-editor.png`
**On screen:** The model drafts — the consultant signs

**Narration:**
The narrative is generated and then edited by you. Saving marks it "Edited by consultant", and it is your edited text that goes into the client document.

The principle is worth stating explicitly to anyone nervous about AI in client work: the model drafts, the consultant signs. Nothing goes to a client under your firm's name that a person did not read and approve.

---

### Scene 5.17 — Closing the round

**Screenshot:** `shots/04-17-close-round-modal.png`
**On screen:** Turns findings into the next round's agenda

**Narration:**
Closing a round marks this synthesis final and converts the contradictions, unresolved hypotheses and blind spots into a per-person agenda for the next round — the agenda the Interview Agent's Refresh tab then runs.

Nothing is deleted by closing a round. It is a milestone, not a cleanup.

---

### Scene 5.18 — Snapshots and clearing

**Screenshot:** `shots/04-18-data-manager.png`
**On screen:** Export before anything irreversible

**Narration:**
Export Snapshot writes every stored key for the firm out to a JSON file. Load Snapshot reads one back.

Take one before anything irreversible — and note what is sitting right beside them. "Clear This Client" deletes the named client's briefing, interviews, synthesis and roadmap. Deliberate placement: the backup is next to the thing you would want a backup for.

---

### Scene 5.19 — Sending to the Roadmap Builder

**Screenshot:** `shots/04-19-send-to-roadmap.png`
**On screen:** Do it once the round is settled

**Narration:**
This is the handoff out of synthesis. It pushes the latest scored round and the sequenced recommendations across to the Roadmap Builder, and exports a snapshot on the way.

Do it once the round is settled. Pushing again overwrites what the roadmap is currently working from, and if a colleague has been building on it, that is their afternoon.

---

### Scene 5.20 — After clearing a client

**Screenshot:** `shots/04-20-clear-client.png`
**On screen:** Only the named client — and no undo

**Narration:**
This is what it looks like afterwards. The dashboard is gone and a count of deleted keys is all that remains.

Two things to hold onto. Only the client named in the box is affected — every other engagement in your firm is untouched. And there is no undo, which is exactly why the confirmation tells you to export a snapshot first.

---

# Module 6 — The Roadmap Builder

*Scores become a sequenced plan. Three gates stand between you and the roadmap, and each one is there for a reason.*

### Scene 6.1 — Maturity targets

**Screenshot:** `shots/05-01-targets-tab.png`
**On screen:** Check the scores before you build on them

**Narration:**
The Roadmap Builder opens on Maturity targets on purpose. Before anything is selected or sequenced, the seven scores that came out of the interviews get looked at — ideally with the client in the room.

Everything on the later tabs is computed from these numbers. An unchecked score becomes an unchecked plan.

---

### Scene 6.2 — What it would take to move a score

**Screenshot:** `shots/05-02-targets-gap-lists.png`
**On screen:** Two kinds of tick — and they differ

**Narration:**
Each dimension gets a flat list of the specific capabilities standing between the measured score and five out of five, each weighted in score points.

There are two different ticks here and the difference matters. "We already have this" corrects the measured score, because the interviews missed something real. "We would do this" only moves a projection. Correcting a score here flows through every other tab in the module.

---

### Scene 6.3 — The sliders in the rail

**Screenshot:** `shots/05-03-maturity-sliders.png`
**On screen:** Test "what if we are wrong about D1"

**Narration:**
The same seven scores as sliders, carried on every tab, with the sector average and best in class marked against each.

Drag one and the readiness percentages across the whole module move with it. That makes this a live sensitivity tool: "what does the plan look like if we are wrong about D1" is a question you can now answer in front of a client rather than promising to come back on.

---

### Scene 6.4 — The use case catalog

**Screenshot:** `shots/05-04-matrix-catalog.png`
**On screen:** Locked to this client's industry

**Narration:**
The use-case library for this client's industry, grouped by department, plus a cross-industry layer that applies to everyone.

The industry is locked to the engagement, so nobody can accidentally roadmap a logistics client against the healthcare catalog. The readiness figure on each card is this client's own scores measured against that use case's capability requirements.

---

### Scene 6.5 — Choosing what goes on the roadmap

**Screenshot:** `shots/05-05-matrix-selected.png`
**On screen:** The decision everything else hangs off

**Narration:**
Ticking a use case is the decision the whole rest of the module hangs off.

Watch the counts as you go — on each department, and the totals in the rail: how many are ready now, how many carry gaps. That is the conversation to have before the list gets any longer, because the instinct in a workshop is always to add one more.

---

### Scene 6.6 — Scoping inside an initiative

**Screenshot:** `shots/05-06-matrix-subcases.png`
**On screen:** Where a slogan becomes defined work

**Narration:**
A use case is not one thing. Expanding it shows the sub-use cases it is made of, each of which can be taken in or out of scope, with the data each one needs. You can add a client-specific one too.

This is where an initiative stops being a slogan and becomes defined work — and where you find out that "predictive maintenance" means four different things to four people in the room.

---

### Scene 6.7 — Filters

**Screenshot:** `shots/05-07-matrix-filters.png`
**On screen:** The shortlist arguments, pre-built

**Narration:**
The filters are the shortlist arguments you have to make anyway: quick wins, high impact, ready now, blocked on data, blocked on people.

Their real use is steering a workshop away from the initiative everybody likes and towards the one that can actually start in March.

---

### Scene 6.8 — One use case in detail

**Screenshot:** `shots/05-08-uc-detail.png`
**On screen:** Read it before you defend it

**Narration:**
Clicking a use-case name opens its briefing panel: what it actually is, the capabilities it delivers, industry-typical ROI framed as an estimate rather than as this client's number, the stages it usually runs in, the ways it usually fails, and a build-versus-buy view.

This is preparation, not a presentation. Read it before you defend the initiative in front of the client.

---

### Scene 6.9 — Implementation stages

**Screenshot:** `shots/05-09-stages-entered.png`
**On screen:** Entered is not confirmed

**Narration:**
Every selected use case needs an end-to-end target duration. Here the durations exist but nobody has confirmed them, so the bar reads zero per cent and the Roadmap tab is still greyed out.

Confirming is a separate, deliberate act — because the sequencing is only as good as the number somebody was willing to stand behind.

---

### Scene 6.10 — Durations and gates

**Screenshot:** `shots/05-10-stages-card.png`
**On screen:** End to end — not the sum of the stages

**Narration:**
Target completion is the figure the roadmap sequences on, and it is end to end, not the sum of the stages, because stages overlap.

Ticking "Gate" on a stage marks it as something that cannot be compressed or run in parallel. That is what makes the critical path honest rather than optimistic — and the critical path is the part of your plan a client's programme director will attack first.

---

### Scene 6.11 — All stages confirmed

**Screenshot:** `shots/05-11-stages-confirmed.png`
**On screen:** Editing a duration re-locks the tab

**Narration:**
Every card confirmed, the bar at a hundred per cent, and the Roadmap tab lights up.

Change any duration afterwards and that card re-opens for confirmation and the tab re-locks. The plan cannot quietly drift away from what was agreed without somebody re-agreeing it.

---

### Scene 6.12 — Gap analysis

**Screenshot:** `shots/05-12-gap-analysis.png`
**On screen:** The same gap blocks four initiatives

**Narration:**
For each selected use case, the capability areas where this client sits below what that use case needs.

Common gaps are pulled out at the top, and that is where the sequencing argument actually lives: the same missing capability usually blocks four initiatives at once, and fixing it once unlocks all four. That is a far better story than four separate business cases.

---

### Scene 6.13 — Correcting a gap

**Screenshot:** `shots/05-13-gap-card.png`
**On screen:** Scores are survey averages, not ground truth

**Narration:**
Interview scores are survey averages, not ground truth. The checklist here lets you tick off what the client demonstrably already has, and the readiness ring recalculates on the spot.

Without that correction, one low interview score permanently overstates the work — and you end up proposing to build something the client already owns.

---

### Scene 6.14 — Dependencies

**Screenshot:** `shots/05-14-dependencies.png`
**On screen:** "Not present" is the month-four failure

**Narration:**
Hard prerequisites, drawn from the built-in library rather than from a model call. Each one is either already on the roadmap, already in place at the client, or not present.

A "not present" prerequisite is the single most common reason a plausible-looking roadmap fails in month four. This tab exists so that you find it in month zero instead.

---

### Scene 6.15 — Gate 1

**Screenshot:** `shots/05-15-gate-1-nothing-selected.png`
**On screen:** No roadmap until something is on it

**Narration:**
Clicking Roadmap & Synthesis with nothing selected does not open it. It sends you to the Use case matrix and tells you why.

This is the first of three gates and the one every consultant meets on day one: there is no roadmap until somebody has decided what is on it.

---

### Scene 6.16 — Gate 2

**Screenshot:** `shots/05-16-gate-2-requirements.png`
**On screen:** A generic profile means an untrustworthy percentage

**Narration:**
The second gate. A use case with no industry-calibrated capability profile is running on a generic default, which means its readiness percentage is not trustworthy.

The tab stays shut and sends you to Gap analysis to generate and confirm requirements for the ones that need it. The product would rather be shut than show you a confident number it cannot stand behind.

---

### Scene 6.17 — Gate 3

**Screenshot:** `shots/05-17-gate-3-stages.png`
**On screen:** Selection · requirements · durations

**Narration:**
The third gate. Every selected use case has a valid profile, but no confirmed duration — so there is nothing to sequence. The message names how many are outstanding and which ones, and drops you on Implementation stages.

Three gates, always in that order: selection, requirements, durations. Once you know them, the greyed-out tab stops being mysterious.

---

### Scene 6.18 — The tab opens

**Screenshot:** `shots/05-18-roadmap-unlocked.png`
**On screen:** Before you spend a synthesis call

**Narration:**
With all three gates open, the tab renders. The impact-versus-complexity matrix is your selection plotted against itself.

Nothing has been generated yet and the deck export is still disabled. This is the state you want to be in before you spend a synthesis call — everything checked, everything confirmed, nothing generated on top of an assumption you have not looked at.

---

### Scene 6.19 — The synthesised roadmap

**Screenshot:** `shots/05-19-roadmap-synthesis.png`
**On screen:** Read the shared investments table first

**Narration:**
The synthesis is the argument, not the list. Quick wins, the critical path, the capability investments that unlock more than one initiative, the phases and what each one unlocks, and an executive narrative underneath.

Read the shared investments table first. That is where the sequencing case is actually made — one investment, four initiatives unlocked, is the sentence that gets a phase funded.

---

### Scene 6.20 — The 36-month Gantt

**Screenshot:** `shots/05-20-roadmap-gantt.png`
**On screen:** Draggable — in front of the client

**Narration:**
The same plan as a timeline, in workstreams, with dependency arrows and milestone diamonds, scrolling sideways across three years.

The bars are draggable and resizable, live, in front of the client. And confirmed dependencies are re-enforced after a drag — so when somebody in the room pulls an initiative forward, the sequencing cannot be quietly broken without the plan pushing back.

---

### Scene 6.21 — The AI Strategy Deck

**Screenshot:** `shots/05-21-deck-export.png`
**On screen:** Client-ready or internal — choose before exporting

**Narration:**
The deck export is enabled only once a synthesis exists. Two versions: client-ready, which carries no individual attribution, and internal, which keeps the per-person detail.

Choose before you export. This is the control that decides what leaves the building, and "the CFO said" is a sentence that reads very differently inside your firm than it does in a client boardroom.

---

# Module 7 — The Solution Design Studio

*Selected use cases become build-ready design briefs.*

### Scene 7.1 — The handoff

**Screenshot:** `shots/06-01-roadmap-handoff.png`
**On screen:** One catalog, two modules

**Narration:**
The Studio does not have its own use-case list. It reads whatever this client has selected in the Roadmap Builder, with the department, impact, value and diagnostic scores attached, and offers them in a banner.

One catalog, two modules. They cannot drift apart.

---

### Scene 7.2 — The portfolio

**Screenshot:** `shots/06-02-portfolio.png`
**On screen:** Yours after the first import

**Narration:**
On first open the portfolio is the roadmap selection. After that it belongs to you: new roadmap selections are offered rather than merged in behind your back, and something you removed is never quietly restored.

Each use case carries its own intake, pattern and brief, and is worked in turn.

---

### Scene 7.3 — The design intake

**Screenshot:** `shots/06-03-intake.png`
**On screen:** Five questions — the routing is deterministic

**Narration:**
Five questions. What follows from them is fully deterministic — no model decides the architecture pattern; the answers do.

Which means these five are worth arguing about with the client rather than guessing at, because everything downstream inherits them.

---

### Scene 7.4 — The recommended pattern

**Screenshot:** `shots/06-04-pattern-proposal.png`
**On screen:** It shows its working

**Narration:**
The routing shows its working: each line is the intake answer that drove the recommendation. Alternatives that also matched are offered, and you can force any pattern you like — but an override is labelled as an override for whoever reads the brief in three months.

Confirmation is required before a brief is generated. Nothing is written on top of a pattern you did not agree to.

---

### Scene 7.5 — The design brief

**Screenshot:** `shots/06-05-brief.png`
**On screen:** Generate only the sections this engagement needs

**Narration:**
Ten parts, collapsed by default because nobody reads all of them at once.

Parts one to six arrive with the brief. The tool shortlist, governance, MLOps, runbook and sourcing sections are generated on demand — so you spend only on the sections this particular engagement actually needs.

---

### Scene 7.6 — Reference architecture

**Screenshot:** `shots/06-06-architecture.png`
**On screen:** No vendor names — on purpose

**Narration:**
Tool-agnostic by design: components and how they connect, with no vendor names anywhere.

The layout is authored per pattern and only the labels come from the model, which is why the diagram cannot come out as nonsense. Every box is clickable, and the whole thing downloads as SVG for a deck.

---

### Scene 7.7 — Drilling into a component

**Screenshot:** `shots/06-07-drill-detail.png`
**On screen:** Authored fact versus generated detail — labelled

**Narration:**
Level one: what triggers this component, what it is responsible for, what goes in and what comes out.

Notice the labelling. The trigger and the responsibility are authored and role-generic. The "in this use case" line is the part that came from the brief. Knowing which is which is the difference between quoting it to an engineer and checking it first.

---

### Scene 7.8 — Control flow

**Screenshot:** `shots/06-08-drill-control-flow.png`
**On screen:** Where an engineer starts asking real questions

**Narration:**
Level two: the internal steps and the branches, including what happens when something fails.

This is the level at which an engineer starts asking real questions, and it is deterministic — identical for every use case that uses this component. You are not asking a model to invent error handling.

---

### Scene 7.9 — Workflow view

**Screenshot:** `shots/06-09-workflow-view.png`
**On screen:** Read across — do not redesign

**Narration:**
The same design as an ordered sequence, mapped across n8n, Make, Airflow and plain code.

The point of that table is that your design survives the client having already chosen a platform. You read across it. You do not redesign.

---

### Scene 7.10 — One step, per platform

**Screenshot:** `shots/06-10-workflow-drill.png`
**On screen:** Including the trap on each platform

**Narration:**
Clicking a step gives the per-platform implementation detail, including the specific trap on each platform.

Authored fact, not generated — which is why it is safe to hand to an engineer who is going to build it that afternoon.

---

### Scene 7.11 — Tool shortlist

**Screenshot:** `shots/06-11-tool-shortlist.png`
**On screen:** Curated versus candidate — the distinction is the point

**Narration:**
Vendor choices come last, per architecture slot, filtered to the platform the client actually runs.

Entries from a loaded Vynora catalog are marked curated. Anything the model suggested is marked as a candidate to verify. That distinction is the entire point of the section — one of those you can put in a proposal, and one of those you check first.

---

### Scene 7.12 — Governance

**Screenshot:** `shots/06-12-governance.png`
**On screen:** Every red chip is a client decision

**Narration:**
A first-draft governance framework: risk tier, audit events, fairness or coverage review, model-risk controls, monitoring, and the approval route.

Every red chip is a decision the client has to make, and the chip names which one. Do not present this as a finished compliance artifact — present it as the list of decisions nobody has taken yet, which is far more useful to them.

---

### Scene 7.13 — MLOps

**Screenshot:** `shots/06-13-mlops.png`
**On screen:** Mostly a list of unasked questions

**Narration:**
How the thing gets retrained, registered, deployed and rolled back.

Its real value is as the list of questions the client's platform team has not been asked yet. Most engagements discover here that there is no promotion gate at all — which is a finding, and usually a phase one investment.

---

### Scene 7.14 — Runbooks and handoff

**Screenshot:** `shots/06-14-runbook.png`
**On screen:** Read the handoff checklist early

**Narration:**
What running it looks like day to day: routine tasks, what healthy looks like, an incident playbook and the escalation path.

Read the handoff checklist early rather than at the end. It is the list of things the receiving team has to be able to do before you leave, and some of them take months to arrange.

---

### Scene 7.15 — Build, buy or partner

**Screenshot:** `shots/06-15-sourcing.png`
**On screen:** Grounded in the diagnostic, or inferred — it says which

**Narration:**
The recommendation with its reasoning, a phased plan, risks and success metrics. At the top, what it was grounded in: "from this client's diagnostic" means it came out of the interviews; "assumption" means the model inferred it.

The narrative fields are editable and saved against this client, because this is the section that ends up in a proposal — under your name, in your words.

---

### Scene 7.16 — Exports

**Screenshot:** `shots/06-16-export.png`
**On screen:** For getting work out, not for keeping it

**Narration:**
Export one brief or the whole portfolio as a print-ready document, export the session as JSON to hand to a colleague, and load or export the shared tool catalog.

The platform is already saving your work continuously. These are for getting it out, not for keeping it.

---

# Module 8 — Across the portfolio

### Scene 8.1 — The scorecard

**Screenshot:** `shots/07-01-scorecard.png`
**On screen:** Every engagement, side by side

**Narration:**
Every engagement in the firm, latest scored round, side by side, with the movement against the round before it. Owners see all clients; a scoped consultant sees only theirs.

Nothing is listed until at least one engagement has a round with scores on it — which is the state shown here, and the one your firm sees on day one.

---

### Scene 8.2 — The Persona Simulator

**Screenshot:** `shots/07-02-persona-tab.png`
**On screen:** It writes nothing, anywhere

**Narration:**
A sandbox for previewing how a role might answer before a real interview is booked.

Be clear about what it is: it writes nothing. Not to the tracker, not to the engagement record, not to synthesis. The client from your session is filled in for convenience; everything else is optional.

---

### Scene 8.3 — A custom persona

**Screenshot:** `shots/07-03-persona-custom.png`
**On screen:** Rehearse the hostile interview

**Narration:**
Either an existing role from the client's briefing, or a persona you describe from scratch with its own bias.

The second is the useful one. It lets you rehearse the hostile interview — the CFO who thinks this is a waste of money, the CTO who has been burned before — before you walk into it. It is a rehearsal, not evidence, and nothing from it reaches the scorecard.

---

### Scene 8.4 — Account and subscription

**Screenshot:** `shots/00-90-account.png`
**On screen:** What your firm pays for VYNE

**Narration:**
What your firm pays to use VYNE. Not client billing — that is a separate screen, and confusing the two in front of a client is a bad afternoon.

---

### Scene 8.5 — Client billing

**Screenshot:** `shots/00-91-billing.png`
**On screen:** At cost, per client, for pass-through

**Narration:**
Real AI usage cost by client, at cost, for pass-through. If your engagement letter says AI costs are billed at cost, this is the screen that substantiates it.

---

### Scene 8.6 — Firm administration

**Screenshot:** `shots/00-92-admin.png`
**On screen:** Scope consultants to named clients

**Narration:**
Team members and their roles. A consultant can be scoped to named clients only — which is how you bring in a subcontractor, or run two engagements that must not see each other, without splitting your firm across two accounts.

---

### Scene 8.7 — About and version

**Screenshot:** `shots/00-93-about.png`
**On screen:** Know where this is

**Narration:**
The running version. Worth knowing where this lives, because the first question anybody will ask when you report something odd is which version you were on.

---

# Closing

**Screenshot:** `shots/00-03-hub.png`
**On screen:** Briefing → interviews → synthesis → roadmap → design

**Narration:**
Back to where we started, and the shape of the thing should be clearer now.

The briefing decides what the interviews ask. The interviews produce evidence. Synthesis turns that evidence into an argument — including the disagreements, which are usually the most valuable part. The roadmap turns the argument into a sequenced plan with the prerequisites made explicit. The design studio turns the plan into something an engineer can build.

Each step reads what the one before it wrote. That is why the order on the Hub is the order on the Hub, and it is why the single most useful habit you can form is finishing the briefing properly before anybody is invited.

One last thing, and it is the thing to say when a client asks how much of this is the machine. The model drafts. The consultant signs. Every narrative is editable, every score can be traced back to who said it, and nothing goes out under your firm's name that a person did not read first.
