/**
 * THE TRAINING FIXTURE — one firm, two clients, one of them worked all the way
 * through, used to render every screen of the product with plausible content
 * for the training screenshots.
 *
 * It is DELIBERATELY not anyone's real engagement. Northwind Freight Group and
 * Harbourline Health are invented; the numbers are invented; every name is
 * invented. Screenshots taken from this go into a training document that leaves
 * the building, so no real client material may be in them.
 *
 * The shapes here are copied from the shapes the existing e2e suites already
 * assert against (synthesis-e2e, tracker-e2e, maturity-targets-e2e,
 * roadmap-client-isolation-e2e), so a screen that renders from this fixture is
 * rendering from the shape the product actually writes.
 */

export const FIRM = { email: 'consultant@meridianadvisory.com', role: 'owner' };

export const A = {
  name: 'Northwind Freight Group',
  norm: 'northwindfreightgroup',
  code: 'NWF01',
  industry: 'Logistics',
};

export const B = {
  name: 'Harbourline Health',
  norm: 'harbourlinehealth',
  code: 'HBL01',
  industry: 'Healthcare Payor',
};

const DIMS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'];

/* Round 1: five interviews, two of them VP Operations — the two-people-one-title
 * case is the single most important thing for a consultant to see working, so it
 * is in the training screenshots on purpose. */
const ROUND1_INTERVIEWS = [
  {
    role: 'CEO', interviewee: 'Marguerite Vance', name: 'Marguerite Vance',
    sourceInterviewId: 'iv-ceo', completedAt: '2026-07-14T10:00:00.000Z',
    scores: { D1: 2, D2: 3, D3: 4, D4: 2, D5: 2, D6: 1, D7: 2 },
    findings: [
      { dimension: 'D1', text: 'Freight movement data is reconciled by hand every month end' },
      { dimension: 'D6', text: 'Nobody owns AI policy; each region decides for itself' },
      { dimension: 'D7', text: 'Two failed TMS programmes have made the depots sceptical of change' },
    ],
  },
  {
    role: 'CTO', interviewee: 'Peter Osei', name: 'Peter Osei',
    sourceInterviewId: 'iv-cto', completedAt: '2026-07-15T09:30:00.000Z',
    scores: { D1: 3, D2: 4, D3: 4, D4: 3, D5: 2, D6: 2, D7: 3 },
    findings: [
      { dimension: 'D1', text: 'Movement data is reconciled manually at each month end' },
      { dimension: 'D2', text: 'The warehouse platform is on a supported version but has no test environment' },
      { dimension: 'D6', text: 'There is no model inventory and no approval gate' },
    ],
  },
  {
    role: 'CFO', interviewee: 'Ines Kaur', name: 'Ines Kaur',
    sourceInterviewId: 'iv-cfo', completedAt: '2026-07-16T14:00:00.000Z',
    scores: { D1: 2, D3: 3, D4: 2, D5: 3, D6: 2 },
    findings: [
      { dimension: 'D4', text: 'No business case template exists for technology spend under £2m' },
      { dimension: 'D5', text: 'Cost-to-serve is calculated quarterly, so pricing decisions run on stale numbers' },
    ],
  },
  {
    role: 'VP_Operations', interviewee: 'Tomas Reinholt', name: 'Tomas Reinholt',
    sourceInterviewId: 'iv-ops-north', completedAt: '2026-07-17T11:00:00.000Z',
    scores: { D3: 3, D5: 2, D7: 2 },
    findings: [
      { dimension: 'D5', text: 'Shift handover is a paper form transcribed into the WMS the next morning' },
      { dimension: 'D3', text: 'Trailer utilisation is measured weekly, in a spreadsheet, by one person' },
    ],
  },
  {
    role: 'VP_Operations', interviewee: 'Grace Okonkwo', name: 'Grace Okonkwo',
    sourceInterviewId: 'iv-ops-south', completedAt: '2026-07-18T11:00:00.000Z',
    scores: { D3: 4, D5: 2, D7: 3 },
    findings: [
      { dimension: 'D5', text: 'Shift handover is a paper form transcribed into the WMS the next morning' },
      { dimension: 'D7', text: 'Depot supervisors were not consulted on the last rollout and worked around it' },
    ],
  },
];

