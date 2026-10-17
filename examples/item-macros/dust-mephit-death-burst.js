/**
 * Dust Mephit : Death Burst
 *   "The mephit explodes when it dies. Dexterity Saving Throw: DC 10, each creature in a 5-foot Emanation originating
 *    from the mephit. Failure: 5 (2d4) Bludgeoning damage. Success: Half damage."
 *
 * Setup : Item Macro on Death Burst, Run on Hooks : "Drops to 0 HP", Run For : Active GM (once).
 * Uses  : item.roll()  (its emanation around it, the save card)
 */

if(hook === "macro-helper.zeroHP") await item.roll();
