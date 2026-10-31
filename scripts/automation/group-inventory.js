import { module } from '../module.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { groupTravel } from './group-travel.js';
const log = logger.for(import.meta.url);

/**
 * Group Travel : the group sheet's Inventory and Effects tabs.
 *   The group actor carries nothing (a stash would weigh nothing) : what lands on it (dnd5e's Award, a drop on the tab)
 *   goes, on the active GM's client, to the member picked under "New items go to" (the GM or the Leader's player;
 *   Automatic : the primary vehicle, a pack member, the Leader, the first creature). With no one to take it, it stays
 *   in a red "Not carried" section, and Rule Limits warns or stops the travel.
 *   Inventory : a section for each vehicle and each creature with no class levels (pack animals, mounts, hirelings) :
 *   its load, coins (Manage Currency), and items in Count / Weight columns, folded or not (each viewer's own). One
 *   search box under them filters every section. dnd5e's sidebar keeps the characters' cards; its own list is hidden.
 *   Anyone in the group (the GM, or a player owning one of its creatures) may drag items between the sections and their
 *   own character (its card, or its own sheet), not another player's character, change a section's counts, and move
 *   a section's coins to another section or their own character. Items move (never copied), with their contents, all
 *   through the GM's client; dropped on a container row, they go inside it.
 *   Effects : dnd5e's list (the group's), then one folded section per vehicle and pack member.
 */
export class groupInventory{
  static FOLDED = "macro-helper.groupFolded";
  static #sweeping = new Set();

  static register(){
    if(game.system.id !== "dnd5e") return;
    this.oneInventory();
    Hooks.on("renderActorSheetV2", (app, html) => this.render(app, html));
    /* Out of a section onto any actor sheet (a player's own) : a move through the GM */
    Hooks.on("dropActorSheetData", (actor, sheet, data) => this.dropOnSheet(actor, data));
    for(const hook of ["createItem", "updateItem", "deleteItem", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]){
      Hooks.on(hook, doc => this.redraw(doc));
    }
    /* What lands on the group goes to a member */
    Hooks.on("createItem", item => (item.parent?.type === "group") && this.sweep(item.parent));
    Hooks.on("updateActor", (actor, changes) => (actor.type === "group") && this.arrivalsChanged(actor, changes));
    Hooks.once("ready", () => this.sweepAll());
    Hooks.on("updateSetting", setting => (setting.key === `${module.id}.groupTravel`) && this.sweepAll());
    gm.handle("groupItem", (data, user) => this.moveAsGM(data, user));
    gm.handle("groupArrivals", (data, user) => this.arrivalsAsGM(data, user));
    gm.handle("groupQuantity", (data, user) => this.quantityAsGM(data, user));
    gm.handle("groupCoins", (data, user) => this.coinsAsGM(data, user));
  }

  static enabled(){
    return groupTravel.enabled();
  }

  /* dnd5e's Group / Vehicle switch : every vehicle has its own section now */
  static oneInventory(){
    const proto = dnd5e.applications?.actor?.GroupActorSheet?.prototype;
    const original = proto && Object.getOwnPropertyDescriptor(proto, "inventorySource");
    if(!original?.get) return log.error("Group inventory : no GroupActorSheet.inventorySource");
    const self = this;
    Object.defineProperty(proto, "inventorySource", {
      configurable : true,
      get(){ return self.enabled() ? this.actor : original.get.call(this); }
    });
  }

  /* ---------- Who may do what ---------- */

  /* In the group : the GM, the group's owner, or a player owning one of its creatures */
  static inGroup(group, user = game.user){
    return user.isGM || group.testUserPermission(user, "OWNER") || groupTravel.creatures(group).some(a => a.testUserPermission(user, "OWNER"));
  }

  static packs(group){
    const order = groupTravel.flag(group, "order") ?? [];
    const rank = a => { const i = order.indexOf(a.id); return (i < 0) ? order.length : i; };
    const members = group.system.members.map(m => m.actor).filter(a => groupTravel.isPack(a));
    return members.map((a, i) => ({ a, i })).sort((x, y) => (rank(x.a) - rank(y.a)) || (x.i - y.i)).map(x => x.a);
  }

