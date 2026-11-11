import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const mod: any = await import(pathToFileURL(path.resolve(__dirname, '../src/webui/lib/remoteHints.js')).href);
const all = (hints: Array<{ commands?: string[] }>) => hints.flatMap((h) => h.commands ?? []).join('\n');

describe('Einrichtungshilfen für den Fernzugriff (Web UI)', () => {
  it('Windows: TightVNC per winget, nur lokal', () => {
    const h = mod.remoteHints('win32', null);
    expect(all(h)).toContain('GlavSoft.TightVNC');
    expect(all(h)).toContain('VALUE_OF_LOOPBACKONLY=1');
  });

  it('Linux: Paketverwaltung bestimmt den Befehl; X11 → x11vnc, Wayland → GNOME-Freigabe, immer TigerVNC für Server', () => {
    const x11 = mod.remoteHints('linux', { env: { session: 'x11', package_manager: 'dnf' } });
    expect(all(x11)).toContain('sudo dnf install -y x11vnc');
    expect(all(x11)).toContain('-localhost');
    expect(all(x11)).not.toContain('grdctl');
    const way = mod.remoteHints('linux', { env: { session: 'wayland', package_manager: 'apt-get' } });
    expect(all(way)).toContain('grdctl vnc enable');
    expect(all(way)).not.toContain('x11vnc -display');
    expect(all(way)).toContain('tigervnc-standalone-server');
  });

  it('macOS: Anleitung ohne Befehle; Warnung nur, wenn VNC auch im Netzwerk erreichbar ist', () => {
    const mac = mod.remoteHints('darwin', null);
    expect(mac[0].note).toContain('Bildschirmfreigabe');
    expect(mod.exposureNote({ vnc: { running: true, local_only: false } })).toContain('Netzwerk');
    expect(mod.exposureNote({ vnc: { running: true, local_only: true } })).toBeNull();
    expect(mod.exposureNote({ vnc: { running: false, local_only: false } })).toBeNull();
  });
});
