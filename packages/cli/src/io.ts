export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Eingabe (z. B. Passwort); `hidden` blendet die Eingabe aus. */
  prompt(question: string, hidden?: boolean): Promise<string>;
}

export interface Ctx {
  env: NodeJS.ProcessEnv;
  cwd: string;
  io: Io;
}
