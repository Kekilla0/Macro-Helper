/**
 * Blink Dog : Teleport
 *   "Teleport (Recharge 4–6). The dog teleports up to 40 feet to an unoccupied space it can see."  (Bonus Action)
 *
 * Setup : Item Macro on Teleport, mode "Macro only".
 * Uses  : token.teleport(feet, { item }) : pick the space (Esc : nothing used), use the item, then teleport there
 */

await token.teleport(40, { item });
