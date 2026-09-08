/**
 * GROUP 05/06/07 — THE BUILD HALF OF THE ENGAGEMENT.
 *
 *   05-  roadmap.html          the AI Roadmap Builder (six tabs, three gates)
 *   06-  solution_design.html  the Solution Design Studio
 *   07-  scorecard.html        the portfolio scorecard and persona simulator
 *
 * ── Two mechanical notes ───────────────────────────────────────────────────
 *
 * roadmap.html sets `body{height:100vh;overflow:hidden}` and scrolls .main
 * internally, so `full: true` captures nothing more than the viewport. Its long
 * screens therefore use a tall `viewport` instead. solution_design.html scrolls
 * the document normally and uses `full: true`.
 *
 * ── How these shots reach their state ──────────────────────────────────────
 *
 * Everything that CAN be driven through the product's own controls is driven
 * that way: showTab(), toggleUc(), setUcStages()/confirmStages(),
 * generateAllDimGaps() (which really does go through the LLM stub),
 * proposePattern()/confirmPattern(), syncFromRoadmap(), drillComp().
 *
 * Three things cannot, because the stub LLM in harness.mjs returns one union
 * object and those code paths parse a specific schema out of it and reject it:
 * the roadmap SYNTHESIS, the roadmap GANTT, and the Design Studio's brief and
 * its Governance / MLOps / Runbook / Sourcing packages. For those the prep
 * writes the object the product would have stored — the same shape
 * renderSynthesis(), renderGantt() and renderBrief() read — and then calls the
 * product's own render function. Nothing is drawn by hand; the pixels are the
 * product's. What is invented is the content, exactly as the rest of the
 * fixture invents Northwind Freight Group.
 *
 * See the CANNOT REACH notes at the bottom for what is left out entirely.
 */

/* Every prep is wrapped so a failure surfaces as prepError, not a throw. */
const P = (js) => `(() => { try { ${js}; return {}; } catch (e) { return { error: String(e) }; } })()`;

/* ══════════════════════════════════════════════════════════════════════════
   A. roadmap.html
   ══════════════════════════════════════════════════════════════════════════ */

/* The engagement auto-loads at DOMContentLoaded from the session's active
 * client, so nothing has to be done to get Northwind on screen. This is only
 * a belt-and-braces re-apply for the shots that then drive state on top. */
const RM_ENG = `
  if (!currentClientName) applyEngagementByCode('NWF01');
`;

/* Six use cases across four departments. Chosen so the Dependencies tab has
 * something to say: w2 needs w1 and d1 (both selected → "In roadmap"), and w5
 * needs w3 (not selected → an unresolved hard prerequisite). */
const RM_SELECT = `${RM_ENG}
  ['d1','w1','w2','w5','t3','c1'].forEach(function (id) { if (!selected[id]) toggleUc(id); });
`;

/* Consultant-entered implementation stages + a target completion, then Confirm
 * — the third gate, done the way the product does it. */
const RM_STAGES = `${RM_SELECT}
  var PLAN = {
    d1: { t: '9',  s: [['Data assessment and history clean-up','3-4 mo',true,'Two years of movement and POS history pulled together and checked before anything is modelled.'],
                       ['Baseline statistical forecast','2 mo',false,'A simple forecast the planners can argue with, so the ML has something to beat.'],
                       ['ML model and accuracy review with planners','3 mo',false,'Weekly accuracy review with the planning team until they trust the number.']] },
    w1: { t: '6',  s: [['Variability study by SKU and depot','2 mo',false,'Where the buffers actually are today, and how much of that is habit.'],
                       ['Safety-stock policy agreed with Operations','1 mo',true,'The bands themselves, signed off by both regions before anything is automated.'],
                       ['Rollout to the two pilot depots','3 mo',false,'Doncaster and one southern site, with the old policy running alongside.']] },
    w2: { t: '12', s: [['Reorder-point integration with the WMS','4 mo',false,'Transactional write path with a rollback story on partial failure.'],
                       ['Exception-only approval workflow','3 mo',true,'The supervisor queue. A real workflow, not an inbox.'],
                       ['Depot-by-depot rollout','5 mo',false,'Override rate is the gate between each depot, not a date.']] },
    w5: { t: '18', s: [['Slotting layout baseline','4 mo',true,'Not on the roadmap yet — surfaced as a hard prerequisite on the Dependencies tab.'],
                       ['Robot/human safety case','5 mo',true,'Signed off before a single unit is on the floor.'],
                       ['Single-aisle pilot','4 mo',false,'One aisle, one shift pattern, measured against the aisle next to it.'],
                       ['Site rollout','5 mo',false,'The capital ask. Board approval sits in front of this stage.']] },
    t3: { t: '8',  s: [['Telematics feed into one place','3 mo',false,'Vehicle and driver-hours data landed where finance can read it.'],
                       ['Failure-mode labelling with the workshops','2 mo',false,'The fitters know what failed and why; nothing else does.'],
                       ['Maintenance scheduling change','3 mo',false,'Moving from interval-based to condition-based scheduling.']] },
    c1: { t: '10', s: [['Order-exception taxonomy','2 mo',false,'What actually goes wrong with an order, in the words customer service uses.'],
                       ['Assistant on the top three exception types','4 mo',false,'Narrow on purpose — three types cover most of the volume.'],
                       ['Customer-facing release','4 mo',true,'The first thing on this roadmap a customer sees. Handled accordingly.']] }
  };
  Object.keys(PLAN).forEach(function (id) {
    setUcStages(id, {
      generatedAt: '2026-08-10T09:00:00.000Z',
      targetDuration: PLAN[id].t,
      confirmed: false,
      stages: PLAN[id].s.map(function (r, i) {
        return { id: 'st-' + id + '-' + i, name: r[0], duration: r[1], isGate: r[2], description: r[3] };
      })
    });
  });
  renderStagesTab();
`;

const RM_STAGES_CONFIRMED = `${RM_STAGES}
  Object.keys(PLAN).forEach(function (id) { confirmStages(id); });
`;

/* The synthesis the product stores after "Synthesise roadmap with AI".
 * Shape = what renderSynthesis() reads. */
