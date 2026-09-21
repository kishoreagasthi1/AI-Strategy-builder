/**
 * One stored entry per spoken line. (v5.34.132)
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * Every live line — interviewer and interviewee — was stored twice:
 *
 *     {"at":1789647196985, "text":"Hi Avery,"}
 *     {"at":null,          "text":"Hi Avery, I'm Jack Smith. This is just a short…"}
 *
 * liveAppend's new-bubble branch called addMessage(), which stores the entry,
 * and then pushed a second one of its own. Later fragments updated only the
 * last entry, so the first stayed frozen at the opening fragment. The screen
 * drew one bubble; the record held two. The 2026-09-18 Northwind interview was 52
 * spoken turns stored as 104, with the `at` pattern above on all 52 pairs.
 *
 * ── Why these tests run the page's own code ─────────────────────────────────
 *
 * The bug is an interaction between two functions — neither is wrong alone —
 * so a test of either one in isolation passes on the broken page. These lift
 * the REAL addMessage and liveAppend out of interview_agent.html and drive them
 * with the fragment stream a live interview produces, over a minimal DOM.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const page = readFileSync(join(root, "frontend", "interview_agent.html"), "utf8");

function fnSrc(src: string, name: string): string {
  const i = src.indexOf(`function ${name}(`);
  expect(i, `function ${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(i);
  const next = rest.slice(1).search(/\n(?:async )?function [A-Za-z_]/);
  return next > 0 ? rest.slice(0, next + 1) : rest;
}

/** Just enough DOM for addMessage and liveAppend. */
type Stub = { textContent?: string; attrs: Record<string, string>; setAttribute(k: string, v: string): void };
function fakeDom() {
  const mkStub = (): Stub => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  type Node = { className: string; html: string; parts: Record<string, Stub>;
                innerHTML: string; querySelector(sel: string): Stub | null };
  const children: Node[] = [];
  const createElement = (): Node => {
    const n: Node = {
      className: "", html: "", parts: {},
      set innerHTML(v: string) {
        n.html = v;
        if (v.includes("msg-bubble")) n.parts[".msg-bubble"] = mkStub();
        if (v.includes("clarify-btn")) {
          const b = mkStub();
          const m = /data-original="([^"]*)"/.exec(v);
          if (m) b.attrs["data-original"] = m[1];
          n.parts[".clarify-btn"] = b;
        }
      },
      get innerHTML() { return n.html; },
      querySelector(sel: string) { return n.parts[sel] || null; },
    };
    return n;
  };
  const wrap = {
    scrollTop: 0, scrollHeight: 0,
    appendChild(n: Node) { children.push(n); },
    get lastElementChild() { return children[children.length - 1] || null; },
    contains(el: unknown) { return children.some((c) => Object.values(c.parts).includes(el as Stub)); },
  };
  return {
    children,
    document: {
      getElementById: (id: string) => (id === "messages-wrap" ? wrap : null),
      createElement,
    },
  };
}

type Entry = { role: string; text: string; at?: number };

/** The page's real functions, running against a fresh record. */
function live() {
  const S: { displayMessages: Entry[]; stakeholderName: string } = { displayMessages: [], stakeholderName: "Avery" };
  const dom = fakeDom();
  const src = [
    /^var _liveLast = .*?;$/m.exec(page)![0],
    fnSrc(page, "addMessage"),
    fnSrc(page, "liveAppend"),
    fnSrc(page, "liveBreakTurn"),
  ].join("\n");
  // eslint-disable-next-line no-new-func
  const mk = new Function("S", "document", "esc", "fmt", "agentInitials", "agentLabel", `
    ${src}
    return { addMessage, liveAppend, liveBreakTurn };`);
  const f = mk(S, dom.document, (x: string) => String(x), (x: string) => String(x),
               () => "JS", () => "Jack Smith") as {
    addMessage: (role: string, text: string, extra?: Record<string, unknown>) => void;
    liveAppend: (who: string, text: string) => void;
    liveBreakTurn: () => void;
  };
  return { S, dom, ...f };
}

