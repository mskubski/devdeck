/** Erklärung der Secret-Umgebungen – einheitlich in Import-Dialog, Secret-Dialog und Hilfe. */
export const ENV_HELP_HTML = `
  <ul class="text-sm env-help">
    <li><strong>development</strong> – Entwicklung: Werte zum Arbeiten und Ausprobieren auf deinem Rechner
      (Test-Datenbank, Sandbox-Schlüssel, Test-Konten). Fehler richten keinen Schaden an. Nur diese Umgebung schreibt DevDeck
      standardmäßig in die lokale <code>.env</code> des Workspaces.</li>
    <li><strong>staging</strong> – Probelauf: eine Testumgebung, die dem Live-Betrieb möglichst gleicht (aber mit Testdaten
      und eigenen Testschlüsseln). Hier prüft man Änderungen, bevor sie live gehen.</li>
    <li><strong>production</strong> – Live-Betrieb: die echten Schlüssel und Konten, mit denen die Anwendung wirklich arbeitet
      (Kunden-Daten, Zahlungen, Telegram-/Mail-/API-Konten). Besonders sorgfältig behandeln; ein Fehler wirkt sofort live.</li>
  </ul>
  <p class="text-sm muted">Derselbe Secret-Name kann in jeder Umgebung einen anderen Wert haben (z. B. <span class="mono">API_KEY</span>
    als Testwert in <em>development</em> und als echter Wert in <em>production</em>). Wert abrufen für eine andere Umgebung:
    <span class="mono">devdeck env run --environment production -- &lt;befehl&gt;</span>.</p>`;
