import { module } from '../module.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { limits } from './limits.js';
import { rollRequests } from '../requests/requests.js';
import { restMinutesOf } from './rest-length.js';
import { restLimit } from './rest-limit.js';
import { groupTravel } from './group-travel.js';
import { groupInventory } from './group-inventory.js';
const log = logger.for(import.meta.url);

/**
 * Group Travel : Camp (the group sheet's Camp button, the GM or the Leader's player runs it; everyone in the group sees
 * it and sets their own creatures' rows).
 *   Plan : each member Rests or not, a Task for the setup hours (Forage : 2024 DMG, Wisdom (Survival) against the
 *   terrain's Foraging DC; homebrew tasks through campTask), stands Watch or not, Eats and Drinks or not. The setup hours
 *   come first, then the night : as long as the longest rest among the members resting (2024 Elf Trance : 4 h), longer
 *   when the watchers can't cover every hour (a Long Rest allows 2 hours of light activity, standing watch among them;
 *   hours past one's own rest are free), or what the GM typed. The rota hands the hours out in the members' order.
 *   Running : Next hour / To the end move the clock; sleepers are Unconscious (2024 PHB : during sleep), taken off when
 *   they wake (watch, the end). The night's first hour : the foraging card's successes find 1d6 + WIS mod lb of food and
 *   as many gallons of water (2024 DMG Foraging), then the meal : each member's daily food and water by size (2024 PHB
 *   Malnutrition / Dehydration) from what was found, then their own Rations (1 lb of food each) and waterskins (water
 *   kept on each, a full one 1/2 gallon), then the pack animals' and vehicles'. What's left of the water fills the
 *   waterskins. Each member's meal is kept on it (flag fed) for the day's-end rules to come.
 *   Interruptions (2024 PHB Long Rest) : rolling Initiative pauses the camp (Resume goes on); Initiative, damage or a
 *   spell other than a cantrip adds an hour to that member's rest. Moving the Group's token is refused while camping.
 *   The end : dnd5e's Long Rest for each member whose rest is done (one a day : rest-limit.js, checked when the camp is
 *   made), a Short Rest for one who rested an hour or more of it (Break camp), a log card.
 *
 *   campTask(id, { label, icon, applies(actor), start({ group, actors, camp }), collect({ group, actors, data, camp }),
 *     finish({ group, actors, data, camp, rested }) })
 *       a homebrew task for the setup hours : start when the camp is made (its return is kept as data), collect when the
 *       night starts (return { food, water, lines } : added to what's shared), finish after the rests.
 */
const tasks = new Map();

export function campTask(id, { label, icon = "fa-solid fa-person-digging", applies = null, start = null, collect = null, finish = null } = {}){
  if(!id || (id === "none")) return;
  tasks.set(id, { id, label : label ?? id, icon, applies, start, collect, finish });
}

export class groupCamp{
  /* 2024 DMG Travel Terrain : Foraging DC */
  static TERRAIN = { arctic : 20, coastal : 10, desert : 20, forest : 10, grassland : 15, hill : 15, mountain : 20, swamp : 10, underdark : 20, urban : 20, waterborne : 15 };
  /* 2024 PHB Food / Water Needs per Day (pounds / gallons) */
  static NEEDS = { tiny : 0.25, sm : 1, med : 1, lg : 4, huge : 16, grg : 64 };
  static WATERSKIN = 0.5;
  static #windows = new Map();

  static register(){
    if(game.system.id !== "dnd5e") return;
    campTask("forage", { label : "groupTravel.camp.task.forage", icon : "fa-solid fa-seedling",
      start : data => this.forageStart(data), collect : data => this.forageCollect(data) });
    Hooks.on("renderActorSheetV2", (app, html) => this.renderHeader(app, html));
    Hooks.on("updateActor", (actor, changes) => this.changed(actor, changes));
    Hooks.on("updateWorldTime", () => this.redraw());
    Hooks.on("preMoveToken", token => this.preMove(token));
    /* Interruptions, from the client they happen on */
    Hooks.on("dnd5e.rollInitiative", actor => this.interrupt(actor, "initiative"));
    Hooks.on("dnd5e.postUseActivity", activity => ((activity?.item?.type === "spell") && (Number(activity.item.system.level) > 0)) && this.interrupt(activity.actor, "spell"));
    Hooks.on("preUpdateActor", (actor, changes, options) => this.hurt(actor, changes, options));
    gm.handle("groupCamp", (data, user) => this.asGM(data, user));
  }

  static enabled(){
    return groupTravel.enabled();
  }

  static i18n(key, data){
    return data ? game.i18n.format(`groupTravel.camp.${key}`, data) : game.i18n.localize(`groupTravel.camp.${key}`);
  }

  static esc(text){
    return foundry.utils.escapeHTML(String(text ?? ""));
  }

