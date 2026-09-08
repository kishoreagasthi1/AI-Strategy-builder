/**
 * GROUP 03/04 — the Interview Agent and the Synthesis Dashboard.
 *
 * Two screens, three audiences. Every shot carries `audience`:
 *
 *   'consultant'  — the consultant-only training video
 *   'interviewee' — the video a client executive is sent before their session
 *   'both'        — appears in both, and in the prospect walkthrough
 *
 * THE THING TO GET RIGHT IN THIS GROUP is that interview_agent.html is TWO
 * pages wearing one filename. vyne-client.js sets INTERVIEWEE from
 * session.role === 'interviewee' (line 437) and everything downstream branches
 * on it:
 *
 *   · vyne-rail.js swaps the seven-module nav for a single "Your Interview"
 *     entry and drops the client-engagement box entirely — an interviewee has
 *     no client to switch to, they ARE one interview.
 *   · vyne-client.js hydrates from GET /api/interviews/mine/bootstrap into a
 *     PRIVATE namespace instead of the firm workspace, so an interviewee's
 *     browser never holds another interview's material.
 *   · interview_agent.html's last script block (line 4534) hides #setup-screen
 *     outright, locks the identity fields from the invite, puts up its own
 *     welcome overlay, and pins a gold action bar with Pause and
 *     Finish & Submit across the top.
 *
 * So the same live conversation has FOUR controls on it in an interviewee's
 * browser and TWO in a consultant's, and only the interviewee's Finish calls
 * vyneInterview.complete() — the consultant's header Finish exports locally
 * and never tells the server the interview is done.
 */
import { A, BRIEFING_A } from './fixture.mjs';

/* ── Fixture repairs, and why they are here rather than invented ────────────
 *
 * The stub backend answers GET /api/interviews/mine/bootstrap from
 * INTERVIEWS_API[0], which is the TRACKER's row shape (`client`), not the
 * bootstrap's (`client_name`, plus `injected` carrying the sanitized briefing
 * — see routes/interviews.ts around line 1221). Left alone, every interviewee
 * shot renders "CEO · " with an empty client and no prep material.
 *
 * These two constants put back exactly what the real endpoint sends, and
 * nothing else. They are not decoration: without them the screenshots would
 * be of a bug in the harness rather than of the product.
 */
const IV_CLIENT = A.name;

/** The briefing as an interviewee actually receives it — BRIEFING_SAFE_FIELDS
 *  (routes/interviews.ts:100) with the consultant-only material removed, and
 *  issueTreeQuestions in the "D1 questions: a | b | c" shape pre_engagement.html
 *  writes (line 1920) and buildTopicPreview() parses. */
const IV_BRIEFING = (() => {
  const b = { ...BRIEFING_A };
  delete b.politicalSensitivityFlags;
  delete b.observations;
  delete b.dataRequestOwners;
  delete b.recommendedInterviewOrder;
  b.issueTreeQuestions = [
    'D1 questions: What is the single authoritative source of truth for movement data? | '
      + 'How long does it take to get a reliable answer to a data question, and who does it? | '
      + 'How many times is a movement re-keyed before it reaches finance?',
    'D2 questions: What proportion of the estate is cloud-based today? | '
      + 'How is a change to the warehouse platform tested before it goes live? | '
      + 'What is the oldest core system still running?',
    'D4 questions: Who signs off a technology business case under two million? | '
      + 'What does a business case for technology spend have to contain today? | '
      + 'How is benefit tracked after a programme goes live?',
    'D6 questions: Who is accountable when a data error causes a business error? | '
      + 'Is there a register of the models and tools in use? | '
      + 'Has the board been briefed on AI risk in the last twelve months?',
    'D7 questions: Describe a time a technology programme did not land here. | '
      + 'Do the depots trust the reports they are sent, or keep their own? | '
      + 'How does leadership talk about AI internally?',
  ];
  return b;
})();

/* ── Shared prep fragments ─────────────────────────────────────────────────
 * `prep` is a string evaluated in the page, so these are string constants
 * concatenated into each shot. Every one of them drives the page's OWN
 * globals — addMessage, applyScoreData, renderScorecard, setInterviewMode,
 * detectRefreshAgenda — rather than writing markup by hand. */

/** A refresh agenda in the exact shape synthesis.html's confirmCloseRound()
 *  writes at line 27017 (byRole kept as the compatibility shim, byPerson
 *  preferred). Round 1 of the fixture is closed; this is what closing it
 *  produces. */
const REFRESH_AGENDA = {
  engagementCode: A.code,
  clientName: A.name,
  roundClosed: 1,
  roundLabel: 'Round 1 — Initial Diagnostic',
  generatedAt: '2026-07-21T09:00:00.000Z',
  trigger: null,
  eventDescription: null,
  byRole: {
    VP_Operations: { isNewRole: false, agendaItems: [] },
    CEO: { isNewRole: false, agendaItems: [] },
    CDO: { isNewRole: true, agendaItems: [] },
  },
  byPerson: {
    'VP_Operations||Tomas Reinholt': {
      role: 'VP_Operations', person: 'Tomas Reinholt',
      label: 'VP Operations (Tomas Reinholt)', isNewRole: false,
      agendaItems: [
        { type: 'contradiction', dimension: 'D5', gap: '1.0',
          question: 'Walk me through a handover from the point the shift ends to the point it reaches the WMS — where does the time actually go?',
          round1ScoreHigh: 3, round1ScoreLow: 2,
          counterpartHigh: 'VP Operations (Grace Okonkwo)', counterpartLow: 'VP Operations (Tomas Reinholt)' },
        { type: 'blindspot', dimension: 'D3',
          topic: 'Key-person risk on the utilisation spreadsheet',
          question: 'If the person who maintains the weekly utilisation spreadsheet were away for a month, what would happen?' },
      ],
    },
    'VP_Operations||Grace Okonkwo': {
      role: 'VP_Operations', person: 'Grace Okonkwo',
      label: 'VP Operations (Grace Okonkwo)', isNewRole: false,
      agendaItems: [
        { type: 'contradiction', dimension: 'D5', gap: '1.0',
          question: 'Walk me through a handover from the point the shift ends to the point it reaches the WMS — where does the time actually go?',
          round1ScoreHigh: 3, round1ScoreLow: 2,
          counterpartHigh: 'VP Operations (Grace Okonkwo)', counterpartLow: 'VP Operations (Tomas Reinholt)' },
        { type: 'custom', consultantDirected: true, dimension: 'D7', dimensions: ['D7'],
          note: 'Test whether the depots were involved in designing the handover change this time.',
          question: 'How were the depot supervisors involved in designing the change, and when?' },
      ],
    },
    'CEO||Marguerite Vance': {
      role: 'CEO', person: 'Marguerite Vance', label: 'CEO', isNewRole: false,
      agendaItems: [
        { type: 'hypothesis', dimension: 'D6',
          hypothesis: 'Trailer utilisation data already exists and is simply not used.',
          question: 'Which of the weekly operational reports do you personally act on, and which do you skim?',
          routingReason: 'Lowest D6 score in round 1 (1.0) — routed to the CEO.' },
      ],
    },
  },
};

