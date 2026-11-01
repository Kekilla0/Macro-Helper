import { module } from '../module.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { idOf } from '../helpers/utils.js';
import { groupTravel } from './group-travel.js';
import { groupInventory } from './group-inventory.js';
import { groupCamp } from './group-camp.js';
import { groupFood } from './group-food.js';
const log = logger.for(import.meta.url);

/**
 * Group Travel : the Meal window (Food and water on). Everything eaten or drunk is a carried item.
 *   It opens after a rest whose window had "Meal during rest" ticked (dnd5e's Short or Long Rest, a sheet's own or the
 *   group's), and at the camp's meal. Each user gets the creatures they own (the GM : those whose players are away).
 *   Each member : food and water bars of ten steps (tenths of the day's need) as eaten so far today and after; a source
 *   (Automatic : spoiling food first, then its own stores, then the pack animals' and vehicles'; one stack of its own,
 *   a pack's, another member's when the user owns that one or runs the group; free food nearby or the inn's meal at the
 *   camp) and an amount (lb / gal; Rations come off in parts : flag eaten, the part of one already gone). A Goodberry
 *   berry fills the day's food; its caster can cast Goodberry from the window.
 *   Found food (Forage, Hunt) is a "Foraged food" item, Create Food and Water a 45 lb "Created food" (made by magic : no
 *   Preserve), both given to the member new items go to (flag arrivals); both spoil at midnight (flag spoils; the clock
 *   put back past it brings them back). Water needs a container : found or created water fills the waterskins and the
 *   rest is lost; water readily there (nearby, an inn, found at the camp) is drunk at once by everyone, then fills them.
 */
