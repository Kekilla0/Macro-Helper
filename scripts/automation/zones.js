import { module } from '../module.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { idOf } from '../helpers/utils.js';
import { pickSpace } from '../helpers/targets.js';
import { gm } from '../gm.js';
import { actionTracker } from './action-tracker.js';
import { auraOff } from './auras.js';
const log = logger.for(import.meta.url);

/**
 * The zone lego : an area that acts on whoever comes into it or spends a turn in it (Cloud of Daggers, Moonbeam,
 * Grease; a monster's "a creature that starts its turn in the pool takes 2d6 acid"; a homebrew trap). Its item's own
 * activity is used at that one creature, as it was cast (the slot level, the DC), with nothing spent : its card is the
 * usual card (the save, the damage, Apply).
 *
 *   zone(match, { enter, start, end, move, per, firstOnTurn, oncePerTurn, terrain, effect, whileInside, moves, filter, enabled })
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
 *                   effects), an effect id or name, or item => effect(s)
 *     who           whose side gets the effect : "any" (default), "ally", "enemy" or "nonAlly", from the side of the
 *                   creature that made the area (Pass without Trace : "ally"; that creature itself counts as an ally)
 *     whileInside   what the item's uses put on a creature ends when it leaves the area (Web's Restrained)
 *     cast          false : using the item only makes the area, nothing happens to the creatures already in it then
 *                   (Web, Spike Growth : no card)
 *     moves         its user can move the area : feet (Moonbeam : 60), or { feet, cost, later } : cost "action" (default),
 *                   "bonus" or null (free); later (default true) : not on the turn it was made. A "Move <item>" button
 *                   on the user's action bar (its turn), or MacroHelper.moveZone(); the area slides up to that far, and
 *                   creatures it comes onto haven't entered it (they didn't move)
 *     filter        (token, item) => boolean : who it acts on (default : every creature)
 *
 * The item's lasting area (a dnd5e area left on the map : Concentration, a duration) gets a Region Behavior, "Zone"
 * (macro-helper.zone), from the active GM; it goes with the area. A GM can also add that behavior to any Region by
 * hand : the item's uuid, the cast level, and the activity id for each moment. The active GM's client uses the
 * activity (whoever moved the token).
 *
 * An area stuck to a token (an emanation : Pass without Trace) goes where its creature goes : those it comes onto
 * enter it, those it leaves behind leave it. A creature's aura (giveAura, auras.js) is such an area too.
 */
const rules = new Map();
let queue = Promise.resolve();
/* A move's use : its dice that many times (the activity's uuid, while it's used) */
const times = new Map();

export function zone(match, { enter = null, start = null, end = null, move = null, per = 5, firstOnTurn = false, oncePerTurn = false,
  terrain = false, effect = null, who = "any", whileInside = false, moves = null, cast = true, filter = null, enabled = null } = {}){
  if(!match || !(enter || start || end || move || terrain || effect || whileInside || moves)) return;
  if(moves && (typeof moves !== "object")) moves = { feet : Number(moves) };
  moves = (Number(moves?.feet) > 0) ? { feet : Number(moves.feet), cost : (moves.cost === undefined) ? "action" : moves.cost, later : moves.later !== false } : null;
  rules.set(match, { match, enter, start, end, move, per : Number(per) || 5, firstOnTurn : !!firstOnTurn, oncePerTurn : !!oncePerTurn,
    terrain : !!terrain, effect, who, whileInside : !!whileInside, moves, cast : cast !== false, filter, enabled });
}

