// DevDeck Web UI – Rollen-Rang (muss zum Backend passen, @devdeck/shared roles.ts).
const RANK = { viewer: 0, developer: 1, maintainer: 2, owner: 3 };

export function roleAtLeast(role, min) {
  return (RANK[role] ?? -1) >= (RANK[min] ?? 0);
}
