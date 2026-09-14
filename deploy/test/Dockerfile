# The UI + regression runner. (v5.34.56)
#
# Base image is Microsoft's Playwright image, which already contains Chromium
# and every shared library a headless browser needs on Linux. That is the whole
# reason to use Docker here: "works on my Mac, fails in CI" for browser tests is
# almost always a missing system library, and pinning the image removes it.
#
# Pin the tag. `:latest` would mean the browser under test changes without
# anyone deciding to change it — which is the same class of problem as the
# harness recording on a different model than production ran (see v5.34.51).
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

ENV CI=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# A skipped browser suite in THIS image would defeat the point of the image.
ENV VYNE_REQUIRE_BROWSER=1

WORKDIR /app

# Dependencies first, so a source change does not reinstall node_modules.
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --no-audit --no-fund

# The suite reads frontend/ directly — it serves those files to the browser.
COPY backend ./backend
COPY frontend ./frontend
#
# v5.34.64. deploy/ was missing, and five test files read from it:
#
#   deployByokIam       deploy/deploy.sh          the BYOK IAM role
#   deployTestRunner    deploy/test/*             this image's own compose file
#   preflightChecks     deploy/preflight-lib.sh   sourced into a real bash
#   liveTurnOwnership   deploy/voice-record.mjs   the recorder's handover log
#   sweepStaleHolds     deploy/*.sql              the backfill script
#
# They did not fail — they could not even LOAD, because the readFileSync is at
# module top level, so vitest reported five failed SUITES before any test ran.
# The image that exists to stop things silently not being tested was silently
# not testing the deploy scripts, which are the least covered code in the repo
# and the only part that touches production directly.
COPY deploy ./deploy
#
# Repo-ROOT dotfiles, which two tests read and which no directory COPY brings:
#   .gcloudignore   securityAuditFixes — what `gcloud run deploy --source .`
#                   uploads to the build bucket (a developer's .env, once)
#   .dockerignore   deployTestRunner — that the host's node_modules cannot
#                   overwrite the image's
#
# Listed explicitly because a glob for dotfiles would silently pick up anything
# else that appears at the root later, and these two are read for their exact
# contents.
COPY .gcloudignore .dockerignore ./

WORKDIR /app/backend
ENTRYPOINT ["npx", "vitest", "run"]
