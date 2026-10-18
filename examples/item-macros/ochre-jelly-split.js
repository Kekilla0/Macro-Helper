/**
 * Ochre Jelly : Split (Reaction)
 *   "Trigger : While the jelly is Large or Medium and has 10+ Hit Points, it becomes Bloodied or is subjected to
 *    Lightning or Slashing damage. Response : The jelly splits into two new Ochre Jellies. Each new jelly is one size
 *    smaller than the original jelly and acts on its Initiative. The original jelly's Hit Points are divided evenly
 *    between the new jellies (round down)."
 * Homebrew : the Pseudopod's damage follows the jelly's size (DAMAGE below), set on the new jellies when they split.
 *
 * Setup : Item Macro on the Split feature of the creature in the sidebar (placed tokens get it), mode "Macro",
 *         Run on Hooks : "dnd5e.applyDamage", Run For : Active GM, only for this creature.
 * Needs : unlinked tokens (monsters from a compendium are, by default).
 * Uses  : damageTypes(options), becameBloodied(actor, options), item.roll(), token.split(), item.setDamage(formula)
 */

const TYPES = ["lightning", "slashing"];
const DAMAGE = { lg : "2d8 + @mod", med : "1d8 + @mod", sm : "1d4 + @mod", tiny : "1d2 + @mod" };

if(hook !== "dnd5e.applyDamage") return;   // used from the sheet : nothing to do
const [, , options] = args;

/* While it's Large or Medium with 10+ HP (after the damage) */
if(!["lg", "med"].includes(actor.system.traits.size) || (actor.system.attributes.hp.value < 10)) return;

/* It becomes Bloodied, or is subjected to Lightning or Slashing damage : one split, even if both */
const hitBy = damageTypes(options).some(type => TYPES.includes(type));
if(!hitBy && !becameBloodied(actor, options)) return;

/* Its Reaction : the Split card for everyone (the Action Tracker spends the Reaction; Rule Limits on Block stops it) */
if(!await item.roll()) return;

for(const copy of await token.split())
  await copy.actor.items.getName("Pseudopod")?.setDamage(DAMAGE[copy.actor.system.traits.size]);