export const ENG_A = {
  code: A.code, client: A.name, industry: A.industry,
  createdAt: '2026-07-01T09:00:00.000Z',
  currentRoundId: 'r1',
  rounds: [
    {
      roundId: 'r1', roundNumber: 1, label: 'Initial Diagnostic', type: 'initial',
      status: 'complete', date: '2026-07-20',
      scopeDimensions: DIMS.slice(),
      interviews: ROUND1_INTERVIEWS,
      scores: { D1: 2.4, D2: 3.5, D3: 3.6, D4: 2.3, D5: 2.2, D6: 1.6, D7: 2.5 },
      benchmarks: {
        D1: { avg: 2.9, best: 4.1, laggard: 1.5 }, D2: { avg: 3.1, best: 4.3, laggard: 1.8 },
        D3: { avg: 3.0, best: 4.2, laggard: 1.6 }, D4: { avg: 2.7, best: 4.0, laggard: 1.4 },
        D5: { avg: 2.8, best: 4.1, laggard: 1.5 }, D6: { avg: 2.4, best: 3.9, laggard: 1.2 },
        D7: { avg: 2.9, best: 4.0, laggard: 1.6 },
      },
      benchmarkBasis: 'Third-party logistics operators, £500m–£2bn revenue, EMEA.',
    },
  ],
};

export const ENG_B = {
  code: B.code, client: B.name, industry: B.industry,
  createdAt: '2026-08-04T09:00:00.000Z',
  currentRoundId: 'h1',
  rounds: [
    { roundId: 'h1', roundNumber: 1, label: 'Initial Diagnostic', type: 'initial',
      status: 'active', interviews: [], scores: {} },
  ],
};

export const BRIEFING_A = {
  _format: 'vynora_briefing_pack_v2',
  client: A.name,
  industry: A.industry,
  /* v5.33.7 fixture repair. `revenue` must be one of VYNE_CONFIG.revenueRanges'
   * VALUES (pre_engagement.html:508) or the <select> silently falls back to its
   * first option, and the field the stated problem restores into is
   * `clientProblem` — `statedProblem` was invented here and read by nothing, so
   * the textarea came back empty on every reload. Neither was a product defect;
   * both were this file describing a shape the product does not write. */
  revenue: '$1B-$2B',
  clientProblem:
    'The board has asked for an AI plan. Operations wants fewer manual handoffs, '
    + 'finance wants cost-to-serve it can trust, and nobody agrees on what to do first.',
  roundNumber: 1,
  roundLabel: 'Initial Diagnostic',
  scopeDimensions: DIMS.slice(),
  benchmarkDate: '2026-07-08',
  benchmarkBasis: 'Third-party logistics operators, £500m–£2bn revenue, EMEA.',
  benchmarks: ENG_A.rounds[0].benchmarks,
  benchmarkSummary:
    'The sector averages 2.8–3.1 across the technical dimensions and is weakest on governance (D6). '
    + 'Best-in-class operators have automated shift handover and daily cost-to-serve.',
  industryTrends: [
    'Dynamic pricing on contract freight is moving from annual to weekly repricing.',
    'Yard and dock scheduling is the most common first automation in the sector.',
    'Regulatory pressure on driver-hours reporting is pulling telematics data into finance systems.',
  ],
  topUseCases: [
    'Automated shift handover and exception surfacing',
    'Trailer utilisation and load-fill optimisation',
    'Daily cost-to-serve by lane and customer',
    'Predictive maintenance on tractor units',
  ],
  /* `index` and a status of open|confirmed|rejected are what the product itself
   * writes (pre_engagement.html's saveBriefingContext). The first draft used
   * `id: 'H1'` and `status: 'selected'`, neither of which anything reads — the
   * badges rendered as NaN and every card shared one state slot. v5.33.7 made
   * the reader tolerate a missing index; the fixture should still describe the
   * real shape rather than lean on the tolerance. */
  hypotheses: [
    { index: 0, text: 'Manual reconciliation of movement data is the binding constraint on every downstream analytic.', status: 'confirmed', note: 'CEO and CTO described the same month-end reconciliation, unprompted, in different words.' },
    { index: 1, text: 'The depots will not adopt anything they were not consulted on, regardless of its merit.', status: 'confirmed', note: 'Both VP Operations raised the 2024 rollout without being asked; the southern region described active workarounds.' },
    { index: 2, text: 'There is no owner for AI governance, so no use case can clear approval.', status: 'confirmed', note: 'No model inventory and no approval gate. CEO and CTO agree.' },
    { index: 3, text: 'Trailer utilisation data already exists and is simply not used.', status: 'open', note: 'It exists weekly, in a spreadsheet, maintained by one person. Not the same as available.' },
  ],
  issueTreeQuestions: [
    'Where does movement data originate, and how many times is it re-keyed before it reaches finance?',
    'Who signs off a technology business case under £2m today?',
    'What happened on the last two TMS programmes, in the depots’ own words?',
    'Which of the weekly spreadsheets are load-bearing for a decision somebody actually makes?',
  ],
  politicalSensitivityFlags:
    'The two VP Operations report to different regional MDs and do not agree on the cause of the '
    + 'handover problem. Ask each separately; do not put them in the same session.',
  selectedRoles: ['CEO', 'CTO', 'CFO', 'VP_Operations'],
  roleCatalog: [
    { value: 'CEO', display: 'CEO / Executive Leadership', priorityDims: ['D4', 'D6', 'D7'], seq: 1 },
    { value: 'CTO', display: 'CTO / Head of Technology', priorityDims: ['D1', 'D2', 'D6'], seq: 2 },
    { value: 'CFO', display: 'CFO / Finance Leadership', priorityDims: ['D4', 'D5'], seq: 3 },
    { value: 'VP_Operations', display: 'VP Operations', priorityDims: ['D3', 'D5', 'D7'], seq: 4 },
  ],
  observations: [
    { label: 'Site visit — Doncaster depot', text: 'The handover form is a clipboard by the door. It is photographed on a phone and typed up the next morning.' },
    { label: 'Document review', text: 'Three separate definitions of "on time" are in use across the contract portfolio.' },
  ],
  documentSummaries: [
    { name: 'FY26 Operating Plan.pdf', summary: 'Sets a 4% cost-to-serve reduction target with no named programme against it.' },
    { name: 'TMS Post-Implementation Review.docx', summary: 'Attributes the 2024 failure to a lack of depot involvement in design.' },
  ],
  dataRequestOwners: ['CTO', 'CFO'],
  recommendedInterviewOrder: ['CEO', 'CTO', 'CFO', 'VP_Operations'],
};

