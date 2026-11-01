import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { patch } from '../patch.js';
import { gm } from '../gm.js';
import { limits } from './limits.js';
import { rollRequests } from '../requests/requests.js';
import { restMinutesOf, standardRest } from './rest-length.js';
import { buttonRow, addButton, makeButton } from '../helpers/utils.js';
import { groupWeather } from './group-weather.js';
const log = logger.for(import.meta.url);

/**
 * Group Travel (dnd5e's Group actor) : the group sheet's header, rearranged and added to.
 *   dnd5e keeps : the portrait, name, Place Members, the group Short / Long Rest buttons, Travel Pace (its pace arrows
 *                 and Land / Water / Air paces), Advancement.
 *   added       : a Journey card beside the portrait, under Travel Pace / Advancement (as wide as both) : the clock (dnd5e's Calendar, in the Calendar HUD's own date / time formats), the travel
 *                 mode chips (Land / Water / Air; the primary vehicle's type marked), Weather (GM : temperature, wind,
 *                 precipitation, a Roll on the DMG table; group-weather.js : hourly saves, effects), Stealth
 *                 (toggle), the primary vehicle's crew / passenger seats; Travel and Pass Time beside the rest buttons.
 *   Everyone sees it; only the GM uses it, but Travel and Gallop are also the Leader's player's. Stealth on : each leg ends with a group Stealth check, rolled at once and whispered to the GM.
 *   Travel : the Group's token moved on the travel map (the ACTIVE scene, its grid in miles or km; on an inactive one
 *   in miles, Rule Limits warns or stops the move, no time passes) by the GM or the
 *   Leader's player passes the time at once (exact : 1.1 h = 66 min, at the PHB hourly rate), adds it to the counted
 *   members' hours and posts a log card (the GM's Undo puts it all back). The ruler shows each leg's time and arrival,
 *   spaces past the day's travel hours red (forced march), the galloped hour yellow. The Travel window does the same
 *   off the map (miles or hours); Pass Time (GM) moves only the clock.
 *   Forced march (2024 DMG Extended Travel) : at the end of each hour past the day's travel hours, each counted member
 *   makes a Constitution save, DC 10 + 1 per hour past, or gains 1 Exhaustion : a public request card per hour (Roll all;
 *   Exhaustion +1 on a failed row). Undo deletes the cards; Exhaustion already taken stays. Rests : dnd5e's group Short /
 *   Long Rest move the clock (its calendar on); a Long Rest clears the hours. A group rest lasts as long as the
 *   longest rest among the members ticked (2024 Elf Trance : a Long Rest in 4 h; restLength legos), shown in its window.
 *   Weights (2024 PHB Carrying Capacity) : a member carried or riding counts on its carrier's / mount's load (its body
 *   plus all it carries), inside dnd5e's own encumbrance, so dnd5e's Encumbrance setting decides what being over does
 *   (Exceeding Carrying Capacity : Speed 5 ft, so the group goes Slow). Carried by is offered up to twice the carrier's
 *   capacity (dragging), Riding up to the mount's capacity. Pulling a vehicle : each puller takes up to 5 times its
 *   capacity left (its own load first), the team adds; the vehicle, its cargo and everyone aboard are pulled, each
 *   puller's share (split by capacity left) counting a fifth on its load. Body weights : the GM's typed one, the
 *   character's Weight, else an estimate by size. The group actor holds nothing : what lands on it (dnd5e's Award, a
 *   drop) goes to the member picked for it (group-inventory.js draws the Inventory tab).
 *   Vehicles : everyone goes by the group's travel hours. A vehicle joining the group brings its crew, passengers and
 *   draft animals in as members (and takes them out when it leaves); a Beast can't crew. Seats over their number
 *   (homebrew : seats by size), a vehicle too heavy for its team or a member over twice its capacity : Rule Limits
 *   warns or stops the travel.
 *   Travel Pace (2024 RAW) : the PHB's fixed table (Normal 3 mph / 24 miles a day, Fast 30, Slow 18), whatever the
 *   members' speeds; Water / Air only when every member has that speed. The DMG's Slower Travelers : Slow when any
 *   member on its own feet (walking or pulling) is slowed (dnd5e's movement.slowed : Speed half or less).
 *   A land vehicle uses the table too (PHB : land vehicles choose a pace as normal), capped by its own speed when the
 *   GM typed one, and goes nowhere with no one pulling it; a ship or airship keeps its own speed (dnd5e). Paces the GM
 *   typed in the group's Travel Pace window override all of it ("Travel Pace OVERRIDE").
 */
export class groupTravel{
  static enabled = settings.on("groupTravel");
  static MODES = ["land", "water", "air"];

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("renderActorSheetV2", (app, html) => this.renderHeader(app, html));
    Hooks.on("renderActorSheetV2", (app, html, context, options) => this.renderMembers(app, html, options));
    /* The clock follows world time without redrawing the whole sheet */
    Hooks.on("updateWorldTime", () => this.updateClocks());
    /* dnd5e's group rest windows : a saved empty member list rests nobody (only the clock moves) : tick everyone */
    Hooks.on("renderShortRestDialog", (app, html) => this.restTargets(app, html));
    Hooks.on("renderLongRestDialog", (app, html) => this.restTargets(app, html));
    /* A group rest lasts as long as its longest member's (Trance : 4 h) */
    for(const type of ["Short", "Long"]) Hooks.on(`dnd5e.pre${type}Rest`, (actor, config) => this.restLength(actor, config));
    /* A Long Rest, on the member's own sheet or the group's : their travel hours start again */
    Hooks.on("dnd5e.restCompleted", (actor, result, config) => this.restHours(actor, config));
    gm.handle("groupMember", (data, user) => this.memberAsGM(data, user));
    gm.handle("groupOrder", (data, user) => this.orderAsGM(data, user));
    /* Travel : the Group token's moves on the travel map, the Travel and Pass Time windows; the log cards' Undo */
    gm.handle("groupLeg", (data, user) => this.legAsGM(data, user));
    gm.handle("groupPass", (data, user) => this.passAsGM(data, user));
    gm.handle("groupUndo", (data, user) => this.undoAsGM(data, user));
    gm.handle("groupGallop", (data, user) => this.gallopAsGM(data, user));
    Hooks.on("preMoveToken", (token, movement, options) => this.preMove(token, movement, options));
    Hooks.on("moveToken", (token, movement, operation, user) => this.onMove(token, movement, operation, user));
    Hooks.on("renderChatMessageHTML", (message, html) => this.drawLog(message, html));
    const self = this;
    patch.wrap("CONFIG.Token.rulerClass.prototype._getWaypointLabelContext", function(wrapped, ...args){
      const context = wrapped(...args);
      try { self.rulerLabel(this.token, args[0], context); } catch(err) { log.error("Travel ruler :", err); }
      return context;
    });
    patch.wrap("CONFIG.Token.rulerClass.prototype._getGridHighlightStyle", function(wrapped, ...args){
      const style = wrapped(...args);
      try { return self.rulerStyle(this.token, args[0], style); } catch(err) { log.error("Travel ruler :", err); return style; }
    });
    patch.wrap("CONFIG.Actor.dataModels.group.prototype.getTravelPace", function(wrapped, ...args){
      const pace = wrapped(...args);
      if(!self.enabled()) return pace;
      try { return self.travelPace(this, pace); } catch(err) { log.error("Travel Pace :", err); return pace; }
    });
    /* Carried and riding members count on their carrier's encumbrance (dnd5e's, so its own Encumbrance setting applies) */
    patch.wrap("dnd5e.dataModels.actor.AttributesFields.prepareEncumbrance", function(wrapped, ...args){
      const result = wrapped(...args);
      try { self.addCarried(this); } catch(err) { log.error("Group weights :", err); }
      return result;
    });
    Hooks.once("ready", () => { this.refreshLoads(); this.joinAll(); });
    /* A vehicle's crew, passengers and draft animals join the group with it (and leave with it) */
    Hooks.on("updateActor", (actor, changes) => this.joinsChanged(actor, changes));
    /* Switched on or off : the members' loads (carried members, pulling shares) come and go */
    Hooks.on("updateSetting", setting => [`${module.id}.groupTravel`, `${module.id}.homebrewSeats`].includes(setting.key) && this.settingChanged());
    Hooks.on("updateActor", (actor, changes) => this.loadsChanged(actor, changes));
    for(const hook of ["createItem", "updateItem", "deleteItem"]){
      Hooks.on(hook, (item, changes) => this.gearChanged(item, (hook === "updateItem") ? changes : null));
    }
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

  /* The members on their own feet : walking or pulling a vehicle (not aboard one, riding or carried) */
  static walkers(group){
    return group.members.map(m => m.actor).filter(a => a?.system?.isCreature && ["walk", "draft"].includes(this.travelOf(group.parent, a).by));
  }

  /* The members pulling that vehicle */
  static pullersOf(group, vehicle){
    return this.creatures(group).filter(a => vehicle.system.draft?.value?.includes(a.uuid));
  }

