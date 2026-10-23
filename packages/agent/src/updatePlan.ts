/**
 * Entscheidung, was ein Agent-Update tun muss. Rein funktional (testbar).
 *
 * - `before`/`after`: Commit vor/nach `git pull --ff-only`
 * - `runningHead`: Commit, mit dem der laufende Agent gestartet wurde (null = unbekannt)
 *
 * Auf dem Server-Rechner hat das Server-Update den Code oft schon geholt und gebaut (before === after);
 * der laufende Agent kennt ihn aber noch nicht → nur neu bauen (No-Op, wenn aktuell) und neu starten.
 */
export interface UpdatePlan {
  install: boolean;
  build: boolean;
  restart: boolean;
}

export function planUpdate(before: string, after: string, runningHead: string | null): UpdatePlan {
  const pulled = before !== after;
  const stale = runningHead !== null && runningHead !== after;
  return {
    install: pulled,
    build: pulled || stale,
    restart: pulled || stale,
  };
}
