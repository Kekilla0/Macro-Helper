import { module } from '../../module.js';
import { idOf, originItem } from '../../helpers/utils.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { tokenOf, getTokensWithin } from '../../helpers/tokens.js';
import { uses } from '../../uses.js';
import { rollItem } from '../../roll-item/roll-item.js';
import { itemFixes } from '../item-fixes.js';
import { conditions } from '../conditions.js';
const log = logger.for(import.meta.url);

/**
 * Cleric, levels 1-2 (Class Rules setting). Divine Order (Thaumaturge's Arcana / Religion bonus), Channel Divinity's
 * uses and Divine Spark are the items' own data; Divine Spark's necrotic or radiant is chosen when it's rolled (Roll
 * Item asks when a damage part offers several types).
 *
 *   Turn Undead : no placement and no pick : a 30 ft circle appears round the Cleric (removed at the end of the turn)
 *                 and every Undead within it (not on the Cleric's side) is targeted,
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

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    /* Turned ends when it takes damage, or the Cleric is Incapacitated */
    conditions.endsWhen(effect => this.enabled() && this.isTurned(effect), { damaged : true, sourceDown : true });
    /* Turn Undead : its targets set before the use (no pick), and its circle round the Cleric for everyone to see */
    uses.onActivity("presetTargets", (activity, ctx, next) => {
      const preset = this.presetTargets(activity);
      if(preset){
        rollItem.announceTargets(activity, preset, { keepEmpty : true });
        uses.mark(ctx, { skipPick : true });
      }
      return next();
    });
    Hooks.on("dnd5e.postUseActivity", activity => this.placeEmanation(activity));
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

  /**
   * Targets an activity sets itself, before dnd5e uses it (no placement, no pick), or null.
   * Turn Undead : every Undead within its range (30 ft) of the Cleric, not on its side.
   * @param {Activity} activity
   * @returns {Token[]|null}
   */
  static presetTargets(activity){
    if(!this.enabled() || !this.isTurnUndead(activity)) return null;
    const me = tokenOf(activity.actor);
    if(!me) return null;
    const feet = Number(activity.range?.value || activity.item?.system?.range?.value) || 30;
    return getTokensWithin(me, feet, { disposition : "nonAlly" }).filter(t => this.isUndead(t.actor));
  }

  /**
   * Turn Undead's reach shown on the map : a 30 ft circle round the Cleric's space, made when it's used (not placed
   * by anyone : it is where it is). Instantaneous, so Clear Instant Templates removes it at the end of the turn.
   */
  static async placeEmanation(activity){
    if(!this.enabled() || !this.isTurnUndead(activity) || !canvas.ready) return;
    const me = tokenOf(activity.actor);
    if(!me || (me.document.parent !== canvas.scene)) return;
    const feet = Number(activity.range?.value || activity.item?.system?.range?.value) || 30;
    const radius = (feet / canvas.scene.grid.distance) * canvas.grid.size + (Math.max(me.w, me.h) / 2);
    try {
      await canvas.scene.createEmbeddedDocuments("Region", [{
        name : activity.item.name, color : game.user.color?.css ?? "#ffd700",
        /* Seen by everyone on the map (a region otherwise only shows on the Regions layer) */
        visibility : CONST.REGION_VISIBILITY?.ALWAYS ?? 2,
        shapes : [{ type : "circle", x : me.center.x, y : me.center.y, radius }],
        flags : { dnd5e : { activity : activity.uuid, origin : me.document.uuid } },
      }]);
    } catch(error){
      log.error("Turn Undead's circle", error);
    }
  }

  /* Turned, from a Cleric's Turn Undead */
  static isTurned(effect){
    /* The item, or one of its activities (dnd5e's effect tray) */
    const origin = originItem(effect);
    if(!origin) return false;
    return (idOf(origin) === this.TURN_UNDEAD) || (this.isChannel(origin) && /turn/i.test(effect.name ?? ""));
  }
}
