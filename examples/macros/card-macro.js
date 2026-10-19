/**
 * Thunder Maul (a homebrew weapon) : on a hit, the target is knocked Prone or pushed 10 ft (one or the other), and
 * a Large or smaller target takes 1d6 thunder damage more.
 *
 * A card macro : the item's normal use rolls its card, the macro only adds what's different.
 *
 * Setup : Item Macro on the weapon, mode "Macro only".
 * Uses  : item.roll() -> card, card.append(), card.remove(), applyCondition(), push(), extraDamage(),
 *         `when` (the result, plus a check per target), `choice` (one part or the other), target.isSmaller()
 */

const card = await item.roll();          // the normal use : targets, attack, damage, its card
if(!card) return;                        // the pick was closed : nothing rolled

const small = target => target.isSmaller("large");

card.remove("prone");                    // the item's own Prone, if it has one : replaced below
card.append(extraDamage("1d6", { type : "thunder", when : ["hit", small] }));
card.append(applyCondition({ type : "prone", when : "hit", choice : "knock" }));
card.append(push(10, { when : "hit", choice : "knock" }));