/* A shape moved by (dx, dy) : its x / y, its points, an emanation's base */
function shifted(shape, dx, dy){
  const data = foundry.utils.deepClone(shape);
  if(Number.isFinite(data.x)) data.x += dx;
  if(Number.isFinite(data.y)) data.y += dy;
  if(Array.isArray(data.points)) data.points = data.points.map((n, i) => n + ((i % 2) ? dy : dx));
  if(data.origin && Number.isFinite(data.origin.x)) data.origin = { x : data.origin.x + dx, y : data.origin.y + dy };
  if(data.base) data.base = shifted(data.base, dx, dy);
  return data;
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
    gm.handle("moveZone", (data, user) => this.shiftAsGM(data, user));
    (CONFIG.RegionBehavior.typeIcons ??= {})[this.TYPE] = "fa-solid fa-burst";
    Hooks.on("createRegion", (region, options, userId) => this.onArea(region));
    Hooks.on("deleteRegion", region => this.gone(region));
    Hooks.on("deleteRegionBehavior", behavior => (behavior.type === this.TYPE) && this.gone(behavior));
    /* A turn starting inside one : once the turn's order is settled (core's region turn event, at a round Initiative
       Each Round rerolls, names whoever was first before the roll) */
    Hooks.on(`${module.id}.turnStart`, (combat, combatant) => this.turnStarted(combat, combatant));
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

  /* A lasting area of an item with a zone rule : its behaviors (the active GM) : the Zone (its effects while inside
     too), and dnd5e's Difficult Terrain when the rule says so (and the activity doesn't already make them) */
  async onArea(region){
    if(!game.users.activeGM?.isSelf || region.behaviors.some(b => b.type === this.TYPE)) return;
    const item = fromUuidSync(region.getFlag("dnd5e", "item") ?? "", { strict : false });
    const rule = zoneRuleOf(item);
    if(!rule) return;
    /* The turn it was made : a move only on later ones */
    if(rule.moves) await region.setFlag(module.id, "madeOn", this.turnKey() ?? "").catch(error => log.error(error));
    const activity = fromUuidSync(region.getFlag("dnd5e", "activity") ?? "", { strict : false });
    const own = new Set((activity?.applicableBehaviors ?? []).map(b => b.type));
    const level = Number(region.getFlag("dnd5e", "spellLevel")) || Number(activity?.item?.system?.level) || Number(item.system?.level) || 0;
    const ids = Object.fromEntries(["enter", "start", "end", "move"].map(k => [k, pickActivity(item, rule[k])?.id ?? ""]));
    const effects = own.has("applyActiveEffect") ? [] : pickEffects(item, rule.effect).map(e => e.uuid);
    const behaviors = [];
    if(ids.enter || ids.start || ids.end || ids.move || rule.whileInside || effects.length) behaviors.push({ type : this.TYPE, name : module.i18n("zones.name"),
      system : { item : item.uuid, level, ...ids, per : rule.per, firstOnTurn : rule.firstOnTurn, oncePerTurn : rule.oncePerTurn, whileInside : rule.whileInside,
        effects, who : rule.who ?? "any" } });
    if(rule.terrain && !own.has("difficultTerrain")) behaviors.push({ type : "dnd5e.difficultTerrain", name : module.i18n("zones.terrain"),
      system : { magical : (item.type === "spell") || !!item.system?.properties?.has?.("mgc"), types : [], ignoredDispositions : [] } });
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
    /* Already gone is fine (its Concentration ended : dnd5e deletes what depends on it, the area goes too) */
    if(ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids, { [module.id] : { reason : module.format("zones.left", { zone : item.name }) } })
      .catch(error => /does not exist/.test(String(error?.message ?? error)) ? log.debug(error) : log.error(error));
  },

  /* The creature that made the area : the one it's stuck to, else the one that used the item */
  makerOf(region){
    return region?.attachment?.token ?? fromUuidSync(region?.getFlag?.("dnd5e", "origin") ?? "", { strict : false }) ?? null;
  },

  /* Is this creature one the area's effects are for : its side (who), not its own creature (others), the rule */
  givesTo(behavior, token){
    const system = behavior.system, region = behavior.parent;
    if(!token?.actor || behavior.disabled || (token.disposition === CONST.TOKEN_DISPOSITIONS.SECRET)) return false;
    const maker = this.makerOf(region);
    /* An aura its creature's condition switches off (auras.js unless) */
    if(region?.getFlag?.(module.id, "auraUnless")?.length && auraOff(maker?.actor, region.getFlag(module.id, "auraUnless"))) return false;
    const self = !!maker && (maker.id === token.id);
    if(system.others && self) return false;
    const sign = (maker?.disposition ?? 0) * token.disposition;
    if(!self && (((system.who === "ally") && !(sign > 0)) || ((system.who === "enemy") && !(sign < 0))
      || ((system.who === "nonAlly") && !(sign <= 0)))) return false;
    const item = fromUuidSync(system.item ?? "", { strict : false });
    const rule = (item instanceof Item) ? zoneRuleOf(item, { any : true }) : null;
    return !(rule && ((rule.enabled && !rule.enabled()) || (rule.filter?.(token.object ?? token, item) === false)));
  },

  /* Into the area : its effects (a copy of each, lasting while inside) or its condition, by the active GM (a
     consequence of the area, so at once) */
  async give(behavior, token){
    const actor = token?.actor, system = behavior.system;
    const extra = behavior.parent?.getFlag?.(module.id, "auraEffects") ?? [];
    if(!actor || !(system.effects?.size || system.status || extra.length) || !this.givesTo(behavior, token)) return;
    if(actor.effects.some(e => e.getFlag(module.id, "zoneOf") === behavior.uuid)) return;
    const source = fromUuidSync(system.item ?? "", { strict : false });
    const flags = { zoneOf : behavior.uuid, auraOf : system.item || behavior.uuid };
    const data = [];
    for(const uuid of system.effects ?? []){
      const effect = await fromUuid(uuid).catch(() => null);
      if(!effect) continue;
      const copy = effect.toObject();
      delete copy._id;
      data.push(foundry.utils.mergeObject(copy, { transfer : false, disabled : false, duration : {}, origin : effect.parent?.uuid ?? source?.uuid ?? null,
        flags : { [module.id] : flags } }));
    }
    /* An aura's own effect data (auras.js) */
    for(const effect of extra){
      data.push(foundry.utils.mergeObject(foundry.utils.deepClone(effect), { transfer : false, disabled : false, duration : {},
        origin : source?.uuid ?? effect.origin ?? null, flags : { [module.id] : flags } }));
    }
    if(system.status){
      const status = CONFIG.statusEffects.find(s => s.id === system.status);
      const maker = this.makerOf(behavior.parent);
      data.push({ name : `${game.i18n.localize(status?.name ?? system.status)}${maker ? `: ${maker.name}` : ""}`, img : status?.img ?? "icons/svg/aura.svg",
        statuses : [system.status], origin : source?.origin ?? source?.uuid ?? null, flags : { [module.id] : flags } });
    }
    if(data.length) await actor.createEmbeddedDocuments("ActiveEffect", data).catch(error => log.error(error));
  },

  /* Out of the area (or the area gone) : what it gave ends */
  async take(behaviorUuid, actor, reason = null){
    const ids = (actor?.effects ?? []).filter(e => String(e.getFlag(module.id, "zoneOf") ?? "").startsWith(behaviorUuid)).map(e => e.id);
    if(ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids, { [module.id] : { reason : reason ?? module.i18n("cardBuilder.auraLeft") } }).catch(error => log.debug(error));
  },

  /* An area (or its behavior) deleted : what it gave goes, everywhere on its scene (the active GM) */
  async gone(doc){
    if(!game.users.activeGM?.isSelf) return;
    const scene = (doc.documentName === "Region") ? doc.parent : doc.parent?.parent;
    for(const token of scene?.tokens ?? []) await this.take(doc.uuid, token.actor);
  },

  /* The turn, as a key : the event's (a turn's end comes once the next has begun), else the current one; out of
     combat none (every time counts) */
  /* Active GM : the zones the creature whose turn it is starts it in */
  turnStarted(combat, combatant){
    const token = combatant?.token;
    if(!game.users.activeGM?.isSelf || !token?.parent) return;
    const data = { token, combat, round : combat.round, turn : combat.turn };
    for(const region of token.parent.regions){
      if(!region.tokens?.has?.(token)) continue;
      for(const behavior of region.behaviors){
        if((behavior.type === this.TYPE) && !behavior.disabled && behavior.system.start) this.queue(behavior, token, "start", data);
      }
    }
  },

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

  /* The areas the creature can move now (their rule's moves; not one stuck to a token; not on the turn it was made) :
     [{ region, item, moves }] */
  movable(actor){
    if(!actor || !canvas.scene) return [];
    const now = this.turnKey() ?? "";
    return canvas.scene.regions.contents.map(region => {
      const item = fromUuidSync(region.getFlag("dnd5e", "item") ?? "", { strict : false });
      const moves = (item?.actor?.uuid === actor.uuid) ? zoneRuleOf(item)?.moves : null;
      if(!moves || region.attachment?.token) return null;
      if(moves.later && now && (region.getFlag(module.id, "madeOn") === now)) return null;
      return { region, item, moves };
    }).filter(Boolean);
  },

  /* Where the area is : its middle */
  centreOf(region){
    const bounds = region.object?.bounds;
    if(bounds?.width) return { x : bounds.x + (bounds.width / 2), y : bounds.y + (bounds.height / 2) };
    const shape = region.shapes?.[0]?.base ?? region.shapes?.[0];
    return { x : Number(shape?.x) || 0, y : Number(shape?.y) || 0 };
  },

  /**
   * Move an area its creature can move (its rule's moves) : a space up to that far from its middle, picked on the map;
   * its cost spent (Action Tracker). No region given : the first one the creature can move.
   * @returns {Promise<boolean>}  moved
   */
  async moveArea(actor, region = null){
    const found = this.movable(actor).find(m => !region || (m.region === region) || (m.region.id === region?.id) || (m.region.uuid === region));
    if(!found) return ui.notifications.warn(module.i18n("zones.noMove")) && false;
    const { item, moves } = found;
    const st = actionTracker.enabled() ? actionTracker.state(actor) : null;
    if(st && moves.cost && (actionTracker.remaining(st.rec, moves.cost) <= 0))
      return ui.notifications.warn(module.format("zones.noCost", { kind : actionTracker.label(moves.cost) })) && false;
    /* Picked from the square its middle is in, as if it were a Medium creature there */
    const size = canvas.grid.size;
    const centre = this.centreOf(found.region);
    const cell = { x : Math.floor(centre.x / size) * size, y : Math.floor(centre.y / size) * size };
    const stand = { name : item.name, center : { x : cell.x + (size / 2), y : cell.y + (size / 2) },
      document : { documentName : "Token", x : cell.x, y : cell.y, width : 1, height : 1, elevation : 0 } };
    const space = await pickSpace(stand, { range : moves.feet, occupied : true, banner : module.format("zones.moveBanner", { zone : item.name, feet : moves.feet }) });
    if(!space) return false;
    const dx = space.x - cell.x, dy = space.y - cell.y;
    if(!dx && !dy) return false;
    if(st && moves.cost) await actionTracker.spend(actor, { kind : moves.cost, what : module.format("zones.moved", { zone : item.name }) });
    const data = { region : found.region.uuid, dx, dy };
    if(found.region.canUserModify(game.user, "update")) await this.shift(data);
    else await gm.run("moveZone", data);
    return true;
  },

  /* The area moved by (dx, dy) */
  async shift({ region : uuid, dx = 0, dy = 0 } = {}){
    const region = fromUuidSync(uuid ?? "", { strict : false });
    if(!region || (!dx && !dy)) return false;
    log.debug("Zone moved", region.name, dx, dy);
    await region.update({ shapes : region.shapes.map(s => shifted(s.toObject?.() ?? s, dx, dy)) });
    return true;
  },

  /* A player's move (the area is theirs, not a creature : moved at once) */
  async shiftAsGM(data = {}, user){
    const region = fromUuidSync(data.region ?? "", { strict : false });
    const item = fromUuidSync(region?.getFlag("dnd5e", "item") ?? "", { strict : false });
    if(!item?.actor?.testUserPermission(user, "OWNER") || !zoneRuleOf(item)?.moves) return false;
    return this.shift(data);
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
    const { StringField, NumberField, BooleanField, SetField } = foundry.data.fields;
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
      effects : new SetField(new StringField({ blank : false }), { label : "zones.fields.effects" }),
      status : new StringField({ required : true, blank : true, initial : "", label : "zones.fields.status" }),
      who : new StringField({ required : true, blank : false, initial : "any", label : "zones.fields.who",
        choices : { any : "zones.who.any", ally : "zones.who.ally", enemy : "zones.who.enemy", nonAlly : "zones.who.nonAlly" } }),
      others : new BooleanField({ initial : false, label : "zones.fields.others" }),
    };
  }

  /* Effects or a condition to give inside it (an aura's own effect data too) */
  get gives(){
    return !!(this.effects.size || this.status || this.behavior?.parent?.getFlag?.(module.id, "auraEffects")?.length);
  }

  static async #onEnter(event){
    if(!game.users.activeGM?.isSelf) return;
    /* Inside it, however it came to be (the area made round it or moving onto it too) : its effects */
    if(this.gives) queue = queue.then(() => zones.give(this.behavior, event.data.token)).catch(error => log.error(error));
    /* Moved in (walking through counts : core splits the move at the edge); appearing round it or the area coming
       onto it is the cast's own card, or the area's move */
    if(this.enter && event.data?.movement) zones.queue(this.behavior, event.data.token, "enter", event.data);
  }

  /* Made (or switched on) : the creatures already inside get its effects */
  static async #onActivated(event){
    if(!game.users.activeGM?.isSelf || !this.gives) return;
    for(const token of this.region?.tokens ?? []) queue = queue.then(() => zones.give(this.behavior, token)).catch(error => log.error(error));
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
    if(!game.users.activeGM?.isSelf) return;
    if(this.gives) queue = queue.then(() => zones.take(this.behavior.uuid, event.data?.token?.actor)).catch(error => log.error(error));
    if(this.whileInside) queue = queue.then(() => zones.left(this.behavior, event.data?.token)).catch(error => log.error(error));
  }

  static events = {
    [CONST.REGION_EVENTS.BEHAVIOR_ACTIVATED] : this.#onActivated,
    [CONST.REGION_EVENTS.TOKEN_ENTER] : this.#onEnter,
    [CONST.REGION_EVENTS.TOKEN_TURN_END] : this.#onTurnEnd,
    [CONST.REGION_EVENTS.TOKEN_MOVE_WITHIN] : this.#onMoveWithin,
    [CONST.REGION_EVENTS.TOKEN_EXIT] : this.#onExit,
  };
}
