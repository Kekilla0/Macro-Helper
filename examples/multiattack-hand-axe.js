/**
 * Multiattack weapon : Orc Warrior Hand Axe. As many attacks as its Multiattack gives it ("makes two attacks with its
 * hand axes" -> 2), and the same target can be picked more than once : both axes at one foe, or one each.
 *
 * Setup : Item Macro on the weapon (Hand Axe), mode "Macro only".
 * Flow  : your targets are cleared -> click a target (click it again for the second attack there, right click takes
 *         a pick away) -> after the last pick, one Roll Item card with an attack, damage and APPLY per attack.
 *         Only want one attack (an opportunity attack) ? Pick once and press Enter.
 *
 * Uses  : item.getMultiattack() reads the Multiattack feature (1 if the creature has none),
 *         item.pickAndAttack({ repeat : true }) lets a target be picked more than once
 */

return item.pickAndAttack({
  count : item.getMultiattack(),   // or a number, e.g. 2
  repeat : true,                   // the same target can take more than one attack
  confirm : "auto",                // done after the last pick (Enter to stop early)
  event : scope.event,             // advantage / disadvantage keys
});
