import { module } from '../module.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { idOf } from '../helpers/utils.js';
import { tokenOf, cells, isSpaceFree } from '../helpers/tokens.js';
import { isAlly } from '../helpers/targets.js';
import { giveCondition } from '../roll-item/card-builder.js';
import { actions } from './actions.js';
import { actionTracker } from './action-tracker.js';
import { movement, jumpRule } from './movement.js';
import { limits } from './limits.js';
import { patch } from '../patch.js';
const log = logger.for(import.meta.url);

/**
 * Long Jump (2024), a Default Action ("Jump", examples/items/long-jump.json) and a button on the action bar on its turn
 * (Default Actions setting). The squares it can land on show green, the squares it would pass over yellow; it clicks a
 * green one, and the jump that gets it there is worked out :
 *
 *   Standing jump  : up to half its Strength score, over anything in the way. Both distances are rounded to the nearest
 *                    5 ft (the grid's step), and squares are measured with the scene's diagonal rule.
 *   Running jump   : up to its Strength score, after moving 10 ft on foot (Athlete : 5 ft) straight before it. Already
 *                    walked that far this turn, right up to here : it jumps from where it stands. Otherwise the run-up
 *                    is part of the jump : it walks the rest of it first, along the same line (the run-up squares can't
 *                    hold a creature that isn't its ally, and the space it jumps from must be empty).
 *   A leap         : the Jump spell, Boots of Striding and Springing : once a turn, up to 30 ft for 10 ft of movement,
 *                    no run-up; taken only when it's cheaper than a plain jump.
 *
 * Each foot of a jump (and of its run-up) costs a foot of movement : green only where its movement left this turn
 * (Action Tracker) pays for it; a wall in the way blocks it, and it lands on an empty space at the same height. The move
 * is its own (leaving a creature's reach provokes an Opportunity Attack). Landing in Difficult Terrain : DC 10
 * Dexterity (Acrobatics), or it has the Prone condition; a jump's feet cost no more for Difficult Terrain (dnd5e's measure
 * would charge it, the ruler's Jump too). The low-obstacle Athletics check is the GM's call (not asked).
 * How far it goes : the jumpRule lego (movement.js) and effects' flags.macro-helper.jump (Step of the Wind doubles the
 * distance). High Jump : not here (no ground height on the map).
 */
export class jump{
  static ID = "long-jump";
  static RUN_UP = 10;
  static LANDING_DC = 10;
  static COLORS = { land : 0x33DD66, pass : 0xE6C229, path : 0xFFD24A, border : 0xFFFFFF };
  static BOOTS = "boots-of-striding-and-springing";

  /* The item uses the jump makes itself (its card) : let them through */
  static #using = new Set();