const RM_SYNTH_OBJ = `{
  quickWins: ['Dynamic safety stock optimisation', 'Predictive vehicle maintenance'],
  criticalPath: 'Movement-data reconciliation, then an AI approver. Nothing downstream of either can ship until both are done, and neither is a build.',
  sharedInvestments: [
    { name: 'Automated movement reconciliation', detail: 'One reconciliation of depot, TMS and finance movement records, run nightly rather than at month end.',
      effort: '2 quarters, existing team', unlocks: ['AI demand forecasting','Dynamic safety stock optimisation','Autonomous replenishment','AI order management assistant'],
      phase: 'p1', constraintType: 'data', dimension: 'D1' },
    { name: 'Named AI approval owner and route', detail: 'One accountable owner and a one-page approval route for model deployment.',
      effort: 'Weeks, a naming decision', unlocks: ['Autonomous replenishment','AMR robot routing'],
      phase: 'p1', constraintType: 'regulatory', dimension: 'D6' },
    { name: 'Depot co-design forum', detail: 'Supervisors from both regions in the design of any change that lands on a shift.',
      effort: 'Ongoing, one day a month', unlocks: ['Autonomous replenishment','AMR robot routing','AI order management assistant'],
      phase: 'p1', constraintType: 'change', dimension: 'D7' },
    { name: 'Telematics into the finance estate', detail: 'Vehicle and driver-hours data landed where finance can read it.',
      effort: '1 quarter, vendor dependency', unlocks: ['Predictive vehicle maintenance'],
      phase: 'p2', constraintType: 'vendor', dimension: 'D2' }
  ],
  phases: [
    { phase: 'p1', label: 'Phase 1 — Fix the floor', timeframe: 'Months 1-9',
      theme: 'Nothing is built on a number nobody trusts.',
      investments: ['Automated movement reconciliation','Named AI approval owner and route','Depot co-design forum'],
      unlockedInitiatives: ['AI demand forecasting','Dynamic safety stock optimisation'],
      rationale: 'Both initiatives here consume reconciled movement data and neither needs a new platform. The approval owner is named in this phase because every later phase stalls at that gate.' },
    { phase: 'p2', label: 'Phase 2 — Automate the shift', timeframe: 'Months 10-21',
      theme: 'Take the manual handoffs out, with the depots in the room.',
      investments: ['Telematics into the finance estate'],
      unlockedInitiatives: ['Autonomous replenishment','Predictive vehicle maintenance','AI order management assistant'],
      rationale: 'Replenishment depends on safety-stock targets set in Phase 1. Predictive maintenance is independent of the reconciliation work and can run in parallel once telematics lands.' },
    { phase: 'p3', label: 'Phase 3 — Change the building', timeframe: 'Months 22-36',
      theme: 'Capital and physical change, once the operating model has been proven.',
      investments: [],
      unlockedInitiatives: ['AMR robot routing'],
      rationale: 'The only capital-heavy initiative, deliberately last. It also needs a slotting baseline that is not yet on the roadmap — surfaced on the Dependencies tab.' }
  ],
  constraints: [
    { type: 'capex', summary: 'AMR fleet is the only capital ask', impact: 'Approximately two-thirds of programme capital sits in one Phase 3 initiative.',
      mitigation: 'Take it to the board separately, after Phase 2 has evidence.' },
    { type: 'headcount', summary: 'One person is the utilisation reporting layer', impact: 'A weekly decision depends on a spreadsheet maintained by a single named individual.',
      mitigation: 'Second person trained in Phase 1, regardless of what else moves.' },
    { type: 'change', summary: 'Two failed TMS programmes', impact: 'Depot supervisors have worked around the last rollout and will do so again.',
      mitigation: 'Depot co-design forum is a Phase 1 investment, not a Phase 2 nicety.' },
    { type: 'data', summary: 'Month-end reconciliation', impact: 'Every downstream analytic inherits a month-end lag and a transcription error rate.',
      mitigation: 'The first shared investment; everything else waits on it.' }
  ],
  narrative: 'Northwind does not have a technology problem. It has one manual reconciliation step underneath every number the business argues about, and nobody empowered to approve an AI use case. Phase 1 fixes both, using the team that is already there, and unlocks demand forecasting and safety-stock optimisation as a by-product. Phase 2 takes the manual handoffs out of the shift, with depot supervisors in the design rather than on the receiving end of it — that is the lesson of the 2024 TMS programme, and it is the difference between adoption and another set of workarounds. Phase 3 is the only capital ask and is deliberately last: the AMR case is far easier to make with two phases of delivered evidence behind it. At month 36 the operation runs on daily numbers, has a named owner for model deployment, and has stopped re-keying movement data between three systems.'
}`;

const RM_GANTT_OBJ = `{
  totalMonths: 36,
  workstreams: [
    { label: 'Foundation', colour: '#378ADD', rows: [
      { id: 'f1', name: 'Automated movement reconciliation', startMonth: 1, durationMonths: 6, type: 'foundation', milestone: 'Nightly reconciliation live' },
      { id: 'f2', name: 'Named AI approval owner and route', startMonth: 1, durationMonths: 3, type: 'foundation', milestone: 'Approver named' },
      { id: 'f3', name: 'Telematics into the finance estate', startMonth: 7, durationMonths: 4, type: 'foundation' }
    ] },
    { label: 'Initiatives', colour: '#7F77DD', rows: [
      { id: 'i1', name: 'AI demand forecasting', startMonth: 7, durationMonths: 9, dependsOn: ['f1'] },
      { id: 'i2', name: 'Dynamic safety stock optimisation', startMonth: 7, durationMonths: 6, dependsOn: ['f1'] },
      { id: 'i3', name: 'Predictive vehicle maintenance', startMonth: 11, durationMonths: 8, dependsOn: ['f3'] },
      { id: 'i4', name: 'Autonomous replenishment', startMonth: 13, durationMonths: 12, dependsOn: ['i2','f2'], milestone: 'All depots live' },
      { id: 'i5', name: 'AI order management assistant', startMonth: 15, durationMonths: 10, dependsOn: ['f1'] },
      { id: 'i6', name: 'AMR robot routing', startMonth: 19, durationMonths: 18, dependsOn: ['f2'], milestone: 'First site at full throughput' }
    ] },
    { label: 'Change', colour: '#A88553', rows: [
      { id: 'c1r', name: 'Depot co-design forum', startMonth: 1, durationMonths: 36, type: 'change' },
      { id: 'c2r', name: 'Utilisation reporting key-person cover', startMonth: 2, durationMonths: 4, type: 'change' }
    ] }
  ]
}`;

const RM_SYNTH = `${RM_STAGES_CONFIRMED}
  synthesisResult = ${RM_SYNTH_OBJ};
  synthesisResult._selectedIds = Object.keys(selected).sort().join(',');
  showTab('roadmap');
  syncSynthOutput();
`;

const RM_GANTT = `${RM_SYNTH}
  ganttData = ${RM_GANTT_OBJ};
  renderGantt(ganttData, document.getElementById('gantt-output'));
`;

/* scrollIntoView() inside syncSynthOutput leaves .main part-scrolled. */
const RM_TOP = `var m = document.querySelector('.main'); if (m) m.scrollTop = 0;`;