  /* ---------- The camp's data : flags.macro-helper.camp { plan, rows, run } ---------- */

  static campOf(group){
    const camp = groupTravel.flag(group, "camp") ?? {};
    return { plan : { setup : 1, terrain : "forest", watch : true, night : null, ...(camp.plan ?? {}) }, rows : camp.rows ?? {}, run : camp.run ?? null };
  }

  static running(group){
    return !!groupTravel.flag(group, "camp")?.run;
  }

  /* The creatures in the group's order */
  static members(group){
    const order = groupTravel.flag(group, "order") ?? [];
    const rank = a => { const i = order.indexOf(a.id); return (i < 0) ? order.length : i; };
    return groupTravel.creatures(group).map((a, i) => ({ a, i })).sort((x, y) => (rank(x.a) - rank(y.a)) || (x.i - y.i)).map(x => x.a);
  }

  /* A member's row : rests, task, watch (the players' creatures by default), eats, drinks */
  static rowOf(camp, actor){
    return { rest : true, task : "none", watch : !!actor.hasPlayerOwner, eat : true, drink : true, ...(camp.rows[actor.id] ?? {}) };
  }

  static canRun(group, user = game.user){
    return groupTravel.canOrder(group, user);
  }

  static canEdit(group, actor, user = game.user){
    return this.canRun(group, user) || !!actor?.testUserPermission(user, "OWNER");
  }

  /* ---------- The rota ---------- */

  /**
   * Hour by hour : { setup, night, total, rows : [{ actor, row, hours (rest), short (a shortened rest : Trance), cells,
   * restEnd, sleep, watch, full }] }. Cells : "task:<id>", "awake", "watch", "sleep", "trance", "out" (not resting, not
   * watching).
   */
  static schedule(group, camp = this.campOf(group)){
    const setup = Math.max(0, Math.round(Number(camp.plan.setup) || 0));
    const rows = this.members(group).map(actor => {
      const row = this.rowOf(camp, actor);
      const { minutes, source } = restMinutesOf(actor, "long");
      const hours = Math.max(1, Math.ceil(minutes / 60));
      return { actor, row, hours, short : !!source, source, allowance : Math.min(2, Math.max(0, hours - 6)) };
    });
    const resting = rows.filter(r => r.row.rest);
    const watchers = camp.plan.watch ? rows.filter(r => r.row.watch) : [];
    const cap = (r, n) => r.row.rest ? Math.min(n, r.allowance + n - r.hours) : n;
    let night = resting.length ? Math.max(...resting.map(r => r.hours)) : 0;
    if(watchers.length) while((watchers.reduce((s, r) => s + Math.max(0, cap(r, night)), 0) < night) && (night < 48)) night++;
    night = Math.max(night, Math.round(Number(camp.plan.night) || 0));
    /* Each watcher's share, round and round, then one block each in order */
    const share = new Map(watchers.map(r => [r, 0]));
    for(let left = watchers.length ? night : 0, moved = true; left && moved;){
      moved = false;
      for(const r of watchers) if(left && (share.get(r) < cap(r, night))){ share.set(r, share.get(r) + 1); left--; moved = true; }
    }
    const watchOf = new Map();
    let at = 0;
    for(const r of watchers){ watchOf.set(r, new Set(Array.from({ length : share.get(r) }, (_, i) => at + i))); at += share.get(r); }
    const interrupts = camp.run?.interrupts ?? {};
    for(const r of rows){
      const mine = watchOf.get(r) ?? new Set();
      const cells = Array.from({ length : setup }, () => (r.row.task !== "none") ? `task:${r.row.task}` : "awake");
      let rested = 0;
      for(let h = 0; h < night; h++){
        if(mine.has(h)) cells.push("watch");
        else if(!r.row.rest) cells.push("out");
        else if(r.short && (rested >= r.hours)) cells.push("awake");
        else { cells.push(r.short ? "trance" : "sleep"); rested++; }
      }
      const restCells = c => (c === "sleep") || (c === "trance");
      /* Its rest ends once it has had its hours : rest, and watch within its 2 hours of light activity */
      const endOf = () => {
        let had = 0, light = 0;
        for(let h = setup; h < cells.length; h++){
          if(restCells(cells[h])) had++;
          else if((cells[h] === "watch") && (light < r.allowance)) { had++; light++; }
          if(had >= r.hours) return { end : h + 1, full : true };
        }
        return { end : cells.findLastIndex(restCells) + 1, full : false };
      };
      let { end, full } = r.row.rest ? endOf() : { end : 0, full : true };
      /* An interruption : an hour more of rest after it (RAW : resuming adds 1 hour each) */
      const extra = r.row.rest ? (Number(interrupts[r.actor.id]) || 0) : 0;
      if(extra) { cells.splice(end, 0, ...Array(extra).fill(r.short ? "trance" : "sleep")); end += extra; }
      Object.assign(r, { cells, restEnd : end, sleep : cells.filter(restCells).length, watch : mine.size, full });
    }
    const total = Math.max(setup + night, ...rows.map(r => r.restEnd), ...rows.map(r => r.cells.length));
    for(const r of rows) while(r.cells.length < total) r.cells.push(r.row.rest ? "awake" : "out");
    return { setup, night, total, rows };
  }

