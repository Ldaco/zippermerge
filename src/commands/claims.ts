import { context } from '../context.ts';
import { loadClaims } from '../migrations.ts';

export async function run() {
  const claims = loadClaims(context());
  if (!claims.length) console.log('No claims.');
  for (const claim of claims) console.log(`${claim.number}  ${claim.agent}  ${claim.file}`);
}
