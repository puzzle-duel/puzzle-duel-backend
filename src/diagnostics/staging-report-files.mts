/** Private, bounded staging-only diagnostic report persistence.
 * Store only events previously validated by DiagnosticReportStore.
 * Never return report data via HTTP or public GitHub logs.
 */
import { constants } from 'node:fs';
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync,
  readdirSync, unlinkSync, writeSync, fsyncSync,
} from 'node:fs';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const STAGING_DIAGNOSTIC_REPORT_DIR =
  '/home/pzd-staging/pzd-staging/diagnostic-reports';
export const REPORT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_FILES = 100;
const MAX_FILE_BYTES = 20 * 1024;

export class StagingDiagnosticReportFiles {
  private readonly directory: string;
  private readonly now: () => number;
  constructor(
    directory = STAGING_DIAGNOSTIC_REPORT_DIR,
    now: () => number = Date.now,
  ) {
    this.directory = directory;
    this.now = now;
  }

  save(reportId: string, events: readonly unknown[]): void {
    if (!UUID.test(reportId) || !Array.isArray(events) || events.length > 64) {
      throw new Error('INVALID_DIAGNOSTIC_REPORT');
    }
    const directory = this.directory;
    if (!existsSync(directory)) mkdirSync(directory, { recursive: false, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        info.uid !== process.getuid?.()) {
      throw new Error('DIAGNOSTIC_DIRECTORY_UNSAFE');
    }
    this.prune();
    const now = this.now();
    const data = JSON.stringify({
      version: 1, expiresAt: now + REPORT_RETENTION_MS, events,
    });
    if (Buffer.byteLength(data) > MAX_FILE_BYTES) {
      throw new Error('DIAGNOSTIC_REPORT_TOO_LARGE');
    }
    // Exclusive create with NOFOLLOW; reportId is generated UUID, not caller path.
    const path = join(directory, reportId + '.json');
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const buffer = Buffer.from(data);
      let offset = 0;
      while (offset < buffer.length) {
        const wrote = writeSync(fd, buffer, offset, buffer.length - offset);
        if (wrote <= 0) throw new Error('DIAGNOSTIC_WRITE_FAILED');
        offset += wrote;
      }
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      unlinkSync(path);
      throw error;
    }
    closeSync(fd);
  }

  prune(): void {
    const candidates: { path: string; mtime: number }[] = [];
    for (const name of readdirSync(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name) || !UUID.test(name.slice(0, -5))) continue;
      const path = join(this.directory, name);
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (info.mtimeMs < this.now() - REPORT_RETENTION_MS) {
        unlinkSync(path);
        continue;
      }
      candidates.push({ path, mtime: info.mtimeMs });
    }
    // Max 100 files; reserve one slot for incoming report.
    candidates.sort((a, b) => a.mtime - b.mtime);
    for (const item of candidates.slice(0, Math.max(0, candidates.length - (MAX_FILES - 1)))) {
      unlinkSync(item.path);
    }
  }
}