  /* What the members need and what they carry : { food : { need, rations }, water : { need, skins } } */
  static supplies(group, camp = this.campOf(group)){
    const rows = this.members(group).map(a => ({ a, row : this.rowOf(camp, a) }));
    const holders = [...new Set([...rows.map(r => r.a), ...groupInventory.packs(group)])];
    const need = key => rows.filter(r => r.row[key]).reduce((s, r) => s + this.need(r.a), 0);
    return {
      food : { need : need("eat"), rations : holders.reduce((s, a) => s + this.rations(a).reduce((n, i) => n + (Number(i.system.quantity) || 0), 0), 0) },
      water : { need : need("drink"), skins : holders.reduce((s, a) => s + this.skins(a).reduce((n, i) => n + this.waterIn(i), 0), 0) }
    };
  }

  static need(actor){
    return this.NEEDS[actor.system.traits?.size] ?? 1;
  }

  static rations(actor){
    return actor.items.filter(i => (i.system.identifier === "rations") && ((Number(i.system.quantity) || 0) > 0));
  }

  static skins(actor){
    return actor.items.filter(i => i.system.identifier === "waterskin");
  }

  /* Gallons in a waterskin (one never tracked is full) */
  static waterIn(item){
    const water = item.getFlag(module.id, "water");
    return Math.max(0, (water == null) ? this.WATERSKIN * (Number(item.system.quantity) || 1) : Number(water) || 0);
  }

  /* ---------- On the GM's client ---------- */

  static async asGM({ group, op, ...data }, user){
    group = await fromUuid(group);
    if((group?.type !== "group") || !this.enabled()) return false;
    const camp = this.campOf(group);
    try {
      switch(op){
        case "row" : {
          const actor = groupTravel.memberActor(group, data.id);
          if(!actor || camp.run || !this.canEdit(group, actor, user)) return false;
          const clean = {};
          for(const key of ["rest", "watch", "eat", "drink"]) if(key in (data.changes ?? {})) clean[key] = !!data.changes[key];
          if("task" in (data.changes ?? {})) clean.task = ((data.changes.task === "none") || tasks.has(data.changes.task)) ? data.changes.task : "none";
          await group.update({ [`flags.${module.id}.camp.rows.${actor.id}`] : clean });
          return true;
        }
        case "plan" : {
          if(camp.run || !this.canRun(group, user)) return false;
          const c = data.changes ?? {}, clean = {};
          if("setup" in c) clean.setup = Math.min(24, Math.max(0, Math.round(Number(c.setup) || 0)));
          if(("terrain" in c) && (c.terrain in this.TERRAIN)) clean.terrain = c.terrain;
          if("watch" in c) clean.watch = !!c.watch;
          if("night" in c) clean.night = (Number(c.night) > 0) ? Math.min(48, Math.round(Number(c.night))) : null;
          await group.update({ [`flags.${module.id}.camp.plan`] : clean });
          return true;
        }
        case "make" : return (!camp.run && this.canRun(group, user)) ? this.make(group, camp) : false;
        case "step" : return (camp.run && !camp.run.paused && this.canRun(group, user)) ? this.step(group, 1) : false;
        case "finish" : return (camp.run && !camp.run.paused && this.canRun(group, user)) ? this.step(group, Infinity) : false;
        case "break" : return (camp.run && this.canRun(group, user)) ? this.end(group, false) : false;
        case "resume" : return (camp.run?.paused && this.canRun(group, user)) ? group.update({ [`flags.${module.id}.camp.run.paused`] : false }) : false;
        case "interrupt" : {
          const actor = groupTravel.memberActor(group, data.id);
          if(!camp.run || !actor || !(user.isGM || actor.testUserPermission(user, "OWNER"))) return false;
          return this.interruptAsGM(group, actor, data.why);
        }
      }
    } catch(err) { log.error("Camp :", err); }
    return false;
  }

