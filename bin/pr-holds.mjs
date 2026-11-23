// Rules from state/pr-holds.json. Explicit PR holds take priority over
// exceptions to the owner rule, which only applies to non-main targets.
export function holdFor(pr, rules) {
  const number = String(pr.number);
  const byNumber = rules?.byNumber || {};
  if (Object.hasOwn(byNumber, number) && byNumber[number]) return `hold: ${byNumber[number]}`;
  if (Array.isArray(rules?.notHeld) && rules.notHeld.some((n) => String(n) === number)) return '';

  const byOwner = rules?.byOwnerNonMainBase || {};
  if (pr.owner && pr.baseRef && pr.baseRef !== 'main' && Object.hasOwn(byOwner, pr.owner) && byOwner[pr.owner]) {
    return `hold: ${byOwner[pr.owner]}`;
  }
  return '';
}
