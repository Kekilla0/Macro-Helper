/**
 * Animated Rug of Smothering : Smother
 *   "If the target is a Medium or smaller creature, the rug can give it the Grappled condition (escape DC 13) instead
 *    of dealing damage. Until the grapple ends, the target has the Blinded and Restrained conditions, is suffocating,
 *    and takes 10 (2d6 + 3) Bludgeoning damage at the start of each of its turns. The rug can smother only one
 *    creature at a time. While grappling the target, the rug can't take this action, the rug halves the damage it
 *    takes (round down), and the target takes the same amount of damage."
 *
 * Setup : Item Macro on Smother, mode "Macro only", also Run on Hooks : "Damage about to apply".
 * Uses  : item.roll(), applyCondition (with, escape, repeat, insteadOfDamage, self), token.grappling(), shareDamage, ruleLimit
 */

// Damage about to apply to the rug : while it smothers someone, it takes half, and that creature the same
if(hook === "dnd5e.preApplyDamage"){
  const [held] = token.grappling();
  if(held) shareDamage(args, held, 0.5);
  return;
}

// One creature at a time, and not while grappling
if(token.grappling().length && !ruleLimit("The rug can smother only one creature at a time.")) return;

const card = await item.roll({ activity : 0 });
if(!card) return;

card.remove("grappled");                         // the item's own combined effect : replaced below
card.append(applyCondition({
  when : ["hit", target => target.isSmaller("medium")],
  type : "grappled", with : ["blinded", "restrained"], escape : 13,
  repeat : { at : "start", damage : "2d6 + 3", type : "bludgeoning" },
  insteadOfDamage : true,                        // the grapple or the damage, not both
  self : "Smothering",                           // the rug's own effect, ending with the grapple
}));
