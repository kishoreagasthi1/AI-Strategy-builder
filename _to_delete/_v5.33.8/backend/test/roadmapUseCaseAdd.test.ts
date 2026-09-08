/**
 * v5.32.7 postmortem: the Roadmap Builder's "+ Add AI-generated use case"
 * flow (frontend/roadmap.html) resolved the target department at COMMIT
 * time by re-deriving it from a numeric index — `getDepts()[di]` — after an
 * async LLM call had already completed. Reported symptom: a use case added
 * from an industry-specific department's box could land under the
 * always-on "Cross-Industry & Corporate Functions" section instead, and
 * afterwards the add prompt for that department appeared to vanish. The
 * add button's click handler also collapsed the creator box unconditionally
 * on every click, whether or not the add actually succeeded — so a silently
 * failed commit (the old code's `if(!dept) return;` with zero user
 * feedback) looked identical to a successful one-and-done add, reinforcing
 * "it only lets me add once."
 *
 * The fix: the department is resolved ONCE, at render time, as a direct
 * object reference — not a positional index re-looked-up later — and is
 * threaded through generateCustomUc() -> commitGeneratedUc() unchanged.
 * commitGeneratedUc() now reports success/failure via its return value, and
 * the click handler only collapses/resets on failure; on success it clears
 * the box and keeps it open with a confirmation naming the department, so
 * adding several use cases in a row doesn't require rediscovering the
 * prompt each time.
 *
 * There's no frontend test runner in this repo (static HTML+JS pages, no
 * bundler — see frontendXssGuards.test.ts / roleCanon.test.ts for the same
 * pattern), so this is a static source-text regression guard from the
 * backend's vitest suite.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dirname, "..", "..", "frontend");

function readRoadmap(): string {
  return readFileSync(join(FRONTEND, "roadmap.html"), "utf8");
}

describe("roadmap.html — AI-generated use case add (v5.32.7)", () => {
  it("commitGeneratedUc takes the department object directly, not a re-derived index lookup", () => {
    const src = readRoadmap();
    expect(src).toContain("function commitGeneratedUc(ucData, dept, di){");
    // The old bug pattern — re-resolving the department from `di` at commit
    // time — must not come back as executable code anywhere in the file.
    // (The dead `addCustomInitiative()` helper had the same pattern and was
    // removed entirely in the same fix, rather than left dormant.)
    const codeLines = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(codeLines).not.toContain("getDepts()[di]");
    expect(src).not.toContain("function addCustomInitiative(");
  });

  it("commitGeneratedUc validates the passed-in department and reports failure via return value", () => {
    const src = readRoadmap();
    expect(src).toMatch(/if\(!dept\s*\|\|\s*!Array\.isArray\(dept\.uc\)\)\s*return false;/);
    expect(src).toContain("return true;");
  });

  it("the department-block render loop passes the department OBJECT (not just its name) into the AI creator", () => {
    const src = readRoadmap();
    // The IIFE that wires up the collapsed row / generate button / cancel
    // button must be invoked with `dept` (the object from the depts.forEach
    // loop), not `dept.name` (a string with no way back to the right array).
    expect(src).toMatch(/\}\)\(dept,di,taId,btnId2,stId,pvId,expandedDiv,ta\);/);
    expect(src).not.toContain("}(dept.name,di,taId,btnId2,stId,pvId,expandedDiv,ta);");
  });

  it("generateCustomUc and commitGeneratedUc are called with the department object end-to-end", () => {
    const src = readRoadmap();
    expect(src).toContain("async function generateCustomUc(dept, di, textareaId, btnId, statusId, previewId){");
    expect(src).toContain("generateCustomUc(deptObj,dIdx,tId,bId,sId,pId)");
    expect(src).toContain("commitGeneratedUc(ucData, deptObj, dIdx)");
  });

  it("the add-button handler only resets/collapses the creator when the commit actually succeeded", () => {
    const src = readRoadmap();
    const handlerMatch = src.match(
      /addBtn\.onclick = function\(\)\{([\s\S]*?)\};\s*\}\)\(uc, dept, di\);/
    );
    expect(handlerMatch, "expected to find the wired-up ai-preview-add onclick handler").toBeTruthy();
    const body = handlerMatch![1];
    expect(body).toContain("var ok = commitGeneratedUc(ucData, deptObj, dIdx);");
    expect(body).toMatch(/if\(ok\)\{/);
    // Regression: the old handler called commitGeneratedUc() and then reset
    // the UI unconditionally on the very next lines, with no success check —
    // that's what made a silent failure look like "it only works once."
    expect(body).not.toMatch(/commitGeneratedUc\([^)]*\);\s*\/\/ Reset the creator/);
  });

  it("a successful add keeps the creator open for another entry instead of collapsing it", () => {
    const src = readRoadmap();
    expect(src).toContain("Describe another to add more, or click the prompt above to close.");
    // The success path must NOT close ai-expanded-<di> — closing it is what
    // made the prompt look like it had disappeared after the first add.
    const successBlock = src.split("Describe another to add more")[0].slice(-600);
    expect(successBlock).not.toContain("classList.remove('open')");
  });
});
