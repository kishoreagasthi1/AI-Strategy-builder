/**
 * deploy/preflight-lib.sh — the first tests preflight has ever had (v5.32.70).
 *
 * WHY. preflight.sh shipped three bugs in two releases and every one of them
 * printed something reassuring while being wrong:
 *
 *   · check 3 passed on "more than one distinct address" while 235 of 300
 *     requests resolved to 169.254.169.126, a link-local proxy hop
 *   · check 6 passed on "the list is not empty" with the newest backup two days
 *     old and automated backups off
 *   · check 6 then printed "newest is -4h old" — gcloud emits UTC, BSD date
 *     parses local, and the resulting NEGATIVE age sailed past the staleness
 *     test, so a misparsed timestamp read as fresh
 *
 * That last one is the reason this file exists rather than a fourth careful
 * read-through. A monitoring script that fails open is worse than no script:
 * it converts "nobody checked" into "somebody checked and it was fine".
 *
 * These drive the real shell functions in a real bash, with no gcloud and no
 * network. Each case below is either a bug that shipped or the fail-open
 * direction of one.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "preflight-lib.sh");

/** Run one library function in a real bash, optionally with stdin. */
function sh(snippet: string, stdin = "", env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("bash", ["-c", `. '${LIB}'; ${snippet}`], {
    input: stdin, encoding: "utf8", env: { ...process.env, ...env },
  }).trim();
}

/**
 * A stand-in for BSD/macOS `date`, because the bug that shipped is BSD-ONLY.
 *
 * This matters more than it looks. On Linux `date -j -f` does not exist, so the
 * library's first branch always fails and falls through to GNU `date -d`, which
 * is handed the full offset-bearing string and is correct under any TZ. Removing
 * the TZ=UTC fix and re-running the suite on Linux therefore PASSES — a test
 * that cannot fail for the bug it was written about.
 *
 * The shim reproduces the two BSD behaviours that caused it: `-j -f` parses in
 * the CURRENT timezone, and it refuses a stamp with trailing characters (which
 * is why vyne_normalize_stamp has to strip the offset before handing it over).
 */
let BSD_BIN = "";
function installBsdDateShim(): string {
  if (BSD_BIN) return BSD_BIN;
  const dir = mkdtempSync(join(tmpdir(), "bsddate-"));
  const shim = join(dir, "date");
  writeFileSync(shim, [
    "#!/usr/bin/env bash",
    'if [ "$1" = "-j" ] && [ "$2" = "-f" ]; then',
    '  fmt="$3"; stamp="$4"; out="$5"',
    "  # BSD's -f cannot express a fractional part or an offset.",
    "  [ \"$fmt\" = '%Y-%m-%dT%H:%M:%S' ] || exit 1",
    "  case \"$stamp\" in",
    "    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]) ;;",
    "    *) exit 1 ;;",
    "  esac",
    "  # The behaviour that caused the -4h bug: parsed in the CURRENT timezone.",
    '  exec /bin/date -d "$stamp" "$out"',
    "fi",
    'exec /bin/date "$@"',
  ].join("\n"));
  chmodSync(shim, 0o755);
  BSD_BIN = dir;
  return dir;
}

/** Run against the BSD shim, in a deliberately non-UTC timezone. */
function shBsd(snippet: string, tz = "America/Chicago"): string {
  const dir = installBsdDateShim();
  return sh(snippet, "", { PATH: `${dir}:${process.env.PATH}`, TZ: tz });
}

/** An RFC3339 UTC stamp `hours` in the past, shaped exactly like gcloud's. */
function stampHoursAgo(hours: number): string {
  const d = new Date(Date.now() - hours * 3600_000);
  // No fractional part here: the milliseconds case is exercised explicitly
  // below. The first version of this helper left them in AND appended more,
  // producing "...00.123.963+00:00" — the test failed on its first run for a
  // reason that was in the test, not the library. Keeping the base shape clean
  // means each case says what it means.
  return d.toISOString().replace(/\.\d+Z$/, "") + "+00:00";
}