export const SYNTHESIS_A = {
  savedAt: 1786500000000,
  client: A.name,
  code: A.code,
  synthesis: {
    executiveSummary:
      'Northwind is not blocked by technology. It is blocked by a manual reconciliation step that '
      + 'sits underneath every number the business argues about, and by the absence of anybody '
      + 'empowered to approve an AI use case. Both are fixable inside two quarters and neither '
      + 'requires the platform replacement the board has been asked to fund.',
    hypothesisVerdict: [
      { hypothesis: 'Manual reconciliation of movement data is the binding constraint on every downstream analytic.',
        verdict: 'confirmed',
        evidence: 'The CEO and the CTO independently described the same month-end reconciliation, in different words, without prompting.' },
      { hypothesis: 'The depots will not adopt anything they were not consulted on.',
        verdict: 'confirmed',
        evidence: 'Both VP Operations raised the last rollout unprompted; the southern region described active workarounds.' },
      { hypothesis: 'There is no owner for AI governance.',
        verdict: 'confirmed',
        evidence: 'CEO and CTO both said so. There is no model inventory and no approval gate.' },
      { hypothesis: 'Trailer utilisation data already exists and is simply not used.',
        verdict: 'partial',
        evidence: 'It exists weekly, in a spreadsheet, maintained by one person. That is not the same as available.' },
    ],
    blindSpots: [
      { topic: 'Who owns AI approval', whyItMatters: 'Every use case stalls at the same gate that does not exist.', whoShouldAddress: ['CEO', 'CTO'] },
      { topic: 'Key-person risk on the utilisation spreadsheet', whyItMatters: 'One person is the reporting layer for a decision made weekly.', whoShouldAddress: ['VP_Operations'] },
    ],
    strategicImplications: [
      'Fix the reconciliation before funding anything that consumes its output.',
      'Name an AI approver in this quarter, or nothing ships next quarter.',
      'Bring the depots into design of the handover change, or repeat 2024.',
    ],
    contradictions: [
      { topic: 'Cause of the handover delay',
        positions: [
          { role: 'VP_Operations', person: 'Tomas Reinholt', position: 'The WMS screen is too slow to use on shift.' },
          { role: 'VP_Operations', person: 'Grace Okonkwo', position: 'The screen is fine; nobody was trained on it.' },
        ] },
    ],
  },
};