/** Two mandatory questions on the Northwind engagement, one of them already
 *  answered by the CTO — the state the managed list exists to show. */
const MANDATORY = {
  questions: [
    { id: 'mq-aup', text: 'Confirm you have reviewed the AI Acceptable Use policy this quarter.',
      roles: ['CEO', 'CTO', 'CFO'], dimensions: ['D6'] },
    { id: 'mq-dpa', text: 'Name every third party that currently receives customer movement data.',
      roles: ['CTO', 'VP_Operations'], dimensions: ['D1', 'D6'] },
  ],
  completed: {
    'mq-aup': {
      'CTO||Peter Osei': { role: 'CTO', person: 'Peter Osei', at: '2026-07-15T10:20:00.000Z' },
    },
  },
};

/** Seed the refresh agenda and re-run the page's own detection pass. */
const SEED_REFRESH =
  `vyneStore.setItem('vynora_refresh_agenda_${A.code}', ${JSON.stringify(JSON.stringify(REFRESH_AGENDA))});`
  + `detectRefreshAgenda();`;

const SEED_MANDATORY =
  `vyneStore.setItem('vynora_mandatory_${A.code}', ${JSON.stringify(JSON.stringify(MANDATORY))});`;

/**
 * A live interview, mid-conversation, painted through the page's own
 * functions: addMessage() for each turn and applyScoreData() for each scoring
 * pass, which is the identical entry point both the text path (sendToAgent)
 * and the realtime voice path feed. Nothing here writes markup directly.
 *
 * The conversation itself is invented, like every other word in the fixture.
 */
const LIVE_SCENE = `
  S.client = ${JSON.stringify(A.name)};
  S.stakeholderRole = 'CTO';
  S.stakeholderName = 'Peter Osei';
  S.industry = 'Logistics';
  S.depth = 'deep';
  S.voiceMode = 'both';
  S.sessionId = 'sess-training-01';
  S.sessionCode = 'VYNE-7K2M-4Q8P';
  document.getElementById('setup-screen').style.display = 'none';
  var _is = document.getElementById('interview-screen');
  _is.style.display = 'flex';
  document.getElementById('header-meta').textContent =
    S.client + ' \\u00b7 ' + S.stakeholderName + ' \\u00b7 ' + S.industry;
  showSessionCodeBar();
  var _br = loadBriefingContext(S.client);
  if (_br && _br.benchmarks) S.benchmarks = _br.benchmarks;
  renderScorecard();

  addMessage('ai', "Thank you for the time, Peter. I would like to start with data. When the board is shown a movement number \\u2014 trailers moved, on-time percentage \\u2014 where does that number actually come from?");
  addMessage('user', "It comes out of the TMS, but the TMS does not agree with the depot records, so finance reconciles the two by hand at each month end. That reconciled figure is the one the board sees.");
  applyScoreData({ scores: { D1: 3 }, questionsAsked: 6,
    finding: { dimension: 'D1', text: 'Movement data is reconciled manually at each month end' } });

  addMessage('ai', "How long does that reconciliation take, and what does anyone who needs the number before it finishes do in the meantime?");
  addMessage('user', "Three to four working days. Everyone downstream works from last month's figure and adjusts by feel. Nobody thinks that is fine, but nobody owns fixing it either.");
  applyScoreData({ scores: { D1: 3, D2: 4, D3: 4 }, questionsAsked: 11,
    finding: { dimension: 'D2', text: 'The warehouse platform is on a supported version but has no test environment' } });

  addMessage('ai', "Let us turn to governance. If your team wanted to put a model into production next month, who signs it off?");
  addMessage('user', "Honestly, nobody. There is no model inventory and no approval gate \\u2014 each region has been deciding for itself, which is exactly how we ended up with three different definitions of on-time.");
  applyScoreData({ scores: { D1: 3, D2: 4, D3: 4, D6: 2, D7: 3 }, questionsAsked: 18,
    finding: { dimension: 'D6', text: 'There is no model inventory and no approval gate' } });

  setStatus('', 'Listening...');
  setSaveStatus('saved');
  startClock();
  IV_CLOCK.startedAt = Date.now() - 22 * 60 * 1000;
  renderClock();
`;

/**
 * The interviewee session, repaired and re-run.
 *
 * The bootstrap block is a DOMContentLoaded listener, and by the time `prep`
 * runs it has already fired against the stub's incomplete row. Putting the
 * missing fields back and re-dispatching the event runs the REAL block again
 * — the alternative is hand-drawing the welcome panel, which would be a
 * screenshot of this file rather than of the product. The prior overlay and
 * action bar are removed first so the second pass does not stack on the first.
 */
