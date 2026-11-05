import { context } from '../context.ts';
import { loadLocks } from '../locks.ts';

export async function run() {
  const locks = loadLocks(context());
  if (!locks.length) console.log('No locks.');
  for (const lock of locks) console.log(`${lock.resource}  ${lock.agent}  until ${lock.expiresAt}  ${lock.why}`);
}
