/**
 * GROUP 01 — building the briefing (pre_engagement.html), and the interview
 * roster that follows from it (interviews.html).
 *
 * ── Three mechanical notes ─────────────────────────────────────────────────
 *
 * 1. pre_engagement.html's export bar is `position: sticky; bottom: 0`. In a
 *    whole-viewport shot that is correct and is what a consultant sees, but in
 *    an ELEMENT shot of a tall panel Playwright scrolls the panel into view and
 *    the bar paints across the bottom of it. PE() below sets it to `static` so
 *    each panel is photographed whole. Nothing else about the page is touched.
 *
 * 2. interviews.html reads three things the harness stub does not serve:
 *    /api/my-clients (which fills the invite form's client picker, the row
 *    editor's picker, and the entire owner half of the access panel), /api/team,
 *    and the interview list under the FIELD NAMES the real API returns —
 *    client_name, email, started_at, status 'completed' — which are not the
 *    names fixture.mjs uses. Left alone the tracker renders with an empty client
 *    column, an empty login column and a disabled client dropdown: a picture of
 *    a broken page rather than of the product.
 *
 *    STUB_FILL closes exactly those three gaps, here, from the data the harness
 *    already serves elsewhere — the client list is /api/clients' own answer, the
 *    team is /api/firms/team's own answer, and the interviews are the fixture's
 *    own rows under the API's field names. Nothing is drawn by hand; the page's
 *    own code renders all of it. The real fix belongs in harness.mjs and
 *    fixture.mjs, which this group may not edit.
 *
 * 3. The tracker table is a ten-column grid inside a 1100px page, and an open
 *    row editor is ~1240px of controls, so at the standard width half of it sits
 *    behind .table-scroll's horizontal scroll and no single frame shows both the
 *    client picker and Save. TABLE_VP / WIDEN give the four table shots the room
 *    to be photographed whole; no control is added, removed or restyled.
 */

/** pre_engagement.html prep: flatten the sticky export bar, then run `body`. */
const PE = (body = '') => `(() => { try {
  var _eb = document.getElementById('export-bar'); if (_eb) _eb.style.position = 'static';
  ${body}
  return {};
} catch (e) { return { error: String(e) }; } })()`;

/** The three routes the stub omits, answered from the fixture's own data. */
const STUB_FILL = `
  var _f = window.fetch;
  window.fetch = function(u, o){
    var url = String(u);
    var json = function(body){ return Promise.resolve(new Response(JSON.stringify(body),
      { status: 200, headers: { 'content-type': 'application/json' } })); };
    if (url.indexOf('/api/my-clients') >= 0)
      return json({ role: 'owner', clients: ['Northwind Freight Group', 'Harbourline Health'] });
    if (url.indexOf('/api/team') >= 0)
      return json({ members: [
        { userId: 'u1', email: 'consultant@meridianadvisory.com', name: 'You', role: 'owner' },
        { userId: 'u2', email: 'analyst@meridianadvisory.com', name: 'Priya Raman', role: 'consultant' } ] });
    if (url.indexOf('/api/assignments') >= 0 && (!o || !o.method || o.method === 'GET'))
      return json({ assignments: [
        { email: 'analyst@meridianadvisory.com', name: 'Priya Raman', client_name: 'Northwind Freight Group' } ] });
    if (/\\/api\\/interviews(\\?|$)/.test(url) && (!o || !o.method || o.method === 'GET')){
      return _f(u, o).then(function(r){ return r.json(); }).then(function(d){
        var slug = function(c){ return String(c||'').toLowerCase().replace(/[^a-z]+/g,''); };
        var mail = function(n, c){
          return String(n||'').toLowerCase().replace(/[^a-z ]/g,'').split(' ').join('.')
            + '@' + slug(c) + '.example';
        };
        return json({ interviews: (d.interviews||[]).map(function(iv){
          var done = iv.completed_at || null;
          return {
            id: iv.id,
            client_name: iv.client,
            interviewee_name: iv.interviewee_name,
            interviewee_role: iv.interviewee_role,
            status: iv.status === 'complete' ? 'completed' : iv.status,
            email: mail(iv.interviewee_name, iv.client),
            created_at: iv.created_at,
            started_at: done ? new Date(Date.parse(done) - 42*60*1000).toISOString() : null,
            completed_at: done,
            round_number: null,
            interviewer_name: 'Vyn',
            interviewer_voice: iv.interviewee_role === 'CFO' ? 'Orus' : ''
          };
        }) });
      });
    }
    return _f(u, o);
  };
`;