const ROADMAP = [
  { id: '05-01-targets-tab', page: 'roadmap.html', title: 'Maturity targets — the tab you land on',
    viewport: { width: 1440, height: 1500 }, settle: 2500,
    note: 'The Roadmap Builder opens here on purpose. Before anything is selected or sequenced, the '
        + 'seven scores that came out of the interviews get looked at with the client. Everything on '
        + 'the later tabs is computed from these numbers, so an unchecked score becomes an unchecked plan.' },

  { id: '05-02-targets-gap-lists', page: 'roadmap.html', title: 'What it would take to move a score',
    viewport: { width: 1440, height: 2200 }, settle: 2500, after: 7000,
    prep: P(`${RM_ENG}
      showTab('targets');
      vyneStore.setItem('vynora_api_key', 'sk-ant-training-stub');
      return generateAllDimGaps();`),
    note: 'Each dimension gets a flat list of the specific capabilities that stand between the measured '
        + 'score and 5.0, each weighted in score points. Two different ticks: "we have this" corrects the '
        + 'measured score because the interview missed it, "we would do this" only moves a projection. '
        + 'Correcting a score here flows through to every other tab.' },

  { id: '05-03-maturity-sliders', page: 'roadmap.html', title: 'The measured scores in the rail',
    target: '.maturity-section', settle: 2500,
    note: 'The same seven scores as a set of sliders, carried on every tab, with the sector average and '
        + 'best-in-class marked against each. Drag one and the readiness percentages across the whole '
        + 'module move with it — useful for testing "what if we are wrong about D1" in front of a client.' },

  { id: '05-04-matrix-catalog', page: 'roadmap.html', title: 'Use case matrix — the catalog',
    viewport: { width: 1440, height: 1500 }, settle: 2500,
    prep: P(`${RM_ENG} showTab('matrix');`),
    note: 'The use-case library for this client\'s industry, grouped by department, plus a cross-industry '
        + 'layer. The industry is locked to the engagement, so a consultant cannot accidentally roadmap a '
        + 'logistics client against the healthcare catalog. Readiness on each card is this client\'s '
        + 'scores against that use case\'s capability requirements.' },

  { id: '05-05-matrix-selected', page: 'roadmap.html', title: 'Choosing what goes on the roadmap',
    viewport: { width: 1440, height: 1500 }, settle: 2500,
    prep: P(`${RM_SELECT} showTab('matrix');`),
    note: 'Ticking a use case is the decision the whole rest of the module hangs off. The counts on each '
        + 'department and the totals in the rail update as you go — how many are ready now and how many '
        + 'carry gaps — which is the conversation to have before the list gets any longer.' },

  { id: '05-06-matrix-subcases', page: 'roadmap.html', title: 'Scoping inside one initiative',
    viewport: { width: 1440, height: 1700 }, settle: 2500,
    prep: P(`${RM_SELECT} showTab('matrix'); toggleInit('d1');`),
    note: 'A use case is not one thing. Expanding it shows the sub-use cases it is made of, each of which '
        + 'can be taken in or out of scope, with the data each needs — and a consultant can add a '
        + 'client-specific one. This is where an initiative stops being a slogan and becomes defined work.' },

  { id: '05-07-matrix-filters', page: 'roadmap.html', title: 'Filtering the catalog',
    viewport: { width: 1440, height: 1500 }, settle: 2500,
    prep: P(`${RM_SELECT} showTab('matrix');
      var b = document.querySelector('.f-btn[data-f="ready"]'); setFilter('ready', b);`),
    note: 'The filters are the shortlist arguments a consultant has to make anyway: quick wins, high '
        + 'impact, ready now, blocked on data, blocked on people. Useful for steering a workshop away from '
        + 'the initiative everyone likes and towards the one that can actually start.' },

  { id: '05-08-uc-detail', page: 'roadmap.html', title: 'One use case, in detail',
    target: '#uc-detail-panel', viewport: { width: 1440, height: 1450 }, settle: 2500,
    prep: P(`${RM_SELECT} showTab('matrix');
      var _uc = getUc('w2'), _dept = getDeptForUc('w2');
      detailCache[_uc.id] = renderDetailHtml(_uc, ${JSON.stringify({
        detailedDescription:
          'Autonomous replenishment moves the purchase-order decision from a weekly planner cycle to a '
          + 'continuous one. A reorder signal — on-hand plus in-transit falling through a reorder point — '
          + 'is evaluated against forecast demand and the current supplier lead time, and an order is '
          + 'proposed with the reasoning attached.\n\n'
          + 'Anything inside the safety-stock and value bands the business has agreed is raised '
          + 'automatically and logged. Anything outside them is held for a named human. That split is the '
          + 'whole design: the value is in the orders nobody has to look at, and the safety is in the '
          + 'ones that are never raised without somebody looking.\n\n'
          + 'It needs reliable movement data, observed rather than contractual lead times, and a '
          + 'transactional write path into the warehouse system. The implementation risk sits in the '
          + 'exception workflow and in whether the operation accepts the bands, not in the model.',
        keyCapabilities: [
          'Continuous evaluation of reorder signals rather than a weekly planning cycle',
          'Automatic raising inside agreed safety-stock and value bands, with a full audit record',
          'Exception queue for anything outside the bands, routed to a named approver',
          'Capture of every override and its reason, as the feedback loop back into the model',
        ],
        typicalROI: { metric: 'Planner time on order raising', range: 'Typically a two-thirds reduction where bands are agreed and data is reliable', timeToValue: '2-3 quarters to first automated depot' },
        implementationStages: [
          { stage: 'Bands and baseline', duration: '2-3 months', description: 'Agree safety-stock and value bands with the operation, and instrument observed lead times.' },
          { stage: 'Shadow', duration: '2 months', description: 'Generate proposals against live data, raise nothing, compare with what planners actually did.' },
          { stage: 'Canary', duration: '2 months', description: 'One site, one product velocity band, automatic raising switched on inside the bands.' },
          { stage: 'Rollout', duration: '5-6 months', description: 'Site by site, with the override rate as the gate between each step rather than a date.' },
        ],
        commonPitfalls: [
          'Bands set centrally without the sites, so the exception queue fills and everything is overridden',
          'Contractual lead times used instead of observed ones, which makes every proposal wrong in the same direction',
          'No transactional rollback on the write path, so a partial failure leaves the order raised in one system only',
          'No named approver for model changes, so the thing works in pilot and never reaches production',
        ],
        vendorLandscape:
          'Off-the-shelf replenishment products carry their own policy model, which is the part an '
          + 'operation is least willing to adopt; the orchestration and the model behind a custom build '
          + 'are increasingly commodity. The integration into the warehouse system and the exception '
          + 'workflow are the parts that genuinely have to be built for this client either way.',
      })});
      openUcDetail(_uc, _dept);`),
    note: 'Clicking a use case name opens its briefing panel: what it actually is, the capabilities it '
        + 'delivers, industry-typical ROI framed as an estimate rather than this client\'s number, the '
        + 'stages it usually runs in, the ways it usually fails, and a build-versus-buy view. It is what '
        + 'you read before defending the initiative in front of the client, not something to present.' },

  { id: '05-09-stages-entered', page: 'roadmap.html', title: 'Implementation stages — entered, not yet confirmed',
    viewport: { width: 1440, height: 1150 }, settle: 2500,
    prep: P(`${RM_STAGES} showTab('stages');`),
    note: 'Every selected use case needs an end-to-end target duration. Durations exist here but nobody '
        + 'has confirmed them, so the bar reads 0% and the Roadmap tab is still greyed out. Confirming is '
        + 'a deliberate act, because the sequencing is only as good as the number somebody stood behind.' },

  { id: '05-10-stages-card', page: 'roadmap.html', title: 'Setting a duration and marking the gates',
    viewport: { width: 1440, height: 1700 }, settle: 2500,
    prep: P(`${RM_STAGES} showTab('stages'); toggleStageCard('w2');`),
    note: 'Target completion is the figure the roadmap sequences on — end to end, not the sum of the '
        + 'stages, because stages overlap. Ticking "Gate" marks a stage that cannot be compressed or run '
        + 'in parallel, which is what makes the critical path honest rather than optimistic.' },

  { id: '05-11-stages-confirmed', page: 'roadmap.html', title: 'All stages confirmed',
    viewport: { width: 1440, height: 1300 }, settle: 2500,
    prep: P(`${RM_STAGES_CONFIRMED} showTab('stages');`),
    note: 'Once every card is confirmed the bar reads 100% and the Roadmap tab lights up. Editing any '
        + 'duration afterwards re-opens that card for confirmation and re-locks the tab — the plan cannot '
        + 'drift away from what was agreed without somebody re-agreeing it.' },

  { id: '05-12-gap-analysis', page: 'roadmap.html', title: 'Gap analysis — what is in the way',
    viewport: { width: 1440, height: 2200 }, settle: 2500,
    prep: P(`${RM_SELECT} showTab('gap');`),
    note: 'For each selected use case, the capability areas where this client sits below what the use case '
        + 'needs. Common gaps are pulled out at the top because the same missing capability usually blocks '
        + 'four initiatives at once, and fixing it once is the whole argument for sequencing.' },

  { id: '05-13-gap-card', page: 'roadmap.html', title: 'One gap card, with its capability checklist',
    target: '.gap-card', viewport: { width: 1440, height: 1800 }, settle: 2500,
    prep: P(`${RM_SELECT} showTab('gap');
      if (typeof openChecklists !== 'undefined') openChecklists.add('w2');
      renderGapAnalysis();`),
    note: 'Scores are survey averages, not ground truth. The checklist lets the consultant tick off what '
        + 'the client demonstrably already has, and the readiness ring recalculates on the spot. Without '
        + 'that correction, one low interview score permanently overstates the work.' },

  { id: '05-14-dependencies', page: 'roadmap.html', title: 'Dependencies between initiatives',
    viewport: { width: 1440, height: 1400 }, settle: 2500,
    prep: P(`${RM_SELECT} showTab('deps');`),
    note: 'Hard prerequisites, from the built-in library rather than a model call. Each one is either '
        + 'already on the roadmap, already in place at the client, or not present — and a "not present" '
        + 'prerequisite is the most common reason a plausible-looking roadmap fails in month four.' },

  { id: '05-15-gate-1-nothing-selected', page: 'roadmap.html', title: 'Gate 1 — Roadmap locked: nothing selected',
    settle: 2500, after: 1200,
    prep: P(`${RM_ENG} showTab('roadmap');`),
    note: 'Clicking Roadmap & Synthesis with nothing selected does not open it. It sends you to the Use '
        + 'case matrix and says why. This is the first of three gates and the one every consultant meets '
        + 'on day one: there is no roadmap until somebody has decided what is on it.' },

  { id: '05-16-gate-2-requirements', page: 'roadmap.html', title: 'Gate 2 — Roadmap locked: requirements not confirmed',
    settle: 2500, after: 1200,
    prep: P(`${RM_ENG}
      ['d1','d4'].forEach(function (id) { if (!selected[id]) toggleUc(id); });
      showTab('roadmap');`),
    note: 'The second gate. A use case with no industry-calibrated capability profile is running on a '
        + 'generic default, so its readiness percentage is not trustworthy. The tab stays shut and sends '
        + 'you to Gap analysis to generate and confirm requirements for the ones that need it.' },

  { id: '05-17-gate-3-stages', page: 'roadmap.html', title: 'Gate 3 — Roadmap locked: stages not confirmed',
    settle: 2500, after: 1200,
    prep: P(`${RM_SELECT} showTab('roadmap');`),
    note: 'The third gate. Every selected use case has a valid profile but no confirmed duration, so there '
        + 'is nothing to sequence. The toast names how many are outstanding and which ones, and drops you '
        + 'on Implementation stages. Three gates, always in that order: selection, requirements, durations.' },

  { id: '05-18-roadmap-unlocked', page: 'roadmap.html', title: 'Roadmap & Synthesis, unlocked',
    viewport: { width: 1440, height: 1100 }, settle: 2500,
    prep: P(`${RM_STAGES_CONFIRMED} showTab('roadmap');`),
    note: 'With all three gates open the tab renders. The impact/complexity matrix is the selection '
        + 'plotted against itself; nothing here has been generated yet, and the deck export is still '
        + 'disabled. This is the state to be in before spending a synthesis call.' },

  { id: '05-19-roadmap-synthesis', page: 'roadmap.html', title: 'The synthesised roadmap',
    viewport: { width: 1440, height: 2600 }, settle: 2500,
    prep: P(`${RM_SYNTH} ${RM_TOP}`),
    note: 'The synthesis is the argument, not the list: quick wins, the critical path, the capability '
        + 'investments that unlock more than one initiative, the phases and what each unlocks, and an '
        + 'executive narrative. Read the shared investments table first — that is where the sequencing '
        + 'case is actually made.' },

  { id: '05-20-roadmap-gantt', page: 'roadmap.html', title: 'The 36-month delivery Gantt',
    target: '.gantt-wrap', settle: 2500,
    prep: P(`${RM_GANTT}`),
    note: 'The same plan as a timeline, in workstreams, with dependency arrows and milestone diamonds. It '
        + 'scrolls sideways across the three years. Bars are draggable and resizable in front of the '
        + 'client, and confirmed dependencies are re-enforced after a drag so the sequencing cannot be '
        + 'quietly broken.' },

  { id: '05-21-deck-export', page: 'roadmap.html', title: 'Exporting the AI Strategy Deck',
    target: '.synth-btn-wrap', settle: 2500,
    prep: P(`${RM_SYNTH}`),
    note: 'The deck export is enabled only once a synthesis exists. Two versions: client-ready, which '
        + 'carries no individual attribution, and internal, which keeps the per-person detail. Choose '
        + 'before exporting — this is the control that decides what leaves the building.' },
];

