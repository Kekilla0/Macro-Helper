import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { idOf, buttonRow, addButton, makeButton } from '../helpers/utils.js';
import { rollRequests } from '../requests/requests.js';
import { attackOf } from '../roll-item/damage.js';
import { giveMode } from '../roll-item/reasons.js';
import { rollModes } from './roll-modes.js';
import { heldLight } from './held-light.js';
import { groupTravel } from './group-travel.js';
import { groupFood } from './group-food.js';
import { gm } from '../gm.js';
const log = logger.for(import.meta.url);

/**
 * Group Travel : Weather (the Journey card's Temperature, Wind and Precipitation, set by the GM; Roll : the 2024 DMG
 * Weather table, whispered to the GM, its wind and precipitation set). Setting weatherRules : 2024 (DMG Environmental
 * Effects) or 2014.
 *   Extreme Cold : at the end of each hour (the clock passing an hour : a leg, Pass Time, a camp's hour) every exposed
 *     creature member makes a DC 10 Constitution save or gains 1 Exhaustion (one card an hour, Roll all). Cold
 *     Resistance or Immunity passes. 2024 PHB : a Small or Medium sleeper in its own Bedroll (asleep or in Trance at
 *     camp) passes; a Blanket gives Advantage (wrapped in it, walking too). 2014 : cold weather clothing worn, or a member the GM marked adapted to cold, passes.
 *   Extreme Heat : the same, only for those without drinkable water on hand (water in their own waterskin, water near
 *     the camp, an inn); DC 5 the first hour, +1 each hour after in a row (flag heatHours). Medium or Heavy armor
 *     (2014 : or heavy clothing) : Disadvantage. Fire Resistance or Immunity passes (2014 : or adapted to heat).
 *     Desert Clothing (no Medium or Heavy armor) / Warm Fungal Clothing pass Heat / Cold whatever the rules.
 *   Exposed : not sheltered. Sheltered : the GM's tick on the member (Members tab), a passenger of a covered vehicle,
 *     at camp : an inn, the camp's natural shelter (a cave...), and once the camp is set up a place in a tent (2024 PHB :
 *     two Small or Medium creatures each) or in a shelter a member built (the Make Shelter task :
 *     a Survival check; each success two places).
 *   Heavy rain or snow, strong wind (a sandstorm) : an effect on each creature member (Weather : ...) : Disadvantage on
 *     Perception (heavy precipitation, a sandstorm; 2014 : strong wind too), on ranged weapon attacks (strong wind).
 *     Heavy rain and strong wind put out open flames held (torches, candles, lamps; lanterns stay lit) and keep them
 *     from being lit.
 *   Weather changes (homebrew homebrewWeatherChanges) : each day 1d12 and 2d12 hours from midnight (flag weatherDay
 *     { at : that midnight, hours }); the clock passing one re-rolls the weather (the Roll, over the GM's own too). A jump
 *     passing several rolls once, at the last. Every Roll card keeps the weather before (flag weatherRoll) : the GM's
 *     Undo, or the clock put back before a change's hour, puts it back.
 *   Weather by season (homebrew homebrewWeatherSeasons) : the Roll's three d20 bands come from the season the calendar
 *     gives that hour (setting weatherSeasons { [season name] : { temperature, wind, precipitation : [none, light, strong] } },
 *     d20 counts adding to 20; the GM's table from the Journey card). A season not in it : its default by name, else RAW.
 *     The temperature in °F : the group's climate (flag climate, the GM's) gives each season a range of average days
 *     (setting weatherClimates { [climate] : { night, [season name] : [low, high] } }); each midnight the day's base
 *     (flag weatherDay.base) carries on from the day before (2d6 - 7, plus a quarter of the way back to the range's
 *     middle; the first : random in the range). A colder / hotter roll shifts it 2d4 °F until the next roll (weather.shift);
 *     night (18:00 to 6:00) takes the climate's night degrees off. 0 °F or lower : Extreme Cold, 100 °F or higher : Extreme
 *     Heat, set as the clock moves (a Temperature the GM picks by hand holds until the next roll : weather.manual);
 *     heavy precipitation : snow at 32 °F or lower, else rain.
 */
