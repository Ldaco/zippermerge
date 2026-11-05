// The records in the store and the board built from them. Nothing here runs, so the dashboard can share it.

export interface MigrationsConfig {
  dir: string;
  pattern: string;
}

export interface Config {
  base: string;
  remote: string | null;
  human: string;
  port: number;
  migrations: MigrationsConfig | null;
}

export interface Ctx {
  cwd: string;
  store: string;
  config: Config;
  me: string | null;
}

/** What a command receives from the command line. */
export interface Args<Values = Record<string, never>> {
  values: Values;
  positionals: string[];
}

export interface Agent {
  name: string;
  role: string;
  owns: string[];
  worktree: string;
  joinedAt: string;
}

export interface Message {
  id: string;
  ts: string;
  from: string;
  to: string[];
  kind: string;
  body: string;
  re: string | null;
  thread: string;
  via: string;
}

export interface Receipt {
  delivered: string | null;
  acked: string | null;
}

export interface Claim {
  number: number;
  agent: string;
  slug: string;
  file: string;
  path: string;
  ts: string;
}

/** One thing that happened. Which optional fields are set depends on the type. */
export interface ZmEvent {
  id: string;
  ts: string;
  agent: string | null;
  type: string;
  role?: string;
  resource?: string;
  why?: string;
  holder?: string | null;
  number?: number;
  file?: string;
  files?: string[];
  reasons?: string[];
  glob?: string;
  exclusive?: boolean;
  command?: string;
  waitedMs?: number;
  durationMs?: number;
  code?: number;
}
