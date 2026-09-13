/**
 * REVERT TEST for the v5.33.7 fixes.
 *
 *   node frontend/test/training-defects-revert.mjs
 *
 * A passing test suite proves the code passes the suite. It does not prove the
 * suite would have caught the defect — three times on this project a check has
 * gone green while asserting something narrower than it appeared to. So: back
 * each fix out ONE AT A TIME, run the suite, and require that the cases named
 * for that defect FAIL. Then restore the file and confirm the suite is green
 * again before moving to the next.
 *
 * A revert that leaves the suite passing is reported as a BROKEN TEST, not as a
 * success — that is the whole point of running this.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = join(FRONTEND, 'test', 'training-defects-e2e.mjs');

/** Each revert restores the exact code that shipped, and names the cases it must break. */
const REVERTS = [
  {
    id: 'D1a  drill-down guard (dimension)',
    file: 'synthesis.html',
    from: `function openDrillDown(dimCode){
  // v5.33.7: see openConflictDrillDown — same guard, same defect, same fix.
  if(!engagement)return;`,
    to: `function openDrillDown(dimCode){
  if(!engagement||!engagement.interviews)return;`,
    mustFail: [/clicking a dimension opens the drill-down/],
  },
  {
    id: 'D1b  drill-down guard (contradiction)',
    file: 'synthesis.html',
    from: `  if(!engagement)return;
  const iv=getActiveRoundInterviews();
  const dimName=DIM_NAMES[dimCode]||dimCode;
  const weights=ROLE_WEIGHTS[dimCode]||{}; const wOf=function(r){return vyneRoleWeight(dimCode, r);};

  // All entries for this dimension`,
    to: `  if(!engagement||!engagement.interviews)return;
  const iv=getActiveRoundInterviews();
  const dimName=DIM_NAMES[dimCode]||dimCode;
  const weights=ROLE_WEIGHTS[dimCode]||{}; const wOf=function(r){return vyneRoleWeight(dimCode, r);};

  // All entries for this dimension`,
    mustFail: [/clicking a contradiction opens its drill-down/],
  },
  {
    id: 'D2   contradiction header copy',
    file: 'synthesis.html',
    from: `\${esc(conflictWho(high,low))} scored \${dimCode} <strong style="color:#14532D">\${spread.toFixed(1)} \${spread===1?'point':'points'} higher</strong> than \${esc(conflictWho(low,high))}`,
    to: `\${esc(high.role)} scored \${dimCode} <strong style="color:#14532D">\${high.score} points higher</strong> than \${esc(low.role)}`,
    mustFail: [/quotes the SPREAD/, /does not say "5 points higher"/, /both ends are named/],
  },
  {
    id: 'D3   interview tracker keyed by person',
    file: 'synthesis.html',
    fromMarker: '  var trackerRows = [];',
    toMarker: "  }).join('');\n  // Dimension scores — clickable drill-down",
    to: `  document.getElementById('interview-tracker').innerHTML=allRoleKeys.map(function(key){
    var done = doneKeys.indexOf(key) >= 0;
    var interview = iv.find(function(i){ return roleKey(i.role)===key; });
    var roleScore = interview ? Object.values(interview.scores||{}).filter(function(s){ return s>0; }) : [];
    var avg = roleScore.length ? roleScore.reduce(function(a,b){ return a+b; },0)/roleScore.length : 0;
    var label = roleLabel(key);
    return '<div class="interview-row">'
      +'<div><div class="iv-role">'+esc(label.replace(/_/g,' '))+'</div>'+(interview?'<div class="iv-name">'+esc(interview.name||'')+'</div>':'')+'</div>'
      +'<div class="iv-status '+(done?'done':'pending')+'">'+(done?'✓ Done':'Pending')+'</div>'
      +'<div class="iv-score">'+(done&&avg>0?avg.toFixed(1):'—')+'</div>'
      +'</div>';
  }).join('');
  // Dimension scores — clickable drill-down`,
    mustFail: [/both VP Operations appear in the tracker/, /one row per interview that happened/],
  },
  {
    id: 'D4   roadmap handoff picks newest createdAt',
    file: 'synthesis.html',
    fromMarker: '  var bestEng = engagement;',
    toMarker: '  // Get latest round scores',
    to: `  var idx = JSON.parse(vyneStore.getItem('vynora_engagement_index')||'{}');
  var codes = Object.values(idx);
  if(!codes.length){
    alert('No engagement found. Create one in the Pre-Engagement Briefing first.');
    return;
  }
  var bestEng = null;
  codes.forEach(function(code){
    var raw = vyneStore.getItem('vynora_engagement_'+code);
    if(!raw) return;
    try{
      var eng = JSON.parse(raw);
      if(!bestEng || (eng.createdAt > (bestEng.createdAt||0))) bestEng = eng;
    }catch(e){}
  });
  if(!bestEng){ alert('Could not load engagement data.'); return; }

  // Get latest round scores`,
    mustFail: [/the push writes the LOADED/, /writes nothing for the client that merely has a newer/],
  },
  {
    id: 'D5   BTN font shorthand breaks the style attribute',
    file: 'interview_agent.html',
    from: `font:600 15px Inter,sans-serif;cursor:pointer;margin-top:12px'`,
    to: `font:600 15px "Inter",sans-serif;cursor:pointer;margin-top:12px'`,
    mustFail: [/the style attribute survives intact/, /actually VYNE gold/],
  },
  {
    id: 'D6   duplicate benchmark legend',
    file: 'interview_agent.html',
    fromMarker: `  if(S.benchmarks && Object.values(S.benchmarks).some(function(b){return b&&b.avg;})){`,
    toMarker: `  const vals=Object.values(S.scores).filter(s=>s>0);`,
    to: `  if(S.benchmarks && Object.values(S.benchmarks).some(function(b){return b&&b.avg;})){
    c.insertAdjacentHTML('beforeend',
      '<div style="display:flex;gap:14px;padding:8px 4px 2px;font-size:9px;border-top:1px solid rgba(1,32,61,0.05);margin-top:4px">'+
      '<span style="display:flex;align-items:center;gap:4px;color:#46535F"><span style="width:10px;height:2px;background:rgba(55,138,221,0.8);display:inline-block;border-radius:1px"></span>Industry avg</span>'+
      '<span style="display:flex;align-items:center;gap:4px;color:#46535F"><span style="width:10px;height:2px;background:rgba(16,185,129,0.8);display:inline-block;border-radius:1px"></span>Best-in-class</span>'+
      '</div>'
    );
  }
  if(S.benchmarks && Object.values(S.benchmarks).some(function(b){return b&&b.avg;})){
    c.insertAdjacentHTML('beforeend',
      '<div style="display:flex;gap:14px;padding:8px 4px 2px;font-size:9px;border-top:1px solid rgba(1,32,61,0.05);margin-top:4px">'+
      '<span style="display:flex;align-items:center;gap:4px;color:#46535F"><span style="width:10px;height:2px;background:rgba(55,138,221,0.8);display:inline-block;border-radius:1px"></span>Industry avg</span>'+
      '<span style="display:flex;align-items:center;gap:4px;color:#46535F"><span style="width:10px;height:2px;background:rgba(16,185,129,0.8);display:inline-block;border-radius:1px"></span>Best-in-class</span>'+
      '</div>'
    );
  }
  const vals=Object.values(S.scores).filter(s=>s>0);`,
    mustFail: [/renders exactly ONE benchmark legend/],
  },
  {
    id: 'D7   hypothesis index fallback',
    file: 'pre_engagement.html',
    from: `          data.hypotheses.forEach(function(h, hPos){
            if(!h.text) return;
            if(h.index === undefined || h.index === null || isNaN(h.index)) h = Object.assign({}, h, {index: hPos});`,
    to: `          data.hypotheses.forEach(function(h){
            if(!h.text) return;`,
    mustFail: [/number 1, 2, 3 rather than NaN/, /each gets its OWN state slot/],
  },
];

