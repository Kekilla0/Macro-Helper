import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { patch } from '../patch.js';
import { gm } from '../gm.js';
const log = logger.for(import.meta.url);

/**
 * Group Travel (dnd5e's Group actor) : the group sheet's header, rearranged and added to.
 *   dnd5e keeps : the portrait, name, Place Members, the group Short / Long Rest buttons, Travel Pace (its pace arrows
 *                 and Land / Water / Air paces), Advancement.
 *   added       : a Journey card, a full-width row under the header : the clock (dnd5e's Calendar, in the Calendar HUD's own date / time formats), the travel
 *                 mode chips (Land / Water / Air; the primary vehicle's type marked), Weather (GM dropdown), Stealth
 *                 (toggle), the primary vehicle's crew / passenger seats; Travel and Pass Time beside the rest buttons.
 *   Everyone sees it; only the GM uses it (the Leader role gets Travel later). Travel, Pass Time, weather and stealth
 *   don't do anything yet : the look comes first.
 *   Travel Pace (2024 RAW) : the PHB's fixed table (Normal 3 mph / 24 miles a day, Fast 30, Slow 18), whatever the
 *   members' speeds; Water / Air only when every member has that speed. The DMG's Slower Travelers : Slow when any
 *   member walking (not aboard the primary vehicle) is slowed (dnd5e's movement.slowed : Speed half or less).
 *   A land vehicle uses the table too (PHB : land vehicles choose a pace as normal); a ship or airship keeps its own
 *   speed (dnd5e). Paces the GM typed in the group's Travel Pace window override all of it ("Travel Pace OVERRIDE").
 */