export class groupMeal{
  static FORAGED = "foraged-food";
  static CREATED = "created-food";
  static CREATE_SPELL = "create-food-and-water";
  static CREATED_LB = 45;
  static CREATED_GAL = 30;
  static STEPS = 10;
  static #windows = new Map();
  static #App = null;
  static #rested = new Map();

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("renderShortRestDialog", (app, html) => this.restTick(app, html, "short"));
    Hooks.on("renderLongRestDialog", (app, html) => this.restTick(app, html, "long"));
    Hooks.on("dnd5e.restCompleted", (actor, result, config) => this.rested(actor, config));
    Hooks.on("updateActor", (actor, changes) => this.changed(actor, changes));
    for(const hook of ["createItem", "updateItem", "deleteItem"]) Hooks.on(hook, item => item?.parent && this.redraw());
    Hooks.on("dnd5e.postUseActivity", activity => this.cast(activity));
    Hooks.on(`${module.id}.dayEnded`, info => this.dayEnded(info).catch(error => log.error("Meal, day's end", error)));
    Hooks.on(`${module.id}.dayUndone`, info => this.dayUndone(info).catch(error => log.error("Meal, day undone", error)));
    gm.handle("groupMeal", (data, user) => this.asGM(data, user));
  }

  static enabled(){
    return groupFood.enabled();
  }

  static i18n(key, data){
    return data ? game.i18n.format(`groupTravel.meal.${key}`, data) : game.i18n.localize(`groupTravel.meal.${key}`);
  }

  static esc(text){
    return foundry.utils.escapeHTML(String(text ?? ""));
  }

  static round(n){
    return Math.round(n * 100) / 100;
  }

  /* ---------- Stores ---------- */

  static spoils(item){
    return !!item?.getFlag?.(module.id, "spoils");
  }

  static berry(item){
    return !!item?.getFlag?.(module.id, "goodberry") || /goodberr/.test(idOf(item));
  }

  /* Units left in a stack : its quantity less the part of one already eaten */
  static unitsLeft(item){
    return Math.max(0, (Number(item.system.quantity) || 0) - (Number(item.getFlag(module.id, "eaten")) || 0));
  }

  /* Food (lb) one unit gives this eater : a day of feed is an animal's day (Beasts only), a berry its whole day */
  static perUnit(item, eater){
    if(/^feed/.test(idOf(item))) return groupCamp.isBeast(eater) ? groupCamp.need(eater) : 0;
    if(this.berry(item)) return groupCamp.need(eater);
    return groupFood.nourishOf(item, eater)?.food ?? 0;
  }

  /* Whose stores this user may give this member : its own, the pack animals' and vehicles', another member's they own
     (any member's for the group's runner) */
  static holders(group, actor, user = game.user){
    const runner = groupCamp.canRun(group, user);
    const others = groupCamp.members(group).filter(a => (a !== actor) && (runner || a.testUserPermission(user, "OWNER")));
    return [...new Set([actor, ...groupInventory.packs(group), ...others])];
  }

  static foodItems(holder, eater){
    return holder.items.filter(i => (i.type === "consumable") && (this.unitsLeft(i) > 1e-9) && (this.perUnit(i, eater) > 0));
  }

  /* The sources a member may eat (drink) from : [{ key, label, have (lb / gal; a berry : count), item }] */
  static sources(group, actor, kind, free = null, user = game.user){
    const holders = this.holders(group, actor, user);
    const name = (item, holder) => (holder === actor) ? item.name : `${item.name} (${holder.name})`;
    const list = [];
    if(kind === "food"){
      if(free) list.push({ key : "free", label : this.i18n(`free.${free}`), have : Infinity });
      for(const holder of holders) for(const item of this.foodItems(holder, actor)){
        const berry = this.berry(item);
        list.push({ key : item.uuid, item, berry, label : name(item, holder), have : berry ? Math.floor(this.unitsLeft(item)) : this.round(this.unitsLeft(item) * this.perUnit(item, actor)) });
      }
    }
    else for(const holder of holders) for(const item of groupCamp.skins(holder)){
      const have = this.round(groupCamp.waterIn(item));
      if(have > 0) list.push({ key : item.uuid, item, label : name(item, holder), have });
    }
    const auto = this.autoItems(group, actor, kind, user);
    const total = this.round(auto.reduce((s, i) => s + ((kind === "food") ? this.unitsLeft(i) * this.perUnit(i, actor) : groupCamp.waterIn(i)), 0));
    /* Free food first : the default pick */
    const first = (list[0]?.key === "free") ? [list.shift()] : [];
    return [...first, { key : "auto", label : this.i18n("auto"), have : total }, ...list];
  }

  /* Automatic : spoiling food first (anyone's this user may give), then its own stores (a Beast : feed first), then the
     pack animals' and vehicles'; no berries */
  static autoItems(group, actor, kind, user = game.user){
    const packs = groupInventory.packs(group).filter(a => a !== actor);
    if(kind === "water") return [actor, ...packs].flatMap(a => groupCamp.skins(a)).filter(i => groupCamp.waterIn(i) > 0);
    const plain = holder => this.foodItems(holder, actor).filter(i => !this.berry(i) && !this.spoils(i))
      .sort((a, b) => Number(/^feed/.test(idOf(b))) - Number(/^feed/.test(idOf(a))));
    const spoiling = this.holders(group, actor, user).flatMap(h => this.foodItems(h, actor)).filter(i => this.spoils(i));
    return [...spoiling, ...plain(actor), ...packs.flatMap(plain)];
  }

  /* Eats up to `lb` from a stack (parts of a unit kept on it); returns the lb eaten */
  static async eatFrom(item, lb, eater){
    const per = this.perUnit(item, eater);
    if(!(per > 0) || !(lb > 0)) return 0;
    const units = Math.min(this.unitsLeft(item), lb / per);
    const eaten = (Number(item.getFlag(module.id, "eaten")) || 0) + units;
    const whole = Math.floor(eaten + 1e-9);
    const quantity = (Number(item.system.quantity) || 0) - whole;
    const part = this.round(eaten - whole);
    if((quantity <= 0) || ((quantity === 1) && (part >= 1 - 1e-9))) await item.delete();
    else await item.update({ "system.quantity" : quantity, [`flags.${module.id}.eaten`] : part });
    return this.round(units * per);
  }

  static async drinkFrom(item, gal){
    const has = groupCamp.waterIn(item);
    const sip = Math.min(has, Math.max(0, gal));
    if(sip > 0) await item.setFlag(module.id, "water", this.round(has - sip));
    return this.round(sip);
  }

  /* ---------- On the GM's client ---------- */

  static async asGM({ op, ...data }, user){
    if(!this.enabled()) return false;
    const group = data.group ? await fromUuid(data.group) : null;
    try {
      if(op === "call"){
        if(group?.type !== "group") return false;
        const ids = (data.ids ?? []).filter(id => { const a = groupTravel.memberActor(group, id); return a && (user.isGM || a.testUserPermission(user, "OWNER")); });
        if(ids.length) await this.callAsGM(group, ids, data.free ?? {});
        return true;
      }
      if(op === "eat") return this.eatAsGM(group, data, user);
      if(op === "created"){
        const actor = await fromUuid(data.actor);
        if(!actor?.testUserPermission(user, "OWNER")) return false;
        return this.createdAsGM(actor);
      }
    } catch(error){ log.error(`Meal ${op}`, error); }
    return false;
  }

  /* The call each client answers (flag mealCall { key, ids, free : [[actorId, "nearby" | "grazing" | "inn"]] : a list,
     so a new call replaces it) */
  static callAsGM(group, ids, free = {}){
    return group.setFlag(module.id, "mealCall", { key : foundry.utils.randomID(), ids, free : Object.entries(free), at : game.time.worldTime });
  }

  static freeOf(group, actor){
    return Object.fromEntries(groupTravel.flag(group, "mealCall")?.free ?? [])[actor.id] ?? null;
  }

  static async eatAsGM(group, { actor : uuid, food = null, water = null } = {}, user){
    const actor = await fromUuid(uuid ?? "");
    if((group?.type !== "group") || !actor || !groupFood.tracked(group, actor) || !(user.isGM || actor.testUserPermission(user, "OWNER"))) return false;
    const holders = this.holders(group, actor, user);
    const today = groupFood.intakeOf(actor);
    const needs = groupFood.needs(actor, today);
    const got = { food : 0, water : 0 };
    const pick = key => {
      if(key === "auto") return "auto";
      const item = fromUuidSync(key ?? "", { strict : false });
      return (item && holders.includes(item.parent)) ? item : null;
    };
    if(food?.source){
      const amount = Math.max(0, Number(food.amount) || 0);
      const free = this.freeOf(group, actor);
      if(food.source === "free"){ if(free) got.food = amount; }
      else {
        const from = pick(food.source);
        if(from === "auto"){
          for(const item of this.autoItems(group, actor, "food", user)){
            if(got.food >= amount - 1e-9) break;
            got.food += await this.eatFrom(item, amount - got.food, actor);
          }
        }
        /* A berry : a day's food at once */
        else if(from && this.berry(from)){
          if((this.unitsLeft(from) >= 1) && (needs.food > today.food)){ await this.eatFrom(from, groupCamp.need(actor), actor); got.food = Math.max(0, needs.food - today.food); }
        }
        else if(from) got.food = await this.eatFrom(from, amount, actor);
      }
    }
    if(water?.source){
      const amount = Math.max(0, Number(water.amount) || 0);
      const from = pick(water.source);
      const skins = (from === "auto") ? this.autoItems(group, actor, "water", user) : (from && groupCamp.skins(from.parent).includes(from)) ? [from] : [];
      for(const item of skins){
        if(got.water >= amount - 1e-9) break;
        got.water += await this.drinkFrom(item, amount - got.water);
      }
    }
    got.food = this.round(got.food); got.water = this.round(got.water);
    await groupFood.record(actor, got);
    return got;
  }

  /* ---------- Asking for the meal ---------- */

  /* The members to feed (tracked ones), on every client that answers for them */
  static call(group, ids, free = {}){
    if(!this.enabled() || (group?.type !== "group")) return;
    ids = ids.filter(id => groupFood.tracked(group, groupTravel.memberActor(group, id)));
    if(ids.length) return gm.run("groupMeal", { op : "call", group : group.uuid, ids, free });
  }

  /* Who this client feeds : a player their own creatures; the GM those no active player owns */
  static answers(actor, user = game.user){
    if(!actor) return false;
    if(user.isGM) return !game.users.some(u => u.active && !u.isGM && actor.testUserPermission(u, "OWNER"));
    return actor.testUserPermission(user, "OWNER");
  }

  static changed(actor, changes){
    if((actor.type === "group") && foundry.utils.hasProperty(changes, `flags.${module.id}.mealCall.key`)){
      const call = groupTravel.flag(actor, "mealCall");
      const ids = (call?.ids ?? []).filter(id => this.answers(groupTravel.memberActor(actor, id)));
      if(ids.length && this.enabled()) this.open(actor, ids);
    }
    if(foundry.utils.hasProperty(changes, `flags.${module.id}.intake`) || foundry.utils.hasProperty(changes, "system.traits")) this.redraw();
  }

  /* dnd5e's rest windows : "Meal during rest" (a Long Rest ticked to start with) */
  static restTick(app, html, rest){
    const actor = app.actor ?? app.options?.document;
    const root = (html instanceof HTMLElement) ? html : (app.element ?? html?.[0]);
    if(!this.enabled() || !actor?.isOwner || !root || root.querySelector(".macro-helper-meal-tick")) return;
    const fed = (actor.type === "group") ? groupTravel.creatures(actor).some(a => groupFood.tracked(actor, a))
      : groupTravel.groupsOf(actor).some(g => groupFood.tracked(g, actor));
    if(!fed) return;
    const section = root.querySelector("section.flexcol") ?? root.querySelector("form") ?? root;
    /* The window draws again on each change : the tick as the rest's config has it */
    const on = app.config?.[module.id]?.meal ?? (rest === "long");
    const box = document.createElement("div");
    box.className = "form-group macro-helper-meal-tick";
    box.innerHTML = `<label>${this.i18n("tick")}</label>
      <div class="form-fields"><input type="checkbox" name="${module.id}.meal" ${on ? "checked" : ""}></div>
      <p class="hint">${this.i18n("tickHint")}</p>`;
    section.append(box);
  }

  /* A rest done with the tick : its members gathered (a group's rest rests them one after the other), then called */
  static rested(actor, config){
    if(!config?.[module.id]?.meal || !this.enabled() || (actor?.type === "group") || !actor?.isOwner) return;
    const group = groupTravel.groupsOf(actor).find(g => groupFood.tracked(g, actor));
    if(!group) return;
    const entry = this.#rested.get(group.uuid) ?? { ids : new Set(), timer : null };
    entry.ids.add(actor.id);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { this.#rested.delete(group.uuid); this.call(group, [...entry.ids]); }, 500);
    this.#rested.set(group.uuid, entry);
  }

  /* ---------- Spells : Create Food and Water ---------- */

  static cast(activity){
    const actor = activity?.actor;
    if(!this.enabled() || (idOf(activity?.item) !== this.CREATE_SPELL) || !actor?.isOwner) return;
    gm.run("groupMeal", { op : "created", actor : actor.uuid });
  }

  /* 45 lb of food to the member new items go to (else the caster), 30 gallons filling the waterskins (the rest lost) */
  static async createdAsGM(caster){
    const group = groupTravel.groupsOf(caster)[0] ?? null;
    const holder = (group && groupTravel.arrivalHolder(group).actor) || caster;
    await this.giveFood(holder, { identifier : this.CREATED, name : this.i18n("created"), lb : this.CREATED_LB, made : true });
    const actors = group ? [...groupCamp.members(group), ...groupInventory.packs(group)] : [caster];
    const filled = await this.fillSkins([...new Set(actors)], this.CREATED_GAL);
    await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor : caster }),
      content : `<div class="macro-helper-group-log"><p>${this.i18n("createdLine", { lb : this.CREATED_LB, name : this.esc(holder.name), filled : this.round(filled), lost : this.round(this.CREATED_GAL - filled) })}</p></div>` });
    return true;
  }

  /* ---------- Food found or made, water found ---------- */

  /* Food given as an item : added to the holder's stack of it (spoils at midnight; made : by magic) */
  static async giveFood(holder, { identifier, name, lb, made = false }){
    lb = Math.floor(lb + 1e-9);
    if(!holder || (lb <= 0)) return null;
    const stack = holder.items.find(i => (idOf(i) === identifier) && this.spoils(i));
    if(stack) return stack.update({ "system.quantity" : (Number(stack.system.quantity) || 0) + lb });
    return holder.createEmbeddedDocuments("Item", [{ name, type : "consumable", img : made ? "icons/consumables/food/bowl-stew-brown.webp" : "icons/consumables/food/berries-ration-round-red.webp",
      system : { identifier, quantity : lb, weight : { value : 1, units : "lb" }, type : { value : "food" } },
      flags : { [module.id] : { spoils : true, made, nourish : { food : 1, water : 0 } } } }]);
  }

  /* Water poured into these creatures' waterskins, in order; returns the gallons used */
  static async fillSkins(actors, gallons = Infinity){
    let used = 0;
    for(const item of actors.flatMap(a => groupCamp.skins(a))){
      const room = groupCamp.skinMax(item) - groupCamp.waterIn(item);
      const fill = Math.min(room, gallons - used);
      if(fill <= 1e-9) continue;
      await item.setFlag(module.id, "water", this.round(groupCamp.waterIn(item) + fill));
      used += fill;
    }
    return used;
  }

  /* Water readily there : each tracked member drinks up to its day's need, then the waterskins fill; returns the lines */
  static async drinkThere(group, actors, gallons = Infinity){
    let left = gallons;
    const lines = [];
    for(const actor of actors){
      if(!groupFood.tracked(group, actor)) continue;
      const today = groupFood.intakeOf(actor);
      const sip = Math.min(left, Math.max(0, groupFood.needs(actor, today).water - today.water));
      if(sip <= 0) continue;
      await groupFood.record(actor, { water : this.round(sip) });
      left -= sip;
    }
    left -= await this.fillSkins([...actors, ...groupInventory.packs(group)], left);
    if(Number.isFinite(gallons) && (left > 0.01)) lines.push(this.i18n("waterLost", { gal : this.round(left) }));
    return lines;
  }

  /* ---------- Midnight : spoiling food gone (put back with the clock) ---------- */

  static async dayEnded({ at }){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    /* A camp's Preserve takes what's left first */
    for(const group of game.actors.filter(a => (a.type === "group") && groupCamp.running(a))) await groupCamp.preserveLeft(group);
    const gone = [];
    for(const actor of game.actors){
      const items = actor.items.filter(i => this.spoils(i));
      if(!items.length) continue;
      for(const item of items) gone.push({ actor : actor.uuid, name : actor.name, data : item.toObject() });
      await actor.deleteEmbeddedDocuments("Item", items.map(i => i.id));
    }
    if(!gone.length) return;
    const lines = gone.map(g => this.i18n("spoiledLine", { item : this.esc(g.data.name), n : this.round(g.data.system?.quantity ?? 1), name : this.esc(g.name) }));
    await ChatMessage.implementation.create({ whisper : game.users.filter(u => u.isGM).map(u => u.id),
      content : `<div class="macro-helper-group-log"><p><strong><i class="fa-solid fa-trash" inert></i> ${this.i18n("spoiled")}</strong></p>${lines.map(l => `<p>${l}</p>`).join("")}</div>`,
      flags : { [module.id] : { spoiled : { at, gone } } } });
  }

  static async dayUndone({ at }){
    if(!game.users.activeGM?.isSelf) return;
    for(const message of game.messages.filter(m => (m.getFlag(module.id, "spoiled")?.at === at) && !m.getFlag(module.id, "spoiled")?.undone)){
      for(const { actor : uuid, data } of message.getFlag(module.id, "spoiled").gone ?? []){
        const actor = await fromUuid(uuid);
        if(actor) await actor.createEmbeddedDocuments("Item", [data], { keepId : !actor.items.has(data._id) });
      }
      await message.setFlag(module.id, "spoiled.undone", true);
    }
  }

  /* ---------- The window ---------- */

  static redraw(){
    for(const [uuid, app] of this.#windows){
      if(!app.rendered) { this.#windows.delete(uuid); continue; }
      app.render();
    }
  }

  static open(group, ids){
    const self = this;
    this.#App ??= class MealWindow extends foundry.applications.api.ApplicationV2{
      static DEFAULT_OPTIONS = { classes : ["macro-helper-meal"], window : { icon : "fa-solid fa-bowl-food", resizable : true }, position : { width : 640, height : "auto" } };
      picks = {};
      get title(){ return `${this.options.group.name} : ${self.i18n("title")}`; }
      async _renderHTML(){ return self.html(this); }
      _replaceHTML(result, content){ content.innerHTML = result; self.listen(this, content); }
    };
    let app = this.#windows.get(group.uuid);
    if(app?.rendered) app.options.ids = [...new Set([...app.options.ids, ...ids])];
    else { app = new this.#App({ group, ids, id : `macro-helper-meal-${group.id}` }); this.#windows.set(group.uuid, app); }
    app.render({ force : true });
  }

  /* The row's pick for a kind : the source kept, else Automatic; the amount kept, else what's missing to the need */
  static pickOf(app, actor, kind, sources, missing){
    const kept = app.picks[actor.id]?.[kind] ?? {};
    const source = sources.find(s => s.key === kept.source) ?? sources[0];
    const most = source.berry ? missing : Math.min(source.have, missing);
    const amount = source.berry ? missing : Math.max(0, Math.min(source.have, ("amount" in kept) ? Number(kept.amount) || 0 : most));
    return { source, amount : this.round(amount) };
  }

  /* Ten steps : had today, what this adds, the half mark */
  static bar(had, add, need){
    const step = need / this.STEPS;
    const cells = Array.from({ length : this.STEPS }, (_, i) => {
      const top = (i + 1) * step - 1e-9;
      return `<i class="${(had >= top) ? "had" : (had + add >= top) ? "add" : ""} ${(i === this.STEPS / 2 - 1) ? "half" : ""}"></i>`;
    }).join("");
    return `<span class="meal-bar ${(had + add < need / 2) ? "short" : ""}">${cells}</span>`;
  }

  static html(app){
    const group = app.options.group;
    const actors = app.options.ids.map(id => groupTravel.memberActor(group, id)).filter(a => a && groupFood.tracked(group, a) && (game.user.isGM || a.isOwner));
    const e = t => this.esc(t);
    const rows = actors.map(actor => {
      const today = groupFood.intakeOf(actor);
      const needs = groupFood.needs(actor, today);
      const line = (kind, icon, unit) => {
        const sources = this.sources(group, actor, kind, (kind === "food") ? this.freeOf(group, actor) : null);
        const missing = this.round(Math.max(0, needs[kind] - today[kind]));
        const { source, amount } = this.pickOf(app, actor, kind, sources, missing);
        const have = s => (s.have === Infinity) ? "" : s.berry ? ` : ${this.i18n("berries", { n : s.have })}` : ` : ${s.have} ${unit}`;
        const options = sources.map(s => `<option value="${e(s.key)}" ${(s === source) ? "selected" : ""}>${e(s.label + have(s))}</option>`).join("");
        return `<div class="line" data-kind="${kind}">
          <i class="fa-solid ${icon}" inert></i>
          ${this.bar(today[kind], 0, needs[kind])}
          <span class="had">${this.round(today[kind])} / ${this.round(needs[kind])} ${unit}</span>
          <select data-kind="${kind}" data-berry="${!!source.berry}">${options}</select>
          <input type="number" data-kind="${kind}" min="0" step="0.1" value="${amount}" ${(source.berry || !(source.have > 0)) ? "disabled" : ""}> ${unit}
          <i class="fa-solid fa-arrow-right" inert></i> ${this.bar(today[kind], source.berry ? missing : amount, needs[kind])}</div>`;
      };
      const goodberry = actor.isOwner ? actor.items.find(i => (i.type === "spell") && (idOf(i) === "goodberry")) : null;
      return `<section class="member" data-id="${actor.id}">
        <header><img src="${e(actor.img)}" alt=""><span>${e(actor.name)}</span>
          ${goodberry ? `<button type="button" class="goodberry" data-tooltip="${e(this.i18n("goodberryHint"))}"><i class="fa-solid fa-seedling" inert></i> ${e(goodberry.name)}</button>` : ""}</header>
        ${line("food", "fa-drumstick-bite", game.i18n.localize("groupTravel.camp.lb"))}
        ${line("water", "fa-droplet", game.i18n.localize("groupTravel.camp.gal"))}</section>`;
    }).join("");
    return `${rows || `<p class="hint">${this.i18n("nobody")}</p>`}
      <p class="hint">${this.i18n("hint")}</p>
      <footer class="form-footer"><button type="button" data-op="eat" ${rows ? "" : "disabled"}><i class="fa-solid fa-utensils" inert></i> ${this.i18n("eat")}</button></footer>`;
  }

  static listen(app, content){
    const group = app.options.group;
    const keep = (input, key, value) => {
      const id = input.closest("[data-id]").dataset.id, kind = input.dataset.kind;
      const row = (app.picks[id] ??= {});
      row[kind] = (key === "source") ? { source : value } : { ...(row[kind] ?? {}), amount : value };
      app.render();
    };
    for(const select of content.querySelectorAll("select[data-kind]")) select.addEventListener("change", () => keep(select, "source", select.value));
    for(const input of content.querySelectorAll("input[data-kind]")) input.addEventListener("change", () => keep(input, "amount", input.value));
    for(const button of content.querySelectorAll(".goodberry")){
      button.addEventListener("click", () => {
        const actor = groupTravel.memberActor(group, button.closest("[data-id]").dataset.id);
        actor?.items.find(i => (i.type === "spell") && (idOf(i) === "goodberry"))?.use();
      });
    }
    content.querySelector("[data-op='eat']")?.addEventListener("click", async event => {
      event.currentTarget.disabled = true;
      for(const section of content.querySelectorAll("section.member")){
        const actor = groupTravel.memberActor(group, section.dataset.id);
        const picks = {};
        for(const kind of ["food", "water"]){
          const select = section.querySelector(`select[data-kind="${kind}"]`);
          const amount = Number(section.querySelector(`input[data-kind="${kind}"]`)?.value) || 0;
          if(select && ((amount > 0) || (select.dataset.berry === "true"))) picks[kind] = { source : select.value, amount };
        }
        if(actor && Object.keys(picks).length) await gm.run("groupMeal", { op : "eat", group : group.uuid, actor : actor.uuid, ...picks });
      }
      app.close();
    });
  }
}