/* ══════════════════════════════════════════════════════════════════════════
   B. solution_design.html
   ══════════════════════════════════════════════════════════════════════════ */

/* The Studio reads the Roadmap Builder's published selection out of
 * vynora_roadmap_state. Writing that partition and re-reading it is exactly
 * what roadmap.html's publishUcMeta() does on the other side. */
const SD_ROADMAP = `
  var meta = {
    w2: { name:'Autonomous replenishment', desc:'AI triggers POs automatically, human approval for exceptions only',
          dept:'Inventory & Warehouse', impact:'high', complexity:'medium', value:'Planner productivity 3x', phase:'p1' },
    d1: { name:'AI demand forecasting', desc:'ML combining POS, weather, events to predict SKU/location demand',
          dept:'Demand Planning', impact:'high', complexity:'medium', value:'Inventory -20%', phase:'p1' },
    t3: { name:'Predictive vehicle maintenance', desc:'Predict component failure before it happens from telematics',
          dept:'Transportation & Fleet', impact:'high', complexity:'medium', value:'Downtime -25%', phase:'p1' },
    c1: { name:'AI order management assistant', desc:'Assistant handles order exceptions and status questions',
          dept:'Customer & Order Management', impact:'high', complexity:'medium', value:'Service cost -20%', phase:'p2' }
  };
  vyneStore.setItem('vynora_roadmap_state', JSON.stringify({ byEng: { eng_NWF01: {
    selected: { w2:true, d1:true, t3:true, c1:true },
    ucMeta: meta,
    industryLabel: 'Logistics & Supply Chain',
    maturityScores: { D1:2.4, D2:3.5, D3:3.6, D4:2.3, D5:2.2, D6:1.6, D7:2.5 },
    savedAt: '2026-08-12T16:00:00.000Z'
  } } }));
  state.roadmap = readRoadmapSelection();
  renderRoadmapList(); updateRoadmapBanner(); renderRail(); loadActiveIntoUI();
`;

const SD_PORTFOLIO = `${SD_ROADMAP}
  syncFromRoadmap(true);
  renderRail(); renderRoadmapList(); updateRoadmapBanner(); updatePortfolioBadge(); loadActiveIntoUI();
  var w2 = state.items.filter(function (x) { return x.snapData && x.snapData.ucId === 'w2'; })[0];
  if (w2) selectItem(w2.id);
`;

const SD_INTAKE = `${SD_PORTFOLIO}
  var it = cur();
  it.intake = { output:'task', sources:'many', actions:'writes-and-actions', human:'advisory',
                latency:'interactive',
                constraints:'Must run inside their Azure tenant. Depot supervisors approve every exception; no unattended writes to the WMS.' };
  document.getElementById('constraints').value = it.intake.constraints;
  loadActiveIntoUI();
`;

const SD_PROPOSAL = `${SD_INTAKE}
  proposePattern();
`;

const SD_CONFIRMED = `${SD_PROPOSAL}
  confirmPattern();
`;

/* The brief the product stores after "Generate design brief" — one entry per
 * slot of the confirmed orchestrator pattern, in slot order. */
