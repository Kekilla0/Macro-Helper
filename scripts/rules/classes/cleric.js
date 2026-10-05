import { module } from '../../module.js';
import { idOf } from '../../helpers/utils.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { tokenOf, getTokensWithin } from '../../helpers/tokens.js';
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
  static INCAPACITATED = ["incapacitated", "unconscious", "paralyzed", "petrified", "stunned", "dead"];

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.applyDamage", (actor, amount) => this.onDamaged(actor, amount));
    Hooks.on("createActiveEffect", effect => this.onClericDown(effect));
    Hooks.on("updateActiveEffect", effect => this.onClericDown(effect));
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
    if(!this.enabled() || (idOf(activity?.item) !== this.TURN_UNDEAD)) return null;
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
    if(!this.enabled() || (idOf(activity?.item) !== this.TURN_UNDEAD) || !canvas.ready) return;
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
    const origin = effect?.origin ? fromUuidSync(effect.origin, { strict : false }) : null;
    return (origin?.documentName === "Item") && (idOf(origin) === this.TURN_UNDEAD);
  }

  /* Taking damage ends it */
  static async onDamaged(actor, amount){
    if(!this.enabled() || !(amount > 0) || !actor?.isOwner) return;
    const turned = actor.effects.filter(e => this.isTurned(e));
    if(!turned.length) return;
    await actor.deleteEmbeddedDocuments("ActiveEffect", turned.map(e => e.id)).catch(error => log.debug("Already gone", error));
    log.debug("Turned ends (damage)", actor.name);
  }

  static #busy = Promise.resolve();

  /* The Cleric Incapacitated or dead : every creature it turned stops being Turned (the active GM). Several status
     changes arrive together (Unconscious brings Incapacitated) : one at a time, and only what's still there */
  static onClericDown(effect){
    const run = this.#busy.then(() => this.#clericDown(effect));
    this.#busy = run.catch(() => {});
    return run;
  }

  static async #clericDown(effect){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    const actor = (effect?.parent?.documentName === "Actor") ? effect.parent : null;
    if(!actor || !this.INCAPACITATED.some(s => actor.statuses?.has(s))) return;
    const mine = item => item?.actor && ((item.actor.uuid === actor.uuid) || (item.actor.id === actor.id));
    const sources = [...game.actors, ...(canvas.tokens?.placeables ?? []).filter(t => t.actor && !t.document.actorLink).map(t => t.actor)];
    for(const other of new Set(sources)){
      const turned = other.effects.filter(e => this.isTurned(e) && mine(fromUuidSync(e.origin, { strict : false })));
      const ids = turned.map(e => e.id).filter(id => other.effects.has(id));
      if(ids.length) await other.deleteEmbeddedDocuments("ActiveEffect", ids).catch(error => log.debug("Already gone", error));
    }
  }
}
