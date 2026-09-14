/**
 * Guards the single-source-of-truth split across two files that can't
 * literally share a constant (backend/src/version.ts is TypeScript served
 * over the API; frontend/vyne-client.js and frontend/about.html are plain
 * JS baked into the static bundle at packaging time — see version.ts's doc
 * comment for the incident this is preventing). If a release bumps one and
 * forgets the others, this fails instead of shipping a silently-mismatched
 * build.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { VERSION } from "../src/version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(here, "../../frontend");

describe("version parity across backend/frontend", () => {
  it("backend VERSION is a plausible semver-ish string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("frontend/vyne-client.js's VYNE_VERSION matches backend VERSION", () => {
    const src = readFileSync(path.join(frontendDir, "vyne-client.js"), "utf8");
    const m = src.match(/var VYNE_VERSION = "([^"]+)";/);
    expect(m, "vyne-client.js must define var VYNE_VERSION = \"x.y.z\";").not.toBeNull();
    expect(m![1]).toBe(VERSION);
  });

  it("frontend/about.html's FRONTEND_VERSION matches backend VERSION", () => {
    const src = readFileSync(path.join(frontendDir, "about.html"), "utf8");
    const m = src.match(/var FRONTEND_VERSION = "([^"]+)";/);
    expect(m, "about.html must define var FRONTEND_VERSION = \"x.y.z\";").not.toBeNull();
    expect(m![1]).toBe(VERSION);
  });
});
