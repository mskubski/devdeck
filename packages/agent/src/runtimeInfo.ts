/** Commit, aus dem der laufende Agent-Code stammt (beim Start ermittelt); für Update-Entscheidung und Diagnose. */
let runningHead: string | null = null;

export function getRunningHead(): string | null {
  return runningHead;
}

export function setRunningHead(head: string | null): void {
  runningHead = head;
}