  /* A vehicle's own speed (mph / kph in the group's units), only when the GM typed one : dnd5e otherwise reads its
     jump (Strength / 2 ft) as a land speed (0.5 mph). null = none */
  static vehicleSpeed(group, vehicle, type = "land"){
    const source = vehicle?._source?.system?.attributes?.travel ?? {};
    const typed = v => `${v ?? ""}`.trim() !== "";
    const travel = vehicle?.system?.attributes?.travel;
    if(!travel || !(typed(source.speeds?.[type]) || typed(source.paces?.[type]))) return null;
    const speed = typed(source.speeds?.[type]) ? Number(travel.speeds?.[type]) : (Number(travel.paces?.[type]) || 0) / (Number(travel.time) || 24);
    if(!(speed > 0)) return null;
    const to = group.attributes.travel.units ?? dnd5e.utils.defaultUnits("travel");
    const from = travel.units ?? to;
    return (from === to) ? speed : dnd5e.utils.convertTravelSpeed(speed, from, { to, strict : false }).value;
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

  /* RAW : the table for every travel type all the walkers have (a land vehicle : land only, if something pulls it, no
     faster than its own speed); null = dnd5e's own. cap : the vehicle's speed when it's slower than the table's hour */
  static rawPace(group, chosen){
    const vehicle = group.primaryVehicle;
    if(vehicle && (vehicle.system.details?.type !== "land")) return null;
    const walkers = this.walkers(group);
    const slowed = walkers.some(a => a.system.attributes?.movement?.slowed);
    const order = Object.keys(CONFIG.DND5E.travelPace);
    const pace = (slowed && (order.indexOf(chosen) > order.indexOf("slow"))) ? "slow" : chosen;
    const types = Object.keys(CONFIG.DND5E.travelTypes);
    const noTeam = !!vehicle && !this.pullersOf(group.parent, vehicle).length;
    const has = type => vehicle ? ((type === "land") && !noTeam) : (walkers.length && walkers.every(a => this.travelTypes(a).has(type)));
    const speed = vehicle ? this.vehicleSpeed(group, vehicle) : null;
    const hour = this.tablePace(group, pace, 1);
    const cap = ((speed !== null) && (speed < hour)) ? speed : null;
    const day = (cap !== null) ? Math.min(this.tablePace(group, pace), this.round(cap * group.attributes.travel.time)) : this.tablePace(group, pace);
    const paces = Object.fromEntries(types.map(type => [type, has(type) ? day : null]));
    return { pace : { slowed, available : true, label : CONFIG.DND5E.travelPace[pace]?.label, value : pace }, paces, cap, rate : (cap ?? hour), noTeam };
  }

  /* Why the group has no pace : nothing pulls the primary vehicle, or no pace for the travel mode */
  static noPaceText(group){
    const raw = !this.overridden(group.system) && this.rawPace(group.system, group.system.attributes.travel.pace);
    if(raw?.noTeam) return game.i18n.format("groupTravel.noTeam", { vehicle : group.system.primaryVehicle.name });
    return game.i18n.format("groupTravel.noPace", { mode : game.i18n.localize(`DND5E.TRAVEL.Type.${this.mode(group).capitalize()}`) });
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
      if(!hours) continue;
      value.dataset.tooltip = game.i18n.format("groupTravel.paceHint", {
        hour : `${table ? table.rate : Math.round(day / hours * 10) / 10} ${game.i18n.localize(units.abbreviationHour)}`, hours, day : `${day} ${game.i18n.localize(units.abbreviationDay)}` });
      if(table?.cap != null) value.dataset.tooltip += `<br>${game.i18n.format("groupTravel.paceCap", { vehicle : foundry.utils.escapeHTML(group.primaryVehicle.name),
        speed : `${this.round(table.cap)} ${game.i18n.localize(units.abbreviationHour)}`, table : `${this.tablePace(group, table.pace.value, 1)} ${game.i18n.localize(units.abbreviationHour)}` })}`;
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

  /* A Long Rest clears the travel hours; any rest lets a mount gallop again */
  static restHours(actor, config){
    if(!this.enabled() || !["short", "long"].includes(config?.type) || (actor?.type === "group") || !actor?.isOwner) return;
    if(actor.getFlag(module.id, "galloped")) actor.unsetFlag(module.id, "galloped");
    if((config.type === "long") && actor.getFlag(module.id, "travelHours")) actor.unsetFlag(module.id, "travelHours");
  }

  static restTargets(app, html){
    if((app.actor?.type !== "group") || !this.enabled()) return;
    const element = (html instanceof HTMLElement) ? html : app.element;
    const boxes = [...element.querySelectorAll("dnd5e-checkbox[name^='targets.']")];
    if(boxes.length && boxes.every(box => !box.checked)) for(const box of boxes) box.checked = true;
    const type = app.config?.type;
    if(!["short", "long"].includes(type)) return;
    const ticked = () => boxes.filter(box => box.checked).map(box => box.name.slice("targets.".length));
    const fill = () => this.restDuration(app, element, this.groupRest(app.actor, type, ticked()));
    for(const box of boxes) box.addEventListener("change", fill);
    fill();
  }

  /* How long a group rest takes : the longest rest among the members resting, each their own (Trance : a Long Rest in
     4 h). { minutes, members : [{ actor, minutes, source }] } */
  static groupRest(group, type, ids = null){
    const members = this.creatures(group).filter(a => !ids || ids.includes(a.id))
      .map(actor => ({ actor, ...restMinutesOf(actor, type) }));
    const minutes = members.length ? Math.max(...members.map(m => m.minutes)) : standardRest(type);
    return { minutes, members };
  }

  /* The group's rest window opens on the standard length (8 h), or longer when a member needs it */
  static restLength(actor, config){
    if((actor?.type !== "group") || !this.enabled() || !["short", "long"].includes(config?.type)) return;
    if(Number(config.duration) !== standardRest(config.type)) return;
    const saved = [...(actor.getFlag("dnd5e", "restSettings")?.targets ?? [])];
    const ids = Array.isArray(config.targets) ? config.targets : (saved.length ? saved : null);
    config.duration = Math.max(config.duration, this.groupRest(actor, config.type, ids).minutes);
  }

  /* The window's Duration : one number with - / +, never under the longest rest among the members ticked (Trance : a
     Long Rest in 4 h); its tooltip says who needs how long */
  static restDuration(app, element, { minutes, members }){
    const value = element.querySelector("[name='duration.value']");
    const unit = element.querySelector("[name='duration.unit']");
    const field = value?.closest(".split-group");
    if(!unit || !field) return;
    const step = (minutes % 60 || standardRest(app.config.type) % 60) ? 1 : 60;
    const label = game.i18n.localize(step === 60 ? "groupTravel.restHours" : "groupTravel.restMinutes");
    const min = minutes / step;
    let box = field.querySelector(".macro-helper-rest-hours");
    if(!box){
      field.classList.add("macro-helper-rest-field");
      box = document.createElement("div");
      box.className = "macro-helper-rest-hours";
      box.innerHTML = `<button type="button" class="unbutton minus"><i class="fa-solid fa-minus" inert></i></button>
        <input type="number" step="1"><span class="unit">${label}</span>
        <button type="button" class="unbutton plus"><i class="fa-solid fa-plus" inert></i></button>`;
      field.querySelector(":scope > .form-fields")?.prepend(box);
      const input = box.querySelector("input");
      box.querySelector(".minus").addEventListener("click", () => box.set(Number(input.value) - 1));
      box.querySelector(".plus").addEventListener("click", () => box.set(Number(input.value) + 1));
      input.addEventListener("change", () => box.set(Number(input.value)));
      field.querySelector("[data-action='setDurationSunrise']")?.addEventListener("click", () => setTimeout(() =>
        box.set(Number(value.value) * ((unit.value === "minute") ? 1 : 60) / step)));
    }
    const input = box.querySelector("input");
    box.set = n => {
      const amount = Math.max(box.min, Math.round(Number.isFinite(n) ? n : box.min));
      input.value = value.value = app.macroHelperRest = amount;
      unit.value = (step === 60) ? "hour" : "minute";
      input.min = box.min;
      box.querySelector(".minus").disabled = amount <= box.min;
    };
    box.min = min;
    box.set(app.macroHelperRest ?? Number(app.config.duration ?? standardRest(app.config.type)) / step);
    const hint = field.querySelector(":scope > .hint");
    if(!hint) return;
    const lengths = new Map();
    for(const m of members) (lengths.get(m.minutes) ?? lengths.set(m.minutes, []).get(m.minutes)).push(m.actor.name);
    hint.textContent = game.i18n.format("groupTravel.restAtLeast", { length : this.hm(minutes / 60) });
    hint.dataset.tooltip = [...lengths.entries()].sort(([x], [y]) => y - x)
      .map(([length, names]) => `${this.hm(length / 60)} : ${foundry.utils.escapeHTML(names.join(", "))}`).join("<br>");
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

  /* Travel (the GM or the Leader's player) and Pass Time (the GM), after dnd5e's Place Members and rest buttons */
  static addButtons(app, header){
    const buttons = header.querySelector(".sheet-header-buttons");
    if(!buttons) return;
    const travel = this.button({ action : "travel", icon : "fa-solid fa-route", label : "groupTravel.travel", gmOnly : false });
    const pass = this.button({ action : "pass-time", icon : "fa-solid fa-hourglass-half", label : "groupTravel.passTime" });
    travel.disabled = !this.canTravel(app.document);
    travel.addEventListener("click", () => this.travelWindow(app.document));
    pass.addEventListener("click", () => this.passWindow(app.document));
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
        <div class="weather">${groupWeather.selects(actor)}</div>
        <button type="button" class="stealth unbutton ${this.flag(actor, "stealth") ? "active" : ""}"
          data-tooltip="${game.i18n.localize("groupTravel.stealth")}" ${game.user.isGM ? "" : "disabled"}>
          <i class="fa-solid fa-user-ninja" inert></i>
        </button>
        ${this.gallopButton(actor)}
        <div class="vehicle">${this.vehicleSeats(actor)}</div>
      </div>`;
    /* Beside the portrait, under Travel Pace / Advancement */
    (header.querySelector(":scope > .right") ?? header).append(row);
    this.fillClock(row);
    row.querySelector(".gallop:not([disabled])")?.addEventListener("click", () => gm.run("groupGallop", { group : actor.uuid }));

    if(!game.user.isGM) return;
    for(const chip of row.querySelectorAll(".modes [data-mode]")){
      chip.addEventListener("click", () => actor.setFlag(module.id, "travelMode", chip.dataset.mode));
    }
    groupWeather.listen(actor, row.querySelector(".weather"));
    row.querySelector(".stealth")?.addEventListener("click", () => actor.setFlag(module.id, "stealth", !this.flag(actor, "stealth")));
  }

  static flag(actor, key){
    return actor.getFlag(module.id, key);
  }

  /* Land / Water / Air : the one picked lit; the primary vehicle's own type marked */
  static modeChips(actor){
    const vehicle = actor.system.primaryVehicle;
    const ofVehicle = vehicle?.system?.details?.type;
    const mode = this.mode(actor);
    return this.MODES.map(m => {
      const classes = ["chip", (m === mode) ? "active" : "", (m === ofVehicle) ? "vehicle" : ""].filter(c => c).join(" ");
      const label = game.i18n.localize(`DND5E.TRAVEL.Type.${m.capitalize()}`);
      return `<button type="button" class="unbutton ${classes}" data-mode="${m}" ${game.user.isGM ? "" : "disabled"}>${label}</button>`;
    }).join("");
  }

  /* The primary vehicle's crew and passenger seats taken, of its seats */
  static vehicleSeats(actor){
    const vehicle = actor.system.primaryVehicle;
    if(!vehicle) return `<i class="fa-solid fa-sailboat" inert></i><span class="none">${game.i18n.localize("groupTravel.noVehicle")}</span>`;
    const seats = key => {
      const part = vehicle.system[key] ?? {};
      const taken = this.seatsTaken(vehicle, key);
      const over = Number.isFinite(part.max) && (taken > part.max);
      return `<span class="${over ? "over" : ""}" data-tooltip="${game.i18n.localize(`groupTravel.${key}`)}">
        <i class="fa-solid ${(key === "crew") ? "fa-people-group" : "fa-chair"}" inert></i> ${taken} / ${part.max ?? "—"}</span>`;
    };
    return `<span class="name">${foundry.utils.escapeHTML(vehicle.name)}</span>${seats("crew")}${seats("passengers")}`;
  }

  /* ---------- Members tab ---------- */

  static JOBS = ["none", "leader", "navigator", "lookout", "scout", "tracker", "forager"];
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

  /* Crewing a vehicle : any creature but a Beast */
  static canCrew(actor){
    return actor.system.details?.type?.value !== "beast";
  }

  /* Pulling a vehicle : any member on its feet with some carrying capacity left (2024 : 5 times it, the team adds) */
  static canPull(actor){
    if(!(this.speed(actor, "walk") > 0)) return false;
    if(!this.weighs()) return true;
    const { value = 0, max = 0 } = actor.system.attributes?.encumbrance ?? {};
    return value < max;
  }

  /* The ways that member can travel now : walking (a walk speed), riding a member at least one size larger that walks,
     no one else rides (2024 : one rider) and can carry it, carried by a member on its own feet or riding that can at
     least drag it (twice its capacity), a crew seat (not a Beast : crewing takes hands) / passenger seat on each
     vehicle, pulling it. Weights only count when
     dnd5e's Encumbrance setting is on. The current way stays listed even if it no longer fits. */
  static travelChoices(group, actor, user = game.user){
    const size = a => CONFIG.DND5E.actorSizes[a.system.traits?.size]?.numerical ?? 2;
    const others = this.creatures(group).filter(a => a !== actor);
    const choices = [];
    if(this.speed(actor, "walk") > 0) choices.push({ value : "walk", by : "walk" });
    for(const mount of others){
      if((this.travelOf(group, mount).by !== "walk") || (size(mount) <= size(actor)) || !this.travelTypes(mount).size) continue;
      if(!this.canCarry(mount, actor, 1)) continue;
      const taken = this.carriedBy(group, mount, "ride").some(a => a !== actor);
      choices.push({ value : `ride:${mount.id}`, by : "ride", name : mount.name, disabled : taken });
    }
    for(const carrier of others){
      if(["walk", "ride"].includes(this.travelOf(group, carrier).by) && this.canCarry(carrier, actor, 2)) choices.push({ value : `carried:${carrier.id}`, by : "carried", name : carrier.name });
    }
    const crews = this.canCrew(actor);
    for(const vehicle of this.vehicles(group)){
      for(const by of (crews ? ["crew", "passenger"] : ["passenger"])) choices.push({ value : `${by}:${vehicle.id}`, by, name : vehicle.name });
      if(this.canPull(actor)) choices.push({ value : `draft:${vehicle.id}`, by : "draft", name : vehicle.name });
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
    const limit = this.limitOf(group, actor);
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
        <div class="status">${this.statusIcons(group, actor)}${groupWeather.memberControls(group, actor)}</div>
      </div>
      ${this.weightRow(actor)}`;
    card.querySelector(".hours-value")?.addEventListener("change", event => {
      const value = Math.max(0, Number(event.target.value) || 0);
      if(value) actor.setFlag(module.id, "travelHours", value); else actor.unsetFlag(module.id, "travelHours");
    });
    groupWeather.listenMember(group, actor, card);
    card.querySelector(".body-weight")?.addEventListener("change", event => {
      const value = Math.max(0, Number(event.target.value) || 0);
      if(value) actor.setFlag(module.id, "bodyWeight", value); else actor.unsetFlag(module.id, "bodyWeight");
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
    const load = this.loadState(actor);
    if(load) icons.push(`<span class="over" data-tooltip="${game.i18n.localize(`groupTravel.load.${load}`)}"><i class="fa-solid ${(load === "stuck") ? "fa-ban" : "fa-weight-hanging"}" inert></i></span>`);
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
      const taken = (key === "draft") ? list.length : this.seatsTaken(vehicle, key);
      const over = Number.isFinite(max) && (taken > max);
      return `<div class="${over ? "over" : ""}" data-tooltip="${game.i18n.localize(`groupTravel.${key}`)}">
        <i class="fa-solid ${icon}" inert></i> ${taken}${(key === "draft") ? "" : ` / ${max ?? "—"}`} <span class="names">${this.names(list)}</span></div>`;
    };
    const card = document.createElement("div");
    card.className = "macro-helper-road vehicle card";
    card.innerHTML = `${line("crew", "fa-people-group")}${line("passengers", "fa-chair")}${line("draft", "fa-horse")}${this.pullLine(vehicle)}
      <div class="status">${groupWeather.memberControls(group, vehicle)}</div>`;
    groupWeather.listenMember(group, vehicle, card);
    return card;
  }

  /* ---------- Vehicle crews join ---------- */

  /* A vehicle in the group brings in the creatures on its crew, passenger and draft lists (dnd5e's own; the Members
     tab writes them too) as members, on the active GM's client. Those it brought in are noted (flags.macro-helper.joined
     { actor id : vehicle id }) : when the vehicle leaves, the ones still on its lists leave with it. */
  static joinsChanged(actor, changes){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    const flat = Object.keys(foundry.utils.flattenObject(changes ?? {}));
    if((actor.type === "group") && flat.some(k => k.startsWith("system.members"))) return this.join(actor);
    if((actor.type === "vehicle") && flat.some(k => ["system.crew", "system.passengers", "system.draft"].some(key => k.startsWith(key)))){
      for(const group of this.groupsOf(actor)) this.join(group);
    }
  }

  static joinAll(){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    for(const group of game.actors.filter(a => a.type === "group")) this.join(group);
  }

  static #joining = new Set();

  static async join(group){
    if(this.#joining.has(group.id)) return;
    this.#joining.add(group.id);
    try {
      const members = foundry.utils.deepClone(group.system._source.members ?? []);
      const joined = { ...(this.flag(group, "joined") ?? {}) };
      const ids = new Set(members.map(m => m.actor));
      const vehicles = members.map(m => game.actors.get(m.actor)).filter(a => a?.type === "vehicle");
      const listed = vehicle => ["crew", "passengers", "draft"].flatMap(key => vehicle.system[key]?.value ?? []);
      let changed = false;
      /* Left with their vehicle : still on its lists */
      for(const [id, vehicleId] of Object.entries(joined)){
        const actor = game.actors.get(id);
        if(!ids.has(id)){ delete joined[id]; changed = true; continue; }
        if(ids.has(vehicleId)) continue;
        const vehicle = game.actors.get(vehicleId);
        delete joined[id];
        changed = true;
        if(actor && vehicle && listed(vehicle).includes(actor.uuid)){
          members.splice(members.findIndex(m => m.actor === id), 1);
          ids.delete(id);
        }
      }
      /* Brought in : world creatures on a member vehicle's lists */
      for(const vehicle of vehicles) for(const uuid of listed(vehicle)){
        const actor = this.actorOf(uuid);
        if(!actor?.system?.isCreature || actor.pack || actor.isToken || (game.actors.get(actor.id) !== actor) || ids.has(actor.id)) continue;
        members.push({ actor : actor.id });
        ids.add(actor.id);
        joined[actor.id] = vehicle.id;
        changed = true;
      }
      if(!changed) return;
      const { ForcedDeletion, ForcedReplacement } = foundry.data.operators;
      await group.update({ "system.members" : members,
        [`flags.${module.id}.joined`] : foundry.utils.isEmpty(joined) ? new ForcedDeletion() : ForcedReplacement.create(joined) });
    } catch(err) { log.error("Group members joining :", err); }
    finally { this.#joining.delete(group.id); }
  }

  /* ---------- Weights ---------- */

  /* A body weight by size (lb) when neither the GM's typed one nor the character's Weight is known */
  static SIZE_WEIGHTS = { tiny : 8, sm : 40, med : 150, lg : 1000, huge : 4000, grg : 16000 };

  /* dnd5e's Encumbrance setting : off ("none") = weights are shown but never limit anything */
  static weighs(){
    return game.settings.get("dnd5e", "encumbrance") !== "none";
  }

  static weightUnit(){
    return game.settings.get("dnd5e", "metricWeightUnits") ? "kg" : "lb";
  }

  static convert(value, from, to = this.weightUnit()){
    try { return dnd5e.utils.convertWeight(Number(value) || 0, from, to); } catch { return Number(value) || 0; }
  }

  static weightLabel(value){
    return `${Math.round(value * 10) / 10} ${game.i18n.localize(CONFIG.DND5E.weightUnits?.[this.weightUnit()]?.abbreviation ?? this.weightUnit())}`;
  }

  /* { value, estimate } : the GM's typed weight, the character's Weight ("150 lb", "70 kg"), else by size */
  static bodyWeight(actor){
    const typed = Number(actor.getFlag(module.id, "bodyWeight"));
    if(typed > 0) return { value : typed, estimate : false };
    const text = `${actor.system.details?.weight ?? ""}`;
    const number = parseFloat(text.replace(",", "."));
    if(number > 0) return { value : this.convert(number, /kg/i.test(text) ? "kg" : (/lb|pound/i.test(text) ? "lb" : this.weightUnit())), estimate : false };
    return { value : this.convert(this.SIZE_WEIGHTS[actor.system.traits?.size] ?? 150, "lb"), estimate : true };
  }

  /* A creature's whole weight : its body and everything it carries (its gear, the members it carries) */
  static creatureWeight(actor){
    return this.bodyWeight(actor).value + (Number(actor.system.attributes?.encumbrance?.value) || 0);
  }

  static groupsOf(actor){
    return game.actors?.filter(g => (g.type === "group") && g.system.members?.some(m => m.actor === actor)) ?? [];
  }

  /* The members this creature carries or is ridden by, in any of its groups : [{ actor, by, weight }] */
  static carriedLoad(actor){
    const list = [];
    for(const group of this.groupsOf(actor)){
      for(const by of ["ride", "carried"]) for(const other of this.carriedBy(group, actor, by)){
        if(!list.some(l => l.actor === other)) list.push({ actor : other, by, weight : this.creatureWeight(other) });
      }
    }
    return list;
  }

  /* dnd5e's encumbrance, plus the members carried and a fifth of each vehicle share pulled :
     encumbrance.travel = { gear, carried : [{ actor, by, weight }], pull : [{ vehicle, share, counts }] } */
  static addCarried(system){
    const actor = system.parent;
    const encumbrance = system.attributes?.encumbrance;
    if(!this.enabled() || !game.ready || !encumbrance || !actor?.system?.isCreature) return;
    const carried = this.carriedLoad(actor);
    encumbrance.travel = { gear : encumbrance.value, carried, pull : [] };
    encumbrance.value = (encumbrance.value + carried.reduce((n, c) => n + c.weight, 0)).toNearest(0.1);
    for(const vehicle of this.pulling(actor)){
      const share = this.pullOf(vehicle).pullers.find(p => p.actor === actor)?.share ?? 0;
      if(share > 0) encumbrance.travel.pull.push({ vehicle, share, counts : share / this.draftTimes() });
    }
    encumbrance.value = (encumbrance.value + encumbrance.travel.pull.reduce((n, p) => n + p.counts, 0)).toNearest(0.1);
    if(Number.isFinite(encumbrance.max) && encumbrance.max) encumbrance.pct = Math.clamp((encumbrance.value * 100) / encumbrance.max, 0, 100);
  }

  /* The vehicles this creature pulls, in any of its groups */
  static pulling(actor){
    const vehicles = new Set();
    for(const group of this.groupsOf(actor)){
      for(const vehicle of this.vehicles(group)) if(vehicle.system.draft?.value?.includes(actor.uuid)) vehicles.add(vehicle);
    }
    return [...vehicles];
  }

  static draftTimes(){
    return CONFIG.DND5E.encumbrance.draftMultiplier ?? 5;
  }

  /* A creature's load without what it pulls */
  static ownLoad(actor){
    const { value = 0, travel } = actor.system.attributes?.encumbrance ?? {};
    return value - (travel?.pull ?? []).reduce((n, p) => n + p.counts, 0);
  }

  /* ---------- What lands on the group ---------- */

  /* A member with a section of its own on the Inventory tab : a vehicle, or a creature with no class levels (a pack
     animal, a mount, a hireling). Anyone in the group may load it. */
  static isPack(actor){
    return (actor?.type === "vehicle") || (!!actor?.system?.isCreature && !actor.itemTypes.class.length);
  }

  /* Where items and coins that land on the group actor go (it carries nothing itself) : the member picked (the GM or
     the Leader's player), else the primary vehicle, a pack member, the Leader, the first creature */
  static arrivalHolder(group){
    const picked = this.memberActor(group, this.flag(group, "arrivals"));
    return picked ? { actor : picked, auto : false } : { actor : this.autoHolder(group), auto : true };
  }

  static autoHolder(group){
    const order = this.flag(group, "order") ?? [];
    const rank = a => { const i = order.indexOf(a.id); return (i < 0) ? order.length : i; };
    const members = group.system.members.map(m => m.actor).filter(a => a && (a.type !== "group")).sort((a, b) => rank(a) - rank(b));
    return group.system.primaryVehicle ?? members.find(a => this.isPack(a))
      ?? members.find(a => a.system.isCreature && (this.memberOf(group, a).job === "leader")) ?? members.find(a => a.system.isCreature) ?? null;
  }

  /* Can this carrier take that member (on top of what else it carries) within `times` its capacity ? */
  static canCarry(carrier, actor, times){
    if(!this.weighs()) return true;
    const { value = 0, max = Infinity, travel } = carrier.system.attributes?.encumbrance ?? {};
    const already = travel?.carried?.find(c => c.actor === actor)?.weight ?? 0;
    return value - already + this.creatureWeight(actor) <= times * max;
  }

  /* "drag" : over its capacity (Speed 5 ft while dragging); "stuck" : over twice it (can't move); null */
  static loadState(actor){
    if(!this.weighs()) return null;
    const { value = 0, max = Infinity } = actor.system.attributes?.encumbrance ?? {};
    return (value > 2 * max) ? "stuck" : ((value > max) ? "drag" : null);
  }

  /* What each part of its load counts as, one line each; with the limits when asked */
  static loadTip(actor, limits = true){
    const { value = 0, max = 0, travel } = actor.system.attributes?.encumbrance ?? {};
    const line = (key, weight, name = "") => game.i18n.format(`groupTravel.tip.${key}`, { name : foundry.utils.escapeHTML(name), weight : this.weightLabel(Math.round(weight)) });
    const lines = [line("gear", travel?.gear ?? value)];
    for(const c of travel?.carried ?? []) lines.push(line((c.by === "ride") ? "ridden" : "carrying", c.weight, c.actor.name));
    for(const p of travel?.pull ?? []) lines.push(line("pulling", p.counts, p.vehicle.name));
    if(limits && (actor.type !== "vehicle")) lines.push(line("capacity", max), line("drag", 2 * max));
    return lines.join("<br>");
  }

  /* Its load of its capacity; the GM types its body weight */
  static weightRow(actor){
    const { value = 0, max = 0 } = actor.system.attributes?.encumbrance ?? {};
    const body = this.bodyWeight(actor);
    const state = this.loadState(actor);
    const bodyTip = game.i18n.localize(body.estimate ? "groupTravel.bodyEstimate" : "groupTravel.body");
    return `<div class="row weight">
        <div class="hours" data-tooltip="${this.loadTip(actor)}">
          <i class="fa-solid fa-weight-hanging" inert></i>
          <div class="meter progress meter-sm" style="--bar-percentage : ${max ? Math.min(100, value / max * 100) : 0}%"></div>
          <span class="${state ? "over" : ""}">${Math.round(value)} / ${this.weightLabel(max)}</span>
        </div>
        <span class="body" data-tooltip="${bodyTip}"><i class="fa-solid fa-person" inert></i>${game.user.isGM
          ? `<input type="number" class="body-weight" min="0" step="1" value="${body.estimate ? "" : Math.round(body.value)}" placeholder="≈${Math.round(body.value)}">`
          : `${body.estimate ? "≈" : ""}${Math.round(body.value)}`}</span>
      </div>`;
  }

  /* What a vehicle's team pulls : the vehicle, its cargo, everyone aboard (body and gear); what the team can pull :
     each puller 5 times its capacity left (dnd5e's draftMultiplier; its own load first), added up. Each puller's share
     of the weight goes by its capacity left (evenly when none has any) : a fifth of it counts on its load, so the team
     is over exactly when each puller is. max null = no team (a ship). pullers : [{ actor, left, share }] */
  static pullOf(vehicle){
    const unit = this.weightUnit();
    const actors = key => [...new Set(vehicle.system[key]?.value ?? [])].map(uuid => this.actorOf(uuid)).filter(a => a?.system?.isCreature);
    const own = vehicle.system.traits?.weight ?? {};
    const parts = {
      vehicle : this.convert(own.value || 0, own.units ?? unit),
      cargo : Number(vehicle.system.attributes?.encumbrance?.value) || 0,
      aboard : [...new Set([...actors("crew"), ...actors("passengers")])].reduce((n, a) => n + this.creatureWeight(a), 0)
    };
    const weight = parts.vehicle + parts.cargo + parts.aboard;
    const pullers = actors("draft").map(actor => ({ actor, left : Math.max(0, this.round((Number(actor.system.attributes?.encumbrance?.max) || 0) - this.ownLoad(actor))) }));
    const left = pullers.reduce((n, p) => n + p.left, 0);
    for(const p of pullers) p.share = left ? weight * p.left / left : weight / pullers.length;
    const max = pullers.length ? left * this.draftTimes() : null;
    return { weight, max, parts, pullers };
  }

  static pullLine(vehicle){
    const pull = this.pullOf(vehicle);
    if(pull.max === null) return "";
    const over = this.weighs() && (pull.weight > pull.max);
    const tip = ["vehicle", "cargo", "aboard"].map(k => game.i18n.format(`groupTravel.pull.${k}`, { weight : this.weightLabel(pull.parts[k]) })).join("<br>");
    return `<div class="${over ? "over" : ""}" data-tooltip="${tip}"><i class="fa-solid fa-weight-hanging" inert></i>
      ${game.i18n.format("groupTravel.pull.line", { weight : Math.round(pull.weight), max : this.weightLabel(pull.max) })}</div>`;
  }

  /* Re-prepare the members of this creature's groups (or all groups) so carriers see what they carry now; the GM's
     client then lets dnd5e set its encumbrance statuses. Members carried by members carried... : a few passes. */
  static refreshLoads(actor = null){
    if(!this.enabled() || !game.ready) return;
    const groups = actor ? ((actor.type === "group") ? [actor] : this.groupsOf(actor)) : game.actors.filter(g => g.type === "group");
    const members = new Set(groups.flatMap(g => g.system.members.map(m => m.actor).filter(a => a?.system?.isCreature || (a?.type === "vehicle"))));
    if(!members.size) return;
    for(let pass = 0; pass < 3; pass++) for(const member of members) member.reset();
    if(game.users.activeGM?.isSelf && this.weighs()) for(const member of members) member.updateEncumbrance?.({});
    for(const app of this.sheets()) if(groups.includes(app.document)) app.render();
    for(const member of members) if(member.sheet?.rendered) member.sheet.render();
  }

  static settingChanged(){
    for(const group of game.actors.filter(a => a.type === "group")) for(const { actor } of group.system.members) actor?.reset();
    if(game.users.activeGM?.isSelf && this.weighs()) for(const group of game.actors.filter(a => a.type === "group")){
      for(const { actor } of group.system.members) actor?.updateEncumbrance?.({});
    }
    for(const app of this.sheets()) app.render();
    this.joinAll();
  }

  /* Gear that weighs on someone else : a member carried, riding, aboard a vehicle or pulling one (the team's shares),
     a vehicle's cargo (its team); only weight changes */
  static gearChanged(item, changes){
    const actor = item.parent;
    if(!this.enabled() || !(actor instanceof Actor)) return;
    if(changes){
      const flat = Object.keys(foundry.utils.flattenObject(changes));
      if(!flat.some(k => ["system.quantity", "system.weight", "system.container"].some(key => k.startsWith(key)))) return;
    }
    if(actor.type === "vehicle") return this.groupsOf(actor).length && this.refreshLoads(actor);
    if(!actor.system?.isCreature) return;
    const counts = this.groupsOf(actor).some(g => ["ride", "carried", "crew", "passenger", "draft"].includes(this.travelOf(g, actor).by));
    if(counts) this.refreshLoads(actor);
  }

  /* What a carrier's load depends on : the group's ways of travel, vehicle seats, a member's weight, size, Strength */
  static loadsChanged(actor, changes){
    if(!this.enabled()) return;
    const flat = Object.keys(foundry.utils.flattenObject(changes ?? {}));
    const keys = (actor.type === "group") ? [`flags.${module.id}.members`, `flags.${module.id}.order`, "system.members", "system.primaryVehicle"]
      : (actor.type === "vehicle") ? ["system.crew", "system.passengers", "system.draft", "system.traits.weight", "system.currency"]
      : [`flags.${module.id}.bodyWeight`, `flags.${module.id}.-=bodyWeight`, "system.details.weight", "system.traits.size", "system.abilities.str", "system.currency"];
    if(flat.some(k => keys.some(key => k.startsWith(key)))) this.refreshLoads(actor.type === "vehicle" ? null : actor);
  }

  /* ---------- Travel ---------- */

  static TRAVEL_UNITS = { mph : "mi", kph : "km" };
  static MAP_UNITS = { mi : "mi", mile : "mi", miles : "mi", km : "km", kilometer : "km", kilometers : "km", kilometre : "km", kilometres : "km" };
  static COLORS = { forced : 0xcc3030, gallop : 0xe0b020 };
  static #preview = null;

  /* Travel : the GM, or the owner of the member whose job is Leader */
  static canTravel(group, user = game.user){
    return this.canOrder(group, user);
  }

  /* The travel map : the active scene with its grid in miles or kilometres ("mi", "miles", "km"...); null elsewhere */
  static mapUnit(scene){
    return scene?.active ? this.milesOf(scene) : null;
  }

  /* A scene whose grid is in miles or kilometres, active or not */
  static milesOf(scene){
    return this.MAP_UNITS[`${scene?.grid?.units ?? ""}`.trim().toLowerCase().replace(/\.$/, "")] ?? null;
  }

  /* The Group's token on the travel map */
  static travelToken(token){
    const doc = token?.document ?? token;
    return (this.enabled() && (doc?.actor?.type === "group") && this.mapUnit(doc.parent)) ? doc : null;
  }

  /* The group's length unit (its Travel Pace's mph -> mi, kph -> km) */
  static groupUnit(group){
    return this.TRAVEL_UNITS[group.system.attributes.travel.units ?? dnd5e.utils.defaultUnits("travel")] ?? "mi";
  }

  static unitLabel(group){
    return game.i18n.localize(CONFIG.DND5E.movementUnits[this.groupUnit(group)]?.abbreviation ?? "mi");
  }

  static mapDistance(token, distance){
    return dnd5e.utils.convertLength(distance, this.mapUnit(token.parent), this.groupUnit(token.actor), { strict : false });
  }

  /* A move made only of teleports / displacements (the GM placing it, an Undo) isn't travel */
  static teleport(movement){
    const points = movement.passed?.waypoints?.length ? movement.passed.waypoints : [movement.destination];
    return points.every(p => p && ((p.action === "displace") || CONFIG.Token.movement?.actions?.[p.action]?.teleport));
  }

  /* Land / Water / Air : the chip picked, else the primary vehicle's type */
  static mode(group){
    return this.flag(group, "travelMode") ?? group.system.primaryVehicle?.system?.details?.type ?? "land";
  }

  /* The group's speed for an hour at that pace : the PHB table (Normal 3, Fast 4, Slow 2 mph); a ship, an airship or
     typed paces : dnd5e's day pace over that day's hours. 0 = no pace for the travel mode. */
  static hourly(group, pace){
    const system = group.system;
    const mode = this.mode(group);
    const raw = !this.overridden(system) && this.rawPace(system, pace);
    if(raw) return { rate : (raw.paces[mode] == null) ? 0 : raw.rate, pace : raw.pace.value };
    const travel = system.getTravelPace();
    const hours = Number(system.primaryVehicle?.system?.attributes?.travel?.time ?? system.attributes.travel.time) || 8;
    return { rate : (Number(travel.paces?.[mode]) || 0) / hours, pace : travel.pace.value };
  }

  /* Whose travel hours a leg adds to : members walking, riding, crewing or pulling (not passengers or the carried) */
  static counted(group){
    return this.creatures(group).filter(a => !["passenger", "carried"].includes(this.travelOf(group, a).by));
  }

  /* A member's day of travel hours : the group's, for everyone (crews and draft animals too) */
  static limitOf(group){
    return Number(group.system.attributes?.travel?.time) || 8;
  }

  /* Seats a member takes : 1 each (RAW), or by size with the homebrew switch (Tiny 1/2, Small and Medium 1, Large 4,
     Huge 9, Gargantuan 16) */
  static SEAT_SIZES = { tiny : 0.5, sm : 1, med : 1, lg : 4, huge : 9, grg : 16 };

  static seatsOf(actor){
    return settings.value("homebrewSeats") ? (this.SEAT_SIZES[actor?.system?.traits?.size] ?? 1) : 1;
  }

  /* The crew or passenger seats taken on a vehicle */
  static seatsTaken(vehicle, key){
    return (vehicle.system[key]?.value ?? []).reduce((n, uuid) => n + this.seatsOf(this.actorOf(uuid)), 0);
  }

  /* Items or coins on the group actor itself */
  static uncarried(group){
    return group.items.some(i => !i.system.container) || Object.values(group.system.currency ?? {}).some(n => Number(n) > 0);
  }

  /* What stops the group travelling (Rule Limits) : seats over their number, a vehicle its team can't pull, a member
     over twice its carrying capacity (weights only with dnd5e's Encumbrance setting on), things nobody carries */
  static travelProblems(group){
    const problems = [];
    for(const vehicle of this.vehicles(group)){
      for(const key of ["crew", "passengers"]){
        const part = vehicle.system[key] ?? {};
        const taken = this.seatsTaken(vehicle, key);
        if(Number.isFinite(part.max) && (taken > part.max)) problems.push(game.i18n.format("groupTravel.problem.seats",
          { vehicle : vehicle.name, seats : game.i18n.localize(`groupTravel.${key}`), taken, max : part.max }));
      }
      const pull = this.weighs() && this.pullOf(vehicle);
      if(pull && (pull.max !== null) && (pull.weight > pull.max)) problems.push(game.i18n.format("groupTravel.problem.pull",
        { vehicle : vehicle.name, weight : this.weightLabel(pull.weight), max : this.weightLabel(pull.max) }));
    }
    for(const actor of this.creatures(group)){
      if(this.loadState(actor) === "stuck") problems.push(game.i18n.format("groupTravel.problem.stuck", { name : actor.name }));
    }
    /* Items or coins still on the group actor (no member to hand them to) : nobody carries them */
    if(this.uncarried(group)) problems.push(game.i18n.format("groupTravel.problem.uncarried", { group : group.name }));
    return problems;
  }

  /* Each problem through Rule Limits : false = stopped (Block) */
  static mayTravel(group){
    return this.travelProblems(group).every(rule => limits.allow(rule, { who : group.name, what : game.i18n.localize("groupTravel.travel") }));
  }

  /* Gallop (PHB Mounts) : every creature on its own feet is a ridden mount, none galloped since its last rest */
  static gallopers(group){
    if(group.system.primaryVehicle) return [];
    const walkers = this.walkers(group.system);
    return (walkers.length && walkers.every(a => this.carriedBy(group, a, "ride").length)) ? walkers : [];
  }

  static canGallop(group){
    const mounts = this.gallopers(group);
    return !!mounts.length && mounts.every(a => !a.getFlag(module.id, "galloped"));
  }

  static gallopButton(group){
    const can = this.canGallop(group);
    const on = can && this.flag(group, "gallop");
    const tip = game.i18n.localize(can ? "groupTravel.gallop" : "groupTravel.gallopNo");
    return `<button type="button" class="gallop unbutton ${on ? "active" : ""}" data-tooltip="${tip}" ${(can && this.canTravel(group)) ? "" : "disabled"}>
      <i class="fa-solid fa-horse" inert></i></button>`;
  }

  static async gallopAsGM({ group }, user){
    group = await fromUuid(group);
    if((group?.type !== "group") || !this.canTravel(group, user) || !this.canGallop(group)) return false;
    await group.setFlag(module.id, "gallop", !this.flag(group, "gallop"));
    return true;
  }

  /* What a leg depends on besides its length : { rate, pace, gallop, used and limit (the member nearest its own day's
     hours), counted, members }; null = no pace for the travel mode */
  static legBase(group, { pace = group.system.attributes.travel.pace, gallop = false } = {}){
    const { rate, pace : used } = this.hourly(group, pace);
    if(!(rate > 0)) return null;
    const counted = this.counted(group);
    /* The member closest to (or furthest past) its own day's hours sets the leg's forced march */
    const members = counted.map(actor => ({ actor, used : Number(actor.getFlag(module.id, "travelHours")) || 0, limit : this.limitOf(group, actor) }));
    const worst = members.reduce((a, b) => (!a || ((b.used - b.limit) > (a.used - a.limit))) ? b : a, null);
    return {
      rate, pace : used, gallop : !!gallop && this.canGallop(group), counted, members,
      used : worst?.used ?? 0, limit : worst?.limit ?? (Number(group.system.attributes.travel.time) || 8)
    };
  }

  /* A leg of a distance or of hours : galloping, the first hour covers twice the distance. Time is exact (1.1 h = 66 min);
     over = its hours past the day's travel hours (forced march) */
  static legFrom(base, { distance = null, hours = null }){
    const fast = 2 * base.rate;
    if(hours === null){
      const galloped = base.gallop ? Math.min(distance, fast) : 0;
      hours = galloped / fast + (distance - galloped) / base.rate;
    }
    else distance = base.gallop ? (Math.min(hours, 1) * fast + Math.max(0, hours - 1) * base.rate) : hours * base.rate;
    const over = Math.max(0, base.used + hours - base.limit) - Math.max(0, base.used - base.limit);
    return { ...base, distance, hours, seconds : Math.round(hours * this.secondsPerHour()), over };
  }

  static leg(group, { distance = null, hours = null, pace, gallop } = {}){
    const base = this.legBase(group, { pace, gallop });
    return base && this.legFrom(base, { distance, hours });
  }

  static secondsPerHour(){
    const days = game.time.calendar?.days;
    return (days?.secondsPerMinute ?? 60) * (days?.minutesPerHour ?? 60);
  }

  /* "2 h 12 min" */
  static hm(hours){
    const minutes = Math.round(hours * 60);
    const h = Math.floor(minutes / 60), m = minutes % 60;
    if(!h) return game.i18n.format("groupTravel.m", { m });
    return m ? game.i18n.format("groupTravel.hm", { h, m }) : game.i18n.format("groupTravel.h", { h });
  }

  static round(value){
    return Math.round(value * 10) / 10;
  }

  /* Only the GM or the Leader's player moves the Group's token on the travel map, and only with a pace for its mode */
  static preMove(token, movement){
    if(!this.enabled() || (token?.actor?.type !== "group") || this.teleport(movement)) return;
    const group = token.actor;
    /* A map in miles that isn't the active scene : no time passes; Rule Limits says whether it's told / stopped */
    if(!this.mapUnit(token.parent)){
      if(!this.milesOf(token.parent)) return;
      return limits.allow(game.i18n.format("groupTravel.inactive", { scene : token.parent.name }),
        { who : group.name, what : game.i18n.localize("groupTravel.travel") }) ? undefined : false;
    }
    if(!this.canTravel(group)){
      ui.notifications.warn(game.i18n.format("groupTravel.notLeader", { name : group.name }));
      return false;
    }
    if(!(this.hourly(group, group.system.attributes.travel.pace).rate > 0)){
      ui.notifications.warn(this.noPaceText(group));
      return false;
    }
    if(!this.mayTravel(group)) return false;
  }

  /* The client that moved it : the GM's client passes the time */
  static onMove(token, movement, operation, user){
    if(((user?.id ?? user) !== game.user.id) || !this.travelToken(token) || this.teleport(movement)) return;
    const distance = this.mapDistance(token, movement.passed?.distance ?? 0);
    if(!(distance > 0)) return;
    const { x, y, elevation = 0 } = movement.origin;
    gm.run("groupLeg", { group : token.actor.uuid, token : token.uuid, distance, from : { x, y, elevation } });
  }

  /* A leg, on the GM's client : the counted members' hours, galloping mounts, world time, the log card */
  static async legAsGM({ group, token = null, from = null, distance = null, hours = null, pace, gallop }, user){
    group = await fromUuid(group);
    if((group?.type !== "group") || !this.canTravel(group, user)) return false;
    if(pace && !(pace in CONFIG.DND5E.travelPace)) return false;
    const number = v => (Number.isFinite(v) && (v > 0)) ? v : null;
    const armed = !!this.flag(group, "gallop");
    const leg = this.leg(group, { distance : number(distance), hours : number(hours), pace, gallop : gallop ?? armed });
    if(!leg || !(leg.seconds > 0)) return false;
    /* [uuid, hours before, day's hours] : a uuid's dots would split as a flag key */
    const before = [];
    for(const { actor, used : was, limit } of leg.members){
      before.push([actor.uuid, was, limit]);
      await actor.setFlag(module.id, "travelHours", Math.round((was + leg.hours) * 100) / 100);
    }
    const mounts = leg.gallop ? this.gallopers(group) : [];
    for(const mount of mounts) await mount.setFlag(module.id, "galloped", true);
    if(leg.gallop && armed) await group.unsetFlag(module.id, "gallop");
    const start = game.time.worldTime;
    await game.time.advance(leg.seconds);
    const log = await this.postLog(group, { kind : "leg", start, seconds : leg.seconds, token, from, hours : before, mounts : mounts.map(m => m.uuid), armed : leg.gallop && armed,
      distance : leg.distance, pace : leg.pace, time : leg.hours, day : leg.used + leg.hours, limit : leg.limit, over : leg.over, gallop : leg.gallop });
    const heat = new Map();
    const checks = [await this.stealthCheck(group, leg), ...await this.marchChecks(group, before, leg),
      ...await groupWeather.hourly(group, { start, seconds : leg.seconds, context : "travel", heat })].filter(c => c);
    if(checks.length || heat.size) await log.update({ [`flags.${module.id}.groupLog.checks`] : checks.map(m => m.id), [`flags.${module.id}.groupLog.heat`] : [...heat] });
    return true;
  }

  /* The hours past its own day's travel hours each counted member finished on this leg :
     { "past:hour" : { actors, past (hours past), hour (of the day's travel) } } */
  static marchHours(before, leg){
    const hours = {};
    for(const [uuid, was, limit = leg.limit] of before){
      const actor = fromUuidSync(uuid, { strict : false });
      const now = was + leg.hours;
      for(let end = Math.floor(was + 1e-6) + 1; end <= Math.floor(now + 1e-6); end++){
        if(end > limit) (hours[`${end - limit}:${end}`] ??= { actors : [], past : end - limit, hour : end }).actors.push(actor);
      }
    }
    return hours;
  }

  /* Stealth on : a group DEX (Stealth) check for the leg, by every creature member not carried by another, rolled at
     once and whispered to the GM; no DC (it meets the watchers' passive Perception). 2024 PHB Travel Pace : Normal and
     Fast give Disadvantage */
  static async stealthCheck(group, leg){
    if(!this.flag(group, "stealth")) return null;
    const who = this.creatures(group).filter(a => this.travelOf(group, a).by !== "carried");
    if(!who.length) return null;
    const pace = game.i18n.localize(CONFIG.DND5E.travelPace[leg.pace]?.label ?? leg.pace);
    const rollMode = (leg.pace !== "slow") ? { mode : "disadvantage", reason : game.i18n.format("groupTravel.stealthPace", { pace }) } : null;
    const card = await rollRequests.request({ who : who.map(a => ({ actor : a.uuid, name : a.name, img : a.img, ...(rollMode ? { rollMode } : {}) })),
      what : "skill:ste", mode : "group", whisper : "gm", hideDC : false, speaker : group,
      label : game.i18n.format("groupTravel.stealthCheck", { skill : rollRequests.labelOf("skill", "ste"), pace }) });
    await rollRequests.rollAll(card).catch(error => log.error("Stealth check", error));
    return card;
  }

  /* Forced march : a Constitution save card for each hour past, DC 10 + that hour */
  static async marchChecks(group, before, leg){
    const cards = [];
    for(const { actors, past, hour } of Object.values(this.marchHours(before, leg)).sort((a, b) => (a.past - b.past) || (a.hour - b.hour))){
      const who = actors.filter(a => a).map(a => ({ actor : a.uuid, name : a.name, img : a.img }));
      if(!who.length) continue;
      cards.push(await rollRequests.request({ who, what : "save:con", dc : 10 + Number(past), hideDC : false, speaker : group, onFail : "exhaustion",
        label : game.i18n.format("groupTravel.march", { save : rollRequests.labelOf("save", "con"), hour }) }));
    }
    return cards;
  }

  static async passAsGM({ group, seconds, reason = "" }, user){
    group = await fromUuid(group);
    seconds = Math.round(Number(seconds));
    if(!user.isGM || (group?.type !== "group") || !(seconds > 0)) return false;
    const start = game.time.worldTime;
    await game.time.advance(seconds);
    const log = await this.postLog(group, { kind : "pass", start, seconds, reason : `${reason ?? ""}`.slice(0, 200) });
    /* Extreme cold or heat : the hours' saves */
    const heat = new Map();
    const checks = await groupWeather.hourly(group, { start, seconds, context : "pass", heat });
    if(checks.length || heat.size) await log.update({ [`flags.${module.id}.groupLog.checks`] : checks.map(m => m.id), [`flags.${module.id}.groupLog.heat`] : [...heat] });
    return true;
  }

  /* The log card everyone sees; the GM's Undo puts back the token, the time, the hours and the gallop */
  static postLog(group, data){
    const when = time => { const { date, time : clock } = this.formatted(time); return `${date} ${clock}`; };
    const lines = [];
    if(data.kind === "leg"){
      lines.push(game.i18n.format("groupTravel.log.leg", { distance : this.round(data.distance), unit : this.unitLabel(group),
        pace : game.i18n.localize(CONFIG.DND5E.travelPace[data.pace]?.label ?? data.pace), time : this.hm(data.time) }));
      if(data.gallop) lines.push(game.i18n.localize("groupTravel.log.gallop"));
      lines.push(game.i18n.format("groupTravel.log.day", { day : this.hm(data.day), limit : data.limit }));
      if(data.over > 0) lines.push(`<span class="over">${game.i18n.format("groupTravel.log.over", { time : this.hm(data.over), limit : data.limit })}</span>`);
    }
    else lines.push(game.i18n.format("groupTravel.log.pass", { time : this.hm(data.seconds / this.secondsPerHour()) })
      + (data.reason ? ` : ${foundry.utils.escapeHTML(data.reason)}` : ""));
    const content = `<div class="macro-helper-group-log">
      ${lines.map(l => `<p>${l}</p>`).join("")}
      <p class="when"><i class="fa-solid fa-clock" inert></i> ${when(data.start)} → ${when(data.start + data.seconds)}</p></div>`;
    return ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor : group }), content,
      flags : { [module.id] : { groupLog : { ...data, group : group.uuid } } }
    });
  }

  static drawLog(message, html){
    const data = message.getFlag(module.id, "groupLog");
    const card = data && html.querySelector(".macro-helper-group-log");
    if(!card) return;
    if(data.undone) return card.classList.add("undone");
    if(!game.user.isGM) return;
    const row = buttonRow(html, { key : "macro-helper-group-undo" });
    addButton(row, makeButton({ icon : "fa-rotate-left", text : game.i18n.localize("groupTravel.undo"), once : true,
      onClick : () => this.undoAsGM({ message : message.id }, game.user) }));
  }

  static async undoAsGM({ message }, user){
    message = game.messages.get(message);
    const data = message?.getFlag(module.id, "groupLog");
    if(!user.isGM || !data || data.undone) return false;
    await message.setFlag(module.id, "groupLog.undone", true);
    for(const id of data.checks ?? []) await game.messages.get(id)?.delete();
    await groupWeather.restoreHeat(data.heat);
    for(const [uuid, hours] of data.hours ?? []){
      const actor = await fromUuid(uuid);
      if(!actor) continue;
      if(hours) await actor.setFlag(module.id, "travelHours", hours); else await actor.unsetFlag(module.id, "travelHours");
    }
    for(const uuid of data.mounts ?? []) await (await fromUuid(uuid))?.unsetFlag(module.id, "galloped");
    if(data.armed) await (await fromUuid(data.group))?.setFlag(module.id, "gallop", true);
    await game.time.advance(-data.seconds);
    const token = data.token && data.from && await fromUuid(data.token);
    if(token) await token.move({ ...data.from, action : "displace" });
    return true;
  }

  /* ---------- Travel windows ---------- */

  static paceOptions(now){
    return Object.entries(CONFIG.DND5E.travelPace).map(([key, { label }]) =>
      `<option value="${key}" ${(key === now) ? "selected" : ""}>${game.i18n.localize(label)}</option>`).join("");
  }

  /* Off the map (skipped days, a gridless scene) : miles or hours, a pace, Gallop; the token stays put */
  static async travelWindow(group){
    if(!this.canTravel(group)) return;
    const canGallop = this.canGallop(group);
    const content = `<div class="macro-helper-travel-window">
      <div class="form-group"><label>${game.i18n.localize("groupTravel.distance")} (${this.unitLabel(group)})</label>
        <input type="number" name="distance" min="0" step="0.1" autofocus></div>
      <div class="form-group"><label>${game.i18n.localize("groupTravel.hours")}</label>
        <input type="number" name="hours" min="0" step="0.1"></div>
      <div class="form-group"><label>${game.i18n.localize("DND5E.TRAVEL.Pace.Label")}</label>
        <select name="pace">${this.paceOptions(group.system.attributes.travel.pace)}</select></div>
      <div class="form-group"><label>${game.i18n.localize("groupTravel.gallopLabel")}</label>
        <input type="checkbox" name="gallop" ${canGallop ? "" : "disabled"} ${(canGallop && this.flag(group, "gallop")) ? "checked" : ""}
          data-tooltip="${game.i18n.localize(canGallop ? "groupTravel.gallop" : "groupTravel.gallopNo")}"></div>
      <p class="preview hint"></p></div>`;
    const read = form => ({
      distance : Number(form.elements.distance.value) || null, hours : Number(form.elements.hours.value) || null,
      pace : form.elements.pace.value, gallop : form.elements.gallop.checked
    });
    const result = await foundry.applications.api.DialogV2.wait({
      window : { title : `${group.name} : ${game.i18n.localize("groupTravel.travel")}`, icon : "fa-solid fa-route" },
      content,
      render : (event, dialog) => {
        const form = dialog.element.querySelector("form");
        const preview = () => form.querySelector(".preview").innerHTML = this.legPreview(group, read(form));
        /* Miles or hours : typing one clears the other */
        for(const [name, other] of [["distance", "hours"], ["hours", "distance"]]){
          form.elements[name].addEventListener("input", () => { if(form.elements[name].value) form.elements[other].value = ""; preview(); });
        }
        for(const name of ["pace", "gallop"]) form.elements[name].addEventListener("change", preview);
        preview();
      },
      buttons : [
        { action : "travel", label : game.i18n.localize("groupTravel.travel"), icon : "fa-solid fa-route", default : true, callback : (event, button) => read(button.form) },
        { action : "cancel", label : game.i18n.localize("Cancel"), icon : "fa-solid fa-xmark" }
      ],
      rejectClose : false
    });
    if(!result || (typeof result !== "object") || !(result.distance || result.hours) || !this.mayTravel(group)) return;
    await gm.run("groupLeg", { group : group.uuid, ...result });
  }

  static legPreview(group, { distance, hours, pace, gallop }){
    if(!distance && !hours) return game.i18n.localize("groupTravel.previewEmpty");
    const leg = this.leg(group, { distance, hours, pace, gallop });
    if(!leg) return this.noPaceText(group);
    const { time } = this.formatted(game.time.worldTime + leg.seconds);
    let text = game.i18n.format("groupTravel.preview", { distance : this.round(leg.distance), unit : this.unitLabel(group), time : this.hm(leg.hours), at : time,
      pace : game.i18n.localize(CONFIG.DND5E.travelPace[leg.pace]?.label ?? leg.pace) });
    if(leg.over > 0) text += `<br><span class="over">${game.i18n.format("groupTravel.log.over", { time : this.hm(leg.over), limit : leg.limit })}</span>`;
    return text;
  }

  /* Seconds from now until that hour of the day (today's or tomorrow's) */
  static secondsUntil(hour){
    const { secondsPerMinute : s = 60, minutesPerHour : m = 60, hoursPerDay : h = 24 } = game.time.calendar?.days ?? {};
    const c = game.time.components;
    const now = ((c.hour * m) + c.minute) * s + c.second;
    const day = h * m * s;
    return (((hour * m * s) - now) % day + day) % day || day;
  }

  /* Time passing that isn't travel or a rest : hours and minutes, quick buttons, a reason for the log */
  static async passWindow(group){
    if(!game.user.isGM) return;
    const quick = [["add", 600, "groupTravel.plus10"], ["add", 3600, "groupTravel.plus1h"], ["until", 6, "groupTravel.untilDawn"], ["until", 0, "groupTravel.untilMidnight"]];
    const content = `<div class="macro-helper-pass-window">
      <div class="form-group"><label>${game.i18n.localize("groupTravel.hours")}</label><input type="number" name="hours" min="0" step="1" value="0"></div>
      <div class="form-group"><label>${game.i18n.localize("groupTravel.minutes")}</label><input type="number" name="minutes" min="0" step="1" value="0"></div>
      <div class="quick">${quick.map(([how, value, label]) => `<button type="button" data-${how}="${value}">${game.i18n.localize(label)}</button>`).join("")}</div>
      <div class="form-group"><label>${game.i18n.localize("groupTravel.reason")}</label><input type="text" name="reason"></div>
      <p class="preview hint"></p></div>`;
    /* "Until" keeps its exact seconds (the clock's own seconds too); typing or adding goes back to whole minutes */
    let exact = null;
    const typed = form => ((Number(form.elements.hours.value) || 0) * 60 + (Number(form.elements.minutes.value) || 0)) * 60;
    const seconds = form => exact ?? typed(form);
    const result = await foundry.applications.api.DialogV2.wait({
      window : { title : `${group.name} : ${game.i18n.localize("groupTravel.passTime")}`, icon : "fa-solid fa-hourglass-half" },
      content,
      render : (event, dialog) => {
        const form = dialog.element.querySelector("form");
        const preview = () => {
          const { date, time } = this.formatted(game.time.worldTime + seconds(form));
          form.querySelector(".preview").textContent = game.i18n.format("groupTravel.passPreview", { at : `${date} ${time}` });
        };
        const set = (total, until = false) => {
          exact = until ? total : null;
          const minutes = Math.round(total / 60);
          form.elements.hours.value = Math.floor(minutes / 60);
          form.elements.minutes.value = minutes % 60;
          preview();
        };
        for(const button of form.querySelectorAll(".quick button")) button.addEventListener("click", () =>
          ("add" in button.dataset) ? set(typed(form) + Number(button.dataset.add)) : set(this.secondsUntil(Number(button.dataset.until)), true));
        for(const name of ["hours", "minutes"]) form.elements[name].addEventListener("input", () => { exact = null; preview(); });
        preview();
      },
      buttons : [
        { action : "pass", label : game.i18n.localize("groupTravel.passTime"), icon : "fa-solid fa-hourglass-half", default : true,
          callback : (event, button) => ({ seconds : seconds(button.form), reason : button.form.elements.reason.value.trim() }) },
        { action : "cancel", label : game.i18n.localize("Cancel"), icon : "fa-solid fa-xmark" }
      ],
      rejectClose : false
    });
    if(!result || (typeof result !== "object") || !(result.seconds > 0)) return;
    await gm.run("groupPass", { group : group.uuid, ...result });
  }

  /* ---------- Travel ruler ---------- */

  /* The leg's parts besides its length, for a quarter second (the ruler asks for every grid space) */
  static previewBase(group){
    const now = Date.now();
    if((this.#preview?.uuid === group.uuid) && (now - this.#preview.at < 250)) return this.#preview.base;
    const base = this.legBase(group, { gallop : this.flag(group, "gallop") });
    this.#preview = { uuid : group.uuid, at : now, base };
    return base;
  }

  static previewLeg(token, waypoint){
    const doc = this.travelToken(token);
    if(!doc || !waypoint?.measurement) return null;
    const base = this.previewBase(doc.actor);
    return base && this.legFrom(base, { distance : this.mapDistance(doc, waypoint.measurement.distance) });
  }

  /* The ruler's label : the leg's time and the arrival time, any forced march */
  static rulerLabel(token, waypoint, context){
    if(!context) return;
    const leg = this.previewLeg(token, waypoint);
    if(!leg) return;
    let text = ` · ${this.hm(leg.hours)} → ${this.formatted(game.time.worldTime + leg.seconds).time}`;
    if(leg.over > 0) text += ` · ${game.i18n.format("groupTravel.forced", { time : this.hm(leg.over) })}`;
    if(context.cost) context.cost.units += text;
    else context.units += text;
  }

  /* Grid spaces past the day's travel hours red, the galloped hour's yellow */
  static rulerStyle(token, waypoint, style){
    const leg = this.previewLeg(token, waypoint);
    if(!leg || !((style.alpha ?? 0.5) > 0)) return style;
    if(leg.over > 0) return { ...style, color : this.COLORS.forced };
    if(leg.gallop && (leg.hours <= 1)) return { ...style, color : this.COLORS.gallop };
    return style;
  }

  /* ---------- Clock ---------- */

  /* The Calendar HUD's own date and time formats (each user's choice), now or at that world time */
  static formatted(at = game.time.worldTime){
    const calendar = game.time.calendar;
    const formatters = CONFIG.DND5E?.calendar?.formatters ?? [];
    const prefs = game.settings.get("dnd5e", "calendarPreferences")?.formatters ?? {};
    const as = (value, fallback) => {
      const formatter = formatters.find(f => f.value === value)?.formatter ?? fallback;
      try { return calendar.format(at, formatter); } catch { return ""; }
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
}