export class groupWeather{
  static TEMPERATURE = ["normal", "cold", "heat"];
  static WIND = ["none", "light", "strong", "sandstorm"];
  static PRECIPITATION = ["none", "light", "rain", "snow"];
  /* Item identifiers : a 2024 Blanket, tents (2024 PHB : two Small or Medium creatures), clothing */
  static BLANKET = ["blanket"];
  static BEDROLL = ["bedroll"];
  static TENT = ["tent", "two-person-tent", "tent-two-person"];
  static COLD_GEAR = ["clothing-cold-weather", "cold-weather-clothing", "cold-weather-gear"];
  static WARM = ["warm-fungal-clothing"];
  static DESERT = ["desert-clothing"];
  static PLACES = { tiny : 0.5, sm : 1, med : 1 };
  /* d20 counts [none / normal, light / colder, strong / heavy / hotter] : RAW (14 or lower, 15-17, 18-20), then each
     season's default, found by its name */
  static RAW_BANDS = { temperature : [14, 3, 3], wind : [14, 3, 3], precipitation : [14, 3, 3] };
  static SEASON_BANDS = {
    spring : { temperature : [14, 4, 2], wind : [12, 5, 3], precipitation : [11, 6, 3] },
    summer : { temperature : [13, 1, 6], wind : [15, 3, 2], precipitation : [15, 3, 2] },
    fall : { temperature : [13, 5, 2], wind : [11, 5, 4], precipitation : [13, 4, 3] },
    winter : { temperature : [11, 8, 1], wind : [12, 4, 4], precipitation : [12, 4, 4] },
  };
  static ROLLS = ["temperature", "wind", "precipitation"];
  /* °F : each season's average days (low, high) and how much colder the night is, by climate */
  static CLIMATES = {
    arctic : { night : 15, winter : [-30, -5], spring : [-10, 20], summer : [30, 50], fall : [-5, 25] },
    cold : { night : 15, winter : [0, 25], spring : [25, 50], summer : [55, 75], fall : [25, 50] },
    temperate : { night : 10, winter : [20, 40], spring : [45, 65], summer : [70, 90], fall : [45, 65] },
    arid : { night : 25, winter : [50, 70], spring : [70, 90], summer : [90, 110], fall : [70, 90] },
    tropical : { night : 5, winter : [70, 85], spring : [75, 90], summer : [80, 95], fall : [75, 90] },
  };

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("updateActor", (actor, changes) => this.changed(actor, changes));
    Hooks.on(`${module.id}.preLight`, (actor, item, source) => this.mayLight(actor, item, source));
    rollModes.add("weather", config => this.attackMode(config));
    Hooks.on("updateWorldTime", (at, delta) => this.clockMoved(at, delta).catch(error => log.error("Weather changes", error)));
    Hooks.on("renderChatMessageHTML", (message, html) => this.drawRoll(message, html));
  }

  static rules(){
    return settings.value("weatherRules") ?? "2024";
  }

  static i18n(key, data){
    return data ? game.i18n.format(`groupTravel.weather.${key}`, data) : game.i18n.localize(`groupTravel.weather.${key}`);
  }

  /* The group's weather : { temperature, wind, precipitation } (a flag from before : one of clear / cold / heat / rain / wind) */
  static of(group){
    const saved = groupTravel.flag(group, "weather");
    const now = { temperature : "normal", wind : "none", precipitation : "none" };
    if(typeof saved === "string") return { ...now, ...({ cold : { temperature : "cold" }, heat : { temperature : "heat" }, rain : { precipitation : "rain" }, wind : { wind : "strong" } }[saved] ?? {}) };
    return { ...now, ...(saved ?? {}) };
  }

  /* The weather's effects in play : perception (Disadvantage), ranged (weapon attacks), douses (open flames) */
  static effectsOf(weather){
    const heavy = ["rain", "snow"].includes(weather.precipitation);
    const wind = ["strong", "sandstorm"].includes(weather.wind);
    return {
      perception : heavy || (weather.wind === "sandstorm") || (wind && (this.rules() === "2014")),
      ranged : wind, douses : (weather.precipitation === "rain") || wind,
      names : [heavy && this.i18n(`precipitation.${weather.precipitation}`), wind && this.i18n(`wind.${weather.wind}`)].filter(n => n)
    };
  }

  /* ---------- The Journey card ---------- */

  static selects(group){
    const weather = this.of(group);
    const off = game.user.isGM ? "" : "disabled";
    const select = (key, list, icon) => `<span class="pick"><i class="fa-solid ${icon}" inert data-tooltip="${this.i18n(`${key}Label`)}"></i>
      <select name="${key}" ${off} data-tooltip="${this.i18n(`${key}Label`)}">${list.map(v => `<option value="${v}" ${(v === weather[key]) ? "selected" : ""}>${this.i18n(`${key}.${v}`)}</option>`).join("")}</select></span>`;
    const climate = this.seasonsOn() ? `<span class="pick"><i class="fa-solid fa-earth-americas" inert data-tooltip="${this.i18n("climateLabel")}"></i>
      <select name="climate" ${off} data-tooltip="${this.i18n("climateLabel")}">${Object.keys(this.CLIMATES).map(c => `<option value="${c}" ${(c === this.climateOf(group)) ? "selected" : ""}>${this.i18n(`climate.${c}`)}</option>`).join("")}</select></span>` : "";
    return `${climate}${select("temperature", this.TEMPERATURE, "fa-temperature-half")}${this.degreesTag(group)}${select("wind", this.WIND, "fa-wind")}${select("precipitation", this.PRECIPITATION, "fa-cloud-rain")}
      ${game.user.isGM ? `<button type="button" class="roll unbutton" data-tooltip="${this.i18n("roll")}"><i class="fa-solid fa-dice-d20" inert></i></button>` : ""}
      ${game.user.isGM && this.seasonsOn() ? `<button type="button" class="seasons unbutton" data-tooltip="${this.i18n("seasons.button")}"><i class="fa-solid fa-leaf" inert></i></button>` : ""}`;
  }

  static listen(group, element){
    if(!game.user.isGM) return;
    for(const select of element.querySelectorAll("select[name]")){
      select.addEventListener("change", () => (select.name === "climate") ? group.setFlag(module.id, "climate", select.value)
        : this.set(group, { [select.name] : select.value, ...((select.name === "temperature") ? { manual : true } : {}) }));
    }
    element.querySelector(".roll")?.addEventListener("click", () => this.roll(group));
    element.querySelector(".seasons")?.addEventListener("click", () => this.editSeasons());
  }

  static set(group, changes){
    return group.setFlag(module.id, "weather", { ...this.of(group), ...changes });
  }

  /* 2024 DMG Weather : 1d20 each for temperature, wind and precipitation (14 or lower : none; 15-17 light / colder;
     18-20 strong, heavy / hotter; Weather by Season : the season's bands); the wind and precipitation are set, the
     temperature is the GM's to judge (Weather by Season : the degrees set it) */
  static async roll(group, { change = null } = {}){
    const at = change ?? game.time.worldTime;
    const roll = await new Roll("3d20").evaluate();
    const [t, w, p] = roll.dice[0].results.map(r => r.result);
    const season = this.seasonsOn() ? this.seasonAt(at) : null;
    const bands = season ? this.bandsOf(season) : this.RAW_BANDS;
    const band = (n, [none, light]) => (n <= none) ? 0 : (n <= none + light) ? 1 : 2;
    const [bt, bw, bp] = [[t, bands.temperature], [w, bands.wind], [p, bands.precipitation]].map(([n, b]) => band(n, b));
    const weather = this.of(group);
    const before = groupTravel.flag(group, "weather") ?? null;
    const wind = ["none", "light", "strong"][bw];
    const changes = { wind : (wind === "strong") && (weather.wind === "sandstorm") ? "sandstorm" : wind };
    let temp;
    if(season){
      await this.dayOf(group, gm.midnightOf(at));
      const shift = bt ? (await new Roll("2d4").evaluate()).total : 0;
      changes.shift = [0, -shift, shift][bt];
      changes.manual = false;
      const degrees = this.degreesAt(group, at, changes.shift);
      changes.temperature = this.temperatureFor(degrees);
      changes.precipitation = ["none", "light", (degrees <= 32) ? "snow" : "rain"][bp];
      temp = this.i18n(["rolled.normalDegrees", "rolled.colderDegrees", "rolled.hotterDegrees"][bt], { shift, degrees });
    }
    else {
      const degrees = bt ? (await new Roll("1d4 * 10").evaluate()).total : 0;
      changes.precipitation = ["none", "light", (weather.temperature === "cold") ? "snow" : "rain"][bp];
      temp = [this.i18n("rolled.normal"), this.i18n("rolled.colder", { degrees }), this.i18n("rolled.hotter", { degrees })][bt];
    }
    await this.set(group, changes);
    const line = (label, n, text) => `<li><b>${this.i18n(label)}</b> (${n}) : ${text}</li>`;
    const odds = season && this.i18n("seasons.rolled", { climate : this.i18n(`climate.${this.climateOf(group)}`), season : foundry.utils.escapeHTML(this.seasonLabel(season)) });
    await ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor : group }), whisper : game.users.filter(u => u.isGM).map(u => u.id),
      content : `<div class="macro-helper-group-log"><h4><i class="fa-solid fa-cloud-sun" inert></i> ${this.i18n("rolled.title")}</h4><ul>
        ${line("temperatureLabel", t, temp)}${line("windLabel", w, this.i18n(`wind.${changes.wind}`))}${line("precipitationLabel", p, this.i18n(`precipitation.${changes.precipitation}`))}</ul>
        ${season ? `<p class="when"><i class="fa-solid fa-leaf" inert></i> ${odds}</p>` : ""}
        ${change ? `<p class="when"><i class="fa-solid fa-clock" inert></i> ${this.i18n("changed", { time : groupTravel.formatted(change).time })}</p>` : ""}
        <p class="hint">${this.i18n(season ? "rolled.hintDegrees" : "rolled.hint")}</p></div>`,
      flags : { [module.id] : { weatherRoll : { group : group.uuid, before, after : this.of(group), ...(change ? { at : change } : {}) } } }
    });
  }

  /* ---------- Weather by season (homebrew) ---------- */

  static seasonsOn(){
    return groupTravel.enabled() && !!settings.value("homebrewWeatherSeasons");
  }

  /* The calendar's seasons (their names : i18n keys or text) */
  static seasons(){
    return game.time.calendar?.seasons?.values ?? [];
  }

  /* The season's name at that world time (none : null) */
  static seasonAt(at){
    try {
      const index = game.time.calendar.timeToComponents(at).season;
      return this.seasons()[index]?.name ?? null;
    }
    catch { return null; }
  }

  static seasonLabel(name){
    return game.i18n.localize(name);
  }

  /* Its key by name (Spring, Summer, Fall / Autumn, Winter), else null */
  static seasonKey(name){
    const text = `${name} ${this.seasonLabel(name)}`.toLowerCase();
    return ["spring", "summer", "fall", "winter"].find(k => text.includes(k)) ?? (text.includes("autumn") ? "fall" : null);
  }

  /* Its default bands : by its name, else RAW */
  static defaultBands(name){
    return this.SEASON_BANDS[this.seasonKey(name)] ?? this.RAW_BANDS;
  }

  /* Its bands : the GM's table, else its default (each roll's three counts add to 20) */
  static bandsOf(name){
    const saved = settings.value("weatherSeasons")?.[name] ?? {};
    const fallback = this.defaultBands(name);
    const ok = b => Array.isArray(b) && (b.length === 3) && b.every(n => Number.isInteger(n) && (n >= 0)) && (b[0] + b[1] + b[2] === 20);
    return Object.fromEntries(this.ROLLS.map(k => [k, ok(saved[k]) ? saved[k] : fallback[k]]));
  }

  static climateOf(group){
    const climate = groupTravel.flag(group, "climate");
    return (climate in this.CLIMATES) ? climate : "temperate";
  }

  /* The climate's average days in that season, °F [low, high] : the GM's table, else its default (a season not known
     by name : spring's) */
  static rangeOf(climate, season){
    const saved = settings.value("weatherClimates")?.[climate]?.[season];
    if(Array.isArray(saved) && (saved.length === 2) && saved.every(Number.isFinite) && (saved[0] <= saved[1])) return saved;
    return this.CLIMATES[climate][this.seasonKey(season) ?? "spring"];
  }

  static nightOf(climate){
    const saved = settings.value("weatherClimates")?.[climate]?.night;
    return Number.isFinite(saved) ? saved : this.CLIMATES[climate].night;
  }

  /* 18:00 to 6:00 (by the calendar's hours a day) */
  static isNight(at){
    const hours = game.time.calendar?.days?.hoursPerDay ?? 24;
    const hour = game.time.calendar.timeToComponents(at).hour;
    return (hour < hours / 4) || (hour >= hours * 3 / 4);
  }

  /* The day starting at midnight : its change hours (Weather Changes) and base °F (Weather by Season), rolled once */
  static async dayOf(group, midnight){
    const saved = groupTravel.flag(group, "weatherDay");
    const same = saved?.at === midnight;
    const day = { at : midnight, hours : same ? (saved.hours ?? null) : null, base : same ? (saved.base ?? null) : null };
    const hours = this.changesOn() && !day.hours;
    const base = this.seasonsOn() && !Number.isFinite(day.base);
    if(!hours && !base) return day;
    if(hours) day.hours = [(await new Roll("1d12").evaluate()).total, (await new Roll("2d12").evaluate()).total];
    if(base) day.base = await this.nextBase(group, midnight, saved?.base);
    await group.setFlag(module.id, "weatherDay", day);
    return day;
  }

  /* The day's base °F : the day before's, 2d6 - 7 and a quarter of the way back to the range's middle (none before :
     random in the range, to 5 °F) */
  static async nextBase(group, midnight, before){
    const [low, high] = this.rangeOf(this.climateOf(group), this.seasonAt(midnight + (gm.secondsPerDay / 2)));
    if(!Number.isFinite(before)) return Math.round((low + ((high - low) * (await new Roll("1d100").evaluate()).total / 100)) / 5) * 5;
    const step = (await new Roll("2d6 - 7").evaluate()).total;
    return Math.round(before + step + (((low + high) / 2) - before) / 4);
  }

  /* °F at that time : the day's base, the last roll's shift, the night */
  static degreesAt(group, at, shift = this.of(group).shift ?? 0){
    const day = groupTravel.flag(group, "weatherDay");
    const base = Number.isFinite(day?.base) ? day.base : (([low, high]) => Math.round((low + high) / 2))(this.rangeOf(this.climateOf(group), this.seasonAt(at)));
    return base + shift - (this.isNight(at) ? this.nightOf(this.climateOf(group)) : 0);
  }

  static temperatureFor(degrees){
    return (degrees <= 0) ? "cold" : (degrees >= 100) ? "heat" : "normal";
  }

  /* The Journey card's °F (refreshed as the clock moves) */
  static degreesTag(group){
    if(!this.seasonsOn()) return "";
    return `<span class="degrees" data-tooltip="${this.i18n("degreesHint")}">${this.degreesAt(group, game.time.worldTime)} °F</span>`;
  }

  static fillDegrees(group, element){
    const tag = this.seasonsOn() && group && element?.querySelector(".macro-helper-journey .weather .degrees");
    if(tag) tag.textContent = `${this.degreesAt(group, game.time.worldTime)} °F`;
  }

  /* The clock moved : the temperature and heavy precipitation follow the degrees (a hand-set Temperature holds) */
  static async settle(group, at){
    const weather = this.of(group);
    const degrees = this.degreesAt(group, at);
    const changes = {};
    if(!weather.manual && (this.temperatureFor(degrees) !== weather.temperature)) changes.temperature = this.temperatureFor(degrees);
    const heavy = (degrees <= 32) ? "snow" : "rain";
    if(["rain", "snow"].includes(weather.precipitation) && (weather.precipitation !== heavy)) changes.precipitation = heavy;
    if(Object.keys(changes).length) await this.set(group, changes);
  }

  /* The GM's table : the odds (for each season and roll, the counts of none and light; strong : the rest of the 20)
     and each climate's °F (each season's average days, the night) */
  static async editSeasons(){
    if(!game.user.isGM) return;
    const seasons = this.seasons();
    if(!seasons.length) return ui.notifications.warn(this.i18n("seasons.missing"));
    const now = this.seasonAt(game.time.worldTime);
    const climates = Object.keys(this.CLIMATES);
    const groups = game.actors.filter(a => a.type === "group").map(g => this.climateOf(g));
    const number = (name, value, min = 0, max = 20) => `<input type="number" name="${name}" value="${value}" min="${min}" max="${max}" step="1">`;
    const rows = seasons.map(({ name }, s) => {
      const bands = this.bandsOf(name);
      const lines = this.ROLLS.map(k => `<tr data-season="${s}" data-roll="${k}"><td>${this.i18n(`${k}Label`)}</td>
        <td>${number(`${s}.${k}.0`, bands[k][0])}</td><td>${number(`${s}.${k}.1`, bands[k][1])}</td><td><output>${bands[k][2]}</output></td></tr>`).join("");
      return `<tr><th colspan="4" class="season ${(name === now) ? "now" : ""}">${foundry.utils.escapeHTML(this.seasonLabel(name))}</th></tr>${lines}`;
    }).join("");
    const climateRows = climates.map(c => `<details ${groups.includes(c) ? "open" : ""}><summary>${this.i18n(`climate.${c}`)}</summary><table class="macro-helper-weather-seasons">
      <tr><th></th><th>${this.i18n("seasons.low")}</th><th>${this.i18n("seasons.high")}</th></tr>
      ${seasons.map(({ name }, s) => { const [low, high] = this.rangeOf(c, name); return `<tr><td class="${(name === now) ? "now" : ""}">${foundry.utils.escapeHTML(this.seasonLabel(name))}</td>
        <td>${number(`${c}.${s}.low`, low, -100, 150)}</td><td>${number(`${c}.${s}.high`, high, -100, 150)}</td></tr>`; }).join("")}
      <tr><td>${this.i18n("seasons.night")}</td><td>${number(`${c}.night`, this.nightOf(c), 0, 100)}</td><td></td></tr></table></details>`).join("");
    const content = `<p class="hint">${this.i18n("seasons.hint")}</p>
      <table class="macro-helper-weather-seasons"><tr><th></th>${["none", "light", "strong"].map(b => `<th>${this.i18n(`seasons.${b}`)}</th>`).join("")}</tr>${rows}</table>
      <h4>${this.i18n("seasons.climates")}</h4><p class="hint">${this.i18n("seasons.climatesHint")}</p>${climateRows}`;
    const read = form => {
      const odds = {}, temps = {};
      for(const [s, { name }] of seasons.entries()){
        odds[name] = Object.fromEntries(this.ROLLS.map(k => {
          const none = Math.clamp(Math.round(Number(form.elements[`${s}.${k}.0`].value) || 0), 0, 20);
          const light = Math.clamp(Math.round(Number(form.elements[`${s}.${k}.1`].value) || 0), 0, 20 - none);
          return [k, [none, light, 20 - none - light]];
        }));
      }
      for(const c of climates){
        temps[c] = { night : Math.max(0, Math.round(Number(form.elements[`${c}.night`].value) || 0)) };
        for(const [s, { name }] of seasons.entries()){
          const [a, b] = ["low", "high"].map(k => Math.round(Number(form.elements[`${c}.${s}.${k}`].value) || 0));
          temps[c][name] = [Math.min(a, b), Math.max(a, b)];
        }
      }
      return { odds, temps };
    };
    const table = await foundry.applications.api.DialogV2.wait({
      window : { title : this.i18n("seasons.title"), icon : "fa-solid fa-leaf" },
      position : { width : 460 },
      content,
      render : (event, dialog) => {
        const form = dialog.element.querySelector("form");
        /* The last count : what's left of the 20 */
        form.addEventListener("input", () => {
          const { odds } = read(form);
          for(const row of form.querySelectorAll("tr[data-season]")){
            row.querySelector("output").value = odds[seasons[row.dataset.season].name][row.dataset.roll][2];
          }
        });
      },
      buttons : [
        { action : "save", label : game.i18n.localize("SETTINGS.Save"), icon : "fa-solid fa-floppy-disk", default : true, callback : (event, button) => read(button.form) },
        { action : "reset", label : this.i18n("seasons.reset"), icon : "fa-solid fa-rotate-left", callback : () => "reset" },
        { action : "cancel", label : game.i18n.localize("Cancel"), icon : "fa-solid fa-xmark" }
      ],
      rejectClose : false
    });
    if(table === "reset"){
      await settings.change("weatherSeasons", {});
      return settings.change("weatherClimates", {});
    }
    if(!table || (typeof table !== "object")) return;
    await settings.change("weatherSeasons", table.odds);
    await settings.change("weatherClimates", table.temps);
  }

  /* ---------- Weather changes (homebrew) ---------- */

  static changesOn(){
    return groupTravel.enabled() && !!settings.value("homebrewWeatherChanges");
  }

  /* The clock moved (the active GM) : forward past a change hour, the weather is rolled (once, at the last one passed);
     back before a change's hour, its weather goes back; Weather by Season : each day's base, then the temperature follows */
  static async clockMoved(at, delta){
    delta = Number(delta) || 0;
    const changes = this.changesOn(), seasons = this.seasonsOn();
    if(!delta || !(changes || seasons) || !game.users.activeGM?.isSelf) return;
    const groups = game.actors.filter(a => (a.type === "group") && groupTravel.creatures(a).length);
    if(delta < 0){
      const undone = changes ? game.messages.filter(m => { const d = m.getFlag(module.id, "weatherRoll"); return d?.at && !d.undone && (d.at > at); }) : [];
      for(const message of undone.reverse()) await this.undoRoll(message);
      if(seasons) for(const group of groups) await this.settle(group, at);
      return;
    }
    const start = at - delta, hour = groupTravel.secondsPerHour(), day = gm.secondsPerDay;
    for(const group of groups){
      let last = null;
      for(let midnight = gm.midnightOf(start); midnight <= at; midnight += day){
        const { hours } = await this.dayOf(group, midnight);
        for(const h of (changes && hours) || []){
          const mark = midnight + (h * hour);
          if((mark > start) && (mark <= at) && ((last === null) || (mark > last))) last = mark;
        }
      }
      if(last !== null) await this.roll(group, { change : last });
      if(seasons) await this.settle(group, at);
    }
  }

  static drawRoll(message, html){
    const data = message.getFlag(module.id, "weatherRoll");
    const card = data && html.querySelector(".macro-helper-group-log");
    if(!card) return;
    if(data.undone) return card.classList.add("undone");
    if(!game.user.isGM || !("before" in data)) return;
    const row = buttonRow(html, { key : "macro-helper-weather-undo" });
    addButton(row, makeButton({ icon : "fa-rotate-left", text : game.i18n.localize("groupTravel.undo"), once : true,
      onClick : () => this.undoRoll(message) }));
  }

  /* The weather as it was before the roll (unless the GM changed it since) */
  static async undoRoll(message){
    const data = message?.getFlag(module.id, "weatherRoll");
    if(!game.user.isGM || !data || data.undone) return false;
    const group = await fromUuid(data.group);
    const kept = w => ({ ...w, ...(this.seasonsOn() ? { temperature : null, precipitation : ["rain", "snow"].includes(w.precipitation) ? "heavy" : w.precipitation } : {}) });
    if(group && !foundry.utils.equals(kept(this.of(group)), kept(data.after))){
      ui.notifications.warn(this.i18n("undoChanged"));
      return false;
    }
    await message.setFlag(module.id, "weatherRoll.undone", true);
    if(!group) return false;
    if(data.before) await group.setFlag(module.id, "weather", data.before);
    else await group.unsetFlag(module.id, "weather");
    return true;
  }

  /* ---------- Shelter ---------- */

  static member(group, actor){
    return groupTravel.memberOf(group, actor);
  }

  /* The GM's ticks : a member sheltered, a vehicle covered; 2014 : adapted to cold / heat */
  static setMember(group, actor, changes){
    if(!game.user.isGM) return;
    return group.update({ [`flags.${module.id}.members.${actor.id}`] : changes });
  }

  /* The Members tab : Sheltered (a creature) / Covered (a vehicle), 2014 : Adapted to (cold, heat); the GM's */
  static memberControls(group, actor){
    const member = this.member(group, actor);
    const off = game.user.isGM ? "" : "disabled";
    const vehicle = actor.type === "vehicle";
    const key = vehicle ? "covered" : "sheltered";
    /* A passenger of a covered vehicle : sheltered by it (the tick stays the GM's own) */
    const by = !vehicle && !member.sheltered && (this.roadShelter(group, actor) === "vehicle") ? groupTravel.memberActor(group, groupTravel.travelOf(group, actor).target) : null;
    const tip = by ? `${this.i18n(`${key}Hint`)}<br>${this.i18n("coveredBy", { vehicle : foundry.utils.escapeHTML(by.name) })}` : this.i18n(`${key}Hint`);
    const toggle = `<button type="button" class="weather-${key} unbutton ${member[key] ? "active" : ""} ${by ? "by-vehicle" : ""}" data-tooltip="${foundry.utils.escapeHTML(tip)}" ${off}>
      <i class="fa-solid ${vehicle ? "fa-caravan" : "fa-person-shelter"}" inert></i></button>`;
    if(vehicle) return toggle;
    const shown = `${toggle}${this.exposureIcon(group, actor)}${this.effectIcon(group, actor)}`;
    if(this.rules() !== "2014") return shown;
    const options = ["none", "cold", "heat"].map(v => `<option value="${v}" ${(v === (member.adapted ?? "none")) ? "selected" : ""}>${this.i18n(`adapted.${v}`)}</option>`).join("");
    return `${shown}<select class="weather-adapted" data-tooltip="${this.i18n("adaptedHint")}" ${off}>${options}</select>`;
  }

  /* Extreme Cold or Heat on the road : why it passes, or the save it makes each hour (camp shelter, Bedrolls : at camp) */
  static exposureIcon(group, actor){
    const kind = { cold : "cold", heat : "heat" }[this.of(group).temperature];
    if(!kind) return "";
    const shelter = this.roadShelter(group, actor);
    const safe = shelter ? this.i18n(`safe.${shelter}`) : this.autoPass(group, actor, kind) ? this.i18n("safe.pass")
      : ((kind === "heat") && this.hasWater(actor, {})) ? this.i18n("safe.water") : null;
    let tip = safe;
    if(!safe){
      const dc = (kind === "heat") ? 5 + (Number(actor.getFlag(module.id, "heatHours")) || 0) : 10;
      const mode = (kind === "heat") ? ((this.heavyArmor(actor) || ((this.rules() === "2014") && this.hasItem(actor, this.COLD_GEAR, { worn : true }))) && this.i18n("exposedDis"))
        : ((this.rules() !== "2014") && this.hasItem(actor, this.BLANKET) && this.i18n("exposedAdv"));
      tip = [this.i18n("exposed", { dc }), mode].filter(t => t).join("<br>");
    }
    return `<span class="exposure ${safe ? "" : "over"}" data-tooltip="${foundry.utils.escapeHTML(`${this.i18n(`temperature.${kind}`)}<br>${tip}`)}">
      <i class="fa-solid ${(kind === "cold") ? "fa-temperature-low" : "fa-temperature-high"}" inert></i></span>`;
  }

  /* Its Weather effect from this group (heavy rain or snow, strong wind) : what it gives */
  static effectIcon(group, actor){
    const effect = actor.effects.find(e => e.getFlag(module.id, "weather")?.group === group.uuid);
    if(!effect) return "";
    const what = [effect.changes.length && this.i18n("perceptionDis"), effect.getFlag(module.id, "weather")?.ranged && this.i18n("rangedDis")].filter(t => t);
    return `<span class="weather-effect" data-tooltip="${foundry.utils.escapeHTML([effect.name, ...what].join("<br>"))}"><img src="${effect.img}"></span>`;
  }

  static listenMember(group, actor, card){
    if(!game.user.isGM) return;
    for(const key of ["sheltered", "covered"]){
      card.querySelector(`.weather-${key}`)?.addEventListener("click", () => this.setMember(group, actor, { [key] : !this.member(group, actor)[key] }));
    }
    card.querySelector(".weather-adapted")?.addEventListener("change", event => this.setMember(group, actor, { adapted : event.target.value }));
  }

  /* Sheltered on the road : the GM's tick, or a passenger of a covered vehicle */
  static roadShelter(group, actor){
    if(this.member(group, actor).sheltered) return "sheltered";
    const way = groupTravel.travelOf(group, actor);
    const vehicle = (way.by === "passenger") && groupTravel.memberActor(group, way.target);
    return (vehicle && this.member(group, vehicle).covered) ? "vehicle" : null;
  }

  /* Places at camp for each member : its own tents, then the others' (members, packs), then built shelters :
     Map(actor -> "tent" | "built"); Large or bigger fit in neither */
  static campPlaces(group, plan, builders = []){
    /* A tent anywhere in the group : a member, a mount, a vehicle, the group itself */
    const holders = [...new Set([group, ...groupTravel.creatures(group), ...groupTravel.vehicles(group)])];
    const tentsOf = a => a.items.filter(i => this.TENT.includes(idOf(i))).reduce((n, i) => n + (Number(i.system.quantity) || 0), 0);
    const pool = [{ kind : "tent", left : 2 * holders.reduce((n, a) => n + tentsOf(a), 0) }, { kind : "built", left : 2 * builders.length }];
    const places = new Map();
    for(const actor of plan){
      const size = this.PLACES[actor.system.traits?.size];
      if(!size) continue;
      const spot = pool.find(p => p.left >= size);
      if(!spot) continue;
      spot.left -= size;
      places.set(actor, spot.kind);
    }
    return places;
  }

  /* ---------- Hourly saves ---------- */

  static hasItem(actor, ids, { worn = false } = {}){
    return actor.items.some(i => ids.includes(idOf(i)) && (Number(i.system.quantity ?? 1) > 0) && (!worn || i.system.equipped));
  }

  static resists(actor, type){
    const traits = actor.system.traits ?? {};
    return ["dr", "di"].some(k => traits[k]?.value?.has?.(type));
  }

  static heavyArmor(actor){
    const armor = actor.system.attributes?.ac?.equippedArmor ?? actor.items.find(i => (i.type === "equipment") && i.system.equipped && ["medium", "heavy"].includes(i.system.type?.value));
    return ["medium", "heavy"].includes(armor?.system?.type?.value);
  }

  /* Passes without a roll */
  static autoPass(group, actor, kind){
    const adapted = (this.rules() === "2014") && (this.member(group, actor).adapted === kind);
    if(kind === "cold") return this.resists(actor, "cold") || adapted || this.hasItem(actor, this.WARM, { worn : true })
      || ((this.rules() === "2014") && this.hasItem(actor, this.COLD_GEAR, { worn : true }));
    return this.resists(actor, "fire") || adapted || (this.hasItem(actor, this.DESERT, { worn : true }) && !this.heavyArmor(actor));
  }

  /* Drinkable water on hand : its own waterskins, water near the camp, an inn */
  static hasWater(actor, where){
    if(where.water) return true;
    return actor.items.some(i => (Number(i.getFlag(module.id, "water")) || 0) > 0);
  }

  /* The hour marks the clock passes from start, for seconds */
  static hourMarks(start, seconds){
    const hour = groupTravel.secondsPerHour();
    const marks = [];
    for(let t = (Math.floor(start / hour) + 1) * hour; t <= start + seconds; t += hour) marks.push(t);
    return marks;
  }

  /**
   * Each hour the clock passed : the exposed members' Cold or Heat save cards (on the GM's client).
   * @param {Actor} group
   * @param {object} options
   * @param {number} options.start     the world time it started at
   * @param {number} options.seconds
   * @param {"travel"|"pass"|"camp"} [options.context]
   * @param {(actor : Actor, time : number) => string|null} [options.shelter]   at camp : that hour's shelter
   * @param {(actor : Actor) => boolean} [options.asleep]   at camp : asleep (or in Trance) that hour
   * @param {object} [options.where]   { water } : drinkable water for everyone
   * @param {Map} [options.heat]       filled with each member's heatHours before (for an Undo)
   * @returns {Promise<ChatMessage[]>}
   */
  static async hourly(group, { start, seconds, context = "pass", shelter = null, asleep = null, where = {}, heat = null } = {}){
    const weather = this.of(group);
    const kind = { cold : "cold", heat : "heat" }[weather.temperature];
    const members = groupTravel.creatures(group);
    if(!kind){
      for(const actor of members) if(actor.getFlag(module.id, "heatHours")){ heat?.set(actor.uuid, actor.getFlag(module.id, "heatHours")); await actor.unsetFlag(module.id, "heatHours"); }
      return [];
    }
    const cards = [];
    for(const time of this.hourMarks(start, seconds)){
      const { time : clock } = groupTravel.formatted(time);
      const rows = new Map();
      for(const actor of members){
        if(kind === "heat") await groupFood.hot(actor, time);
        const covered = (shelter?.(actor, time)) ?? this.roadShelter(group, actor);
        const bedroll = (kind === "cold") && (this.rules() !== "2014") && !!asleep?.(actor) && (actor.system.traits?.size in this.PLACES) && this.hasItem(actor, this.BEDROLL);
        const exposed = !covered && !bedroll && !((kind === "heat") && this.hasWater(actor, where)) && !this.autoPass(group, actor, kind);
        if((kind === "heat") && !heat?.has(actor.uuid)) heat?.set(actor.uuid, Number(actor.getFlag(module.id, "heatHours")) || 0);
        if(!exposed){
          if(actor.getFlag(module.id, "heatHours")) await actor.unsetFlag(module.id, "heatHours");
          continue;
        }
        let dc = 10, rollMode = null;
        if(kind === "heat"){
          const hours = (Number(actor.getFlag(module.id, "heatHours")) || 0) + 1;
          await actor.setFlag(module.id, "heatHours", hours);
          dc = 4 + hours;
          const clothing = (this.rules() === "2014") && this.hasItem(actor, this.COLD_GEAR, { worn : true });
          if(this.heavyArmor(actor) || clothing) rollMode = { mode : "disadvantage", reason : this.i18n(clothing ? "clothing" : "armor") };
        }
        else if((this.rules() !== "2014") && this.hasItem(actor, this.BLANKET)){
          rollMode = { mode : "advantage", reason : this.i18n("blanket") };
        }
        (rows.get(dc) ?? rows.set(dc, []).get(dc)).push({ actor : actor.uuid, name : actor.name, img : actor.img, ...(rollMode ? { rollMode } : {}) });
      }
      for(const [dc, who] of [...rows].sort((a, b) => a[0] - b[0])){
        cards.push(await rollRequests.request({ who, what : "save:con", dc, hideDC : false, speaker : group, onFail : "exhaustion",
          label : this.i18n(`${kind}Save`, { save : rollRequests.labelOf("save", "con"), time : clock }) }));
      }
    }
    return cards;
  }

  /* Undo : each member's heatHours as they were */
  static async restoreHeat(list = []){
    for(const [uuid, hours] of list){
      const actor = await fromUuid(uuid);
      if(!actor) continue;
      if(hours) await actor.setFlag(module.id, "heatHours", hours); else await actor.unsetFlag(module.id, "heatHours");
    }
  }

  /* ---------- Effects on the members ---------- */

  /* The weather changed, or the members : each creature member's Weather effect (the active GM); flames put out */
  static changed(actor, changes){
    if((actor.type !== "group") || !groupTravel.enabled() || !game.users.activeGM?.isSelf) return;
    const flat = Object.keys(foundry.utils.flattenObject(changes ?? {}));
    const weather = k => [`flags.${module.id}.weather`, `flags.${module.id}.-=weather`].some(w => (k === w) || k.startsWith(`${w}.`));
    if(!flat.some(k => weather(k) || k.startsWith("system.members"))) return;
    /* One sync after another : quick changes would overlap on the same effects */
    this.#syncs = this.#syncs.then(() => this.sync(actor)).catch(error => log.error("Weather", error));
  }

  static #syncs = Promise.resolve();

  static async sync(group){
    const weather = this.of(group);
    const effects = this.effectsOf(weather);
    const members = groupTravel.creatures(group);
    for(const actor of members) await this.syncActor(actor, group, effects);
    /* Members who left : their effect from this group goes */
    for(const actor of game.actors){
      if(members.includes(actor)) continue;
      for(const effect of actor.effects.filter(e => e.getFlag(module.id, "weather")?.group === group.uuid)) await this.drop(effect);
    }
    if(weather.temperature !== "heat") for(const actor of members) if(actor.getFlag(module.id, "heatHours")) await actor.unsetFlag(module.id, "heatHours");
  }

  static async syncActor(actor, group, effects){
    const mine = actor.effects.filter(e => e.getFlag(module.id, "weather")?.group === group.uuid);
    const wanted = effects.perception || effects.ranged;
    const changes = effects.perception ? [{ key : "system.skills.prc.roll.mode", type : "add", mode : 2, value : "-1" }] : [];
    const img = effects.ranged ? "icons/magic/air/weather-wind-gust.webp" : (this.of(group).precipitation === "snow") ? "icons/magic/air/weather-clouds-snow.webp" : "icons/magic/air/weather-clouds-rain.webp";
    const data = { name : this.i18n("effect", { names : effects.names.join(", ") }), img,
      changes, flags : { [module.id] : { weather : { group : group.uuid, ranged : effects.ranged } } } };
    const [first, ...extra] = mine;
    for(const e of extra) await this.drop(e);
    if(!wanted){ if(first) await this.drop(first); }
    else if(!first) await actor.createEmbeddedDocuments("ActiveEffect", [{ ...data, transfer : false, showIcon : CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2 }]);
    else if((first.name !== data.name) || (first.changes.map(c => c.key).join() !== changes.map(c => c.key).join()) || (first.getFlag(module.id, "weather")?.ranged !== effects.ranged)) await first.update(data);
    if(effects.douses) await this.douse(actor);
  }

  /* Quick weather changes overlap their syncs : an effect already gone is fine */
  static async drop(effect){
    try { await effect.delete(); }
    catch(error){ log.debug("Weather effect already gone", effect.id, error.message); }
  }

  /* Open flames lit go out (keeping their time) */
  static async douse(actor){
    for(const item of actor.items){
      const id = item.id;
      if(heldLight.sourceOf(item)?.open && heldLight.isLit(actor, id)){
        await heldLight.putOut(actor, id, { keepTime : true });
        log.debug("Weather puts out", actor.name, id);
      }
    }
  }

  /* The weather a creature is in : its groups' (any douses : that one) */
  static weatherFor(actor){
    const groups = game.actors.filter(a => (a.type === "group") && groupTravel.creatures(a).includes(actor));
    return groups.map(g => this.effectsOf(this.of(g)));
  }

  /* Heavy rain, strong wind : an open flame won't light */
  static mayLight(actor, item, source){
    if(!groupTravel.enabled() || !source?.open || !actor) return;
    if(!this.weatherFor(actor).some(e => e.douses)) return;
    ui.notifications.warn(this.i18n("noFlame", { item : item.name }));
    return false;
  }

  /* Strong wind : Disadvantage on ranged weapon attacks */
  static attackMode(config){
    const attack = attackOf(config);
    if(!attack.actor || !attack.weapon || !(attack.ranged || attack.thrown) || !config.rolls?.[0]) return;
    const effect = attack.actor.effects.find(e => e.getFlag(module.id, "weather")?.ranged && !e.disabled);
    if(effect) giveMode(config.rolls[0], "disadvantage", this.i18n("wind.strong"));
  }
}
