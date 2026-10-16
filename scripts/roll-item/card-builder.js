import { module } from '../module.js';
import { gm } from '../gm.js';
import { uses } from '../uses.js';
import { logger } from '../log.js';
import { cells, gridSteps } from '../helpers/tokens.js';
import { postTargetCard, registerTargetCards } from '../helpers/target-card.js';
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
 *   applyCondition({ when, type, with, duration, save, escape, repeat, insteadOfDamage, self })
 *     an Apply button (the target's owner or the GM) : one effect with the condition's own icon and name, from the
 *     item. with : more conditions in that same effect, ending with it (a grapple's Blinded, Restrained); its name
 *     then says where it's from ("Grappled: Animated Rug"). save : { ability, dc, repeat : "end" | "start" } a save at
 *     each of its turns ends it. escape : a grapple's escape DC (the Escape button uses it). repeat : { at, damage,
 *     type } damage at the start / end of each of its turns. insteadOfDamage : this or the hit's damage for that
 *     target, not both. self : a linked effect on the creature that did it ("Smothering: Ranger"); either ending ends
 *     the other. Already under that condition : the harsher one stays (the longer, then no save, then the higher DC).
 *   followUp(item, { when })   a button for the card's owner : that item's attack at the target, part of this use
 *                              (no Action of its own for the Action Tracker).
 *   extraDamage(formula, { type, when })   more damage on the hit, in the hit's own damage line (by type), rolled
 *                              when appended if a target's facts hold (doubled on a critical hit).
 *
 *   item.roll({ activity })    which of the item's activities (its index, id or name), when it has several.
 */
const KEY = "cardParts";
const uuidKey = uuid => String(uuid).replaceAll(".", "-");

/* ---------- Parts ---------- */

export function applyCondition({ type, when = [], with : also = [], duration = null, save = null, escape = null, repeat = null,
  insteadOfDamage = false, self = null, label = null } = {}){
  return { kind : "condition", type, when : [when].flat(), with : [also].flat().filter(Boolean), duration, save, escape, repeat,
    insteadOfDamage : !!insteadOfDamage, self, label };
}

export function followUp(item, { when = [], label = null } = {}){
  const name = (typeof item === "string") ? item : (item?.name ?? "");
  return { kind : "followUp", item : name, when : [when].flat(), label };
}

export function extraDamage(formula, { type = null, when = [], label = null } = {}){
  return { kind : "damage", formula : String(formula), type, when : [when].flat(), label };
}

/* Sizes, smallest first : isSmaller("medium") means Medium or smaller (as stat blocks say it) */
const SIZES = ["tiny", "sm", "med", "lg", "huge", "grg"];
const SIZE_NAMES = { tiny : "tiny", small : "sm", medium : "med", large : "lg", huge : "huge", gargantuan : "grg" };

export function isSmaller(thing, size){
  const actor = thing?.actor ?? thing;
  const own = SIZES.indexOf(actor?.system?.traits?.size);
  const most = SIZES.indexOf(SIZE_NAMES[String(size).toLowerCase()] ?? String(size).toLowerCase());
  return (own >= 0) && (most >= 0) && (own <= most);
}

/* ---------- Grapples ---------- */

/* The grapples on a creature : [{ effect, dc, by (the grappler : token or actor), byName }] */
export function grapplesOn(actor){
  return (actor?.effects?.contents ?? [...(actor?.effects ?? [])]).filter(e => !e.disabled && e.statuses?.has?.("grappled")).map(effect => {
    const f = effect.getFlag(module.id, "grapple") ?? {};
    let origin = null;
    try { origin = effect.origin ? fromUuidSync(effect.origin, { strict : false }) : null; } catch { origin = null; }
    const item = (origin?.documentName === "Item") ? origin : (origin?.item ?? null);
    const by = (f.by ? fromUuidSync(f.by, { strict : false }) : null) ?? item?.actor ?? null;
    const grappler = by?.actor ?? by;
    const save = [...(item?.system?.activities ?? [])].find(a => a.type === "save");
    const text = String(item?.system?.description?.value ?? "");
    const dc = Number(f.escape) || Number(save?.save?.dc?.value) || Number(text.match(/escape\s+DC\s+(\d+)/i)?.[1])
      || (grappler ? 8 + (Number(grappler.system?.abilities?.str?.mod) || 0) + (Number(grappler.system?.attributes?.prof) || 0) : 10);
    return { effect, dc, by, byName : by?.name ?? grappler?.name ?? "?" };
  });
}

/* The creatures it's grappling (read from their Grappled effects : nothing to keep up to date) */
export function grappling(thing){
  const doc = thing?.document ?? ((thing?.documentName === "TokenDocument") ? thing : (thing?.token ?? null));
  const actor = thing?.actor ?? ((thing?.documentName === "Actor") ? thing : null);
  const scene = doc?.parent ?? canvas.scene;
  const mine = by => !!by && ((doc && (by.uuid === doc.uuid)) || (actor && ((by.uuid === actor.uuid) || (by.actor?.uuid === actor.uuid) || (by.id === actor.id))));
  return (scene?.tokens?.contents ?? []).filter(t => t.actor && (t !== doc) && grapplesOn(t.actor).some(g => mine(g.by))).map(t => t.object ?? t);
}

/**
 * In a "Damage about to apply" (dnd5e.preApplyDamage) item-hook macro : the creature takes only part of the damage,
 * and another takes that same amount (Rug of Smothering : half, to the creature it smothers) : a card with that
 * creature's row and an Apply button (its owner or the GM).
 */
export function shareDamage(args, other, fraction = 0.5){
  const [actor, amount, updates, options] = args ?? [];
  const target = other?.actor ?? other;
  if(!actor || !updates || !(amount > 0) || !target || (target === actor)) return 0;
  const part = Math.floor(amount * fraction);
  const hp = actor.system?.attributes?.hp ?? {};
  const temp = Number(hp.temp) || 0;
  const fromTemp = Math.min(temp, part);
  updates["system.attributes.hp.temp"] = temp - fromTemp;
  updates["system.attributes.hp.value"] = Math.max(0, (Number(hp.value) || 0) - (part - fromTemp));
  /* The combat log : what it really took */
  if(options) options[module.id] = { ...(options[module.id] ?? {}), taken : part };
  if(part > 0) setTimeout(() => cardBuilder.postShared(actor, other, part).catch(error => log.debug("Shared damage", error)), 0);
  return part;
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
    if(!draft) return this;
    const rolls = await this.#extraDamage(draft);
    const update = { [`flags.${module.id}.${KEY}`] : draft };
    if(rolls.length){
      const { rollItem } = await import('./roll-item.js');
      await rollItem.showDice(rolls, this.message);
      update.rolls = [...this.message.rolls, ...rolls].map(r => JSON.stringify(r));
      if(game.dice3d) update["flags.dice-so-nice.skip"] = true;
    }
    await this.message.update(update);
    return this;
  }

  /* Extra damage parts whose facts hold for a target : rolled once, into the hit's own damage (doubled on a crit) */
  async #extraDamage(draft){
    const rolls = [];
    const attack = this.message.system?.attackRoll ?? null;
    const actor = this.message.getAssociatedActor?.();
    const rollData = this.message.getAssociatedActivity?.()?.getRollData?.() ?? actor?.getRollData?.() ?? {};
    for(const part of draft.parts){
      if((part.kind !== "damage") || part.rolled) continue;
      part.rolled = true;
      const facts = Object.values(part.facts ?? {});
      if(facts.length && !facts.some(Boolean)) continue;
      const type = part.type ?? this.message.system?.damageRolls?.[0]?.options?.type ?? null;
      const roll = new CONFIG.Dice.DamageRoll(part.formula, rollData, { type, types : type ? [type] : [], isCritical : !!attack?.isCritical });
      await roll.evaluate();
      rolls.push(roll);
    }
    return rolls;
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
  static async roll(item, { post = true, activity = null } = {}){
    /* Several activities (Plutonium's two Talons) : the one asked for, else dnd5e asks */
    const list = [...(item.system?.activities ?? [])];
    const chosen = (activity === null) ? null : (Number.isInteger(activity) ? list[activity] : list.find(a => (a.id === activity) || (a.name === activity)));
    const config = { [module.id] : { skipMacro : true } };
    const results = chosen ? await chosen.use(config) : await item.use(config);
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
     item.roll(), token.chargedAt(target, feet), creature.isSmaller(size), creature.grappling() (never over an existing method) */
  static addMethods(){
    const add = (cls, name, fn) => {
      const proto = cls?.prototype;
      if(!proto || (name in proto)) return;
      Object.defineProperty(proto, name, { value : fn, writable : true, configurable : true, enumerable : false });
    };
    const self = this;
    add(CONFIG.Item.documentClass, "roll", function(options){ return self.roll(this, options); });
    for(const cls of [CONFIG.Actor.documentClass, CONFIG.Token.documentClass, CONFIG.Token.objectClass]){
      add(cls, "isSmaller", function(size){ return isSmaller(this, size); });
      add(cls, "grappling", function(){ return grappling(this); });
    }
    for(const cls of [CONFIG.Token.documentClass, CONFIG.Token.objectClass]) add(cls, "chargedAt", function(target, feet, options){ return chargedAt(this, target, feet, options); });
  }

  static register(){
    Hooks.once("setup", () => this.addMethods());
    gm.handle("cardRelease", (data, user) => this.releaseAsGM(data, user));
    gm.handle("cardShared", (data, user) => this.sharedAsGM(data, user));
    registerTargetCards();
    /* This instead of the damage : that creature takes none of the card's damage */
    Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options = {}) => {
      const card = options.origin;
      const tokens = (actor?.getActiveTokens?.(false, true) ?? []).map(t => uuidKey((t.document ?? t).uuid));
      const instead = card?.getFlag?.(module.id, "cardInstead") ?? {};
      if(!(amount > 0) || !tokens.some(k => instead[k])) return;
      ui.notifications.info(module.format("cardBuilder.insteadOfDamage", { name : actor.name }));
      return false;
    });
    /* A linked effect (a grapple and its grappler's Smothering) : one ending ends the other (the active GM) */
    Hooks.on("deleteActiveEffect", (effect, options = {}) => {
      if(!game.users.activeGM?.isSelf) return;
      const linked = effect.getFlag?.(module.id, "linked");
      const other = linked ? fromUuidSync(linked, { strict : false }) : null;
      if(other) other.delete({ [module.id] : { reason : options?.[module.id]?.reason ?? module.format("cardBuilder.endedWith", { name : effect.name }) } }).catch(() => null);
    });
    gm.handle("cardCondition", (data, user) => this.conditionAsGM(data, user));
    gm.handle("cardPartDone", (data, user) => this.doneAsGM(data, user));
    /* Each target's row : its parts as buttons */
    Hooks.on(`${module.id}.rowButtons`, (message, uuid, buttons, { result } = {}) => {
      const parts = message.getFlag?.(module.id, KEY)?.parts ?? [];
      parts.forEach((part, index) => {
        if(!this.shown(part, uuid, result)) return;
        const done = !!message.getFlag(module.id, `cardDone.${index}.${uuidKey(uuid)}`);
        const target = fromUuidSync(uuid, { strict : false });
        /* This or the damage : once the damage is applied to it, the choice is made */
        if(part.insteadOfDamage && !done && Object.keys(target?.actor?.getFlag?.(module.id, `applied.${message.id}`) ?? {}).length) return;
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
      if(ok) await gm.run("cardPartDone", { message : message.id, index, target : uuid, instead : part.insteadOfDamage });
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
    const sourceToken = message.getAssociatedToken?.() ?? null;
    await this.applyConditionTo(actor, part, { origin : item?.uuid ?? null, by : message.getAssociatedActor?.() ?? null, sourceToken, targetToken : fromUuidSync(uuid, { strict : false }) });
    return true;
  }

  static async doneAsGM({ message : id, index, target : uuid, instead = false } = {}){
    const message = game.messages.get(id);
    if(!message) return false;
    await message.setFlag(module.id, `cardDone.${index}.${uuidKey(uuid)}`, true);
    if(instead) await message.setFlag(module.id, `cardInstead.${uuidKey(uuid)}`, true);
    return true;
  }

  /* GM : a grappler lets go (its owner or the GM pressed Release) */
  static async releaseAsGM({ target : uuid, by } = {}, user){
    const token = fromUuidSync(uuid ?? "", { strict : false });
    const grappler = fromUuidSync(by ?? "", { strict : false });
    const owner = grappler?.actor ?? grappler;
    if(!token?.actor || !(user.isGM || owner?.testUserPermission?.(user, "OWNER"))) return false;
    const mine = g => g.by && ((g.by.uuid === grappler?.uuid) || (g.by.actor?.uuid === owner?.uuid) || (g.by.uuid === owner?.uuid));
    const ids = grapplesOn(token.actor).filter(mine).map(g => g.effect.id);
    if(ids.length) await token.actor.deleteEmbeddedDocuments("ActiveEffect", ids, { [module.id] : { reason : module.format("cardBuilder.released", { name : grappler?.name ?? "" }) } });
    return true;
  }

  /* The shared damage's card : one row, Apply (the creature's owner or the GM) */
  static async postShared(from, other, amount){
    const token = (other?.document ?? other);
    const tokenDoc = (token?.documentName === "TokenDocument") ? token : (other?.actor ?? other)?.getActiveTokens?.(false, true)?.[0] ?? null;
    if(!tokenDoc) return;
    /* The feature it comes from : the effect that links them (the Rug's Smothering), else none */
    const link = from.effects?.find?.(e => e.getFlag(module.id, "holding") === tokenDoc.uuid);
    const item = link?.origin ? fromUuidSync(link.origin, { strict : false }) : null;
    await postTargetCard({ actor : from, item : item ?? { name : from.name, img : from.img, labels : {} },
      text : module.format("cardBuilder.sharedText", { name : tokenDoc.name, n : amount, from : from.name }),
      rows : [{ token : tokenDoc.uuid, label : module.format("cardBuilder.sharedApply", { n : amount }), action : "cardShared",
        data : { token : tokenDoc.uuid, amount, from : from.name }, done : module.format("cardBuilder.sharedDone", { n : amount }) }] });
  }

  static async sharedAsGM({ token : uuid, amount, from } = {}, user){
    const actor = fromUuidSync(uuid ?? "", { strict : false })?.actor;
    if(!actor || !(user.isGM || actor.testUserPermission(user, "OWNER"))) return false;
    await actor.applyDamage(Number(amount) || 0, { [module.id] : { shared : { from } } });
    return true;
  }

  static async release(grappler, target){
    const by = (grappler?.document ?? grappler)?.uuid;
    const uuid = (target?.document ?? target)?.uuid;
    if(by && uuid) await gm.run("cardRelease", { target : uuid, by });
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

  static async applyConditionTo(actor, part, { origin = null, by = null, sourceToken = null, targetToken = null } = {}){
    const status = CONFIG.statusEffects.find(s => s.id === part.type);
    const base = game.i18n.localize(status?.name ?? part.type);
    const source = sourceToken?.name ?? by?.name ?? "";
    /* Several conditions, an escape DC or a linked effect : the name says where it's from */
    const name = part.label ?? ((part.with?.length || part.escape || part.self) && source ? `${base}: ${source}` : base);
    const duration = (typeof part.duration === "number") ? { rounds : part.duration } : (part.duration ?? {});
    const at = part.repeat?.at ?? part.save?.repeat ?? "end";
    const repeat = (part.save || part.repeat) ? { label : at, from : { item : origin, actor : by?.uuid ?? null },
      roll : part.save ? { type : "save", ability : part.save.ability, dc : Number(part.save.dc) || null } : null,
      when : { at, of : actor.uuid },
      damage : part.repeat?.damage ? `(${part.repeat.damage})${part.repeat.type ? `[${part.repeat.type}]` : ""}` : null } : null;
    const incoming = { duration, save : part.save };
    /* Already under it : the harsher stays */
    const existing = actor.effects.filter(e => !e.disabled && e.statuses?.has?.(part.type));
    for(const e of existing){
      const old = { duration : e.duration, save : e.getFlag(module.id, "repeat")?.roll ?? null };
      if(this.harsher(old, incoming) === old) return log.debug("Kept the harsher", part.type, actor.name);
    }
    if(existing.length) await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map(e => e.id),
      { [module.id] : { reason : module.format("cardBuilder.replaced", { name }) } }).catch(() => null);
    const grapple = (part.type === "grappled") ? { grapple : { by : sourceToken?.uuid ?? by?.uuid ?? null, escape : Number(part.escape) || null } } : {};
    const [made] = await actor.createEmbeddedDocuments("ActiveEffect", [{ name, img : status?.img ?? "icons/svg/aura.svg",
      statuses : [part.type, ...(part.with ?? [])], origin, duration,
      flags : { [module.id] : { cardCondition : true, ...(repeat ? { repeat } : {}), ...grapple } } }]);
    /* The doer's linked effect (the Rug's Smothering) : either ending ends the other */
    const doer = sourceToken?.actor ?? by;
    if(made && part.self && doer){
      const [mine] = await doer.createEmbeddedDocuments("ActiveEffect", [{ name : `${part.self}: ${targetToken?.name ?? actor.name}`,
        img : fromUuidSync(origin ?? "", { strict : false })?.img ?? "icons/svg/aura.svg", origin,
        flags : { [module.id] : { linked : made.uuid, holding : targetToken?.uuid ?? null } } }]);
      if(mine) await made.setFlag(module.id, "linked", mine.uuid);
    }
  }
}
