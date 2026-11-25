import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { annotation, identifier, manifest, requireValue, targetMarks, textField } from '../core/review.mjs';

const now = () => new Date().toISOString();
const decode = JSON.parse;
const encode = JSON.stringify;

function saveCapture(store, value, fallback = null) {
  if (!value) return fallback;
  requireValue(typeof value === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value), 'Invalid PNG capture');
  const bytes = Buffer.from(value.slice(22), 'base64');
  requireValue(bytes.length <= 8_000_000 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', 'Invalid PNG capture');
  return store.addAsset(bytes, 'image/png');
}

export class Store {
  constructor(root) {
    this.assets = join(root, 'assets');
    mkdirSync(this.assets, { recursive: true });
    this.db = new DatabaseSync(join(root, 'reviews.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS assets (hash TEXT PRIMARY KEY, type TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (
        project TEXT NOT NULL REFERENCES projects(id), number INTEGER NOT NULL, model TEXT NOT NULL,
        note TEXT NOT NULL, created TEXT NOT NULL, request TEXT NOT NULL, outcomes TEXT NOT NULL,
        PRIMARY KEY(project, number), UNIQUE(project, request)
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL,
        capture TEXT REFERENCES assets(hash), batch TEXT, created TEXT NOT NULL,
        FOREIGN KEY(project, version) REFERENCES versions(project, number)
      );
      CREATE TABLE IF NOT EXISTS batches (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project TEXT NOT NULL,
        version INTEGER NOT NULL, created TEXT NOT NULL,
        FOREIGN KEY(project, version) REFERENCES versions(project, number)
      );
    `);
    this.transaction(() => {
      const legacy = this.db.prepare(`
        SELECT 1 FROM pragma_index_list('batches') AS indexes
        JOIN pragma_index_info(indexes.name) AS columns
        WHERE indexes."unique" = 1 AND columns.name = 'version'
      `).get();
      if (legacy) this.db.exec(`
        CREATE TABLE review_batches (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project TEXT NOT NULL,
          version INTEGER NOT NULL, created TEXT NOT NULL,
          FOREIGN KEY(project, version) REFERENCES versions(project, number)
        );
        INSERT INTO review_batches (seq, id, project, version, created)
          SELECT seq, id, project, version, created FROM batches;
        DROP TABLE batches;
        ALTER TABLE review_batches RENAME TO batches;
      `);
      this.db.exec('CREATE INDEX IF NOT EXISTS batches_project_seq ON batches (project, seq)');
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('batches') WHERE name = 'replaces'").get()) {
        this.db.exec('ALTER TABLE batches ADD COLUMN replaces TEXT REFERENCES batches(id)');
      }
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('comments') WHERE name = 'revision'").get()) {
        this.db.exec('ALTER TABLE comments ADD COLUMN revision TEXT REFERENCES batches(id)');
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS batches_replaces ON batches (replaces) WHERE replaces IS NOT NULL;
        CREATE TABLE IF NOT EXISTS amendments (
          project TEXT NOT NULL, version INTEGER NOT NULL, batch TEXT NOT NULL UNIQUE REFERENCES batches(id),
          PRIMARY KEY(project, version), FOREIGN KEY(project, version) REFERENCES versions(project, number)
        );
      `);
      for (const [table, column, definition] of [
        ['batches', 'additional_to', 'TEXT REFERENCES batches(id)'],
        ['batches', 'delivered_at', 'TEXT'],
        ['batches', 'working_on', 'INTEGER'],
        ['amendments', 'additional', 'INTEGER NOT NULL DEFAULT 0']
      ]) {
        if (!this.db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
    });
  }

  close() { this.db.close(); }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  addAsset(bytes, type) {
    requireValue(bytes.length > 0, 'Empty file');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const file = join(this.assets, hash);
    if (!existsSync(file)) {
      const temporary = join(this.assets, randomUUID());
      writeFileSync(temporary, bytes, { flag: 'wx' });
      try { renameSync(temporary, file); }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
    }
    this.db.prepare('INSERT OR IGNORE INTO assets VALUES (?, ?)').run(hash, type);
    return hash;
  }

  asset(hash) {
    requireValue(/^[a-f0-9]{64}$/.test(hash), 'Invalid file', 404);
    const asset = this.db.prepare('SELECT type FROM assets WHERE hash = ?').get(hash);
    requireValue(asset, 'File not found', 404);
    return { bytes: readFileSync(join(this.assets, hash)), type: asset.type };
  }

