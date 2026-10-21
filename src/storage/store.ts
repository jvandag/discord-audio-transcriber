import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ReportInput, ReportJob } from '../reports/types.js';
import type {
  AudioChunk,
  Job,
  JobCounts,
  Participant,
  Segment,
  Session,
  Settings,
} from '../shared/types.js';

/** SQLite is accessed only on the main thread; transactions make job completion atomic. */
export class Store {
  private db: DatabaseSync;
  constructor(
    path: string,
    private defaults: Settings,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS settings(guild_id TEXT PRIMARY KEY, model TEXT NOT NULL, language TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases(guild_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, editor_id TEXT NOT NULL, PRIMARY KEY(guild_id,user_id));
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS participants(session_id TEXT NOT NULL REFERENCES sessions(id), user_id TEXT NOT NULL, display_name TEXT NOT NULL, transcript_name TEXT, PRIMARY KEY(session_id,user_id));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), user_id TEXT NOT NULL, offset_ms REAL NOT NULL, duration_ms REAL NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state,session_id);
      CREATE TABLE IF NOT EXISTS segments(job_id TEXT NOT NULL REFERENCES jobs(id), ordinal INTEGER NOT NULL, user_id TEXT NOT NULL, start_ms REAL NOT NULL, end_ms REAL NOT NULL, text TEXT NOT NULL, PRIMARY KEY(job_id,ordinal));
      INSERT OR IGNORE INTO migrations VALUES(1);`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS report_inputs(session_id TEXT PRIMARY KEY REFERENCES sessions(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports(session_id TEXT PRIMARY KEY REFERENCES sessions(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transcript_messages(session_id TEXT NOT NULL REFERENCES sessions(id), part INTEGER NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(session_id,part));
      INSERT OR IGNORE INTO migrations VALUES(2);`);
  }
  close() {
    this.db.close();
  }
  reportInput(sessionId: string): ReportInput | undefined {
    const row = this.db.prepare('SELECT data FROM report_inputs WHERE session_id=?').get(sessionId);
    return row ? (JSON.parse(String(row.data)) as ReportInput) : undefined;
  }
  saveReportInput(input: ReportInput) {
    this.db
      .prepare('INSERT OR IGNORE INTO report_inputs VALUES(?,?)')
      .run(input.sessionId, JSON.stringify(input));
  }
  report(sessionId: string): ReportJob | undefined {
    const row = this.db.prepare('SELECT data FROM reports WHERE session_id=?').get(sessionId);
    return row ? (JSON.parse(String(row.data)) as ReportJob) : undefined;
  }
  reports(): ReportJob[] {
    return this.db
      .prepare('SELECT data FROM reports ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(String(row.data)) as ReportJob);
  }
  createReport(job: ReportJob): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO reports VALUES(?,?)')
        .run(job.sessionId, JSON.stringify(job)).changes === 1
    );
  }
  saveReport(job: ReportJob) {
    this.db
      .prepare('UPDATE reports SET data=? WHERE session_id=?')
      .run(JSON.stringify(job), job.sessionId);
  }
  transcriptMessage(sessionId: string, part: number): string | undefined {
    const row = this.db
      .prepare('SELECT message_id FROM transcript_messages WHERE session_id=? AND part=?')
      .get(sessionId, part);
    return row ? String(row.message_id) : undefined;
  }
  saveTranscriptMessage(sessionId: string, part: number, messageId: string) {
    this.db
      .prepare(
        'INSERT INTO transcript_messages VALUES(?,?,?) ON CONFLICT(session_id,part) DO UPDATE SET message_id=excluded.message_id',
      )
      .run(sessionId, part, messageId);
  }
  lastTranscriptMessage(sessionId: string): string | undefined {
    const row = this.db
      .prepare(
        'SELECT message_id FROM transcript_messages WHERE session_id=? ORDER BY part DESC LIMIT 1',
      )
      .get(sessionId);
    return row ? String(row.message_id) : undefined;
  }
  settings(guildId: string): Settings {
    const row = this.db
      .prepare('SELECT model,language FROM settings WHERE guild_id=?')
      .get(guildId);
    return row
      ? { model: String(row.model), language: String(row.language) }
      : { ...this.defaults };
  }
  saveSettings(guildId: string, settings: Settings) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET model=excluded.model,language=excluded.language',
      )
      .run(guildId, settings.model, settings.language);
  }
  alias(guildId: string, userId: string): string | undefined {
    const row = this.db
      .prepare('SELECT name FROM aliases WHERE guild_id=? AND user_id=?')
      .get(guildId, userId);
    return row ? String(row.name) : undefined;
  }
  setAlias(guildId: string, userId: string, name: string | null, editorId: string) {
    if (name === null)
      this.db.prepare('DELETE FROM aliases WHERE guild_id=? AND user_id=?').run(guildId, userId);
    else
      this.db
        .prepare(
          'INSERT INTO aliases VALUES(?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET name=excluded.name,editor_id=excluded.editor_id',
        )
        .run(guildId, userId, name, editorId);
  }
  saveSession(session: Session) {
    this.db
      .prepare('INSERT INTO sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(session.id, JSON.stringify(session));
  }
  session(id: string): Session {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id);
    if (!row) throw new Error('Recording session no longer exists.');
    return JSON.parse(String(row.data)) as Session;
  }
  sessions(): Session[] {
    return this.db
      .prepare('SELECT data FROM sessions ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(String(row.data)) as Session);
  }
  participant(sessionId: string, userId: string, displayName: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO participants(session_id,user_id,display_name) VALUES(?,?,?)')
      .run(sessionId, userId, displayName);
  }
  participants(sessionId: string): Participant[] {
    return this.db
      .prepare('SELECT * FROM participants WHERE session_id=? ORDER BY user_id')
      .all(sessionId)
      .map((row) => ({
        userId: String(row.user_id),
        displayName: String(row.display_name),
        transcriptName: row.transcript_name === null ? null : String(row.transcript_name),
      }));
  }
  snapshotNames(session: Session) {
    this.transaction(() => {
      for (const person of this.participants(session.id)) {
        this.db
          .prepare(
            'UPDATE participants SET transcript_name=? WHERE session_id=? AND user_id=? AND transcript_name IS NULL',
          )
          .run(
            this.alias(session.guildId, person.userId) ?? person.displayName,
            session.id,
            person.userId,
          );
      }
    });
  }
  addJob(chunk: AudioChunk) {
    this.db
      .prepare(
        'INSERT INTO jobs(id,session_id,user_id,offset_ms,duration_ms,path,bytes) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        chunk.id,
        chunk.sessionId,
        chunk.userId,
        chunk.offsetMs,
        chunk.durationMs,
        chunk.path,
        chunk.bytes,
      );
  }
  nextJob(): Job | undefined {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE state='pending' ORDER BY rowid LIMIT 1")
      .get();
    if (!row) return;
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      userId: String(row.user_id),
      offsetMs: Number(row.offset_ms),
      durationMs: Number(row.duration_ms),
      path: String(row.path),
      bytes: Number(row.bytes),
      attempts: Number(row.attempts),
    };
  }
  beginJob(id: string) {
    this.db.prepare("UPDATE jobs SET state='processing',attempts=attempts+1 WHERE id=?").run(id);
  }
  finishJob(job: Job, segments: Segment[]) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM segments WHERE job_id=?').run(job.id);
      segments.forEach((segment, index) =>
        this.db
          .prepare('INSERT INTO segments VALUES(?,?,?,?,?,?)')
          .run(job.id, index, segment.userId, segment.startMs, segment.endMs, segment.text),
      );
      this.db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(job.id);
    });
  }
  failJob(job: Job) {
    this.db
      .prepare('UPDATE jobs SET state=? WHERE id=?')
      .run(job.attempts + 1 < 2 ? 'pending' : 'failed', job.id);
  }
  counts(sessionId: string): JobCounts {
    const counts = { pending: 0, done: 0, failed: 0 };
    for (const row of this.db
      .prepare('SELECT state,COUNT(*) AS n FROM jobs WHERE session_id=? GROUP BY state')
      .all(sessionId)) {
      if (row.state === 'done') counts.done = Number(row.n);
      else if (row.state === 'failed') counts.failed = Number(row.n);
      else counts.pending += Number(row.n);
    }
    return counts;
  }
  pendingBytes(): number {
    return Number(
      this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM jobs WHERE state!='done'").get()
        ?.n ?? 0,
    );
  }
  releaseAudioBudget(sessionId: string) {
    this.db.prepare('UPDATE jobs SET bytes=0 WHERE session_id=?').run(sessionId);
  }
  segments(sessionId: string): Segment[] {
    return this.db
      .prepare(
        'SELECT s.* FROM segments s JOIN jobs j ON s.job_id=j.id WHERE j.session_id=? ORDER BY start_ms,end_ms,user_id,job_id,ordinal',
      )
      .all(sessionId)
      .map((row) => ({
        userId: String(row.user_id),
        startMs: Number(row.start_ms),
        endMs: Number(row.end_ms),
        text: String(row.text),
      }));
  }
  recover() {
    this.db.prepare("UPDATE jobs SET state='pending' WHERE state='processing'").run();
    for (const session of this.sessions()) {
      if (session.state === 'recording' || session.state === 'connecting') {
        session.state = 'interrupted';
        session.endedAt = Date.now();
        session.reason = 'Process interrupted; uncaptured audio may be missing.';
        this.snapshotNames(session);
        this.saveSession(session);
      }
    }
  }
  private transaction(action: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
