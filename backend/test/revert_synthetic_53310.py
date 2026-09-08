#!/usr/bin/env python3
"""Revert-test the two 5.33.10 synthetic fixes against the scratch DB."""
import subprocess, os, sys, re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(ROOT, "backend", "src", "routes", "synthetic.ts")
ENV = dict(os.environ,
           RLS_TEST="1",
           TEST_DATABASE_URL="postgres://vyne:vyne@localhost:5433/vyne",
           RLS_APP_URL="postgres://vyne_app:apppw@localhost:5433/vyne")

FIXES = [
    ("B briefing code-key read", "CODE-keyed briefing",
     "test/syntheticChunked.test.ts",
     '    try {\n'
     '      briefing0 = JSON.parse(\n'
     '        (codeForClient ? ws["vynora_briefing_" + codeForClient] : undefined)\n'
     '          ?? ws["vynora_briefing_" + norm]\n'
     '          ?? "null"\n'
     '      );\n'
     '    } catch { /* none */ }',
     '    try {\n'
     '      briefing0 = JSON.parse(ws["vynora_briefing_" + norm] ?? "null"); /*REVERT: norm only*/\n'
     '    } catch { /* none */ }'),

    ("A specimen follow-up synthetic=true", "replaces rather than 500s",
     "test/synthetic.test.ts",
     "            kind, parent_interview_id, agenda_status, interviewee_user_id,\n"
     "            synthetic)\n"
     "         VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,\n"
     "                 $1, $2, $3, 'completed', $4, $5, now(), now(),\n"
     "                 $6, $7, $8, 'follow_up', $9, 'approved', $10, true)",
     "            kind, parent_interview_id, agenda_status, interviewee_user_id)\n"
     "         VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,\n"
     "                 $1, $2, $3, 'completed', $4, $5, now(), now(),\n"
     "                 $6, $7, $8, 'follow_up', $9, 'approved', $10)"),
]


def run(testfile, _name_filter):
    # Whole file — these suites share ordered state, so -t filtering is unsafe.
    p = subprocess.run(
        ["npx", "vitest", "run", testfile],
        cwd=os.path.join(ROOT, "backend"), env=ENV, capture_output=True, text=True)
    line = ""
    for ln in p.stdout.splitlines():
        if re.search(r"^\s*Tests\s", ln):
            line = ln
    fm = re.search(r"(\d+)\s+failed", line)
    pm = re.search(r"(\d+)\s+passed", line)
    return (int(fm.group(1)) if fm else 0), (int(pm.group(1)) if pm else 0)


def patch(old, new):
    with open(SRC, encoding="utf-8") as f:
        s = f.read()
    if s.count(old) != 1:
        raise SystemExit(f"ANCHOR ERROR: expected 1 match, found {s.count(old)}")
    with open(SRC, "w", encoding="utf-8") as f:
        f.write(s.replace(old, new))


ok = True
for label, filt, testfile, fixed, buggy in FIXES:
    base_f, base_p = run(testfile, filt)
    patch(fixed, buggy)
    rev_f, rev_p = run(testfile, filt)
    patch(buggy, fixed)
    rest_f, rest_p = run(testfile, filt)
    good = base_f == 0 and rev_f >= 1 and rest_f == 0
    ok = ok and good
    print(f"  [{'OK' if good else 'UNEXPECTED'}] {label}: baseline {base_p}p/{base_f}f "
          f"-> reverted {rev_p}p/{rev_f}f (expect >=1 fail) -> restored {rest_p}p/{rest_f}f")

sys.exit(0 if ok else 1)
