#!/usr/bin/env python3
"""Revert-test matrix + worked examples for the 5.33.9 defect fixes.

For each fix: swap the fixed code back to its BUGGY form, run the behavioral
suite (a correct fix makes exactly its own case fail), capture the real buggy
output, then restore the fix and capture the real fixed output. Defect 2's
behavioral path is not headless-runnable (full 26-slide export), so it is
revert-tested at the source level.
"""
import subprocess, sys, re, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SYN = os.path.join(ROOT, "frontend", "synthesis.html")
ROAD = os.path.join(ROOT, "frontend", "roadmap.html")
IAG = os.path.join(ROOT, "frontend", "interview_agent.html")
SUITE = os.path.join(ROOT, "frontend", "test", "defects-5339-e2e.mjs")

# (key, label, file, expected-failing-case-substring, FIXED snippet, BUGGY snippet)
FIXES = [
    ("D1", "runAISynthesis guard", SYN, "D1 runAISynthesis",
     "  var _hasIv=(engagement.interviews&&engagement.interviews.length) ||\n"
     "             (engagement.rounds||[]).some(function(r){return (r.interviews||[]).length;});",
     "  var _hasIv=(engagement.interviews&&engagement.interviews.length) ||\n"
     "             false; /*REVERT: flat-array only*/"),

    ("D3", "openDrillDown label", SYN, "D3 openDrillDown",
     "${esc(conflictWho(high,low))} scored this dimension at <strong style=\"color:#14532D\">${high.score}</strong> while ${esc(conflictWho(low,high))} scored it at <strong style=\"color:#EF4444\">${low.score}</strong>. A gap of ${spread} points suggests these roles have fundamentally different views of the organization's capability here. This discrepancy should be investigated — it may indicate that improvements are siloed, that the ${esc(conflictWho(low,high))} lacks visibility into progress, or that ${esc(conflictWho(high,low))} is overestimating maturity.",
     "${esc(high.role)} scored this dimension at <strong style=\"color:#14532D\">${high.score}</strong> while ${esc(low.role)} scored it at <strong style=\"color:#EF4444\">${low.score}</strong>. A gap of ${spread} points suggests these roles have fundamentally different views of the organization's capability here. This discrepancy should be investigated — it may indicate that improvements are siloed, that the ${esc(low.role)} lacks visibility into progress, or that ${esc(high.role)} is overestimating maturity."),

    ("D4", "renderFocusTile source", SYN, "D4 renderFocusTile",
     "  // canonical, active-round source everything else on the page reads.\n"
     "  var iv = getActiveRoundInterviews();",
     "  // canonical, active-round source everything else on the page reads.\n"
     "  var iv = engagement.interviews && engagement.interviews.length\n"
     "    ? engagement.interviews\n"
     "    : (engagement.rounds||[]).reduce(function(acc,r){ return acc.concat(r.interviews||[]); }, []);"),

    ("D5", "roadmap per-role", ROAD, "D5 deckLoadPersonaScores",
     "          var _bestByPerson={};\n"
     "          interviews.forEach(function(iv){\n"
     "            var pk=String((iv&&iv.role)||'').trim().toLowerCase()+'||'+\n"
     "                   String((iv&&(iv.interviewee||iv.name))||'').trim().toLowerCase();\n"
     "            var rr=(iv&&iv.refreshRound?+iv.refreshRound:1);\n"
     "            var cur=_bestByPerson[pk];\n"
     "            var curRr=cur?(cur.refreshRound?+cur.refreshRound:1):-1;\n"
     "            if(!cur || rr>curRr) _bestByPerson[pk]=iv;\n"
     "          });\n"
     "          interviews=Object.keys(_bestByPerson).map(function(k){ return _bestByPerson[k]; });",
     "          interviews=interviews.filter(function(iv){ return (iv&&iv.refreshRound?+iv.refreshRound:1)===maxRound; });"),

    ("D6", "latestSession scope", IAG, "D6 auto-resume",
     "          if(String(sess.client||'').trim().toLowerCase() !== wantClient) return;\n"
     "          if(String(sess.stakeholderRole||'').trim().toLowerCase() !== wantRole) return;\n"
     "          // Name is matched when the invite carries one; an anonymous invite\n"
     "          // falls back to client+role so a genuine resume is never blocked.\n"
     "          if(wantName && String(sess.stakeholderName||'').trim().toLowerCase() !== wantName) return;\n",
     "          /*REVERT: no identity scoping*/\n"),
]


