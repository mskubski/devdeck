import { describe, expect, it } from 'vitest';
import { parseTasks, taskKey, wellFormed } from '../src/importParsers.js';

describe('Task-Titel beim Import (Emoji, Vergleichsschlüssel)', () => {
  it('beschädigt Emoji in einfachen Listen nicht (Zeichenklasse ohne u-Flag zerlegte Surrogate)', () => {
    const md = '## Sicherheits-Härtung\n- 🛠️ Termine per Chat löschen/auflisten\n- 🚧 Baustelle: neues Layout\n- ✅ Fertig: Login\n- 📌 Angeheftet\n- ⏳ Warten auf Freigabe\n';
    const t = parseTasks(md);
    expect(t.map((x) => x.title)).toEqual(['🛠️ Termine per Chat löschen/auflisten', 'Baustelle: neues Layout', 'Fertig: Login', '📌 Angeheftet', 'Warten auf Freigabe']);
    expect(t[2]!.done).toBe(true);
    for (const x of t) expect(x.title).toBe(wellFormed(x.title)); // keine alleinstehenden Surrogat-Hälften
  });

  it('Checkbox-Listen behalten Emoji ebenfalls', () => {
    expect(parseTasks('- [ ] 🛠️ Termine löschen (P2)\n')[0]).toMatchObject({ title: '🛠️ Termine löschen', priority: 2 });
  });

  it('taskKey: ein früher beschädigt gespeicherter Titel gilt als derselbe Task', () => {
    const clean = '🛠️ Termine per Chat löschen/auflisten: aktuell darf jeder erlaubte Absender';
    const broken = '�️ Termine per Chat löschen/auflisten: aktuell darf jeder erlaubte Absender'; // so landet \udee0 in der Datenbank
    expect(taskKey(broken)).toBe(taskKey(clean));
    expect(taskKey('\uDEE0️ Termine per Chat löschen/auflisten: aktuell darf jeder erlaubte Absender')).toBe(taskKey(clean)); // alleinstehende Hälfte
    expect(taskKey('  Termine   per Chat  ')).toBe(taskKey('termine per chat'));
    expect(taskKey('Anderer Task')).not.toBe(taskKey(clean));
    expect(taskKey('🛠️')).not.toBe(''); // nur Symbole → Rückfall auf den ganzen Titel
  });
});
