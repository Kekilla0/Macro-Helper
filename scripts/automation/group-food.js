import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { idOf, buttonRow, addButton, makeButton } from '../helpers/utils.js';
import { rollRequests } from '../requests/requests.js';
import { groupTravel } from './group-travel.js';
import { groupCamp } from './group-camp.js';
import { groupInventory } from './group-inventory.js';
const log = logger.for(import.meta.url);

/**
 * Group Travel : Food and water (setting foodWater, Rules → Travel; rules foodWaterRules : 2024 PHB or Homebrew, whose
 * switches change the 2024 rules). Each creature member of a group is tracked unless the GM unticks it (Members tab).
 *   What each eats and drinks is kept by the day (flag intake { day's midnight : { food, water, hot } }) whenever it
 *   happens : the camp's meal, the Journey card's Meal (everyone tops up to a day's need, Full or Half, from their own
 *   stores then the pack animals' and vehicles'), a member card's Eat / Drink, or using a food item anywhere (a Ration :
 *   1 lb; a pint of water : 1/8 gallon; a Goodberry berry : a day's food; any other food : 1 lb; an item's flag
 *   macro-helper.nourish { food, water } says otherwise).
 *   The day's end (macro-helper.dayEnded, on the GM's client), 2024 PHB Dehydration / Malnutrition : less than half the
 *   day's water : 1 Exhaustion level. Some food but less than half : a DC 10 Constitution save card (whispered; a
 *   failure's Exhaustion +1 button). No food at all : nothing until the end of the 5th day in a row, then 1 level that
 *   day and each day after. Levels from either are kept on the creature (flag hunger { starve, short, food, water }) with
 *   dnd5e's Malnutrition / Dehydration status : a Long Rest lowers Exhaustion only down to them; a day with the full
 *   amount (food or water) frees them. One card to the GM lists the day; its Undo (or the clock put back past that
 *   midnight) takes it all back : the levels given, the save cards, the counts.
 *   Homebrew : No food is no safer (a day without food makes the save too), Hunger grows (the save's DC +2 for each
 *   day in a row short of food), Thirst save (some water but less than half : a DC 15 Constitution save instead),
 *   Hot days (a day with Extreme Heat doubles the water needed).
 */