describe("v5.34.132 — a spoken line is stored once", () => {
  it("an interviewer line streamed in fragments is one entry with the whole line", () => {
    const L = live();
    for (const frag of ["Hi Avery,", " I'm Jack Smith.", " This is just a short,", " candid conversation."]) {
      L.liveAppend("ai", frag);
    }
    expect(L.S.displayMessages).toHaveLength(1);
    expect(L.S.displayMessages[0].text).toBe("Hi Avery, I'm Jack Smith. This is just a short, candid conversation.");
  });

  it("an answer that arrives as ONE fragment is one entry, not two identical ones", () => {
    /* 25 of the 52 pairs in the real record were word-for-word duplicates —
     * the interviewee's transcription often lands whole. */
    const L = live();
    L.liveAppend("user", "Hey Jack. I don't feel like talking about AI today.");
    expect(L.S.displayMessages).toHaveLength(1);
  });

  it("a conversation stores exactly one entry per turn, for both speakers", () => {
    const L = live();
    L.liveAppend("ai", "Hi"); L.liveAppend("ai", " Avery.");
    L.liveAppend("user", "Hey."); L.liveAppend("user", " Jack.");
    L.liveAppend("ai", "Where"); L.liveAppend("ai", " does your data sit?");
    L.liveAppend("user", "In a lake.");
    expect(L.S.displayMessages.map((m) => [m.role, m.text])).toEqual([
      ["ai", "Hi Avery."], ["user", "Hey. Jack."], ["ai", "Where does your data sit?"], ["user", "In a lake."],
    ]);
  });

  it("the stored entry carries the time the line STARTED", () => {
    /* The surviving entry used to be the un-timed one — the record's `at`
     * column was null on every second entry of every pair. */
    const L = live();
    L.liveAppend("ai", "Hi"); L.liveAppend("ai", " there.");
    const at = L.S.displayMessages[0].at;
    expect(typeof at).toBe("number");
    expect(at).toBeGreaterThan(0);
  });

  it("a message written mid-utterance does not split or triple the line", () => {
    /*
     * The old rule updated "the last entry, if it has this role". Anything
     * written between two fragments — a warning, a status line — made the last
     * entry the wrong one, and the line was pushed yet again. Tracking the entry
     * by reference makes that impossible.
     */
    const L = live();
    L.liveAppend("user", "We have");
    L.addMessage("ai", "⚠️ connection is slow");
    L.liveAppend("user", " a global data lake.");
    const user = L.S.displayMessages.filter((m) => m.role === "user");
    expect(user).toHaveLength(1);
    expect(user[0].text).toBe("We have a global data lake.");
    expect(L.S.displayMessages).toHaveLength(2);
  });

  it("a new turn from the same speaker after a break is a new entry", () => {
    const L = live();
    L.liveAppend("ai", "First question?");
    L.liveBreakTurn();
    L.liveAppend("ai", "Second question?");
    expect(L.S.displayMessages.map((m) => m.text)).toEqual(["First question?", "Second question?"]);
  });

  it("'Add to this answer' quotes the whole answer, not its first fragment", () => {
    const L = live();
    L.liveAppend("user", "Hey Jack.");
    L.liveAppend("user", " We budget for AI separately.");
    const btn = L.dom.children[0].querySelector(".clarify-btn")!;
    expect(decodeURIComponent(btn.attrs["data-original"])).toBe("Hey Jack. We budget for AI separately.");
  });

  it("stores its own entry if addMessage ever stops storing one — never both", () => {
    /* The fallback branch, exercised: a replay-mode addMessage draws without
     * storing, so liveAppend must store exactly one entry itself. */
    const L = live();
    const real = L.addMessage;
    const src = [/^var _liveLast = .*?;$/m.exec(page)![0], fnSrc(page, "liveAppend")].join("\n");
    // eslint-disable-next-line no-new-func
    const mk = new Function("S", "document", "addMessage", `${src}\nreturn liveAppend;`);
    const append = mk(L.S, L.dom.document, (r: string, t: string) => real(r, t, { replay: true })) as
      (who: string, text: string) => void;
    append("ai", "Drawn"); append("ai", " only.");
    expect(L.S.displayMessages).toHaveLength(1);
    expect(L.S.displayMessages[0].text).toBe("Drawn only.");
  });

  it("liveAppend has no second push of its own", () => {
    const body = fnSrc(page, "liveAppend");
    expect(body, "the old mirror push is back").not.toMatch(/t\.push\(\{ role: who, text: text \}\)/);
    expect(body).toMatch(/_liveLast\.entry\.text = _liveLast\.text/);
  });
});
