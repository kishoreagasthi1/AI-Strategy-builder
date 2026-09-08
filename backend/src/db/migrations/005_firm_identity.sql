-- 005: White-label firm identity.
-- slug: human-friendly firm handle ("vynora-consulting") — usable in
--       login links (?firm=vynora-consulting) instead of the IdP tenant id.
-- custom_domain: white-label hostname (vyne.meridianadvisors.com) that
--       resolves straight to the firm at login; the tenant-id concept
--       disappears from the user's view entirely.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS custom_domain text;

-- Backfill slugs for existing firms from their names (collision-safe:
-- later duplicates get a short id suffix).
WITH s AS (
  SELECT id,
         trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')) AS base,
         row_number() OVER (
           PARTITION BY trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))
           ORDER BY created_at
         ) AS rn
  FROM tenants
  WHERE slug IS NULL
)
UPDATE tenants t
   SET slug = CASE WHEN s.rn = 1 THEN s.base ELSE s.base || '-' || substr(t.id::text, 1, 4) END
  FROM s
 WHERE s.id = t.id;

CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_uq ON tenants (slug) WHERE slug IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_custom_domain_uq ON tenants (custom_domain) WHERE custom_domain IS NOT NULL;
