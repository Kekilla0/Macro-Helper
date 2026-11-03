import { module } from '../module.js';
import { logger } from '../log.js';
import { settings } from '../settings.js';
import { rollRequests } from '../requests/requests.js';
import { idOf } from '../helpers/utils.js';
import { extraHitDice } from './hit-dice.js';
import { groupTravel } from './group-travel.js';
import { groupCamp, campTask } from './group-camp.js';
import { groupInventory } from './group-inventory.js';
import { groupWeather } from './group-weather.js';
import { groupFood } from './group-food.js';
const log = logger.for(import.meta.url);

/**
 * Group Travel : Rested Levels (homebrew switch homebrewRestedLevels, under Camp Tasks). Each member finishing its Long
 * Rest at the camp gets a level from -2 to +2 by the points of its night :
 *   the camp : a fire lit +1 (none through Extreme Cold -1); every hour someone rested in watched (someone on watch, or
 *   alarms set in an hour before it) +1; its shelter : every hour +1, saves against the weather -1 (flags camp.run.bare,
 *   exposed, cold); a full day's food and water +1, under half of either -1 (food and water on, a tracked member : the
 *   day of its meal); each interruption of its rest -1. Points 4+ : +2, 2-3 : +1, 0-1 : 0, -1 : -1, less : -2.
 *   An inn : the lifestyle instead (Squalid -1, Poor and Modest 0, Comfortable +1, Wealthy and Aristocratic +2; a Beast
 *   stabled 0), under half the food or water -1, each interruption -1.
 *   -2 : the Long Rest lowers no Exhaustion, 2 fewer Hit Point Dice back; -1 : 1 fewer (taken from that rest's own
 *   recovery, before its updates); +1 : Heroic Inspiration; +2 : Heroic Inspiration and one Hit Point Die over the
 *   maximum until the next Long Rest (extraHitDice). Heroic Inspiration : a character's.
 *   Set Alarms : an hour, a Wisdom (Survival) check, DC 10 moved by the weather (heavy rain or snow +2, strong wind +2, a
 *   sandstorm +4; at most 4), Advantage carrying a Hunting Trap, Caltrops, Ball Bearings or a Bell (its own or a
 *   pack's); the Alarm spell known : set, no check. The first success covers every hour after its own (flag
 *   camp.run.alarm : its hour).
 */
export class restedLevels{
  static ALARM_DC = 10;
  static ALARM_ITEMS = ["hunting-trap", "caltrops", "ball-bearings", "bell"];
  static INNS = { squalid : -1, poor : 0, modest : 0, comfortable : 1, wealthy : 2, aristocratic : 2 };
  /* actor uuid -> { level, parts, group } : worked out as the camp ends, for its rests */
  static #pending = new Map();

  static register(){
    if(game.system.id !== "dnd5e") return;
    campTask("alarm", { label : "groupTravel.camp.task.alarm", hint : "groupTravel.camp.task.alarmHint", icon : "fa-solid fa-bell", homebrew : true,
      available : () => this.on(), start : data => this.alarmStart(data), collect : data => this.alarmCollect(data) });
    Hooks.on(`${module.id}.campResting`, (group, info) => this.resting(group, info));
    Hooks.on("dnd5e.preRestCompleted", (actor, result, config) => this.restCompleted(actor, result, config));
    Hooks.on(`${module.id}.campEnded`, (group, info) => this.ended(group, info).catch(err => log.error("Rested levels :", err)));
  }

  static on(){
    return groupCamp.homebrewTasks() && !!settings.value("homebrewRestedLevels");
  }

  static i18n(key, data){
    return groupCamp.i18n(`rested.${key}`, data);
  }

  /* ---------- Set Alarms ---------- */

  static knowsAlarm(actor){
    return actor.items.some(i => (i.type === "spell") && (idOf(i) === "alarm"));
  }

  static alarmItem(actor, group){
    return [actor, ...groupInventory.packs(group)].flatMap(a => a.items.contents)
      .find(i => this.ALARM_ITEMS.includes(idOf(i)) && (Number(i.system.quantity ?? 1) > 0)) ?? null;
  }

  /* What moves its DC : noise and wind (shelter doesn't help : the alarms are out around the camp) */
  static weatherMods(group){
    const w = groupWeather.of(group);
    const mods = [];
    if(["rain", "snow"].includes(w.precipitation)) mods.push({ value : -2, label : groupWeather.i18n(`precipitation.${w.precipitation}`) });
    if(w.wind === "sandstorm") mods.push({ value : -4, label : groupWeather.i18n("wind.sandstorm") });
    else if(w.wind === "strong") mods.push({ value : -2, label : groupWeather.i18n("wind.strong") });
    return mods;
  }

