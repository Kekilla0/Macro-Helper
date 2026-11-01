import { module } from '../module.js';
import { limits } from './limits.js';

/**
 * One Long Rest a day (Rule Limits) : a creature's Long Rest may start 24 hours of world time after its last one
 * started, not sooner (the group's choice over RAW's "16 hours after it ends" : the same for an 8-hour rest). Each Long
 * Rest's start is kept on the creature (flag lastLongRest, world time in seconds) : its own sheet, the group's rest, a
 * rest request card. Time put back before it (an Undo) doesn't count against it. A group's rest is checked once, for
 * the members ticked in its window (one notice; Block : nobody rests and the clock stays).
 */
export class restLimit{
  static DAY = 24 * 60 * 60;

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

  /* Seconds before it may start another Long Rest (0 : now) */
  static wait(actor, now = game.time.worldTime){
    const last = this.last(actor);
    if((last == null) || (now < last)) return 0;
    return Math.max(0, this.DAY - (now - last));
  }

  static tooSoon(actor){
    const wait = this.wait(actor);
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