  /* The camp made : rest limits, the tasks start, the first hour's sleepers */
  static async make(group, camp){
    const plan = this.schedule(group, camp);
    const resting = plan.rows.filter(r => r.row.rest).map(r => r.actor);
    const problems = [...resting.filter(a => !(Number(a.system.attributes?.hp?.value) > 0)).map(a => this.i18n("noHP", { name : a.name })),
      ...(restLimit.on() ? resting.map(a => restLimit.tooSoon(a)).filter(t => t) : [])];
    if(problems.length && !limits.allow(problems.join(" "), { who : group.name, what : this.i18n("title") })) return false;
    const run = { start : game.time.worldTime, hour : 0, paused : false, interrupts : {}, applied : [], prone : [], pool : { food : 0, water : 0 }, data : {}, fed : false };
    await group.update({ [`flags.${module.id}.camp.run`] : run });
    for(const [id, task] of tasks){
      const actors = plan.rows.filter(r => r.row.task === id).map(r => r.actor);
      if(!actors.length || !task.start) continue;
      try { run.data[id] = (await task.start({ group, actors, camp : this.campOf(group) })) ?? null; } catch(err) { log.error(`Camp task ${id} :`, err); }
    }
    await group.update({ [`flags.${module.id}.camp.run.data`] : run.data });
    await this.postLog(group, "made", { lines : this.rotaLines(group) });
    if(!plan.setup) await this.nightStarts(group);
    await this.statuses(group);
    return true;
  }

  /* An hour (or all that's left) of the camp; the night's first hour brings the meal; the last ends it */
  static async step(group, hours){
    for(let n = 0; n < hours; n++){
      const camp = this.campOf(group);
      if(!camp.run || camp.run.paused) return true;
      const plan = this.schedule(group, camp);
      if(camp.run.hour >= plan.total) return this.end(group, true);
      await game.time.advance(groupTravel.secondsPerHour());
      const hour = camp.run.hour + 1;
      await group.update({ [`flags.${module.id}.camp.run.hour`] : hour });
      if((hour === plan.setup) && !camp.run.fed) await this.nightStarts(group);
      if(hour >= this.schedule(group).total) return this.end(group, true);
      await this.statuses(group);
    }
    return true;
  }

  /* Each sleeper Unconscious for this hour, each one awake not (only the ones the camp made so) */
  static async statuses(group, wake = false){
    const camp = this.campOf(group);
    if(!camp.run) return;
    const plan = this.schedule(group, camp);
    const applied = new Set(camp.run.applied), prone = new Set(camp.run.prone);
    for(const r of plan.rows){
      const asleep = !wake && (r.cells[camp.run.hour] === "sleep");
      const actor = r.actor;
      if(asleep && !actor.statuses.has("unconscious")){
        if(!actor.statuses.has("prone")) prone.add(actor.id);
        await actor.toggleStatusEffect("unconscious", { active : true });
        applied.add(actor.id);
      }
      else if(!asleep && applied.has(actor.id)){
        if(actor.statuses.has("unconscious")) await actor.toggleStatusEffect("unconscious", { active : false });
        if(prone.has(actor.id) && actor.statuses.has("prone")) await actor.toggleStatusEffect("prone", { active : false });
        applied.delete(actor.id); prone.delete(actor.id);
      }
    }
    await group.update({ [`flags.${module.id}.camp.run.applied`] : [...applied], [`flags.${module.id}.camp.run.prone`] : [...prone] });
  }

  /* The night starts : the tasks' finds, then the meal */
  static async nightStarts(group){
    const camp = this.campOf(group);
    const plan = this.schedule(group, camp);
    const pool = { food : 0, water : 0 };
    const lines = [];
    for(const [id, task] of tasks){
      const actors = plan.rows.filter(r => r.row.task === id).map(r => r.actor);
      if(!actors.length || !task.collect) continue;
      try {
        const found = (await task.collect({ group, actors, data : camp.run.data?.[id] ?? null, camp })) ?? {};
        pool.food += Number(found.food) || 0;
        pool.water += Number(found.water) || 0;
        lines.push(...(found.lines ?? []));
      } catch(err) { log.error(`Camp task ${id} :`, err); }
    }
    lines.push(...(await this.meal(group, camp, plan, pool)));
    await group.update({ [`flags.${module.id}.camp.run.fed`] : true, [`flags.${module.id}.camp.run.pool`] : pool });
    await this.postLog(group, "meal", { lines });
  }

