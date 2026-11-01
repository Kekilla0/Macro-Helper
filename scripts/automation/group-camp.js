import { module } from '../module.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { settings } from '../settings.js';
import { limits } from './limits.js';
import { rollRequests } from '../requests/requests.js';
import { restMinutesOf } from './rest-length.js';
import { restLimit } from './rest-limit.js';
import { groupTravel } from './group-travel.js';
import { groupInventory } from './group-inventory.js';
const log = logger.for(import.meta.url);

/**
 * Group Travel : Camp (the group sheet's Camp button; the GM or the Leader's player runs it, everyone in the group sees
 * it and sets their own creatures' rows).
 *   Where : the terrain (2024 DMG Foraging DC), water nearby (everyone drinks for free, every waterskin is filled), food
 *   nearby (everyone eats for free), grazing (Beasts eat for free), or an inn (2024 PHB Food, Drink, and Lodging : a
 *   night's stay and a meal by lifestyle, a Beast's stabling and feed, paid by the member picked on each row; food, water
 *   and shelter included, no watch, no tasks).
 *   Plan : each member Rests or not, a Task for the setting-up hours (Forage, RAW; homebrew : Hunt, Gather Water, each
 *   with its own DCs by terrain; more through campTask), stands Watch or not (not a Beast unless the GM ticks it), eats
 *   and drinks from : Automatic (free when nearby, what was found, then its own : a Beast's feed first, Rations; then
 *   the pack animals' and vehicles'), What's found, Own stores, Free (nearby), or Nothing.
 *   The rota : the rest lasts as long as the longest rest among the members resting (2024 Elf Trance : 4 h), longer
 *   when the watchers can't cover every hour (a Long Rest allows 2 hours of light activity, standing watch among them;
 *   hours past one's own rest are free), or what the GM typed. Hours are handed out in the members' order.
 *   Running : Next Hour / To the End move the clock; sleepers are Unconscious (2024 PHB : during sleep), taken off when
 *   they wake (watch, the end). The rest's first hour : the tasks' finds (a success : 1d6 + WIS mod lb of food and as
 *   many gallons of water, 2024 DMG Foraging), then the meal (each member's daily food and water by size, 2024 PHB
 *   Malnutrition / Dehydration). What's left of the water fills the waterskins. Each member's meal is kept on it (flag
 *   fed) for the day's-end rules to come.
 *   Interruptions (2024 PHB Long Rest) : Interrupt (the GM picks who; they wake) or rolling Initiative pauses the camp
 *   (Resume goes on, sleepers back to sleep); each, damage, or a spell other than a cantrip adds an hour to that member's
 *   rest. Moving the Group's token is refused while camping.
 *   The end : dnd5e's Long Rest for each member whose rest is done (one a day : rest-limit.js, checked when the camp is
 *   made); Break Camp : a Short Rest request card (each player's own rest window) for those who rested an hour or more.
 *
 *   campTask(id, { label, icon, homebrew, applies(actor), available({ group, plan }), start({ group, actors, camp }),
 *     collect({ group, actors, data, camp }), finish({ group, actors, data, camp, rested }) })
 *       a task for the setting-up hours : start when the camp is made (its return is kept as data), collect when the
 *       rest starts (return { food, water, lines } : added to what's found), finish after the rests.
 */
const tasks = new Map();

export function campTask(id, { label, icon = "fa-solid fa-person-digging", homebrew = false, applies = null, available = null, start = null, collect = null, finish = null } = {}){
  if(!id || (id === "none")) return;
  tasks.set(id, { id, label : label ?? id, icon, homebrew, applies, available, start, collect, finish });
}

export class groupCamp{
  /* 2024 DMG Travel Terrain : Foraging DC */
  static TERRAIN = { arctic : 20, coastal : 10, desert : 20, forest : 10, grassland : 15, hill : 15, mountain : 20, swamp : 10, underdark : 20, urban : 20, waterborne : 15 };
  /* Homebrew Camp Tasks : finding food (Hunt) and water (Gather Water) apart, by terrain */
  static HOMEBREW_DC = { arctic : [20, 10], coastal : [10, 15], desert : [20, 25], forest : [10, 10], grassland : [15, 15], hill : [15, 10],
    mountain : [20, 10], swamp : [10, 15], underdark : [20, 15], urban : [20, 10], waterborne : [15, 20] };
  /* 2024 PHB Food / Water Needs per Day (pounds / gallons) */
  static NEEDS = { tiny : 0.25, sm : 1, med : 1, lg : 4, huge : 16, grg : 64 };
  /* 2024 PHB Food, Drink, and Lodging (cp) : Inn Stay per Day, Meal; Mounts : Stabling and Feed per day */
  static LODGING = { squalid : [7, 1], poor : [10, 2], modest : [50, 10], comfortable : [80, 20], wealthy : [200, 30], aristocratic : [400, 60] };
  static STABLE = 5 + 5;
  static WATERSKIN = 0.5;
  static SOURCES = ["auto", "found", "own", "free", "none"];
  static #windows = new Map();

