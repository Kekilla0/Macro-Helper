/**
 * Bullywug Warrior : Leap
 *   "The bullywug can jump up to 30 feet by spending 10 feet of movement."  (Bonus Action)
 *
 * Setup : Item Macro on Leap, mode "Macro only".
 * Uses  : token.leap(feet, { item }) : pick the space (Esc : nothing used), use the item, jump there;
 *         token.useMovement(-10) : the 10 feet it costs
 */

if(!await token.leap(30, { item })) return;
await token.useMovement(-10);