  /* Each member's daily food and water : what was found, their own, then the packs' and vehicles' */
  static async meal(group, camp, plan, pool){
    const lines = [];
    const shared = groupInventory.packs(group);
    const round = n => Math.round(n * 100) / 100;
    for(const { actor, row } of plan.rows){
      const need = this.need(actor);
      let food = 0, water = 0;
      if(row.eat){
        const found = Math.min(pool.food, need);
        pool.food -= found; food += found;
        for(const holder of [actor, ...shared.filter(a => a !== actor)]){
          for(const item of this.rations(holder)){
            if(food >= need) break;
            const take = Math.min(Number(item.system.quantity) || 0, Math.ceil(need - food - 1e-9));
            if(take <= 0) continue;
            const left = (Number(item.system.quantity) || 0) - take;
            if(left > 0) await item.update({ "system.quantity" : left }); else await item.delete();
            food = Math.min(need, food + take);
          }
        }
      }
      if(row.drink){
        const found = Math.min(pool.water, need);
        pool.water -= found; water += found;
        for(const holder of [actor, ...shared.filter(a => a !== actor)]){
          for(const item of this.skins(holder)){
            if(water >= need) break;
            const has = this.waterIn(item);
            const take = Math.min(has, need - water);
            if(take <= 0) continue;
            await item.setFlag(module.id, "water", round(has - take));
            water += take;
          }
        }
      }
      await actor.setFlag(module.id, "fed", { at : game.time.worldTime, food : round(food), needFood : need, water : round(water), needWater : need });
      const short = (got, key) => (got < need / 2) ? "over" : "";
      lines.push(`${this.esc(actor.name)} : <span class="${row.eat ? short(food) : ""}">${this.i18n("ate", { got : round(food), need })}</span>, `
        + `<span class="${row.drink ? short(water) : ""}">${this.i18n("drank", { got : round(water), need })}</span>`);
    }
    /* What's left of the water fills the waterskins */
    for(const holder of [...plan.rows.map(r => r.actor), ...shared]){
      for(const item of this.skins(holder)){
        if(pool.water <= 0) break;
        const room = this.WATERSKIN * (Number(item.system.quantity) || 1) - this.waterIn(item);
        if(room <= 0) continue;
        const fill = Math.min(room, pool.water);
        await item.setFlag(module.id, "water", round(this.waterIn(item) + fill));
        pool.water -= fill;
      }
    }
    return lines;
  }

  /* The camp ends : sleepers wake, the rests, the tasks' finish, the log */
  static async end(group, done){
    const camp = this.campOf(group);
    if(!camp.run) return false;
    const plan = this.schedule(group, camp);
    await this.statuses(group, true);
    const hour = Math.min(camp.run.hour, plan.total);
    const restStart = camp.run.start + plan.setup * groupTravel.secondsPerHour();
    const rested = { long : [], short : [], none : [] };
    for(const r of plan.rows.filter(r => r.row.rest)){
      const hadRest = r.cells.slice(0, hour).filter(c => (c === "sleep") || (c === "trance")).length;
      const kind = (done || (hour >= r.restEnd)) && r.full ? "long" : (hadRest >= 1) ? "short" : "none";
      rested[kind].push(r.actor);
    }
    await group.unsetFlag(module.id, "camp.run");
    for(const actor of rested.long){
      try { await actor.longRest({ dialog : false, advanceTime : false, advanceBastionTurn : false, [module.id] : { restChecked : true, restStart } }); }
      catch(err) { log.error("Camp Long Rest :", err); }
    }
    for(const actor of rested.short){
      try { await actor.shortRest({ dialog : false, advanceTime : false }); } catch(err) { log.error("Camp Short Rest :", err); }
    }
    for(const [id, task] of tasks){
      const actors = plan.rows.filter(r => r.row.task === id).map(r => r.actor);
      if(!actors.length || !task.finish) continue;
      try { await task.finish({ group, actors, data : camp.run.data?.[id] ?? null, camp, rested }); } catch(err) { log.error(`Camp task ${id} :`, err); }
    }
    const names = list => list.map(a => this.esc(a.name)).join(", ") || "—";
    await this.postLog(group, done ? "done" : "broken", { start : camp.run.start, lines : [
      this.i18n("restedLong", { names : names(rested.long) }), ...(rested.short.length ? [this.i18n("restedShort", { names : names(rested.short) })] : []),
      ...(rested.none.length ? [this.i18n("restedNone", { names : names(rested.none) })] : [])] });
    Hooks.callAll(`${module.id}.campEnded`, group, { done, rested, plan });
    return true;
  }

  static async interruptAsGM(group, actor, why){
    const camp = this.campOf(group);
    const plan = this.schedule(group, camp);
    const r = plan.rows.find(r => r.actor === actor);
    const hour = camp.run.hour;
    const updates = {};
    /* Only during its rest (from the night's start to its rest's end) */
    if(r?.row.rest && (hour >= plan.setup) && (hour < r.restEnd)) updates[`flags.${module.id}.camp.run.interrupts.${actor.id}`] = (Number(camp.run.interrupts?.[actor.id]) || 0) + 1;
    if(why === "initiative") updates[`flags.${module.id}.camp.run.paused`] = true;
    if(foundry.utils.isEmpty(updates)) return false;
    await group.update(updates);
    const awake = plan.rows.filter(row => !["sleep"].includes(row.cells[hour])).map(row => row.actor.name);
    const asleep = plan.rows.filter(row => row.cells[hour] === "sleep").map(row => row.actor.name);
    await this.postLog(group, "interrupted", { lines : [this.i18n(`why.${why}`, { name : this.esc(actor.name) }),
      this.i18n("awakeNow", { names : this.esc(awake.join(", ") || "—") }), this.i18n("asleepNow", { names : this.esc(asleep.join(", ") || "—") })] });
    return true;
  }