  static async alarmStart({ group, actors }){
    const casters = actors.filter(a => this.knowsAlarm(a));
    const rollers = actors.filter(a => !casters.includes(a));
    const mods = this.weatherMods(group);
    const dc = this.ALARM_DC - groupCamp.modTotal(mods);
    let card = null;
    if(rollers.length){
      const who = rollers.map(a => {
        const item = this.alarmItem(a, group);
        return { actor : a.uuid, name : a.name, img : a.img, ...(item ? { rollMode : { mode : "advantage", reason : this.i18n("alarmItem", { item : item.name }) } } : {}) };
      });
      card = await rollRequests.request({ who, what : "skill:sur", dc, hideDC : false, speaker : group,
        label : this.i18n("alarmCard", { skill : rollRequests.labelOf("skill", "sur") }) + (mods.length ? ` (${groupCamp.esc(groupCamp.modText(mods))})` : "") });
    }
    return { message : card?.id ?? null, dc, casters : casters.map(a => a.id) };
  }

  static async alarmCollect({ group, actors, data, hour }){
    const lines = [], outcomes = {};
    let set = false;
    for(const actor of actors){
      const name = groupCamp.esc(actor.name);
      if((data?.casters ?? []).includes(actor.id)){
        outcomes[actor.id] = "ok";
        set = true;
        lines.push(this.i18n("alarmSpell", { name }));
        continue;
      }
      const got = groupCamp.checked(data, actor);
      outcomes[actor.id] = got?.outcome ?? "fail";
      set ||= got?.outcome === "ok";
      lines.push(this.i18n(!got ? "alarmNone" : (got.outcome === "ok") ? "alarmDone" : "alarmFail", { name }));
    }
    const run = groupCamp.campOf(group).run;
    if(set && !Number.isInteger(run?.alarm)) await group.update({ [`flags.${module.id}.camp.run.alarm`] : hour });
    return { lines, outcomes };
  }

  /* ---------- A member's level ---------- */

  /* The hours (up to `upTo`) someone rested in with no watch and no alarm set before */
  static unwatched(plan, alarm, upTo){
    const rests = c => (c === "sleep") || (c === "trance");
    return Array.from({ length : upTo }, (_, h) => h).filter(h => plan.rows.some(r => rests(r.cells[h]))
      && !plan.rows.some(r => r.cells[h] === "watch") && !(Number.isInteger(alarm) && (alarm < h)));
  }

  /* The camp's part : { fire, cold, unwatched (hours) }; before it's made, as planned (a fire or alarms picked) */
  static campState(group, camp, plan){
    const run = camp.run;
    const planned = id => plan.rows.map(r => r.cells.indexOf(`task:${id}`)).filter(h => h >= 0);
    const fire = run ? !!run.lit : planned("fire").length > 0;
    const cold = run ? !!run.cold : (groupWeather.of(group).temperature === "cold");
    const alarm = run ? run.alarm : (planned("alarm").length ? Math.min(...planned("alarm")) : null);
    return { fire, cold, unwatched : this.unwatched(plan, alarm, run ? Math.min(run.hour, plan.total) : plan.total) };
  }

  /* Food and water : 1 the day's full need, 0 some, -1 under half of either; null : not tracked. Before its meal : the
     full need expected */
  static food(group, camp, r){
    if(!groupFood.enabled() || !groupFood.tracked(group, r.actor)) return null;
    if(!camp.run || !(camp.run.fed ?? []).includes(r.actor.id)) return { value : 1, expected : true };
    const at = camp.run.start + (Math.max(-1, r.meal ?? -1) + 1) * groupTravel.secondsPerHour();
    const intake = groupFood.intakeOf(r.actor, groupFood.dayOf(at));
    const needs = groupFood.needs(r.actor, intake);
    if((intake.food < needs.food / 2) || (intake.water < needs.water / 2)) return { value : -1 };
    return { value : ((intake.food >= needs.food - 1e-6) && (intake.water >= needs.water - 1e-6)) ? 1 : 0 };
  }

  /* { level, points, parts : [{ text, value }] } */
  static score(group, camp, plan, r, state = null){
    const parts = [];
    const add = (value, key, data) => parts.push({ value, text : this.i18n(`part.${key}`, data) });
    const food = this.food(group, camp, r);
    const interrupts = Number(camp.run?.interrupts?.[r.actor.id]) || 0;
    if(groupCamp.atInn(camp.plan)){
      if(groupCamp.isBeast(r.actor)) add(0, "stabled");
      else add(this.INNS[camp.plan.lodging] ?? 0, "inn", { lodging : groupCamp.i18n(`lodging.${camp.plan.lodging}`) });
      if(food?.value < 0) add(-1, "hungry");
      if(interrupts) add(-interrupts, "interrupted", { count : interrupts });
      const points = parts.reduce((s, p) => s + p.value, 0);
      return { points, level : Math.max(-2, Math.min(2, points)), parts };
    }
    state ??= this.campState(group, camp, plan);
    if(state.fire) add(1, "fire");
    else if(state.cold) add(-1, "noFireCold");
    else add(0, "noFire");
    add(state.unwatched.length ? 0 : 1, state.unwatched.length ? "unwatched" : "watched", { count : state.unwatched.length });
    if(camp.run){
      const exposed = (camp.run.exposed ?? []).includes(r.actor.id), bare = (camp.run.bare ?? []).includes(r.actor.id);
      add(exposed ? -1 : bare ? 0 : 1, exposed ? "exposed" : bare ? "bare" : "shelter");
    }
    else {
      const covered = !!groupCamp.shelterOf(group, camp, plan, groupCamp.places(group, plan), r.actor);
      const extreme = groupWeather.of(group).temperature !== "normal";
      add(covered ? 1 : extreme ? -1 : 0, covered ? "shelter" : extreme ? "exposed" : "bare");
    }
    if(food) add(food.value, (food.value > 0) ? (food.expected ? "fedExpected" : "fed") : (food.value < 0) ? "hungry" : "someFood");
    if(interrupts) add(-interrupts, "interrupted", { count : interrupts });
    const points = parts.reduce((s, p) => s + p.value, 0);
    return { points, level : (points >= 4) ? 2 : (points >= 2) ? 1 : (points >= 0) ? 0 : (points === -1) ? -1 : -2, parts };
  }

