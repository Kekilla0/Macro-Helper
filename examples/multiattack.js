/**
 * Multiattack in one click : reads the feature's text and makes each weapon's attacks in turn.
 *   Orc Warrior  "two attacks with its hand axes"                  -> pick 2 for the Hand Axe
 *   Dragon       "one with its bite and two with its claws"        -> pick 1 for the Bite, then 2 for the Claws
 *   Scout        "two attacks, using Shortsword or Longbow"        -> asks how many with each, then picks for each
 * Each weapon gets its own pick on the map and its own card. A target can take more than one of a weapon's attacks
 * (click it again) but doesn't have to : set repeat to false to make every pick a different target.
 * Fewer picks than attacks is fine (Enter), Esc skips that weapon and carries on with the next.
 *
 * Setup : Item Macro on the Multiattack feature, mode "Macro only".
 * Uses  : item.multiattack() (MacroHelper.multiattack), which reads item.getMultiattackPlan() and runs pickAndAttack per weapon
 */

return item.multiattack({
  repeat : true,          // a target can be picked more than once for the same weapon
  event : scope.event,    // advantage / disadvantage keys
  // attack : { long : false, strict : true },  // more pickAndAttack options for every weapon
});