  /* ---------- Interruptions, on the client they happen ---------- */

  static campsOf(actor){
    if(!actor || !this.enabled()) return [];
    return groupTravel.groupsOf(actor).filter(g => this.running(g));
  }

  static interrupt(actor, why){
    for(const group of this.campsOf(actor)) gm.run("groupCamp", { group : group.uuid, op : "interrupt", id : actor.id, why });
  }

  /* Damage : its HP (or temporary HP) going down */
  static hurt(actor, changes){
    if(!this.campsOf(actor).length) return;
    const hp = changes?.system?.attributes?.hp;
    if(!hp) return;
    const now = actor.system.attributes?.hp ?? {};
    const lower = (key) => (key in hp) && (Number(hp[key]) < (Number(now[key]) || 0));
    if(lower("value") || lower("temp")) this.interrupt(actor, "damage");
  }

  /* Exertion : the group doesn't travel while camping */
  static preMove(token){
    if((token?.actor?.type !== "group") || !this.running(token.actor)) return;
    ui.notifications.warn(this.i18n("moving", { name : token.actor.name }));
    return false;
  }

  /* ---------- The log card ---------- */

  static rotaLines(group){
    const camp = this.campOf(group);
    const plan = this.schedule(group, camp);
    const at = h => groupTravel.formatted(camp.run.start + h * groupTravel.secondsPerHour()).time;
    const lines = [this.i18n("length", { setup : plan.setup, night : plan.night, from : at(0), to : at(plan.total) })];
    for(const r of plan.rows){
      const watch = r.cells.map((c, h) => (c === "watch") ? h : null).filter(h => h !== null);
      if(watch.length) lines.push(this.i18n("watchLine", { name : this.esc(r.actor.name), from : at(watch[0]), to : at(watch.at(-1) + 1) }));
    }
    return lines;
  }

