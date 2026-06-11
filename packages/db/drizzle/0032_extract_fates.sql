-- T104: honorable terminal fates for extracts that exit without a card.
--
-- The CHECK is type-coupled so only extract elements may carry a fate. Existing
-- rows migrate as NULL, including legacy status=done extracts whose intent is
-- unknowable.
ALTER TABLE `elements` ADD `extract_fate` text CHECK (`extract_fate` IS NULL OR (`type` = 'extract' AND `extract_fate` IN ('reference', 'synthesized', 'done_without_card')));