  static signed(n){
    return (n > 0) ? `+${n}` : String(n);
  }

  static partsText(parts){
    return parts.map(p => `${p.text} ${this.signed(p.value)}`).join(", ");
  }

  /* What the level does for it (Heroic Inspiration : a character's) */
  static effect(actor, level){
    return this.i18n(`effect${((level > 0) && (actor.type !== "character")) ? "Npc" : ""}.${level}`);
  }

  /* The Camp window's Rested cell */
  static cell(group, camp, plan, r){
    if(!this.on()) return "";
    if(!r.row.rest) return "<td></td>";
    const { level, parts } = this.score(group, camp, plan, r);
    const tip = `${this.effect(r.actor, level)}<br>${groupCamp.esc(this.partsText(parts))}`;
    return `<td class="rested ${(level > 0) ? "good" : (level < 0) ? "over" : ""}" data-tooltip="${groupCamp.esc(tip)}">${this.signed(level)}</td>`;
  }

  /* ---------- The camp ends (on the GM's client) ---------- */

  /* Before the rests : each one's level */
  static resting(group, { rested, plan, camp } = {}){
    if(!this.on() || !camp?.run) return;
    const state = groupCamp.atInn(camp.plan) ? null : this.campState(group, camp, plan);
    for(const actor of rested?.long ?? []){
      const r = plan.rows.find(row => row.actor === actor);
      if(r) this.#pending.set(actor.uuid, { ...this.score(group, camp, plan, r, state), group : group.uuid });
    }
  }

  /* Its Long Rest : -1 / -2 take Hit Point Dice from what it gets back (-2 : no Exhaustion lowered) */
  static restCompleted(actor, result, config){
    const entry = this.#pending.get(actor.uuid);
    if(!entry || (config?.type !== "long") || !result || (entry.level >= 0)) return;
    this.fewerDice(actor, result, -entry.level);
    if(entry.level <= -2){
      const path = "system.attributes.exhaustion";
      result.updateData ??= {};
      if((foundry.utils.getProperty(result.updateData, path) !== undefined) || (path in result.updateData)){
        delete result.updateData[path];
        foundry.utils.setProperty(result.updateData, path, Number(foundry.utils.getProperty(actor, path)) || 0);
      }
    }
  }

  /* Up to n fewer Hit Point Dice back from the rest's recovery : how many */
  static fewerDice(actor, result, n){
    const read = (u, path) => (path in u) ? u[path] : foundry.utils.getProperty(u, path);
    const write = (u, path, v) => { if(path in u) u[path] = v; else foundry.utils.setProperty(u, path, v); };
    let left = n;
    for(const u of result.updateItems ?? []){
      const item = actor.items.get(u._id), now = read(u, "system.hd.spent");
      if((left <= 0) || (item?.type !== "class") || (now === undefined)) continue;
      const back = Math.min(left, (Number(item.system.hd.spent) || 0) - now);
      if(back > 0){ write(u, "system.hd.spent", now + back); left -= back; }
    }
    const path = "system.attributes.hd.spent", now = read(result.updateData ?? {}, path);
    if((left > 0) && (now !== undefined) && !Object.keys(actor.classes ?? {}).length){
      const back = Math.min(left, (Number(actor.system.attributes.hd.spent) || 0) - now);
      if(back > 0){ write(result.updateData, path, now + back); left -= back; }
    }
    const taken = n - left;
    if(result.deltas) result.deltas.hitDice = (Number(result.deltas.hitDice) || 0) - taken;
    return taken;
  }

  /* After the rests : +1 / +2 given, the log */
  static async ended(group, { rested } = {}){
    const lines = [];
    for(const actor of rested?.long ?? []){
      const entry = this.#pending.get(actor.uuid);
      if(!entry || (entry.group !== group.uuid)) continue;
      this.#pending.delete(actor.uuid);
      if(entry.level >= 2) await extraHitDice(actor, 1);
      if((entry.level >= 1) && (actor.type === "character")) await actor.update({ "system.attributes.inspiration" : true });
      lines.push(this.i18n("logLine", { name : groupCamp.esc(actor.name), effect : this.effect(actor, entry.level), parts : groupCamp.esc(this.partsText(entry.parts)) }));
    }
    if(lines.length) await groupCamp.postLog(group, "rested", { lines });
  }
}
