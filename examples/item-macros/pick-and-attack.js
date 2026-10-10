/**
 * Pick and attack : click your targets on the map, then attack each of them with this item (one attack roll per target).
 *
 * Setup : Item Macro on a weapon / attack spell, mode "Macro only". Change the options below for the item.
 * Flow  : your targets are cleared -> the range and the candidates are shown on the map -> you click targets
 *         (Enter confirms, Esc cancels) -> one Roll Item card with an attack, damage and APPLY per target.
 *
 * What gets used up, by dnd5e's own attack roll :
 *   Longsword (nothing)            -> nothing
 *   Dagger / Javelin (Thrown)      -> targets beyond reach are thrown at, each throw uses one (not with Returning)
 *   Longbow (Ammunition)           -> one piece of its ammunition per attack, if the actor carries any for it
 * Nobody attacks with what they don't have (quantity 0, not enough to throw / shoot), unless strict is false.
 *
 * Uses  : item.pickAndAttack()  (MacroHelper.pickAndAttack), which checks the item, attacker, range and ammunition itself
 */

return item.pickAndAttack({
  count : 1,               // most targets (2+ for sweeping / multi-target attacks)
  disposition : "enemy",   // who can be picked : "enemy" | "ally" | "any"
  within : Infinity,       // feet the targets must be within of each other (Infinity = no rule)
  long : true,             // ranged / thrown : allow targets out to long range (attacked with disadvantage)
  confirm : "auto",        // "auto" = finish as soon as the most allowed are picked, "enter" = always wait for Enter
  clearTargets : true,     // start from no targets each time (false = use your targets in range as they are)
  strict : true,           // nobody attacks with what they don't have (quantity 0, not enough to throw / shoot)
  threatened : true,       // ranged / thrown attacks with an enemy within 5 ft have disadvantage (melee doesn't)
  event : scope.event,     // advantage / disadvantage keys
});