const IV_FIX = `
  var _iv = vyneInterview.mine();
  _iv.client_name = ${JSON.stringify(IV_CLIENT)};
  _iv.interviewer_name = 'Vyn';
  /* The stub answers every /api/interviews/ URL from row 0. Point it at the
     CTO's row (iv-cto in the fixture) so the interviewee shots below and the
     consultant shots above are the SAME interview seen from two browsers. */
  _iv.id = 'iv-cto';
  _iv.interviewee_name = 'Peter Osei';
  _iv.interviewee_role = 'CTO';
  vyneStore.setItem('vynora_engagement_index', ${JSON.stringify(JSON.stringify({ [A.norm]: A.code }))});
  vyneStore.setItem('vynora_briefing_${A.norm}', ${JSON.stringify(JSON.stringify(IV_BRIEFING))});
  var _ov = document.getElementById('vyne-iv-overlay'); if (_ov) _ov.remove();
  var _pb = document.getElementById('vyne-pause-btn');
  if (_pb && _pb.parentNode) _pb.parentNode.remove();
  document.dispatchEvent(new Event('DOMContentLoaded'));
`;

/** Dismiss the welcome panel, exactly as clicking Begin does (it sets
 *  display:none rather than removing it — Pause brings it back). */
const IV_BEGIN = `document.getElementById('vyne-iv-overlay').style.display = 'none';`;

/** sessionStorage for a client interviewee: no activeClient, role flips the page. */
const IV_SESSION = {
  role: 'interviewee',
  email: 'peter.osei@northwindfreight.example',
  activeClient: undefined,
};

/** The parsed model output openPreviewSheet() renders. The stub LLM returns a
 *  fixed union object that carries no `dimensions` array, so the Generate
 *  button cannot produce this shape; the sheet itself is the page's own
 *  renderer, called with the payload the real call returns. */
const PREVIEW_SHEET = {
  client: A.name,
  roleLabel: 'CTO / Head of Technology',
  industry: 'Logistics',
  depthLabel: 'Deep Dive',
  mode: 'C',
  intro: 'This is a guided conversation about how ready Northwind is to use AI well — not a test, and '
    + 'not a technology review. It runs for about an hour, led by an AI interviewer that adapts to what '
    + 'you say. Your answers are recorded for the consulting team and nobody else.',
  dimensions: [
    { code: 'D1', name: 'Data & Data Management', tier: 'LEAD',
      theme: 'Where the numbers the business argues about actually come from.',
      questions: [
        'When the board is shown a movement number, which system produced it?',
        'How many times is a movement re-keyed before it reaches finance?',
        'How long does it take to get a reliable answer to a data question, and who does it?',
        'Has a data quality audit ever been done here? What did it find?',
      ],
      prep: ['A rough sense of which systems hold movement data', 'Anything you know about the month-end reconciliation'] },
    { code: 'D2', name: 'Technology & Infrastructure', tier: 'LEAD',
      theme: 'What the estate can carry today without being rebuilt.',
      questions: [
        'What proportion of the estate is cloud-based today?',
        'How is a change to the warehouse platform tested before it goes live?',
        'What is the oldest core system still running, and what would replacing it involve?',
      ],
      prep: ['Recent or planned platform work', 'Roughly how releases are tested today'] },
    { code: 'D6', name: 'Governance & Risk', tier: 'COVER',
      theme: 'Who is allowed to say yes, and what they have to check first.',
      questions: [
        'If your team wanted a model in production next month, who signs it off?',
        'Is there a register of the models and tools in use?',
      ],
      prep: ['Any existing approval route for technology spend'] },
    { code: 'D7', name: 'Culture & Change Readiness', tier: 'LIGHT',
      theme: 'How change has landed here before.',
      questions: ['Describe a technology programme that did not land as intended. How was it handled?'] },
  ],
  mandatory: [
    { text: 'Confirm you have reviewed the AI Acceptable Use policy this quarter.' },
    { text: 'Name every third party that currently receives customer movement data.' },
  ],
};

const wrap = (js) => `(() => { try { ${js} return {}; } catch (e) { return { error: String(e) }; } })()`;

/* ══ B. SYNTHESIS DASHBOARD ════════════════════════════════════════════════
 *
 * 27,215 lines and one screen. Everything below loads the same engagement the
 * same way and then photographs one panel of it, because a full-page shot of
 * this dashboard is unreadable at any size a training document can print.
 */

/** Load Northwind, exactly as a consultant does: type the name, press Load. */
const LOAD = `document.getElementById('client-input').value = ${JSON.stringify(A.name)}; loadEngagement();`;

/**
 * A SECOND round on the Northwind engagement.
 *
 * The comparison table, the round pills and the delta narrative only exist
 * once a client has been assessed twice, and the fixture stops at round 1.
 * This is the record a completed refresh round leaves behind — same shape as
 * fixture.mjs's round 1, written into the same key, and re-scored on load by
 * VyneScoring.recomputeAllRounds() rather than by anything here.
 *
 * The two VP Operations are deliberately three points apart on D5 in this
 * round. Round 1 has them agreeing, so nothing in the fixture produces a
 * contradiction worth drilling into, and the drill-down is the whole point of
 * the contradictions panel.
 */
