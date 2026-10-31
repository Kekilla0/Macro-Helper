import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { patch } from '../patch.js';
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
    /* The clock follows world time without redrawing the whole sheet */
    Hooks.on("updateWorldTime", () => this.updateClocks());
    /* dnd5e's group rest windows : a saved empty member list rests nobody (only the clock moves) : tick everyone */
    Hooks.on("renderShortRestDialog", (app, html) => this.restTargets(app, html));
    Hooks.on("renderLongRestDialog", (app, html) => this.restTargets(app, html));
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

  /* The creatures walking with the group : members not aboard the primary vehicle, plus its draft animals */
  static walkers(group){
    const vehicle = group.primaryVehicle?.system;
    const aboard = new Set([...(vehicle?.crew?.value ?? []), ...(vehicle?.passengers?.value ?? [])]);
    const walkers = group.members.map(m => m.actor).filter(a => a?.system?.isCreature && !aboard.has(a.uuid));
    for(const uuid of vehicle?.draft?.value ?? []){
      const actor = this.actorOf(uuid);
      if(actor?.system?.isCreature && !walkers.includes(actor)) walkers.push(actor);
    }
    return walkers;
  }

  /* The travel types (land / water / air) a creature has a speed for : its own speeds, not today's (Unconscious is 0) */
  static travelTypes(actor){
    const movement = actor.system.attributes?.movement ?? {};
    const source = actor._source?.system?.attributes?.movement?.speeds ?? {};
    const types = new Set();
    for(const [type, config] of Object.entries(CONFIG.DND5E.movementTypes)){
      if(type === "jump") continue;
      const speed = Number(source[type]) || Number(movement.fromSpecies?.[type]) || Number(movement.speeds?.[type]) || 0;
      if(speed > 0) types.add(config.travel ?? "land");
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