  /* Where that user may take items from or put them : the group actor (what nobody carries), a pack member, an actor of
     their own */
  static reaches(group, actor, user = game.user){
    if(!actor) return false;
    if(user.isGM || (actor === group)) return true;
    if(groupTravel.isPack(actor) && group.system.members.some(m => m.actor === actor)) return true;
    return actor.testUserPermission(user, "OWNER");
  }

  /* Where that user may put items : what they reach, and the member new items go to */
  static mayGive(group, actor, user = game.user){
    return (actor !== group) && (this.reaches(group, actor, user) || (actor === groupTravel.arrivalHolder(group).actor));
  }

  static physical(item){
    return !!item?.system?.constructor?._schemaTemplates?.includes(dnd5e.dataModels.item.PhysicalItemTemplate);
  }

  /* ---------- Moves ---------- */

  static move(group, item, to, container = null){
    return gm.run("groupItem", { group : group.uuid, item : item.uuid, to : to.uuid, container });
  }

  /* On the GM's client : the item (and its contents) created on the target, then deleted where it was; a world or
     compendium item (the GM only) is copied. Within one actor : into / out of a container. */
  static async moveAsGM({ group, item, to, container = null }, user){
    group = await fromUuid(group);
    item = await fromUuid(item);
    to = await fromUuid(to);
    if((group?.type !== "group") || !(to instanceof Actor) || !this.physical(item) || !this.inGroup(group, user)) return false;
    const from = (item.parent instanceof Actor) ? item.parent : null;
    if(!this.mayGive(group, to, user) || (from ? !this.reaches(group, from, user) : !user.isGM)) return false;
    return this.transfer(item, to, container);
  }

  static async transfer(item, to, container = null){
    const from = (item.parent instanceof Actor) ? item.parent : null;
    if((to.type === "vehicle") && item.isMountable) return false;
    const box = container ? to.items.get(container) : null;
    if(box && ((box.type !== "container") || (box === item) || (await box.system.allContainers()).includes(item))) return false;
    if(from === to){
      if((item.system.container ?? null) !== (box?.id ?? null)) await item.update({ "system.container" : box?.id ?? null });
      return true;
    }
    const unequip = data => {
      if(data.system && ("equipped" in data.system)) data.system.equipped = false;
      if(data.system?.attuned) data.system.attuned = false;
      return data;
    };
    const created = await CONFIG.Item.documentClass.createWithContents([item], {
      container : box, transformAll : doc => (doc instanceof foundry.abstract.Document) ? doc.toObject() : doc, transformFirst : unequip
    });
    if(!created?.length) return false;
    await CONFIG.Item.documentClass.createDocuments(created, { parent : to, keepId : true });
    if(from) await item.delete({ deleteContents : true });
    return true;
  }

  /* A section's item dropped on another sheet (a player's own character) : moved by the GM, not copied */
  static dropOnSheet(actor, data){
    if(!this.enabled() || (data?.type !== "Item") || !data.uuid || (actor?.type === "group")) return;
    const item = fromUuidSync(data.uuid, { strict : false });
    const from = item?.parent;
    if(!(from instanceof Actor) || (from === actor) || !this.physical(item)) return;
    const group = (from.type === "group") ? from : groupTravel.groupsOf(from).find(g => groupTravel.isPack(from) && this.inGroup(g));
    if(!group || !this.inGroup(group)) return;
    if(!this.mayGive(group, actor)) ui.notifications.warn(game.i18n.localize("groupTravel.inventory.notYours"));
    else this.move(group, item, actor);
    return false;
  }

  /* ---------- What lands on the group ---------- */

  static canPlace(group, user = game.user){
    return groupTravel.canOrder(group, user);
  }

  static async arrivalsAsGM({ group, holder }, user){
    group = await fromUuid(group);
    if((group?.type !== "group") || !this.canPlace(group, user)) return false;
    if(!holder) await group.unsetFlag(module.id, "arrivals");
    else if(groupTravel.memberActor(group, holder)) await group.setFlag(module.id, "arrivals", holder);
    else return false;
    await this.sweep(group);
    return true;
  }

