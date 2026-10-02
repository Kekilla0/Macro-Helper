/**
 * Relentless Endurance : when reduced to 0 hit points but not killed outright, drop to 1 hit point instead (once a day).
 * Lives on the feature itself, so it only listens while that creature has a token on the scene.
 *
 * Setup : Item Macro on the Relentless Endurance feature (as a GM). In the editor open "Run on Hooks" :
 *           Hooks        : Damage about to apply (dnd5e.preApplyDamage)
 *           Run For      : Owner, where it happens   (the hook only fires for whoever applies the damage)
 *           Only About This Creature : on
 *         Works when damage goes through dnd5e (chat card APPLY, token HP bar); typing a new HP into the sheet skips it.
 * Uses  : item.hasUses(), actor.preventDropToZero(), item.spendUses()
 *
 * preventDropToZero changes dnd5e's pending HP update, so it must happen before any await.
 * "Not killed outright" : massive damage (what's left after 0 HP is at least its HP max) still kills.
 * Set massiveDamage : false to ignore that rule.
 */

if(hook !== "dnd5e.preApplyDamage") return;
const [, amount, updates] = args;
if(!(amount > 0) || !item.hasUses()) return;
if(!actor.preventDropToZero(amount, updates, { hp : 1, massiveDamage : true })) return;

await item.spendUses(1, { warn : false });
ChatMessage.create({
  speaker : ChatMessage.getSpeaker({ actor }),
  content : `<p><strong>${actor.name}</strong> refuses to fall : <em>${item.name}</em> leaves it on 1 HP.</p>`,
});
