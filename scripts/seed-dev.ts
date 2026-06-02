/**
 * Desktop dev seed (T009): `pnpm seed`.
 *
 * Resets the dev SQLite database (the gitignored package-local file under
 * `packages/db/.dev/dev.sqlite`, NOT the production app data directory) and
 * rebuilds a realistic demo collection THROUGH the `@interleave/local-db`
 * repositories — so the seed exercises the same transactions + `operation_log`
 * appends the app uses, never raw inserts. The collection itself is the shared
 * `seedDemoCollection` factory from `@interleave/testing`, the same one the
 * Vitest fixtures and the Playwright E2E reuse, so dev and test data cannot drift.
 *
 * Lives at the repo root (not inside a package) on purpose: it composes
 * `@interleave/db` + `@interleave/local-db` + `@interleave/testing`, and a
 * package-level script would create a workspace dependency cycle. The root is the
 * workspace, not a member, so it can depend on all three.
 *
 * It is verbose by design: it prints the lineage chain it created and the
 * operation-log count so a human (or the reviewer) can eyeball that the seed
 * populated the DB correctly.
 */

import fs from "node:fs";
import path from "node:path";
import { DEV_DB_PATH, migrateDatabase, openDatabase } from "@interleave/db";
import { createRepositories, OperationLogRepository } from "@interleave/local-db";
import { seedDemoCollection } from "@interleave/testing";

function resetDevDatabase(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${DEV_DB_PATH}${suffix}`, { force: true });
  }
  fs.mkdirSync(path.dirname(DEV_DB_PATH), { recursive: true });
}

function main(): void {
  console.log(`[seed] resetting dev database at ${DEV_DB_PATH}`);
  resetDevDatabase();

  const { db, sqlite } = openDatabase(DEV_DB_PATH);
  try {
    migrateDatabase(db);
    console.log("[seed] migrations applied");

    const repos = createRepositories(db);
    const collection = seedDemoCollection(repos, db);
    const ops = new OperationLogRepository(db);

    // Echo the lineage chain so it is obvious the seed wired it correctly.
    const sourceId = collection.source.element.id;
    const extractId = collection.extract.element.id;
    const subExtractId = collection.subExtract.element.id;
    const qaCardId = collection.qaCard.element.id;
    const locationId = collection.qaCard.card.sourceLocationId;

    // Read the extract's live stage (it is advanced raw → clean → atomic after creation).
    const liveExtractStage = repos.elements.findById(extractId)?.stage;

    console.log("[seed] created demo collection:");
    console.log(`  source        ${sourceId}  "${collection.source.element.title}"`);
    console.log(`   └─ extract    ${extractId}  (stage ${liveExtractStage})`);
    console.log(`       └─ sub    ${subExtractId}`);
    console.log(`   ├─ Q&A card   ${qaCardId}  → source_location ${locationId}`);
    console.log(`   └─ cloze card ${collection.clozeCard.element.id}`);
    console.log(`  inbox source  ${collection.inboxSource.element.id}`);
    console.log(
      `  image extract ${collection.occlusion.imageExtract.element.id}  → ${collection.occlusion.cards.length} image_occlusion sibling cards`,
    );
    console.log(
      `  concepts      ${collection.concepts.parentConceptId} → ${collection.concepts.childConceptId}`,
    );

    const reviewLogs = repos.review.listReviewLogs(qaCardId);
    const assets = repos.assets.listForElement(sourceId);
    console.log(
      `[seed] review_logs=${reviewLogs.length}  assets=${assets.length}  operation_log=${ops.count()}`,
    );
    console.log("[seed] done — dev database populated.");
  } finally {
    sqlite.close();
  }
}

main();
