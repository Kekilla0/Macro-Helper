/**
 * Harpy's Luring Song : only Humanoids and Giants that can hear the song are affected. That limit is in the text, not
 * dnd5e's data, so this drops everyone else from the targets before the card is made (the area or pick still happens).
 * The same pattern works for "Undead only", "creatures that can see you"...
 *
 * Setup : Item Macro on the Harpy's Luring Song, saved by a GM. In the editor open "Run on Hooks" :
 *           Hooks : "Targets picked" (macro-helper.targets)
 *           Run For : Owner, where it happens        Only About This Creature : on
 * Uses  : the "macro-helper.targets" stage hook : remove tokens from the list to drop them (before any await)
 */

const TYPES = ["humanoid", "giant"];

const [activity, tokens] = args;
if(activity?.item?.id !== item.id) return;

for(let i = tokens.length - 1; i >= 0; i--){
  const actor = tokens[i].actor;
  const type = actor?.system?.details?.type?.value;
  const canHear = !actor?.statuses?.has("deafened");
  if(!TYPES.includes(type) || !canHear) tokens.splice(i, 1);
}
