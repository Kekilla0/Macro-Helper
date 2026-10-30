/**
 * Fire Aura : at the end of each of its turns, the creature's aura damages everyone within 5 ft of it (the item's own
 * damage, on its card), unless it's Incapacitated.
 *
 * A passive feature : the item macro runs on a hook, only while the creature is on the scene.
 *
 * Setup : Item Macro on the feature (a Damage activity), saved by a GM, When Used "Macro only". In the editor open
 *         "Run on Hooks" :
 *           Hooks : "Its turn ends" (macro-helper.turnEnd)
 *           Run For : Active GM (once)        Only About This Creature : on
 * Uses  : hook (which hook ran it, null when used from the sheet), token.getTokensWithin(), item.roll({ targets })
 */

if(hook !== "macro-helper.turnEnd") return;          // used from the sheet : nothing
if(actor.statuses.has("incapacitated")) return;

const around = token.getTokensWithin(5);
if(around.length) await item.roll({ targets : around });