const SD_BRIEF_OBJ = `{
  generatedAt: '2026-08-13T10:12:00.000Z',
  patternId: 'orchestrator',
  architecture: [
    { slotType:'orchestrator-core', label:'Replenishment planner', role:'Takes a depot/SKU reorder signal and decides which checks this order needs before it can be raised.' },
    { slotType:'subagent-slot', label:'Stock, demand and supplier checks', role:'Three parallel look-ups: on-hand and in-transit, forecast demand, supplier lead time and current risk.' },
    { slotType:'reasoning-core', label:'Order quantity and timing decision', role:'Reconciles the three views into a proposed quantity and date, with the reasoning attached.' },
    { slotType:'reflection-slot', label:'Sanity check against policy', role:'Re-checks the proposal against safety-stock policy and budget bands before it leaves the system.' },
    { slotType:'human-review-slot', label:'Depot supervisor exception queue', role:'Anything outside the agreed bands waits here for a named supervisor; everything inside them does not.' },
    { slotType:'memory-slot', label:'Order and override history', role:'What was proposed, what was approved, and what the supervisor changed — the record the model learns from.' },
    { slotType:'systems-connector', label:'WMS and TMS write-back', role:'Raises the purchase order and updates the movement record in one transaction.' },
    { slotType:'guardrail-layer', label:'Value and volume ceilings', role:'Hard caps on order value and quantity that no proposal can cross regardless of what the model concluded.' }
  ],
  buildEffort: {
    summary: 'Three of the four data look-ups already exist in some form; the demand feed is the one that has to be built, and it depends on the reconciliation work already on the roadmap. The human-exception queue is a bigger piece of work than the model — it needs a real workflow, not an inbox.',
    prerequisites: ['Reconciled movement data','Agreed safety-stock policy per SKU band','Supplier lead-time data with a known refresh','Named approver for exception decisions','WMS write API with transactional semantics']
  },
  vynoraHelp: [
    'Feature and schema design against Northwind\\u2019s actual movement records — the studio has never seen them, and the reconciliation gap is the reason this use case is phased where it is.',
    'Validating the generated governance, MLOps and runbook drafts against Northwind\\u2019s real approval thresholds and the two regional operating models.',
    'Running the depot co-design sessions so the exception queue is designed with supervisors rather than delivered to them.',
    'Standing up the exception workflow and the WMS integration, and training the planners who inherit it.'
  ],
  truncated: false
}`;

/* A loaded Vynora tool catalog — the same shape "Load catalog" reads. */
const SD_CATALOG_OBJ = `{
  'orchestrator-core': [
    { name:'Managed agent-orchestration service', note:'Hosted planner/dispatcher with built-in tracing; least to operate.', platforms:['azure','aws','gcp'] },
    { name:'Open-source agent framework', note:'Full control of the planning loop; you own the observability.', platforms:['agnostic'] }
  ],
  'subagent-slot': [
    { name:'Serverless function per check', note:'Each look-up is independently deployable and independently rate-limited.', platforms:['azure','aws','gcp'] },
    { name:'Workflow-engine task', note:'Fits where the client already runs a workflow engine for other automation.', platforms:['agnostic'] }
  ],
  'reasoning-core': [
    { name:'Hosted frontier LLM', note:'Strongest reconciliation across conflicting inputs; per-call cost to model.', platforms:['azure','aws','gcp'] },
    { name:'Smaller instruction-tuned model', note:'Adequate once the decision is bounded by policy; materially cheaper at volume.', platforms:['agnostic'] }
  ],
  'reflection-slot': [
    { name:'Rules engine', note:'Policy checks are deterministic — do not spend a model call on them.', platforms:['agnostic'] }
  ],
  'human-review-slot': [
    { name:'Existing WMS exception queue', note:'Supervisors already live here; adding a queue elsewhere splits attention.', platforms:['agnostic'] },
    { name:'Workflow platform approval step', note:'Better audit trail, at the cost of a second place to look.', platforms:['azure','aws','agnostic'] }
  ],
  'memory-slot': [
    { name:'Relational store on the existing estate', note:'Order and override history is structured; a vector store buys nothing here.', platforms:['agnostic'] }
  ],
  'systems-connector': [
    { name:'WMS vendor API', note:'Transactional, supported, and the only path with a rollback story.', platforms:['agnostic'] },
    { name:'Integration platform connector', note:'Faster to build, weaker transactional guarantees on partial failure.', platforms:['azure','aws'] }
  ],
  'guardrail-layer': [
    { name:'Policy middleware in the write path', note:'Caps enforced where the write happens, not where the model runs.', platforms:['agnostic'] }
  ]
}`;

const SD_GOV_OBJ = `{
  summary: 'This use case raises purchase orders against a supplier, so the risk is financial and contractual rather than personal. The controls concentrate on the write path and the exception queue.',
  riskTier: { tier: 'Medium', why: 'It commits money automatically, but only inside bands a human agreed, and every order outside them is held.' },
  auditLogging: { events: [
    { event:'Order proposed', fields:'SKU, depot, quantity, date, the three inputs and the reasoning', retention:'[set: retention period — finance and audit to agree]' },
    { event:'Policy check result', fields:'Rule fired, pass/fail, band applied', retention:'[set: retention period]' },
    { event:'Supervisor decision', fields:'Approver, decision, any amended quantity, free-text reason', retention:'[set: retention period]' },
    { event:'Write to WMS/TMS', fields:'Order id, transaction id, success or rollback', retention:'[set: retention period]' }
  ] },
  fairness: { subject:'entities',
    rationale:'What matters here is whether the system works evenly across depots, SKU classes and suppliers rather than optimising the busiest lane.',
    concerns:['Southern depots have thinner history than northern ones after the 2024 rollout','Slow-moving SKUs are under-represented in any training window','Smaller suppliers have noisier lead-time data'],
    metrics:[
      { metric:'Order acceptance rate by depot', definition:'Share of proposals a supervisor accepts unchanged, per depot', threshold:'[set: acceptable spread across depots]' },
      { metric:'Stockout rate by SKU velocity band', definition:'Stockouts per 1,000 SKU-weeks, split by velocity band', threshold:'[set: threshold per band]' },
      { metric:'Lead-time error by supplier size', definition:'Mean absolute error on predicted lead time, banded by supplier volume', threshold:'[set: threshold]' }
    ],
    methods:['Report the three metrics on the same cadence as the S&OP cycle','Hold out one depot per region from any retrain and compare','Review with both regional MDs, not one'] },
  modelRisk: { controls: [
    { control:'Bounded autonomy', detail:'Value and quantity ceilings enforced in the write path, not the prompt', owner:'[set: owner — Head of Supply Chain Systems]' },
    { control:'Shadow period', detail:'Proposals generated but not raised for one full replenishment cycle per depot', owner:'[set: owner]' },
    { control:'Override capture', detail:'Every supervisor amendment recorded with a reason and reviewed monthly', owner:'[set: owner]' },
    { control:'Kill switch', detail:'A single control that returns every depot to manual ordering', owner:'[set: owner]' }
  ] },
  monitoring: { signals: [
    { signal:'Override rate', trigger:'Above the agreed band two weeks running', action:'Pause automatic raising for that depot and review' },
    { signal:'Supplier lead-time drift', trigger:'Predicted vs actual error doubles', action:'Fall back to contractual lead times until refit' },
    { signal:'Exception-queue age', trigger:'Anything older than one shift', action:'Escalate to the regional MD' }
  ] },
  approvalWorkflow: [
    'Proposal inside agreed bands raises automatically and is logged.',
    'Anything outside them holds in the depot supervisor queue.',
    'Value above the ceiling goes to the regional MD regardless of band.',
    'Model version changes go to the named AI approver before deployment — the role Northwind does not yet have.'
  ],
  regulatoryNotes: [
    'No personal data in the decision path; the driver-hours feed is deliberately not an input.',
    'Purchase commitments fall under existing delegated-authority policy — this does not create a new one, it automates inside it.'
  ],
  openDecisions: [
    'Who owns AI approval at Northwind — this is the gate every use case stalls at and nobody holds it today.',
    'The retention period for order and override records, which finance and audit have to agree jointly.',
    'The acceptable override rate before automatic raising is paused, per depot rather than group-wide.',
    'Whether the southern region runs the shadow period longer, given the 2024 history.'
  ]
}`;

