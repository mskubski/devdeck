import { icon } from '../lib/icons.js';

export async function renderHelp(el) {
  const topics = [
    {
      id: 'ueberblick',
      icon: 'compass',
      title: 'Überblick',
      body: `
        <p>DevDeck ist ein zentral selbst gehostetes <strong>Developer Control Plane</strong>. Git bleibt die
        Quelle für Sourcecode – DevDeck verwaltet alles drumherum: Projektwissen, Aufgaben, Coding-Sessions,
        Secrets, Entwicklungsrechner (Maschinen) und deren lokale Arbeitskopien (Workspaces).</p>
        <p>Drei Komponenten arbeiten zusammen:</p>
        <ul>
          <li><strong>DevDeck Server</strong> (diese Weboberfläche) – zentrale Datenbank, Rechte, Vault, Audit-Log.</li>
          <li><strong>DevDeck Agent</strong> – läuft auf jedem Entwicklungsrechner, führt ausschließlich fest
            erlaubte Aktionen aus (kein generischer Remote-Zugriff).</li>
          <li><strong>DevDeck CLI</strong> – geplante lokale Kommandozeile für Entwickler und Coding Agents
            (Claude Code, Codex). Noch nicht ausgeliefert.</li>
        </ul>`,
    },
    {
      id: 'projekte',
      icon: 'folder',
      title: 'Projekte & Rollen',
      body: `
        <p>Ein <strong>Projekt</strong> bündelt Tasks, Sessions, Secrets, Workspaces und Audit-Einträge. Jeder
        Benutzer hat zusätzlich zur Projektrolle eine <strong>Systemrolle</strong> (<code>admin</code> oder
        <code>developer</code>) – admins dürfen Projekte anlegen und haben überall implizit Owner-Rechte.</p>
        <table><thead><tr><th>Projektrolle</th><th>Darf</th></tr></thead><tbody>
          <tr><td><span class="badge accent">viewer</span></td><td>Lesen (Tasks, Sessions, Secret-Metadaten)</td></tr>
          <tr><td><span class="badge accent">developer</span></td><td>zusätzlich: Tasks/Sessions anlegen, Secrets <em>nutzen</em> (nicht einsehen)</td></tr>
          <tr><td><span class="badge accent">maintainer</span></td><td>zusätzlich: Mitglieder verwalten, Secrets anlegen/ändern/einsehen</td></tr>
          <tr><td><span class="badge accent">owner</span></td><td>volle Projektkontrolle</td></tr>
        </tbody></table>`,
    },
    {
      id: 'tasks',
      icon: 'tasks',
      title: 'Tasks',
      body: `
        <p>Einfache Aufgabenverwaltung je Projekt: Titel, Beschreibung, Priorität (1–5) und Status
        (<code>offen → in Arbeit → erledigt</code>, oder <code>verworfen</code>). Jede Statusänderung landet im
        Audit-Log. Tasks ersetzen kein vollständiges Ticketsystem – sie sind als schneller, DB-gestützter
        Kontext für Entwickler und Coding Agents gedacht.</p>`,
    },
    {
      id: 'sessions',
      icon: 'code',
      title: 'Coding Sessions & Handover',
      body: `
        <p>Eine <strong>Coding Session</strong> markiert den Zeitraum, in dem an einem Projekt gearbeitet wird
        (manuell oder durch einen Coding Agent wie Claude Code). Beim Beenden kann ein strukturierter
        <strong>Handover</strong> erfasst werden: erledigte Punkte, offene Punkte, geänderte Dateien und Notizen.
        Damit kennt die nächste Session (auch auf einem anderen Rechner) sofort den letzten Stand, ohne die
        komplette Historie neu lesen zu müssen.</p>
        <p>Der DevDeck Agent kann eine Session zusätzlich serverseitig als „gestartet“/„beendet“ markieren, wenn
        er einen Coding Agent direkt im Workspace startet.</p>`,
    },
    {
      id: 'secrets',
      icon: 'key',
      title: 'Secrets & DevDeck Vault',
      body: `
        <p>Secret-<strong>Werte</strong> werden getrennt von den Metadaten gespeichert: Name, Beschreibung,
        Typ (<code>env</code>/<code>file</code>) und Environment (<code>development</code>/<code>staging</code>/
        <code>production</code>) liegen in der normalen Datenbank – der eigentliche Wert liegt
        <strong>AES-256-GCM-verschlüsselt</strong> in einer separaten Vault-Datei.</p>
        <p>Zugriff läuft über Capabilities, nicht nur über die Projektrolle:</p>
        <table><thead><tr><th>Capability</th><th>Bedeutung</th></tr></thead><tbody>
          <tr><td><span class="mono">secret.metadata.read</span></td><td>Name/Beschreibung sehen (nie den Wert)</td></tr>
          <tr><td><span class="mono">secret.use</span></td><td>Wert als <code>.env</code>-Variable projizieren lassen (z. B. durch den Agenten)</td></tr>
          <tr><td><span class="mono">secret.reveal</span></td><td>Wert im Browser anzeigen – wird immer auditiert</td></tr>
          <tr><td><span class="mono">secret.update</span></td><td>Wert setzen/ändern/löschen</td></tr>
          <tr><td><span class="mono">secret.file.deploy</span></td><td>als Datei in den Workspace schreiben (z. B. <code>service-account.json</code>)</td></tr>
        </tbody></table>
        <p><code>owner</code>/<code>maintainer</code> haben implizit alle Capabilities, <code>developer</code>
        nur <code>metadata.read</code> + <code>use</code>, <code>viewer</code> nur <code>metadata.read</code>.
        Secret-Werte erscheinen <strong>niemals</strong> im Audit-Log, in Logs oder in der generierten
        <code>.devdeck/SECRETS.md</code> – dort stehen nur Namen und Beschreibungen.</p>`,
    },
    {
      id: 'maschinen',
      icon: 'monitor',
      title: 'Maschinen & Agent',
      body: `
        <p>Jeder Entwicklungsrechner muss einmalig per <strong>Enrollment-Token</strong> verbunden werden
        (einmalig verwendbar, läuft ab, wird nur gehasht gespeichert). Danach erhält die Maschine ein eigenes,
        <strong>jederzeit widerrufbares</strong> Token und meldet sich alle 30 Sekunden per Heartbeat.</p>

        <h3>Wie verbindet sich mein PC? (kein SSH)</h3>
        <p>Es gibt <strong>keine SSH-Verbindung</strong> und keinen eingehenden Zugriff vom DevDeck Server auf
        deinen Rechner – es läuft genau andersherum. Der <strong>DevDeck Agent</strong> auf deinem Rechner baut
        selbst eine ausgehende HTTPS-Verbindung zum Server auf: alle 30 Sekunden ein Heartbeat, alle paar
        Sekunden eine Abfrage „gibt es ein Kommando für mich?“ (Long-Poll). Dein Rechner braucht dafür
        <strong>keinen offenen eingehenden Port</strong> und keine Portweiterleitung in Firewall/Router – er
        muss den DevDeck Server nur per HTTP(S) erreichen können (z. B. <code>http://<server>:8080</code> im
        selben Netz, oder eine extern erreichbare Adresse, falls du remote arbeitest).</p>
        <p>SSH kommt in diesem Setup höchstens an einer ganz anderen Stelle vor: wenn dein Git-Remote selbst
        per SSH angesprochen wird (<code>git@github.com:...</code>). Das ist eine Verbindung zwischen deinem
        Rechner und GitHub/GitLab – damit hat DevDeck nichts zu tun.</p>

        <h3>Rechner verbinden – Schritt für Schritt</h3>
        <ol>
          <li>In der Web-UI: <strong>Maschinen → „+ Enrollment-Token erzeugen“</strong> (als Projekt-Maintainer/
            Owner oder Admin). Das Token wird nur einmal angezeigt und läuft nach der gewählten Zeit ab.</li>
          <li>Auf dem Zielrechner (Windows/macOS/Linux) das DevDeck-Repository auschecken und einmalig bauen:
            <pre>git clone &lt;devdeck-repo&gt;
cd devdeck
npm install
npm run build</pre>
          </li>
          <li>Agent einmalig mit dem Token registrieren:
            <pre>node packages/agent/dist/index.js enroll --server http://<server>:8080 --token &lt;TOKEN&gt;</pre>
          </li>
          <li>Agent starten:
            <pre>node packages/agent/dist/index.js start</pre>
            Läuft im Vordergrund, solange das Terminal offen bleibt – für Dauerbetrieb siehe Tabelle unten.</li>
          <li>Die Maschine erscheint danach unter <strong>Maschinen</strong> mit Status
            <span class="badge ok">online</span>. Widerruf jederzeit mit einem Klick.</li>
        </ol>

        <h3>Voraussetzungen je Betriebssystem</h3>
        <table><thead><tr><th>OS</th><th>Node.js installieren</th><th>Agent dauerhaft laufen lassen</th></tr></thead><tbody>
          <tr><td>Windows</td><td>Installer von nodejs.org oder <code>winget install OpenJS.NodeJS.LTS</code></td>
            <td>Terminal offen lassen, oder als Aufgabe in der Aufgabenplanung („Beim Anmelden ausführen“)</td></tr>
          <tr><td>macOS</td><td><code>brew install node git</code></td>
            <td><code>launchd</code>-Dienst (<span class="mono">~/Library/LaunchAgents/...plist</span>) oder
              Terminal/<span class="mono">tmux</span> offen lassen</td></tr>
          <tr><td>Linux</td><td>Paketmanager (<code>apt install nodejs npm git</code>) oder NodeSource-Repo</td>
            <td><code>systemd</code>-User-Service, z. B. <span class="mono">systemctl --user enable --now
              devdeck-agent</span></td></tr>
        </tbody></table>
        <p class="muted text-sm">Ein fertiges systemd-/launchd-Unit-Template sowie ein installierbares
        <span class="mono">devdeck-agent</span>-Kommando sind Teil der noch ausstehenden DevDeck-CLI-Phase –
        aktuell startet man den Agenten direkt per <span class="mono">node .../dist/index.js</span>.</p>

        <p>Der DevDeck Agent führt danach ausschließlich diese fest definierten Aktionen aus – es gibt
        <strong>keine generische Remote-Shell</strong>:</p>
        <ul>
          <li><code>workspace.status</code> / <code>workspace.sync</code> / <code>workspace.provision</code></li>
          <li><code>context.refresh</code> – erzeugt <code>.devdeck/*.md</code> aus der Datenbank</li>
          <li><code>env.refresh</code> – projiziert <code>.env</code> und Secret Files (0600, nie committed)</li>
          <li><code>dependencies.install</code>, <code>editor.open</code>, <code>terminal.open</code>, <code>coding_agent.start</code></li>
        </ul>`,
    },
    {
      id: 'workspaces',
      icon: 'package',
      title: 'Workspaces: Sync & Provision',
      body: `
        <p>Ein <strong>Workspace</strong> ist die lokale Arbeitskopie eines Projekts auf einer bestimmten
        Maschine (Pfad + zugeordnete Maschine). Zwei sichere Operationen stehen zur Verfügung:</p>
        <p><strong>Sync</strong> prüft zuerst den Git-Status. Gibt es nicht committete, lokale Änderungen,
        <strong>bricht der Agent sofort ab</strong> (nichts wird überschrieben) – erst danach folgen
        <code>fetch</code> + <code>pull --ff-only</code> (nie <code>reset</code>/<code>stash</code>/<code>clean</code>),
        ein Dependency-Check und ein Context-Refresh.</p>
        <p><strong>Provision</strong> richtet einen neuen oder leeren Workspace komplett ein: Clone → Toolchain
        prüfen → Dependencies installieren → autorisierte Secrets/<code>.env</code> projizieren → Context erzeugen →
        Readiness bewerten. Trifft Provision auf ein nicht-leeres, nicht-Git-Verzeichnis, bricht es mit einer
        Rückfrage ab, statt etwas zu überschreiben.</p>`,
    },
    {
      id: 'audit',
      icon: 'history',
      title: 'Audit-Log',
      body: `
        <p>Sicherheitsrelevante Aktionen werden lückenlos protokolliert: Login, Machine Enrollment/Widerruf,
        Mitgliedschaftsänderungen, Secret-Anlage/-Änderung/-Anzeige, Workspace-Provisioning/-Sync, Sessions.
        Secret-<em>Werte</em> werden dabei durch einen Redaktions-Filter immer entfernt, selbst wenn sie versehentlich
        in Detail-Daten landen würden.</p>`,
    },
    {
      id: 'grenzen',
      icon: 'hourglass',
      title: 'Aktuell bewusst nicht enthalten',
      body: `
        <p>Diese Teile der Spezifikation sind als Zielbild dokumentiert, aber in dieser Version noch nicht
        umgesetzt – damit das vorhandene Fundament stabil bleibt, statt halbfertige Funktionen auszuliefern:</p>
        <ul>
          <li><strong>DevDeck CLI</strong> (<code>devdeck status/sync/session/...</code>) – noch kein Quellcode.</li>
          <li><strong>Backups/Restore</strong> – Datenmodell vorhanden, keine Implementierung.</li>
          <li><strong>Decisions/Changelog/Known Issues</strong> als eigene UI – Datenbanktabellen existieren,
            Changelog fließt bereits in <code>.devdeck/CHANGELOG_RECENT.md</code> ein, aber es gibt noch keine
            eigenen Verwaltungs-Routen/Oberflächen dafür.</li>
          <li><strong>Service-Integrationen</strong> (GitHub, Supabase, Vercel, …) – später, optional.</li>
        </ul>`,
    },
  ];

  const toc = topics.map((t) => `<a href="#help-${t.id}">${icon(t.icon, { size: 14 })}${t.title}</a>`).join('');
  const sections = topics.map((t) => `
    <section class="help-topic card" id="help-${t.id}">
      <h2>${icon(t.icon, { size: 20, cls: 'accent' })}${t.title}</h2>
      ${t.body}
    </section>`).join('');

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Hilfe</h1>
        <p class="lede">Erklärung aller DevDeck-Funktionen – passend zum tatsächlichen Funktionsumfang dieser Installation.</p>
      </div>
    </div>
    <div class="help-toc">${toc}</div>
    ${sections}`;
}
