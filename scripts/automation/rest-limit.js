import { module } from '../module.js';
import { limits } from './limits.js';

/**
 * One Long Rest a day (Rule Limits) : a creature's Long Rest may start on a later calendar day than its last one
 * started (the group's choice over RAW's "16 hours after it ends" : one ending at 23:00 lets the next start at 01:00).
 * Each Long Rest's start is kept on the creature (flag lastLongRest, world time in seconds) : its own sheet, the group's
 * rest, a rest request card. Time put back before it (an Undo) doesn't count against it. A group's rest is checked once, for
 * the members ticked in its window (one notice; Block : nobody rests and the clock stays).
 */
export class restLimit{
  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.preLongRest", (actor, config) => this.check(actor, config));
    Hooks.on("dnd5e.longRest", (actor, config) => this.checkGroup(actor, config));
    Hooks.on("dnd5e.restCompleted", (actor, result, config) => this.keep(actor, result, config));
  }

  static on(){
    return limits.mode() !== "off";
  }

  /* World time this creature's last Long Rest started, or null */
  static last(actor){
    const at = Number(actor?.getFlag(module.id, "lastLongRest"));
    return Number.isFinite(at) ? at : null;
  }

  /* Seconds before it may start another Long Rest (0 : now) : the rest of the day its last one started on */
  static wait(actor, now = game.time.worldTime){
    const last = this.last(actor);
    if((last == null) || (now < last)) return 0;
    const calendar = game.time.calendar;
    const day = t => { const c = calendar.timeToComponents(t); return [c.year, c.day]; };
    const [y1, d1] = day(last), [y2, d2] = day(now);
    if((y1 !== y2) || (d1 !== d2)) return 0;
    const { secondsPerMinute : s = 60, minutesPerHour : m = 60, hoursPerDay : h = 24 } = calendar.days ?? {};
    const c = calendar.timeToComponents(now);
    return (h * m * s) - (((c.hour * m) + c.minute) * s + c.second);
  }

  /* Why it can't start a Long Rest at that world time (default now), or null */
  static tooSoon(actor, at = game.time.worldTime){
    const wait = this.wait(actor, at);
    if(!wait) return null;
    return module.format("restLimit.tooSoon", { name : actor.name, hours : Math.floor(wait / 3600), minutes : Math.ceil((wait % 3600) / 60) });
  }

  static check(actor, config){
    if(!this.on() || (actor?.type === "group") || !actor?.system?.isCreature || config?.[module.id]?.restChecked) return;
    const rule = this.tooSoon(actor);
    if(rule && !limits.allow(rule, { who : actor.name, what : game.i18n.localize("DND5E.REST.Long.Label") })) return false;
  }

  /* After the group's window : its members ticked, together (their own rests then skip the check) */
  static checkGroup(group, config){
    if(!this.on() || (group?.type !== "group")) return;
    const members = group.system.members.map(m => m.actor).filter(a => a?.system?.isCreature && (!config.targets || config.targets.includes(a.id)));
    const rules = members.map(a => this.tooSoon(a)).filter(r => r);
    config[module.id] = { ...config[module.id], restChecked : true };
    if(rules.length && !limits.allow(rules.join(" "), { who : group.name, what : game.i18n.localize("DND5E.REST.Long.Label") })) return false;
  }

  /* When it started : given (a camp), dnd5e moved the clock past the rest (its own sheet, by the GM) or not yet (a
     group's rest moves it after its members') */
  static keep(actor, result, config){
    if(!this.on() || !result?.longRest || (actor?.type === "group") || !actor?.isOwner) return;
    const moved = config?.advanceTime && (config.duration > 0) && game.user.isGM;
    actor.setFlag(module.id, "lastLongRest", config?.[module.id]?.restStart ?? (game.time.worldTime - (moved ? 60 * config.duration : 0)));
  }
}
