import { module } from '../module.js';
import { gm } from '../gm.js';
import { uses } from '../uses.js';
import { logger } from '../log.js';
import { cells, gridSteps } from '../helpers/tokens.js';
const log = logger.for(import.meta.url);

/**
 * Card builder : a macro adds to (or takes from) the card a use makes, and the card shows it like its own parts.
 *
 *   const card = await item.roll();              the item's normal use (targets, attack, damage...), its card returned
 *   card.remove("prone");                        an item's own effect taken off the card (by condition or name)
 *   card.append(applyCondition({ type : "prone", when : ["hit", pounce] }));
 *   card.append(followUp("Bite", { when : ["hit", pounce] }));
 *
 * Parts are kept on the card (flags.macro-helper.cardParts) and shown in each target's row, in the order appended.
 * `when` : "hit" / "miss" are judged live (Shield, cover, a reroll change them), a function (target) => boolean is a
 * fact judged once per target when appended (its size, how it was charged), true / false as given. Changes made
 * together reach the card in one update (no flicker).
 *
 *   applyCondition({ type, when, duration, save : { ability, dc, repeat : "end" | "start" } })
 *     an Apply button (the target's owner or the GM) : the condition with its own icon and name, from the item; a
 *     save repeats at the end (or start) of each of its turns, a success ends it. Already under that condition : the
 *     harsher one stays (the longer, then the one with no save, then the higher DC).
 *   followUp(item, { when })   a button for the card's owner : that item's attack at the target, part of this use
 *                              (no Action of its own for the Action Tracker).
 */
const KEY = "cardParts";
const uuidKey = uuid => String(uuid).replaceAll(".", "-");

/* ---------- Parts ---------- */

export function applyCondition({ type, when = [], duration = null, save = null, label = null } = {}){
  return { kind : "condition", type, when : [when].flat(), duration, save, label };
}

export function followUp(item, { when = [], label = null } = {}){
  const name = (typeof item === "string") ? item : (item?.name ?? "");
  return { kind : "followUp", item : name, when : [when].flat(), label };
}

/* Sizes, smallest first : sizeAtMost("large") */
const SIZES = ["tiny", "sm", "med", "lg", "huge", "grg"];
const SIZE_NAMES = { tiny : "tiny", small : "sm", medium : "med", large : "lg", huge : "huge", gargantuan : "grg" };

export function sizeAtMost(thing, size){
  const actor = thing?.actor ?? thing;
  const own = SIZES.indexOf(actor?.system?.traits?.size);
  const most = SIZES.indexOf(SIZE_NAMES[String(size).toLowerCase()] ?? String(size).toLowerCase());
  return (own >= 0) && (most >= 0) && (own <= most);
}

/**
 * Did it charge at the target : its last stretch of movement this turn in a straight line, at least `feet` long,
 * going toward the target and ending within reach of it (Allosaurus Pounce, Boar Charge).
 */
export function chargedAt(thing, target, feet = 30, { reach = null } = {}){
  const doc = thing?.document ?? thing;
  const other = target?.document ?? target;
  const scene = doc?.parent;
  if(!doc || !other || !scene) return false;
  const size = scene.grid.size, unit = scene.grid.distance || 5;
  const points = (doc.movementHistory ?? []).map(w => ({ x : w.x, y : w.y }));
  const now = { x : doc.x, y : doc.y };
  if(!points.length || (points.at(-1).x !== now.x) || (points.at(-1).y !== now.y)) points.push(now);
  if(points.length < 2) return false;
  /* Back along the path while it keeps the last stretch's direction */
  const angle = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
  const end = points.at(-1);
  let i = points.length - 2;
  while((i >= 0) && (points[i].x === end.x) && (points[i].y === end.y)) i--;
  if(i < 0) return false;
  const heading = angle(points[i], end);
  while((i > 0) && (Math.abs(angle(points[i - 1], points[i]) - heading) < 0.15)) i--;
  const start = points[i];
  const foot = p => ({ x : p.x, y : p.y, width : doc.width, height : doc.height });
  const centre = p => ({ x : p.x + ((doc.width || 1) * size / 2), y : p.y + ((doc.height || 1) * size / 2) });
  const length = scene.grid.measurePath([centre(start), centre(end)]).distance;
  const gap = p => { const a = cells(foot(p)), b = cells(other);
    return gridSteps(Math.max(0, b.left - a.right, a.left - b.right), Math.max(0, b.top - a.bottom, a.top - b.bottom)) * unit; };
  const within = reach ?? unit;
  return (length >= feet) && (gap(end) <= within) && ((gap(start) - gap(end)) >= (feet - unit));
}

/* ---------- The card ---------- */

export class CardBuilder{
  #draft = null;
  #timer = null;

  constructor(message){
    this.message = message;
  }

