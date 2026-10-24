import { icon } from '../lib/icons.js';
import { ENV_HELP_HTML } from '../lib/envHelp.js';

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
        <p><strong>Wofür sind die Umgebungen (development / staging / production)?</strong></p>
        ${ENV_HELP_HTML}
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

        <h3>Maschinen-Details</h3>
        <p>Ein Klick auf den <strong>Namen</strong> einer Maschine öffnet ihre Detailseite (Tabs <em>Übersicht</em>, <em>Inventar</em>, <em>Anwendungen</em>, <em>Patches</em> und <em>Logs</em>; weitere folgen). Der Agent (ab 0.9.0) sammelt dafür
        beim Start und danach alle 15 Minuten ein <strong>Inventar</strong> – auf Windows, Linux und macOS, nur Metadaten, keine Inhalte oder Passwörter:
        <em>Laufwerke</em> (frei/gesamt), <em>Gerät</em> (Computername, Hersteller, Modell, Prozessor, Seriennummer, RAM, BIOS), <em>Betriebssystem</em> (Version, Build, Sprache),
        <em>Sicherheit</em> (Secure Boot, Firewall, Verschlüsselung, Virenschutz bzw. FileVault/SIP/Gatekeeper, TPM, ausstehender Neustart; grün = in Ordnung, gelb = Hinweis, rot = Problem, grau = nicht ermittelbar),
        <em>Verwaltung</em> (Agent, IP-Adresse, Startzeit) und <em>Eigene Felder</em>. Was ein System nicht hergibt (z. B. ohne Administratorrechte), bleibt leer oder „Unbekannt“ – es wird nie geraten.
        <strong>Eigene Felder</strong> (Besitzer der Maschine oder Admin): beliebige Angaben als „Bezeichnung: Wert“, eine pro Zeile (z. B. Standort, Zuständiger, Kaufdatum) – bitte keine Passwörter, dafür gibt es den Vault.
        Der Tab <strong>Inventar</strong> zeigt die Hardware im Detail, je Abschnitt mit Zeitstempel: <em>Gerät</em>, <em>Sicherheit</em> (inkl. TPM-Hersteller/-Spezifikation, soweit ohne Administratorrechte lesbar),
        <em>Prozessor</em> (Name, Hersteller, Kerne/Threads, Takt, Datenbreite, L2-Cache, Architektur), <em>BIOS</em>, <em>Speichermodule</em> (Hersteller, Kapazität, Teilenummer, Steckplatz, Bauform, Geschwindigkeit)
        und <em>Netzwerkverbindungen</em> (Name, MAC, IPv4/IPv6, verbunden). Unter Linux brauchen die Speichermodule Root-Rechte (<code>dmidecode</code>) – ohne bleibt der Abschnitt leer; unter macOS mit Apple Silicon erscheint der gemeinsame Arbeitsspeicher als ein Eintrag.
        Ist noch kein Inventar da, ist der Agent zu alt (Übersicht ab 0.9.0, Inventar-Details ab 0.10.0): unter <em>Maschinen</em> „Agent updaten“.</p>

        <p>Der Tab <strong>Anwendungen</strong> listet die <strong>installierte Software</strong> mit Name, Version, Hersteller, Kennung und Quelle – mit Suchfeld und Filter nach Quelle, Zeitstempel der letzten Erfassung
        (der Agent ab 0.11.0 liest sie beim Start und danach stündlich; angezeigt werden die ersten 500 Treffer, „alle anzeigen“ lädt den Rest).
        <em>Windows:</em> Programme aus den Uninstall-Schlüsseln der Registry (Quelle <em>MSI</em>, <em>Add or remove programs</em> bzw. <em>(user)</em> für Benutzerinstallationen); Updates und ausgeblendete Nicht-MSI-Einträge entfallen, Microsoft-Store-Apps sind nicht enthalten.
        <em>Linux:</em> Pakete des Paketmanagers (<code>dpkg</code>, sonst <code>rpm</code> oder <code>pacman</code>) sowie <code>snap</code> und <code>flatpak</code>, soweit vorhanden – Hersteller ist bei dpkg der Paketbetreuer. Das sind oft viele hundert Einträge, gespeichert werden höchstens 2500.
        <em>macOS:</em> Programme aus <code>system_profiler</code> (Quelle Apple, Mac App Store, Identifizierter Entwickler) und Homebrew-Pakete. Nicht über den Paketmanager installierte Programme (portable Apps, selbst kompiliert) kennt DevDeck nicht.</p>

        <p>Der Tab <strong>Patches</strong> zeigt, <strong>welche Updates ausstehen</strong> (Agent ab 0.12.0, Prüfung beim Start und danach alle 6 Stunden; die erste kann einige Minuten dauern):
        Zusammenfassung (Gesamtstatus, Anzahl ausstehender/kritischer/sicherheitsrelevanter Updates, Neustart erforderlich, zuletzt installiert), die Tabelle <em>Ausstehende Updates</em> (Hersteller, Name, installierte und verfügbare Version,
        Art System/Programm, Status <span class="badge bad">Kritisch</span> · <span class="badge warn">Sicherheit</span> · <span class="badge accent">Update verfügbar</span>) und <em>Zuletzt installierte Updates</em>.
        <em>Windows:</em> ausstehende Windows-Updates über den Windows Update Agent (Schweregrad Kritisch/Wichtig laut Microsoft) und veraltete Programme über <code>winget</code>; installierte Updates aus der Hotfix-Liste.
        <em>Linux:</em> <code>apt list --upgradable</code> (Sicherheits-Suiten werden als „Sicherheit“ markiert), sonst <code>dnf</code> (mit Sicherheitsmeldungen) oder <code>checkupdates</code>; das Ergebnis ist so aktuell wie die Paketliste – der Tab nennt deren Alter (die Pakete selbst aktualisiert DevDeck nicht).
        <em>macOS:</em> <code>softwareupdate -l</code> und <code>brew outdated</code>. <strong>Wichtig:</strong> Das ist kein Hersteller-Scanner mit Schwachstellen-Datenbank: Gelistet wird nur, was ein Update braucht; „aktuell“ heißt „dem System ist kein Update bekannt“.
        Programme, die weder winget noch ein Paketmanager kennt, werden nicht bewertet.</p>

        <p>Der Tab <strong>Logs</strong> zeigt die <strong>Fehlermeldungen der Maschine</strong> (nur Stufen Kritisch und Fehler) mit Zeit, <em>Log</em> (aus welchem Protokoll der Eintrag stammt), Quelle (Anbieter, Dienst oder Prozess), ID, Ebene und Meldung –
        neueste zuerst, mit Suche und Filter nach Log und Ebene; über der Tabelle steht, wie viele Einträge je Log gespeichert sind. Der Agent (ab 0.13.0) liest sie alle 15 Minuten (beim ersten Mal die letzten 7 Tage) und überträgt nur Neues.
        <em>Windows:</em> Ereignisanzeige, Protokolle <em>System</em> (dort auch Hardware-/Laufwerksfehler, z. B. Anbieter disk, Ntfs, WHEA-Logger) und <em>Application</em>; das Sicherheitsprotokoll braucht Administratorrechte und wird nicht gelesen.
        <em>Linux:</em> systemd-Journal (Priorität „err“ und schlimmer, getrennt in <em>journal (System)</em> und <em>journal (Kernel)</em> – letzteres sind Treiber-/Hardwarefehler) sowie der Kernel-Ringpuffer <em>dmesg</em>, soweit lesbar.
        Damit der Agent <em>alle</em> Journal-Einträge sieht, muss sein Benutzer in der Gruppe <code>systemd-journal</code> (oder <code>adm</code>) sein, sonst sieht er nur eigene – der Tab weist darauf hin.
        <em>macOS:</em> Systemprotokoll (<code>log show</code>, Error und Fault) sowie Absturz- und Kernel-Panic-Berichte aus <em>DiagnosticReports</em>.
        <strong>Aufbewahrung:</strong> Einträge werden <strong>30 Tage</strong> gespeichert und danach automatisch gelöscht (beim Eintreffen neuer Logs und alle 6 Stunden); zusätzlich gilt eine Obergrenze von 5000 Einträgen je Maschine (die ältesten fallen zuerst weg), damit die Datenbank nicht überläuft.
        Meldungen werden auf 600 Zeichen gekürzt. Logs können versehentlich sensible Angaben enthalten (Pfade, Benutzernamen) – sie sind nur für Berechtigte der Maschine sichtbar.</p>

        <h3>Die drei Knöpfe pro Maschine</h3>
        <table><thead><tr><th>Knopf</th><th>Was passiert genau?</th><th>Voraussetzung</th></tr></thead><tbody>
          <tr><td><strong>Agent updaten</strong></td>
            <td>Beauftragt den Agenten, sich selbst zu aktualisieren: <code>git fetch</code> von <code>origin/main</code> (nur Fast-Forward, bei Bedarf Wechsel auf <code>main</code>),
              bei Bedarf Abhängigkeiten installieren (<code>npm ci</code>) und Build, dann ein Probelauf des neuen Codes und zuletzt der Neustart des Agenten. Scheitert Build oder Probelauf (oder liegen lokale Änderungen vor),
              wird alles zurückgerollt und der alte Agent läuft weiter. Der Agent ist während des Neustarts kurz offline. Andere Maschinen und der Server bleiben unberührt –
              den Server aktualisierst du unter <em>System</em>.</td>
            <td>Maschine online, Agent mit Selbst-Update (sonst erscheint „Update-Anleitung“ für die einmalige manuelle Aktualisierung)</td></tr>
          <tr><td><strong>Root ändern</strong></td>
            <td>Ändert den <em>Workspace-Root</em> der Maschine, also das Verzeichnis, unter dem der Agent arbeiten darf. Der neue absolute Pfad wird auf der Maschine gespeichert
              (fehlendes Verzeichnis wird angelegt) und gilt sofort, ohne Neustart. Bestehende Dateien und Workspaces werden <em>nicht</em> verschoben oder gelöscht;
              Workspaces außerhalb des neuen Roots lassen sich allerdings nicht mehr synchronisieren/provisionieren, bis ihr Pfad angepasst wird.</td>
            <td>Maschine online, Agent mit Selbst-Update</td></tr>
          <tr><td><strong>Widerrufen</strong></td>
            <td>Entzieht der Maschine <em>sofort und dauerhaft</em> den Zugriff auf DevDeck: Das Agent-Token wird ungültig, wartende und laufende Aufträge werden abgebrochen,
              die zugehörigen Workspaces stehen auf „offline“. Die Maschine bleibt mit Status „revoked“ in der Liste (Nachvollziehbarkeit, Audit-Eintrag). Es wird <em>nichts gelöscht</em> –
              weder Daten auf dem Rechner noch Workspaces oder Projekte in DevDeck. Rückgängig geht nicht: Zum erneuten Verbinden einen neuen Enrollment-Token erzeugen und den Agenten
              neu registrieren (<code>enroll</code>). Der Knopf erscheint für Besitzer der Maschine und Admins und verlangt eine Bestätigung.</td>
            <td>Maschine nicht bereits widerrufen</td></tr>
        </tbody></table>

        <p>Der DevDeck Agent führt danach ausschließlich diese fest definierten Aktionen aus – es gibt
        <strong>keine generische Remote-Shell</strong>:</p>
        <ul>
          <li><code>workspace.status</code> / <code>workspace.sync</code> / <code>workspace.provision</code></li>
          <li><code>context.refresh</code> – erzeugt <code>.devdeck/*.md</code> aus der Datenbank</li>
          <li><code>env.refresh</code> – projiziert <code>.env</code> und Secret Files (0600, nie committed)</li>
          <li><code>dependencies.install</code>, <code>editor.open</code>, <code>terminal.open</code>, <code>coding_agent.start</code></li>
        </ul>
        <p><strong>Update „erfolgreich“, aber die Version bleibt alt?</strong> „Agent updaten“ holt den Code (nur Fast-Forward), baut ihn, <em>startet den neuen Code probeweise</em>
        (schlägt das fehl, wird abgebrochen und der alte Agent läuft weiter) und startet den Agenten neu. Meldet der Agent danach weiter die alte Version, zeigt die Maschinen-Liste
        „Update nicht angekommen“ samt Startdatei, Commit und Node-Version des laufenden Prozesses. Typische Ursachen: ein <em>zweiter, älterer Agent-Prozess</em> (z. B. früher von Hand gestartet) läuft
        parallel; der Agent läuft aus einem <em>anderen Ordner</em> als dem aktualisierten; er wird von einem Prozess-Manager/Container gestartet, der alten Code festhält. Prüfen auf der Maschine:
        <code>ps -eo pid,lstart,cmd | grep "[a]gent/dist"</code> (Linux) bzw. Task-Manager (Windows) – es sollte genau <em>einen</em> Agent-Prozess geben; danach ihn einmal sauber neu starten.
        Hängende Aufträge („running“) werden nach 30 Minuten automatisch als fehlgeschlagen abgeschlossen.</p>
        <p><strong>Empfohlen unter Linux:</strong> den Agent als systemd-Dienst betreiben – dann gibt es genau einen Prozess und er startet nach jedem Update zuverlässig mit dem neuen Code:
        im DevDeck-Ordner <code>git pull --ff-only &amp;&amp; deploy/install-agent-service.sh --replace</code> (installiert nur den Agenten, nicht den Server; <code>--replace</code> beendet von Hand gestartete Agent-Prozesse;
        für Start ohne Login einmalig <code>sudo loginctl enable-linger $USER</code>).</p>`,
    },
    {
      id: 'workspaces',
      icon: 'package',
      title: 'Workspaces: Sync & Provision',
      body: `
        <p>Ein <strong>Workspace</strong> ist die lokale Arbeitskopie eines Projekts auf einer bestimmten
        Maschine (Pfad + zugeordnete Maschine). <strong>Der Pfad muss immer unterhalb des Workspace-Roots der Maschine liegen</strong>
        (Sicherheitsregel: der Agent arbeitet nur dort; den Root zeigt und ändert man unter <em>Maschinen</em>). Beim Registrieren und Bearbeiten
        zeigt DevDeck den Root an, schlägt ihn als Pfad vor und prüft die Eingabe. Mit <em>Bearbeiten</em> lassen sich Pfad, Maschine, Branch und
        Repository nachträglich ändern; <em>Entfernen</em> (Maintainer) löscht nur die Registrierung in DevDeck – nie Dateien auf der Maschine.
        Ohne eigenes Repository am Workspace nutzt Provision das Repository und den Standard-Branch des Projekts. Zwei sichere Operationen stehen zur Verfügung:</p>
        <p><strong>Status verstehen:</strong> Die Spalte <em>Status</em> kommt vom Agenten auf der Maschine. Er prüft Git, Repository, Toolchain und
        Abhängigkeiten laut optionalem <code>.devdeck/workspace.yaml</code>, die <code>.env</code> (nur wenn das Manifest eine Projektion verlangt), den
        Coding-Kontext und den Abgleich mit GitHub (unveröffentlichte Commits bzw. neuer Remote-Stand). Daraus folgt:
        <strong>ready</strong> = alles in Ordnung · <strong>warning</strong> = läuft, aber es gibt Hinweise · <strong>blocked</strong> = eine Voraussetzung fehlt
        (z. B. Ordner nicht vorhanden → Provision) · <strong>unknown</strong> = noch nicht geprüft. <em>Ein Klick auf den Status zeigt jeden Prüfpunkt mit Begründung.</em>
        Geprüft wird automatisch beim Registrieren/Ändern, bei Sync/Provision und – falls noch nie geprüft – sobald der Agent sich meldet;
        mit <em>Prüfen</em> geht es jederzeit manuell (read-only, ohne zu synchronisieren).</p>
        <p><strong>Sync</strong> prüft zuerst den Git-Status. Gibt es nicht committete, lokale Änderungen,
        <strong>bricht der Agent sofort ab</strong> (nichts wird überschrieben) – erst danach folgen
        <code>fetch</code> + <code>pull --ff-only</code> (nie <code>reset</code>/<code>stash</code>/<code>clean</code>),
        ein Dependency-Check und ein Context-Refresh.</p>
        <p><strong>Provision</strong> richtet einen neuen oder leeren Workspace komplett ein: Clone → Toolchain
        prüfen → Dependencies installieren → autorisierte Secrets/<code>.env</code> projizieren → Context erzeugen →
        Readiness bewerten. Trifft Provision auf ein nicht-leeres, nicht-Git-Verzeichnis, bricht es mit einer
        Rückfrage ab, statt etwas zu überschreiben.</p>
        <p><strong>Deploy</strong> (Maintainer, nur Linux-Maschinen, Agent ab 0.8.0): Bringt eine <em>produktiv laufende</em> Software auf den neuesten Stand.
        Ablauf: Arbeitskopie muss sauber sein (sonst Abbruch, nichts verändert) → <code>fetch</code> + Fast-Forward auf den Branch des Workspaces (sonst Standard-Branch des Projekts)
        → <code>deploy</code>-Block aus <code>.devdeck/workspace.yaml</code> lesen → optional Installationsbefehl (nur wenn es neuen Code gab) → die genannten systemd-<em>Benutzer</em>dienste
        der Reihe nach neu starten → Gesundheitsprüfung (HTTP-Antwort 2xx einer Adresse auf localhost, sonst <code>systemctl --user is-active</code>). Wird ein Dienst nicht gesund oder scheitert ein Schritt,
        geht der Workspace automatisch auf den alten Commit zurück und die Dienste starten mit dem alten Stand neu. Das Ergebnis (Commits vorher/nachher, jeder Schritt) steht im Dialog und im Tab <em>Sync-Log</em>.
        Es werden nur Dienste neu gestartet, die im versionierten Manifest stehen – keine frei eingegebenen Befehle.
        <pre>deploy:
  timeout_seconds: 60          # so lange auf gesunde Dienste warten (5–600)
  install: .venv/bin/pip install -r requirements.txt   # optional, ohne Shell-Zeichen
  services:
    - unit: helferle-api
      health_url: http://localhost:5001/v1/health      # nur localhost
    - unit: helferle-gui
      health_url: http://localhost:5000/login
    - unit: helferle           # ohne health_url: is-active</pre>
        Projekte, die über GitHub/GitLab direkt auf Vercel laufen, brauchen kein Deploy hier – dort deployt der Push.</p>
        <p><strong>Deploy bricht ab?</strong> Die Meldung steht im Dialog und im <em>Sync-Log</em>. <em>„lokale Änderungen“</em> nennt die Dateien: auf der Maschine committen oder entfernen (die Software darf nicht in versionierte Dateien schreiben).
        <em>„Kein deploy-Block“</em>: das Manifest liegt noch nicht auf dem Branch des Workspaces. <em>„Neustart von … fehlgeschlagen“</em>: Unit-Name falsch oder es ist keine Benutzer-Unit (<code>systemctl --user status &lt;unit&gt;</code> prüfen).
        <em>„… nicht gesund“</em>: der Dienst startet, antwortet aber nicht in der Zeit – der Workspace wurde auf den alten Stand zurückgesetzt; Logs mit <code>journalctl --user -u &lt;unit&gt;</code>.</p>
        <p><strong>Importieren</strong> (Maintainer): Der Agent liest im Workspace <code>CHANGELOG.md</code>,
        <code>ROADMAP.md</code>/<code>TODO.md</code> (Checkboxen <code>- [ ]</code>/<code>- [x]</code>, optional <code>(P1)</code>–<code>(P5)</code>)
        sowie <code>.env</code> und <code>credentials.md</code> und zeigt zuerst eine <strong>Vorschau</strong> (Secret-Namen, nie Werte).
        Nach Bestätigung landen Changelog-Einträge, Tasks und Secrets (verschlüsselt im Vault, in der gewählten Umgebung) in DevDeck.
        Bereits vorhandene Einträge werden übersprungen – der Import lässt sich gefahrlos wiederholen.
        Die Werte laufen dabei einmalig per HTTP im LAN vom Agent zum Server; Quelldateien danach nicht committen bzw. löschen.</p>
        <p><strong>Coding-Regeln:</strong> Bei Sync/Provision/Kontext-Refresh schreibt der Agent den Kontext nach <code>.devdeck/</code> und die
        Arbeitsregeln (Kontext lesen, nach jeder Änderung bauen/testen/pushen) nach <code>.claude/rules/devdeck.md</code>, die Claude Code beim
        Start lädt. Beides wird lokal per <code>.git/info/exclude</code> ignoriert – das Repository wird nicht verändert und der Sync nicht blockiert.
        Enthält das Repo eigene Regeln, genügt der Marker <code>&lt;!-- devdeck:rules-included --&gt;</code> in der <code>CLAUDE.md</code>.</p>`,
    },
    {
      id: 'workflow',
      icon: 'code',
      title: 'Entwickeln am PC & auf dem Server ausrollen',
      body: `
        <p>Typischer Ablauf, wenn du am PC (z. B. <em>mauriceZ</em>) entwickelst und DevDeck auf einem Server
        (z. B. <em>debian01</em>) läuft. <strong>Der Code reist ausschließlich über GitHub</strong> – DevDeck
        selbst überträgt keinen Quellcode.</p>
        <ol>
          <li><strong>Am PC arbeiten:</strong> im Workspace-Ordner (z. B. <code>D:\DEVDECK\DEV\devdeck</code>)
            einen Branch anlegen (<code>git checkout -b feature/xyz</code>) und mit Claude Code entwickeln.
            Claude Code hält dabei GitHub aktuell (Regel in <code>CLAUDE.md</code>: nach jeder Änderung bauen, testen, Pull Request, bei grüner CI mergen).
            Die Sitzung erscheint automatisch unter <em>Sessions</em> (Quelle „Claude Code“), sobald der
            Agent läuft und der Workspace registriert ist.</li>
          <li><strong>Auf GitHub bringen</strong> (macht Claude Code automatisch): bauen und testen, committen, pushen,
            Pull Request öffnen und Auto-Merge einschalten – GitHub mergt nach <code>main</code>, sobald die CI grün ist.</li>
          <li><strong>Server aktualisieren:</strong> in DevDeck unter <em>System</em> auf „Server aktualisieren“ klicken.
            Ein Backup wird automatisch erstellt, der neueste Stand von <code>main</code> geholt, gebaut und der Server
            neu gestartet (wenige Sekunden). Mit dem Häkchen „auch alle Agents aktualisieren“ (Standard) holen sich danach
            alle online befindlichen Agents den neuen Stand selbst (Fast-Forward-Pull, Build, Neustart) – ein Klick für alles.
            Schlägt etwas fehl, bleibt der alte Stand aktiv. Das geht von jeder Maschine aus, die in DevDeck angemeldet ist.</li>
          <li><strong>Projekt-Workspaces</strong> mit <em>Sync</em> (<code>devdeck sync</code>) auf den neuen Stand bringen.
            Einzelne Agents lassen sich weiterhin unter <em>Maschinen</em> mit „Agent updaten“ aktualisieren;
            Agents unter Version 0.2.0 müssen einmalig von Hand aktualisiert werden.</li>
        </ol>
        <p><strong>Optional – ganz ohne Klick:</strong> Auf der Seite <em>System</em> kann das <em>automatische Update</em> eingeschaltet
        werden. Der Server prüft dann nachts zur gewählten Stunde (Standard 03:00, Serverzeit), ob <code>main</code> neuer ist, und
        aktualisiert sich samt Agents – höchstens einmal pro Tag, nur mit sauberem Server-Ordner und nie, während ein Agent-Auftrag läuft.
        Standardmäßig ist es <strong>aus</strong>. Das Ergebnis steht unter „Letztes Update“.</p>
        <p class="muted">Hinweise: Der Server-Rechner braucht Zugriff auf GitHub (<code>git fetch</code>). Bei lokalen
        Änderungen im Server-Ordner bricht das Update bzw. „Agent updaten“ ab – dort nichts uncommittet liegen lassen.
        Das Update läuft auf dem Branch <code>main</code> (änderbar mit <code>DEVDECK_UPDATE_BRANCH</code>).
        Wissen wie Tasks, Changelog und Entscheidungen liegt in der DevDeck-Datenbank, nicht in Git
        (Import vorhandener Dateien: <code>devdeck import all</code>).</p>`,
    },
    {
      id: 'architektur',
      icon: 'layers',
      title: 'Architektur-Karte',
      body: `
        <p>Auf der <strong>Projekt-Übersicht</strong> zeigt – unterhalb von Kennzahlen, Projektinfo und letzten Sessions – ein weißes Feld über die ganze Breite, <strong>woraus das Projekt besteht und wie die Teile zusammenhängen</strong>:
        Entwicklungsrechner → GitHub-Repository → Betrieb/Hosting (eigener Server, Vercel, IONOS-Webspace …) → Datenbank (lokal mit Dateigröße, Supabase mit Region)
        sowie darunter alle externen Dienste (Mail-Server, Telegram-Bot, KI-Anbieter wie Anthropic/Mistral/OpenRouter, Karten wie OpenStreetMap, Newsletter, Zahlung …).
        Jede Karte hat eine Beschreibung; die Pfeile sind beschriftet. Ein Klick auf eine Karte zeigt alle Details und Beziehungen, ein Klick auf eine Pfeil-Beschriftung die Verbindung.
        Gestrichelte Karten/Pfeile sind noch offen oder ungewiss (z. B. „Betrieb noch nicht festgelegt“).</p>
        <p><strong>Wie bleibt die Karte aktuell?</strong> Drei Quellen, die sich ergänzen (Vorrang: manuell &gt; Manifest &gt; automatisch):</p>
        <ol>
          <li><strong>Automatisch (Programm):</strong> Bei jeder Workspace-Prüfung/Sync liest der Agent <em>Namen</em> der <code>.env</code>-Variablen, bereinigte Hostnamen (z. B. <code>IMAP_HOST</code>,
            nie Passwörter/Tokens), Abhängigkeiten, <code>vercel.json</code>/Dockerfile/systemd-Dateien und lokale SQLite-Dateien. DevDeck ordnet das Diensten zu und kennt zusätzlich Maschinen, Repository und Secret-Namen.
            Neue Projekte erscheinen so ohne Zutun, sobald ein Workspace registriert ist.</li>
          <li><strong>Manifest <code>.devdeck/architecture.yaml</code> (im Repository):</strong> Beschreibungen, Beziehungen und alles Nicht-Erkennbare. <strong>Claude Code pflegt die Datei bei jeder Änderung an Datenbank,
            Hosting oder externen Diensten mit</strong> – die Regel steht in <code>.claude/rules/devdeck.md</code> (wird beim Sync erzeugt). Format: Knopf „Wie wird das gepflegt?“ im Feld.</li>
          <li><strong>Manuell:</strong> Karte anklicken → Bearbeiten, Ausblenden oder Zurücksetzen; <em>+ Komponente</em> / <em>+ Beziehung</em> für Eigenes (Maintainer). Ausgeblendetes ist unter dem Diagramm wiederherstellbar.</li>
        </ol>
        <p><em>Aktualisieren</em> lässt alle Workspaces des Projekts sofort neu prüfen. Live-Zahlen von Supabase, Vercel und IONOS (z. B. Datenbankgröße) folgen mit den jeweiligen Konnektoren.</p>`,
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
          <li><strong>Weitere Service-Integrationen</strong> (GitLab, Supabase, Vercel, Brevo, Apple, Google Play, IONOS) –
            GitHub ist als erster Konnektor umgesetzt (Tab „Integrationen“), weitere folgen nach Bedarf.</li>
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
