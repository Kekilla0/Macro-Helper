import { module } from '../../module.js';
import { idOf, originItem } from '../../helpers/utils.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { emanation } from '../emanation.js';
import { itemFixes } from '../item-fixes.js';
import { conditions } from '../conditions.js';
const log = logger.for(import.meta.url);

/**
 * Cleric, levels 1-2 (Class Rules setting). Divine Order (Thaumaturge's Arcana / Religion bonus), Channel Divinity's
 * uses and Divine Spark are the items' own data; Divine Spark's necrotic or radiant is chosen when it's rolled (Roll
 * Item asks when a damage part offers several types).
 *
 *   Turn Undead : the emanation lego : no placement and no pick : a 30 ft circle appears round the Cleric (removed at
 *                 the end of the turn) and every Undead within it (not on the Cleric's side) is targeted,
 *                 and makes the save on its row. The GM applies Turned to those that fail (the rows' Apply effect).
 *                 Turned ends early when the creature takes damage, or when the Cleric is Incapacitated or dies.
 */
export class cleric{
  static TURN_UNDEAD = "turn-undead";
  /* dnd5e's own : Turn Undead is an activity on Channel Divinity (beside Divine Spark), not an item */
  static CHANNEL = "channel-divinity-cleric";

  /* The Cleric's Channel Divinity : dnd5e's identifier, or Plutonium's plain "channel-divinity" on a Cleric */
  static isChannel(item){
    const id = idOf(item);
    return (id === this.CHANNEL) || ((id === "channel-divinity") && !!item?.actor?.classes?.cleric);
  }

  static enabled = settings.on("classRules");

  static register(){
    if(game.system.id !== "dnd5e") return;
    /* Turned ends when it takes damage, or the Cleric is Incapacitated */
    conditions.endsWhen(effect => this.enabled() && this.isTurned(effect), { damaged : true, sourceDown : true });
    /* Turn Undead : every Undead within 30 ft not on the Cleric's side, no pick; its circle shown round the Cleric */
    emanation("turnUndead", { enabled : () => this.enabled(), applies : activity => this.isTurnUndead(activity),
      filter : token => this.isUndead(token.actor) });
    /* Plutonium's Thaumaturge adds WIS to Arcana / Religion with keys dnd5e 6 no longer reads */
    itemFixes.add({ name : "Divine Order: Thaumaturge", where : "owned", plan : item => this.thaumaturgeFix(item) });
  }


  /* The old skill check bonus keys (system.skills.arc.bonuses.check) as dnd5e 6 has them (system.skills.arc.roll.bonus) */
  static thaumaturgeFix(item){
    if(!["divine-order-thaumaturge", "thaumaturge"].includes(idOf(item)) || (String(item?.system?.source?.rules ?? "") === "2014")) return null;
    const updateEffects = [];
    for(const effect of item.effects ?? []){
      const changes = [...(effect.system?.changes ?? effect.changes ?? [])].map(c => ({ ...c }));
      let changed = false;
      for(const change of changes){
        const m = String(change.key).match(/^system\.skills\.(\w+)\.bonuses\.check$/);
        if(m){ change.key = `system.skills.${m[1]}.roll.bonus`; changed = true; }
      }
      if(changed) updateEffects.push({ _id : effect.id, ...((effect.system?.changes !== undefined) ? { "system.changes" : changes } : { changes }) });
    }
    return updateEffects.length ? { updateEffects } : null;
  }

  /* Turn Undead : an item of its own, or Channel Divinity's activity of that name */
  static isTurnUndead(activity){
    const id = idOf(activity?.item);
    return (id === this.TURN_UNDEAD) || (this.isChannel(activity?.item) && /turn undead/i.test(activity?.name ?? ""));
  }

  static isUndead(actor){
    const type = actor?.system?.details?.type;
    return [type?.value, type?.custom, type?.subtype].some(t => String(t ?? "").toLowerCase().includes("undead"));
  }

  /* Turned, from a Cleric's Turn Undead */
  static isTurned(effect){
    /* The item, or one of its activities (dnd5e's effect tray) */
    const origin = originItem(effect);
    if(!origin) return false;
    return (idOf(origin) === this.TURN_UNDEAD) || (this.isChannel(origin) && /turn/i.test(effect.name ?? ""));
  }
}
