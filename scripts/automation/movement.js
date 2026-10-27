import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { patch } from '../patch.js';
import { idOf } from '../helpers/utils.js';
import { grapplesOn } from '../roll-item/card-builder.js';
const log = logger.for(import.meta.url);

/**
 * The movement legos : how a creature moves, stands and drags (Athlete, Grappler's Fast Wrestler; a monster's "it has
 * a climb speed equal to its walking speed", a homebrew "standing up costs you nothing").
 *
 *   speedAs(match, { speed : "climb", as : "walk", when })   a speed equal to another (at least : a bigger one stays)
 *   standUpCost(match, feet, { when })                       standing up from Prone costs that much movement (the
 *                                                            least of the rules that hold, and half its Speed); feet
 *                                                            may be (actor, source) => number
 *   dragsFreely(match, { when })                             dragging a creature it grapples costs no extra movement;
 *                                                            when(grappler, held) : this one qualifies (Fast Wrestler :
 *                                                            its size or smaller)
 *   jumpRule(match, { times, runUp, leap, cost, once, when })  how its Long Jump goes (jump.js) : times : its distance
 *                                                            multiplied (Step of the Wind : 2); runUp : the feet it moves
 *                                                            first for a running jump (Athlete : 5; the least wins);
 *                                                            leap : a jump up to that many feet for `cost` ft of movement
 *                                                            (default 10), no run-up, once a turn (once : null : every
 *                                                            jump) : the Jump spell, Boots of Striding and Springing.
 *                                                            An Active Effect does the same with flags.macro-helper.jump
 *                                                            = { times, runUp, leap, cost, once } (no match).
 *
 *   match  an item identifier the creature has (or several), or (actor) => the item (or anything truthy) that gives it
 *   when   (actor, source) => boolean : the rule holds now. enabled () => boolean leaves it off (its setting). The same
 *          id (default : the match) replaces the rule.
 *
 * Dragging (2024 Grappled, Condition Rules) : a grappler that moves (a drag, the keyboard, a leap; not a teleport or a
 * forced move) takes the creatures it grapples with it, each the same way (the active GM moves them), and every foot of its
 * movement costs 1 extra foot, unless each of them is Tiny or two sizes smaller than it (or a dragsFreely rule says
 * so). The ruler shows the cost; the Action Tracker counts it. Release first to leave one behind.
 */
const rules = { speed : new Map(), stand : new Map(), drag : new Map(), jump : new Map() };

const keyOf = (match, id) => id ?? ((typeof match === "function") ? foundry.utils.randomID() : [match].flat().map(String).join(","));

/* The item on this creature that gives a rule, or null */
function sourceOf(actor, match){
  if(!actor) return null;
  if(typeof match === "function"){
    try { return match(actor) || null; } catch(error){ log.error("Movement match", error); return null; }
  }
  const ids = [match].flat();
  return actor.items?.find?.(i => (i.type !== "spell") && ids.includes(idOf(i))) ?? null;
}

/* The rules of a kind holding for this creature : [{ rule, source }] */
function holding(kind, actor){
  const found = [];
  for(const rule of rules[kind].values()){
    if(rule.enabled && !rule.enabled()) continue;
    const source = sourceOf(actor, rule.match);
    if(!source) continue;
    try { if(rule.when && !rule.when(actor, source)) continue; } catch(error){ log.error("Movement rule", error); continue; }
    found.push({ rule, source });
  }
  return found;
}

/**
 * A speed equal to another one (Athlete : a Climb Speed equal to its Speed). A speed already bigger stays.
 * @param {string|string[]|Function} match
 * @param {object} options  { speed, as = "walk", when, enabled, id }
 */
export function speedAs(match, { speed, as = "walk", when = null, enabled = null, id = null } = {}){
  if(!speed) return;
  rules.speed.set(keyOf(match, id), { match, speed, as, when, enabled });
}

/**
 * Standing up from Prone costs this much movement (Athlete's Hop Up : 5 ft).
 * @param {string|string[]|Function} match
 * @param {number|Function} feet   or (actor, source) => number
 * @param {object} [options]  { when, enabled, id }
 */
export function standUpCost(match, feet, { when = null, enabled = null, id = null } = {}){
  rules.stand.set(keyOf(match, id), { match, feet, when, enabled });
}

/**
 * Dragging a creature it grapples costs no extra movement (Fast Wrestler).
 * @param {string|string[]|Function} match
 * @param {object} [options]  { when : (grappler, held) => boolean, enabled, id }
 */
export function dragsFreely(match, { when = null, enabled = null, id = null } = {}){
  rules.drag.set(keyOf(match, id), { match, held : when, enabled });
}

/**
 * How its Long Jump goes (Athlete's 5 ft run-up, Step of the Wind's doubled distance, the Jump spell's 30 ft for 10 ft).
 * @param {string|string[]|Function} match
 * @param {object} [options]  { times, runUp, leap, cost = 10, once = "turn", when, enabled, id }
 */
export function jumpRule(match, { times = null, runUp = null, leap = null, cost = 10, once = "turn", when = null, enabled = null, id = null } = {}){
  rules.jump.set(keyOf(match, id), { key : keyOf(match, id), match, times, runUp, leap, cost, once, when, enabled });
}

const SIZES = ["tiny", "sm", "med", "lg", "huge", "grg"];

