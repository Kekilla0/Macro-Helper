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
 *   zone(match, { enter, start, end, move, per, firstOnTurn, oncePerTurn, terrain, effect, whileInside, filter, enabled })
 *     match         an item identifier, or item => boolean
 *     enter         a creature moving into the area (walking through it counts)
 *     start / end   a creature starting / ending its turn in it (combat)
 *     move          a creature moving into or within it : once for every `per` feet (default 5) it travels there, its
 *                   dice that many times (Spike Growth's 2d4 a 5 ft; a space stepped into counts, one stepped out of
 *                   doesn't; teleporting doesn't)
 *                   each : true (the item's save activity, else its damage one), an activity id, name or type, or
 *                   item => Activity
 *     firstOnTurn   entering counts once a turn (Web, Sleet Storm, Insect Plague)
 *     oncePerTurn   one of them a turn, whichever comes first (Cloud of Daggers, Moonbeam : "only once per turn")
 *     terrain       the area is Difficult Terrain (dnd5e's own Region Behavior; magical for a spell)
 *     effect        a creature has this while inside it, gone when it leaves (Silence's Deafened) : true (the item's
 *                   effects), an effect id or name, or item => effect(s) (dnd5e's "Apply Active Effect" behavior)
 *     whileInside   what the item's uses put on a creature ends when it leaves the area (Web's Restrained)
 *     cast          false : using the item only makes the area, nothing happens to the creatures already in it then
 *                   (Web, Spike Growth : no card)
 *     filter        (token, item) => boolean : who it acts on (default : every creature)
 *
 * The item's lasting area (a dnd5e area left on the map : Concentration, a duration) gets a Region Behavior, "Zone"
 * (macro-helper.zone), from the active GM; it goes with the area. A GM can also add that behavior to any Region by
 * hand : the item's uuid, the cast level, and the activity id for each moment. The active GM's client uses the
 * activity (whoever moved the token).
 */
const rules = new Map();
let queue = Promise.resolve();
/* A move's use : its dice that many times (the activity's uuid, while it's used) */
const times = new Map();

export function zone(match, { enter = null, start = null, end = null, move = null, per = 5, firstOnTurn = false, oncePerTurn = false,
  terrain = false, effect = null, whileInside = false, cast = true, filter = null, enabled = null } = {}){
  if(!match || !(enter || start || end || move || terrain || effect || whileInside)) return;
  rules.set(match, { match, enter, start, end, move, per : Number(per) || 5, firstOnTurn : !!firstOnTurn, oncePerTurn : !!oncePerTurn,
    terrain : !!terrain, effect, whileInside : !!whileInside, cast : cast !== false, filter, enabled });
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

/* The effects a creature has while inside : true (the item's own, not on its owner), an id / name, or a function */
function pickEffects(item, how){
  if(!how || !item) return [];
  const list = (item.effects?.contents ?? []).filter(e => !e.transfer);
  if(typeof how === "function") return [how(item) ?? []].flat().filter(Boolean);
  if(how === true) return list;
  return list.filter(e => (e.id === how) || (e.name === how));
}

/* "2d4 + 1" with its dice n times : "4d4 + 1" */
function timesDice(formula, n){
  return String(formula).replace(/(^|[^\w@.])(\d*)d(\d+)/g, (all, before, count, faces) => `${before}${(Number(count) || 1) * n}d${faces}`);
}

export const zones = {
  TYPE : `${module.id}.zone`,

  register(){
    CONFIG.RegionBehavior.dataModels[this.TYPE] = ZoneBehavior;
    (CONFIG.RegionBehavior.typeIcons ??= {})[this.TYPE] = "fa-solid fa-burst";
    Hooks.on("createRegion", (region, options, userId) => this.onArea(region));
    /* Only the area made (cast : false) : Roll Item makes no card for the use itself */
    Hooks.on(`${module.id}.preRollItem`, (activity, usage) => usage?.[module.id]?.noCast || (zoneRuleOf(activity?.item)?.cast !== false));
    /* and dnd5e rolls nothing after it (a damage activity's damage) */
    Hooks.on("dnd5e.preUseActivity", (activity, usage) => {
      if(!usage?.[module.id]?.noCast && (zoneRuleOf(activity?.item)?.cast === false)) usage.subsequentActions = false;
    });
    /* A move's use : its dice once for every `per` feet */
    Hooks.on("dnd5e.preRollDamageV2", config => {
      const n = times.get(config?.subject?.uuid);
      if(n > 1) for(const roll of config.rolls ?? []) roll.parts = (roll.parts ?? []).map(part => timesDice(part, n));
    });
  },

  /* A lasting area of an item with a zone rule : its behaviors (the active GM) : the Zone, and dnd5e's Difficult
     Terrain and Apply Active Effect when the rule says so (and the activity doesn't already make them) */
  async onArea(region){
    if(!game.users.activeGM?.isSelf || region.behaviors.some(b => b.type === this.TYPE)) return;
    const item = fromUuidSync(region.getFlag("dnd5e", "item") ?? "", { strict : false });
    const rule = zoneRuleOf(item);
    if(!rule) return;
    const activity = fromUuidSync(region.getFlag("dnd5e", "activity") ?? "", { strict : false });
    const own = new Set((activity?.applicableBehaviors ?? []).map(b => b.type));
    const level = Number(region.getFlag("dnd5e", "spellLevel")) || Number(activity?.item?.system?.level) || Number(item.system?.level) || 0;
    const ids = Object.fromEntries(["enter", "start", "end", "move"].map(k => [k, pickActivity(item, rule[k])?.id ?? ""]));
    const behaviors = [];
    if(ids.enter || ids.start || ids.end || ids.move || rule.whileInside) behaviors.push({ type : this.TYPE, name : module.i18n("zones.name"),
      system : { item : item.uuid, level, ...ids, per : rule.per, firstOnTurn : rule.firstOnTurn, oncePerTurn : rule.oncePerTurn, whileInside : rule.whileInside } });
    if(rule.terrain && !own.has("difficultTerrain")) behaviors.push({ type : "dnd5e.difficultTerrain", name : module.i18n("zones.terrain"),
      system : { magical : (item.type === "spell") || !!item.system?.properties?.has?.("mgc"), types : [], ignoredDispositions : [] } });
    const effects = own.has("applyActiveEffect") ? [] : pickEffects(item, rule.effect);
    if(effects.length) behaviors.push({ type : "dnd5e.applyActiveEffect", name : module.i18n("zones.effect"),
      system : { effects : effects.map(e => e.uuid), dispositions : [], sizes : [], types : [] } });
    if(behaviors.length) await region.createEmbeddedDocuments("RegionBehavior", behaviors).catch(error => log.error(error));
  },

  /* How many times a move inside the area counts : the spaces stepped into inside it (by its token's centre), as
     feet, once for every `per` feet. Core splits a move at the area's edges, so the path given is all inside it,
     maybe from a point on its edge; gridless : the distance itself */
  timesMoved(region, token, movement, per = 5){
    const grid = token.parent?.grid ?? canvas.grid;
    const points = [movement?.origin, ...(movement?.passed?.waypoints ?? [])].filter(Boolean);
    if(grid.isGridless) return Math.floor(((Number(movement?.passed?.distance) || 0) + 1e-6) / per);
    let steps = 0;
    for(let i = 1; i < points.length; i++){
      const a = points[i - 1], b = points[i];
      if(CONFIG.Token.movement?.actions?.[b.action]?.teleport) continue;
      const ca = token.getCenterPoint(a), cb = token.getCenterPoint(b);
      const dx = cb.x - ca.x, dy = cb.y - ca.y, length = (dx * dx) + (dy * dy);
      if(!length) continue;
      /* Each space along the way (by its top left corner), counted when it's ahead of where this part began and
         its centre is inside the area */
      for(const offset of grid.getDirectPath([{ x : a.x + 1, y : a.y + 1 }, { x : b.x + 1, y : b.y + 1 }])){
        const corner = grid.getTopLeftPoint(offset);
        const c = token.getCenterPoint({ ...b, x : corner.x, y : corner.y });
        const t = (((c.x - ca.x) * dx) + ((c.y - ca.y) * dy)) / length;
        if((t > 1e-6) && (t <= 1 + 1e-6) && region.testPoint({ x : c.x, y : c.y, elevation : b.elevation ?? token.elevation })) steps++;
      }
    }
    return Math.floor(((steps * grid.distance) + 1e-6) / per);
  },

  /* Out of the area : what the item's uses put on it ends (the active GM; a consequence of the area, so at once) */
  async left(behavior, token){
    const item = fromUuidSync(behavior.system.item ?? "", { strict : false });
    const actor = token?.actor;
    if(!item || !actor) return;
    const ids = actor.effects.filter(e => String(e.origin ?? "").startsWith(item.uuid)).map(e => e.id);
    if(ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids, { [module.id] : { reason : module.format("zones.left", { zone : item.name }) } }).catch(error => log.error(error));
  },

  /* The turn, as a key : the event's (a turn's end comes once the next has begun), else the current one; out of
     combat none (every time counts) */
  turnKey({ combat = game.combat, round, turn } = {}){
    if(!combat?.started) return null;
    return `${combat.id}.${round ?? combat.round}.${turn ?? combat.turn}`;
  },

  /* One moment of one zone for one creature : counted, then its activity used at the creature */
  async fire(behavior, token, moment, data = {}, { count = 1 } = {}){
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
        note : module.format(`zones.${moment}`, { name : token.name, zone : item.name, feet : count * (Number(system.per) || 5) }) },
    };
    if((item.type === "spell") && (level > 0)) usage.spell = { slot : `spell${Math.max(level, Number(item.system.level) || 1)}` };
    times.set(activity.uuid, count);
    try {
      const results = await activity.use(usage, { configure : false });
      if(results) await uses.cardOf(results).catch(() => null);
      return results;
    } finally { times.delete(activity.uuid); }
  },

  /* One at a time : a use is made, card and all, before the next starts */
  queue(behavior, token, moment, data, options){
    queue = queue.then(() => this.fire(behavior, token, moment, data, options)).catch(error => log.error(error));
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
      move : new StringField({ required : true, blank : true, initial : "", label : "zones.fields.move" }),
      per : new NumberField({ required : true, integer : true, min : 1, initial : 5, label : "zones.fields.per" }),
      whileInside : new BooleanField({ initial : false, label : "zones.fields.whileInside" }),
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

  /* Moved inside it (core splits a move at its edges : this part is all inside) */
  static async #onMoveWithin(event){
    if(!game.users.activeGM?.isSelf || !this.move) return;
    const { token, movement } = event.data ?? {};
    const count = zones.timesMoved(this.region, token, movement, Number(this.per) || 5);
    if(count > 0) zones.queue(this.behavior, token, "move", event.data, { count });
  }

  /* Out of it : what its uses put on the creature ends (whileInside) */
  static async #onExit(event){
    if(!game.users.activeGM?.isSelf || !this.whileInside) return;
    queue = queue.then(() => zones.left(this.behavior, event.data?.token)).catch(error => log.error(error));
  }

  static events = {
    [CONST.REGION_EVENTS.TOKEN_ENTER] : this.#onEnter,
    [CONST.REGION_EVENTS.TOKEN_TURN_START] : this.#onTurnStart,
    [CONST.REGION_EVENTS.TOKEN_TURN_END] : this.#onTurnEnd,
    [CONST.REGION_EVENTS.TOKEN_MOVE_WITHIN] : this.#onMoveWithin,
    [CONST.REGION_EVENTS.TOKEN_EXIT] : this.#onExit,
  };
}
