/**
 * Split (Ochre Jelly, Black Pudding)
 * Replaces the creature's token with two copies, each with half its current HP (rounded down),
 * half its token size and one dnd5e size category smaller, in the same space and at the same initiative.
 *
 * Setup : Item Macro on the creature's "Split" feature, mode "Macro only". Run by the GM.
 * Needs : an unlinked token (monsters from a compendium are, by default).
 * Uses  : token.split()  (MacroHelper.splitToken)
 */

return token.split();

/* Options, all optional :
return token.split({
  copies : 2,        // how many copies
  hp : 0.5,          // fraction of current HP each copy gets (also its max HP)
  scale : 0.5,       // token width / height multiplier
  stepSize : true,   // also one dnd5e size category smaller (Large -> Medium)
  chat : true,       // post a line to chat
});
*/
