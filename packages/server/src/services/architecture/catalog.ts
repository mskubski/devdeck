import type { ArchKind } from '@devdeck/shared';

/** Erkennungsregeln: Variablen-Namen (und Paketnamen) → externer Dienst mit Beschreibung und Beziehungs-Beschriftung. */
export interface ServiceRule {
  id: string;
  kind: ArchKind;
  name: string;
  description: string;
  /** Beschriftung der Beziehung „Anwendung → Dienst“ */
  link: string;
  env?: RegExp;
  pkg?: RegExp;
}

export const SERVICE_RULES: ServiceRule[] = [
  { id: 'telegram', kind: 'messaging', name: 'Telegram-Bot', env: /^TELEGRAM_/, pkg: /telegram|telegraf|grammy/,
    description: 'Nimmt Nachrichten und Aufgaben entgegen und sendet Antworten über die Telegram Bot API.', link: 'Nachrichten' },
  { id: 'mail', kind: 'mail', name: 'Mail-Server (IMAP/SMTP)', env: /^(EMAIL_|IMAP_|SMTP_|MAIL_)/, pkg: /^(nodemailer|imapflow|aioimaplib|imap-tools|imaplib2)$/,
    description: 'Liest eingehende E-Mails und versendet Antworten.', link: 'E-Mails lesen/senden' },
  { id: 'anthropic', kind: 'llm', name: 'Anthropic (Claude)', env: /^(ANTHROPIC_|CLAUDE_)/, pkg: /^(anthropic|@anthropic-ai\/.+)$/,
    description: 'Sprachmodell für Textverstehen, Agenten und Code (Claude).', link: 'KI-Anfragen' },
  { id: 'openai', kind: 'llm', name: 'OpenAI', env: /^OPENAI_/, pkg: /^openai$/,
    description: 'Sprachmodelle von OpenAI (GPT, Embeddings, Whisper-API).', link: 'KI-Anfragen' },
  { id: 'mistral', kind: 'llm', name: 'Mistral AI', env: /^MISTRAL_/, pkg: /^mistralai$/,
    description: 'Europäischer LLM-Anbieter, z. B. als Ausweich-Modell.', link: 'KI-Anfragen' },
  { id: 'openrouter', kind: 'llm', name: 'OpenRouter', env: /^OPENROUTER_/,
    description: 'Gateway zu vielen Sprachmodellen mit einem Schlüssel.', link: 'KI-Anfragen' },
  { id: 'gemini', kind: 'llm', name: 'Google Gemini', env: /^(GEMINI_|GOOGLE_AI_|GOOGLE_API_KEY)/, pkg: /^(google-generativeai|@google\/generative-ai)$/,
    description: 'Sprachmodelle von Google.', link: 'KI-Anfragen' },
  { id: 'groq', kind: 'llm', name: 'Groq', env: /^GROQ_/, pkg: /^groq(-sdk)?$/,
    description: 'Schnelle Modell-Inferenz.', link: 'KI-Anfragen' },
  { id: 'ollama', kind: 'llm', name: 'Ollama (lokale Modelle)', env: /^OLLAMA_/, pkg: /^ollama$/,
    description: 'Lokal betriebene Sprachmodelle.', link: 'KI-Anfragen' },
  { id: 'whisper', kind: 'llm', name: 'Whisper (Spracherkennung)', env: /^WHISPER_/, pkg: /whisper/,
    description: 'Wandelt Sprachnachrichten in Text um.', link: 'Sprache → Text' },
  { id: 'brevo', kind: 'mail', name: 'Brevo (E-Mail-Marketing)', env: /^BREVO_/, pkg: /^(sib-api-v3-sdk|@getbrevo\/.+)$/,
    description: 'Newsletter und Kampagnen-Versand.', link: 'Newsletter/Kampagnen' },
  { id: 'sendgrid', kind: 'mail', name: 'SendGrid', env: /^SENDGRID_/, pkg: /^(sendgrid|@sendgrid\/.+)$/,
    description: 'Transaktionale E-Mails.', link: 'E-Mail-Versand' },
  { id: 'stripe', kind: 'payment', name: 'Stripe', env: /^STRIPE_/, pkg: /^(stripe|@stripe\/.+)$/,
    description: 'Online-Zahlungen.', link: 'Zahlungen' },
  { id: 'paypal', kind: 'payment', name: 'PayPal', env: /^PAYPAL_/, description: 'Online-Zahlungen.', link: 'Zahlungen' },
  { id: 'openstreetmap', kind: 'map', name: 'OpenStreetMap', env: /(^|_)(OSM|NOMINATIM|OPENSTREETMAP|OVERPASS)(_|$)/i,
    pkg: /^(leaflet|react-leaflet|osmnx|maplibre-gl|nominatim)$/,
    description: 'Kartendaten und Geokodierung.', link: 'Karten & Geodaten' },
  { id: 'mapbox', kind: 'map', name: 'Mapbox', env: /^MAPBOX_/, pkg: /^(mapbox-gl|@mapbox\/.+)$/,
    description: 'Karten und Geokodierung.', link: 'Karten & Geodaten' },
  { id: 'googlemaps', kind: 'map', name: 'Google Maps', env: /^GOOGLE_MAPS_/, pkg: /^(googlemaps|@googlemaps\/.+)$/,
    description: 'Karten, Routen und Orte.', link: 'Karten & Orte' },
  { id: 'sentry', kind: 'service', name: 'Sentry', env: /^SENTRY_/, pkg: /^(sentry-sdk|@sentry\/.+)$/,
    description: 'Fehler-Monitoring.', link: 'Fehlerberichte' },
  { id: 'twilio', kind: 'messaging', name: 'Twilio', env: /^TWILIO_/, pkg: /^twilio$/,
    description: 'SMS/WhatsApp/Telefonie.', link: 'SMS/Anrufe' },
  { id: 'cloudflare', kind: 'service', name: 'Cloudflare', env: /^CLOUDFLARE_/,
    description: 'DNS, CDN und Schutz.', link: 'DNS/CDN' },
  { id: 'aws', kind: 'service', name: 'Amazon AWS', env: /^AWS_/, pkg: /^(boto3|aws-sdk|@aws-sdk\/.+)$/,
    description: 'Cloud-Dienste von Amazon.', link: 'Cloud-API' },
  { id: 'redis', kind: 'storage', name: 'Redis', env: /^REDIS_/, pkg: /^(redis|ioredis)$/,
    description: 'Cache/Warteschlange im Arbeitsspeicher.', link: 'Cache/Queue' },
  { id: 'peefinder', kind: 'service', name: 'PeeFinder', env: /^PEEFINDER_/,
    description: 'Anbindung an die PeeFinder-Anwendung.', link: 'Daten/API' },
];