const SD_MLOPS_OBJ = `{
  summary: 'Two models with different cadences sit behind this: a lead-time predictor that retrains on a schedule and a reasoning step that changes only when its prompt or model version does. Treat them separately.',
  trainingOrchestration: {
    schedule: '[set: retrain cadence — weekly is the starting assumption]',
    steps: ['Pull the reconciled movement window and supplier receipts',
            'Rebuild lead-time features per supplier and SKU band',
            'Retrain and evaluate against the held-out depot',
            'Compare to the incumbent on the same window before promotion',
            'Register the candidate with its evaluation attached']
  },
  modelRegistry: { practices: [
    'Every promoted version carries the data window it was trained on',
    'Prompt and model version for the reasoning step are registered like a model, not edited in place',
    'Promotion requires the named AI approver — the same gate as governance',
    'Rollback target is always the last version that ran a clean cycle'
  ] },
  cicd: { stages: [
    { stage:'Pre-merge', detail:'Unit tests on the policy rules and the write-path caps' },
    { stage:'Integration', detail:'Full proposal-to-write cycle against a WMS sandbox' },
    { stage:'Shadow', detail:'Proposals generated against live data, no writes, compared to what planners did' },
    { stage:'Canary', detail:'One depot, one SKU band, automatic raising enabled' },
    { stage:'Promote', detail:'Depot-by-depot, with the override rate as the gate between each' }
  ] },
  environments: [
    { env:'dev', purpose:'Model and prompt iteration against a fixed extract' },
    { env:'staging', purpose:'WMS sandbox, full cycle, no real orders' },
    { env:'prod-shadow', purpose:'Live data, proposals logged, nothing raised' },
    { env:'prod', purpose:'Automatic raising inside agreed bands' }
  ],
  deployment: { strategy:'Depot-by-depot canary', detail:'Each depot enters shadow, then canary on one SKU band, then full. The override rate is the gate at each step, not a date.' },
  rollback: { trigger:'Override rate outside band, or any write that fails to roll back cleanly',
    procedure:['Disable automatic raising group-wide via the kill switch',
               'Return the affected depots to the previous registered version',
               'Replay the affected orders from the audit log',
               'Hold the post-incident review with both regions, not one'] },
  openDecisions: [
    'Who owns the retrain cadence and the promotion decision once the AI approver role exists.',
    'Whether the WMS sandbox is refreshed often enough to be a meaningful staging environment — today it is not.',
    'Which depot is permanently held out of training so there is always an untouched comparison.'
  ]
}`;

const SD_RUNBOOK_OBJ = `{
  summary: 'Day to day this is a queue and two dashboards. The handoff that matters is to the depot supervisors, who inherit the exception queue, and to the planners, whose job changes shape rather than disappearing.',
  routineOps: [
    { task:'Clear the exception queue', cadence:'Every shift', detail:'Depot supervisor; anything older than one shift escalates' },
    { task:'Review override reasons', cadence:'Weekly', detail:'Planner and supervisor together — the reasons are the model\\u2019s feedback loop' },
    { task:'Check lead-time drift', cadence:'Weekly', detail:'Predicted vs actual by supplier; falls back to contractual on a doubling' },
    { task:'Reconcile raised orders against movement records', cadence:'Daily', detail:'The same reconciliation the roadmap automates — this is its first consumer' }
  ],
  monitoring: [
    { what:'Exception-queue depth and age', healthySignal:'Cleared within the shift', whereToLook:'[set: client dashboard]' },
    { what:'Automatic raise rate', healthySignal:'Stable per depot week to week', whereToLook:'[set: client dashboard]' },
    { what:'Write failures and rollbacks', healthySignal:'Zero unresolved', whereToLook:'[set: client logging platform]' },
    { what:'Model and prompt version in use', healthySignal:'Matches the registered promotion', whereToLook:'[set: client registry]' }
  ],
  incidents: [
    { symptom:'Orders raised at the wrong quantity across one depot', likelyCause:'Safety-stock policy changed without the band being updated', response:'Kill switch for that depot, correct the band, replay from the audit log' },
    { symptom:'Exception queue growing through the shift', likelyCause:'Supplier data stale, so everything falls outside band', response:'Fall back to contractual lead times, notify the supervisor, refit' },
    { symptom:'Write succeeds in WMS but not TMS', likelyCause:'Partial transaction on the connector', response:'Roll back the WMS side, raise manually, do not retry automatically' },
    { symptom:'Supervisors overriding almost everything', likelyCause:'Bands set without them — the 2024 pattern', response:'Pause automatic raising, re-run the co-design session' }
  ],
  escalation: [
    'Tier 1 — depot supervisor, within the shift',
    'Tier 2 — regional planning lead, same day',
    'Tier 3 — Head of Supply Chain Systems and the AI approver, for anything touching the write path'
  ],
  handoffChecklist: [
    'Supervisors in both regions have run the queue for one full cycle unaided',
    'The kill switch has been tested by the team who would have to use it',
    'Override reasons are being written in words, not codes',
    'The rollback procedure has been rehearsed against the sandbox',
    'Named owners exist for every [set: owner] placeholder in this pack'
  ],
  openDecisions: [
    'Who is on call for the write path outside depot hours, and to what SLA.',
    'Whether the regional planning leads or the group function own tier 2.',
    'The agreed override rate that triggers a pause, per depot.'
  ]
}`;

const SD_SOURCING_OBJ = `{
  generatedAt: '2026-08-13T10:40:00.000Z',
  model: 'stub',
  evidenceBasis: { hadEvidence: true, interviewCount: 5, rolesInterviewed: ['CEO','CTO','CFO','VP_Operations'],
                   hasScores: true, confirmedFindingCount: 3, hasSynthesis: true },
  doc: {
    problemStatement: 'Replenishment decisions at Northwind are made weekly from a spreadsheet by a small number of planners, against movement data that is reconciled by hand at month end. The decision is late, the inputs are stale, and the people who see the consequences on the shift floor have no part in it.',
    currentStateBasis: 'evidenced',
    currentState: 'Planners raise purchase orders on a weekly cycle using on-hand figures from the WMS and a utilisation spreadsheet maintained by one person. Supplier lead times are contractual rather than observed. Depot supervisors see the result as arriving stock, not as a decision they influenced.',
    targetState: 'Reorder signals are evaluated continuously. Anything inside agreed safety-stock and value bands raises automatically with a full record of why; anything outside them lands in a named supervisor\\u2019s exception queue within the shift. Planners move from raising orders to setting and reviewing the bands.',
    recommendation: { approach: 'partner',
      rationale: 'The orchestration and the model are not the hard part and are increasingly commodity. The hard parts are the WMS write path, the exception workflow, and getting the depots to own the bands — all of which need people who know Northwind. Buying an off-the-shelf replenishment product would mean adopting its policy model, which is the one thing the last two programmes proved Northwind will reject.' },
    dataAndIntegrationRequirements: [
      'Reconciled movement data — the shared investment already sequenced in Phase 1 of the roadmap.',
      'Observed supplier lead times with a known refresh, not contractual figures.',
      'A transactional write path to the WMS with a rollback story on partial failure.',
      'Safety-stock bands per SKU velocity band, agreed and versioned rather than held in a spreadsheet.'
    ],
    phasedPlan: [
      { phase:1, name:'Bands and baseline', description:'Agree safety-stock and value bands with both regions; instrument observed lead times.', durationWeeks:10, assumed:false },
      { phase:2, name:'Shadow', description:'Generate proposals against live data, raise nothing, compare to what planners actually did.', durationWeeks:8, assumed:false },
      { phase:3, name:'Canary', description:'One depot, one velocity band, automatic raising inside the bands.', durationWeeks:8, assumed:true },
      { phase:4, name:'Rollout', description:'Depot by depot, override rate as the gate between each step.', durationWeeks:22, assumed:true }
    ],
    risksAndDependencies: [
      { risk:'Movement reconciliation slips', mitigation:'This initiative does not start Phase 2 until reconciliation is live; it is the roadmap dependency, not a caveat.' },
      { risk:'Depots reject the bands as done to them', mitigation:'Bands are set in the co-design forum in Phase 1, before any model exists.' },
      { risk:'No named AI approver', mitigation:'Escalate as a Phase 1 naming decision; nothing here can be promoted to production without it.' },
      { risk:'Key-person dependency on the utilisation spreadsheet', mitigation:'Second person trained during Phase 1 regardless of this initiative.' }
    ],
    successMetrics: [
      { metric:'Share of orders raised without human touch', target:'[set: target with Operations]', assumed:true },
      { metric:'Planner hours per week on order raising', target:'Down by two-thirds', assumed:true },
      { metric:'Stockouts per 1,000 SKU-weeks', target:'No worse than baseline in shadow; better by rollout', assumed:false },
      { metric:'Exception-queue age', target:'Cleared within the shift', assumed:false }
    ],
    evidenceUsed: [
      'CEO and CTO both described the same month-end manual reconciliation, unprompted.',
      'Both VP Operations raised the 2024 TMS rollout without being asked about it.',
      'D6 measured at 1.6 — there is no model inventory and no approval gate.'
    ],
    assumptions: [
      'That the WMS exposes a transactional write API; this was not confirmed in any interview.',
      'That supplier lead-time data is retrievable per receipt rather than only contractually.',
      'That the two regions will accept one set of bands rather than one each.'
    ]
  }
}`;