  #state(){
    return foundry.utils.deepClone(this.message.getFlag(module.id, KEY) ?? { parts : [], removed : [] });
  }

  /* Changes made one after another reach the card together, once the macro pauses or ends */
  #change(fn){
    this.#draft ??= this.#state();
    fn(this.#draft);
    this.#timer ??= setTimeout(() => this.flush(), 0);
    return this;
  }

  async flush(){
    const draft = this.#draft;
    this.#draft = null;
    clearTimeout(this.#timer);
    this.#timer = null;
    if(draft) await this.message.setFlag(module.id, KEY, draft);
    return this;
  }

  get targets(){
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    return (this.message.system?.targets ?? []).map(d => TargetsField.resolve(d)?.token).filter(Boolean);
  }

  /* A part, after the others; its target facts (functions) judged now, for each target */
  append(part){
    if(!part?.kind) return this;
    const facts = {};
    for(const token of this.targets){
      const doc = token.document ?? token;
      const ok = part.when.every(w => (typeof w !== "function") || !!w(doc.object ?? token));
      facts[uuidKey(doc.uuid)] = ok;
    }
    const stored = { ...part, when : part.when.filter(w => (typeof w === "string") || (typeof w === "boolean")), facts };
    return this.#change(state => state.parts.push(stored));
  }

  /* An item's own effect off the card (by its condition, or its name), or a part appended before */
  remove(what){
    return this.#change(state => {
      if(typeof what === "string") state.removed.push(what.toLowerCase());
      else state.parts = state.parts.filter(p => p !== what);
    });
  }

  /* Nothing of the item's own effects, no parts : everything from here on is appended */
  clear(){
    return this.#change(state => { state.parts = []; state.removed = ["*"]; });
  }
}

export class cardBuilder{
  /* item.roll() : the item's normal use, its card as a CardBuilder (null : nothing was rolled) */
  static async roll(item, { post = true } = {}){
    const results = await item.use({ [module.id] : { skipMacro : true } });
    if(!results) return null;
    const made = await uses.cardOf(results);
    /* The card itself (the use may hand back its data, or the message) */
    const id = made?.id ?? made?._id ?? made?.message?.id ?? null;
    const message = (made?.documentName === "ChatMessage") ? made : (id ? game.messages.get(id) : null);
    if(!message) return null;
    if(!post) log.debug("item.roll : the card is already posted by the use; post : false is not supported yet");
    return new CardBuilder(message);
  }

  /* The item's own effects the card shows : those not removed */
  static keeps(message, effect){
    const removed = message?.getFlag?.(module.id, KEY)?.removed ?? [];
    if(!removed.length) return true;
    if(removed.includes("*")) return false;
    const statuses = [...(effect?.statuses ?? [])];
    return !removed.some(r => statuses.includes(r) || (effect?.name ?? "").toLowerCase() === r);
  }

  static shown(part, uuid, result){
    if(part.facts && (part.facts[uuidKey(uuid)] === false)) return false;
    return part.when.every(w => (w === "hit") ? (result?.hit === true) : (w === "miss") ? (result?.hit === false) : (w !== false));
  }

  /* Card macros' building blocks, on the documents whatever the Helpers → Methods switches say :
     item.roll(), token.chargedAt(target, feet), creature.sizeAtMost(size) (never over an existing method) */
  static addMethods(){
    const add = (cls, name, fn) => {
      const proto = cls?.prototype;
      if(!proto || (name in proto)) return;
      Object.defineProperty(proto, name, { value : fn, writable : true, configurable : true, enumerable : false });
    };
    const self = this;
    add(CONFIG.Item.documentClass, "roll", function(options){ return self.roll(this, options); });
    for(const cls of [CONFIG.Actor.documentClass, CONFIG.Token.documentClass, CONFIG.Token.objectClass]) add(cls, "sizeAtMost", function(size){ return sizeAtMost(this, size); });
    for(const cls of [CONFIG.Token.documentClass, CONFIG.Token.objectClass]) add(cls, "chargedAt", function(target, feet, options){ return chargedAt(this, target, feet, options); });
  }

  static register(){
    Hooks.once("setup", () => this.addMethods());
    gm.handle("cardCondition", (data, user) => this.conditionAsGM(data, user));
    gm.handle("cardPartDone", (data, user) => this.doneAsGM(data, user));
    /* Each target's row : its parts as buttons */
    Hooks.on(`${module.id}.rowButtons`, (message, uuid, buttons, { result } = {}) => {
      const parts = message.getFlag?.(module.id, KEY)?.parts ?? [];
      parts.forEach((part, index) => {
        if(!this.shown(part, uuid, result)) return;
        const done = !!message.getFlag(module.id, `cardDone.${index}.${uuidKey(uuid)}`);
        const target = fromUuidSync(uuid, { strict : false });
        if(part.kind === "condition"){
          if(!(game.user.isGM || target?.actor?.isOwner)) return;
          const status = CONFIG.statusEffects.find(s => s.id === part.type);
          const name = part.label ?? game.i18n.localize(status?.name ?? part.type);
          /* The condition's own picture and name; once applied, greyed out */
          buttons.push({ id : `part:${index}`, img : status?.img ?? null, icon : "fa-circle-exclamation", disabled : done, label : name });
        }
        else if(part.kind === "followUp"){
          if(!message.isOwner) return;
          buttons.push({ id : `part:${index}`, icon : "fa-hand-fist", disabled : done, label : part.label ?? part.item });
        }
      });
    });
    Hooks.on(`${module.id}.rowButton`, (message, uuid, id) => {
      if(String(id).startsWith("part:")) this.press(message, uuid, Number(String(id).slice(5)));
    });
  }