const TABLE_VP = { width: 1700, height: 950 };
/** The "All interviews" panel — the last block inside .page. */
const LIST_PANEL = '.page > .panel:last-child';
const WIDEN = "document.querySelector('.page').style.maxWidth = '1460px';";

/** interviews.html prep: install the missing routes, then run `body`. */
const IV = (body = '') => `(() => { try {
  ${STUB_FILL}
  ${body}
  return {};
} catch (e) { return { error: String(e) }; } })()`;

export const SHOTS = [

  /* ══ A. pre_engagement.html — building the briefing ══════════════════════ */

  { id: '01-01-setup-new-client', page: 'pre_engagement.html', settle: 4000,
    title: 'Engagement details — a new client',
    session: { activeClient: 'Harbourline Health' },
    prep: PE(`
      document.getElementById('client-name').value = '';
      document.getElementById('industry').value = '';
      detectRoundMode('');
    `),
    note: 'Where a new engagement starts. Client, industry and revenue band decide which benchmark '
        + 'set and which hypothesis library everything below draws on, so they are worth getting '
        + 'right before anything is generated. Industry is free text — describe the business the '
        + 'client is actually in, not the nearest tick-box.' },

  { id: '01-02-setup-filled', page: 'pre_engagement.html', settle: 4000,
    title: 'Engagement details — filled in',
    prep: PE(`
      var v = function(id, val){ var e = document.getElementById(id); if (e) e.value = val; };
      v('revenue', '$1B-$2B');
      v('pe-sponsor', 'Ashgrove Partners');
      v('eng-lead', 'You');
      v('client-stated-problem', 'The board has asked for an AI plan. Operations wants fewer manual handoffs, finance wants cost-to-serve it can trust, and nobody agrees on what to do first.');
      v('pe-context', 'Held since 2023, exit targeted for 2028. The value creation plan carries a 4% cost-to-serve reduction with no named programme against it.');
    `),
    note: 'What the client SAYS the problem is goes in verbatim, in their words — that is the claim '
        + 'the diagnostic tests, not the one it accepts. The engagement code under the name is the '
        + 'identifier every other module joins on, and Rename Client is the only safe way to change '
        + 'the name: it moves the engagement, the interviews and every module’s data together.' },

  { id: '01-03-round-mode', page: 'pre_engagement.html', target: '#round-mode-panel', settle: 4000,
    title: 'Round mode — a repeat diagnostic on an existing client',
    prep: PE(`
      var v = function(id, val){ var e = document.getElementById(id); if (e) e.value = val; };
      v('round-label', 'Q4 2026 Refresh');
      v('round-type', 'event');
      v('event-context', 'New CTO started in September; the TMS replacement went live in the northern region.');
      v('what-changed', 'Movement reconciliation is now nightly rather than monthly in the north. An AI approver has still not been named. Two depot managers have left.');
      var off = ['D2','D4'];
      document.querySelectorAll('.scope-btn').forEach(function(b){
        if (off.indexOf(b.getAttribute('data-dim')) >= 0) b.click();
      });
    `),
    note: 'This panel appears by itself once the client already has an engagement. The table is the '
        + 'prior rounds and their scores; deselecting a dimension says "nothing has changed here, '
        + 'do not re-ask it", which is what keeps a refresh round shorter than the first one.' },

  { id: '01-10-benchmarks', page: 'pre_engagement.html', target: '#section-benchmarks', settle: 4000,
    title: 'Industry benchmarks',
    prep: PE(),
    note: 'Where the sector sits on each dimension for this industry and revenue band. This is what '
        + 'you use to answer "is a 2.4 bad?" in front of a CEO. Read the basis line underneath '
        + 'before quoting any of it — it says whether these are a real sector baseline or the '
        + 'nearest available substitute.' },

  { id: '01-11-hypotheses-generated', page: 'pre_engagement.html', target: '#section-hypotheses',
    settle: 4000,
    title: 'Working hypotheses — as generated',
    prep: PE(`
      renderHypotheses(document.getElementById('industry').value, '',
        document.getElementById('client-name').value, '', '');
    `),
    note: 'Hypotheses come from the industry pattern library plus the context typed above. They are '
        + 'starting positions, not findings — the interviews exist to confirm or kill them, and a '
        + 'hypothesis nobody tested is worse than one you never wrote down.' },

  { id: '01-12-hypotheses-marked', page: 'pre_engagement.html', target: '#section-hypotheses',
    settle: 4000,
    title: 'Working hypotheses — confirmed, rejected, unresolved',
    prep: PE(`
      renderHypotheses(document.getElementById('industry').value, '',
        document.getElementById('client-name').value, '', '');
      setHypothesis(1, 'confirmed');
      var n1 = document.getElementById('hyp-note-1');
      if (n1) { n1.value = 'CEO and CTO described the same month-end reconciliation independently, in different words.'; n1.dispatchEvent(new Event('input')); }
      setHypothesis(3, 'rejected');
      var n3 = document.getElementById('hyp-note-3');
      if (n3) { n3.value = 'Routing is already ML-driven on contract freight — this is not where the loss is.'; n3.dispatchEvent(new Event('input')); }
    `),
    note: 'Mark each one as evidence arrives, and write down what convinced you. The note is the '
        + 'evidence line you will be asked for in the readout, and Synthesis reads these statuses '
        + 'back when it works out which hypotheses the round actually settled.' },

  { id: '01-13-hypothesis-custom', page: 'pre_engagement.html', target: '#section-hypotheses',
    settle: 4000,
    title: 'Adding your own hypothesis',
    prep: PE(`
      renderHypotheses(document.getElementById('industry').value, '',
        document.getElementById('client-name').value, '', '');
      addCustomHypothesis();
      var i = Math.max.apply(null, Object.keys(hypothesesState).map(Number));
      var t = document.getElementById('hyp-custom-' + i);
      if (t) { t.value = 'The depots will not adopt anything they were not consulted on, regardless of its merit.'; t.dispatchEvent(new Event('input')); }
      var n = document.getElementById('hyp-note-' + i);
      if (n) { n.value = 'Raised unprompted by both VP Operations. Test it with the depot supervisors, not with head office.'; n.dispatchEvent(new Event('input')); }
      document.getElementById('hyp-card-' + i).scrollIntoView({ block: 'center' });
    `),
    note: 'Anything you believe about this client that the library did not think of goes here. From '
        + 'the moment it is written, a custom hypothesis is treated exactly like a generated one.' },

  { id: '01-20-issue-tree', page: 'pre_engagement.html', target: '#section-issue-tree', settle: 4000,
    title: 'The MECE issue tree',
    prep: PE(),
    note: 'Every diagnostic question, grouped under the dimension it belongs to. This is the '
        + 'coverage check: a question that does not trace to a dimension here does not get asked, '
        + 'and a dimension with no questions is a hole in the diagnostic.' },

  { id: '01-30-context-docs-empty', page: 'pre_engagement.html', target: '#section-data-requests',
    settle: 4000,
    title: 'Engagement context documents — before anything is attached',
    prep: PE(),
    note: 'Documents attach to the ENGAGEMENT, not to the person who handed them over, and are '
        + 'tagged by the dimensions they inform. Every interview covering those dimensions gets '
        + 'them, whoever supplied them.' },

  { id: '01-31-context-docs-attached', page: 'pre_engagement.html', target: '#section-data-requests',
    settle: 4000, after: 4000,
    title: 'Engagement context documents — attached, summarised and tagged',
    prep: PE(`
      var put = function(name, label, text){
        document.getElementById('ctx-doc-label').value = label;
        var inp = document.getElementById('ctx-doc-file');
        var dt = new DataTransfer();
        dt.items.add(new File([text], name, { type: 'text/plain' }));
        inp.files = dt.files;
        handleContextDocUpload(inp);
      };
      put('FY26 Operating Plan.txt', 'FY26 Operating Plan',
          'Sets a 4% cost-to-serve reduction target for FY26. No named programme is attached to it.');
      setTimeout(function(){
        put('TMS Post-Implementation Review.txt', 'TMS Post-Implementation Review',
            'Attributes the 2024 failure to a lack of depot involvement in design.');
      }, 900);
      setTimeout(function(){
        var keys = Object.keys(docSummaries);
        if (keys[0]) { toggleCtxDocDim(keys[0], 'D3'); toggleCtxDocDim(keys[0], 'D5'); }
        if (keys[1]) { toggleCtxDocDim(keys[1], 'D7'); }
      }, 2400);
    `),
    note: 'Each document is read once and reduced to analyst notes, and the chips decide which '
        + 'interviews see it. A document with no chips reaches nobody, and the card says so rather '
        + 'than sitting there looking attached and doing nothing.' },

  { id: '01-32-context-doc-rename', page: 'pre_engagement.html', target: '#section-data-requests',
    settle: 4000, after: 4000,
    title: 'Renaming a context document',
    prep: PE(`
      var inp = document.getElementById('ctx-doc-file');
      document.getElementById('ctx-doc-label').value = '';
      var dt = new DataTransfer();
      dt.items.add(new File(['Sets a 4% cost-to-serve reduction target for FY26.'],
        'FY26_OP_v7_FINAL_final.txt', { type: 'text/plain' }));
      inp.files = dt.files;
      handleContextDocUpload(inp);
      setTimeout(function(){
        var k = Object.keys(docSummaries)[0];
        if (!k) return;
        toggleCtxDocDim(k, 'D3');
        renameCtxDoc(k);
        var box = document.getElementById('ctxdoc-rename-' + k);
        if (box) box.value = 'FY26 Operating Plan';
      }, 2200);
    `),
    note: 'The file name a client sends is rarely the name you want to read for the rest of the '
        + 'engagement. The rename is display only — the original file name stays in brackets, so '
        + 'the document can always be traced back to what they actually sent.' },

  { id: '01-33-doc-suggestions', page: 'pre_engagement.html', target: '#section-data-requests',
    settle: 4000,
    title: 'What to ask the client for, by dimension',
    prep: PE(`
      var d = document.querySelector('#section-data-requests details');
      if (d) d.open = true;
    `),
    note: 'The checklist behind the data request. Work down it before the first interview — a '
        + 'document you get up front is a question you do not have to spend interview time on.' },

  { id: '01-40-observations', page: 'pre_engagement.html', target: '#section-observation-log',
    settle: 4000,
    title: 'Field observation log',
    prep: PE(`addObservation();`),
    note: 'What you saw, as against what you were told. These are the entries that settle an '
        + 'argument three weeks later, so record the specific thing — which screen was open, which '
        + 'form was on the clipboard — and not the conclusion you drew from it.' },

  { id: '01-50-political-flags', page: 'pre_engagement.html', target: '#section-political',
    settle: 4000,
    title: 'Political sensitivity flags',
    prep: PE(),
    note: 'Patterns to listen for during the interviews. They are prompts to probe, not conclusions '
        + '— the judgement about what a hedge or a deflection actually means stays with you.' },

  { id: '01-60-roles', page: 'pre_engagement.html', target: '#section-role-selection', settle: 4000,
    title: 'Engagement roles and their dimension depth',
    prep: PE(),
    note: 'The stakeholder map for this client. Ticking a role puts it in scope; the Lead / Cover / '
        + 'Light chips beside it say how deep that role is questioned on each dimension. This one '
        + 'list drives every interview and the coverage analysis in Synthesis, so it is worth more '
        + 'care than it looks like it needs.' },

  { id: '01-61-role-dimension-tiers', page: 'pre_engagement.html', target: '#section-role-selection',
    settle: 4000,
    title: 'Editing one role’s dimension depth',
    prep: PE(`editRoleDims('CTO');`),
    note: 'Lead means this person is the authority on that dimension, Cover means ask but do not '
        + 'dwell, Light means one question, Off means do not ask at all. Turning things Off is how '
        + 'a 60-minute interview stays 60 minutes.' },

  { id: '01-62-role-rename', page: 'pre_engagement.html', target: '#section-role-selection',
    settle: 4000,
    title: 'Renaming a role for this client',
    prep: PE(`
      renameRole('COO');
      var box = document.getElementById('rename-input-COO');
      if (box) box.value = 'Depot Network Director';
    `),
    note: 'Use the client’s own job titles — people answer to the title they hold. The rename is '
        + 'cosmetic on purpose: the underlying key does not move, so scoring and role weighting are '
        + 'unaffected by what you call it.' },

  { id: '01-63-custom-role-form', page: 'pre_engagement.html', target: '#custom-role-add',
    settle: 4000,
    title: 'Adding a custom role',
    prep: PE(`
      document.getElementById('custom-role-name').value = 'Head of Depot Operations';
      document.querySelectorAll('#custom-role-dims input').forEach(function(c){
        if (c.value === 'D5' || c.value === 'D7') c.checked = true;
      });
    `),
    note: 'For titles that only exist at this client. Tick the dimensions this person is the '
        + 'priority voice on; in every other respect the role then behaves like a standard one.' },

  { id: '01-64-custom-role-added', page: 'pre_engagement.html', target: '#section-role-selection',
    settle: 4000,
    title: 'The custom role in the list',
    prep: PE(`
      document.getElementById('custom-role-name').value = 'Head of Depot Operations';
      document.querySelectorAll('#custom-role-dims input').forEach(function(c){
        if (c.value === 'D5' || c.value === 'D7') c.checked = true;
      });
      addCustomRole();
    `),
    note: 'The custom role joins the same list, marked as custom and removable. Only custom roles '
        + 'can be deleted; a standard role is unticked instead, so nothing is lost if you change '
        + 'your mind halfway through the engagement.' },

  { id: '01-70-briefing-full', page: 'pre_engagement.html', full: true,
    settle: 4000, after: 5000,
    title: 'The complete briefing',
    prep: PE(`
      var v = function(id, val){ var e = document.getElementById(id); if (e) e.value = val; };
      v('revenue', '$1B-$2B');
      v('pe-sponsor', 'Ashgrove Partners');
      v('eng-lead', 'You');
      v('client-stated-problem', 'The board has asked for an AI plan. Operations wants fewer manual handoffs, finance wants cost-to-serve it can trust, and nobody agrees on what to do first.');
      v('pe-context', 'Held since 2023, exit targeted for 2028. The value creation plan carries a 4% cost-to-serve reduction with no named programme against it.');
      renderHypotheses(document.getElementById('industry').value, '',
        document.getElementById('client-name').value, '', '');
      setHypothesis(1, 'confirmed');
      var n1 = document.getElementById('hyp-note-1');
      if (n1) { n1.value = 'CEO and CTO described the same month-end reconciliation independently, in different words.'; n1.dispatchEvent(new Event('input')); }
      setHypothesis(3, 'rejected');
      var put = function(name, label, text){
        document.getElementById('ctx-doc-label').value = label;
        var inp = document.getElementById('ctx-doc-file');
        var dt = new DataTransfer();
        dt.items.add(new File([text], name, { type: 'text/plain' }));
        inp.files = dt.files;
        handleContextDocUpload(inp);
      };
      put('FY26 Operating Plan.txt', 'FY26 Operating Plan',
          'Sets a 4% cost-to-serve reduction target for FY26.');
      setTimeout(function(){
        put('TMS Post-Implementation Review.txt', 'TMS Post-Implementation Review',
            'Attributes the 2024 failure to a lack of depot involvement in design.');
      }, 900);
      setTimeout(function(){
        var keys = Object.keys(docSummaries);
        if (keys[0]) { toggleCtxDocDim(keys[0], 'D3'); toggleCtxDocDim(keys[0], 'D5'); }
        if (keys[1]) { toggleCtxDocDim(keys[1], 'D7'); }
      }, 2400);
    `),
    note: 'The whole pre-engagement pack in one page, in the order it is meant to be worked: '
        + 'details, benchmarks, hypotheses, issue tree, documents, observations, political flags, '
        + 'roles. Finish this before anybody is invited — it is what the interviews are tuned from.' },

  { id: '01-71-export', page: 'pre_engagement.html', target: '#export-bar', settle: 4000,
    title: 'Exporting the briefing pack',
    prep: PE(),
    note: 'The JSON pack is the portable copy of everything above — it loads straight back into '
        + 'this page and brings the roles, hypotheses and document summaries with it. Print is the '
        + 'version you hand round a room.' },

  /* ══ B. interviews.html — the interview tracker ══════════════════════════ */

  { id: '02-01-tracker-full', page: 'interviews.html', full: true, viewport: TABLE_VP,
    title: 'The interview tracker',
    prep: IV(`${WIDEN} loadAccess(); refresh();`),
    after: 2000,
    note: 'One page for the whole roster: who on your side has access, who on the client side has '
        + 'been invited, and where each interview has got to. This is the screen you live on '
        + 'between finishing the briefing and opening Synthesis.' },

  { id: '02-02-interview-list', page: 'interviews.html', viewport: TABLE_VP,
    target: LIST_PANEL,
    title: 'All interviews',
    prep: IV(`
      ${WIDEN}
      loadAccess(); refresh();
      setTimeout(function(){
      }, 1200);
    `),
    after: 2500,
    note: 'Every interview for the firm, sortable and filterable. Note the two VP Operations rows: '
        + 'one title held by two people is a real situation, and the product keeps them apart as '
        + 'separate voices all the way through to Synthesis rather than averaging them together.' },

  { id: '02-03-list-filters', page: 'interviews.html', viewport: TABLE_VP,
    target: LIST_PANEL,
    title: 'Filtering the list',
    prep: IV(`
      ${WIDEN}
      loadAccess(); refresh();
      setTimeout(function(){
        ivSetFilter('client', 'Northwind Freight Group');
        ivSetFilter('status', 'invited');
      }, 1200);
    `),
    after: 2500,
    note: 'Filters persist between visits, which is why the bar above the table always shows which '
        + 'ones are on and offers one click to clear them. Filtering to "invited" is how you find '
        + 'who has been asked and has not yet turned up.' },

  { id: '02-04-row-editor', page: 'interviews.html', viewport: TABLE_VP,
    target: LIST_PANEL,
    title: 'Editing one interview',
    prep: IV(`
      ${WIDEN}
      loadAccess(); refresh();
      setTimeout(function(){
        editRow('iv-cdo-pending');
      }, 1400);
    `),
    after: 2500,
    note: 'Client and role are picked here, never typed: a typed client name would silently detach '
        + 'this interview from its engagement. Use this to move a misfiled interview, pin it to a '
        + 'round, or correct the interviewer name and voice. The login cannot be changed — delete '
        + 'and re-invite instead.' },

  { id: '02-05-invite', page: 'interviews.html',
    title: 'Inviting an interviewee',
    prep: IV(`
      loadAccess(); refresh();
      setTimeout(function(){
        var c = document.getElementById('iv-client');
        c.value = 'Northwind Freight Group';
        refreshRoleOptions();
        document.getElementById('iv-role').value = 'CFO';
        document.getElementById('iv-name').value = 'Ines Kaur';
        document.getElementById('iv-email').value = 'ines.kaur@northwindfreightgroup.example';
        document.getElementById('iv-interviewer-name').value = 'Vyn';
        document.getElementById('iv-round').value = '1';
        c.closest('.panel').scrollIntoView({ block: 'start' });
      }, 1200);
    `),
    after: 2500,
    note: 'An invite creates that person’s login and drops them straight into an interview '
        + 'already tuned to their role for this client. The role list is the stakeholder map from '
        + 'the briefing — a role missing here is missing in Pre-Engagement. The interviewer name '
        + 'and voice on the second row are the firm’s choice, travel with the invite, and are '
        + 'remembered as the default for the next one.' },

  { id: '02-06-invite-created', page: 'interviews.html',
    title: 'The invite, created',
    prep: IV(`
      loadAccess(); refresh();
      setTimeout(function(){
        var c = document.getElementById('iv-client');
        c.value = 'Northwind Freight Group';
        refreshRoleOptions();
        document.getElementById('iv-role').value = 'CFO';
        document.getElementById('iv-name').value = 'Ines Kaur';
        document.getElementById('iv-email').value = 'ines.kaur@northwindfreightgroup.example';
        document.getElementById('iv-interviewer-name').value = 'Vyn';
        createInvite();
      }, 1200);
      setTimeout(function(){
        document.getElementById('iv-client').closest('.panel').scrollIntoView({ block: 'start' });
      }, 2200);
    `),
    after: 3000,
    note: 'The confirmation carries the login hint for that interviewee. Nothing is sent from here '
        + '— sending stays with you, because the relationship with that executive is yours.' },

  { id: '02-07-access-panel', page: 'interviews.html', target: '#access-panel',
    title: 'Client access',
    prep: IV(`loadAccess(); refresh();`),
    after: 2000,
    note: 'Consultants see only the clients you assign to them, enforced on the server rather than '
        + 'in the page. The delete at the bottom removes a client and everything attached to them — '
        + 'briefing, interviews, synthesis, roadmap — and there is no undo.' },

  { id: '02-08-synthetic', page: 'interviews.html',
    title: 'Synthetic practice data',
    prep: IV(`
      loadAccess(); refresh();
      setTimeout(function(){
        var s = document.getElementById('syn-client');
        s.value = 'Northwind Freight Group';
        document.getElementById('syn-industry').value = 'Logistics';
        s.closest('.panel').scrollIntoView({ block: 'start' });
      }, 1200);
    `),
    after: 2500,
    note: 'A complete fake engagement built from this client’s own briefing — its roles, its '
        + 'industry, its hypotheses, with contradictions and a governance blind spot seeded in. Use '
        + 'it to rehearse Synthesis and the Roadmap before the real interviews land. It is appended '
        + 'alongside the real interviews and never mixed into them.' },

  { id: '02-09-agenda-review', page: 'interviews.html',
    title: 'Reviewing a follow-up agenda',
    prep: IV(`
      loadAccess(); refresh();
      setTimeout(function(){
        openAgendaReview('iv-ops-north', [
          { dimension: 'D5', text: 'How the shift handover is recorded today, end to end.',
            evidence: ['Shift handover is a paper form transcribed into the WMS the next morning.'] },
          { dimension: 'D7', text: 'What made the last depot rollout land badly, in your words.',
            evidence: ['Depot supervisors were not consulted on the last rollout and worked around it.'] },
          { dimension: 'D3', text: 'Who is measuring trailer utilisation, and what is done with it.',
            evidence: ['Trailer utilisation is measured weekly, in a spreadsheet, by one person.'] }
        ]);
      }, 1400);
    `),
    after: 2500,
    note: 'A follow-up is drafted from what OTHER people said, so nothing reaches the interviewee '
        + 'until you have read it. The grey block under each topic is the material it was drawn '
        + 'from — that is for you only; they see the topic text and nothing else.' },
];

