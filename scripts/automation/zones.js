import { module } from '../module.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { idOf } from '../helpers/utils.js';
const log = logger.for(import.meta.url);

/**
 * The zone lego : an area that acts on whoever comes into it or spends a turn in it (Cloud of Daggers, Moonbeam,
 * Grease; a monster's "a creature that starts its turn in the pool takes 2d6 acid"; a homebrew trap). Its item's own
 * activity is used at that one creature, as it was cast (the slot level, the DC), with nothing spent : its card is the
 * usual card (the save, the damage, Apply).
 *
 *   zone(match, { enter, start, end, firstOnTurn, oncePerTurn, filter, enabled })
 *     match         an item identifier, or item => boolean
 *     enter         a creature moving into the area (walking through it counts)
 *     start / end   a creature starting / ending its turn in it (combat)
 *                   each : true (the item's save activity, else its damage one), an activity id, name or type, or
 *                   item => Activity
 *     firstOnTurn   entering counts once a turn (Web, Sleet Storm, Insect Plague)
 *     oncePerTurn   one of them a turn, whichever comes first (Cloud of Daggers, Moonbeam : "only once per turn")
 *     filter        (token, item) => boolean : who it acts on (default : every creature)
 *
 * The item's lasting area (a dnd5e area left on the map : Concentration, a duration) gets a Region Behavior, "Zone"
 * (macro-helper.zone), from the active GM; it goes with the area. A GM can also add that behavior to any Region by
 * hand : the item's uuid, the cast level, and the activity id for each moment. The active GM's client uses the
 * activity (whoever moved the token).
 */
const rules = new Map();
let queue = Promise.resolve();

export function zone(match, { enter = null, start = null, end = null, firstOnTurn = false, oncePerTurn = false, filter = null, enabled = null } = {}){
  if(!match || !(enter || start || end)) return;
  rules.set(match, { match, enter, start, end, firstOnTurn : !!firstOnTurn, oncePerTurn : !!oncePerTurn, filter, enabled });
}

/* The item's rule (switched off : none; { any : true } : switched off too) */
export function zoneRuleOf(item, { any = false } = {}){
  if(!item) return null;
  return [...rules.values()].find(rule => (any || !rule.enabled || rule.enabled()) && ((typeof rule.match === "function") ? rule.match(item) : (idOf(item) === rule.match))) ?? null;
}

/* The activity for one moment : true (save, else damage), an id / name / type, or a function of the item */
function pickActivity(item, how){
  if(!how || !item) return null;
  const list = [...(item.system?.activities ?? [])];
  if(typeof how === "function") return how(item) ?? null;
  if(how === true) return list.find(a => a.type === "save") ?? list.find(a => a.type === "damage") ?? null;
  return list.find(a => (a.id === how) || (a.name === how)) ?? list.find(a => a.type === how) ?? null;
}