  static async press(message, uuid, index){
    const part = message.getFlag(module.id, KEY)?.parts?.[index];
    if(!part || message.getFlag(module.id, `cardDone.${index}.${uuidKey(uuid)}`)) return;
    const target = fromUuidSync(uuid, { strict : false });
    if(part.kind === "condition"){
      const ok = await gm.run("cardCondition", { message : message.id, index, target : uuid });
      if(ok) await gm.run("cardPartDone", { message : message.id, index, target : uuid });
      return;
    }
    if(part.kind === "followUp"){
      const actor = message.getAssociatedActor?.();
      const item = actor?.items?.getName(part.item) ?? actor?.items?.get(part.item);
      const attack = item?.system?.activities?.find?.(a => a.type === "attack");
      if(!attack || !target?.object) return ui.notifications.warn(module.format("cardBuilder.noItem", { name : part.item }));
      canvas.tokens.setTargets([target.object.id]);
      const used = await attack.use({ [module.id] : { economy : "free", skipPick : true, useTargets : true, skipMacro : true } });
      if(used) await gm.run("cardPartDone", { message : message.id, index, target : uuid });
    }
  }

  /* GM : the condition on the target (its owner or the GM pressed it), the harsher one kept */
  static async conditionAsGM({ message : id, index, target : uuid } = {}, user){
    const message = game.messages.get(id);
    const part = message?.getFlag(module.id, KEY)?.parts?.[index];
    const actor = fromUuidSync(uuid ?? "", { strict : false })?.actor;
    if(!part || !actor || !(user.isGM || actor.testUserPermission(user, "OWNER"))) return false;
    const item = message.getAssociatedItem?.();
    await this.applyConditionTo(actor, part, { origin : item?.uuid ?? null, by : message.getAssociatedActor?.() ?? null });
    return true;
  }

  static async doneAsGM({ message : id, index, target : uuid } = {}){
    const message = game.messages.get(id);
    if(!message) return false;
    await message.setFlag(module.id, `cardDone.${index}.${uuidKey(uuid)}`, true);
    return true;
  }

  /* How long it can last, in seconds (Infinity : until something ends it) */
  static lasting(duration){
    if(!duration) return Infinity;
    const d = duration;
    return (Number(d.seconds) || 0) + ((Number(d.rounds) || 0) * 6) + ((Number(d.turns) || 0) * 6) || Infinity;
  }

  /* Which is harsher : the longer, then the one with no save, then the higher DC */
  static harsher(a, b){
    const la = this.lasting(a.duration), lb = this.lasting(b.duration);
    if(la !== lb) return (la > lb) ? a : b;
    if(!!a.save !== !!b.save) return a.save ? b : a;
    return ((Number(a.save?.dc) || 0) >= (Number(b.save?.dc) || 0)) ? a : b;
  }

  static async applyConditionTo(actor, part, { origin = null, by = null } = {}){
    const status = CONFIG.statusEffects.find(s => s.id === part.type);
    const name = part.label ?? game.i18n.localize(status?.name ?? part.type);
    const duration = (typeof part.duration === "number") ? { rounds : part.duration } : (part.duration ?? {});
    const repeat = part.save ? { label : part.save.repeat ?? "end", from : { item : origin, actor : by?.uuid ?? null },
      roll : { type : "save", ability : part.save.ability, dc : Number(part.save.dc) || null },
      when : { at : part.save.repeat ?? "end", of : actor.uuid } } : null;
    const incoming = { duration, save : part.save };
    /* Already under it : the harsher stays */
    const existing = actor.effects.filter(e => !e.disabled && e.statuses?.has?.(part.type));
    for(const e of existing){
      const old = { duration : e.duration, save : e.getFlag(module.id, "repeat")?.roll ?? null };
      if(this.harsher(old, incoming) === old) return log.debug("Kept the harsher", part.type, actor.name);
    }
    if(existing.length) await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map(e => e.id),
      { [module.id] : { reason : module.format("cardBuilder.replaced", { name }) } }).catch(() => null);
    await actor.createEmbeddedDocuments("ActiveEffect", [{ name, img : status?.img ?? "icons/svg/aura.svg", statuses : [part.type], origin,
      duration, flags : { [module.id] : { cardCondition : true, ...(repeat ? { repeat } : {}) } } }]);
  }
}
