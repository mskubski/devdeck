import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Router } from 'express';
import { AppError, isReplicableBundleName } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { asyncHandler, param } from '../http.js';
import {
  STAGING_MAX_BYTES,
  completeStaging,
  getReplicaById,
  stagingUsage,
  transferFilePath,
  transferFiles,
  type ReplicaRow,
} from '../services/backupReplicas.js';

/**
 * Dateiübertragung zwischen Agenten und Server für die Replikation (Agenten verbinden sich nur ausgehend):
 *  – Quell-Agent eines Projekt-Jobs lädt die Dateien eines Backups in den Zwischenspeicher des Servers (PUT, mit Prüfsumme),
 *  – Ziel-Agent holt Dateiliste und Dateien (GET) und prüft jede Datei selbst gegen die Prüfsumme.
 * Zugriff nur für die jeweils beteiligte Maschine und nur, solange der passende Schritt der Replikation läuft.
 */
export function mountReplicaTransferRoutes(router: Router, ctx: AppContext): void {
  const replicaFor = (req: Parameters<Parameters<typeof router.get>[1]>[0], role: 'source' | 'target'): { row: ReplicaRow; bundle: string } => {
    const row = getReplicaById(ctx, param(req, 'replicaId')!);
    const bundle = param(req, 'bundle')!;
    if (!row || !isReplicableBundleName(bundle)) throw new AppError('NOT_FOUND', 'Replik oder Backup nicht gefunden');
    const machine = req.machine!;
    if (row.cur_bundle !== bundle) throw new AppError('CONFLICT', 'Für dieses Backup läuft gerade keine Übertragung');
    if (role === 'target') {
      if (row.machine_id !== machine.id || row.state !== 'importing') throw new AppError('FORBIDDEN', 'Keine Berechtigung für diese Übertragung');
    } else {
      const job = row.job_id ? ctx.db.get<{ machine_id: string }>('SELECT machine_id FROM backup_jobs WHERE id = ?', row.job_id) : undefined;
      if (!job || job.machine_id !== machine.id || row.state !== 'exporting') throw new AppError('FORBIDDEN', 'Keine Berechtigung für diese Übertragung');
    }
    return { row, bundle };
  };

  // Quelle → Server: eine Datei in den Zwischenspeicher (Rohdaten im Body, Prüfsumme im Header)
  router.put(
    '/replicas/:replicaId/staging/:bundle/file',
    asyncHandler(async (req, res) => {
      let abort: AppError | null = null;
      try {
        const { row, bundle } = replicaFor(req, 'source');
        const size = Number(req.headers['content-length']);
        const sha = String(req.headers['x-sha256'] ?? '').toLowerCase();
        if (!Number.isFinite(size) || size < 0) throw new AppError('VALIDATION', 'Content-Length fehlt');
        if (!/^[0-9a-f]{64}$/.test(sha)) throw new AppError('VALIDATION', 'X-Sha256 fehlt oder ist ungültig');
        if (stagingUsage(ctx) + size > STAGING_MAX_BYTES) throw new AppError('CONFLICT', 'Der Zwischenspeicher auf dem Server ist voll');
        const dest = transferFilePath(ctx, row, bundle, req.query.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = `${dest}.part`;
        const hash = createHash('sha256');
        let received = 0;
        try {
          await pipeline(
            req,
            new Transform({
              transform(chunk: Buffer, _enc, cb) {
                received += chunk.length;
                hash.update(chunk);
                cb(null, chunk);
              },
            }),
            fs.createWriteStream(tmp, { mode: 0o600 }),
          );
          if (received !== size || hash.digest('hex') !== sha) throw new AppError('VALIDATION', 'Datei beschädigt übertragen (Größe oder Prüfsumme stimmt nicht)');
          fs.renameSync(tmp, dest);
        } catch (err) {
          fs.rmSync(tmp, { force: true });
          throw err;
        }
        res.status(204).end();
        return;
      } catch (err) {
        abort = err instanceof AppError ? err : new AppError('INTERNAL', 'Übertragung fehlgeschlagen');
      }
      req.resume(); // den Rest des Bodys verwerfen, damit die Verbindung sauber antwortet
      throw abort;
    }),
  );

  // Quelle → Server: alle Dateien übergeben, Liste bestätigen
  router.post(
    '/replicas/:replicaId/staging/:bundle/complete',
    asyncHandler(async (req, res) => {
      const { row, bundle } = replicaFor(req, 'source');
      res.json({ data: { files: completeStaging(ctx, row, bundle, req.body) } });
    }),
  );

  // Server → Ziel: Dateiliste mit Prüfsummen
  router.get(
    '/replicas/:replicaId/bundles/:bundle/files',
    asyncHandler(async (req, res) => {
      const { row, bundle } = replicaFor(req, 'target');
      res.json({ data: { files: transferFiles(ctx, row, bundle) } });
    }),
  );

  // Server → Ziel: eine Datei streamen
  router.get(
    '/replicas/:replicaId/bundles/:bundle/file',
    asyncHandler(async (req, res) => {
      const { row, bundle } = replicaFor(req, 'target');
      const file = transferFilePath(ctx, row, bundle, req.query.path);
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        throw new AppError('NOT_FOUND', 'Datei nicht gefunden');
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(size));
      await pipeline(fs.createReadStream(file), res);
    }),
  );
}