const ROUND_2 = {
  roundId: 'r2', roundNumber: 2, label: 'Round 2 — Post-Reconciliation Refresh',
  type: 'refresh', status: 'complete', date: '2026-09-14',
  scopeDimensions: ['D1', 'D3', 'D5', 'D6', 'D7'],
  eventContext: 'Automated reconciliation went live in August',
  deltaNarrative:
    'D1 is up 0.3 in eight weeks, and that is the automated reconciliation landing — it is the only '
    + 'change with a cause anyone can name. D6 moved 0.1, which is noise: an AI approver was named in '
    + 'July and has still not been given a route to approve anything, so the governance score is '
    + 'measuring an intention rather than a control. The D5 average is up 0.3 and that number should '
    + 'not be reported on its own. It hides a three-point split between the two regions: the southern '
    + 'depots have dropped the paper handover form entirely, the northern depots have not changed at '
    + 'all, and in round 1 the two agreed.',
  interviews: [
    { role: 'CEO', interviewee: 'Marguerite Vance', name: 'Marguerite Vance',
      sourceInterviewId: 'iv-ceo-r2', completedAt: '2026-09-10T10:00:00.000Z',
      isRefresh: true, refreshRound: 2,
      scores: { D1: 3, D3: 4, D6: 2, D7: 3 },
      findings: [
        { dimension: 'D1', text: 'The reconciliation now runs overnight; the board pack is no longer built by hand' },
        { dimension: 'D6', text: 'An AI approver has been named but has no approval route to use' },
      ] },
    { role: 'CTO', interviewee: 'Peter Osei', name: 'Peter Osei',
      sourceInterviewId: 'iv-cto-r2', completedAt: '2026-09-11T09:30:00.000Z',
      isRefresh: true, refreshRound: 2,
      scores: { D1: 4, D3: 4, D5: 3, D6: 2, D7: 3 },
      findings: [
        { dimension: 'D1', text: 'Depot, TMS and finance movement records now reconcile automatically each night' },
        { dimension: 'D6', text: 'Still no model inventory; the approval gate exists on paper only' },
      ] },
    { role: 'VP_Operations', interviewee: 'Tomas Reinholt', name: 'Tomas Reinholt',
      sourceInterviewId: 'iv-ops-north-r2', completedAt: '2026-09-12T11:00:00.000Z',
      isRefresh: true, refreshRound: 2,
      scores: { D3: 3, D5: 2, D7: 2 },
      findings: [
        { dimension: 'D5', text: 'Handover is still a paper form in the northern depots; nothing has changed on shift' },
      ] },
    { role: 'VP_Operations', interviewee: 'Grace Okonkwo', name: 'Grace Okonkwo',
      sourceInterviewId: 'iv-ops-south-r2', completedAt: '2026-09-12T15:00:00.000Z',
      isRefresh: true, refreshRound: 2,
      scores: { D3: 4, D5: 5, D7: 4 },
      findings: [
        { dimension: 'D5', text: 'Southern depots piloted handover capture on the yard tablets and dropped the paper form' },
        { dimension: 'D7', text: 'Supervisors were in the design workshops this time and are advocating the change' },
      ] },
  ],
  scores: {},
  benchmarks: {
    D1: { avg: 2.9, best: 4.1, laggard: 1.5 }, D2: { avg: 3.1, best: 4.3, laggard: 1.8 },
    D3: { avg: 3.0, best: 4.2, laggard: 1.6 }, D4: { avg: 2.7, best: 4.0, laggard: 1.4 },
    D5: { avg: 2.8, best: 4.1, laggard: 1.5 }, D6: { avg: 2.4, best: 3.9, laggard: 1.2 },
    D7: { avg: 2.9, best: 4.0, laggard: 1.6 },
  },
  benchmarkBasis: 'Third-party logistics operators, £500m–£2bn revenue, EMEA.',
};

/* REMOVED in v5.33.7 — FLAT_INTERVIEWS.
 *
 * It used to give the engagement a flat `interviews` array before loading,
 * because openDrillDown() and openConflictDrillDown() both began
 * `if(!engagement||!engagement.interviews) return;` and a rounds-only record has
 * no such array — so on the fixture as written, clicking a dimension did nothing
 * at all. It was a workaround for a product defect and was documented as one.
 *
 * The guard is fixed (both now read the rounds, which is what the rest of their
 * own bodies already did), so the workaround is gone. It had to go: a screenshot
 * taken through a workaround is a screenshot of the workaround. These shots now
 * photograph the same record every other shot on this page uses.
 */

/** Add round 2 to the stored engagement. */
const ADD_ROUND_2 = `
  var _eng = JSON.parse(vyneStore.getItem('vynora_engagement_${A.code}'));
  _eng.rounds.push(${JSON.stringify(ROUND_2)});
  _eng.currentRoundId = 'r2';
  vyneStore.setItem('vynora_engagement_${A.code}', JSON.stringify(_eng));
`;

/** Two rounds, then load. */
const LOAD_2_ROUNDS = `${ADD_ROUND_2} ${LOAD}`;