export const zones = {
  TYPE : `${module.id}.zone`,

  register(){
    CONFIG.RegionBehavior.dataModels[this.TYPE] = ZoneBehavior;
    (CONFIG.RegionBehavior.typeIcons ??= {})[this.TYPE] = "fa-solid fa-burst";
    Hooks.on("createRegion", (region, options, userId) => this.onArea(region));
  },

  /* A lasting area of an item with a zone rule : its behavior (the active GM) */
  async onArea(region){
    if(!game.users.activeGM?.isSelf || region.behaviors.some(b => b.type === this.TYPE)) return;
    const item = fromUuidSync(region.getFlag("dnd5e", "item") ?? "", { strict : false });
    const rule = zoneRuleOf(item);
    if(!rule) return;
    const ids = Object.fromEntries(["enter", "start", "end"].map(k => [k, pickActivity(item, rule[k])?.id ?? ""]));
    const activity = fromUuidSync(region.getFlag("dnd5e", "activity") ?? "", { strict : false });
    const level = Number(region.getFlag("dnd5e", "spellLevel")) || Number(activity?.item?.system?.level) || Number(item.system?.level) || 0;
    await region.createEmbeddedDocuments("RegionBehavior", [{ type : this.TYPE, name : module.i18n("zones.name"),
      system : { item : item.uuid, level, ...ids, firstOnTurn : rule.firstOnTurn, oncePerTurn : rule.oncePerTurn } }]).catch(error => log.error(error));
  },

  /* The turn, as a key : the event's (a turn's end comes once the next has begun), else the current one; out of
     combat none (every time counts) */
  turnKey({ combat = game.combat, round, turn } = {}){
    if(!combat?.started) return null;
    return `${combat.id}.${round ?? combat.round}.${turn ?? combat.turn}`;
  },

  /* One moment of one zone for one creature : counted, then its activity used at the creature */
  async fire(behavior, token, moment, data = {}){
    const system = behavior.system;
    const item = fromUuidSync(system.item ?? "", { strict : false });
    const activity = item?.system?.activities?.get?.(system[moment]);
    if(!activity || !token?.actor || behavior.disabled) return;
    /* Its rule switched off since (a behavior added by hand has none : it always acts) */
    const rule = zoneRuleOf(item, { any : true });
    if(rule && ((rule.enabled && !rule.enabled()) || (rule.filter?.(token, item) === false))) return;
    const key = this.turnKey(data);
    if(key){
      const seen = behavior.getFlag(module.id, "seen")?.[token.id] ?? {};
      if((system.oncePerTurn && (seen.any === key)) || ((moment === "enter") && system.firstOnTurn && (seen.enter === key))) return;
      await behavior.setFlag(module.id, `seen.${token.id}`, { any : key, enter : (moment === "enter") ? key : (seen.enter ?? null) });
    }
    log.debug("Zone", item.name, moment, token.name);
    const level = Number(system.level) || 0;
    const usage = {
      consume : { spellSlot : false, resources : false }, concentration : { begin : false }, create : { measuredTemplate : false },
      [module.id] : { noCast : true, economy : "free", skipPick : true, targetUuids : [token.uuid],
        note : module.format(`zones.${moment}`, { name : token.name, zone : item.name }) },
    };
    if((item.type === "spell") && (level > 0)) usage.spell = { slot : `spell${Math.max(level, Number(item.system.level) || 1)}` };
    const results = await activity.use(usage, { configure : false });
    if(results) await uses.cardOf(results).catch(() => null);
    return results;
  },

  /* One at a time : a use is made, card and all, before the next starts */
  queue(behavior, token, moment, data){
    queue = queue.then(() => this.fire(behavior, token, moment, data)).catch(error => log.error(error));
    return queue;
  },
};

/**
 * The Zone Region Behavior : which item, the level it was cast at, the activity for each moment, and the once-a-turn
 * limits. Its events are handled on the active GM's client.
 */
class ZoneBehavior extends foundry.data.regionBehaviors.RegionBehaviorType {
  static defineSchema(){
    const { StringField, NumberField, BooleanField } = foundry.data.fields;
    return {
      item : new StringField({ required : true, blank : true, initial : "", label : "zones.fields.item" }),
      level : new NumberField({ required : true, integer : true, min : 0, initial : 0, label : "zones.fields.level" }),
      enter : new StringField({ required : true, blank : true, initial : "", label : "zones.fields.enter" }),
      start : new StringField({ required : true, blank : true, initial : "", label : "zones.fields.start" }),
      end : new StringField({ required : true, blank : true, initial : "", label : "zones.fields.end" }),
      firstOnTurn : new BooleanField({ initial : false, label : "zones.fields.firstOnTurn" }),
      oncePerTurn : new BooleanField({ initial : false, label : "zones.fields.oncePerTurn" }),
    };
  }

  static async #onEnter(event){
    /* Moved in (walking through counts : core splits the move at the edge); appearing round it or the area coming
       onto it is the cast's own card, or the area's move */
    if(!game.users.activeGM?.isSelf || !this.enter || !event.data?.movement) return;
    zones.queue(this.behavior, event.data.token, "enter", event.data);
  }

  static async #onTurnStart(event){
    if(!game.users.activeGM?.isSelf || !this.start) return;
    zones.queue(this.behavior, event.data.token, "start", event.data);
  }

  static async #onTurnEnd(event){
    if(!game.users.activeGM?.isSelf || !this.end) return;
    zones.queue(this.behavior, event.data.token, "end", event.data);
  }

  static events = {
    [CONST.REGION_EVENTS.TOKEN_ENTER] : this.#onEnter,
    [CONST.REGION_EVENTS.TOKEN_TURN_START] : this.#onTurnStart,
    [CONST.REGION_EVENTS.TOKEN_TURN_END] : this.#onTurnEnd,
  };
}
