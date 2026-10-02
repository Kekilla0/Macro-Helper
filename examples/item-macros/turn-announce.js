/**
 * Turn announcer : posts whose turn it is when the combat turn changes.
 *
 * Setup : Hook Macro (world macro, Script). Run on Hooks : "Turn changed" (combatTurnChange).
 *         Run For : Active GM (once).
 * Args  : [combat, previous, current]
 */

const [combat] = args;
const combatant = combat.combatant;
if(!combatant || combatant.defeated) return;

ChatMessage.create({
  speaker : { alias : "Combat" },
  content : `<p>Round ${combat.round} : it's <strong>${combatant.name}</strong>'s turn.</p>`,
  whisper : combatant.hidden ? game.users.filter(u => u.isGM).map(u => u.id) : [],
});
