/**
 * Bugbear Warrior : Light Hammer
 *   "Melee or Ranged Attack Roll: +4 (with Advantage if the target is Grappled by the bugbear), reach 10 ft. or range
 *    20/60 ft. Hit: 9 (3d4 + 2) Bludgeoning damage."
 *
 * Setup : Item Macro on Light Hammer, mode "Macro only".
 * Uses  : item.roll({ advantage }), token.grappling()
 */

await item.roll({ advantage : target => token.grappling().includes(target) });
