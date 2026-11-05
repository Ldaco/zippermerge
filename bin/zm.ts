#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { UserError } from '../src/errors.ts';

const commandsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands');

function usage() {
  const names = (existsSync(commandsDir) ? readdirSync(commandsDir) : [])
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.replace(/\.ts$/, ''));
  console.log(`zippermerge <command>\n\nCommands: ${names.join(', ')}`);
}

const [command, ...rest] = process.argv.slice(2);

if (!command || command === 'help' || command === '--help') {
  usage();
  process.exit(0);
}

const file = join(commandsDir, `${command}.ts`);
if (!/^[a-z-]+$/.test(command) || !existsSync(file)) {
  console.error(`Unknown command: ${command}`);
  usage();
  process.exit(2);
}

try {
  const mod = await import(pathToFileURL(file).href);
  const { values, positionals } = parseArgs({
    args: rest,
    options: mod.options ?? {},
    allowPositionals: true,
  });
  await mod.run({ values, positionals });
} catch (error) {
  if (error instanceof UserError || (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
    console.error((error as Error).message);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
}
