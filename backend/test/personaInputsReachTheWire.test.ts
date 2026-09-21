/**
 * Everything the persona is built from must actually reach the mint. (v5.34.84)
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * buildInterviewerInstruction takes `agenda`, `mandatoryCount` and `askedCount`
 * above the data fence. interview_agent.html has passed all three into
 * vyneLiveInterview.create() since v5.34.73, and vyne-live.js has read
 * self.opts.agenda / self.opts.mandatoryCount at mint time since v5.34.73.
 *
 * Between those two sits LiveInterview.prototype._sessionOpts(), which builds
 * the object handed to vyneLive.start(). It listed `context` and not the other
 * three. So vyne-live.js resolved them from an object that never carried them,
 * every mint sent undefined, and in EVERY live interview ever run:
 *
 *   · the seven-dimension agenda and role weighting were absent;
 *   · the entire mandatory-question block was absent — it is emitted only
 *     `if (mandatoryCount > 0)`, so "ask it on its own turn, never announce it"
 *     never reached the model;
 *   · "you already have evidence on D3, D6 — do not ask again" was absent;
 *   · the v5.34.79 no-repeat rule, gated on askedCount > 0, was absent.
 *
 * ── Why every existing test passed ──────────────────────────────────────────
 *
 * interviewerAgenda.test.ts and interviewNoRepeat.test.ts call
 * buildInterviewerInstruction DIRECTLY, so they prove the builder. The voice
 * harness renders its own instruction and supplies these three itself, so it
 * proves the builder too. Nothing tested the wire between the page and the
 * grant — and a value that never arrives is indistinguishable, from inside the
 * builder, from a caller that had nothing to send.
 *
 * That is the same failure as the harness's dead `onAgentText` hook, one layer
 * further out: a correctly-built thing, correctly tested, connected to nothing.
 *
 * ── What this asserts ───────────────────────────────────────────────────────
 *
 * The chain, read out of the three files, for every field the persona consumes:
 * the page passes it → _sessionOpts forwards it → the mint body sends it → the
 * route accepts it. Static, because standing up a browser and a live session to
 * discover a missing object key is what let this run for eleven versions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const PAGE = read("frontend/interview_agent.html");
const INTERVIEW = read("frontend/vyne-live-interview.js");
const LIVE = read("frontend/vyne-live.js");
const PERSONA = read("backend/src/llm/interviewerPersona.ts");
const ROUTE = read("backend/src/routes/voice.ts");

/** The object literal `_sessionOpts()` returns — what reaches vyneLive.start(). */
function sessionOptsBody(): string {
  const at = INTERVIEW.indexOf("LiveInterview.prototype._sessionOpts = function ()");
  expect(at, "_sessionOpts moved — update this test").toBeGreaterThan(-1);
  const end = INTERVIEW.indexOf("\n  };", at);
  expect(end).toBeGreaterThan(at);
  return INTERVIEW.slice(at, end);
}

/** The body of the mint request in vyne-live.js. */
function mintBody(): string {
  const at = LIVE.indexOf("body: JSON.stringify({");
  expect(at, "the mint body moved — update this test").toBeGreaterThan(-1);
  /* Closes on "      })" at the same indent as `body:`, which is the literal's
   * own terminator — not "}),", which nothing in this object ends with. */
  const end = LIVE.indexOf("\n      })\n", at);
  expect(end, "could not find the end of the mint body").toBeGreaterThan(at);
  return LIVE.slice(at, end);
}

/**
 * Every optional field of InterviewerContext that carries interview STATE.
 *
 * Read from the interface rather than listed here, so a field added to the
 * persona tomorrow is covered by this test the day it appears — which is the
 * only way this class of bug stops recurring. The identity fields are excluded
 * because they are derived inside _sessionOpts from `state` rather than passed
 * through by name.
 */
function personaStateFields(): string[] {
  const at = PERSONA.indexOf("export interface InterviewerContext {");
  expect(at).toBeGreaterThan(-1);
  const body = PERSONA.slice(at, PERSONA.indexOf("\n}", at));
  const all = [...body.matchAll(/^\s{2}(\w+)\?:/gm)].map((m) => m[1]);
  const derivedFromState = new Set([
    "interviewerName", "clientName", "industry", "intervieweeName", "intervieweeRole",
  ]);
  return all.filter((f) => !derivedFromState.has(f));
}

