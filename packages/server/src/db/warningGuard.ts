/*
 * Muss VOR `node:sqlite` importiert werden (Modul-Evaluationsreihenfolge).
 * Dämpft ausschließlich die Experimental-Warnung von node:sqlite (Risiko R1 / PLAN A2),
 * damit Betriebs- und Testlogs lesbar bleiben. Kein anderes Warning wird gedämpft.
 */
const originalEmit = process.emit;
process.emit = function patchedEmit(name: unknown, ...args: unknown[]): boolean {
  if (
    name === 'warning' &&
    args[0] instanceof Error &&
    (args[0] as Error).name === 'ExperimentalWarning' &&
    String((args[0] as Error).message).includes('SQLite')
  ) {
    return false;
  }
  return (originalEmit as (...a: unknown[]) => boolean).call(process, name, ...args);
} as typeof process.emit;

export {};
