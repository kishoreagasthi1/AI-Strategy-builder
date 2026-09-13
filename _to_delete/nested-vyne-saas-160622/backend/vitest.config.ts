/**
 * v5.34.37 — added for ONE reason: `setupFiles`.
 *
 * The suite ran on vitest's defaults until now, which was fine until the
 * release gate started failing because of variables the operator exported in
 * order to DEPLOY them (see test/setup.env.ts for the full story and the two
 * deploys it cost). A setup file is the only place that can insulate every
 * test file from the shell, so this config exists to point at it.
 *
 * Everything else is left at the default deliberately: the fewer knobs here,
 * the fewer ways the suite can differ between a laptop, the gate and CI.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.env.ts"],
  },
});