const SD_BRIEF = `${SD_CONFIRMED}
  var it = cur();
  it.brief = ${SD_BRIEF_OBJ};
  state.toolCatalog = ${SD_CATALOG_OBJ};
  state.catalogMeta = { loadedFrom: 'VYNE_ToolCatalog.json', savedAt: '2026-08-01T09:00:00.000Z' };
  it.toolPlatform = 'azure';
  it.governance = ${SD_GOV_OBJ};
  it.mlops = ${SD_MLOPS_OBJ};
  it.runbook = ${SD_RUNBOOK_OBJ};
  it.sourcing = ${SD_SOURCING_OBJ};
  updateCatalogBadge();
  document.getElementById('block-brief').classList.remove('hidden');
  renderBrief();
  syncReady();
`;

/* Brief parts ship collapsed — open the one being shot. The sticky action bar
 * is hidden for panel shots only: it is fixed to the viewport and would sit
 * across the middle of an element capture. */
const openPart = (pid) => `toggleBriefPart('${pid}');
  var ab = document.querySelector('.actionbar'); if (ab) ab.style.display = 'none';`;

const DESIGN = [
  { id: '06-01-roadmap-handoff', page: 'solution_design.html', title: 'What the Roadmap Builder pushed across', full: true,
    settle: 2000,
    prep: P(SD_ROADMAP),
    note: 'The Studio does not have its own use-case list. It reads whatever this client has selected in '
        + 'the Roadmap Builder, with the department, impact, value and diagnostic scores attached, and '
        + 'offers them in a banner. One catalog, two modules — they cannot drift apart.' },

  { id: '06-02-portfolio', page: 'solution_design.html', title: 'The portfolio for this client', full: true,
    settle: 2000,
    prep: P(SD_PORTFOLIO),
    note: 'On first open the portfolio IS the roadmap selection. After that it belongs to the consultant: '
        + 'new roadmap selections are offered, never merged in behind your back, and a removal is never '
        + 'undone. Each use case carries its own intake, pattern and brief, and is worked in turn.' },

  { id: '06-03-intake', page: 'solution_design.html', title: 'The five-question design intake', full: true,
    settle: 2000,
    prep: P(SD_INTAKE),
    note: 'Five questions, and the routing that follows is fully deterministic from the answers — no model '
        + 'decides the pattern. Get these wrong and everything downstream is wrong, so they are worth '
        + 'arguing about with the client rather than guessing at.' },

  { id: '06-04-pattern-proposal', page: 'solution_design.html', title: 'The recommended pattern and why',
    target: '#block-proposal', settle: 2000,
    prep: P(`${SD_PROPOSAL}
      var ab = document.querySelector('.actionbar'); if (ab) ab.style.display = 'none';`),
    note: 'The routing shows its working: each line is the intake answer that drove it. Alternatives that '
        + 'also matched are offered, and any pattern can be forced — but an override is labelled as one '
        + 'for whoever reads the brief later. Confirmation is required before a brief is generated.' },

  { id: '06-05-brief', page: 'solution_design.html', title: 'The ten-part design brief', full: true,
    settle: 2000,
    prep: P(`${SD_BRIEF}
      ['bp-1','bp-4','bp-5'].forEach(function (p) { toggleBriefPart(p); });`),
    note: 'Ten parts, collapsed by default because nobody reads all of them at once. Parts 1 to 6 come '
        + 'with the brief; the tool shortlist, governance, MLOps, runbook and sourcing sections are '
        + 'generated on demand, so a consultant only spends on the ones this engagement needs.' },

  { id: '06-06-architecture', page: 'solution_design.html', title: 'Reference architecture — structure view',
    target: '#arch-view', settle: 2000,
    prep: P(`${SD_BRIEF} ${openPart('bp-2')}`),
    note: 'Tool-agnostic by design: components and how they connect, no vendor names. The layout is '
        + 'authored per pattern and only the labels come from the model, so the diagram cannot be '
        + 'nonsense. Every box is clickable, and the whole thing downloads as SVG for a deck.' },

  { id: '06-07-drill-detail', page: 'solution_design.html', title: 'Drilling into one component',
    target: '#drill-panel', settle: 2000,
    prep: P(`${SD_BRIEF} ${openPart('bp-2')} drillComp('human-review-slot');`),
    note: 'Level one: what triggers this component, what it is responsible for, and what goes in and out. '
        + 'The trigger and responsibility are authored and role-generic; the "in this use case" line is '
        + 'the part that came from the brief. The labelling of which is which is deliberate.' },

  { id: '06-08-drill-control-flow', page: 'solution_design.html', title: 'The component’s control flow',
    target: '#drill-panel', settle: 2000,
    prep: P(`${SD_BRIEF} ${openPart('bp-2')} drillComp('orchestrator-core'); drillDepth(2);`),
    note: 'Level two: the internal steps and the branches, including what happens when something fails. '
        + 'This is the level an engineer starts asking real questions at, and it is deterministic — the '
        + 'same for every use case that uses this component.' },

  { id: '06-09-workflow-view', page: 'solution_design.html', title: 'Workflow view and platform mapping',
    target: '#arch-view', settle: 2000,
    prep: P(`${SD_BRIEF} ${openPart('bp-2')} setArchView('flow');`),
    note: 'The same design as an ordered sequence, mapped across n8n, Make, Airflow and plain code. The '
        + 'point of the table is that the design survives the client having already chosen a platform — '
        + 'you read across rather than redesigning.' },

  { id: '06-10-workflow-drill', page: 'solution_design.html', title: 'One workflow step, per platform',
    target: '#wf-drill-panel', settle: 2000,
    prep: P(`${SD_BRIEF} ${openPart('bp-2')} setArchView('flow'); wfDrill('human-gate');`),
    note: 'Clicking a step gives the per-platform implementation detail for it, including the trap on each '
        + 'platform. Authored fact, not generated — which is why it is safe to hand to an engineer who is '
        + 'going to build it that afternoon.' },

  { id: '06-11-tool-shortlist', page: 'solution_design.html', title: 'Tool and technology shortlist',
    target: '#bp-3-body', settle: 2000,
    prep: P(`${SD_BRIEF} ${openPart('bp-3')}`),
    note: 'Vendor choices come last, per architecture slot, filtered to the platform the client actually '
        + 'runs. Entries from a loaded Vynora catalog are marked curated; anything the model suggested is '
        + 'marked as a candidate to verify. That distinction is the point of the section.' },

  { id: '06-12-governance', page: 'solution_design.html', title: 'Governance and assurance draft',
    target: '#gov-panel', settle: 2000,
    prep: P(`${SD_BRIEF} ${openPart('bp-7')}`),
    note: 'A first-draft governance framework: risk tier, audit events, fairness or coverage review, '
        + 'model-risk controls, monitoring and the approval route. Every red chip is a decision the client '
        + 'has to make and the chip says which. Do not present this as a finished compliance artifact.' },

  { id: '06-13-mlops', page: 'solution_design.html', title: 'MLOps workflow draft',
    target: '#mlops-panel', settle: 2000,
    prep: P(`${SD_BRIEF} ${openPart('bp-8')}`),
    note: 'How the thing gets retrained, registered, deployed and rolled back. Useful mostly as the list '
        + 'of questions the client’s platform team has not been asked yet — most engagements discover '
        + 'here that there is no promotion gate at all.' },

  { id: '06-14-runbook', page: 'solution_design.html', title: 'Runbooks and handoff pack',
    target: '#runbook-panel', settle: 2000,
    prep: P(`${SD_BRIEF} ${openPart('bp-9')}`),
    note: 'What running it looks like day to day: routine tasks, what healthy looks like, an incident '
        + 'playbook and the escalation path. Read the handoff checklist early — it is what the receiving '
        + 'team has to be able to do before you leave.' },

  { id: '06-15-sourcing', page: 'solution_design.html', title: 'Build, buy or partner',
    target: '#sourcing-panel', settle: 2000,
    prep: P(`${SD_BRIEF} ${openPart('bp-10')}`),
    note: 'The recommendation with its reasoning, a phased plan, risks and success metrics — and at the '
        + 'top, exactly what it was grounded in. "From this client’s diagnostic" means it came out of the '
        + 'interviews; "assumption" means the model inferred it. The narrative fields are editable and '
        + 'saved against this client, because this is the section that ends up in a proposal.' },

  { id: '06-16-export', page: 'solution_design.html', title: 'The export bar',
    target: '.topbar', settle: 2000,
    prep: P(SD_BRIEF),
    note: 'Export one brief or the whole portfolio as a print-ready document, export the session as JSON '
        + 'to hand to a colleague, and load or export the shared tool catalog. The platform already saves '
        + 'the work continuously — these are for getting it out, not for keeping it.' },
];