export class groupTravel{
  static enabled = settings.on("groupTravel");
  static MODES = ["land", "water", "air"];
  static WEATHER = ["clear", "cold", "heat", "rain", "wind"];

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("renderActorSheetV2", (app, html) => this.renderHeader(app, html));
    Hooks.on("renderActorSheetV2", (app, html, context, options) => this.renderMembers(app, html, options));
    /* The clock follows world time without redrawing the whole sheet */
    Hooks.on("updateWorldTime", () => this.updateClocks());
    /* dnd5e's group rest windows : a saved empty member list rests nobody (only the clock moves) : tick everyone */
    Hooks.on("renderShortRestDialog", (app, html) => this.restTargets(app, html));
    Hooks.on("renderLongRestDialog", (app, html) => this.restTargets(app, html));
    /* A Long Rest, on the member's own sheet or the group's : their travel hours start again */
    Hooks.on("dnd5e.restCompleted", (actor, result, config) => this.restHours(actor, config));
    gm.handle("groupMember", (data, user) => this.memberAsGM(data, user));
    gm.handle("groupOrder", (data, user) => this.orderAsGM(data, user));
    const self = this;
    patch.wrap("CONFIG.Actor.dataModels.group.prototype.getTravelPace", function(wrapped, ...args){
      const pace = wrapped(...args);
      if(!self.enabled()) return pace;
      try { return self.travelPace(this, pace); } catch(err) { log.error("Travel Pace :", err); return pace; }
    });
    /* A member's speed or conditions changed : their groups' paces may too */
    Hooks.on("updateActor", actor => this.redrawGroupsOf(actor));
    for(const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]){
      Hooks.on(hook, effect => (effect.target instanceof Actor) && this.redrawGroupsOf(effect.target));
    }
  }

  /* ---------- Travel Pace ---------- */

  /* Paces the GM typed in the group's own Travel Pace window */
  static overridden(group){
    const travel = group._source?.attributes?.travel ?? {};
    return ["paces", "speeds"].some(key => Object.values(travel[key] ?? {}).some(v => `${v ?? ""}`.trim()));
  }

  static actorOf(uuid){
    try { return fromUuidSync(uuid); } catch { return null; }
  }

  /* The creatures walking with the group : members on their own feet (not aboard a vehicle, riding or carried), plus
     the primary vehicle's draft animals */
  static walkers(group){
    const walkers = group.members.map(m => m.actor).filter(a => a?.system?.isCreature && (this.travelOf(group.parent, a).by === "walk"));
    for(const uuid of group.primaryVehicle?.system?.draft?.value ?? []){
      const actor = this.actorOf(uuid);
      if(actor?.system?.isCreature && !walkers.includes(actor)) walkers.push(actor);
    }
    return walkers;
  }

  /* A creature's own speed of that movement type, not today's (Unconscious is 0) */
  static speed(actor, type){
    const movement = actor.system.attributes?.movement ?? {};
    const source = actor._source?.system?.attributes?.movement?.speeds ?? {};
    return Number(source[type]) || Number(movement.fromSpecies?.[type]) || Number(movement.speeds?.[type]) || 0;
  }

  /* The travel types (land / water / air) a creature has a speed for */
  static travelTypes(actor){
    const types = new Set();
    for(const [type, config] of Object.entries(CONFIG.DND5E.movementTypes)){
      if((type !== "jump") && (this.speed(actor, type) > 0)) types.add(config.travel ?? "land");
    }
    return types;
  }

  /* The PHB table for the pace, a day of the group's travel hours (24 miles = 3 mph x 8 h, then Fast 30 / Slow 18);
     hours 1 = its hourly rate (Normal 3, Fast 4, Slow 2 mph) */
  static tablePace(group, pace, hours = group.attributes.travel.time){
    const units = group.attributes.travel.units ?? dnd5e.utils.defaultUnits("travel");
    const unitType = CONFIG.DND5E.travelUnits[units]?.type;
    const mph = (unitType === "metric") ? dnd5e.utils.convertTravelSpeed(3, "mph", { to : units }).value : 3;
    return dnd5e.dataModels.actor.TravelField.applyPaceMultiplier(mph * hours, pace, unitType);
  }

  /* RAW : the table for every travel type all the walkers have (a land vehicle : land only); null = dnd5e's own */
  static rawPace(group, chosen){
    const vehicle = group.primaryVehicle;
    if(vehicle && (vehicle.system.details?.type !== "land")) return null;
    const walkers = this.walkers(group);
    const slowed = walkers.some(a => a.system.attributes?.movement?.slowed);
    const order = Object.keys(CONFIG.DND5E.travelPace);
    const pace = (slowed && (order.indexOf(chosen) > order.indexOf("slow"))) ? "slow" : chosen;
    const types = Object.keys(CONFIG.DND5E.travelTypes);
    const has = type => vehicle ? (type === "land") : (walkers.length && walkers.every(a => this.travelTypes(a).has(type)));
    const paces = Object.fromEntries(types.map(type => [type, has(type) ? this.tablePace(group, pace) : null]));
    return { pace : { slowed, available : true, label : CONFIG.DND5E.travelPace[pace]?.label, value : pace }, paces };
  }

  static travelPace(group, pace){
    if(this.overridden(group)) return { ...pace, override : true };
    return this.rawPace(group, group.attributes.travel.pace) ?? pace;
  }

  /* "Travel Pace OVERRIDE" : the GM's typed paces win; the tooltip shows what RAW would give */
  static markPace(app, header){
    const group = app.document.system;
    const title = header.querySelector(".movement .travel-pace h3");
    if(!title || !this.overridden(group)) return;
    title.classList.add("macro-helper-override");
    title.textContent = `${game.i18n.localize("DND5E.TRAVEL.Label")} ${game.i18n.localize("groupTravel.override")}`;
    const raw = this.rawPace(group, group.attributes.travel.pace);
    const paces = raw ? Object.entries(raw.paces).map(([type, value]) =>
      `${game.i18n.localize(`DND5E.TRAVEL.Type.${type.capitalize()}`)} ${value ?? "—"}`).join(", ") : "—";
    title.dataset.tooltip = game.i18n.format("groupTravel.overrideHint", { paces });
  }

  /* dnd5e shows a bare number : add its unit (mi/d) and a tooltip with the hourly rate and the day's hours
     (the PHB table's own rate under RAW : Fast is 4 mph but 30 miles a day) */
  static paceUnits(app, header){
    const group = app.document.system;
    const travel = group.attributes?.travel ?? {};
    const table = !this.overridden(group) && this.rawPace(group, travel.pace);
    const units = CONFIG.DND5E.travelUnits[travel.units ?? dnd5e.utils.defaultUnits("travel")];
    const hours = Number(travel.time) || 0;
    if(!units) return;
    for(const value of header.querySelectorAll(".movement .info .value")){
      const day = Number(value.textContent.replace(/[^\d.]/g, ""));
      if(!day) continue;
      const unit = document.createElement("span");
      unit.className = "macro-helper-unit";
      unit.textContent = game.i18n.localize(units.abbreviationDay);
      value.append(unit);
      if(hours) value.dataset.tooltip = game.i18n.format("groupTravel.paceHint", {
        hour : `${table ? this.tablePace(group, table.pace.value, 1) : Math.round(day / hours * 10) / 10} ${game.i18n.localize(units.abbreviationHour)}`, hours, day : `${day} ${game.i18n.localize(units.abbreviationDay)}` });
    }
  }

  static redrawGroupsOf(actor){
    if(!this.enabled() || (actor.type === "group")) return;
    for(const app of this.sheets()){
      const group = app.document.system;
      const linked = group.members.some(m => m.actor === actor) || this.walkers(group).includes(actor);
      if(linked) app.render();
    }
  }

  static restHours(actor, config){
    if(!this.enabled() || (config?.type !== "long") || (actor?.type === "group") || !actor?.isOwner) return;
    if(actor.getFlag(module.id, "travelHours")) actor.unsetFlag(module.id, "travelHours");
  }

  static restTargets(app, html){
    if((app.actor?.type !== "group") || !this.enabled()) return;
    const boxes = [...((html instanceof HTMLElement) ? html : app.element).querySelectorAll("dnd5e-checkbox[name^='targets.']")];
    if(boxes.length && boxes.every(box => !box.checked)) for(const box of boxes) box.checked = true;
  }

  static sheets(){
    return [...foundry.applications.instances.values()].filter(app => app.document?.type === "group" && app.rendered);
  }

  /* ---------- The header ---------- */

  static renderHeader(app, html){
    const actor = app.document;
    if(actor?.type !== "group" || !this.enabled()) return;
    const header = (html ?? app.element)?.querySelector?.(".sheet-header");
    if(!header || header.querySelector(".macro-helper-journey")) return;
    try {
      this.addButtons(app, header);
      this.addJourney(app, header);
      this.markPace(app, header);
      this.paceUnits(app, header);
    } catch(err) { log.error("Group header :", err); }
  }

  static button({ action, icon, label, gmOnly = true }){
    const button = document.createElement("button");
    button.type = "button";
    button.className = `gold-button macro-helper-${action}`;
    button.dataset.tooltip = "";
    button.setAttribute("aria-label", game.i18n.localize(label));
    button.innerHTML = `<i class="${icon}" inert></i>`;
    if(gmOnly && !game.user.isGM) button.disabled = true;
    return button;
  }

  /* Travel and Pass Time, after dnd5e's Place Members and rest buttons */
  static addButtons(app, header){
    const buttons = header.querySelector(".sheet-header-buttons");
    if(!buttons) return;
    const travel = this.button({ action : "travel", icon : "fa-solid fa-route", label : "groupTravel.travel" });
    const pass = this.button({ action : "pass-time", icon : "fa-solid fa-hourglass-half", label : "groupTravel.passTime" });
    travel.addEventListener("click", () => this.notYet("groupTravel.travel"));
    pass.addEventListener("click", () => this.notYet("groupTravel.passTime"));
    buttons.append(travel, pass);
  }

  static addJourney(app, header){
    const actor = app.document;
    const row = document.createElement("div");
    row.className = "macro-helper-journey card";
    row.innerHTML = `
      <div class="header"><h3>${game.i18n.localize("groupTravel.journey")}</h3></div>
      <div class="info">
        <div class="clock" data-tooltip="${game.i18n.localize("groupTravel.clock")}">
          <i class="fa-solid fa-clock" inert></i>
          <span class="date"></span><span class="time"></span>
        </div>
        <div class="modes">${this.modeChips(actor)}</div>
        <div class="weather">${this.weatherSelect(actor)}</div>
        <button type="button" class="stealth unbutton ${this.flag(actor, "stealth") ? "active" : ""}"
          data-tooltip="${game.i18n.localize("groupTravel.stealth")}" ${game.user.isGM ? "" : "disabled"}>
          <i class="fa-solid fa-user-ninja" inert></i>
        </button>
        <div class="vehicle">${this.vehicleSeats(actor)}</div>
      </div>`;
    /* A full-width row under dnd5e's header */
    header.append(row);
    this.fillClock(row);

    if(!game.user.isGM) return;
    for(const chip of row.querySelectorAll(".modes [data-mode]")){
      chip.addEventListener("click", () => actor.setFlag(module.id, "travelMode", chip.dataset.mode));
    }
    row.querySelector(".weather select")?.addEventListener("change", event => actor.setFlag(module.id, "weather", event.target.value));
    row.querySelector(".stealth")?.addEventListener("click", () => actor.setFlag(module.id, "stealth", !this.flag(actor, "stealth")));
  }

  static flag(actor, key){
    return actor.getFlag(module.id, key);
  }

  /* Land / Water / Air : the one picked lit; the primary vehicle's own type marked */
  static modeChips(actor){
    const vehicle = actor.system.primaryVehicle;
    const ofVehicle = vehicle?.system?.details?.type;
    const mode = this.flag(actor, "travelMode") ?? ofVehicle ?? "land";
    return this.MODES.map(m => {
      const classes = ["chip", (m === mode) ? "active" : "", (m === ofVehicle) ? "vehicle" : ""].filter(c => c).join(" ");
      const label = game.i18n.localize(`DND5E.TRAVEL.Type.${m.capitalize()}`);
      return `<button type="button" class="unbutton ${classes}" data-mode="${m}" ${game.user.isGM ? "" : "disabled"}>${label}</button>`;
    }).join("");
  }

  static weatherSelect(actor){
    const now = this.flag(actor, "weather") ?? "clear";
    const options = this.WEATHER.map(w => `<option value="${w}" ${(w === now) ? "selected" : ""}>${game.i18n.localize(`groupTravel.weather.${w}`)}</option>`).join("");
    return `<i class="fa-solid fa-cloud-sun" inert data-tooltip="${game.i18n.localize("groupTravel.weatherLabel")}"></i>
      <select ${game.user.isGM ? "" : "disabled"}>${options}</select>`;
  }

  /* The primary vehicle's crew and passenger seats taken, of its seats */
  static vehicleSeats(actor){
    const vehicle = actor.system.primaryVehicle;
    if(!vehicle) return `<i class="fa-solid fa-sailboat" inert></i><span class="none">${game.i18n.localize("groupTravel.noVehicle")}</span>`;
    const seats = key => {
      const part = vehicle.system[key] ?? {};
      const taken = part.value?.length ?? 0;
      const over = Number.isFinite(part.max) && (taken > part.max);
      return `<span class="${over ? "over" : ""}" data-tooltip="${game.i18n.localize(`groupTravel.${key}`)}">
        <i class="fa-solid ${(key === "crew") ? "fa-people-group" : "fa-chair"}" inert></i> ${taken} / ${part.max ?? "—"}</span>`;
    };
    return `<span class="name">${foundry.utils.escapeHTML(vehicle.name)}</span>${seats("crew")}${seats("passengers")}`;
  }

  /* ---------- Members tab ---------- */

  static JOBS = ["none", "leader", "navigator", "lookout", "scout", "tracker"];
  static SEATS = { crew : "crew", passenger : "passengers", draft : "draft" };
  static WIDTH = 1000;
  static #dragging = null;

  /* Each member's job and way of travel on the group : flags.macro-helper.members[actor id] { job, travelBy, with }
     (with : the mount ridden or the member carrying them). Vehicle seats live in dnd5e's own lists on the vehicle. */
  static memberOf(group, actor){
    return { job : "none", travelBy : "walk", with : null, ...(this.flag(group, "members")?.[actor.id] ?? {}) };
  }

  static setMember(group, actor, changes){
    return group.update({ [`flags.${module.id}.members.${actor.id}`] : changes });
  }

  static creatures(group){
    return group.system.members.map(m => m.actor).filter(a => a?.system?.isCreature);
  }

  static vehicles(group){
    return group.system.members.map(m => m.actor).filter(a => a?.type === "vehicle");
  }

  static memberActor(group, id){
    return group.system.members.find(m => m.actor?.id === id)?.actor ?? null;
  }

  /* How a member travels : { by : walk / ride / carried / crew / passenger / draft, target : the mount, carrier or
     vehicle's id }. A vehicle seat wins; riding / carried only while that member is still on its own feet. */
  static travelOf(group, actor, depth = 0){
    for(const vehicle of this.vehicles(group)){
      for(const [by, key] of Object.entries(this.SEATS)){
        if(vehicle.system[key]?.value?.includes(actor.uuid)) return { by, target : vehicle.id };
      }
    }
    const { travelBy, with : target } = this.memberOf(group, actor);
    const other = ["ride", "carried"].includes(travelBy) && this.memberActor(group, target);
    if(other && (other !== actor) && (depth < 3)){
      const theirs = this.travelOf(group, other, depth + 1).by;
      if((theirs === "walk") || ((travelBy === "carried") && (theirs === "ride"))) return { by : travelBy, target };
    }
    return { by : "walk", target : null };
  }

  /* Who rides or is carried by that member */
  static carriedBy(group, actor, by){
    return this.creatures(group).filter(a => (a !== actor) && (this.travelOf(group, a).by === by) && (this.travelOf(group, a).target === actor.id));
  }

  /* A mount being ridden or a draft animal has no job; hirelings and sidekicks do */
  static hasJob(group, actor){
    return (this.travelOf(group, actor).by !== "draft") && !this.carriedBy(group, actor, "ride").length;
  }

  /* Pulling a vehicle : Beasts; anyone else (rare) only when the GM picks it */
  static canPull(actor, user){
    return (this.speed(actor, "walk") > 0) && (user.isGM || (actor.system.details?.type?.value === "beast"));
  }

  /* The ways that member can travel now : walking (a walk speed), riding a member at least one size larger that walks
     and no one else rides (2024 : one rider), carried by a member on its own feet or riding, a crew / passenger seat on
     each vehicle, pulling it. The current way stays listed even if it no longer fits. */
  static travelChoices(group, actor, user = game.user){
    const size = a => CONFIG.DND5E.actorSizes[a.system.traits?.size]?.numerical ?? 2;
    const others = this.creatures(group).filter(a => a !== actor);
    const choices = [];
    if(this.speed(actor, "walk") > 0) choices.push({ value : "walk", by : "walk" });
    for(const mount of others){
      if((this.travelOf(group, mount).by !== "walk") || (size(mount) <= size(actor)) || !this.travelTypes(mount).size) continue;
      const taken = this.carriedBy(group, mount, "ride").some(a => a !== actor);
      choices.push({ value : `ride:${mount.id}`, by : "ride", name : mount.name, disabled : taken });
    }
    for(const carrier of others){
      if(["walk", "ride"].includes(this.travelOf(group, carrier).by)) choices.push({ value : `carried:${carrier.id}`, by : "carried", name : carrier.name });
    }
    for(const vehicle of this.vehicles(group)){
      for(const by of ["crew", "passenger"]) choices.push({ value : `${by}:${vehicle.id}`, by, name : vehicle.name });
      if(this.canPull(actor, user)) choices.push({ value : `draft:${vehicle.id}`, by : "draft", name : vehicle.name });
    }
    const now = this.travelOf(group, actor);
    const value = now.target ? `${now.by}:${now.target}` : now.by;
    if(!choices.some(c => c.value === value)){
      const other = this.memberActor(group, now.target);
      choices.unshift({ value, by : now.by, name : other?.name, stale : true });
    }
    return choices;
  }

  /* Write a way of travel : the group's flag, and the vehicles' crew / passenger / draft lists (dnd5e's own) */
  static async setTravel(group, actor, value){
    const [by, target = null] = value.split(":");
    const seat = this.SEATS[by];
    for(const vehicle of this.vehicles(group)){
      const changes = {};
      for(const key of Object.values(this.SEATS)){
        const list = vehicle.system._source[key]?.value ?? [];
        const want = (key === seat) && (vehicle.id === target);
        if(want && !list.includes(actor.uuid)) changes[`system.${key}.value`] = [...list, actor.uuid];
        if(!want && list.includes(actor.uuid)) changes[`system.${key}.value`] = list.filter(u => u !== actor.uuid);
      }
      if(!foundry.utils.isEmpty(changes)) await vehicle.update(changes);
    }
    return this.setMember(group, actor, seat ? { travelBy : "walk", with : null } : { travelBy : by, with : target });
  }

  /* A member's owner (or the GM) changes their job or way of travel : the GM's client writes it (players rarely own
     the group or its vehicles), after checking it's one of that member's choices */
  static change(group, actor, changes){
    return gm.run("groupMember", { group : group.uuid, actor : actor.uuid, ...changes });
  }

  static async memberAsGM({ group, actor, job, travel }, user){
    group = await fromUuid(group);
    actor = await fromUuid(actor);
    if((group?.type !== "group") || !actor || (this.memberActor(group, actor.id) !== actor)) return false;
    if(!user.isGM && !actor.testUserPermission(user, "OWNER")) return false;
    if(job !== undefined){
      if(!this.JOBS.includes(job) || !this.hasJob(group, actor)) return false;
      await this.setMember(group, actor, { job });
    }
    if(travel !== undefined){
      if(!this.travelChoices(group, actor, user).some(c => (c.value === travel) && !c.disabled)) return false;
      await this.setTravel(group, actor, travel);
    }
    return true;
  }

  /* The members' order : the GM, or the owner of the member whose job is Leader */
  static canOrder(group, user = game.user){
    return user.isGM || this.creatures(group).some(a => (this.memberOf(group, a).job === "leader") && a.testUserPermission(user, "OWNER"));
  }

  static async orderAsGM({ group, order }, user){
    group = await fromUuid(group);
    if((group?.type !== "group") || !Array.isArray(order) || !this.canOrder(group, user)) return false;
    const ids = order.filter(id => this.memberActor(group, id));
    await group.setFlag(module.id, "order", ids);
    return true;
  }

  /* dnd5e's rows keep everything; a third card goes on the right of each */
  static renderMembers(app, html, options){
    const group = app.document;
    if(group?.type !== "group" || !this.enabled()) return;
    if(options?.isFirstRender && (app.position.width < this.WIDTH)) app.setPosition({ width : this.WIDTH });
    const tab = (html ?? app.element)?.querySelector?.(".tab[data-tab='members']");
    if(!tab) return;
    tab.classList.add("macro-helper-members");
    try {
      for(const row of tab.querySelectorAll("li.member[data-uuid]")){
        if(row.querySelector(".macro-helper-road")) continue;
        const actor = this.actorOf(row.dataset.uuid);
        if(!actor) continue;
        row.prepend(this.gripFor(group, tab, row));
        row.append(actor.system.isCreature ? this.travelCard(group, actor) : this.vehicleCard(group, actor));
      }
      this.sortRows(group, tab);
    } catch(err) { log.error("Group members :", err); }
  }

  /* dnd5e sorts each section by name : the group's own order goes first, the rest keep dnd5e's */
  static sortRows(group, tab){
    const order = this.flag(group, "order") ?? [];
    for(const menu of tab.querySelectorAll("menu.members")){
      const rank = row => { const i = order.indexOf(this.actorOf(row.dataset.uuid)?.id); return (i < 0) ? order.length : i; };
      [...menu.querySelectorAll(":scope > li.member[data-uuid]")].map((row, i) => ({ row, rank : rank(row), i }))
        .sort((a, b) => (a.rank - b.rank) || (a.i - b.i)).forEach(({ row }) => menu.append(row));
    }
  }

  /* Drag a row by its grip, within its own section (Characters, NPCs, Vehicles) */
  static gripFor(group, tab, row){
    const grip = document.createElement("div");
    grip.className = "macro-helper-grip";
    grip.dataset.tooltip = game.i18n.localize("groupTravel.order");
    grip.innerHTML = `<i class="fa-solid fa-grip-vertical" inert></i>`;
    if(!this.canOrder(group)){
      grip.classList.add("disabled");
      return grip;
    }
    grip.draggable = true;
    grip.addEventListener("dragstart", event => {
      event.stopPropagation();
      this.#dragging = row;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", "");
      event.dataTransfer.setDragImage(row, 20, 20);
      row.classList.add("dragging");
    });
    grip.addEventListener("dragend", () => { row.classList.remove("dragging"); this.#dragging = null; });
    const same = () => this.#dragging && (this.#dragging !== row) && (this.#dragging.parentElement === row.parentElement);
    row.addEventListener("dragover", event => { if(same()){ event.preventDefault(); event.stopPropagation(); } });
    row.addEventListener("drop", event => {
      if(!same()) return;
      event.preventDefault();
      event.stopPropagation();
      const box = row.getBoundingClientRect();
      row[(event.clientY < box.top + box.height / 2) ? "before" : "after"](this.#dragging);
      const order = [...tab.querySelectorAll("li.member[data-uuid]")].map(r => this.actorOf(r.dataset.uuid)?.id).filter(id => id);
      gm.run("groupOrder", { group : group.uuid, order });
    });
    return grip;
  }

  static options(keys, now, prefix){
    return keys.map(k => `<option value="${k}" ${(k === now) ? "selected" : ""}>${game.i18n.localize(`${prefix}.${k}`)}</option>`).join("");
  }

  static names(actors){
    return actors.map(a => foundry.utils.escapeHTML(a.name)).join(", ");
  }

  /* Job, travels by, hours since the group's Long Rest (the GM types them), status icons */
  static travelCard(group, actor){
    const member = this.memberOf(group, actor);
    const canEdit = game.user.isGM || actor.isOwner;
    const riders = this.carriedBy(group, actor, "ride");
    const limit = Number(group.system.attributes?.travel?.time) || 8;
    const hours = Number(actor.getFlag(module.id, "travelHours")) || 0;
    const shown = Math.round(hours * 10) / 10;
    const card = document.createElement("div");
    card.className = "macro-helper-road card";
    card.innerHTML = `
      <div class="row">
        ${this.hasJob(group, actor) ? `<select class="job" data-tooltip="${game.i18n.localize("groupTravel.jobLabel")}" ${canEdit ? "" : "disabled"}>
          ${this.options(this.JOBS, member.job, "groupTravel.job")}</select>` : ""}
        ${riders.length
          ? `<span class="ridden" data-tooltip="${game.i18n.localize("groupTravel.riddenBy")}"><i class="fa-solid fa-horse-head" inert></i> ${this.names(riders)}</span>`
          : `<select class="travel-by" data-tooltip="${game.i18n.localize("groupTravel.travelByLabel")}" ${canEdit ? "" : "disabled"}>
              ${this.travelByOptions(group, actor)}</select>`}
      </div>
      <div class="row">
        <div class="hours" data-tooltip="${game.i18n.localize("groupTravel.hoursHint")}">
          <i class="fa-solid fa-person-hiking" inert></i>
          <div class="meter progress meter-sm" style="--bar-percentage : ${Math.min(100, hours / limit * 100)}%"></div>
          <span class="${(hours > limit) ? "over" : ""}">${game.user.isGM
            ? `<input type="number" class="hours-value" min="0" step="0.1" value="${shown}">` : shown} / ${limit} h</span>
        </div>
        <div class="status">${this.statusIcons(group, actor)}</div>
      </div>`;
    card.querySelector(".hours-value")?.addEventListener("change", event => {
      const value = Math.max(0, Number(event.target.value) || 0);
      if(value) actor.setFlag(module.id, "travelHours", value); else actor.unsetFlag(module.id, "travelHours");
    });
    if(!canEdit) return card;
    card.querySelector(".job")?.addEventListener("change", event => this.change(group, actor, { job : event.target.value }));
    card.querySelector(".travel-by")?.addEventListener("change", event => this.change(group, actor, { travel : event.target.value }));
    return card;
  }

  /* "Riding : <mount>" (a taken mount greyed), "Carried by : <member>", "Crew / Passenger : <vehicle>", pulling it */
  static travelByOptions(group, actor){
    const now = this.travelOf(group, actor);
    const value = now.target ? `${now.by}:${now.target}` : now.by;
    return this.travelChoices(group, actor).map(c => {
      const label = game.i18n.localize(`groupTravel.travelBy.${c.by}`);
      const text = c.name ? `${label} : ${c.name}` : label;
      return `<option value="${c.value}" ${(c.value === value) ? "selected" : ""} ${(c.disabled || c.stale) ? "disabled" : ""}>${foundry.utils.escapeHTML(text)}</option>`;
    }).join("");
  }

  /* Exhaustion, Slowed, who they carry (later : Dehydrated, Malnourished, encumbrance, Galloped) */
  static statusIcons(group, actor){
    const icons = [];
    const exhaustion = Number(actor.system.attributes?.exhaustion) || 0;
    if(exhaustion) icons.push(`<span data-tooltip="${CONFIG.DND5E.conditionTypes.exhaustion?.name ?? "Exhaustion"} ${exhaustion}">
      <img src="${CONFIG.DND5E.conditionTypes.exhaustion?.img ?? CONFIG.DND5E.conditionTypes.exhaustion?.icon}"><b>${exhaustion}</b></span>`);
    if(actor.system.attributes?.movement?.slowed) icons.push(`<span data-tooltip="${game.i18n.localize("DND5E.TRAVEL.Slowed.Member")}"><i class="fa-solid fa-triangle-exclamation" inert></i></span>`);
    const carried = this.carriedBy(group, actor, "carried");
    if(carried.length) icons.push(`<span data-tooltip="${game.i18n.localize("groupTravel.carrying")} : ${this.names(carried)}"><i class="fa-solid fa-person-carry-box" inert></i><b>${carried.length}</b></span>`);
    return icons.join("") || `<span class="none">${game.i18n.localize("groupTravel.statusOk")}</span>`;
  }

  /* A vehicle's row : who crews it, rides in it, pulls it */
  static vehicleCard(group, vehicle){
    const actors = key => (vehicle.system[key]?.value ?? []).map(uuid => this.actorOf(uuid)).filter(a => a);
    const line = (key, icon) => {
      const list = actors(key);
      const max = vehicle.system[key]?.max;
      const over = Number.isFinite(max) && (list.length > max);
      return `<div class="${over ? "over" : ""}" data-tooltip="${game.i18n.localize(`groupTravel.${key}`)}">
        <i class="fa-solid ${icon}" inert></i> ${list.length}${(key === "draft") ? "" : ` / ${max ?? "—"}`} <span class="names">${this.names(list)}</span></div>`;
    };
    const card = document.createElement("div");
    card.className = "macro-helper-road vehicle card";
    card.innerHTML = `${line("crew", "fa-people-group")}${line("passengers", "fa-chair")}${line("draft", "fa-horse")}`;
    return card;
  }

  /* ---------- Clock ---------- */

  /* The Calendar HUD's own date and time formats (each user's choice) */
  static formatted(){
    const calendar = game.time.calendar;
    const formatters = CONFIG.DND5E?.calendar?.formatters ?? [];
    const prefs = game.settings.get("dnd5e", "calendarPreferences")?.formatters ?? {};
    const as = (value, fallback) => {
      const formatter = formatters.find(f => f.value === value)?.formatter ?? fallback;
      try { return calendar.format(game.time.components, formatter); } catch { return ""; }
    };
    return { date : as(prefs.date, "formatMonthDay"), time : as(prefs.time, "formatHoursMinutes") };
  }

  static fillClock(element){
    const clock = element.querySelector(".macro-helper-journey .clock") ?? element.querySelector(".clock");
    if(!clock) return;
    const { date, time } = this.formatted();
    clock.querySelector(".date").textContent = date;
    clock.querySelector(".time").textContent = time;
  }

  static updateClocks(){
    for(const app of this.sheets()) this.fillClock(app.element);
  }

  static notYet(label){
    ui.notifications.info(game.i18n.format("groupTravel.notYet", { what : game.i18n.localize(label) }));
  }
}