export const SHOTS = [
  /* ══ A. INTERVIEW AGENT — the consultant's setup ═══════════════════════ */

  { id: '03-01-setup-consultant', page: 'interview_agent.html', audience: 'both',
    title: 'Interview Agent — setup, as the consultant sees it', full: true,
    note: 'Where an interview is configured. The client is already filled in from the session and the '
        + 'role list comes from the Pre-Engagement briefing, so the only decisions left are who is being '
        + 'interviewed and how deep to go.' },

  { id: '03-02-per-person-fields', page: 'interview_agent.html', audience: 'consultant',
    title: 'The per-person fields', target: '#new-interview-fields',
    prep: wrap(`
      document.getElementById('client-name').value = ${JSON.stringify(A.name)};
      checkBriefing(${JSON.stringify(A.name)});
      document.getElementById('stakeholder-role').value = 'VP_Operations';
      handleRoleChange('VP_Operations');
      document.getElementById('stakeholder-name').value = 'Grace Okonkwo';
    `),
    note: 'Everything that changes from one interview to the next. Role and name are both required, and '
        + 'the name is the part people skip. Two people can hold the same role — Northwind has two VP '
        + 'Operations — and without the name the second interview overwrites the first instead of '
        + 'sitting beside it.' },

  { id: '03-03-depth-selector', page: 'interview_agent.html', audience: 'consultant',
    title: 'Voice mode and interview depth', target: '.field-group:has(#interview-depth)',
    prep: wrap(`document.getElementById('interview-depth').value = 'standard';`),
    note: 'Depth sets the question budget the agent works to: Quick Screen 25, Standard 35, Deep Dive 50. '
        + 'It is the choice that decides whether an executive is in the chair for twenty minutes or ninety.' },

  { id: '03-04-preview-control', page: 'interview_agent.html', audience: 'consultant',
    title: 'Generating the interviewee preview sheet', target: '.field-group:has(#preview-gen-btn)',
    prep: wrap(`
      document.getElementById('preview-gen-status').textContent =
        '\\u2713 Preview ready below \\u2014 review it, then use Print \\u2192 Save as PDF to share.';
      document.getElementById('preview-gen-status').className = 'preview-gen-status ok';
      document.querySelector('input[name="preview-mode"][value="C"]').checked = true;
    `),
    note: 'Optional, and worth doing for senior people. One AI call produces a courtesy sheet you can send '
        + 'ahead. "Topic guide + prep notes" adds what it would help them to have to hand.' },

  { id: '03-05-preview-sheet', page: 'interview_agent.html', audience: 'both',
    title: 'The preview sheet the executive receives', target: '#preview-overlay',
    settle: 1800, after: 1200,
    prep: wrap(`openPreviewSheet(${JSON.stringify(PREVIEW_SHEET)});`),
    note: 'What the interviewee gets before the session: the areas to be covered and illustrative questions, '
        + 'stated plainly as illustrative because the live conversation follows their answers. Print to PDF '
        + 'and send it.' },

  { id: '03-06-mode-toggle', page: 'interview_agent.html', audience: 'consultant',
    title: 'The three modes of the setup screen', target: '#mode-toggle',
    prep: wrap(SEED_REFRESH),
    note: 'Three modes on one card. New Interview runs a first conversation; Refresh runs a focused '
        + 'second one against an agenda Synthesis generated; Mandatory Questions is where the questions '
        + 'that must be asked are authored. The gold line underneath appears only once a round has been '
        + 'closed for the client currently typed in — that is the signal a refresh is available.' },

  { id: '03-07-mandatory-questions', page: 'interview_agent.html', audience: 'consultant',
    title: 'Mandatory questions for the engagement', target: '#mandatory-fields',
    prep: wrap(`
      ${SEED_MANDATORY}
      setInterviewMode('mandatory');
      document.getElementById('mq-client').value = ${JSON.stringify(A.name)};
      loadMandatoryForClient(${JSON.stringify(A.name)});
    `),
    note: 'Questions the agent must ask, assigned per role and tracked per person. The green chip means '
        + 'that role has been answered and by whom; an interview cannot be finished while a mandatory '
        + 'question assigned to that person is still unasked.' },

  { id: '03-08-refresh-setup', page: 'interview_agent.html', audience: 'consultant',
    title: 'Refresh interview setup', target: '#refresh-interview-fields',
    prep: wrap(`${SEED_REFRESH} setInterviewMode('refresh');`),
    note: 'A second-round interview. The engagement and the person are picked from what Synthesis produced '
        + 'when the round was closed — there is nothing to configure, because the agenda decides the scope.' },

  { id: '03-09-refresh-agenda', page: 'interview_agent.html', audience: 'consultant',
    title: 'The generated agenda for one person', target: '#refresh-agenda-preview',
    prep: wrap(`${SEED_REFRESH} setInterviewMode('refresh'); renderRefreshAgendaPreview();`),
    note: 'Read this before the session. Each line came from the round that closed: a contradiction between '
        + 'two people, an unresolved hypothesis, a blind spot, or something you added by hand. Only these '
        + 'dimensions can be re-scored.' },

  /* ══ The live interview — CONSULTANT running it in their own tab ════════ */

  { id: '03-10-live-consultant', page: 'interview_agent.html', audience: 'consultant',
    title: 'The live interview as the consultant runs it', settle: 1600, after: 1200,
    prep: wrap(LIVE_SCENE),
    note: 'Running the agent in your own tab, with the interviewee in the room. Conversation on the left, '
        + 'the score forming on the right. Two controls only — Pause and Finish & Export — and the left '
        + 'rail is still the full module nav, because this is your session.' },

  { id: '03-11-live-transcript', page: 'interview_agent.html', audience: 'both',
    title: 'The live transcript', target: '.convo-panel', settle: 1600, after: 1200,
    prep: wrap(LIVE_SCENE),
    note: 'Every turn as it happens. Answers can be spoken or typed, and "Clarify this answer" on any of '
        + 'your own turns sends a correction the agent folds into the scoring rather than overwriting what '
        + 'you said.' },

  { id: '03-12-live-scorecard', page: 'interview_agent.html', audience: 'consultant',
    title: 'The scorecard forming during the interview', target: '.side-panel',
    settle: 1600, after: 1200,
    prep: wrap(LIVE_SCENE),
    note: 'Scores move as the conversation goes, with the industry average and best-in-class marked on each '
        + 'bar from the briefing benchmarks. A dimension nobody has touched stays "Not yet assessed" rather '
        + 'than defaulting to a number.' },

  { id: '03-13-live-findings', page: 'interview_agent.html', audience: 'consultant',
    title: 'Findings extracted during the interview', target: '.side-panel',
    settle: 1600, after: 1200,
    prep: wrap(`${LIVE_SCENE} switchTab('findings');`),
    note: 'The evidence line behind each score, tagged to its dimension, captured at the moment it was said. '
        + 'These are what Synthesis clusters into confirmed findings and contradictions later.' },

  { id: '03-14-header-controls', page: 'interview_agent.html', audience: 'consultant',
    title: 'The consultant’s two controls', target: '.header-right',
    settle: 1600, after: 1200,
    prep: wrap(LIVE_SCENE),
    note: 'Save state, elapsed time, Pause and Finish & Export. Pause stops the clock and the microphone. '
        + 'Finish & Export writes the interview into the engagement and opens the export screen — it does '
        + 'NOT tell the server the interview is submitted; only the interviewee’s own Finish does that.' },

  { id: '03-15-paused-consultant', page: 'interview_agent.html', audience: 'consultant',
    title: 'A paused interview', settle: 1600, after: 1400,
    prep: wrap(`${LIVE_SCENE} togglePause();`),
    note: 'Paused: the clock stops, the microphone stops, Send is disabled and the session is saved. Use it '
        + 'for a break or an interruption — resume picks up in the same conversation.' },

  /* ══ The same interview, in the INTERVIEWEE'S browser ═══════════════════ */

  { id: '03-20-interviewee-welcome', page: 'interview_agent.html', audience: 'interviewee',
    title: 'What the interviewee sees when they sign in', session: IV_SESSION,
    settle: 1800, after: 1200,
    prep: wrap(IV_FIX),
    note: 'The whole consultant setup is gone. One panel: who you are, what this is, and a single button to '
        + 'begin. Nothing to configure and nothing to choose — the invite already carries your name, your '
        + 'role and your client.' },

  { id: '03-21-interviewee-topics', page: 'interview_agent.html', audience: 'interviewee',
    title: 'Previewing the topics before starting', session: IV_SESSION,
    settle: 1800, after: 1200,
    prep: wrap(`${IV_FIX} _vyneIvPreview();`),
    note: 'Areas, not a question list — the interviewer adapts, and an exact script invites rehearsed '
        + 'answers. Worth opening if you would like rough figures to hand before you start.' },

  { id: '03-22-interviewee-live', page: 'interview_agent.html', audience: 'interviewee',
    title: 'The live interview in the interviewee’s browser', session: IV_SESSION,
    settle: 1800, after: 1400,
    prep: wrap(`${IV_FIX} ${IV_BEGIN} ${LIVE_SCENE}`),
    note: 'The same conversation the consultant sees, with two differences that matter: the gold bar across '
        + 'the top carries Pause and Finish & Submit, and the left rail holds one item — your interview. '
        + 'There is no way from here into any other client’s work.' },

  { id: '03-23-interviewee-controls', page: 'interview_agent.html', audience: 'interviewee',
    title: 'Pause and Finish & Submit', target: 'div:has(> #vyne-finish-btn)',
    session: IV_SESSION, settle: 1800, after: 1400,
    prep: wrap(`${IV_FIX} ${IV_BEGIN} ${LIVE_SCENE}`),
    note: 'Answers save as you go, so Pause simply closes the session; you can come back to it. '
        + 'Finish & Submit is the one that ends it — it sends the interview to the consulting team and '
        + 'nothing can be edited afterwards.' },

  { id: '03-24-interviewee-paused', page: 'interview_agent.html', audience: 'interviewee',
    title: 'Pausing to continue later', session: IV_SESSION, settle: 1800, after: 1400,
    prep: wrap(`${IV_FIX} ${IV_BEGIN} ${LIVE_SCENE} document.getElementById('vyne-pause-btn').click();`),
    note: 'What Pause leads to. The window can be closed; signing in again offers "Continue where you left '
        + 'off" and resumes at the same point in the conversation.' },

  { id: '03-25-interviewee-submitted', page: 'interview_agent.html', audience: 'interviewee',
    title: 'After Finish & Submit', session: IV_SESSION, settle: 1800, after: 1800,
    prep: wrap(`
      ${IV_FIX} ${IV_BEGIN} ${LIVE_SCENE}
      window.confirm = function(){ return true; };
      document.getElementById('vyne-finish-btn').click();
    `),
    note: 'Submitted. The interview is now with the consulting team and every control on the page is '
        + 'disabled — this is the point of no return the confirmation warned about.' },

  /* ══ The export screen ═════════════════════════════════════════════════ */

  { id: '03-30-export-screen', page: 'interview_agent.html', audience: 'consultant',
    title: 'Interview complete — the export screen', full: true,
    settle: 1600, after: 2200,
    prep: wrap(`${LIVE_SCENE} S.messages = []; finishInterview();`),
    note: 'What a consultant-run interview ends on. The scores are already written into the engagement and '
        + 'auto-archived; these buttons are for taking a copy out — the JSON for another system, the '
        + 'transcript for the file, the record file for recovery.' },

  { id: '03-31-export-json', page: 'interview_agent.html', audience: 'consultant',
    title: 'The exported record', target: '#export-json-box',
    settle: 1600, after: 2200,
    prep: wrap(`${LIVE_SCENE} S.messages = []; finishInterview();`),
    note: 'The machine-readable form of the interview: dimension scores, findings and the identifiers that '
        + 'tie it back to the engagement. This is what Synthesis reads.' },

  /* ══ B. SYNTHESIS DASHBOARD ════════════════════════════════════════════ */

  { id: '04-01-synthesis-empty', page: 'synthesis.html', audience: 'both',
    title: 'Synthesis before a client is loaded',
    session: { activeClient: undefined },
    note: 'Synthesis reads what the interviews wrote. Until a client is named it has nothing to read, '
        + 'which is why this screen starts empty rather than starting wrong.' },

  { id: '04-02-synthesis-loaded', page: 'synthesis.html', audience: 'both',
    title: 'Synthesis — engagement loaded', full: true,
    settle: 1800, after: 1600,
    prep: `(() => { try { document.getElementById('client-input').value = 'Northwind Freight Group'; loadEngagement(); return {}; } catch (e) { return { error: String(e) }; } })()`,
    note: 'Five interviews on one page. Progress and coverage at the top, the score with its evidence in '
        + 'the middle, and what to do about it at the bottom. Nothing here was typed by a consultant — '
        + 'every number is derived from the interviews.' },

  { id: '04-03-overall-progress', page: 'synthesis.html', audience: 'both',
    title: 'Overall progress', target: '#card-overall', settle: 1800, after: 1600,
    prep: wrap(LOAD),
    note: 'The headline number and how much of the assessment stands behind it. Read the interview count '
        + 'before the score: an overall built on two conversations is not the same object as one built '
        + 'on six.' },

  { id: '04-04-interview-tracker', page: 'synthesis.html', audience: 'consultant',
    title: 'Who has been interviewed', target: '#card-interviews', settle: 1800, after: 1600,
    prep: wrap(LOAD),
    note: 'Who has been interviewed against who was planned in the briefing, with each person’s own '
        + 'average. One row per PERSON, not per role — Northwind’s two VP Operations each get their own '
        + 'line and their own number, because they are two voices and the whole diagnostic depends on '
        + 'not merging them. A role nobody has spoken to yet shows as a single Pending row.' },

  { id: '04-05-dimension-scores', page: 'synthesis.html', audience: 'both',
    title: 'Dimension scores and who contributed to them',
    target: '.card:has(#score-grid)', settle: 1800, after: 1600,
    prep: wrap(LOAD),
    note: 'The seven dimensions, weighted by whose view carries most authority on each — a CTO’s reading '
        + 'of the technology estate counts for more than the CFO’s. The chips under each bar are every '
        + 'interview that scored it, with the highest green and the lowest red; a ⚡ on the title means '
        + 'they are 1.5 or more apart. Click any dimension for the arithmetic.' },

  { id: '04-06-coverage-map', page: 'synthesis.html', audience: 'consultant',
    title: 'Coverage map', target: '.card:has(#coverage-grid)', settle: 1800, after: 1600,
    prep: wrap(LOAD),
    note: 'How many interviews have scored each dimension. Anything on one interview is one person’s '
        + 'opinion, not a finding — the target is two before the round is finalised, and this is where '
        + 'you see which dimensions are short.' },

  { id: '04-07-confirmed-findings', page: 'synthesis.html', audience: 'both',
    title: 'Confirmed findings', target: '.card:has(#confirmed-list)', settle: 1800, after: 1600,
    prep: wrap(`${LOAD}
      /* Each tile collapses; open them so the evidence is visible. */
      document.querySelectorAll('#confirmed-list .synth-sec-body')
        .forEach(function(b){ b.style.display = 'flex'; });
    `),
    note: 'Findings that more than one person raised independently. Corroboration is the whole test: the '
        + 'CEO and the CTO describing the same month-end reconciliation in different words is worth more '
        + 'than either of them saying it twice.' },

  { id: '04-08-contradictions', page: 'synthesis.html', audience: 'consultant',
    title: 'Contradictions', target: '.card:has(#conflict-list)', settle: 1800, after: 1600,
    prep: wrap(LOAD),
    note: 'Dimensions where the people interviewed disagree by a point or more. These are not errors to '
        + 'reconcile — they are the most useful thing on the page, because a gap between what leadership '
        + 'believes and what operations experiences is usually the finding itself.' },

  { id: '04-09-unresolved-gaps', page: 'synthesis.html', audience: 'consultant',
    title: 'Unresolved gaps', target: '.card:has(#gap-list)', settle: 1800, after: 1600,
    prep: wrap(LOAD),
    note: 'Per dimension, the roles with real authority on it that nobody has interviewed yet. It is the '
        + 'confidence gap stated as a list of people: D6 is the lowest score on the board and it has been '
        + 'assessed without a General Counsel or a CDO in the room.' },

  { id: '04-10-recommended-focus', page: 'synthesis.html', audience: 'consultant',
    title: 'Recommended focus for the next interview',
    target: '.card:has(#remaining-questions)', settle: 1800, after: 1600,
    prep: wrap(LOAD),
    note: 'Who to interview next and what to ask them, derived from the thinnest coverage and the widest '
        + 'disagreement. The panel underneath is where you add your own focus item — it merges into the '
        + 'refresh agenda when the round closes.' },

  { id: '04-11-ai-synthesis', page: 'synthesis.html', audience: 'both',
    title: 'The AI synthesis', target: '.card:has(#synthesis-box)', settle: 1800, after: 1600,
    prep: wrap(`${LOAD}
      /* The sections render collapsed. Open the two a consultant reads first —
         the same click their headers do. */
      var _sb = document.querySelectorAll('#synthesis-box .synth-sec-body');
      if (_sb[0]) _sb[0].style.display = 'flex';
      if (_sb[1]) _sb[1].style.display = 'flex';
    `),
    note: 'The written argument across all the interviews: which hypotheses survived, what the client '
        + 'cannot see about itself, and what follows. A previously generated synthesis is restored on '
        + 'load with the date it was made, so revisiting the page does not cost another AI call.' },

  { id: '04-12-drill-dimension', page: 'synthesis.html', audience: 'consultant',
    title: 'Drill-down — how one dimension score was calculated',
    settle: 1800, after: 1600,
    prep: wrap(`${LOAD} openDrillDown('D5');`),
    note: 'Click any dimension and the weighted average is shown as arithmetic — every interview, its '
        + 'score, its weight, and the sum. This is the screen to open when a client asks why a number is '
        + 'what it is.' },

  { id: '04-13-drill-contradiction', page: 'synthesis.html', audience: 'consultant',
    title: 'Drill-down — a contradiction, side by side',
    settle: 2000, after: 1600,
    prep: wrap(`${LOAD_2_ROUNDS} openConflictDrillDown('D5');`),
    note: 'The two ends of a disagreement, with what each person actually said underneath their score. '
        + 'Northwind’s two regional VP Operations are three points apart on shift handover in round 2 — '
        + 'same job title, same company, opposite experience.' },

  { id: '04-14-round-pills', page: 'synthesis.html', audience: 'consultant',
    title: 'Switching between assessment rounds', target: '#round-pills-row',
    settle: 2000, after: 1600,
    prep: wrap(LOAD_2_ROUNDS),
    note: 'Once a client has been assessed twice the dashboard opens on the latest scored round, and these '
        + 'pills switch the whole page between rounds. What you are looking at is always one round, never '
        + 'a blend of them.' },

  { id: '04-15-comparison-table', page: 'synthesis.html', audience: 'both',
    title: 'Round-over-round comparison', target: '#comparison-table-wrap',
    settle: 2000, after: 1600,
    prep: wrap(LOAD_2_ROUNDS),
    note: 'What actually changed between rounds, per dimension. This table is the deliverable a retained '
        + 'client is paying for — a score on its own says where they are, and only the movement says '
        + 'whether the work is landing.' },

  { id: '04-16-narrative-editor', page: 'synthesis.html', audience: 'consultant',
    title: 'Editing the delta narrative', target: '#comparison-section',
    settle: 2000, after: 1600,
    prep: wrap(`${LOAD_2_ROUNDS} toggleNarrativeEdit();`),
    note: 'The narrative is generated, then edited by you. Save marks it "Edited by consultant" and it is '
        + 'the edited text that goes into the client document — the model drafts, the consultant signs.' },

  { id: '04-17-close-round-modal', page: 'synthesis.html', audience: 'consultant',
    title: 'Closing the round', settle: 1800, after: 1600,
    prep: wrap(`${LOAD} openCloseRoundModal();`),
    note: 'Closing a round marks this synthesis final and turns the contradictions, unresolved hypotheses '
        + 'and blind spots into a per-person agenda for the next round — the agenda the Interview Agent’s '
        + 'Refresh tab then runs. Nothing is deleted.' },

  { id: '04-18-data-manager', page: 'synthesis.html', audience: 'consultant',
    title: 'Export Snapshot, Load Snapshot, Clear This Client', target: '.data-manager',
    settle: 1800, after: 1600,
    prep: wrap(LOAD),
    note: 'Export Snapshot writes every stored key for the firm to a JSON file; Load Snapshot reads one '
        + 'back. Take one before anything irreversible — Clear This Client is beside them, and it deletes '
        + 'the named client’s briefing, interviews, synthesis and roadmap.' },

  { id: '04-19-send-to-roadmap', page: 'synthesis.html', audience: 'consultant',
    title: 'Sending the scores to the Roadmap Builder', target: '.load-bar',
    settle: 1800, after: 1800,
    /* v5.33.7: the push itself now runs in the shot. It could not before —
     * pushToRoadmapBuilder() picked the engagement with the newest createdAt
     * rather than the loaded one, which on this fixture is Harbourline, which
     * has no scored round, so it alerted and returned. */
    prep: wrap(`${LOAD} pushToRoadmapBuilder();`),
    note: 'The handoff out of Synthesis, beside Run AI Synthesis and Close Round. It pushes the latest '
        + 'scored round and the sequenced recommendations across to the Roadmap Builder and exports a '
        + 'snapshot on the way. Do it once the round is settled — pushing again overwrites what the '
        + 'roadmap is working from.' },

  { id: '04-20-clear-client', page: 'synthesis.html', audience: 'consultant',
    title: 'After Clear This Client', settle: 1800, after: 1800,
    prep: wrap(`
      ${LOAD}
      window.confirm = function(){ return true; };
      clearAllData();
    `),
    note: 'What it looks like afterwards: the dashboard is gone and the count of deleted keys is all that '
        + 'is left. Only the client named in the box is affected — every other engagement is untouched — '
        + 'and there is no undo, which is why the confirmation tells you to export a snapshot first.' },
];