/* ══════════════════════════════════════════════════════════════════════════
   C. scorecard.html
   ══════════════════════════════════════════════════════════════════════════ */

const SCORECARD = [
  { id: '07-01-scorecard', page: 'scorecard.html', title: 'Portfolio scorecard (empty state)', full: true,
    settle: 2500,
    note: 'Every engagement in the firm, latest scored round, side by side, with the movement against the '
        + 'round before it. Owners see all clients; a scoped consultant sees only theirs. Nothing is '
        + 'listed until at least one engagement has a round with scores on it — which is the state shown '
        + 'here, and the one a new firm sees on day one.' },

  { id: '07-02-persona-tab', page: 'scorecard.html', title: 'Persona Simulator', full: true,
    settle: 2500,
    prep: P(`switchTab('persona');`),
    note: 'A sandbox for previewing how a role might answer before a real interview is booked. It writes '
        + 'nothing — not to the tracker, not to the engagement record, not to Synthesis. The client from '
        + 'the session is filled in for you; everything else is optional.' },

  { id: '07-03-persona-custom', page: 'scorecard.html', title: 'Simulating a custom persona', full: true,
    settle: 2500,
    prep: P(`switchTab('persona');
      document.getElementById('ps-role').value = 'VP Operations';
      document.getElementById('ps-industry').value = 'Logistics';
      document.getElementById('ps-name').value = 'Regional depot manager';
      document.getElementById('ps-bias').value = 'Sceptical after two failed TMS programmes; will not commit to anything the depots were not consulted on.';`),
    note: 'Either an existing role from the client’s briefing, or a persona described from scratch with '
        + 'its own bias. The second is the useful one: it lets a consultant rehearse the hostile interview '
        + 'before walking into it. It is a rehearsal, not evidence — nothing here reaches the scorecard.' },
];

export const SHOTS = [...ROADMAP, ...DESIGN, ...SCORECARD];

// CANNOT REACH (left out deliberately — none of these are faked):
//
// * roadmap.html — "Generate requirements" / "Confirm requirements" on a use
//   case running the generic default profile, i.e. gate 2 being CLEARED. The
//   LLM stub in harness.mjs returns one union object with no `requires` key,
//   and generateReqsFor() throws 'No requirements returned' on it. The gate is
//   captured LOCKED in 05-16, which is the state that needs explaining anyway.
//
// * roadmap.html — the AI Strategy Deck itself. exportStrategyDeck() builds a
//   .pptx with pptxgenjs and triggers a download; there is no on-screen render
//   to photograph. 05-21 captures the export controls and the client-ready /
//   internal choice, which is the decision that matters.
//
// * roadmap.html — "Generate stages", "Generate gaps for one dimension via the
//   per-card button" and "Regenerate dependencies with AI". All parse schemas
//   the stub does not return. The states they produce ARE captured (05-10,
//   05-11, 05-14) because stages can be entered by hand and dependencies come
//   from the built-in library, which is the no-API path the product ships.
//
// * roadmap.html — the "Companies that have done it" and "Industry benchmarks"
//   sections of #uc-detail-panel. Those name REAL companies and cite real
//   published figures; the stub cannot produce them and inventing them for a
//   document that leaves the building is exactly what the product's own prompt
//   forbids. 05-08 seeds every other section of the panel and leaves those two
//   out, so the shot shows the panel with two of its eight sections absent.
//
// * solution_design.html — the print-ready export view. exportActiveBrief()
//   calls window.open() and writes the document into the popup; the harness
//   screenshots one page and has no handle on a popup. 06-16 captures the
//   controls instead.
//
// * solution_design.html — "Suggest answers" on the intake, and "Generate
//   developer spec" at drill level 3. Both need JSON shapes the stub does not
//   return. The answered intake is captured in 06-03; it is filled in rather
//   than suggested.
//
// * solution_design.html — a REAL build/buy/partner generation. It posts to
//   /api/solution-design/generate, which the stub backend does not implement.
//   06-15 renders the stored document shape instead.
//
// * scorecard.html — the persona simulation RESULT. It posts to
//   /api/synthetic/persona-preview, which the stub backend does not implement,
//   so the run fails before anything renders. The form is captured filled in
//   (07-03) but not run.
//
// * scorecard.html — a POPULATED portfolio scorecard. The stub's /api/scorecard
//   returns { engagements: [], dimensionNames: {} }, so the page correctly
//   renders its empty state (07-01). To render populated it would need, per
//   engagement: { code, client, industry, roundNumber, roundLabel, roundDate,
//   interviewCount, scores:{D1..D7:number}, overall:number,
//   maturity:'AI-Native'|'AI-Led'|'AI Capable'|'AI Exploring'|'AI Unaware',
//   deltaOverall:number|null, deltaScores:{D1..D7:number} }, plus
//   dimensionNames:{D1:'Data & Data Management', ... D7:'Culture & Change
//   Readiness'} — the shape backend/src/routes/scorecard.ts buildScorecard()
//   produces from ENG_A / ENG_B.