describe("v5.34.84 — the persona's inputs reach the grant", () => {
  it("knows which fields it is checking", () => {
    // A silent zero-match here would make everything below vacuously true,
    // which is this bug's exact shape.
    const fields = personaStateFields();
    expect(fields).toContain("agenda");
    expect(fields).toContain("mandatoryCount");
    expect(fields).toContain("askedCount");
    expect(fields).toContain("context");
  });

  it("_sessionOpts forwards every one of them", () => {
    /*
     * THE regression. Three of four were missing here while being read one
     * layer down, so they resolved to undefined on every mint.
     */
    const body = sessionOptsBody();
    const missing = personaStateFields().filter((f) => !new RegExp(`^\\s+${f}:`, "m").test(body));
    expect(missing, `_sessionOpts drops these, so the persona never sees them: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("the mint body sends every one of them", () => {
    const body = mintBody();
    const missing = personaStateFields().filter((f) => !new RegExp(`^\\s+${f}:`, "m").test(body));
    expect(missing, `the grant request omits: ${missing.join(", ")}`).toEqual([]);
  });

  it("the route accepts every one of them and passes them to the builder", () => {
    // The far end. A field the client sends and zod strips is just as dead.
    for (const f of personaStateFields()) {
      expect(ROUTE, `voice.ts has no schema entry for ${f}`).toMatch(new RegExp(`${f}:\\s*z\\.`));
      expect(ROUTE, `voice.ts never forwards ${f} to the instruction builder`)
        .toMatch(new RegExp(`${f}:\\s*parsed\\.data\\.${f}`));
    }
  });

  it("the VOICE HARNESS supplies them too, or the paid run proves nothing", () => {
    /*
     * v5.34.111 — the same parity check, pointed at deploy/voice-record.mjs.
     *
     * The harness deliberately renders the SHIPPED persona rather than a copy
     * of it ("render live, do not pin"), which is what lets a recorded run
     * exercise the real instruction. But it builds the context object itself,
     * so a field the product sends and the harness omits is a field the paid
     * run silently cannot test — while the verdict still reads as though it
     * had. That is this file's own documented trap ("a correctly-built thing,
     * correctly tested, connected to nothing") pointed at the instrument
     * instead of the product.
     *
     * Caught exactly this on v5.34.111: the three fields carrying the
     * early-close fix were wired through all four product layers and not
     * through the harness, so the next soak would have measured the old
     * behaviour.
     */
    const RIG = read("deploy/voice-record.mjs");
    const at = RIG.indexOf("renderInstruction = (f) =>");
    expect(at, "the harness's instruction renderer moved — update this test").toBeGreaterThan(-1);
    const body = RIG.slice(at, RIG.indexOf("\n    });", at));
    const missing = personaStateFields().filter((f) => !new RegExp(`\\b${f}:`).test(body));
    expect(
      missing,
      `deploy/voice-record.mjs renders the persona without: ${missing.join(", ")} — ` +
        "a recorded run cannot exercise them, and the verdict will not say so",
    ).toEqual([]);
  });

  it("the page supplies them, so there is something to forward", () => {
    const at = PAGE.indexOf("window.vyneLiveInterview.create({");
    expect(at, "the page no longer creates a live interview — update this test").toBeGreaterThan(-1);
    const body = PAGE.slice(at, PAGE.indexOf("\n  });", at));
    for (const f of ["context", "agenda", "mandatoryCount", "askedCount"]) {
      expect(body, `interview_agent.html does not pass ${f}`).toMatch(new RegExp(`^\\s+${f}:`, "m"));
    }
  });

  it("the three that change during an interview are resolved AT MINT, not captured", () => {
    /*
     * A handover starts a session with no memory of the conversation. If these
     * were captured at create() the fresh session would be told the interview
     * as it stood at minute zero — nothing asked, nothing evidenced, every
     * required question outstanding — which is precisely the state that makes
     * it repeat itself. v5.34.79 fixed that for `context`; the same has to hold
     * for the counts that accompany it, or they disagree with it.
     */
    const body = mintBody();
    for (const f of ["context", "agenda", "mandatoryCount", "askedCount"]) {
      expect(body, `${f} is sent but not resolved at mint time`)
        .toMatch(new RegExp(`${f}: \\(function\\(\\w\\)\\{`));
    }
    // And the page passes functions, so there is something to resolve.
    for (const f of ["context", "agenda", "mandatoryCount", "askedCount"]) {
      expect(PAGE, `the page passes a static ${f}; a handover will re-send minute zero`)
        .toMatch(new RegExp(`${f}: function\\(\\)`));
    }
  });

  it("_sessionOpts passes them through WITHOUT resolving them itself", () => {
    // Resolving here would re-freeze the value one layer down — the v5.34.79
    // bug moved rather than fixed.
    const body = sessionOptsBody();
    for (const f of ["context", "agenda", "mandatoryCount", "askedCount"]) {
      expect(body, `_sessionOpts calls ${f} instead of forwarding it`)
        .not.toMatch(new RegExp(`${f}:[^,]*\\b${f}\\(\\)`));
    }
  });
});
