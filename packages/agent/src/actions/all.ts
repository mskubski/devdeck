/**
 * Aggregator: Import aller Action-Module, damit die Registry beim Start
 * vollständig belegt ist (Seiteneffekt = Registrierung).
 */
import './workspaceStatus.js';
import './workspaceSync.js';
import './workspaceProvision.js';
import './contextRefresh.js';
import './envRefresh.js';
import './dependenciesInstall.js';
import './editorOpen.js';
import './terminalOpen.js';
import './codingAgentStart.js';