  static register(){
    if(game.system.id !== "dnd5e") return;
    const survey = (key, kind) => ({ start : data => this.surveyStart(key, kind, data), collect : data => this.surveyCollect(key, kind, data) });
    campTask("forage", { label : "groupTravel.camp.task.forage", icon : "fa-solid fa-seedling", available : ({ plan }) => !(plan.food && plan.water), ...survey("forage", "both") });
    campTask("hunt", { label : "groupTravel.camp.task.hunt", icon : "fa-solid fa-crosshairs", homebrew : true, available : ({ plan }) => !plan.food, ...survey("hunt", "food") });
    campTask("water", { label : "groupTravel.camp.task.water", icon : "fa-solid fa-bucket", homebrew : true, available : ({ plan }) => !plan.water, ...survey("water", "water") });
    Hooks.on("renderActorSheetV2", (app, html) => this.renderHeader(app, html));
    Hooks.on("updateActor", (actor, changes) => this.changed(actor, changes));
    Hooks.on("updateWorldTime", () => this.redraw());
    Hooks.on("updateSetting", setting => (setting.key === `${module.id}.homebrewCampTasks`) && this.redraw());
    Hooks.on("preMoveToken", token => this.preMove(token));
    /* Interruptions, from the client they happen on */
    Hooks.on("dnd5e.rollInitiative", actor => this.interrupt(actor, "initiative"));
    Hooks.on("dnd5e.postUseActivity", activity => ((activity?.item?.type === "spell") && (Number(activity.item.system.level) > 0)) && this.interrupt(activity.actor, "spell"));
    Hooks.on("preUpdateActor", (actor, changes) => this.hurt(actor, changes));
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
    return { plan : { setup : 1, terrain : "forest", watch : true, night : null, water : false, food : false, grazing : false, lodging : "none", ...(camp.plan ?? {}) },
      rows : camp.rows ?? {}, run : camp.run ?? null };
  }

  static running(group){
    return !!groupTravel.flag(group, "camp")?.run;
  }

  static atInn(plan){
    return (plan.lodging ?? "none") in this.LODGING;
  }

  /* The creatures in the group's order */
  static members(group){
    const order = groupTravel.flag(group, "order") ?? [];
    const rank = a => { const i = order.indexOf(a.id); return (i < 0) ? order.length : i; };
    return groupTravel.creatures(group).map((a, i) => ({ a, i })).sort((x, y) => (rank(x.a) - rank(y.a)) || (x.i - y.i)).map(x => x.a);
  }

  static isBeast(actor){
    return actor?.system?.details?.type?.value === "beast";
  }

  /* Who pays a member's night at the inn : itself (a player's creature), else the Leader's or the first player's */
  static defaultPayer(group, actor){
    if(actor.hasPlayerOwner && !this.isBeast(actor)) return actor;
    const players = this.members(group).filter(a => a.hasPlayerOwner && !this.isBeast(a));
    return players.find(a => groupTravel.memberOf(group, a).job === "leader") ?? players[0] ?? actor;
  }

  /* A member's row : rests, task, watch (the players' creatures, not Beasts), food / water sources, who pays */
  static rowOf(camp, actor, group = null){
    const saved = camp.rows[actor.id] ?? {};
    const row = { rest : true, task : "none", watch : !!actor.hasPlayerOwner && !this.isBeast(actor), food : "auto", water : "auto", payer : null, ...saved };
    /* Rows saved before sources : eat / drink ticks */
    if((saved.eat === false) && !("food" in saved)) row.food = "none";
    if((saved.drink === false) && !("water" in saved)) row.water = "none";
    if(!this.sourcesFor(camp.plan, actor, "food").includes(row.food)) row.food = "auto";
    if(!this.sourcesFor(camp.plan, actor, "water").includes(row.water)) row.water = "auto";
    if(!this.taskOffered(camp, row.task, actor)) row.task = "none";
    if(group && !groupTravel.memberActor(group, row.payer)) row.payer = this.defaultPayer(group, actor).id;
    return row;
  }

  static homebrewTasks(){
    return !!settings.value("homebrewCampTasks");
  }

  /* The tasks this member may take here (none at an inn) */
  static offered(camp, actor){
    if(this.atInn(camp.plan)) return [];
    return [...tasks.values()].filter(t => (!t.homebrew || this.homebrewTasks()) && (!t.available || t.available({ plan : camp.plan })) && (!t.applies || t.applies(actor)));
  }

  static taskOffered(camp, id, actor){
    return (id === "none") || this.offered(camp, actor).some(t => t.id === id);
  }

  /* Free food here for that member : food nearby, or grazing for a Beast */
  static freeFood(plan, actor){
    return !!plan.food || (!!plan.grazing && this.isBeast(actor));
  }