// CANNOT REACH — states deliberately left out, and why.
//
// pre_engagement.html
//   · The Rename Client dialog. renameClientPrompt() uses window.prompt(), a
//     native browser dialog: Playwright cannot photograph one, and the harness
//     dismisses dialogs by design. The button that opens it is visible in 01-02.
//   · The Document Intelligence output (#doc-intel-output). That panel renders
//     one block per dimension from a {"D1":{assessment,signal},…} response. The
//     harness's single LLM stub returns a fixed union object with no D1–D7 keys,
//     so the panel would photograph as an empty box. The control that runs it,
//     and the explanation of what it does, are in 01-30 / 01-31.
//   · The three AI-generated client-specific hypotheses that are prepended to
//     the industry list when a stated problem is present — same reason: the stub
//     does not return the JSON array that path parses, so the page falls back to
//     the industry library, which is what 01-11 shows.
//
// interviews.html
//   · The ready-to-send invite message (#invite-message). It appears only when
//     POST /api/interviews returns an inviteMessage, which the stub does not,
//     and which the real server builds from an Identity Platform reset link.
//   · The interview transcript overlay (#transcript-overlay). GET
//     /api/interviews/:id/transcript is stubbed as {interview, transcript: []};
//     viewTranscript() reads d.transcripts[0] and correctly reports that no
//     transcript is stored.
//   · Drafting a follow-up end to end. POST /api/interviews/:id/followup/draft
//     is not stubbed, so the drafted agenda is handed to the page's own
//     openAgendaReview() directly — which is what 02-09 does. The review screen
//     itself, including the evidence blocks, is the real one.
//   · The full interviewer-voice catalog. /api/voice/voices is stubbed with two
//     entries carrying no `presents` or `character` field, so voiceOptions()
//     cannot build its male/female optgroups. 02-05 shows the picker on its
//     default ("Aoede — female, breezy"), which is the honest part of it.
