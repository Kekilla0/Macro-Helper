/**
 * Darkmantle : Crush
 *   "Melee Attack Roll: +5, reach 5 ft. Hit: 6 (1d6 + 3) Bludgeoning damage, and the darkmantle attaches to the target.
 *    If the target is a Medium or smaller creature and the darkmantle had Advantage on the attack roll, it covers the
 *    target, which has the Blinded condition and is suffocating while the darkmantle is attached in this way. While
 *    attached to a target, the darkmantle can attack only the target but has Advantage on its attack rolls. Its Speed
 *    becomes 0, it can't benefit from any bonus to its Speed, and it moves with the target. A creature can take an
 *    action to try to detach the darkmantle from itself, doing so with a successful DC 13 Strength (Athletics) check.
 *    On its turn, the darkmantle can detach itself by using 5 feet of movement."
 *
 * Setup : Item Macro on Crush, mode "Macro only".
 * Uses  : token.attachedTo(), item.roll({ targets, advantage }), card.hadAdvantage, target.isSmaller, attach (again :
 *         the attach replaced, now with Blinded)
 *         (the target's Detach button : its Action, Athletics DC 13; the darkmantle's : 5 ft of its movement)
 */

// Attached : it can attack only that creature, with Advantage
const held = token.attachedTo();
const card = await item.roll(held ? { targets : [held], advantage : true } : {});
if(!card) return;

card.remove("blinded");                                    // the item's own Blinded would land on any hit
// A hit with Advantage (from anything) on a Medium or smaller creature covers it : Blinded, suffocating
const covers = target => card.hadAdvantage && target.isSmaller("medium");
// Not attached yet : a hit attaches (covering it too, as above)
if(!held) card.append(attach({ when : ["hit", target => !covers(target)], escape : 13 }));
card.append(attach({ when : ["hit", covers], escape : 13, with : ["blinded"] }));
