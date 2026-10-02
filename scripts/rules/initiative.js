import { settings } from '../settings.js';
import { logger } from '../log.js';
const log = logger.for(import.meta.url);

/**
 * Auto-Roll Initiative, done by the active GM once the combat update has landed : when combat begins, everyone
 * without an initiative rolls, and the first turn goes to the top of the new order. Anyone added later rolls as they
 * join, and the current turn stays where it is. Rolled initiative goes through
 * dnd5e (its bonuses, Alert's card...). Homebrew's Initiative Each Round uses roll() too.
 */
export class initiative{
  static register(){
    Hooks.on("updateCombat", (combat, changes) => this.onUpdate(combat, changes));
    Hooks.on("createCombatant", combatant => this.onJoin(combatant));
  }

  static async onUpdate(combat, changes = {}){
    if(!game.users.activeGM?.isSelf || !("round" in changes)) return;
    const round = Number(changes.round) || 0;
    /* Combat began : round 0 to 1 */
    if((round !== 1) || !settings.value("autoInitiative")) return;
    const ids = combat.combatants.filter(c => c.initiative === null).map(c => c.id);
    if(ids.length) await this.roll(combat, ids, "begin");
  }

  /* Joining a combat already under way : roll now, keeping whoever's turn it is */
  static async onJoin(combatant){
    const combat = combatant?.combat ?? combatant?.parent;
    if(!game.users.activeGM?.isSelf || !combat?.started || !settings.value("autoInitiative") || (combatant.initiative !== null)) return;
    log.debug("Rolling initiative", "joined", combatant.name);
    await combat.rollInitiative([combatant.id], { updateTurn : true });
  }

  /* Roll, then start from the top of the new order */
  static async roll(combat, ids, why){
    log.debug("Rolling initiative", why, ids.length);
    await combat.rollInitiative(ids, { updateTurn : false });
    await combat.update({ turn : 0 });
  }
}
