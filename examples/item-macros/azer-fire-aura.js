/**
 * Azer Sentinel : Fire Aura
 *   "At the end of each of the azer's turns, each creature of the azer's choice in a 5-foot Emanation originating from
 *    the azer takes 5 (1d10) Fire damage unless the azer has the Incapacitated condition."
 *
 * Setup : Item Macro on Fire Aura, Run on Hooks : "Its turn ends", Run For : Active GM (once).
 *         One damage roll for everyone within 5 ft; the GM presses Apply for the creatures the azer chooses.
 * Uses  : the "Its turn ends" hook, item.roll({ targets }), token.getTokensWithin
 */

if(hook !== "macro-helper.turnEnd") return;            // nothing when used from the sheet
if(actor.statuses.has("incapacitated")) return;         // "unless the azer has the Incapacitated condition"

await item.roll({ targets : token.getTokensWithin(5) });
