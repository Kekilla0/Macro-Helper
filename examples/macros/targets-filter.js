/**
 * "Undead only" : a feature that only affects some creatures (Turn Undead, a Harpy's song for Humanoids and Giants).
 * The limit is in the text, not dnd5e's data, so this drops everyone else from the targets before the card is made
 * (the area or the pick still happens as usual).
 *
 * Setup : Item Macro on the feature, saved by a GM. In the editor open "Run on Hooks" :
 *           Hooks : "Targets picked" (macro-helper.targets)
 *           Run For : Owner, where it happens        Only About This Creature : on
 * Uses  : the macro-helper.targets hook (args : the activity, the tokens; remove tokens to drop them, before any await),
 *         target.isType()
 */

const [activity, tokens] = args;
if(activity?.item?.id !== item.id) return;           // another of the creature's items

for(let i = tokens.length - 1; i >= 0; i--){
  if(!tokens[i].isType("undead")) tokens.splice(i, 1);
}