  static arrivalsChanged(group, changes){
    const flat = Object.keys(foundry.utils.flattenObject(changes ?? {}));
    if(flat.some(k => k.startsWith("system.currency") || k.startsWith("system.members") || k.startsWith("system.primaryVehicle"))) this.sweep(group);
  }

  static sweepAll(){
    for(const group of game.actors?.filter(a => a.type === "group") ?? []) this.sweep(group);
  }

  /* On the active GM's client : the group's own items (with their contents) and coins go to the member picked */
  static async sweep(group){
    if(!this.enabled() || !game.users.activeGM?.isSelf || this.#sweeping.has(group.id)) return;
    const holder = groupTravel.arrivalHolder(group).actor;
    if(!holder || !groupTravel.uncarried(group)) return;
    this.#sweeping.add(group.id);
    try {
      for(const item of group.items.filter(i => !i.system.container && this.physical(i))) await this.transfer(item, holder);
      const coins = Object.fromEntries(Object.entries(group.system.currency ?? {}).filter(([, n]) => Number(n) > 0));
      if(!foundry.utils.isEmpty(coins)) await dnd5e.applications.Award.awardCurrency(coins, [holder], { origin : group });
    } catch(err) { log.error("Group arrivals :", err); }
    finally { this.#sweeping.delete(group.id); }
  }

  /* ---------- Counts and coins ---------- */

  /* A section's item count, up or down (anyone in the group, through the GM) */
  static async quantityAsGM({ group, item, delta }, user){
    group = await fromUuid(group);
    item = await fromUuid(item);
    delta = Math.trunc(Number(delta));
    const actor = item?.parent;
    if((group?.type !== "group") || !(actor instanceof Actor) || !delta || !this.physical(item) || !this.inGroup(group, user) || !this.reaches(group, actor, user)) return false;
    await item.update({ "system.quantity" : Math.max(0, (Number(item.system.quantity) || 0) + delta) });
    return true;
  }

  /* The coins a section may go to : the other sections, the user's own characters in the group (the GM : every member) */
  static coinTargets(group, from, user = game.user){
    return group.system.members.map(m => m.actor)
      .filter(a => a && (a !== from) && (a.type !== "group") && (this.packs(group).includes(a) || user.isGM || a.testUserPermission(user, "OWNER")));
  }

  static async coinsAsGM({ group, from, to = [], amount = {}, convert = false }, user){
    group = await fromUuid(group);
    from = await fromUuid(from);
    if((group?.type !== "group") || !(from instanceof Actor) || !this.inGroup(group, user) || !this.reaches(group, from, user)) return false;
    if(convert) return !!(await dnd5e.applications.CurrencyManager.convertCurrency(from));
    const targets = this.coinTargets(group, from, user);
    const destinations = (await Promise.all(to.map(uuid => fromUuid(uuid)))).filter(a => targets.includes(a));
    const amounts = Object.fromEntries(Object.keys(CONFIG.DND5E.currencies).map(k => [k, Math.max(0, Math.trunc(Number(amount[k]) || 0))]));
    if(!destinations.length || !Object.values(amounts).some(n => n)) return false;
    await dnd5e.applications.Award.awardCurrency(amounts, destinations, { origin : from });
    return true;
  }

  /* dnd5e's Currency Manager for a section : its transfer goes to the other sections and the user's own characters,
     and both its tabs run on the GM's client */
  static #Manager = null;

  static currencyWindow(group, actor){
    const self = this;
    this.#Manager ??= class GroupCurrencyManager extends dnd5e.applications.CurrencyManager {
      static DEFAULT_OPTIONS = { form : { handler : GroupCurrencyManager.submit } };
      get transferDestinations(){ return self.coinTargets(this.options.group, this.document); }
      static async submit(event, form, formData){
        const data = foundry.utils.expandObject(formData.object);
        const group = this.options.group;
        if(event.submitter?.name === "convert") return gm.run("groupCoins", { group : group.uuid, from : this.document.uuid, convert : true });
        if(event.submitter?.name !== "transfer") return;
        const to = this.transferDestinations.filter(d => data.destination?.[d.id]).map(d => d.uuid);
        return gm.run("groupCoins", { group : group.uuid, from : this.document.uuid, to, amount : data.amount ?? {} });
      }
    };
    new this.#Manager({ document : actor, group }).render({ force : true });
  }

  /* ---------- Drawing ---------- */

  static folded(){
    try { return new Set(JSON.parse(localStorage.getItem(this.FOLDED) ?? "[]")); } catch { return new Set(); }
  }

  static fold(key, on){
    const set = this.folded();
    if(on) set.add(key); else set.delete(key);
    try { localStorage.setItem(this.FOLDED, JSON.stringify([...set])); } catch {}
  }

  /* A group sheet showing that item's or effect's actor redraws */
  static redraw(doc){
    if(!this.enabled()) return;
    const actor = (doc.parent instanceof Actor) ? doc.parent : doc.parent?.parent;
    if(!(actor instanceof Actor)) return;
    for(const app of groupTravel.sheets()){
      if((app.document === actor) || this.packs(app.document).includes(actor)) app.render({ parts : ["inventory", "effects"] });
    }
  }

  static render(app, html){
    const group = app.document;
    if((group?.type !== "group") || !this.enabled()) return;
    const root = html ?? app.element;
    try {
      const inventory = root?.querySelector(".tab[data-tab='inventory']");
      if(inventory && !inventory.classList.contains("macro-helper-inventory")) this.drawInventory(group, inventory);
      const effects = root?.querySelector(".tab[data-tab='effects']");
      if(effects && !effects.classList.contains("macro-helper-effects")) this.drawEffects(group, effects);
    } catch(err) { log.error("Group inventory :", err); }
  }

  /* A fold-able section : its head (chevron + what's given) and body */
  static section({ key, head, body, className = "" }){
    const section = document.createElement("section");
    section.className = `macro-helper-pack ${className}`;
    section.dataset.key = key;
    if(this.folded().has(key)) section.classList.add("folded");
    section.innerHTML = `<header class="pack-head"><i class="fa-solid fa-chevron-down fold" inert></i>${head}</header><div class="pack-body">${body}</div>`;
    section.querySelector(".pack-head").addEventListener("click", event => {
      if(event.target.closest("select, input, a, button")) return;
      const on = !section.classList.contains("folded");
      section.classList.toggle("folded", on);
      this.fold(key, on);
    });
    return section;
  }

  static drawInventory(group, tab){
    tab.classList.add("macro-helper-inventory");
    const member = this.inGroup(group);
    const packs = this.packs(group);
    /* The sidebar : characters only (pack members have their own sections); others' characters aren't for you */
    for(const card of tab.querySelectorAll(".sidebar .encumbrance.card[data-uuid]")){
      const actor = groupTravel.actorOf(card.dataset.uuid);
      if(packs.includes(actor)) card.remove();
      else if(!this.reaches(group, actor)) card.classList.add("not-yours");
    }
    const body = tab.querySelector(":scope > .body");
    if(!body) return;
    /* dnd5e's list of the group's own items : hidden (the group carries nothing) */
    const hidden = document.createElement("div");
    hidden.className = "macro-helper-hidden";
    hidden.append(...body.childNodes);
    body.append(hidden, this.arrivalsBar(group));
    body.querySelector(".arrivals select")?.addEventListener("change", event => gm.run("groupArrivals", { group : group.uuid, holder : event.target.value }));
    const places = [...(groupTravel.uncarried(group) ? [group] : []), ...(member ? packs : [])];
    for(const actor of places){
      const loose = actor === group;
      const section = this.section({ key : `${group.uuid}.${loose ? "loose" : actor.id}`, className : loose ? "loose" : "",
        head : loose ? this.looseHead(group) : this.packHead(group, actor), body : this.itemList(actor, member) });
      section.dataset.uuid = actor.uuid;
      this.listen(group, actor, section);
      body.append(section);
    }
    if(member && places.length) body.append(this.searchBox(body));
    /* Drops anywhere on the tab : moves between the group's places go through the GM */
    tab.addEventListener("dragover", event => { if(event.target.closest(".macro-helper-pack[data-uuid], .sidebar .card[data-uuid], .body")) event.preventDefault(); });
    tab.addEventListener("drop", event => this.onDrop(group, tab, event), { capture : true });
  }

  /* "New items go to" : the member picked, or Automatic */
  static arrivalsBar(group){
    const { actor, auto } = groupTravel.arrivalHolder(group);
    const members = group.system.members.map(m => m.actor).filter(a => a && (a.type !== "group"));
    const options = [`<option value="" ${auto ? "selected" : ""}>${game.i18n.format("groupTravel.inventory.auto", { name : foundry.utils.escapeHTML(groupTravel.autoHolder(group)?.name ?? "—") })}</option>`,
      ...members.map(a => `<option value="${a.id}" ${(!auto && (a === actor)) ? "selected" : ""}>${foundry.utils.escapeHTML(a.name)}</option>`)].join("");
    const bar = document.createElement("div");
    bar.className = "macro-helper-arrivals";
    bar.innerHTML = `<label class="arrivals" data-tooltip="${game.i18n.localize("groupTravel.inventory.arrivalsHint")}">
      <i class="fa-solid fa-inbox" inert></i> ${game.i18n.localize("groupTravel.inventory.arrivals")}
      <select ${this.canPlace(group) ? "" : "disabled"}>${options}</select></label>`;
    return bar;
  }

  /* What nobody carries (no member to hand it to) */
  static looseHead(group){
    return `<i class="fa-solid fa-triangle-exclamation" inert></i><h3 class="over">${game.i18n.localize("groupTravel.inventory.loose")}</h3>
      <span class="hint">${game.i18n.localize("groupTravel.inventory.looseHint")}</span>${this.coinPills(group, false)}`;
  }

  static coinPills(actor, manage){
    const coins = Object.entries(actor.system.currency ?? {}).filter(([, n]) => n > 0)
      .map(([k, n]) => `<li class="pill transparent"><span class="currency ${k}"></span><span class="label">${n}</span></li>`).join("");
    const button = manage ? `<button type="button" class="unbutton manage-coins" data-tooltip="${game.i18n.localize("DND5E.CurrencyManager.Title")}"
      aria-label="${game.i18n.localize("DND5E.CurrencyManager.Title")}"><i class="fa-solid fa-coins" inert></i></button>` : "";
    return `<div class="coins">${coins ? `<ul class="currency pills unlist">${coins}</ul>` : ""}${button}</div>`;
  }

  /* Portrait, name, load (a creature : its carrying capacity; a vehicle : cargo and what its team pulls), coins */
  static packHead(group, actor){
    const { value = 0, max = 0, travel } = actor.system.attributes?.encumbrance ?? {};
    const finite = Number.isFinite(max) && (max > 0);
    const over = groupTravel.weighs() && ((actor.type === "vehicle") ? (finite && (value > max)) : !!groupTravel.loadState(actor));
    const tip = [`${game.i18n.localize("groupTravel.gear")} ${groupTravel.weightLabel(travel?.gear ?? value)}`,
      ...(travel?.carried ?? []).map(c => `${game.i18n.localize((c.by === "ride") ? "groupTravel.riddenBy" : "groupTravel.carrying")} ${foundry.utils.escapeHTML(c.actor.name)} ${groupTravel.weightLabel(c.weight)}`),
      ...(travel?.pull ?? []).map(p => game.i18n.format("groupTravel.pullShare", { vehicle : foundry.utils.escapeHTML(p.vehicle.name),
        share : groupTravel.weightLabel(p.share), counts : groupTravel.weightLabel(p.counts) }))].join("<br>");
    const name = actor.testUserPermission(game.user, "LIMITED")
      ? `<a class="name" data-uuid="${actor.uuid}">${foundry.utils.escapeHTML(actor.name)}</a>` : `<span class="name">${foundry.utils.escapeHTML(actor.name)}</span>`;
    const gets = (groupTravel.arrivalHolder(group).actor === actor)
      ? `<i class="fa-solid fa-inbox gets" data-tooltip="${game.i18n.localize("groupTravel.inventory.gets")}"></i>` : "";
    return `<img class="portrait" src="${actor.img}" alt="">${name}${gets}
      <div class="load" data-tooltip="${tip}">
        <i class="fa-solid ${(actor.type === "vehicle") ? "fa-boxes-stacked" : "fa-weight-hanging"}" inert></i>
        <div class="meter progress meter-sm" style="--bar-percentage : ${finite ? Math.min(100, value / max * 100) : 0}%"></div>
        <span class="${over ? "over" : ""}">${Math.round(value)} / ${finite ? groupTravel.weightLabel(max) : "—"}</span>
      </div>
      ${(actor.type === "vehicle") ? `<div class="pull">${groupTravel.pullLine(actor)}</div>` : ""}
      ${this.coinPills(actor, true)}`;
  }

  /* Its items (not natural weapons or armour; a vehicle : cargo, not its mounted parts), containers with their contents
     under them, in Count and Weight columns */
  static itemList(actor, member){
    const items = actor.items.filter(i => this.physical(i) && (i.system.type?.value !== "natural") && !((actor.type === "vehicle") && i.isMountable));
    const rows = (container, depth) => items.filter(i => (i.system.container ?? null) === container)
      .sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name, game.i18n.lang))
      .map(i => this.itemRow(i, depth, member) + ((i.type === "container") && (depth < 4) ? rows(i.id, depth + 1) : "")).join("");
    const list = rows(null, 0);
    if(!list) return `<p class="empty">${game.i18n.localize("groupTravel.inventory.empty")}</p>`;
    return `<div class="columns"><span class="name">${game.i18n.localize("groupTravel.inventory.item")}</span>
      <span class="count">${game.i18n.localize("groupTravel.inventory.count")}</span><span class="weight">${game.i18n.localize("groupTravel.inventory.weight")}</span></div>
      <ol class="items unlist">${list}</ol>`;
  }

  static itemRow(item, depth, member){
    const quantity = Number(item.system.quantity) || 0;
    const weight = item.system.totalWeightIn?.(groupTravel.weightUnit()) ?? 0;
    const box = item.type === "container";
    const step = (delta, icon) => `<button type="button" class="unbutton step" data-delta="${delta}" ${member ? "" : "disabled"}><i class="fa-solid ${icon}" inert></i></button>`;
    return `<li class="item ${box ? "container" : ""}" draggable="true" data-uuid="${item.uuid}" data-parent="${item.system.container ?? ""}" data-id="${item.id}"
      ${box ? `data-container-id="${item.id}"` : ""} style="--depth : ${depth}">
      <img src="${item.img}" alt=""><span class="name">${foundry.utils.escapeHTML(item.name)}</span>
      <span class="count">${box ? "" : `${step(-1, "fa-minus")}<span class="value">${quantity}</span>${step(1, "fa-plus")}`}</span>
      <span class="weight">${weight ? groupTravel.weightLabel(weight) : "—"}</span></li>`;
  }

  /* One search box for every section : a match shows its containers too */
  static searchBox(body){
    const box = document.createElement("div");
    box.className = "macro-helper-pack-search";
    box.innerHTML = `<i class="fa-solid fa-magnifying-glass" inert></i>
      <input type="search" placeholder="${game.i18n.localize("groupTravel.inventory.search")}" aria-label="${game.i18n.localize("groupTravel.inventory.search")}">`;
    box.querySelector("input").addEventListener("input", event => {
      const text = event.target.value.trim().toLocaleLowerCase(game.i18n.lang);
      for(const list of body.querySelectorAll(".macro-helper-pack ol.items")){
        const rows = [...list.querySelectorAll("li.item")];
        const byId = new Map(rows.map(r => [r.dataset.id, r]));
        const shown = new Set();
        for(const row of rows){
          if(text && !row.querySelector(".name").textContent.toLocaleLowerCase(game.i18n.lang).includes(text)) continue;
          for(let r = row, n = 0; r && (n < 6); r = byId.get(r.dataset.parent), n++) shown.add(r);
        }
        for(const row of rows) row.hidden = !shown.has(row);
      }
    });
    return box;
  }

  static listen(group, actor, section){
    section.querySelector("a.name")?.addEventListener("click", () => actor.sheet.render(true));
    section.querySelector(".manage-coins")?.addEventListener("click", () => this.currencyWindow(group, actor));
    for(const row of section.querySelectorAll("li.item[data-uuid]")){
      const item = fromUuidSync(row.dataset.uuid);
      row.addEventListener("dragstart", event => {
        event.stopPropagation();
        event.dataTransfer.setData("text/plain", JSON.stringify(item.toDragData()));
      });
      row.querySelector(".name").addEventListener("click", () => item.testUserPermission(game.user, "OBSERVER") && item.sheet.render(true));
      for(const button of row.querySelectorAll("button.step:not([disabled])")){
        button.addEventListener("click", event => {
          event.stopPropagation();
          const delta = Number(button.dataset.delta) * (event.shiftKey ? 5 : 1);
          gm.run("groupQuantity", { group : group.uuid, item : item.uuid, delta });
        });
      }
    }
  }

  /* Where it's dropped : a section (on a container row : inside it), a character's card, elsewhere on the tab : the
     member new items go to */
  static onDrop(group, tab, event){
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    if((data?.type !== "Item") || !data.uuid) return;
    const item = fromUuidSync(data.uuid, { strict : false });
    if(!this.physical(item)) return;
    const section = event.target.closest(".macro-helper-pack[data-uuid]");
    const card = event.target.closest(".sidebar .card[data-uuid]");
    const to = section ? groupTravel.actorOf(section.dataset.uuid) : (card ? groupTravel.actorOf(card.dataset.uuid) : groupTravel.arrivalHolder(group).actor);
    const from = (item.parent instanceof Actor) ? item.parent : null;
    event.preventDefault();
    event.stopPropagation();
    if(!to || (to === group)) return;
    if(!this.inGroup(group) || !this.mayGive(group, to) || (from ? !this.reaches(group, from) : !game.user.isGM)){
      return ui.notifications.warn(game.i18n.localize("groupTravel.inventory.notYours"));
    }
    const container = section ? (event.target.closest("li.item[data-container-id]")?.dataset.containerId ?? null) : null;
    if((from === to) && ((item.system.container ?? null) === container)) return;
    this.move(group, item, to, container);
  }

  /* ---------- Effects ---------- */

  static drawEffects(group, tab){
    tab.classList.add("macro-helper-effects");
    if(!this.inGroup(group)) return;
    for(const actor of this.packs(group)){
      const effects = [...actor.allApplicableEffects()];
      const rows = effects.map(e => `<li class="item ${e.disabled ? "disabled" : ""}" data-uuid="${e.uuid}">
        <img src="${e.img}" alt=""><span class="name">${foundry.utils.escapeHTML(e.name)}</span>
        <span class="duration">${e.disabled ? game.i18n.localize("groupTravel.inventory.off") : (e.duration?.label ?? "")}</span></li>`).join("");
      const head = `<img class="portrait" src="${actor.img}" alt=""><span class="name">${foundry.utils.escapeHTML(actor.name)}</span><span class="count">${effects.length}</span>`;
      const section = this.section({ key : `${group.uuid}.${actor.id}.effects`, head,
        body : rows ? `<ol class="items unlist">${rows}</ol>` : `<p class="empty">${game.i18n.localize("groupTravel.inventory.noEffects")}</p>` });
      for(const row of section.querySelectorAll("li.item[data-uuid]")){
        const effect = fromUuidSync(row.dataset.uuid);
        row.addEventListener("click", () => effect?.testUserPermission(game.user, "OBSERVER") && effect.sheet.render(true));
      }
      tab.append(section);
    }
  }
}