  static postLog(group, kind, { lines = [], start = null } = {}){
    const content = `<div class="macro-helper-group-log macro-helper-camp-log">
      <p><strong><i class="fa-solid fa-campground" inert></i> ${this.i18n(`log.${kind}`)}</strong></p>
      ${lines.map(l => `<p>${l}</p>`).join("")}</div>`;
    return ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor : group }), content });
  }

  /* ---------- Foraging (2024 DMG) ---------- */

  static async forageStart({ group, actors }){
    const { plan } = this.campOf(group);
    const dc = this.TERRAIN[plan.terrain] ?? 15;
    const card = await rollRequests.request({ who : actors.map(a => ({ actor : a.uuid, name : a.name, img : a.img })), what : "skill:sur", dc, hideDC : false, speaker : group,
      label : this.i18n("forageCard", { skill : rollRequests.labelOf("skill", "sur"), terrain : this.i18n(`terrain.${plan.terrain}`) }) });
    return { message : card?.id ?? null };
  }

  static async forageCollect({ actors, data }){
    const message = game.messages.get(data?.message);
    const request = message?.getFlag(module.id, "request");
    let food = 0, water = 0;
    const lines = [];
    for(const actor of actors){
      const row = request?.rows.find(r => (r.actor === actor.uuid));
      const result = row ? request.results?.[1]?.[row.key] : null;
      if(!result) { lines.push(this.i18n("forageNone", { name : this.esc(actor.name) })); continue; }
      if(!result.success) { lines.push(this.i18n("forageFail", { name : this.esc(actor.name) })); continue; }
      const roll = async () => (await new Roll("1d6 + @abilities.wis.mod", actor.getRollData()).evaluate()).total;
      const f = Math.max(0, await roll()), w = Math.max(0, await roll());
      food += f; water += w;
      lines.push(this.i18n("forageFound", { name : this.esc(actor.name), food : f, water : w }));
    }
    return { food, water, lines };
  }

  /* ---------- The sheet : the Camp button, the Journey card's camp line ---------- */

  static renderHeader(app, html){
    const group = app.document;
    if((group?.type !== "group") || !this.enabled()) return;
    const header = (html ?? app.element)?.querySelector?.(".sheet-header");
    if(!header) return;
    try {
      const buttons = header.querySelector(".sheet-header-buttons");
      if(buttons && !buttons.querySelector(".macro-helper-camp")){
        const button = groupTravel.button({ action : "camp", icon : "fa-solid fa-campground", label : "groupTravel.camp.title", gmOnly : false });
        button.disabled = !groupInventory.inGroup(group);
        button.addEventListener("click", () => this.open(group));
        buttons.append(button);
      }
      const info = header.querySelector(".macro-helper-journey .info");
      const camp = this.campOf(group);
      if(info && camp.run && !info.querySelector(".camp")){
        const plan = this.schedule(group, camp);
        const awake = plan.rows.filter(r => !["sleep"].includes(r.cells[camp.run.hour])).map(r => r.actor.name);
        const line = document.createElement("div");
        line.className = `camp ${camp.run.paused ? "paused" : ""}`;
        line.innerHTML = `<i class="fa-solid fa-campground" inert></i> ${this.i18n("journey", { hour : Math.min(camp.run.hour + 1, plan.total), total : plan.total })}
          ${camp.run.paused ? `<span class="over">${this.i18n("paused")}</span>` : ""}
          <span class="awake" data-tooltip="${this.esc(this.i18n("awakeNow", { names : awake.join(", ") || "—" }))}"><i class="fa-solid fa-eye" inert></i> ${this.esc(awake.join(", ") || "—")}</span>`;
        line.addEventListener("click", () => this.open(group));
        info.append(line);
      }
    } catch(err) { log.error("Camp header :", err); }
  }

  static changed(actor, changes){
    if(actor.type !== "group") return;
    if(foundry.utils.hasProperty(changes, `flags.${module.id}.camp`) || foundry.utils.hasProperty(changes, `flags.${module.id}.-=camp`)
      || foundry.utils.hasProperty(changes, `flags.${module.id}.order`) || ("system" in (changes ?? {}))) this.redraw(actor);
  }

  static redraw(group = null){
    for(const [uuid, app] of this.#windows){
      if(!app.rendered) { this.#windows.delete(uuid); continue; }
      if(!group || (group.uuid === uuid)) app.render();
    }
  }

  /* ---------- The window ---------- */

  static #App = null;

  static open(group){
    if(!this.enabled() || !groupInventory.inGroup(group)) return;
    const self = this;
    this.#App ??= class CampWindow extends foundry.applications.api.ApplicationV2{
      static DEFAULT_OPTIONS = { classes : ["macro-helper-camp"], window : { icon : "fa-solid fa-campground", resizable : true }, position : { width : 860, height : "auto" } };
      get title(){ return `${this.options.group.name} : ${self.i18n("title")}`; }
      async _renderHTML(){ return self.html(this.options.group); }
      _replaceHTML(result, content){ content.innerHTML = result; self.listen(this.options.group, content); }
    };
    let app = this.#windows.get(group.uuid);
    if(!app?.rendered){ app = new this.#App({ group, id : `macro-helper-camp-${group.id}` }); this.#windows.set(group.uuid, app); }
    app.render({ force : true });
  }

  static CELLS = { awake : "fa-person", watch : "fa-eye", sleep : "fa-bed", trance : "fa-spa", out : "" };

  static html(group){
    const camp = this.campOf(group);
    const plan = this.schedule(group, camp);
    const run = camp.run;
    const planner = this.canRun(group) && !run;
    const start = run?.start ?? game.time.worldTime;
    const at = h => groupTravel.formatted(start + h * groupTravel.secondsPerHour()).time;
    const e = t => this.esc(t);
    const taskOptions = (now, actor) => [["none", this.i18n("task.none")], ...[...tasks.values()].filter(t => !t.applies || t.applies(actor)).map(t => [t.id, game.i18n.localize(t.label)])]
      .map(([v, l]) => `<option value="${v}" ${(v === now) ? "selected" : ""}>${e(l)}</option>`).join("");
    const heads = Array.from({ length : plan.total }, (_, h) => `<th class="hour ${(h < plan.setup) ? "setup" : ""} ${(run && (h === run.hour)) ? "now" : ""}">${e(at(h))}</th>`).join("");
    const rows = plan.rows.map(r => {
      const edit = !run && this.canEdit(group, r.actor);
      const box = key => `<input type="checkbox" data-key="${key}" ${r.row[key] ? "checked" : ""} ${edit ? "" : "disabled"}>`;
      const cells = r.cells.map((c, h) => {
        const task = c.startsWith("task:") ? tasks.get(c.slice(5)) : null;
        const icon = task ? task.icon : `fa-solid ${this.CELLS[c] ?? ""}`;
        const tip = task ? game.i18n.localize(task.label) : this.i18n(`cell.${c}`);
        return `<td class="cell ${task ? "task" : c} ${(h < plan.setup) ? "setup" : ""} ${(run && (h === run.hour)) ? "now" : ""}" data-tooltip="${e(tip)}">${icon.trim() ? `<i class="${icon}" inert></i>` : ""}</td>`;
      }).join("");
      const summary = r.row.rest ? (r.short ? this.i18n("sumShort", { rest : r.sleep, watch : r.watch, source : r.source?.name ?? "" }) : this.i18n("sum", { sleep : r.sleep, watch : r.watch }))
        : this.i18n("sumOut", { watch : r.watch });
      return `<tr data-id="${r.actor.id}">
        <td class="who"><img src="${e(r.actor.img)}" alt=""><span>${e(r.actor.name)}</span></td>
        <td>${box("rest")}</td><td><select data-key="task" ${edit ? "" : "disabled"}>${taskOptions(r.row.task, r.actor)}</select></td>
        <td>${box("watch")}</td><td>${box("eat")}</td><td>${box("drink")}</td>
        ${cells}
        <td class="sum ${r.full ? "" : "over"}" data-tooltip="${e(this.i18n(r.full ? "full" : "notFull"))}">${e(summary)} <i class="fa-solid ${r.full ? "fa-check" : "fa-triangle-exclamation"}" inert></i></td></tr>`;
    }).join("");
    const terrain = Object.entries(this.TERRAIN).map(([k, dc]) => `<option value="${k}" ${(k === camp.plan.terrain) ? "selected" : ""}>${e(this.i18n(`terrain.${k}`))} (${this.i18n("dc", { dc })})</option>`).join("");
    const s = this.supplies(group, camp);
    const short = (have, need) => (have < need) ? "over" : "";
    const buttons = run ? [
      run.paused ? ["resume", "fa-play", "resume"] : ["step", "fa-forward-step", "step"],
      ...(run.paused ? [] : [["finish", "fa-forward-fast", "finish"]]), ["break", "fa-person-walking-arrow-right", "break"]]
      : [["make", "fa-campground", "make"]];
    const control = this.canRun(group);
    return `<div class="plan">
        <label>${this.i18n("setup")} <input type="number" name="setup" min="0" max="24" step="1" value="${plan.setup}" ${planner ? "" : "disabled"}></label>
        <label>${this.i18n("terrainLabel")} <select name="terrain" ${planner ? "" : "disabled"}>${terrain}</select></label>
        <label><input type="checkbox" name="watch" ${camp.plan.watch ? "checked" : ""} ${planner ? "" : "disabled"}> ${this.i18n("keepWatch")}</label>
        <label data-tooltip="${e(this.i18n("nightHint"))}">${this.i18n("night")} <input type="number" name="night" min="1" max="48" step="1" value="${plan.night}" ${planner ? "" : "disabled"}></label>
      </div>
      <div class="grid"><table>
        <thead><tr><th class="who"></th><th data-tooltip="${e(this.i18n("restHint"))}"><i class="fa-solid fa-bed" inert></i></th><th>${this.i18n("taskLabel")}</th>
          <th data-tooltip="${e(this.i18n("keepWatch"))}"><i class="fa-solid fa-eye" inert></i></th>
          <th data-tooltip="${e(this.i18n("eat"))}"><i class="fa-solid fa-drumstick-bite" inert></i></th>
          <th data-tooltip="${e(this.i18n("drink"))}"><i class="fa-solid fa-droplet" inert></i></th>${heads}<th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <p class="supplies">
        <span class="${short(s.food.rations, s.food.need)}"><i class="fa-solid fa-drumstick-bite" inert></i> ${this.i18n("foodLine", { need : s.food.need, have : s.food.rations })}</span>
        <span class="${short(s.water.skins, s.water.need)}"><i class="fa-solid fa-droplet" inert></i> ${this.i18n("waterLine", { need : s.water.need, have : Math.round(s.water.skins * 100) / 100 })}</span>
        <span>${this.i18n("length", { setup : plan.setup, night : plan.night, from : at(0), to : at(plan.total) })}</span>
        ${run?.paused ? `<span class="over">${this.i18n("paused")}</span>` : ""}
      </p>
      <footer class="form-footer">${buttons.map(([op, icon, label]) =>
        `<button type="button" data-op="${op}" ${control ? "" : "disabled"}><i class="fa-solid ${icon}" inert></i> ${this.i18n(`button.${label}`)}</button>`).join("")}</footer>`;
  }

  static listen(group, content){
    const send = data => gm.run("groupCamp", { group : group.uuid, ...data });
    for(const input of content.querySelectorAll("tr[data-id] [data-key]")){
      input.addEventListener("change", () => send({ op : "row", id : input.closest("tr").dataset.id,
        changes : { [input.dataset.key] : (input.type === "checkbox") ? input.checked : input.value } }));
    }
    for(const input of content.querySelectorAll(".plan [name]")){
      input.addEventListener("change", () => send({ op : "plan", changes : { [input.name] : (input.type === "checkbox") ? input.checked : input.value } }));
    }
    for(const button of content.querySelectorAll("footer [data-op]")){
      button.addEventListener("click", () => { button.disabled = true; send({ op : button.dataset.op }); });
    }
  }
}