/** Run the suite; return every case line as {name, ok}. */
function runSuite() {
  let out = '';
  try {
    out = execFileSync('node', [SUITE], { cwd: join(FRONTEND, '..'), encoding: 'utf8', timeout: 600000 });
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  return out.split('\n')
    .map((l) => l.match(/^\s{2}(PASS|FAIL)\s{2}(.*)$/))
    .filter(Boolean)
    .map((m) => ({ ok: m[1] === 'PASS', name: m[2].trim() }));
}

function replaceOnce(src, from, to) {
  const at = src.indexOf(from);
  if (at < 0) return null;
  if (src.indexOf(from, at + 1) >= 0) return undefined;   // ambiguous — refuse
  return src.slice(0, at) + to + src.slice(at + from.length);
}

console.log('\n=== REVERT TEST — v5.33.7 ===\n');
console.log('  Baseline (all fixes in place):');
const baseline = runSuite();
const baseFails = baseline.filter((c) => !c.ok);
console.log(`    ${baseline.length - baseFails.length} passed, ${baseFails.length} failed`);
if (baseFails.length) {
  console.log('    !! the suite is not green before reverting — stopping.');
  for (const f of baseFails) console.log('       ' + f.name);
  process.exit(1);
}

let broken = 0;
for (const r of REVERTS) {
  const path = join(FRONTEND, r.file);
  const original = readFileSync(path, 'utf8');

  let reverted;
  if (r.from) {
    reverted = replaceOnce(original, r.from, r.to);
  } else {
    // Marker form: replace everything from fromMarker up to and including toMarker.
    const a = original.indexOf(r.fromMarker);
    const b = a < 0 ? -1 : original.indexOf(r.toMarker, a);
    reverted = (a < 0 || b < 0) ? null
      : original.slice(0, a) + r.to + original.slice(b + r.toMarker.length);
  }

  if (reverted === null)      { console.log(`\n  [SKIP] ${r.id} — pattern not found; the fix may have moved`); broken++; continue; }
  if (reverted === undefined) { console.log(`\n  [SKIP] ${r.id} — pattern is ambiguous; refusing to patch`);   broken++; continue; }

  writeFileSync(path, reverted);
  const cases = runSuite();
  writeFileSync(path, original);                       // restore before judging

  const failed = cases.filter((c) => !c.ok).map((c) => c.name);
  const expected = r.mustFail.map((re) => ({ re, hit: failed.some((n) => re.test(n)) }));
  const allHit = expected.every((e) => e.hit);

  console.log(`\n  ${allHit ? '[OK]  ' : '[BAD] '} ${r.id}`);
  console.log(`         reverted → ${failed.length} case(s) failed`);
  for (const e of expected) {
    console.log(`           ${e.hit ? '✓' : '✗'} expected failure: ${e.re}`);
  }
  if (!allHit) {
    broken++;
    console.log('         !! backing this fix out did NOT break its test — the test proves less than it claims');
    console.log('            failures were: ' + (failed.join(' | ') || '(none)'));
  }
}

console.log('\n  Restoring and re-checking the baseline...');
const after = runSuite();
const afterFails = after.filter((c) => !c.ok);
console.log(`    ${after.length - afterFails.length} passed, ${afterFails.length} failed`);
if (afterFails.length) { console.log('    !! files were not restored cleanly'); broken++; }

console.log(`\n  ${REVERTS.length - broken} of ${REVERTS.length} reverts behaved as required\n`);
process.exit(broken ? 1 : 0);
