/**
 * Konnektor-Interface (Phase J). Ein Konnektor spricht EINEN externen Dienst an.
 * Zugangsdaten kommen ausschließlich aus dem Vault und verlassen den Server nie.
 */
export interface ConnectorCheckResult {
  ok: boolean;
  /** Kurze, nicht-sensible Zusammenfassung für UI und Audit. */
  message: string;
  /** Dienstspezifische Statusdaten (keine Credentials). */
  details?: Record<string, unknown>;
}

export interface ConnectorField {
  key: string;
  label: string;
  placeholder?: string;
}

export interface Connector {
  type: string;
  label: string;
  /** Nicht-geheime Konfigurationsfelder (z. B. Repo-Name). */
  fields: ConnectorField[];
  /** Normalisiert/validiert die Konfiguration; wirft Error mit Klartext bei Fehlern. */
  validateConfig(config: Record<string, unknown>): Record<string, string>;
  /** Verbindung + Status prüfen. Darf nie Credentials in message/details zurückgeben. */
  check(args: {
    config: Record<string, string>;
    credential: string;
    fetch: typeof fetch;
  }): Promise<ConnectorCheckResult>;
}
