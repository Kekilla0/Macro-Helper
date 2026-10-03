/**
 * A Multiattack weapon on its own : Orc Warrior Hand Axe, two attacks, and the same target can be picked more than once
 * (both axes at one foe, or one each). Only want one attack (an opportunity attack) ? Pick once and press Enter.
 *
 * Setup : Item Macro on the weapon (Hand Axe), mode "Macro only". Set COUNT to its Multiattack's number.
 * Uses  : item.pickAndAttack({ repeat : true })
 */

const COUNT = 2;

return item.pickAndAttack({
  count : COUNT,
  repeat : true,          // the same target can take more than one attack
  confirm : "auto",       // done after the last pick (Enter to stop early)
  event : scope.event,    // advantage / disadvantage keys
});