export class groupFood{
  static PINT = 0.125;
  static KEEP_DAYS = 8;

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on(`${module.id}.dayEnded`, info => this.dayEnded(info).catch(error => log.error("Food and water, day's end", error)));
    Hooks.on(`${module.id}.dayUndone`, info => this.dayUndone(info).catch(error => log.error("Food and water, day undone", error)));
    Hooks.on(`${module.id}.requestExhaustion`, (message, actor) => this.failed(message, actor));
    Hooks.on("dnd5e.postActivityConsumption", activity => this.used(activity));
    Hooks.on("dnd5e.preRestCompleted", (actor, result, config) => this.rested(actor, result, config));
    Hooks.on("renderChatMessageHTML", (message, html) => this.drawDay(message, html));
    gm.handle("groupFood", (data, user) => this.asGM(data, user));
  }

  static enabled(){
    return groupTravel.enabled() && !!settings.value("foodWater");
  }

  /* A homebrew switch, while the rules are Homebrew */
  static homebrew(key){
    return (settings.value("foodWaterRules") === "homebrew") && !!settings.value(key);
  }

  static i18n(key, data){
    return data ? game.i18n.format(`groupTravel.food.${key}`, data) : game.i18n.localize(`groupTravel.food.${key}`);
  }

  static esc(text){
    return foundry.utils.escapeHTML(String(text ?? ""));
  }

  static round(n){
    return Math.round(n * 100) / 100;
  }

  /* ---------- Who, and how much ---------- */

  /* Tracked : a creature member, unless the GM unticked it */
  static tracked(group, actor){
    return !!actor?.system?.isCreature && (groupTravel.memberOf(group, actor).eats !== false);
  }

  /* Each tracked creature once, with the first group it's in */
  static trackedActors(){
    const found = new Map();
    for(const group of game.actors.filter(a => a.type === "group")){
      for(const actor of groupTravel.creatures(group)) if(!found.has(actor) && this.tracked(group, actor)) found.set(actor, group);
    }
    return found;
  }

  /* The day's need (2024 PHB, by size); water doubled on a hot day (homebrew) */
  static needs(actor, intake = {}){
    const need = groupCamp.need(actor);
    return { food : need, water : need * ((intake.hot && this.homebrew("homebrewHeatWater")) ? 2 : 1) };
  }

  /* ---------- What was eaten and drunk, by the day ---------- */

  static dayOf(at = game.time.worldTime){
    return gm.midnightOf(at);
  }

  static intakeOf(actor, day = this.dayOf()){
    return { food : 0, water : 0, hot : false, ...(actor.getFlag(module.id, "intake")?.[day] ?? {}) };
  }

  static hungerOf(actor){
    return { starve : 0, short : 0, food : 0, water : 0, ...(actor.getFlag(module.id, "hunger") ?? {}) };
  }

  /**
   * Food (lb) and water (gallons) a creature had, kept on its day; a full day's frees what Malnutrition / Dehydration held.
   * Its owner's client or the GM's.
   */
  static async record(actor, { food = 0, water = 0, hot = false } = {}, at = game.time.worldTime){
    if(!actor || !(food || water || hot)) return;
    if(!actor.isOwner) return gm.run("groupFood", { op : "record", actor : actor.uuid, food, water, hot, at });
    const day = this.dayOf(at);
    const now = this.intakeOf(actor, day);
    const next = { food : this.round(now.food + (Number(food) || 0)), water : this.round(now.water + (Number(water) || 0)), hot : now.hot || !!hot };
    const changes = { [`flags.${module.id}.intake.${day}`] : next };
    const oldest = day - (this.KEEP_DAYS * gm.secondsPerDay);
    for(const key of Object.keys(actor.getFlag(module.id, "intake") ?? {})) if(Number(key) < oldest) changes[`flags.${module.id}.intake.-=${key}`] = null;
    await actor.update(changes);
    await this.free(actor, day);
  }

  /* A day with the full food (water) frees the Exhaustion Malnutrition (Dehydration) held */
  static async free(actor, day = this.dayOf()){
    const intake = this.intakeOf(actor, day);
    const needs = this.needs(actor, intake);
    const hunger = this.hungerOf(actor);
    const freed = {};
    if(hunger.food && (intake.food >= needs.food)) freed.food = 0;
    if(hunger.water && (intake.water >= needs.water)) freed.water = 0;
    if(Object.keys(freed).length) await this.setHunger(actor, { ...hunger, ...freed });
  }

  /* The hunger counts, and dnd5e's Malnutrition / Dehydration status while they hold Exhaustion */
  static async setHunger(actor, hunger){
    await actor.setFlag(module.id, "hunger", hunger);
    for(const [status, kind] of [["malnutrition", "food"], ["dehydration", "water"]]){
      const on = (Number(hunger[kind]) || 0) > 0;
      if(actor.statuses?.has(status) !== on) await actor.toggleStatusEffect(status, { active : on }).catch(error => log.debug(status, error));
    }
  }

  static async addExhaustion(actor, n = 1){
    const level = Number(actor.system.attributes?.exhaustion) || 0;
    const max = CONFIG.DND5E.conditionTypes.exhaustion?.levels ?? 6;
    const next = Math.max(0, Math.min(max, level + n));
    if(next !== level) await actor.update({ "system.attributes.exhaustion" : next });
    return next - level;
  }

  /* ---------- Eating anywhere : a food item used ---------- */

  /* What one of this item gives : { food, water } (null : not food) */
  static nourishOf(item, actor = item?.actor){
    const own = item?.getFlag?.(module.id, "nourish");
    if(own) return { food : Number(own.food) || 0, water : Number(own.water) || 0 };
    const id = idOf(item);
    if(item?.getFlag?.(module.id, "goodberry") || /goodberr/.test(id)) return { food : groupCamp.need(actor), water : 0 };
    if(id === "rations") return { food : 1, water : 0 };
    if(/^water/.test(id)) return { food : 0, water : this.PINT };
    if((item?.type === "consumable") && (item.system.type?.value === "food")) return { food : 1, water : 0 };
    return null;
  }

  static used(activity){
    const item = activity?.item, actor = activity?.actor;
    if(!this.enabled() || !item || !actor?.isOwner) return;
    const got = this.nourishOf(item, actor);
    if(!got || !this.trackedActors().has(actor)) return;
    this.record(actor, got).catch(error => log.error("Food and water, item used", error));
  }

  /* ---------- Eating and drinking from stores ---------- */

  /* Takes up to `want` from the holders' stores (a Beast : a day of feed first); returns what it got */
  static async take(actor, kind, want, holders){
    if(want <= 1e-9) return 0;
    if(kind === "food"){
      if(groupCamp.isBeast(actor) && (await groupCamp.useUp(holders.flatMap(a => groupCamp.feed(a)), 1, 1))) return want;
      return groupCamp.useUp(holders.flatMap(a => groupCamp.rations(a)), want, 1);
    }
    let got = 0;
    for(const item of holders.flatMap(a => groupCamp.skins(a))){
      if(got >= want - 1e-9) break;
      const has = groupCamp.waterIn(item);
      const sip = Math.min(has, want - got);
      if(sip <= 0) continue;
      await item.setFlag(module.id, "water", this.round(has - sip));
      got += sip;
    }
    return this.round(got);
  }

  /* Up to the day's need (at a portion) of food and / or water : free, else its own stores, then the group's packs */
  static async topUp(group, actor, { kinds = ["food", "water"], portion = 1, free = {} } = {}){
    const today = this.intakeOf(actor);
    const needs = this.needs(actor, today);
    const holders = [...new Set([actor, ...groupInventory.packs(group)])];
    const got = {};
    for(const kind of kinds){
      const want = Math.max(0, needs[kind] * portion - today[kind]);
      got[kind] = free[kind] ? want : await this.take(actor, kind, want, holders);
    }
    await this.record(actor, got);
    return { got, today : this.intakeOf(actor), needs };
  }

  /* ---------- On the GM's client ---------- */

  static async asGM({ op, ...data }, user){
    if(!this.enabled()) return false;
    const actor = data.actor ? await fromUuid(data.actor) : null;
    const group = data.group ? await fromUuid(data.group) : null;
    try {
      if(op === "record"){
        if(!actor?.testUserPermission(user, "OWNER")) return false;
        await this.record(actor, data, Number(data.at) || game.time.worldTime);
        return true;
      }
      if(op === "eat"){
        if((group?.type !== "group") || !actor || !(user.isGM || actor.testUserPermission(user, "OWNER"))) return false;
        const { got, today, needs } = await this.topUp(group, actor, { kinds : [data.kind] });
        return { got : got[data.kind], has : today[data.kind], need : needs[data.kind] };
      }
      if(op === "meal"){
        if((group?.type !== "group") || !groupCamp.canRun(group, user)) return false;
        await this.meal(group, data);
        return true;
      }
      if(op === "track"){
        if(!user.isGM || (group?.type !== "group") || !actor) return false;
        await group.update({ [`flags.${module.id}.members.${actor.id}.eats`] : !this.tracked(group, actor) });
        return true;
      }
    } catch(error){ log.error(`Food and water ${op}`, error); }
    return false;
  }

  /* ---------- The Journey card's Meal ---------- */

  static mealButton(group){
    if(!this.enabled()) return "";
    const can = groupCamp.canRun(group);
    return `<button type="button" class="meal unbutton" data-tooltip="${this.i18n("mealHint")}" ${can ? "" : "disabled"}>
      <i class="fa-solid fa-bowl-food" inert></i></button>`;
  }

  static listenMeal(group, row){
    row.querySelector(".meal:not([disabled])")?.addEventListener("click", () => this.mealWindow(group));
  }

  static async mealWindow(group){
    const content = `<div class="macro-helper-meal-window">
      <div class="form-group"><label>${this.i18n("portion")}</label>
        <select name="portion"><option value="1">${game.i18n.localize("groupTravel.camp.portion.full")}</option>
          <option value="0.5">${game.i18n.localize("groupTravel.camp.portion.half")}</option></select></div>
      <div class="form-group"><label>${this.i18n("foodNearby")}</label><input type="checkbox" name="food"></div>
      <div class="form-group"><label>${this.i18n("waterNearby")}</label><input type="checkbox" name="water"></div>
      <p class="hint">${this.i18n("mealWindowHint")}</p></div>`;
    const data = await foundry.applications.api.DialogV2.prompt({
      window : { title : this.i18n("meal"), icon : "fa-solid fa-bowl-food" }, content,
      ok : { label : this.i18n("meal"), callback : (event, button) => ({ portion : Number(button.form.elements.portion.value) || 1,
        food : button.form.elements.food.checked, water : button.form.elements.water.checked }) },
      rejectClose : false
    });
    if(data) await gm.run("groupFood", { op : "meal", group : group.uuid, ...data });
  }

  /* Every tracked member tops up to its day's need (at the portion); a log card lists it */
  static async meal(group, { portion = 1, food = false, water = false } = {}){
    const lines = [];
    for(const actor of groupCamp.members(group)){
      if(!this.tracked(group, actor)) continue;
      const { today, needs } = await this.topUp(group, actor, { portion, free : { food, water } });
      lines.push(`${this.esc(actor.name)} : ${this.amounts(today, needs)}`);
    }
    if(!lines.length) return;
    const title = this.i18n((portion < 1) ? "mealHalf" : "meal");
    await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor : group }),
      content : `<div class="macro-helper-group-log"><p><strong><i class="fa-solid fa-bowl-food" inert></i> ${title}</strong></p>
        ${lines.map(l => `<p>${l}</p>`).join("")}</div>` });
  }

  /* "food 1 / 1 lb, water 0.5 / 1 gal", red under half */
  static amounts(intake, needs){
    const part = (kind, key) => `<span class="${(intake[kind] < needs[kind] / 2) ? "over" : ""}">${game.i18n.format(`groupTravel.camp.${key}`, { got : this.round(intake[kind]), need : this.round(needs[kind]) })}</span>`;
    return `${part("food", "ate")}, ${part("water", "drank")}`;
  }

  /* ---------- The Members tab : today's food and water, Eat / Drink, the GM's tick ---------- */

  static memberRow(group, actor){
    if(!this.enabled() || !actor?.system?.isCreature) return "";
    const tracked = this.tracked(group, actor);
    const tick = game.user.isGM ? `<button type="button" class="food-track unbutton ${tracked ? "active" : ""}" data-tooltip="${this.i18n(tracked ? "trackedHint" : "untrackedHint")}">
      <i class="fa-solid fa-bowl-food" inert></i></button>` : "";
    if(!tracked) return `<div class="row food">${tick}<span class="none">${this.i18n("untracked")}</span></div>`;
    const today = this.intakeOf(actor);
    const hunger = this.hungerOf(actor);
    const can = game.user.isGM || actor.isOwner;
    const button = (kind, icon) => can ? `<button type="button" class="food-${kind} unbutton" data-tooltip="${this.i18n(`${kind}Hint`)}"><i class="fa-solid ${icon}" inert></i></button>` : "";
    const held = [hunger.food && this.i18n("heldFood", { n : hunger.food }), hunger.water && this.i18n("heldWater", { n : hunger.water }),
      (hunger.starve > 0) && this.i18n("starve", { n : hunger.starve })].filter(t => t);
    return `<div class="row food" data-tooltip="${this.i18n("todayHint")}">${tick}<span class="today">${this.amounts(today, this.needs(actor, today))}</span>
      ${button("eat", "fa-drumstick-bite")}${button("drink", "fa-bottle-water")}
      ${held.length ? `<span class="over held">${held.join(", ")}</span>` : ""}</div>`;
  }

  static listenMember(group, actor, card){
    card.querySelector(".food-track")?.addEventListener("click", () => gm.run("groupFood", { op : "track", group : group.uuid, actor : actor.uuid }));
    for(const kind of ["eat", "drink"]){
      card.querySelector(`.food-${kind}`)?.addEventListener("click", async () => {
        const result = await gm.run("groupFood", { op : "eat", group : group.uuid, actor : actor.uuid, kind : (kind === "eat") ? "food" : "water" });
        if(result && (result.has < result.need)) ui.notifications.warn(this.i18n(`${kind}Short`, { name : actor.name, has : this.round(result.has), need : this.round(result.need) }));
      });
    }
  }

  /* ---------- Weather : a hot day (homebrew Hot days) ---------- */

  static async hot(actor, at){
    if(!this.enabled() || !this.homebrew("homebrewHeatWater") || this.intakeOf(actor, this.dayOf(at)).hot) return;
    await this.record(actor, { hot : true }, at);
  }

  /* ---------- The day's end ---------- */

  static async dayEnded({ at }){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    const day = this.dayOf(at - 1);
    const saves = new Map();
    const rows = [], lines = [];
    let speaker = null;
    for(const [actor, group] of this.trackedActors()){
      speaker ??= group;
      const intake = this.intakeOf(actor, day);
      const needs = this.needs(actor, intake);
      const before = this.hungerOf(actor);
      const hunger = { ...before };
      const notes = [];
      let gave = 0;
      const save = (kind, dc) => {
        const key = `${kind}:${dc}`;
        (saves.get(key) ?? saves.set(key, { kind, dc, who : [] }).get(key)).who.push({ actor : actor.uuid, name : actor.name, img : actor.img });
        notes.push(this.i18n(`${kind}Save`, { dc }));
      };
      /* Water : under half, 1 level (homebrew : some water, a DC 15 save) */
      if(intake.water >= needs.water) hunger.water = 0;
      else if(intake.water < needs.water / 2){
        if((intake.water > 0) && this.homebrew("homebrewThirstSave")) save("water", 15);
        else { gave += await this.addExhaustion(actor); hunger.water += 1; notes.push(this.i18n("dehydrated")); }
      }
      /* Food : some but under half, a DC 10 save; none, 1 level from the end of the 5th day in a row */
      const short = intake.food < needs.food / 2;
      hunger.short = short ? hunger.short + 1 : 0;
      const dc = 10 + (this.homebrew("homebrewHungerGrows") ? 2 * (hunger.short - 1) : 0);
      if(intake.food >= needs.food){ hunger.food = 0; hunger.starve = 0; }
      else if(intake.food > 0){
        hunger.starve = 0;
        if(short) save("food", dc);
      }
      else {
        hunger.starve += 1;
        if(hunger.starve >= 5){ gave += await this.addExhaustion(actor); hunger.food += 1; notes.push(this.i18n("starved", { n : hunger.starve })); }
        else if(this.homebrew("homebrewFoodNothing")) save("food", dc);
      }
      await this.setHunger(actor, hunger);
      rows.push({ actor : actor.uuid, before, gave });
      lines.push(`${this.esc(actor.name)} : ${this.amounts(intake, needs)}${notes.length ? ` → ${notes.join(", ")}` : ""}`);
    }
    if(!rows.length) return;
    const cards = [];
    for(const { kind, dc, who } of saves.values()){
      const card = await rollRequests.request({ who, what : "save:con", dc, hideDC : false, whisper : true, speaker, onFail : "exhaustion",
        label : this.i18n(`${kind}Card`, { save : rollRequests.labelOf("save", "con") }), flags : { foodSave : { kind, day } } });
      if(card) cards.push(card.id);
    }
    const { date } = groupTravel.formatted(at - 1);
    await ChatMessage.implementation.create({
      speaker : speaker ? ChatMessage.implementation.getSpeaker({ actor : speaker }) : {}, whisper : game.users.filter(u => u.isGM).map(u => u.id),
      content : `<div class="macro-helper-group-log macro-helper-food-day"><p><strong><i class="fa-solid fa-bowl-food" inert></i> ${this.i18n("dayTitle", { date })}</strong></p>
        ${lines.map(l => `<p>${l}</p>`).join("")}</div>`,
      flags : { [module.id] : { foodDay : { at, rows, cards } } }
    });
  }

  /* A save card's Exhaustion button : that level is held too */
  static async failed(message, actor){
    const kind = message?.getFlag?.(module.id, "foodSave")?.kind;
    if(!kind || !actor?.isOwner) return;
    const hunger = this.hungerOf(actor);
    await this.setHunger(actor, { ...hunger, [kind] : (Number(hunger[kind]) || 0) + 1 });
  }

  /* The clock put back past a midnight : that day's end is taken back */
  static async dayUndone({ at }){
    if(!game.users.activeGM?.isSelf) return;
    for(const message of game.messages.filter(m => (m.getFlag(module.id, "foodDay")?.at === at) && !m.getFlag(module.id, "foodDay")?.undone)) await this.undoDay(message);
  }

  static async undoDay(message){
    const data = message?.getFlag(module.id, "foodDay");
    if(!game.user.isGM || !data || data.undone) return false;
    await message.setFlag(module.id, "foodDay.undone", true);
    /* Levels given : at once, and through the save cards' buttons */
    const fromCards = new Map();
    for(const id of data.cards ?? []){
      const card = game.messages.get(id);
      const request = card?.getFlag(module.id, "request");
      for(const row of request?.rows ?? []) if(request.results?.[1]?.[row.key]?.exhausted) fromCards.set(row.actor, (fromCards.get(row.actor) ?? 0) + 1);
      await card?.delete();
    }
    for(const { actor : uuid, before, gave } of data.rows ?? []){
      const actor = await fromUuid(uuid);
      if(!actor) continue;
      const levels = (Number(gave) || 0) + (fromCards.get(uuid) ?? 0);
      if(levels) await this.addExhaustion(actor, -levels);
      await this.setHunger(actor, before);
      /* A full meal since then still frees them */
      await this.free(actor);
    }
    return true;
  }

  static drawDay(message, html){
    const data = message.getFlag(module.id, "foodDay");
    const card = data && html.querySelector(".macro-helper-food-day");
    if(!card) return;
    if(data.undone) return card.classList.add("undone");
    if(!game.user.isGM) return;
    const row = buttonRow(html, { key : "macro-helper-food-undo" });
    addButton(row, makeButton({ icon : "fa-rotate-left", text : game.i18n.localize("groupTravel.undo"), once : true,
      onClick : () => this.undoDay(message) }));
  }

  /* ---------- A Long Rest : Exhaustion lowered, down to what Malnutrition / Dehydration hold ---------- */

  /* dnd5e keeps all Exhaustion while either status is on : lower it here, not past the levels they hold (nor when a
     status was taken off by hand) */
  static rested(actor, result, config){
    const delta = Number(config?.exhaustionDelta) || 0;
    if(!this.enabled() || (delta >= 0) || !actor.getFlag(module.id, "hunger") || !result?.updateData) return;
    const path = "system.attributes.exhaustion";
    const hunger = this.hungerOf(actor);
    const held = (Number(hunger.food) || 0) + (Number(hunger.water) || 0);
    const level = Number(foundry.utils.getProperty(actor, path)) || 0;
    const planned = foundry.utils.getProperty(result.updateData, path);
    const next = Math.min(level, Math.max(held, (planned === undefined) ? level + delta : Number(planned) || 0));
    if((next !== level) || (planned !== undefined)) foundry.utils.setProperty(result.updateData, path, next);
  }
}
