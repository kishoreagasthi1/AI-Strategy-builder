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

WORKDIR /app/backend
ENTRYPOINT ["npx", "vitest", "run"]