  static enabled(){
    return actions.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    /* Its item used (the sheet, Favorites, a macro) : the squares first, then its card, then the jump */
    uses.onItem("jump", (item, ctx, next) => {
      if(!this.enabled() || (idOf(item) !== this.ID) || this.#using.has(item.uuid)) return next();
      return this.jump(tokenOf(item.actor) ?? item.actor, { item });
    });
    /* A jump's feet : a foot of movement each, Difficult Terrain or not (only its landing matters) */
    const self = this;
    Hooks.once("setup", () => patch.wrap("CONFIG.Token.objectClass.prototype._getMovementCostFunction", function(wrapped, ...args){
      const cost = wrapped(...args);
      if(!cost || !self.enabled()) return cost;
      return (from, to, distance, segment) => ((segment?.action === "jump") && segment.terrain)
        ? cost(from, to, distance, Object.create(segment, { terrain : { value : null } }))
        : cost(from, to, distance, segment);
    }));
    /* Boots of Striding and Springing : once on each of its turns, up to 30 ft for 10 ft of movement (worn, attuned) */
    jumpRule(actor => this.boots(actor), { leap : 30, cost : 10, id : "bootsOfStriding", enabled : () => this.enabled() });
  }

  static boots(actor){
    return actor?.items?.find?.(i => (idOf(i) === this.BOOTS) && i.system?.equipped
      && ((i.system.attunement !== "required") || i.system.attuned)) ?? null;
  }

  /* Its Jump item (ours) */
  static itemOf(actor){
    return actor?.items?.find?.(i => idOf(i) === this.ID) ?? null;
  }

  /**
   * How far it can jump now : feet for a running and a standing Long Jump, the run-up a running one needs, the best
   * leap left (Jump spell : { leap, cost, key, name }).
   * @param {Actor} actor
   * @param {object} [rec]   its Action Tracker record (the leaps used this turn)
   */
  static reachOf(actor, rec = null){
    const str = Number(actor?.system?.abilities?.str?.value) || 0;
    const rules = movement.jumpRules(actor);
    const times = rules.reduce((t, r) => t * (Number(r.times) || 1), 1);
    const runUps = rules.map(r => Number(r.runUp)).filter(n => Number.isFinite(n) && (n >= 0));
    /* Rounded to the nearest grid step (5 ft : STR 16 jumps 15 ft, 8 ft standing becomes 10); distances on the map
       are measured with the scene's diagonal rule */
    const step = Number(canvas.scene?.grid?.distance) || 5;
    const round = feet => Math.round(feet / step) * step;
    const long = str * times;
    const used = rec?.jumps ?? {};
    const leap = rules.filter(r => (Number(r.leap) > 0) && !(r.once && used[r.key]))
      .sort((a, b) => (b.leap - a.leap) || (a.cost - b.cost))[0] ?? null;
    return { long : round(long), standing : round(long / 2), runUp : Math.min(this.RUN_UP, ...runUps), leap };
  }

  /* Feet it walked this turn right up to where it stands (its movement history's last walking stretch) */
  static ranUp(token){
    const doc = token.document, history = doc.movementHistory ?? [];
    let feet = 0;
    for(let i = history.length - 1; i > 0; i--){
      if(history[i].action !== "walk") break;
      try { feet += doc.measureMovementPath([history[i - 1], history[i]]).distance ?? 0; } catch { break; }
    }
    return feet;
  }

  /* Its movement left this turn (Infinity : not counted) */
  static movementLeft(token, st){
    if(!st?.mine || (st.combatant.tokenId !== token.id)) return Infinity;
    return actionTracker.movementOf(token.actor, "walk") - actionTracker.movedOf(token) - (Number(st.rec.standing) || 0);
  }

  /**
   * Jump : the green squares, the one clicked, its card (the item, when it has it), then the move.
   * @param {Token|Actor} thing
   * @param {object} [options]  { item }
   * @returns {Promise<object|null>}  the jump made ({ kind, to, distance, cost }), null : cancelled or can't
   */
  static async jump(thing, { item = null } = {}){
    const token = tokenOf(thing);
    const actor = token?.actor;
    if(!token || !actor) return null;
    if(!token.document.isOwner){ ui.notifications.warn(module.format("cardBuilder.teleportOwner", { name : token.name })); return null; }
    if(canvas.grid.type !== CONST.GRID_TYPES.SQUARE){ ui.notifications.warn(module.i18n("jump.square")); return null; }
    if(actor.statuses?.has?.("prone")){ ui.notifications.warn(module.format("jump.prone", { name : actor.name })); return null; }
    const st = actionTracker.state(actor);
    if(st && !st.mine && !game.user.isGM
      && !limits.allow(module.format("actionTracker.notItsTurn", { name : actor.name, turn : st.combat.combatant?.name ?? "" }), { who : actor.name, what : module.i18n("jump.name") })) return null;
    const reach = this.reachOf(actor, st?.rec);
    const left = this.movementLeft(token, st);
    const speed = Number(actor.system?.attributes?.movement?.walk) || 0;
    if(!reach.long || !speed || (left < 5)){ ui.notifications.warn(module.format("jump.cant", { name : actor.name })); return null; }
    const plans = this.plans(token, reach, left);
    if(!plans.size){ ui.notifications.warn(module.format("jump.nowhere", { name : actor.name })); return null; }
    const plan = await this.pick(token, plans, item?.name ?? module.i18n("jump.name"));
    if(!plan) return null;
    item ??= this.itemOf(actor);
    if(item){
      this.#using.add(item.uuid);
      try { await item.use({}, { configure : false }, { data : { flags : { [module.id] : { note : this.describe(plan) } } } }); }
      catch(error){ log.error("Jump card", error); }
      finally { this.#using.delete(item.uuid); }
    }
    await this.go(token, plan);
    return plan;
  }

  /* ---------- Where it can land ---------- */

  /**
   * Every square it can land on, with the cheapest jump there : Map "x,y" -> { kind, from, to, distance, runUp, cost,
   * path (top-left points passed over), rule (a leap's) }.
   */
  static plans(token, reach, left){
    const grid = canvas.grid, size = grid.size, unit = canvas.scene.grid.distance;
    const doc = token.document, w = doc.width, h = doc.height;
    const origin = { x : doc.x, y : doc.y };
    const elevation = doc.elevation ?? 0;
    const ran = this.ranUp(token);
    const far = Math.max(reach.long + reach.runUp, reach.leap?.leap ?? 0);
    const span = Math.ceil(far / unit) + 1;
    const rect = canvas.dimensions.sceneRect;
    const dist = (a, b) => grid.measurePath([a, b]).distance;
    const at = (p, action) => ({ x : p.x, y : p.y, elevation, action });
    /* The token's own measure, on the path with its terrain : Difficult Terrain and its kind of move count */
    const costOf = path => this.measure(token, path).cost;
    const inScene = p => (p.x >= rect.x) && (p.y >= rect.y) && (p.x + (w * size) <= rect.right) && (p.y + (h * size) <= rect.bottom);
    const out = new Map();
    for(let dx = -span; dx <= span; dx++) for(let dy = -span; dy <= span; dy++){
      if(!dx && !dy) continue;
      const to = { x : origin.x + (dx * size), y : origin.y + (dy * size) };
      if(!inScene(to) || !isSpaceFree(to.x, to.y, w, { height : h, ignore : token })) continue;
      const distance = dist(origin, to);
      if((distance > far) || this.blocked(token, origin, to)) continue;
      const options = [];
      /* From here : standing, or running when it already ran up to here */
      if((distance <= reach.standing) || ((ran >= reach.runUp) && (distance <= reach.long))){
        options.push({ kind : (distance <= reach.standing) ? "standing" : "running", from : origin, distance, runUp : 0,
          cost : costOf([at(origin, "walk"), at(to, "jump")]), rank : 0 });
      }
      /* A leap (Jump spell) : its own cost */
      if(reach.leap && (distance <= reach.leap.leap)) options.push({ kind : "leap", from : origin, distance, runUp : 0, cost : reach.leap.cost, rule : reach.leap, rank : 2 });
      /* A running jump with the rest of its run-up first, along the same line */
      if((distance > reach.standing) && (ran < reach.runUp)){
        const from = this.runUpPoint(origin, to, reach.runUp - ran, unit);
        const run = from ? dist(origin, from) : 0;
        const leapt = from ? dist(from, to) : 0;
        if(from && (run + ran >= reach.runUp) && leapt && (leapt <= reach.long) && this.runUpClear(token, origin, from)
          && !this.blocked(token, origin, from) && !this.blocked(token, from, to)){
          options.push({ kind : "runUp", from, distance : leapt, runUp : run,
            cost : costOf([at(origin, "walk"), at(from, "walk"), at(to, "jump")]), rank : 1 });
        }
      }
      const best = options.filter(o => Number.isFinite(o.cost) && (o.cost <= left + 0.01)).sort((a, b) => (a.cost - b.cost) || (a.rank - b.rank))[0];
      if(!best) continue;
      const path = [...(best.runUp ? [...this.lineOf(token, origin, best.from)] : []), ...this.lineOf(token, best.from, to)];
      out.set(`${to.x},${to.y}`, { ...best, to, path });
    }
    return out;
  }

  /* The space `feet` along the line toward `to` (whole squares), or null when that's already `to` or past it */
  static runUpPoint(origin, to, feet, unit){
    const size = canvas.grid.size;
    const di = (to.x - origin.x) / size, dj = (to.y - origin.y) / size;
    const steps = Math.max(Math.abs(di), Math.abs(dj));
    const k = Math.ceil(feet / unit);
    if(!steps || (k >= steps)) return null;
    return { x : origin.x + (Math.round(di * k / steps) * size), y : origin.y + (Math.round(dj * k / steps) * size) };
  }

  /* Top-left points of its space along a -> b (b in, a out) */
  static lineOf(token, a, b){
    const grid = canvas.grid, size = grid.size;
    const hw = token.document.width * size / 2, hh = token.document.height * size / 2;
    const snap = v => Math.round(v / size) * size;
    let offsets;
    try { offsets = grid.getDirectPath([{ x : a.x + hw, y : a.y + hh }, { x : b.x + hw, y : b.y + hh }]); } catch { offsets = []; }
    const points = offsets.slice(1).map(o => { const c = grid.getCenterPoint(o); return { x : snap(c.x - hw), y : snap(c.y - hh) }; });
    if(!points.length || (points.at(-1).x !== b.x) || (points.at(-1).y !== b.y)) points.push({ x : b.x, y : b.y });
    return points.filter((p, i, all) => !i || (p.x !== all[i - 1].x) || (p.y !== all[i - 1].y));
  }

  /* A wall that blocks movement between the two spaces' centres */
  static blocked(token, a, b){
    const size = canvas.grid.size;
    const hw = token.document.width * size / 2, hh = token.document.height * size / 2;
    try {
      return !!CONFIG.Canvas.polygonBackends.move.testCollision({ x : a.x + hw, y : a.y + hh }, { x : b.x + hw, y : b.y + hh }, { type : "move", mode : "any" });
    } catch { return false; }
  }

  /* The run-up's squares hold no creature but its allies, and the one it jumps from none at all */
  static runUpClear(token, origin, from){
    const doc = token.document;
    const line = this.lineOf(token, origin, from);
    const there = p => {
      const size = canvas.grid.size;
      const left = Math.round(p.x / size), top = Math.round(p.y / size);
      return canvas.tokens.placeables.filter(t => (t !== token) && t.actor && (() => {
        const c = cells(t);
        return (c.left < left + doc.width) && (c.right > left) && (c.top < top + doc.height) && (c.bottom > top);
      })());
    };
    if(line.some(p => there(p).some(t => !isAlly(t, token)))) return false;
    return !there(from).length;
  }

  /* The card's line : "Running jump : 10 ft run-up, then 20 ft (30 ft of movement)" */
  static describe(plan){
    const cost = Math.round(plan.cost), distance = Math.round(plan.distance);
    if(plan.kind === "leap") return module.format("jump.leap", { distance, cost, name : plan.rule?.name ?? "" });
    if(plan.kind === "runUp") return module.format("jump.runUp", { run : Math.round(plan.runUp), distance, cost });
    return module.format((plan.kind === "standing") ? "jump.standing" : "jump.running", { distance, cost });
  }

  /* ---------- The pick ---------- */

  /* Green : where it can land; yellow : what it would pass over. The hovered square shows its jump. */
  static pick(token, plans, title){
    const layer = canvas.interface.grid;
    const size = canvas.grid.size;
    const doc = token.document;
    const BASE = `${module.id}-jump`, HOVER = `${module.id}-jump-hover`;
    layer.addHighlightLayer(BASE);
    layer.addHighlightLayer(HOVER);
    const fill = (name, p, color, alpha, border = null) => {
      for(let i = 0; i < doc.width; i++) for(let j = 0; j < doc.height; j++){
        layer.highlightPosition(name, { x : p.x + (i * size), y : p.y + (j * size), color, alpha, border });
      }
    };
    const keyOf = p => `${p.x},${p.y}`;
    const passed = new Map();
    for(const plan of plans.values()) for(const p of plan.path.slice(0, -1)) if(!plans.has(keyOf(p))) passed.set(keyOf(p), p);
    for(const p of passed.values()) fill(BASE, p, this.COLORS.pass, 0.25);
    for(const plan of plans.values()) fill(BASE, plan.to, this.COLORS.land, 0.3);

    const view = canvas.app.view;
    const banner = document.createElement("div");
    banner.className = `${module.id}-pick-banner`;
    document.body.append(banner);
    const esc = s => Handlebars.escapeExpression(s);
    const status = (line = "", warning = "") => {
      banner.innerHTML = `<strong>${esc(title)}</strong><span class="picks">${esc(line || module.i18n("jump.banner"))}</span>`
        + `<span>${esc(module.i18n("helpers.space.keys"))}</span>` + (warning ? `<span class="warning">${esc(warning)}</span>` : "");
    };
    const spaceAt = event => {
      const point = canvas.canvasCoordinatesFromClient({ x : event.clientX, y : event.clientY });
      /* The space its token would take with the mouse over its middle */
      return { x : Math.round((point.x / size) - (doc.width / 2)) * size, y : Math.round((point.y / size) - (doc.height / 2)) * size };
    };
    let hovered = null;
    return new Promise(resolve => {
      const finish = result => {
        window.removeEventListener("pointerdown", onPointer, true);
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("keydown", onKey, true);
        layer.destroyHighlightLayer(BASE);
        layer.destroyHighlightLayer(HOVER);
        banner.remove();
        resolve(result);
      };
      const onMap = target => (target === view) || ((target?.tagName === "CANVAS") && !target.closest?.(".application, #sidebar, #ui-left, #ui-right, #hotbar"));
      const onMove = event => {
        if(!onMap(event.target)) return;
        const at = spaceAt(event);
        if(hovered && (hovered.x === at.x) && (hovered.y === at.y)) return;
        hovered = at;
        layer.clearHighlightLayer(HOVER);
        const plan = plans.get(keyOf(at));
        if(!plan) return status();
        for(const p of plan.path.slice(0, -1)) fill(HOVER, p, this.COLORS.path, 0.55);
        fill(HOVER, plan.to, this.COLORS.land, 0.7, this.COLORS.border);
        status(this.describe(plan));
      };
      const onPointer = event => {
        if(!onMap(event.target) || (event.button !== 0)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const plan = plans.get(keyOf(spaceAt(event)));
        if(!plan) return status("", module.i18n("jump.notGreen"));
        finish(plan);
      };
      const onKey = event => {
        if(event.key !== "Escape") return;
        event.preventDefault(); event.stopPropagation();
        finish(null);
      };
      window.addEventListener("pointerdown", onPointer, true);
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("keydown", onKey, true);
      status();
    });
  }

  /* ---------- The move ---------- */

  /* The run-up walked, the jump jumped (its own move : Opportunity Attacks); a leap costs its own feet; the landing */
  static async go(token, plan){
    const doc = token.document;
    const elevation = doc.elevation ?? 0;
    const waypoints = [
      ...(plan.runUp ? [{ x : plan.from.x, y : plan.from.y, elevation, action : "walk" }] : []),
      { x : plan.to.x, y : plan.to.y, elevation, action : "jump" },
    ];
    if(plan.kind === "leap") actionTracker.markLeap(token.id, plan.to);
    await doc.move(waypoints, { [module.id] : { oaCheck : true } });
    await token.movementAnimationPromise?.catch?.(() => null);
    if(plan.kind === "leap"){
      await actionTracker.useMovement(token, -plan.cost);
      const st = actionTracker.state(token.actor);
      if(st && plan.rule?.once){
        st.rec.jumps = { ...(st.rec.jumps ?? {}), [plan.rule.key] : true };
        await actionTracker.save(token.actor, st.rec);
      }
    }
    /* Stopped on the way (an Opportunity Attack) : it lands later, no check here */
    if((doc.x !== plan.to.x) || (doc.y !== plan.to.y)) return;
    if(this.difficultAt(token, plan)) await this.land(token);
  }

  /* Its landing space is Difficult Terrain : walking into it costs more than its distance */
  static difficultAt(token, plan){
    const doc = token.document;
    const before = plan.path.at(-2) ?? plan.from;
    const elevation = doc.elevation ?? 0;
    const m = this.measure(token, [{ x : before.x, y : before.y, elevation, action : "walk" }, { x : plan.to.x, y : plan.to.y, elevation, action : "walk" }]);
    return Number.isFinite(m.cost) && (m.cost > m.distance + 0.01);
  }

  /* { distance, cost } of a path (waypoints with their action), terrain included */
  static measure(token, waypoints){
    try {
      const m = token.measureMovementPath(token.createTerrainMovementPath(waypoints));
      return { distance : m.distance ?? 0, cost : m.cost ?? Infinity };
    } catch(error){ log.debug("Jump measure", error); return { distance : 0, cost : Infinity }; }
  }

  /* DC 10 Dexterity (Acrobatics), or Prone */
  static async land(token){
    const actor = token.actor;
    const [roll] = await actor.rollSkill({ skill : "acr", target : this.LANDING_DC }, { configure : false },
      { data : { flavor : module.i18n("jump.landing") } }) ?? [];
    if(!roll || (roll.total >= this.LANDING_DC)) return;
    await giveCondition(token, "prone", { from : this.itemOf(actor) });
  }
}
