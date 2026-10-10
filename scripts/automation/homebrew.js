import { module } from '../module.js';
import { rollModes } from './roll-modes.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { tokenOf } from '../helpers/tokens.js';
import { getFlanker } from '../helpers/targets.js';
import { giveMode } from '../roll-item/reasons.js';
import { conditions } from './conditions.js';
import { initiative } from './initiative.js';
import { gm } from '../gm.js';
const log = logger.for(import.meta.url);

/**
 * Homebrew rules (the Homebrew settings sub-menu, all off by default) :
 *   Flanking               : melee attacks against a creature with an ally on its opposite side get advantage or +2.
 *   Initiative Each Round  : at the start of every new round, everyone rolls again and the round starts from the top.
 *   Push Into Obstacles    : part of pushing itself (masteries.pushCollision), used by Push, Shove and Tavern Brawler.
 */
export class homebrew{
  static register(){
    if(game.system.id !== "dnd5e") return;
    rollModes.add("flanking", config => this.onPreRollAttack(config));
    Hooks.on("updateCombat", (combat, changes, options) => this.onUpdateCombat(combat, changes, options));
  }

  static onPreRollAttack(config){
    const roll = config.rolls?.[0];
    if(!config.subject?.actor || !roll) return;
    roll.options ??= {};
    const flanking = settings.value("homebrewFlanking");
    if(flanking && (flanking !== "off")) this.applyFlanking(config, roll, flanking);
  }

  /* A new round going forward (not back with "previous round") : everyone rolls again, done by the active GM */
  static async onUpdateCombat(combat, changes = {}, options = {}){
    if(!game.users.activeGM?.isSelf || !settings.value("homebrewInitiative")) return;
    const round = Number(changes.round) || 0;
    if((round <= 1) || (Number(options.direction ?? 1) <= 0)) return;
    await initiative.roll(combat, combat.combatants.map(c => c.id), "round");
    /* Now the first turn of the round is known : its "until the start of your next turn" effects end */
    await gm.expireStart(combat);
  }

  /* ---------- Flanking ---------- */

  static applyFlanking(config, roll, mode){
    const activity = config.subject;
    const melee = String(activity.getActionType?.(config.attackMode) ?? "").startsWith("m");
    if(!melee) return;
    const attacker = tokenOf(activity.actor), target = conditions.targetOf(config);
    if(!attacker || !target) return;
    const flanker = getFlanker(attacker, target);
    if(!flanker) return;

    if(mode === "advantage") giveMode(roll, "advantage", module.format("reasons.flanking", { name : flanker.name }));
    else if(mode === "bonus"){
      roll.parts = [...(roll.parts ?? []), "@flanking"];
      roll.data = { ...(roll.data ?? {}), flanking : 2 };
    }
    log.debug("Flanking", attacker.name, "with", flanker.name, "against", target.name, mode);
  }
}
