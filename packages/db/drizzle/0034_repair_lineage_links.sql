-- Repair: backfill `elements.parent_id`/`source_id` wiped by the original 0030.
--
-- 0030 rebuilt `elements` on a connection with `foreign_keys = ON`: `DROP TABLE
-- elements` ran an implicit DELETE FROM whose `ON DELETE SET NULL` actions fired
-- into the freshly copied `__new_elements` rows, nulling every lineage link
-- table-wide. Every side table was restored from its TEMP backup; the new
-- elements table itself was the one casualty. The original links survive
-- verbatim in the append-only operation log — every element's `create_element`
-- payload carries the `parentId`/`sourceId` it was born with — so this
-- migration backfills from there.
--
-- Guards (all load-bearing):
--   - fill ONLY rows whose link is still NULL (vaults that never ran the broken
--     0030, and rows the user genuinely created without a parent, are untouched);
--   - fill ONLY when the referenced element still exists, so the runner's
--     post-migration `foreign_key_check` stays clean and hard-purged ancestors
--     stay detached;
--   - soft-deleted elements are repaired too — trash restore needs lineage.
-- Idempotent by construction; a no-op on fresh databases.
CREATE TEMP TABLE `__lineage_backfill` AS
SELECT
	o.element_id AS id,
	json_extract(o.payload, '$.element.parentId') AS parent_id,
	json_extract(o.payload, '$.element.sourceId') AS source_id,
	MIN(o.created_at) AS first_created_at
FROM `operation_log` o
WHERE o.op_type = 'create_element' AND o.element_id IS NOT NULL
GROUP BY o.element_id;--> statement-breakpoint
UPDATE `elements`
SET parent_id = (SELECT b.parent_id FROM `__lineage_backfill` b WHERE b.id = elements.id)
WHERE parent_id IS NULL
	AND EXISTS (
		SELECT 1 FROM `__lineage_backfill` b
		JOIN `elements` p ON p.id = b.parent_id
		WHERE b.id = elements.id
	);--> statement-breakpoint
UPDATE `elements`
SET source_id = (SELECT b.source_id FROM `__lineage_backfill` b WHERE b.id = elements.id)
WHERE source_id IS NULL
	AND EXISTS (
		SELECT 1 FROM `__lineage_backfill` b
		JOIN `elements` p ON p.id = b.source_id
		WHERE b.id = elements.id
	);--> statement-breakpoint
DROP TABLE `__lineage_backfill`;