  list() {
    return this.db.prepare('SELECT projects.*, MAX(versions.number) AS latest FROM projects JOIN versions ON project = id GROUP BY id ORDER BY projects.created DESC').all();
  }

  review(id) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    requireValue(project, 'Project not found', 404);
    const versions = this.db.prepare('SELECT * FROM versions WHERE project = ? ORDER BY number').all(id).map(row => ({
      number: row.number, model: decode(row.model), note: row.note, outcomes: decode(row.outcomes), created: row.created
    }));
    return { ...project, versions, comments: this.comments(id), batches: this.db.prepare('SELECT id, version, created, replaces, additional_to AS additionalTo, delivered_at AS deliveredAt, working_on AS workingOn FROM batches WHERE project = ? ORDER BY seq').all(id),
      amendments: this.db.prepare('SELECT version, batch, additional FROM amendments WHERE project = ?').all(id) };
  }

  comments(id, batch) {
    const rows = batch
      ? this.db.prepare('SELECT * FROM comments WHERE project = ? AND batch = ? ORDER BY created, id').all(id, batch)
      : this.db.prepare('SELECT * FROM comments WHERE project = ? ORDER BY created, id').all(id);
    return rows.map(row => ({ id: row.id, version: row.version, batch: row.batch, created: row.created, capture: row.capture,
      ...(row.revision ? { revision: row.revision } : {}), ...decode(row.payload) }));
  }

  publish({ projectId, title, baseVersion = 0, model, note = '', requestId, outcomes = [] }) {
    const id = identifier(projectId, 'Project');
    const request = identifier(requestId, 'Publication ID');
    const normalized = manifest(model);
    requireValue(typeof note === 'string' && note.length <= 4000, 'Invalid change note');
    return this.transaction(() => {
      const hit = this.db.prepare('SELECT number, model, note, outcomes FROM versions WHERE project = ? AND request = ?').get(id, request);
      if (hit) {
        requireValue(hit.model === encode(normalized) && hit.note === note && hit.outcomes === encode(outcomes) && hit.number === baseVersion + 1, 'The publication ID was already used with different content', 409);
        return { id, version: hit.number, repeated: true };
      }
      const latest = this.db.prepare('SELECT MAX(number) AS n FROM versions WHERE project = ?').get(id).n ?? 0;
      requireValue(Number.isSafeInteger(baseVersion) && baseVersion === latest, `The current version is v${latest}`, 409);
      for (const part of normalized.parts) {
        const asset = this.db.prepare('SELECT type FROM assets WHERE hash = ?').get(part.asset);
        requireValue(asset?.type === 'application/octet-stream', `Missing model for ${part.id}`);
      }
      requireValue(Array.isArray(outcomes) && outcomes.length <= 250, 'Invalid comment outcomes');
      const handled = new Set();
      for (const outcome of outcomes) {
        const comment = this.db.prepare('SELECT id, batch FROM comments WHERE project = ? AND id = ?').get(id, outcome.commentId);
        requireValue(comment?.batch && !handled.has(comment.id) && ['applied', 'pending', 'needs-clarification'].includes(outcome.status), 'Invalid comment outcome');
        requireValue(!this.db.prepare('SELECT 1 FROM batches WHERE replaces = ?').get(comment.batch), 'Feedback was corrected. Read the replacement before publishing this outcome.', 409);
        handled.add(comment.id);
        if (outcome.note) textField(outcome.note, 'Outcome', 2000);
      }
      if (!latest) this.db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(id, textField(title, 'Title', 130), now());
      const version = latest + 1;
      this.db.prepare('INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, version, encode(normalized), note, now(), request, encode(outcomes));
      return { id, version, repeated: false };
    });
  }

  saveComment(project, version, input, commentId) {
    return this.transaction(() => this.#writeComment(project, version, input, commentId));
  }

  #writeComment(project, version, input, commentId) {
    const row = this.db.prepare('SELECT model FROM versions WHERE project = ? AND number = ?').get(project, version);
    requireValue(row, 'Version not found', 404);
    const payload = annotation(input, decode(row.model));
    const id = commentId ?? randomUUID();
    const previous = commentId && this.db.prepare('SELECT payload, capture, batch, revision FROM comments WHERE project = ? AND version = ? AND id = ?').get(project, version, commentId);
    if (commentId) requireValue(previous, 'Comment not found', 404);
    requireValue(!previous?.batch, 'This comment has already been submitted', 409);
    const revision = input.revision ?? null;
    if (previous) requireValue(previous.revision === revision, 'This draft belongs to another review', 409);
    this.#requireOpen(project, version, revision);
    const capture = saveCapture(this, input.capture, previous?.capture);
    const previousDetail = previous && decode(previous.payload).detailCapture;
    const detailCapture = saveCapture(this, input.detailCapture, input.capture ? null : previousDetail);
    if (detailCapture) payload.detailCapture = detailCapture;
    if (previous) this.db.prepare('UPDATE comments SET payload = ?, capture = ? WHERE id = ?').run(encode(payload), capture, id);
    else this.db.prepare('INSERT INTO comments (id, project, version, payload, capture, created, revision) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, project, version, encode(payload), capture, now(), revision);
    return { id, version, capture, ...payload };
  }

  deleteComment(project, id) {
    const result = this.db.prepare('DELETE FROM comments WHERE project = ? AND id = ? AND batch IS NULL').run(project, id);
    requireValue(result.changes, 'The draft is no longer available', 409);
  }

  #lastBatch(project, version) {
    return this.db.prepare('SELECT id FROM batches WHERE project = ? AND version = ? ORDER BY seq DESC LIMIT 1').get(project, version)?.id;
  }

  #requireOpen(project, version, revision) {
    if (revision === null) {
      requireValue(!this.#lastBatch(project, version), 'This review is closed. Reopen it or wait for the next version.', 409);
      return;
    }
    const draft = this.db.prepare('SELECT additional FROM amendments WHERE project = ? AND version = ? AND batch = ?').get(project, version, revision);
    requireValue(draft, 'This review is no longer open for editing', 409);
    return draft;
  }

  reopen(project, batch, additional = false) {
    return this.transaction(() => {
      const { version } = this.db.prepare('SELECT version FROM batches WHERE project = ? AND id = ?').get(project, batch) ?? {};
      requireValue(version !== undefined, 'Review not found', 404);
      requireValue(!this.db.prepare('SELECT 1 FROM batches WHERE replaces = ?').get(batch), 'This submission has already been replaced', 409);
      const open = this.db.prepare('SELECT batch, additional FROM amendments WHERE project = ? AND version = ?').get(project, version);
      if (open?.batch === batch && Boolean(open.additional) === additional) return { version, batch };
      requireValue(!open, 'A revision of this submission is already open', 409);
      requireValue(batch === this.#lastBatch(project, version), 'Reopen the latest submission for this version', 409);
      this.db.prepare('INSERT INTO amendments (project, version, batch, additional) VALUES (?, ?, ?, ?)').run(project, version, batch, Number(additional));
      if (additional) return { version, batch };
      const insert = this.db.prepare('INSERT INTO comments (id, project, version, payload, capture, created, revision) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const comments = this.db.prepare('SELECT payload, capture, created FROM comments WHERE batch = ? ORDER BY created, id').all(batch);
      for (const comment of comments) insert.run(randomUUID(), project, version, comment.payload, comment.capture, comment.created, batch);
      return { version, batch };
    });
  }

  discardAmendment(project, batch) {
    return this.transaction(() => {
      const removed = this.db.prepare('DELETE FROM amendments WHERE project = ? AND batch = ?').run(project, batch);
      requireValue(removed.changes, 'This revision is no longer open', 409);
      this.db.prepare('DELETE FROM comments WHERE project = ? AND revision = ? AND batch IS NULL').run(project, batch);
      return { removed: true };
    });
  }

  submit(project, version, comment, requestId, revision = null, confirmed = false) {
    return this.transaction(() => {
      const id = requestId === undefined ? randomUUID() : identifier(requestId, 'Review ID');
      const existing = this.db.prepare('SELECT project, version, replaces, additional_to FROM batches WHERE id = ?').get(id);
      if (existing) {
        requireValue(existing.project === project && existing.version === version && (existing.replaces ?? existing.additional_to) === revision, 'The review ID is already in use', 409);
        return { id, version };
      }
      const draft = this.#requireOpen(project, version, revision === null ? null : identifier(revision, 'Submission ID'));
      const replaces = draft?.additional ? null : revision;
      if (replaces && !confirmed) {
        const received = this.db.prepare('SELECT delivered_at FROM batches WHERE id = ?').get(replaces).delivered_at;
        const newer = this.db.prepare('SELECT 1 FROM versions WHERE project = ? AND number > ? LIMIT 1').get(project, version);
        requireValue(!received && !newer, 'Confirm the correction because the agent received the original or a newer version is available.', 409);
      }
      if (comment !== undefined) {
        requireValue(comment && typeof comment === 'object' && !Array.isArray(comment), 'Invalid comment');
        const commentId = comment.id === undefined ? undefined : identifier(comment.id, 'Comment ID');
        this.#writeComment(project, version, { ...comment, revision }, commentId);
      }
      requireValue(replaces || this.db.prepare('SELECT 1 FROM comments WHERE project = ? AND version = ? AND batch IS NULL AND revision IS ?').get(project, version, revision), 'Add at least one comment before submitting');
      this.db.prepare('INSERT INTO batches (id, project, version, created, replaces, additional_to) VALUES (?, ?, ?, ?, ?, ?)').run(id, project, version, now(), replaces, draft?.additional ? revision : null);
      this.db.prepare('UPDATE comments SET batch = ? WHERE project = ? AND version = ? AND batch IS NULL AND revision IS ?').run(id, project, version, revision);
      if (revision) this.db.prepare('DELETE FROM amendments WHERE project = ? AND version = ?').run(project, version);
      return { id, version };
    });
  }

  markDelivered(project, batches) {
    return this.transaction(() => {
      const mark = this.db.prepare('UPDATE batches SET delivered_at = ? WHERE project = ? AND id = ? AND delivered_at IS NULL');
      const at = now();
      return batches.reduce((count, id) => count + mark.run(at, project, id).changes, 0);
    });
  }

  startRevision(project, batch, baseVersion) {
    return this.transaction(() => {
      const latest = this.db.prepare('SELECT MAX(number) AS n FROM versions WHERE project = ?').get(project).n;
      requireValue(latest !== null && baseVersion === latest, 'Open the latest preview before starting a revision', 409);
      const workingOn = latest + 1;
      const result = this.db.prepare(`UPDATE batches AS b SET working_on = ? WHERE project = ? AND id = ?
        AND delivered_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM batches WHERE replaces = b.id)`).run(workingOn, project, batch);
      requireValue(result.changes, 'Read the current feedback before starting a revision', 409);
      return { batchId: batch, workingOn };
    });
  }

  feedback(project, { after, batch, current = false } = {}) {
    requireValue(this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(project), 'Project not found', 404);
    const cursor = after ? this.db.prepare('SELECT seq FROM batches WHERE project = ? AND id = ?').get(project, after) : null;
    requireValue(!after || cursor, 'Cursor not found', 404);
    const fields = 'b.id, b.version, b.created, b.replaces, b.additional_to AS additionalTo';
    const rows = batch ? (current
      ? this.db.prepare(`WITH RECURSIVE chain(id) AS (SELECT ? UNION ALL SELECT batches.id FROM batches, chain WHERE batches.replaces = chain.id)
          SELECT ${fields} FROM batches b JOIN chain ON chain.id = b.id WHERE b.project = ? ORDER BY b.seq DESC LIMIT 1`).all(batch, project)
      : this.db.prepare(`SELECT ${fields} FROM batches b WHERE b.project = ? AND b.id = ?`).all(project, batch))
      : this.db.prepare(`SELECT ${fields} FROM batches b WHERE b.project = ? AND b.seq > ?
          AND (? = 0 OR NOT EXISTS (SELECT 1 FROM batches WHERE replaces = b.id)) ORDER BY b.seq LIMIT 30`).all(project, cursor?.seq ?? 0, Number(current));
    requireValue(!batch || rows.length, 'Review not found', 404);
    return rows.map(row => {
      const version = this.db.prepare('SELECT model FROM versions WHERE project = ? AND number = ?').get(project, row.version);
      const parts = decode(version.model).parts;
      const sourceFor = id => parts.find(part => part.id === id)?.source;
      return { ...row, comments: this.comments(project, row.id).map(comment => {
        const { target } = comment;
        const marks = targetMarks(target);
        const ids = new Set(marks.flatMap(mark => mark.parts ? mark.parts.map(part => part.partId) : mark.partId ? [mark.partId] : []));
        let measurement = comment.measurement;
        if (measurement?.endpoints) {
          const attachSource = hit => {
            const part = parts.find(part => part.id === hit.partId);
            return { ...hit, label: part?.label, source: part?.source, transform: part?.transform };
          };
          measurement = { ...measurement, endpoints: { a: attachSource(measurement.endpoints.a), b: attachSource(measurement.endpoints.b) } };
        }
        return { ...comment, measurement, source: sourceFor(target.partId),
          sources: target.parts || target.kind === 'group' ? [...ids].map(partId => ({ partId, source: sourceFor(partId) })) : undefined };
      }) };
    });
  }
}