export const ROADMAP_A = {
  entry: {
    notes: {
      D1: 'Reconciliation is the first thing to fix — everything else consumes it.',
      D6: 'No approver exists. This is a naming decision, not a build.',
    },
  },
  assumptions: {},
  dependencies: {},
  generated: {},
};

export const INTERVIEWS_API = [
  { id: 'iv-ceo', client: A.name, engagementCode: A.code, interviewee_name: 'Marguerite Vance',
    interviewee_role: 'CEO', status: 'complete', created_at: '2026-07-10T09:00:00.000Z',
    completed_at: '2026-07-14T10:40:00.000Z', roundNumber: 1, synthetic: false },
  { id: 'iv-cto', client: A.name, engagementCode: A.code, interviewee_name: 'Peter Osei',
    interviewee_role: 'CTO', status: 'complete', created_at: '2026-07-10T09:00:00.000Z',
    completed_at: '2026-07-15T10:20:00.000Z', roundNumber: 1, synthetic: false },
  { id: 'iv-cfo', client: A.name, engagementCode: A.code, interviewee_name: 'Ines Kaur',
    interviewee_role: 'CFO', status: 'complete', created_at: '2026-07-10T09:00:00.000Z',
    completed_at: '2026-07-16T14:45:00.000Z', roundNumber: 1, synthetic: false },
  { id: 'iv-ops-north', client: A.name, engagementCode: A.code, interviewee_name: 'Tomas Reinholt',
    interviewee_role: 'VP_Operations', status: 'complete', created_at: '2026-07-10T09:00:00.000Z',
    completed_at: '2026-07-17T11:35:00.000Z', roundNumber: 1, synthetic: false },
  { id: 'iv-ops-south', client: A.name, engagementCode: A.code, interviewee_name: 'Grace Okonkwo',
    interviewee_role: 'VP_Operations', status: 'complete', created_at: '2026-07-10T09:00:00.000Z',
    completed_at: '2026-07-18T11:50:00.000Z', roundNumber: 1, synthetic: false },
  { id: 'iv-cdo-pending', client: A.name, engagementCode: A.code, interviewee_name: 'Aled Prosser',
    interviewee_role: 'CDO', status: 'invited', created_at: '2026-07-19T09:00:00.000Z',
    completed_at: null, roundNumber: 1, synthetic: false },
  { id: 'iv-hbl-1', client: B.name, engagementCode: B.code, interviewee_name: 'Dana Whitfield',
    interviewee_role: 'CEO', status: 'invited', created_at: '2026-08-05T09:00:00.000Z',
    completed_at: null, roundNumber: 1, synthetic: false },
];

/** The cloud workspace, exactly as /api/module-state/workspace returns it. */
export function workspace() {
  return {
    vynora_engagement_index: JSON.stringify({ [A.norm]: A.code, [B.norm]: B.code }),
    vynora_code_index: JSON.stringify({ [A.code]: A.name, [B.code]: B.name }),
    ['vynora_engagement_' + A.code]: JSON.stringify(ENG_A),
    ['vynora_engagement_' + B.code]: JSON.stringify(ENG_B),
    ['vynora_briefing_' + A.norm]: JSON.stringify(BRIEFING_A),
    ['vynora_synthesis_full_' + A.code]: JSON.stringify(SYNTHESIS_A),
    ['vynora_roadmap_state_eng_' + A.code]: JSON.stringify(ROADMAP_A),
    vynora_last_briefing: JSON.stringify({ normKey: A.norm, client: A.name, code: A.code }),
    vynora_interviewer_name: 'Vyn',
    vynora_deck_mode: 'client',
  };
}