  static sourcesFor(plan, actor, kind){
    const free = (kind === "food") ? this.freeFood(plan, actor) : !!plan.water;
    return this.SOURCES.filter(s => (s !== "free") || free);
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
    const inn = this.atInn(camp.plan);
    const setup = Math.max(0, Math.round(Number(camp.plan.setup) || 0));
    const rows = this.members(group).map(actor => {
      const row = this.rowOf(camp, actor, group);
      const { minutes, source } = restMinutesOf(actor, "long");
      const hours = Math.max(1, Math.ceil(minutes / 60));
      return { actor, row, hours, short : !!source, source, allowance : Math.min(2, Math.max(0, hours - 6)) };
    });
    const resting = rows.filter(r => r.row.rest);
    const watchers = (camp.plan.watch && !inn) ? rows.filter(r => r.row.watch) : [];
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

  /* What the members need and what they carry : { food : { need, rations, feed }, water : { need, skins } } */
  static supplies(group, camp = this.campOf(group)){
    const rows = this.members(group).map(a => ({ a, row : this.rowOf(camp, a, group) }));
    const holders = [...new Set([...rows.map(r => r.a), ...groupInventory.packs(group)])];
    const need = (key, free) => rows.filter(r => !["none", "free"].includes(r.row[key]) && !free(r.a)).reduce((s, r) => s + this.need(r.a), 0);
    const count = list => list.reduce((n, i) => n + (Number(i.system.quantity) || 0), 0);
    return {
      food : { need : need("food", a => this.freeFood(camp.plan, a)), rations : holders.reduce((s, a) => s + count(this.rations(a)), 0), feed : holders.reduce((s, a) => s + count(this.feed(a)), 0) },
      water : { need : need("water", () => !!camp.plan.water), skins : holders.reduce((s, a) => s + this.skins(a).reduce((n, i) => n + this.waterIn(i), 0), 0) }
    };
  }

  static need(actor){
    return this.NEEDS[actor.system.traits?.size] ?? 1;
  }

  static rations(actor){
    return actor.items.filter(i => (i.system.identifier === "rations") && ((Number(i.system.quantity) || 0) > 0));
  }

  /* Animal feed (2024 PHB Feed, per day) : a day's food for one animal */
  static feed(actor){
    return actor.items.filter(i => /^feed/.test(i.system.identifier ?? "") && ((Number(i.system.quantity) || 0) > 0));
  }

  static skins(actor){
    return actor.items.filter(i => i.system.identifier === "waterskin");
  }

  static skinMax(item){
    return this.WATERSKIN * (Number(item.system.quantity) || 1);
  }

  /* Gallons in a waterskin (one never tracked is full) */
  static waterIn(item){
    const water = item.getFlag(module.id, "water");
    return Math.max(0, (water == null) ? this.skinMax(item) : Number(water) || 0);
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
          const c = data.changes ?? {}, clean = {};
          if("rest" in c) clean.rest = !!c.rest;
          if("watch" in c) clean.watch = !!c.watch && (!this.isBeast(actor) || user.isGM);
          if("task" in c) clean.task = this.taskOffered(camp, c.task, actor) ? c.task : "none";
          for(const kind of ["food", "water"]) if((kind in c) && this.sourcesFor(camp.plan, actor, kind).includes(c[kind])) clean[kind] = c[kind];
          if(("payer" in c) && groupTravel.memberActor(group, c.payer) && (this.canRun(group, user) || groupTravel.memberActor(group, c.payer).testUserPermission(user, "OWNER"))) clean.payer = c.payer;
          await group.update({ [`flags.${module.id}.camp.rows.${actor.id}`] : clean });
          return true;
        }
        case "plan" : {
          if(camp.run || !this.canRun(group, user)) return false;
          const c = data.changes ?? {}, clean = {};
          if("setup" in c) clean.setup = Math.min(24, Math.max(0, Math.round(Number(c.setup) || 0)));
          if(("terrain" in c) && (c.terrain in this.TERRAIN)) clean.terrain = c.terrain;
          for(const key of ["watch", "water", "food", "grazing"]) if(key in c) clean[key] = !!c[key];
          if(("lodging" in c) && ((c.lodging === "none") || (c.lodging in this.LODGING))) clean.lodging = c.lodging;
          if("night" in c) clean.night = (Number(c.night) > 0) ? Math.min(48, Math.round(Number(c.night))) : null;
          await group.update({ [`flags.${module.id}.camp.plan`] : clean });
          return true;
        }
        case "make" : return (!camp.run && this.canRun(group, user)) ? this.make(group, camp) : false;
        case "step" : return (camp.run && !camp.run.paused && this.canRun(group, user)) ? this.step(group, 1) : false;
        case "finish" : return (camp.run && !camp.run.paused && this.canRun(group, user)) ? this.step(group, Infinity) : false;
        case "break" : return (camp.run && this.canRun(group, user)) ? this.end(group, false) : false;
        case "resume" : {
          if(!camp.run?.paused || !this.canRun(group, user)) return false;
          await group.update({ [`flags.${module.id}.camp.run.paused`] : false });
          await this.statuses(group);
          return true;
        }
        case "stop" : {
          if(!camp.run || camp.run.paused || !this.canRun(group, user)) return false;
          const actors = (data.ids ?? []).map(id => groupTravel.memberActor(group, id)).filter(a => a);
          return this.interruptAsGM(group, actors, "gm", { wake : true });
        }
        case "interrupt" : {
          const actor = groupTravel.memberActor(group, data.id);
          if(!camp.run || !actor || !(user.isGM || actor.testUserPermission(user, "OWNER"))) return false;
          return this.interruptAsGM(group, [actor], data.why);
        }
      }
    } catch(err) { log.error("Camp :", err); }
    return false;
  }

  /* The camp made : rest limits, the inn paid, the tasks start, the first hour's sleepers */
  static async make(group, camp){
    const plan = this.schedule(group, camp);
    const resting = plan.rows.filter(r => r.row.rest).map(r => r.actor);
    const problems = [...resting.filter(a => !(Number(a.system.attributes?.hp?.value) > 0)).map(a => this.i18n("noHP", { name : a.name })),
      ...(restLimit.on() ? resting.map(a => restLimit.tooSoon(a)).filter(t => t) : [])];
    if(problems.length && !limits.allow(problems.join(" "), { who : group.name, what : this.i18n("title") })) return false;
    const lines = [];
    if(this.atInn(camp.plan)){
      const paid = await this.payInn(group, camp, plan);
      if(!paid) return false;
      lines.push(...paid);
    }
    const run = { start : game.time.worldTime, hour : 0, paused : false, interrupts : {}, applied : [], prone : [], pool : { food : 0, water : 0 }, data : {}, fed : false };
    await group.update({ [`flags.${module.id}.camp.run`] : run });
    for(const [id, task] of tasks){
      const actors = plan.rows.filter(r => r.row.task === id).map(r => r.actor);
      if(!actors.length || !task.start) continue;
      try { run.data[id] = (await task.start({ group, actors, camp : this.campOf(group) })) ?? null; } catch(err) { log.error(`Camp task ${id} :`, err); }
    }
    await group.update({ [`flags.${module.id}.camp.run.data`] : run.data });
    await this.postLog(group, "made", { lines : [...this.rotaLines(group), ...lines] });
    if(!plan.setup) await this.nightStarts(group);
    await this.statuses(group);
    return true;
  }

  /* The inn's price for each member (a Beast : stabling and feed), from the member paying it; nobody pays if one can't */
  static async payInn(group, camp, plan){
    const [stay, meal] = this.LODGING[camp.plan.lodging];
    const bills = new Map();
    for(const { actor, row } of plan.rows){
      const payer = groupTravel.memberActor(group, row.payer) ?? actor;
      const bill = bills.get(payer) ?? { cp : 0, for : [] };
      bill.cp += this.isBeast(actor) ? this.STABLE : (stay + meal);
      bill.for.push(actor.name);
      bills.set(payer, bill);
    }
    const Manager = dnd5e.applications.CurrencyManager;
    const short = [...bills].filter(([payer, bill]) => Manager.getActorCurrencyUpdates(payer, bill.cp, "cp").remainder > 0);
    if(short.length){
      ui.notifications.warn(short.map(([payer, bill]) => this.i18n("cantPay", { name : payer.name, cost : this.coins(bill.cp) })).join(" "));
      return null;
    }
    const lines = [];
    for(const [payer, bill] of bills){
      await Manager.deductActorCurrency(payer, bill.cp, "cp");
      lines.push(this.i18n("paid", { name : this.esc(payer.name), cost : this.coins(bill.cp), names : this.esc(bill.for.join(", ")) }));
    }
    return lines;
  }

  /* "1 gp 2 sp 5 cp" */
  static coins(cp){
    const parts = [];
    for(const [key, size] of [["gp", 100], ["sp", 10], ["cp", 1]]){
      const n = Math.floor(cp / size);
      if(n) parts.push(`${n} ${CONFIG.DND5E.currencies[key]?.abbreviation ?? key}`);
      cp -= n * size;
    }
    return parts.join(" ") || "0";
  }

  /* An hour (or all that's left) of the camp; the rest's first hour brings the meal; the last ends it */
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

  /* Each sleeper Unconscious for this hour, each one awake not (only the ones the camp made so); wake : these (or all) */
  static async statuses(group, wake = null){
    const camp = this.campOf(group);
    if(!camp.run) return;
    const plan = this.schedule(group, camp);
    const applied = new Set(camp.run.applied), prone = new Set(camp.run.prone);
    for(const r of plan.rows){
      const actor = r.actor;
      const woken = (wake === true) || (Array.isArray(wake) && wake.includes(actor));
      const asleep = !woken && (wake === null) && (r.cells[camp.run.hour] === "sleep");
      if(asleep && !actor.statuses.has("unconscious")){
        if(!actor.statuses.has("prone")) prone.add(actor.id);
        await actor.toggleStatusEffect("unconscious", { active : true });
        applied.add(actor.id);
      }
      else if(!asleep && ((wake === null) || woken) && applied.has(actor.id)){
        if(actor.statuses.has("unconscious")) await actor.toggleStatusEffect("unconscious", { active : false });
        if(prone.has(actor.id) && actor.statuses.has("prone")) await actor.toggleStatusEffect("prone", { active : false });
        applied.delete(actor.id); prone.delete(actor.id);
      }
    }
    await group.update({ [`flags.${module.id}.camp.run.applied`] : [...applied], [`flags.${module.id}.camp.run.prone`] : [...prone] });
  }

  /* The rest starts : the tasks' finds, then the meal */
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

  /* Take up to `want` from these items (count : how much one unit covers) */
  static async useUp(items, want, count){
    let got = 0;
    for(const item of items){
      if(got >= want - 1e-9) break;
      const units = Math.min(Number(item.system.quantity) || 0, Math.ceil((want - got) / count - 1e-9));
      if(units <= 0) continue;
      const left = (Number(item.system.quantity) || 0) - units;
      if(left > 0) await item.update({ "system.quantity" : left }); else await item.delete();
      got = Math.min(want, got + units * count);
    }
    return got;
  }

  /* Each member's daily food and water from where its row says */
  static async meal(group, camp, plan, pool){
    const lines = [];
    const shared = groupInventory.packs(group);
    const inn = this.atInn(camp.plan);
    const round = n => Math.round(n * 100) / 100;
    for(const { actor, row } of plan.rows){
      const need = this.need(actor);
      const holders = [actor, ...shared.filter(a => a !== actor)];
      let food = 0, water = 0;
      const foodFrom = inn ? "inn" : ((row.food === "auto") ? (this.freeFood(camp.plan, actor) ? "free" : "auto") : row.food);
      if(["free", "inn"].includes(foodFrom)) food = need;
      if(["auto", "found"].includes(foodFrom)){ const f = Math.min(pool.food, need); pool.food -= f; food += f; }
      if(["auto", "own"].includes(foodFrom) && (food < need)){
        /* A day of feed covers an animal's day; a Ration covers 1 lb */
        if(this.isBeast(actor) && (await this.useUp(holders.flatMap(a => this.feed(a)), 1, 1))) food = need;
        else food += await this.useUp(holders.flatMap(a => this.rations(a)), need - food, 1);
      }
      const waterFrom = inn ? "inn" : ((row.water === "auto") ? (camp.plan.water ? "free" : "auto") : row.water);
      if(["free", "inn"].includes(waterFrom)) water = need;
      if(["auto", "found"].includes(waterFrom)){ const w = Math.min(pool.water, need); pool.water -= w; water += w; }
      if(["auto", "own"].includes(waterFrom) && (water < need)){
        for(const item of holders.flatMap(a => this.skins(a))){
          if(water >= need) break;
          const has = this.waterIn(item);
          const take = Math.min(has, need - water);
          if(take <= 0) continue;
          await item.setFlag(module.id, "water", round(has - take));
          water += take;
        }
      }
      food = round(food); water = round(water);
      await actor.setFlag(module.id, "fed", { at : game.time.worldTime, food, needFood : need, water, needWater : need });
      const part = (got, from, key) => (from === "none") ? `<span class="none">${this.i18n(`${key}None`)}</span>`
        : `<span class="${(got < need / 2) ? "over" : ""}">${this.i18n(key, { got, need })}${["free", "inn"].includes(from) ? ` (${this.i18n(`source.${from}`)})` : ""}</span>`;
      lines.push(`${this.esc(actor.name)} : ${part(food, foodFrom, "ate")}, ${part(water, waterFrom, "drank")}`);
    }
    /* Water nearby fills every waterskin; else what's left of the water found does */
    for(const holder of [...plan.rows.map(r => r.actor), ...shared]){
      for(const item of this.skins(holder)){
        const room = this.skinMax(item) - this.waterIn(item);
        if(room <= 0) continue;
        const fill = camp.plan.water ? room : Math.min(room, pool.water);
        if(fill <= 0) continue;
        await item.setFlag(module.id, "water", round(this.waterIn(item) + fill));
        if(!camp.plan.water) pool.water -= fill;
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
    /* A Short Rest : each player's own rest window (Hit Point Dice), through dnd5e's rest request card */
    if(rested.short.length) await this.shortRestCard(group, rested.short);
    for(const [id, task] of tasks){
      const actors = plan.rows.filter(r => r.row.task === id).map(r => r.actor);
      if(!actors.length || !task.finish) continue;
      try { await task.finish({ group, actors, data : camp.run.data?.[id] ?? null, camp, rested }); } catch(err) { log.error(`Camp task ${id} :`, err); }
    }
    const names = list => list.map(a => this.esc(a.name)).join(", ") || "—";
    await this.postLog(group, done ? "done" : "broken", { lines : [
      this.i18n("restedLong", { names : names(rested.long) }), ...(rested.short.length ? [this.i18n("restedShort", { names : names(rested.short) })] : []),
      ...(rested.none.length ? [this.i18n("restedNone", { names : names(rested.none) })] : [])] });
    Hooks.callAll(`${module.id}.campEnded`, group, { done, rested, plan });
    return true;
  }

  static shortRestCard(group, actors){
    const rest = CONFIG.DND5E.restTypes.short;
    return ChatMessage.implementation.create({
      flavor : this.i18n("shortCard"), speaker : ChatMessage.implementation.getSpeaker({ actor : group, alias : group.name }), type : "request",
      system : { button : { icon : rest.icon ?? "fa-solid fa-utensils", label : rest.label }, handler : "rest",
        data : { newDay : false, recoverTemp : false, recoverTempMax : false, type : "short" }, targets : actors.map(a => ({ actor : a.uuid })) }
    });
  }

  /* An interruption : an hour more for each one resting (during its rest); the GM's or Initiative pauses the camp */
  static async interruptAsGM(group, actors, why, { wake = false } = {}){
    const camp = this.campOf(group);
    const plan = this.schedule(group, camp);
    const hour = camp.run.hour;
    const updates = {};
    const hit = [];
    for(const actor of actors){
      const r = plan.rows.find(r => r.actor === actor);
      if(!r?.row.rest || (hour < plan.setup) || (hour >= r.restEnd)) continue;
      updates[`flags.${module.id}.camp.run.interrupts.${actor.id}`] = (Number(camp.run.interrupts?.[actor.id]) || 0) + 1;
      hit.push(actor);
    }
    if(["initiative", "gm"].includes(why)) updates[`flags.${module.id}.camp.run.paused`] = true;
    if(foundry.utils.isEmpty(updates)) return false;
    await group.update(updates);
    if(wake) await this.statuses(group, actors);
    const now = this.schedule(group);
    const awake = now.rows.filter(row => (row.cells[hour] !== "sleep") || (wake && actors.includes(row.actor))).map(row => row.actor.name);
    const asleep = now.rows.filter(row => (row.cells[hour] === "sleep") && !(wake && actors.includes(row.actor))).map(row => row.actor.name);
    const who = (hit.length ? hit : actors).map(a => a.name).join(", ");
    await this.postLog(group, "interrupted", { lines : [this.i18n(`why.${why}`, { name : this.esc(who) }),
      ...(hit.length ? [this.i18n("hourMore", { names : this.esc(hit.map(a => a.name).join(", ")) })] : []),
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
    const lower = key => (key in hp) && (Number(hp[key]) < (Number(now[key]) || 0));
    if(lower("value") || lower("temp")) this.interrupt(actor, "damage");
  }

  /* Exertion : the group doesn't travel while camping */
  static preMove(token){
    if((token?.actor?.type !== "group") || !this.running(token.actor)) return;
    ui.notifications.warn(this.i18n("moving", { name : token.actor.name }));
    return false;
  }

  /* The GM picks who's interrupted (everyone resting, ticked) */
  static async stopWindow(group){
    const camp = this.campOf(group);
    const plan = this.schedule(group, camp);
    const hour = camp.run?.hour ?? 0;
    const rows = plan.rows.filter(r => r.row.rest).map(r => `<label class="who"><input type="checkbox" name="${r.actor.id}" checked>
      <img src="${this.esc(r.actor.img)}" alt=""> ${this.esc(r.actor.name)} <span class="hint">${this.esc(this.i18n(`cell.${r.cells[hour]?.startsWith("task:") ? "awake" : r.cells[hour]}`))}</span></label>`).join("");
    const ids = await foundry.applications.api.DialogV2.wait({
      window : { title : `${group.name} : ${this.i18n("button.stop")}`, icon : "fa-solid fa-bell" },
      content : `<div class="macro-helper-camp-stop"><p class="hint">${this.i18n("stopHint")}</p>${rows}</div>`,
      buttons : [
        { action : "stop", label : this.i18n("button.stop"), icon : "fa-solid fa-bell", default : true,
          callback : (event, button) => [...button.form.querySelectorAll("input:checked")].map(i => i.name) },
        { action : "cancel", label : game.i18n.localize("Cancel"), icon : "fa-solid fa-xmark" }
      ],
      rejectClose : false
    });
    if(Array.isArray(ids)) await gm.run("groupCamp", { group : group.uuid, op : "stop", ids });
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

  static postLog(group, kind, { lines = [] } = {}){
    const content = `<div class="macro-helper-group-log macro-helper-camp-log">
      <p><strong><i class="fa-solid fa-tents" inert></i> ${this.i18n(`log.${kind}`)}</strong></p>
      ${lines.map(l => `<p>${l}</p>`).join("")}</div>`;
    return ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor : group }), content });
  }

  /* ---------- Finding food and water : Forage (2024 DMG), Hunt, Gather Water (homebrew) ---------- */

  /* The DC : Forage the terrain's Foraging DC; Hunt / Gather Water the homebrew table's food / water DC */
  static surveyDC(key, plan){
    if(key === "forage") return this.TERRAIN[plan.terrain] ?? 15;
    return (this.HOMEBREW_DC[plan.terrain] ?? [15, 15])[(key === "hunt") ? 0 : 1];
  }

  /* A success finds : Forage 1d6 + WIS mod of each; Hunt / Gather Water 2d6 + WIS mod of its own */
  static surveyFormula(kind){
    return (kind === "both") ? "1d6 + @abilities.wis.mod" : "2d6 + @abilities.wis.mod";
  }

  static async surveyStart(key, kind, { group, actors }){
    const { plan } = this.campOf(group);
    const card = await rollRequests.request({ who : actors.map(a => ({ actor : a.uuid, name : a.name, img : a.img })), what : "skill:sur",
      dc : this.surveyDC(key, plan), hideDC : false, speaker : group,
      label : this.i18n("surveyCard", { task : this.i18n(`task.${key}`), skill : rollRequests.labelOf("skill", "sur"), terrain : this.i18n(`terrain.${plan.terrain}`) }) });
    return { message : card?.id ?? null };
  }

  static async surveyCollect(key, kind, { actors, data }){
    const message = game.messages.get(data?.message);
    const request = message?.getFlag(module.id, "request");
    let food = 0, water = 0;
    const lines = [];
    for(const actor of actors){
      const row = request?.rows.find(r => (r.actor === actor.uuid));
      const result = row ? request.results?.[1]?.[row.key] : null;
      const task = this.i18n(`task.${key}`);
      if(!result) { lines.push(this.i18n("surveyNone", { name : this.esc(actor.name), task })); continue; }
      if(!result.success) { lines.push(this.i18n("surveyFail", { name : this.esc(actor.name), task })); continue; }
      const roll = async () => Math.max(0, (await new Roll(this.surveyFormula(kind), actor.getRollData()).evaluate()).total);
      const f = (kind !== "water") ? await roll() : 0, w = (kind !== "food") ? await roll() : 0;
      food += f; water += w;
      lines.push(this.i18n(`found.${kind}`, { name : this.esc(actor.name), food : f, water : w }));
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
        const button = groupTravel.button({ action : "camp", icon : "fa-solid fa-tents", label : "groupTravel.camp.title", gmOnly : false });
        button.disabled = !groupInventory.inGroup(group);
        button.addEventListener("click", () => this.open(group));
        buttons.append(button);
      }
      const info = header.querySelector(".macro-helper-journey .info");
      const camp = this.campOf(group);
      if(info && camp.run && !info.querySelector(".camp")){
        const plan = this.schedule(group, camp);
        const awake = plan.rows.filter(r => r.cells[camp.run.hour] !== "sleep").map(r => r.actor.name);
        const line = document.createElement("div");
        line.className = `camp ${camp.run.paused ? "paused" : ""}`;
        line.innerHTML = `<i class="fa-solid fa-tents" inert></i> ${this.i18n("journey", { hour : Math.min(camp.run.hour + 1, plan.total), total : plan.total })}
          ${camp.run.paused ? `<span class="over">${this.i18n("paused")}</span>` : ""}
          <span class="awake" data-tooltip="${this.esc(this.i18n("awakeNow", { names : awake.join(", ") || "—" }))}"><i class="fa-solid fa-eye" inert></i> ${this.esc(awake.join(", ") || "—")}</span>`;
        line.addEventListener("click", () => this.open(group));
        info.append(line);
      }
    } catch(err) { log.error("Camp header :", err); }
  }

  static changed(actor, changes){
    if(actor.type !== "group") return;
    if(foundry.utils.hasProperty(changes, `flags.${module.id}.camp`) || foundry.utils.hasProperty(changes, `flags.${module.id}.order`) || ("system" in (changes ?? {}))) this.redraw(actor);
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
      static DEFAULT_OPTIONS = { classes : ["macro-helper-camp"], window : { icon : "fa-solid fa-tents", resizable : true }, position : { width : 760, height : "auto" } };
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
    const inn = this.atInn(camp.plan);
    const planner = this.canRun(group) && !run;
    const start = run?.start ?? game.time.worldTime;
    const at = h => groupTravel.formatted(start + h * groupTravel.secondsPerHour()).time;
    const e = t => this.esc(t);
    const off = on => on ? "" : "disabled";
    const options = (list, now) => list.map(([v, l]) => `<option value="${v}" ${(v === now) ? "selected" : ""}>${e(l)}</option>`).join("");
    const toggle = (name, icon, label) => `<label class="toggle ${camp.plan[name] ? "on" : ""}"><input type="checkbox" name="${name}" ${camp.plan[name] ? "checked" : ""} ${off(planner)}>
      <i class="fa-solid ${icon}" inert></i> ${this.i18n(label)}</label>`;
    const terrain = options(Object.entries(this.TERRAIN).map(([k, dc]) => [k, `${this.i18n(`terrain.${k}`)} (${this.i18n("dc", { dc })})`]), camp.plan.terrain);
    const lodging = options([["none", this.i18n("lodging.none")], ...Object.entries(this.LODGING).map(([k, [stay, meal]]) => [k, `${this.i18n(`lodging.${k}`)} (${this.coins(stay + meal)})`])], camp.plan.lodging);
    const where = `<section class="where">
        <h3>${this.i18n("where")}</h3>
        <div class="line"><label>${this.i18n("terrainLabel")} <select name="terrain" ${off(planner && !inn)}>${terrain}</select></label>
          <label>${this.i18n("lodgingLabel")} <select name="lodging" ${off(planner)}>${lodging}</select></label></div>
        <div class="line">${inn ? `<span class="hint">${this.i18n("innHint")}</span>` : `${toggle("water", "fa-water", "nearWater")}${toggle("food", "fa-apple-whole", "nearFood")}${toggle("grazing", "fa-wheat-awn", "grazing")}`}</div>
        <div class="line"><label>${this.i18n("setup")} <input type="number" name="setup" min="0" max="24" step="1" value="${plan.setup}" ${off(planner)}></label>
          ${inn ? "" : `<label><input type="checkbox" name="watch" ${camp.plan.watch ? "checked" : ""} ${off(planner)}> ${this.i18n("keepWatch")}</label>`}
          <label data-tooltip="${e(this.i18n("nightHint"))}">${this.i18n("night")} <input type="number" name="night" min="1" max="48" step="1" value="${plan.night}" ${off(planner)}></label></div>
      </section>`;
    const payers = this.members(group).filter(a => a.hasPlayerOwner && !this.isBeast(a));
    const memberRows = plan.rows.map(r => {
      const edit = !run && this.canEdit(group, r.actor);
      const box = (key, allowed = true) => `<input type="checkbox" data-key="${key}" ${r.row[key] ? "checked" : ""} ${off(edit && allowed)}>`;
      const tasksHere = this.offered(camp, r.actor);
      const task = inn ? `<span class="hint">—</span>` : `<select data-key="task" ${off(edit && tasksHere.length)}>${options([["none", this.i18n("task.none")], ...tasksHere.map(t => [t.id, game.i18n.localize(t.label)])], r.row.task)}</select>`;
      const source = kind => inn ? `<span class="hint">${this.i18n("source.inn")}</span>`
        : `<select data-key="${kind}" ${off(edit)}>${options(this.sourcesFor(camp.plan, r.actor, kind).map(s => [s, this.i18n(`source.${s}`)]), r.row[kind])}</select>`;
      const payer = inn ? `<td><select data-key="payer" ${off(edit)}>${options([...new Set([r.actor, ...payers])].map(a => [a.id, a.name]), r.row.payer)}</select></td>` : "";
      const summary = r.row.rest ? (r.short ? this.i18n("sumShort", { rest : r.sleep, watch : r.watch, source : r.source?.name ?? "" }) : this.i18n("sum", { sleep : r.sleep, watch : r.watch }))
        : this.i18n("sumOut", { watch : r.watch });
      return `<tr data-id="${r.actor.id}">
        <td class="who"><img src="${e(r.actor.img)}" alt=""><span>${e(r.actor.name)}</span></td>
        <td>${box("rest")}</td><td>${task}</td>
        <td>${inn ? "" : box("watch", !this.isBeast(r.actor) || game.user.isGM)}</td>
        <td>${source("food")}</td><td>${source("water")}</td>${payer}
        <td class="sum ${r.full ? "" : "over"}" data-tooltip="${e(this.i18n(r.full ? "full" : "notFull"))}"><i class="fa-solid ${r.full ? "fa-check" : "fa-triangle-exclamation"}" inert></i> ${e(summary)}</td></tr>`;
    }).join("");
    const members = `<section class="members"><h3>${this.i18n("membersLabel")}</h3><table>
        <thead><tr><th></th><th>${this.i18n("rests")}</th><th>${this.i18n("taskLabel")}</th><th>${inn ? "" : this.i18n("watchLabel")}</th>
          <th>${this.i18n("eat")}</th><th>${this.i18n("drink")}</th>${inn ? `<th>${this.i18n("pays")}</th>` : ""}<th>${this.i18n("restLabel")}</th></tr></thead>
        <tbody>${memberRows}</tbody></table></section>`;
    const heads = Array.from({ length : plan.total }, (_, h) => `<th class="${(h < plan.setup) ? "setup" : ""} ${(run && (h === run.hour)) ? "now" : ""}">${e(at(h))}</th>`).join("");
    const rotaRows = plan.rows.map(r => `<tr><td class="who">${e(r.actor.name)}</td>${r.cells.map((c, h) => {
      const task = c.startsWith("task:") ? tasks.get(c.slice(5)) : null;
      const icon = task ? task.icon : `fa-solid ${this.CELLS[c] ?? ""}`;
      const tip = task ? game.i18n.localize(task.label) : this.i18n(`cell.${c}`);
      return `<td class="cell ${task ? "task" : c} ${(h < plan.setup) ? "setup" : ""} ${(run && (h === run.hour)) ? "now" : ""}" data-tooltip="${e(tip)}">${icon.trim() ? `<i class="${icon}" inert></i>` : ""}</td>`;
    }).join("")}</tr>`).join("");
    const rota = `<section class="rota"><h3>${this.i18n("rota")} <span class="hint">${this.i18n("length", { setup : plan.setup, night : plan.night, from : at(0), to : at(plan.total) })}</span></h3>
        <div class="grid"><table><thead><tr><th></th>${heads}</tr></thead><tbody>${rotaRows}</tbody></table></div></section>`;
    const s = this.supplies(group, camp);
    const short = (have, need) => (have < need) ? "over" : "";
    const supplies = inn ? "" : `<p class="supplies">
        <span class="${short(s.food.rations + s.food.feed, s.food.need)}"><i class="fa-solid fa-drumstick-bite" inert></i> ${this.i18n("foodLine", { need : s.food.need, have : s.food.rations, feed : s.food.feed })}</span>
        <span class="${short(s.water.skins, s.water.need)}"><i class="fa-solid fa-droplet" inert></i> ${this.i18n("waterLine", { need : s.water.need, have : Math.round(s.water.skins * 100) / 100 })}</span></p>`;
    const buttons = run ? (run.paused ? [["resume", "fa-play"], ["break", "fa-person-walking-arrow-right"]]
      : [["step", "fa-forward-step"], ["finish", "fa-forward-fast"], ["stop", "fa-bell"], ["break", "fa-person-walking-arrow-right"]]) : [["make", "fa-tents"]];
    const control = this.canRun(group);
    return `${where}${members}${rota}${supplies}
      ${run?.paused ? `<p class="paused over"><i class="fa-solid fa-pause" inert></i> ${this.i18n("paused")}</p>` : ""}
      <footer class="form-footer">${buttons.map(([op, icon]) =>
        `<button type="button" data-op="${op}" ${off(control)}><i class="fa-solid ${icon}" inert></i> ${this.i18n(`button.${op}`)}</button>`).join("")}</footer>`;
  }

  static listen(group, content){
    const send = data => gm.run("groupCamp", { group : group.uuid, ...data });
    for(const input of content.querySelectorAll("tr[data-id] [data-key]")){
      input.addEventListener("change", () => send({ op : "row", id : input.closest("tr").dataset.id,
        changes : { [input.dataset.key] : (input.type === "checkbox") ? input.checked : input.value } }));
    }
    for(const input of content.querySelectorAll(".where [name]")){
      input.addEventListener("change", () => send({ op : "plan", changes : { [input.name] : (input.type === "checkbox") ? input.checked : input.value } }));
    }
    for(const button of content.querySelectorAll("footer [data-op]")){
      button.addEventListener("click", () => {
        if(button.dataset.op === "stop") return this.stopWindow(group);
        button.disabled = true;
        send({ op : button.dataset.op });
      });
    }
  }
}
