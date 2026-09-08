-- =============================================================================
-- 021 — Follow-up agendas stop carrying a colleague's sentence to the interviewee
--
-- v5.32.65 (audit V2-M1). A follow-up agenda item is {dimension, text}, and
-- `text` is rendered verbatim on the interviewee's welcome screen and used to
-- centre the interview. The draft built that text out of OTHER interviewees'
-- findings for the latest round — the same round sanitizeEngagementForInterviewee
-- withholds, for the same reason: a function-level finding like "nobody owns
-- governance and the board has not been told" identifies its author inside a
-- five-person client even with the name stripped.
--
-- From v5.32.65 the drafter writes a neutral, dimension-scoped probe into `text`
-- and keeps the colleagues' sentences in a consultant-only `evidence` array,
-- which the interviewee bootstrap projects away. This migration applies the same
-- shape to agendas already stored.
--
-- It rewrites APPROVED agendas as well as drafts. Approval was a single click on
-- a default nobody chose, so an approved row is not evidence that a consultant
-- decided to disclose that sentence — it is evidence that they accepted the
-- draft. A consultant who does want to say something specific can still write it
-- into `text` afterwards, and that is then a real decision.
--
-- Idempotent: an item that already has `evidence` is left alone, so re-running
-- this cannot bury a consultant's own wording under a second rewrite.
-- =============================================================================

UPDATE interviews SET agenda = (
  SELECT jsonb_agg(
    CASE
      WHEN item ? 'evidence' THEN item
      ELSE jsonb_build_object(
        'dimension', item -> 'dimension',
        'text', to_jsonb(
          'Revisit ' ||
          CASE item ->> 'dimension'
            WHEN 'D1' THEN 'Data & Data Management'
            WHEN 'D2' THEN 'Technology & Infrastructure'
            WHEN 'D3' THEN 'AI Strategy & Vision'
            WHEN 'D4' THEN 'People & Skills'
            WHEN 'D5' THEN 'Process & Operations'
            WHEN 'D6' THEN 'Governance & Risk'
            WHEN 'D7' THEN 'Culture & Change Readiness'
            ELSE coalesce(item ->> 'dimension', 'this area')
          END ||
          ' — we would like your current view on how this is working in practice, and what has changed since we last spoke.'
        ),
        'evidence', jsonb_build_array(item -> 'text')
      )
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(agenda) WITH ORDINALITY AS t(item, ord)
)
WHERE kind = 'follow_up'
  AND agenda IS NOT NULL
  AND jsonb_typeof(agenda) = 'array'
  AND jsonb_array_length(agenda) > 0
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(agenda) AS e(item)
     WHERE NOT (item ? 'evidence')
  );