// CANNOT REACH:
//
// · A REAL VOICE INTERVIEW. startLiveVoice() mints a Gemini realtime grant and
//   opens a WebSocket, and requestMicPermission() needs a microphone. The stub
//   has neither, so the "🎤 RECORDING — speak your answer" banner, the animated
//   waveform in the header and the realtime voice badge cannot be photographed.
//   Every conversation shot above is the same screen with the text path
//   driving it; the voice path renders into exactly these elements.
//
// · THE TAP-TO-BEGIN OVERLAY. launchInterviewScreen() puts up a full-screen
//   "Tap to begin your interview" gate whose only job is to satisfy the
//   browser's requirement for a user gesture before audio can play, and it
//   prefetches the agent's opening line behind it. With the stub LLM the
//   prefetch returns the harness's fixed union object rather than a greeting,
//   so the overlay would be photographed saying it is preparing a question
//   that never arrives. Left out rather than faked.
//
// · THE GENERATE button on either preview panel. It needs the model to return
//   {intro, dimensions:[...]}; the harness's single LLM stub returns one fixed
//   union object for every caller and carries no `dimensions`, so the button
//   errors. 03-05 renders the sheet through the page's own openPreviewSheet()
//   with the payload a real call returns.
//
// FIXED IN v5.33.7 — two entries that used to live in this list are gone,
// because the product changed rather than the workaround improving:
//
//   · The dimension and contradiction drill-downs no longer need a flat
//     `interviews` array grafted onto the record. Both guards read the rounds.
//   · pushToRoadmapBuilder() pushes the engagement that is loaded, so 04-19
//     now runs the real push instead of photographing an inert button.
//
// Both are covered by frontend/test/training-defects-e2e.mjs, which is
// revert-tested — so if either regresses, a test fails rather than a
// screenshot quietly going stale.
//
// · A SUBMITTED interview arriving back in the consultant's tracker. That is a
//   server-side state change (POST /api/interviews/mine/complete) which the
//   stub acknowledges but does not persist, so the tracker row does not move.
//   It belongs to the Interview Tracker group in any case.