describe("preflight-lib.sh exists and is loadable", () => {
  it("is where preflight.sh expects it", () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

describe("backup freshness (check 6)", () => {
  it("reads a UTC timestamp as UTC — the -4h bug", () => {
    // The exact failure: gcloud says 14:42 UTC, BSD `date -j -f` parses it in
    // local time, and on a UTC-5 machine the backup lands five hours in the
    // future. Any non-UTC test runner reproduces it, so this assertion is only
    // meaningful because it pins a NUMBER rather than "does not crash".
    expect(sh(`vyne_backup_age_hours '${stampHoursAgo(2)}'`)).toBe("2");
    expect(sh(`vyne_backup_age_hours '${stampHoursAgo(25)}'`)).toBe("25");
  });

  it("ON BSD, in a non-UTC timezone, still reads the stamp as UTC", () => {
    // THE bug, reproduced on the platform that had it. Without TZ=UTC this
    // returns "unparseable" (age -5, caught by the future guard) or a number
    // five hours wrong. The plain sh() version of this test passes either way
    // on Linux, which is exactly why the shim exists.
    expect(shBsd(`vyne_backup_age_hours '${stampHoursAgo(2)}'`)).toBe("2");
    expect(shBsd(`vyne_backup_age_hours '${stampHoursAgo(2)}'`, "Asia/Kolkata")).toBe("2");
    expect(shBsd(`vyne_backup_age_hours '${stampHoursAgo(40)}'`)).toBe("40");
  });

  it("ON BSD, the real gcloud string with milliseconds still parses", () => {
    // BSD -f refuses trailing characters outright, so without normalisation
    // this branch fails for EVERY healthy instance and silently defers to GNU
    // date — which does not exist on a Mac. That is "unparseable" forever.
    const real = stampHoursAgo(6).replace("+00:00", ".963+00:00");
    expect(shBsd(`vyne_backup_age_hours '${real}'`)).toBe("6");
  });

  it("a fresh backup is under the 36h staleness line", () => {
    expect(Number(sh(`vyne_backup_age_hours '${stampHoursAgo(12)}'`))).toBeLessThan(36);
  });

  it("a stale backup is over it — the schedule-not-running case", () => {
    expect(Number(sh(`vyne_backup_age_hours '${stampHoursAgo(50)}'`))).toBeGreaterThan(36);
    // The Aug-12 state that first passed: two days old, reported as fine.
    expect(Number(sh(`vyne_backup_age_hours '${stampHoursAgo(48)}'`))).toBeGreaterThan(36);
  });

  it("a FUTURE timestamp is unparseable, not fresh — the fail-open direction", () => {
    // This is the one that matters. A negative age used to pass `-gt 36` and
    // print a reassuring line. Anything that cannot be believed must not be
    // reported as good news.
    expect(sh(`vyne_backup_age_hours '${stampHoursAgo(-10)}'`)).toBe("unparseable");
  });

  it("tolerates an hour of clock skew rather than crying wolf at -0", () => {
    expect(sh(`vyne_backup_age_hours '${stampHoursAgo(-0.2)}'`)).toBe("0");
  });

  it("garbage and emptiness are unparseable, never a number", () => {
    expect(sh(`vyne_backup_age_hours ''`)).toBe("unparseable");
    expect(sh(`vyne_backup_age_hours 'not-a-date'`)).toBe("unparseable");
    expect(sh(`vyne_backup_age_hours 'SUCCESSFUL'`)).toBe("unparseable");
  });

  it("reduces every stamp shape gcloud emits to one bare form", () => {
    // The BSD branch feeds this to a format string that can express neither a
    // fractional part nor an offset, and BSD date's tolerance for trailing
    // characters varies by release. macOS is the platform this actually runs
    // on, so these three shapes must all collapse identically.
    expect(sh(`vyne_normalize_stamp '2026-08-14T14:42:46.963+00:00'`)).toBe("2026-08-14T14:42:46");
    expect(sh(`vyne_normalize_stamp '2026-08-14T14:42:46+00:00'`)).toBe("2026-08-14T14:42:46");
    expect(sh(`vyne_normalize_stamp '2026-08-14T14:42:46Z'`)).toBe("2026-08-14T14:42:46");
    expect(sh(`vyne_normalize_stamp '2026-08-14T14:42:46'`)).toBe("2026-08-14T14:42:46");
  });

  it("handles gcloud's fractional seconds", () => {
    // The real string is "2026-08-14T14:42:46.963+00:00". A parser that chokes
    // on .963 returns unparseable for every healthy instance.
    const withMs = stampHoursAgo(3).replace("+00:00", ".963+00:00");
    expect(sh(`vyne_backup_age_hours '${withMs}'`)).toBe("3");
  });
});

/** `uniq -c` output, exactly as check 3 pipes it. */
const REAL_PROD = [
  "    235 169.254.169.126",
  "     64 2600:1700:e60:be50:b926:45e4:2906:dfe6",
  "      1 34.162.230.222",
].join("\n");

describe("client-address sanity (check 3)", () => {
  it("counts the production traffic that resolved to a proxy hop", () => {
    // The run that PASSED under the old "more than one distinct address" rule.
    expect(sh("vyne_nonroutable_count", REAL_PROD)).toBe("235");
  });

  it("reports zero on genuinely routable clients", () => {
    // The false-POSITIVE direction. A check that flags healthy traffic gets
    // ignored, and an ignored check is the same as no check.
    const clean = ["     10 34.1.2.3", "      9 2600:1700::1", "      5 8.8.8.8"].join("\n");
    expect(sh("vyne_nonroutable_count", clean)).toBe("0");
  });

  it("catches every private range, not just link-local", () => {
    const ranges = [
      "  1 10.0.0.5", "  1 192.168.1.1", "  1 127.0.0.1",
      "  1 172.16.0.1", "  1 172.31.255.254", "  1 169.254.1.1", "  1 fd00::1",
    ].join("\n");
    expect(sh("vyne_nonroutable_count", ranges)).toBe("7");
  });

  it("does not mistake a public address that merely LOOKS private", () => {
    // 172.32.x and 172.15.x are public; the RFC1918 block is 172.16–172.31.
    // An over-broad regex here would flag real clients forever.
    const tricky = ["  4 172.32.0.1", "  3 172.15.0.1", "  2 11.0.0.1"].join("\n");
    expect(sh("vyne_nonroutable_count", tricky)).toBe("0");
  });

  it("computes the dominant-address share", () => {
    expect(sh("vyne_top_share_pct", REAL_PROD)).toBe("78");
    const even = ["  50 34.1.2.3", "  50 34.1.2.4"].join("\n");
    expect(sh("vyne_top_share_pct", even)).toBe("50");
  });

  it("does not divide by zero on empty input", () => {
    expect(sh("vyne_nonroutable_count", "")).toBe("0");
    expect(sh("vyne_top_share_pct", "")).toBe("0");
  });
});