/** Domain → Anbieter (für Mail-/Webspace-/Datenbank-Hosts) */
const PROVIDERS: Array<[RegExp, string]> = [
  [/(ionos|1und1|1and1|kundenserver)\./, 'IONOS'],
  [/strato\./, 'STRATO'],
  [/(gmail|google|googlemail)\./, 'Google'],
  [/(outlook|office365|hotmail|microsoft)\./, 'Microsoft'],
  [/(web\.de|gmx\.)/, 'WEB.DE/GMX'],
  [/mailbox\.org/, 'mailbox.org'],
  [/all-inkl|kasserver/, 'ALL-INKL'],
  [/hetzner/, 'Hetzner'],
  [/(supabase)\./, 'Supabase'],
  [/vercel/, 'Vercel'],
];

export function providerForHost(host: string | undefined): string | null {
  if (!host) return null;
  for (const [re, name] of PROVIDERS) if (re.test(host)) return name;
  return null;
}

const REGIONS: Record<string, string> = {
  'eu-central-1': 'Frankfurt', 'eu-central-2': 'Zürich', 'eu-west-1': 'Irland', 'eu-west-2': 'London', 'eu-west-3': 'Paris',
  'eu-north-1': 'Stockholm', 'us-east-1': 'N. Virginia', 'us-east-2': 'Ohio', 'us-west-1': 'N. Kalifornien', 'us-west-2': 'Oregon',
  'ap-southeast-1': 'Singapur', 'ap-southeast-2': 'Sydney', 'ap-northeast-1': 'Tokio', 'ap-northeast-2': 'Seoul',
  'ap-south-1': 'Mumbai', 'sa-east-1': 'São Paulo', 'ca-central-1': 'Kanada',
};

/** `aws-0-eu-central-1.pooler.supabase.com` → „eu-central-1 (Frankfurt)“ */
export function supabaseRegion(host: string): string | null {
  const m = /aws-\d+-([a-z]{2}-[a-z]+-\d)\.pooler\.supabase\.com$/.exec(host);
  if (!m) return null;
  return REGIONS[m[1]!] ? `${m[1]} (${REGIONS[m[1]!]})` : m[1]!;
}

export function supabaseRef(host: string): string | null {
  const m = /^([a-z0-9]{15,})\.supabase\.co$/.exec(host);
  return m ? m[1]! : null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
