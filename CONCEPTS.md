# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Knowledge Processing

### Source

An imported or manually created body of material that the user may read, triage, extract from, and schedule for later processing.

### Inbox source

A source that has been captured but not yet accepted into the user's active knowledge-processing rotation.

### Source provenance

The origin and reliability context attached to a source, including where it came from and how the app should describe that origin to the user.

### Read now

The inbox action that accepts a source into active processing and immediately opens the local reader for that source.

### Source reader

The local reading surface for processing a source inside the app, distinct from opening the source's external canonical URL.

## Local Durability

### Local backup

A restore-ready copy of the user's local application data, covering both the canonical local database and the filesystem-owned asset vault.

### Automatic backup

A local backup created quietly by the desktop app lifecycle rather than by a direct user command.

Automatic backups are owned by automatic retention and may be thinned or deleted by that policy. They are distinct from manual backups, even when both use the same restore-ready backup format.

### Manual backup

A local backup explicitly created by the user.

Manual backups may satisfy an automatic due check because they prove the data was recently backed up, but automatic retention must not prune them.

### Asset vault

The filesystem-owned store for large user data such as source files, media, and exports, with the local database retaining metadata and references.

### Restore-ready backup

A backup artifact whose structure and manifest are sufficient for a restore flow to verify and rebuild the local store.

### Automatic retention

The policy that thins automatic backups over time and enforces a storage cap while preserving manual backups.