def run_suite():
    p = subprocess.run(["node", SUITE], capture_output=True, text=True)
    failed = {re.search(r"\[FAIL\] (.+)", l).group(1).strip()
              for l in p.stdout.splitlines() if "[FAIL]" in l}
    caps = {}
    for l in p.stdout.splitlines():
        m = re.match(r"CAPTURE (D\d) :: (.+)", l)
        if m:
            caps[m.group(1)] = m.group(2)
    return failed, caps, p.returncode


def run_capture():
    env = dict(os.environ, CAPTURE="1")
    p = subprocess.run(["node", SUITE], capture_output=True, text=True, env=env)
    caps = {}
    for l in p.stdout.splitlines():
        m = re.match(r"CAPTURE (D\d) :: (.+)", l)
        if m:
            caps[m.group(1)] = m.group(2)
    return caps


def patch(path, old, new):
    with open(path, encoding="utf-8") as f:
        s = f.read()
    if s.count(old) != 1:
        raise SystemExit(f"  ANCHOR ERROR in {os.path.basename(path)}: expected 1 match, found {s.count(old)}")
    with open(path, "w", encoding="utf-8") as f:
        f.write(s.replace(old, new))


base_failed, _, base_rc = run_suite()
print(f"baseline: {'ALL PASS' if base_rc == 0 else 'FAILURES: ' + str(base_failed)}")
if base_rc != 0:
    raise SystemExit("baseline is not green — aborting")
fixed_caps = run_capture()

ok = True
worked = []
print("\nREVERT MATRIX")
for key, label, path, expect, fixed, buggy in FIXES:
    patch(path, fixed, buggy)
    failed, _, _ = run_suite()
    buggy_caps = run_capture()
    patch(path, buggy, fixed)
    hit = any(expect in f for f in failed)
    only = bool(failed) and all(expect in f for f in failed)
    if not (hit and only):
        ok = False
    print(f"  [{'OK' if (hit and only) else 'UNEXPECTED'}] revert {label:26s} -> {len(failed)} case red"
          + ("" if (hit and only) else f"  {sorted(failed)}"))
    worked.append((key, label, buggy_caps.get(key, "(no capture)"), fixed_caps.get(key, "(no capture)")))

# Defect 2 — source-level revert
D2_FIXED, D2_BUGGY = "    var personas=personaScores;", "    var personas=deckLoadPersonaScores();"
with open(ROAD, encoding="utf-8") as f:
    road = f.read()
d2_ok = road.count(D2_FIXED) == 1 and road.count(D2_BUGGY) == 0
patch(ROAD, D2_FIXED, D2_BUGGY)
with open(ROAD, encoding="utf-8") as f:
    d2_reintroduced = f.read().count(D2_BUGGY) == 1
patch(ROAD, D2_BUGGY, D2_FIXED)
if not (d2_ok and d2_reintroduced):
    ok = False
print(f"  [{'OK' if (d2_ok and d2_reintroduced) else 'UNEXPECTED'}] revert deck appendix leak (source)   -> reload reintroduced={d2_reintroduced}")

print("\nWORKED EXAMPLES (real output, buggy vs fixed)")
for key, label, b, f in worked:
    print(f"\n  {key}  {label}")
    print(f"    BUGGY: {b}")
    print(f"    FIXED: {f}")

final_failed, _, final_rc = run_suite()
print(f"\nrestored: {'ALL PASS' if final_rc == 0 else 'STILL FAILING: ' + str(final_failed)}")
sys.exit(0 if (ok and final_rc == 0) else 1)
