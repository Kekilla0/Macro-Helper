/**
 * Ettercap : Web Strand  (Recharge 5–6)
 *   "Dexterity Saving Throw: DC 12, one Large or smaller creature the ettercap can see within 30 feet. Failure: The
 *    target has the Restrained condition until the web is destroyed (AC 10; HP 5; Vulnerability to Fire damage;
 *    Immunity to Bludgeoning, Poison, and Psychic damage)."
 *
 * Setup : Item Macro on Web Strand, mode "Macro only".
 * Uses  : item.roll(), applyCondition (until : web(...) : a Web token on the target's space; 0 HP, it's free)
 */

const card = await item.roll();
if(!card) return;

card.remove("restrained");
card.append(applyCondition({ when : ["fail", target => target.isSmaller("large")], type : "restrained",
  until : web({ ac : 10, hp : 5, vulnerable : ["fire"], immune : ["bludgeoning", "poison", "psychic"] }) }));
