-- The restricted role the least-privilege tests connect as. (v5.34.63)
--
-- Created by Postgres' own init hook rather than by the test container, which
-- is the fix for two things at once:
--
--   · the test image is Microsoft's Playwright image, which ships Node and the
--     browser's system libraries and is not expected to carry a Postgres
--     client — so the `psql ... && npx vitest run` command the compose file
--     used to carry would have died at its first word, before a single test.
--     Doing it here removes the dependency on that expectation being right,
--     which matters because nobody has ever built this image to find out;
--   · this now happens BEFORE the migrations, rather than racing them. The
--     migrations GRANT to vyne_app, and a grant to a role that does not exist
--     yet is an error.
--
-- The password matches RLS_APP_URL in docker-compose.yml. It is a throwaway
-- for an ephemeral container with no published port; production's is set by
-- deploy.sh from Secret Manager and never appears in this repository.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vyne_app') THEN
    CREATE ROLE vyne_app LOGIN PASSWORD 'change-me-via-ops';
  END IF;
END
$$;
