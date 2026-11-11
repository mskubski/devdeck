/**
 * Einrichtungshilfen für den Fernzugriff (VNC): passende Befehle je System, zum Kopieren.
 * Reine Funktionen ohne DOM – testbar. Alle VNC-Server sollen nur lokal lauschen (DevDeck tunnelt über den Agent).
 */

const PM_INSTALL = {
  'apt-get': 'sudo apt install -y',
  dnf: 'sudo dnf install -y',
  yum: 'sudo yum install -y',
  pacman: 'sudo pacman -S --noconfirm',
  zypper: 'sudo zypper install -y',
};

/**
 * Liefert Hinweise für die Maschine: [{ title, note?, commands? }]. `platform` ist win32|linux|darwin,
 * `remote` der gemeldete Zustand (kann fehlen).
 */
export function remoteHints(platform, remote) {
  const env = remote?.env ?? {};
  const out = [];

  if (platform === 'win32') {
    out.push({
      title: 'TightVNC installieren (Administrator-PowerShell)',
      note: 'Ersetze die Platzhalter durch eigene Passwörter (VNC wertet nur die ersten 8 Zeichen aus). Der Server lauscht nur lokal und läuft als Dienst. Danach hier unter „Passwort hinterlegen“ eintragen.',
      commands: [
        'winget install -e --id GlavSoft.TightVNC --silent --accept-package-agreements --accept-source-agreements --override "/qn /norestart ADDLOCAL=Server SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=1 SET_PASSWORD=1 VALUE_OF_PASSWORD=<PASSWORT> SET_USECONTROLAUTHENTICATION=1 VALUE_OF_USECONTROLAUTHENTICATION=1 SET_CONTROLPASSWORD=1 VALUE_OF_CONTROLPASSWORD=<ADMIN-PASSWORT> SET_ALLOWLOOPBACK=1 VALUE_OF_ALLOWLOOPBACK=1 SET_LOOPBACKONLY=1 VALUE_OF_LOOPBACKONLY=1"',
      ],
    });
    return out;
  }

  if (platform === 'darwin') {
    out.push({
      title: 'Bildschirmfreigabe des Macs einschalten',
      note: 'Systemeinstellungen → Allgemein → Freigaben → „Bildschirmfreigabe“ einschalten. Unter „i“ / „Computereinstellungen“ die Option „VNC-Betrachter dürfen den Bildschirm mit Passwort steuern“ aktivieren und ein Passwort setzen. Der Mac lauscht dann auf Port 5900 auch im Netzwerk – nutze die Firewall, wenn das nicht gewollt ist.',
      commands: [],
    });
    return out;
  }

  const install = PM_INSTALL[env.package_manager] ?? PM_INSTALL['apt-get'];
  const session = env.session;
  if (session !== 'wayland') {
    out.push({
      title: 'x11vnc für X11-Desktops (empfohlen)',
      note: 'Nur lokal erreichbar (-localhost), startet als Benutzerdienst. Funktioniert mit X11-Sitzungen (nicht mit Wayland).',
      commands: [
        `${install} x11vnc`,
        'mkdir -p ~/.devdeck && x11vnc -storepasswd ~/.devdeck/vnc.pass',
        'x11vnc -display :0 -auth guess -rfbauth ~/.devdeck/vnc.pass -localhost -forever -shared -noxdamage -repeat',
      ],
    });
  }
  if (session !== 'x11') {
    out.push({
      title: 'GNOME Bildschirmfreigabe (Wayland)',
      note: 'Eingebaut in GNOME. Hinweis: Der Dienst lauscht auf allen Netzwerkschnittstellen. Sperre Port 5900 von außen in der Firewall – DevDeck verbindet über den Agent lokal.',
      commands: [
        "grdctl vnc enable && grdctl vnc set-auth-method password && grdctl vnc set-password '<PASSWORT>'",
        'sudo ufw deny in on eth0 to any port 5900 proto tcp   # Beispiel; Schnittstelle anpassen',
      ],
    });
  }
  out.push({
    title: 'Server ohne Desktop: virtueller Desktop (TigerVNC)',
    note: 'Legt einen eigenen Desktop auf Display :1 an (Port 5901, nur lokal). Braucht eine Desktop-Umgebung, hier XFCE.',
    commands: [
      `${install} tigervnc-standalone-server xfce4`,
      'vncpasswd',
      'vncserver :1 -localhost yes -geometry 1920x1080 -xstartup /usr/bin/startxfce4',
    ],
  });
  return out;
}

/** Warnhinweis, wenn der VNC-Port auch im Netzwerk erreichbar ist. */
export function exposureNote(remote) {
  if (!remote?.vnc?.running) return null;
  if (remote.vnc.local_only === false) {
    return 'Der VNC-Server ist auch aus dem Netzwerk erreichbar. DevDeck braucht das nicht (Zugriff läuft über den Agent) – am besten auf „nur lokal“ stellen oder den Port in der Firewall sperren.';
  }
  return null;
}