export class movement{
  static enabled(){
    return (game.system.id === "dnd5e") && !!settings.value("conditionAttacks");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    const self = this;
    /* Speeds equal to another : once dnd5e has worked them out (conditions, armor, encumbrance) */
    patch.wrap("CONFIG.Actor.documentClass.prototype.prepareDerivedData", function(wrapped, ...args){
      const result = wrapped(...args);
      if(rules.speed.size) try { self.applySpeeds(this); } catch(error){ log.error("Speeds", error); }
      return result;
    });
    /* Dragging : the extra foot a foot, in the ruler and in what the move costs */
    Hooks.once("setup", () => patch.wrap("CONFIG.Token.objectClass.prototype._getMovementCostFunction", function(wrapped, ...args){
      const cost = wrapped(...args);
      if(!self.enabled() || !self.dragsAtCost(this.document)) return cost;
      return (from, to, distance, segment) => {
        const base = cost ? cost(from, to, distance, segment) : distance;
        if(!Number.isFinite(base) || segment?.actionConfig?.teleport || (segment?.action === "displace")) return base;
        return base + distance;
      };
    }));
    Hooks.on("moveToken", (doc, movement, options) => this.drag(doc, movement, options));
  }

  /* ---------- Speeds ---------- */

  static applySpeeds(actor){
    const m = actor.system?.attributes?.movement;
    if(!m?.speeds) return;
    for(const { rule } of holding("speed", actor)){
      const to = Number(m.speeds[rule.as]) || 0;
      if(to > (Number(m.speeds[rule.speed]) || 0)) m.speeds[rule.speed] = to;
      m.max = Math.max(Number(m.max) || 0, Number(m.speeds[rule.speed]) || 0);
    }
  }

  /* ---------- Standing up ---------- */

  /**
   * What standing up costs it : half its Speed (not a Dash's doubled one), or less from a rule.
   * @param {Actor} actor
   * @param {number} speed   its Speed now (its walk; a Dash doesn't change what standing costs)
   * @returns {number}
   */
  static standCost(actor, speed){
    let cost = Math.floor((Number(speed) || 0) / 2);
    for(const { rule, source } of holding("stand", actor)){
      const feet = Number((typeof rule.feet === "function") ? rule.feet(actor, source) : rule.feet);
      if(Number.isFinite(feet)) cost = Math.min(cost, Math.max(0, feet));
    }
    return cost;
  }

  /* ---------- Jumping ---------- */

  /**
   * The jump rules holding for it : the jumpRule legos, then its effects' flags.macro-helper.jump.
   * @returns {object[]}  [{ key, times, runUp, leap, cost, once, name }]
   */
  static jumpRules(actor){
    const out = holding("jump", actor).map(({ rule, source }) => ({ ...rule, name : source?.name ?? "" }));
    for(const effect of actor?.appliedEffects ?? []){
      const jump = effect.getFlag?.(module.id, "jump");
      if(jump) out.push({ cost : 10, once : "turn", ...jump, key : `effect:${effect.origin ?? effect.id}`, name : effect.name });
    }
    return out;
  }

  /* ---------- Dragging ---------- */

  /* The creatures this token drags with it : those it grapples (not an attachment, which follows on its own) */
  static heldBy(doc){
    const actor = doc?.actor;
    if(!actor || !doc.parent) return [];
    const mine = by => !!by && ((by.uuid === doc.uuid) || (by.uuid === actor.uuid) || (by.actor?.uuid === actor.uuid));
    return doc.parent.tokens.filter(t => (t !== doc) && t.actor && grapplesOn(t.actor).some(g => !g.free && !g.attach && mine(g.by)));
  }

  /* Does dragging cost it the extra foot : someone it holds isn't Tiny or two sizes smaller, nor freed by a rule */
  static dragsAtCost(doc){
    const held = this.heldBy(doc);
    if(!held.length) return false;
    const own = SIZES.indexOf(doc.actor?.system?.traits?.size ?? "med");
    const free = holding("drag", doc.actor);
    return held.some(t => {
      const size = SIZES.indexOf(t.actor?.system?.traits?.size ?? "med");
      if((size === 0) || ((own >= 0) && (size >= 0) && (own - size >= 2))) return false;
      return !free.some(({ rule }) => !rule.held || rule.held(doc.actor, t.actor));
    });
  }

  /* A grappler moved on its own : those it holds move the same way (the active GM) */
  static drag(doc, movement, options = {}){
    if(!this.enabled() || !game.users.activeGM?.isSelf || !movement?.origin || !movement?.destination) return;
    /* Its own move (a drag, the keyboard, a macro's leap or move, the rest of a move an Opportunity Attack stopped) :
       not a creature being dragged itself (two holding each other), a push (dnd5e's update), a teleport, a displace */
    const own = options?.[module.id] ?? {};
    if(own.dragged || !(["dragging", "keyboard"].includes(movement.method) || own.oaCheck || own.oaResume || own.oaSkip)) return;
    const passed = movement.passed?.waypoints ?? [];
    if(passed.length && passed.every(p => (p.action === "displace") || CONFIG.Token.movement?.actions?.[p.action]?.teleport)) return;
    if(!passed.length && ((movement.destination.action === "displace") || CONFIG.Token.movement?.actions?.[movement.destination.action]?.teleport)) return;
    const dx = movement.destination.x - movement.origin.x, dy = movement.destination.y - movement.origin.y;
    const dz = (Number(movement.destination.elevation) || 0) - (Number(movement.origin.elevation) || 0);
    if(!dx && !dy && !dz) return;
    for(const t of this.heldBy(doc)){
      t.move({ x : t.x + dx, y : t.y + dy, elevation : (Number(t.elevation) || 0) + dz, action : "displace" },
        { constrainOptions : { ignoreTokens : true, ignoreWalls : true }, [module.id] : { oaSkip : true, dragged : true } }).catch(error => log.debug(error));
    }
  }
}
