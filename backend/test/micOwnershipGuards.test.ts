/**
 * v5.34.22 — interview_agent.html: the live session is the ONLY microphone,
 * audio-output and turn owner while it owns the interview.
 *
 * The page has no test runner, so the load-bearing parts are pinned as
 * source-text guards (same approach as frontendXssGuards): each one names a
 * line whose removal would quietly reintroduce a second capture chain or a
 * second voice. The behaviour of the two JS modules themselves is tested for
 * real in liveTurnOwnership.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "..", "..", "frontend", "interview_agent.html"), "utf8");

/** Body of a top-level `function name(` … up to the next top-level function. */
function fn(name: string): string {
  const i = src.indexOf(`function ${name}(`);
  expect(i, `function ${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(i + 1);
  const next = rest.search(/\n(?:async )?function [A-Za-z_]/);
  return rest.slice(0, next > 0 ? next : undefined);
}

describe("mic ownership guards (interview_agent.html)", () => {
  it("defines liveOwnsConversation() as LIVE-and-not-stopped (sticky across a renewal)", () => {
    expect(src).toMatch(/function liveOwnsConversation\(\)\{\s*return !!\(LIVE && !LIVE\.stopped\);/);
  });

  it("the mic button never starts the legacy recogniser while live owns the mic", () => {
    const body = fn("toggleMic");
    const guard = body.indexOf("if(liveOwnsConversation())");
    const start = body.indexOf("recognition.start()");
    expect(guard).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(guard);
    expect(body.slice(guard, start)).toContain("return;");
  });

  it("TTS never plays over a live session (one audio output)", () => {
    const body = fn("speak");
    expect(body).toMatch(/if\(liveOwnsConversation\(\)\)\{[^\n]*return; \}/);
  });

  it("the after-speech auto-mic is text+TTS only", () => {
    expect(fn("onSpeakEnd")).toContain("!liveOwnsConversation()");
  });

  it("sendToAgent routes by OWNERSHIP, not by momentary socket liveness", () => {
    const body = fn("sendToAgent");
    expect(body).toContain("if(liveOwnsConversation()){");
    expect(body).not.toMatch(/if\(typeof liveActive==='function' && liveActive\(\)\)\{\s*try\{ LIVE\.say/);
  });

  it("the tap-to-begin handler does not build the recogniser before trying live", () => {
    const i = src.indexOf("overlay.onclick=async()=>{");
    const j = src.indexOf("await startLiveVoice(isResume);", i);
    expect(i).toBeGreaterThan(-1); expect(j).toBeGreaterThan(i);
    expect(src.slice(i, j)).not.toContain("buildRecognition()");
    // …and builds it only on the standard path
    const k = src.indexOf("if(!wentLive){", j);
    expect(src.slice(k, k + 400)).toContain("recognition=buildRecognition()");
  });

  it("launchInterviewScreen no longer pre-builds a second microphone owner", () => {
    const body = fn("launchInterviewScreen");
    const beforeTap = body.slice(0, body.indexOf("overlay.onclick=async()=>{"));
    expect(beforeTap.length).toBeGreaterThan(100);
    expect(beforeTap).not.toContain("buildRecognition()");
  });

  it("a hard refresh releases the live grant (pagehide → LIVE.stop)", () => {
    expect(src).toMatch(/addEventListener\('pagehide'[\s\S]{0,300}LIVE\.stop\('page_unload'\)/);
  });

  it("recogniser start/stop and text-path turns are traced with a stack", () => {
    expect(fn("buildRecognition")).toContain("VL('recognition.'+m+'()'");
    expect(fn("callClaude")).toContain("VL('callClaude()");
    expect(fn("sendToAgent")).toContain("VL('sendToAgent()'");
  });

  it("the live path shows turn state and mic level instead of the standard mic controls", () => {
    expect(src).toMatch(/onTurnState: function\(st\)\{\s*setLiveTurnState\(st\);/);
    expect(src).toContain("onMicLevel: function(rms){ setLiveMicLevel(rms); }");
    expect(src).toContain("setLiveMicUI(true);");
  });
});

describe("v5.34.33 — an interview that ends early is not lost", () => {
  it("a terminal end saves synchronously, before any debounce can drop the last turn", () => {
    const body = fn("startLiveVoice");
    const i = body.indexOf("onEnded: function(r, turns){");
    expect(i, "onEnded no longer takes the turns it is handed").toBeGreaterThan(-1);
    const handler = body.slice(i, i + 2200);
    // saveSession(), not autoSave(): the debounced path is what loses the tail.
    expect(handler).toContain("try{ saveSession(); }catch(e){}");
    expect(handler.indexOf("saveSession()")).toBeLessThan(handler.indexOf("setVoiceBadge"));
    expect(handler).toContain("you can resume with your code");
  });

  it("a resumed live session is told what was already covered", () => {
    // Without this the interviewer walks back in with no memory and re-asks
    // ground already covered — the failure mode of "continue later".
    expect(src).toContain("function priorTranscriptBlock(budget){");
    /*
     * v5.34.73 moved this call to the TOP of buildLiveContext and put it behind
     * the budget allocator. It used to be appended last, which meant that on a
     * long briefing the outer .slice(0, 5800) cut into the most recent
     * exchanges — the opposite of what this test is protecting. Assert the call
     * and its budget, not where in the function it sits.
     */
    expect(fn("buildLiveContext")).toContain("priorTranscriptBlock(3200)");
    const block = fn("priorTranscriptBlock");
    expect(block).toContain("S.displayMessages");
    expect(block).toContain("This interview is being CONTINUED");
    expect(block).toContain("Do not start over");
    // Bounded from the end, so the RECENT exchanges are the ones carried.
    expect(block).toContain("for(var i = msgs.length - 1; i >= 0; i--)");
    expect(block).toContain("lines.unshift(line);");
  });

  it("the live transcript is mirrored into the durable record on every fragment", () => {
    const body = fn("liveAppend");
    expect(body).toContain("S.displayMessages || (S.displayMessages = [])");
    expect(fn("saveSession")).toContain("displayMessages:S.displayMessages,");
  });
});
