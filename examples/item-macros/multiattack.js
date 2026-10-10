/**
 * Multiattack in one click : the attacks written out below, made weapon by weapon. Each weapon gets its own pick on
 * the map and its own card. A target can take more than one of a weapon's attacks (click it again) but doesn't have to.
 * Fewer picks than attacks is fine (Enter), Esc skips that weapon and carries on with the next.
 *
 *   Orc Warrior : [{ weapon : "Hand Axe", count : 2 }]
 *   Dragon      : [{ weapon : "Bite", count : 1 }, { weapon : "Claw", count : 2 }]
 *   Scout       : [{ weapon : ["Shortsword", "Longbow"], count : 2 }]   asks how to split the 2
 *
 * Setup : Item Macro on the Multiattack feature, mode "Macro only". Write the creature's PLAN.
 * Uses  : actor.multiattack(plan) (MacroHelper.multiattack), pickAndAttack per weapon
 */

const PLAN = [
  { weapon : "Hand Axe", count : 2 },
];

return actor.multiattack(PLAN, {
  repeat : true,          // a target can be picked more than once for the same weapon
  event : scope.event,    // advantage / disadvantage keys
});
