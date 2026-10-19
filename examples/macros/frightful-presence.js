/**
 * Frightful Presence : each enemy within 30 ft makes a DC 13 Wisdom save or is Frightened for 1 minute, saving again
 * at the end of each of its turns.
 *
 * Conditions straight on creatures, no card : each save is rolled, and a failure gives the condition at once.
 *
 * Setup : Item Macro on the feature, mode "Macro only". Its activity is a Utility (the Action, any recharge).
 *         Run it as the GM : only a creature's owner or the GM can roll its save.
 * Uses  : item.useActivity(), token.getTokensWithin(), target.applyCondition(type, { save, dc, duration, repeat, from, by })
 */

if(!await item.useActivity()) return;

for(const target of token.getTokensWithin(30, { disposition : "enemy" })){
  await target.applyCondition("frightened", {
    save : "wis", dc : 13,      // a success and it doesn't get it
    duration : 10,              // rounds
    repeat : "end",             // saves again at the end of each of its turns, ending it on a success
    from : item, by : token,
  });
}
