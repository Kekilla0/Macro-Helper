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
import { groupWeather } from './group-weather.js';
import { groupFood } from './group-food.js';
import { groupMeal } from './group-meal.js';
const log = logger.for(import.meta.url);

/**
 * Group Travel : Camp (the group sheet's Camp button; the GM or the Leader's player runs it, everyone in the group sees
 * it and sets their own creatures' rows).
 *   Where : the terrain and the Foraging DC (setting campForageDC : 2024 DMG Travel Terrain; 2014 DMG by abundance;
 *   combined : the terrain's DC, food and water each by abundance), water nearby (everyone drinks for free, every
 *   waterskin is filled), food nearby (everyone eats for free), grazing (Beasts eat for free), or an inn (2024 PHB Food,
 *   Drink, and Lodging : a night's stay by lifestyle and a meal for those eating the inn's, a Beast's stabling and feed,
 *   paid by the member picked on each row; water and shelter included, no watch, no tasks).
 *   Plan : each member Rests or not, a Task for the setting-up hours (Forage, RAW; homebrew : Forage food only, Gather
 *   Water, Hunt, Preserve; more through campTask), stands Watch or not (not a Beast unless the GM ticks it); at an inn,
 *   eats the inn's meal or its own. A Forager on the road (the Members tab's job) forages once, at Make Camp, without
 *   a task (2024 DMG : foraging is done while travelling, once a day).
 *   The rota : the rest lasts as long as the longest rest among the members resting (2024 Elf Trance : 4 h), longer
 *   when the watchers can't cover every hour (a Long Rest allows 2 hours of light activity, standing watch among them;
 *   hours past one's own rest are free), or what the GM typed. A member resting with no task rests from the start, the
 *   others once the setting-up hours are done. Hours are handed out in the members' order. Night hours clicked on or off
 *   watch before Make Camp (flag camp.rota) have no cap : the rest is filled around them, a short rest warned of.
 *   Running : Next Hour / To the End move the clock; sleepers are Unconscious (2024 PHB : during sleep), taken off when
 *   they wake (watch, the end). Setting up done : the tasks' finds (a success : 1d6 + WIS mod lb of food and as many
 *   gallons of water, 2024 DMG Foraging) : the food a "Foraged food" item given to the member new items go to (it
 *   spoils at midnight); the water drunk at once up to each member's need, then filling the waterskins, the rest lost
 *   (water nearby or at an inn : all of it, every waterskin full). Then the Meal window (group-meal.js) opens for every
 *   member, free food nearby (grazing : Beasts) and the inn's meal among its sources. Food that would spoil (at
 *   midnight, or when the camp ends) is first offered to a task (Preserve : Rations; food made by magic can't be).
 *   Weather (group-weather.js) : each camp hour brings Extreme Cold / Heat saves for the exposed. Sheltered : at an inn,
 *   in the camp's natural shelter (Where), the Members tab's ticks, and once set up a tent's place or one in a shelter
 *   built (the Make Shelter task : a Wisdom (Survival) check at the terrain's Foraging DC, Advantage with Carpenter's
 *   or Woodcarver's Tools carried and proficient in both (2024 PHB Tools); a success : two Small or Medium places).
 *   Interruptions (2024 PHB Long Rest) : Interrupt (the GM picks who; they wake) or rolling Initiative pauses the camp
 *   (Resume goes on, sleepers back to sleep); each, damage, or a spell other than a cantrip adds an hour to that member's
 *   rest. Moving the Group's token is refused while camping.
 *   The end : dnd5e's Long Rest for each member whose rest is done (one a day : rest-limit.js, checked when the camp is
 *   made); Break Camp : a Short Rest request card (each player's own rest window) for those who rested an hour or more.
 *
 *   campTask(id, { label, icon, homebrew, applies(actor), available({ group, plan }), start({ group, actors, camp }),
 *     collect({ group, actors, data, camp }), leftover({ group, actors, food, camp }), finish({ group, actors, data,
 *     camp, rested }) })
 *       a task for the setting-up hours : start when the camp is made (its return is kept as data), collect when
 *       setting up is done (return { food, water, lines, finders } : added to what's found), leftover when the
 *       group's spoiling food (not made by magic) would spoil (return { food (lb used), lines }), finish after the rests.
 */
const tasks = new Map();

export function campTask(id, { label, icon = "fa-solid fa-person-digging", homebrew = false, applies = null, available = null, start = null, collect = null, leftover = null, finish = null } = {}){
  if(!id || (id === "none")) return;
  tasks.set(id, { id, label : label ?? id, icon, homebrew, applies, available, start, collect, leftover, finish });
}

export class groupCamp{
  /* 2024 DMG Travel Terrain : Foraging DC */
  static TERRAIN = { arctic : 20, coastal : 10, desert : 20, forest : 10, grassland : 15, hill : 15, mountain : 20, swamp : 10, underdark : 20, urban : 20, waterborne : 15 };
  /* 2014 DMG Foraging DCs, by food and water availability; the combined setting's step on the terrain's DC */
  static ABUNDANCE = { abundant : 10, limited : 15, little : 20 };
  static ABUNDANCE_STEP = { abundant : -5, limited : 0, little : 5 };
  /* 2024 PHB Food / Water Needs per Day (pounds / gallons) */
  static NEEDS = { tiny : 0.25, sm : 1, med : 1, lg : 4, huge : 16, grg : 64 };
  /* 2024 PHB Food, Drink, and Lodging (cp) : Inn Stay per Day, Meal; Mounts : Stabling, Feed per day */
  static LODGING = { squalid : [7, 1], poor : [10, 2], modest : [50, 10], comfortable : [80, 20], wealthy : [200, 30], aristocratic : [400, 60] };
  static STABLE = [5, 5];
  static WATERSKIN = 0.5;
  static INN_SOURCES = ["inn", "own"];
  static #windows = new Map();

  static register(){
    if(game.system.id !== "dnd5e") return;
    const survey = (key, kind) => ({ start : data => this.surveyStart(key, kind(), data), collect : data => this.surveyCollect(key, kind(), data) });
    /* Forage finds both (RAW), food only with Camp Tasks on (Gather Water finds the water) */
    const forage = () => this.homebrewTasks() ? "food" : "both";
    campTask("forage", { label : "groupTravel.camp.task.forage", icon : "fa-solid fa-seedling", available : ({ plan }) => !(plan.food && (plan.water || this.homebrewTasks())),
      applies : (actor, group) => !this.roadForager(group, actor), ...survey("forage", forage) });
    campTask("water", { label : "groupTravel.camp.task.water", icon : "fa-solid fa-bucket", homebrew : true, available : ({ plan }) => !plan.water, ...survey("water", () => "water") });
    campTask("hunt", { label : "groupTravel.camp.task.hunt", icon : "fa-solid fa-crosshairs", homebrew : true, available : ({ plan }) => !plan.food, ...survey("hunt", () => "food") });
    campTask("shelter", { label : "groupTravel.camp.task.shelter", icon : "fa-solid fa-person-shelter", available : ({ plan }) => !plan.shelter,
      start : data => this.shelterStart(data), collect : data => this.shelterCollect(data) });
    campTask("preserve", { label : "groupTravel.camp.task.preserve", icon : "fa-solid fa-jar", homebrew : true, leftover : data => this.preserve(data) });
    Hooks.on("renderActorSheetV2", (app, html) => this.renderHeader(app, html));
    Hooks.on("updateActor", (actor, changes) => this.changed(actor, changes));
    Hooks.on("updateWorldTime", () => this.redraw());
    Hooks.on("updateSetting", setting => [`${module.id}.homebrewCampTasks`, `${module.id}.campForageDC`].includes(setting.key) && this.redraw());
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
    return { plan : { setup : 1, terrain : "forest", watch : true, night : null, water : false, food : false, grazing : false, shelter : false, lodging : "none",
      abundance : "limited", foodAbundance : "limited", waterAbundance : "limited", ...(camp.plan ?? {}) },
      rows : camp.rows ?? {}, rota : camp.rota ?? {}, run : camp.run ?? null };
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

  /* A member's row : rests, task, watch (the players' creatures; a Beast only when the GM ticked it), at an inn the
     inn's meal or its own food, who pays */
  static rowOf(camp, actor, group = null){
    const saved = camp.rows[actor.id] ?? {};
    const row = { rest : true, task : "none", watch : !!actor.hasPlayerOwner && !this.isBeast(actor), food : "inn", payer : null, ...saved };
    /* A Beast's watch from before the GM's tick (rows saved before Beasts were kept off watch) */
    if(this.isBeast(actor) && !saved.watchGM) row.watch = false;
    if(!this.INN_SOURCES.includes(row.food)) row.food = "inn";
    if(group && !this.taskOffered(camp, row.task, actor, group)) row.task = "none";
    if(group && !groupTravel.memberActor(group, row.payer)) row.payer = this.defaultPayer(group, actor).id;
    return row;
  }

  static homebrewTasks(){
    return !!settings.value("homebrewCampTasks");
  }

  /* A Forager on the road (the Members tab's job) : forages at Make Camp, no task needed (2024 DMG : once a day) */
  static roadForager(group, actor){
    return !!group && (groupTravel.memberOf(group, actor).job === "forager") && groupTravel.hasJob(group, actor);
  }

  /* The tasks this member may take here (none at an inn) */
  static offered(camp, actor, group){
    if(this.atInn(camp.plan)) return [];
    return [...tasks.values()].filter(t => (!t.homebrew || this.homebrewTasks()) && (!t.available || t.available({ group, plan : camp.plan })) && (!t.applies || t.applies(actor, group)));
  }

  static taskOffered(camp, id, actor, group){
    return (id === "none") || this.offered(camp, actor, group).some(t => t.id === id);
  }

  /* Who does a task : its rows, and for Forage the Foragers on the road too */
  static taskActors(group, plan, id){
    const actors = plan.rows.filter(r => r.row.task === id).map(r => r.actor);
    if((id === "forage") && !this.atInn(this.campOf(group).plan)) actors.push(...plan.rows.filter(r => this.roadForager(group, r.actor) && !actors.includes(r.actor)).map(r => r.actor));
    return actors;
  }

  /* The Foraging DC for food or water (setting campForageDC) */
  static foragingDC(plan, kind){
    const mode = settings.value("campForageDC");
    if(mode === "2014") return this.ABUNDANCE[plan.abundance] ?? 15;
    const dc = this.TERRAIN[plan.terrain] ?? 15;
    if(mode !== "combined") return dc;
    return dc + (this.ABUNDANCE_STEP[(kind === "water") ? plan.waterAbundance : plan.foodAbundance] ?? 0);
  }

  /* Free food here for that member (the Meal window's source) : the inn's meal, food nearby, grazing for a Beast */
  static freeFood(camp, actor, row = this.rowOf(camp, actor)){
    if(this.atInn(camp.plan)) return (row.food === "inn") ? "inn" : null;
    return camp.plan.food ? "nearby" : (camp.plan.grazing && this.isBeast(actor)) ? "grazing" : null;
  }

  static canRun(group, user = game.user){
    return groupTravel.canOrder(group, user);
  }

  static canEdit(group, actor, user = game.user){
    return this.canRun(group, user) || !!actor?.testUserPermission(user, "OWNER");
  }

  /* ---------- The rota ---------- */

  /**
   * Hour by hour : { setup, night, total, rows : [{ actor, row, hours (rest), short (a shortened rest : Trance), lead
   * (hours rested while the others set up), restStart, cells, restEnd, sleep, watch, full }] }. Cells : "task:<id>",
   * "awake", "watch", "sleep", "trance", "out" (not resting, not watching).
   */
  static schedule(group, camp = this.campOf(group)){
    const inn = this.atInn(camp.plan);
    /* An inn needs no setting up */
    const setup = inn ? 0 : Math.max(0, Math.round(Number(camp.plan.setup) || 0));
    const rows = this.members(group).map(actor => {
      const row = this.rowOf(camp, actor, group);
      const { minutes, source } = restMinutesOf(actor, "long");
      const hours = Math.max(1, Math.ceil(minutes / 60));
      /* Nothing to do while the camp is set up : it rests from the start */
      const lead = (row.rest && (row.task === "none")) ? Math.min(setup, hours) : 0;
      return { actor, row, hours, short : !!source, source, lead, restStart : row.rest ? setup - lead : 0, allowance : Math.min(2, Math.max(0, hours - 6)) };
    });
    const resting = rows.filter(r => r.row.rest);
    const watchers = (camp.plan.watch && !inn) ? rows.filter(r => r.row.watch) : [];
    const cap = (r, n) => r.row.rest ? Math.min(n, r.allowance + n + r.lead - r.hours) : n;
    let night = resting.length ? Math.max(...resting.map(r => r.hours - r.lead)) : 0;
    if(watchers.length) while((watchers.reduce((s, r) => s + Math.max(0, cap(r, night)), 0) < night) && (night < 48)) night++;
    night = Math.max(night, Math.round(Number(camp.plan.night) || 0));
    /* Hours placed by hand (night hours : "watch" / "rest") : no cap on them, the hours left are filled around them */
    const hand = new Map(watchers.map(r => [r, Object.entries(camp.rota?.[r.actor.id] ?? {}).filter(([h]) => Number(h) < night)]));
    const handWatch = r => hand.get(r).filter(([, v]) => v === "watch").map(([h]) => Number(h));
    const handRest = r => new Set(hand.get(r).filter(([, v]) => v === "rest").map(([h]) => Number(h)));
    const pinned = new Set(watchers.flatMap(handWatch));
    const open = Array.from({ length : watchers.length ? night : 0 }, (_, h) => h).filter(h => !pinned.has(h));
    /* Each watcher's share, round and round, then one block each in order */
    const share = new Map(watchers.map(r => [r, 0]));
    for(let left = open.length, moved = true; left && moved;){
      moved = false;
      for(const r of watchers) if(left && (share.get(r) + handWatch(r).length < cap(r, night))){ share.set(r, share.get(r) + 1); left--; moved = true; }
    }
    const watchOf = new Map();
    for(const r of watchers){
      const skip = handRest(r);
      const mine = open.filter(h => !skip.has(h)).slice(0, share.get(r));
      for(const h of mine) open.splice(open.indexOf(h), 1);
      watchOf.set(r, new Set([...handWatch(r), ...mine]));
    }
    /* Hours a watcher gave back by hand : to another with room left */
    for(const h of open){
      const r = watchers.find(r => !handRest(r).has(h) && (watchOf.get(r).size < cap(r, night)));
      r && watchOf.get(r).add(h);
    }
    const interrupts = camp.run?.interrupts ?? {};
    for(const r of rows){
      const mine = watchOf.get(r) ?? new Set();
      const cells = Array.from({ length : setup }, (_, h) => (r.row.task !== "none") ? `task:${r.row.task}` : (h >= r.restStart) ? (r.short ? "trance" : "sleep") : "awake");
      let rested = r.lead;
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
        for(let h = r.restStart; h < cells.length; h++){
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
    /* Night hours with no one on watch, and whether any hour was placed by hand */
    const unwatched = watchers.length ? Array.from({ length : night }, (_, h) => h).filter(h => !watchers.some(r => watchOf.get(r).has(h))) : [];
    return { setup, night, total, rows, unwatched, edited : [...hand.values()].some(list => list.length) };
  }

  /* Who may move this member's watches by hand : the camp's runner, or its owner (a Beast : the GM) */
  static canRota(group, camp, actor, user = game.user){
    return !camp.run && !!camp.plan.watch && !this.atInn(camp.plan) && this.rowOf(camp, actor, group).watch
      && (this.isBeast(actor) ? user.isGM : this.canEdit(group, actor, user));
  }

  /* What the members need and what they carry : { food : { need, rations, feed }, water : { need, skins } } */
  static supplies(group, camp = this.campOf(group)){
    const actors = this.members(group);
    const holders = [...new Set([...actors, ...groupInventory.packs(group)])];
    const need = list => list.reduce((s, a) => s + this.need(a), 0);
    const count = list => Math.round(list.reduce((n, i) => n + groupMeal.unitsLeft(i), 0) * 100) / 100;
    const waterThere = !!camp.plan.water || this.atInn(camp.plan);
    return {
      food : { need : need(actors.filter(a => !this.freeFood(camp, a, this.rowOf(camp, a, group)))), rations : holders.reduce((s, a) => s + count(this.rations(a)), 0), feed : holders.reduce((s, a) => s + count(this.feed(a)), 0) },
      water : { need : waterThere ? 0 : need(actors), skins : holders.reduce((s, a) => s + this.skins(a).reduce((n, i) => n + this.waterIn(i), 0), 0) }
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
          if("watch" in c){
            clean.watch = !!c.watch && (!this.isBeast(actor) || user.isGM);
            if(this.isBeast(actor)) clean.watchGM = clean.watch;
          }
          if("task" in c) clean.task = this.taskOffered(camp, c.task, actor, group) ? c.task : "none";
          if(("food" in c) && this.INN_SOURCES.includes(c.food)) clean.food = c.food;
          if(("payer" in c) && groupTravel.memberActor(group, c.payer) && (this.canRun(group, user) || groupTravel.memberActor(group, c.payer).testUserPermission(user, "OWNER"))) clean.payer = c.payer;
          await group.update({ [`flags.${module.id}.camp.rows.${actor.id}`] : clean });
          return true;
        }
        case "plan" : {
          if(camp.run || !this.canRun(group, user)) return false;
          const c = data.changes ?? {}, clean = {};
          if("setup" in c) clean.setup = Math.min(24, Math.max(0, Math.round(Number(c.setup) || 0)));
          if(("terrain" in c) && (c.terrain in this.TERRAIN)) clean.terrain = c.terrain;
          for(const key of ["watch", "water", "food", "grazing", "shelter"]) if(key in c) clean[key] = !!c[key];
          for(const key of ["abundance", "foodAbundance", "waterAbundance"]) if((key in c) && (c[key] in this.ABUNDANCE)) clean[key] = c[key];
          if(("lodging" in c) && ((c.lodging === "none") || (c.lodging in this.LODGING))) clean.lodging = c.lodging;
          if("night" in c) clean.night = (Number(c.night) > 0) ? Math.min(48, Math.round(Number(c.night))) : null;
          await group.update({ [`flags.${module.id}.camp.plan`] : clean });
          return true;
        }
        case "rota" : {
          if(data.reset){
            if(camp.run || !this.canRun(group, user)) return false;
            await group.update({ [`flags.${module.id}.camp.rota`] : new foundry.data.operators.ForcedDeletion() });
            return true;
          }
          const actor = groupTravel.memberActor(group, data.id);
          const hour = Math.round(Number(data.hour));
          if(!actor || !(hour >= 0) || (hour >= 48) || !this.canRota(group, camp, actor, user)) return false;
          await group.update({ [`flags.${module.id}.camp.rota.${actor.id}.${hour}`] : data.watch ? "watch" : "rest" });
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
      ...(restLimit.on() ? plan.rows.filter(r => r.row.rest).map(r => restLimit.tooSoon(r.actor, game.time.worldTime + r.restStart * groupTravel.secondsPerHour())).filter(t => t) : [])];
    if(problems.length && !limits.allow(problems.join(" "), { who : group.name, what : this.i18n("title") })) return false;
    const lines = [];
    if(this.atInn(camp.plan)){
      const paid = await this.payInn(group, camp, plan);
      if(!paid) return false;
      lines.push(...paid);
    }
    const run = { start : game.time.worldTime, hour : 0, paused : false, interrupts : {}, applied : [], prone : [], data : {}, fed : false };
    await group.update({ [`flags.${module.id}.camp.run`] : run });
    for(const [id, task] of tasks){
      const actors = this.taskActors(group, plan, id);
      if(!actors.length || !task.start) continue;
      try { run.data[id] = (await task.start({ group, actors, camp : this.campOf(group) })) ?? null; } catch(err) { log.error(`Camp task ${id} :`, err); }
    }
    await group.update({ [`flags.${module.id}.camp.run.data`] : run.data });
    await this.postLog(group, "made", { lines : [...this.rotaLines(group), ...lines] });
    /* No setting up : the meal now, unless someone's check is still to roll (then after the first hour) */
    if(!plan.setup && ![...tasks].some(([id, task]) => task.collect && this.taskActors(group, plan, id).length)) await this.nightStarts(group);
    await this.statuses(group);
    return true;
  }

  /* The inn's price for each member (a Beast : stabling, and feed if it eats the inn's; anyone else the stay, and a meal
     if it eats the inn's), from the member paying it; nobody pays if one can't */
  static async payInn(group, camp, plan){
    const [stay, meal] = this.LODGING[camp.plan.lodging];
    const bills = new Map();
    for(const { actor, row } of plan.rows){
      const payer = groupTravel.memberActor(group, row.payer) ?? actor;
      const bill = bills.get(payer) ?? { cp : 0, for : [] };
      const [room, food] = this.isBeast(actor) ? this.STABLE : [stay, meal];
      bill.cp += room + ((row.food === "inn") ? food : 0);
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
      const start = game.time.worldTime;
      await game.time.advance(groupTravel.secondsPerHour());
      const hour = camp.run.hour + 1;
      await group.update({ [`flags.${module.id}.camp.run.hour`] : hour });
      /* The weather's saves for the hour gone, sheltered as the camp was then */
      const places = this.places(group, plan);
      await groupWeather.hourly(group, { start, seconds : groupTravel.secondsPerHour(), context : "camp",
        shelter : actor => this.shelterOf(group, camp, plan, places, actor, hour - 1),
        asleep : actor => ["sleep", "trance"].includes(plan.rows.find(r => r.actor === actor)?.cells[hour - 1]), where : { water : !!camp.plan.water || this.atInn(camp.plan) } })
        .catch(err => log.error("Camp weather :", err));
      if((hour >= plan.setup) && !camp.run.fed) await this.nightStarts(group);
      if(hour >= this.schedule(group).total) return this.end(group, true);
      await this.statuses(group);
    }
    return true;
  }

  /* Tent places and shelters built (once checked : only the successes), for those with no other shelter : Map(actor -> "tent" | "built") */
  static places(group, plan){
    const built = this.campOf(group).run?.data?.shelter?.built;
    const builders = plan.rows.filter(r => (r.row.task === "shelter") && (!Array.isArray(built) || built.includes(r.actor.id))).map(r => r.actor);
    return groupWeather.campPlaces(group, plan.rows.map(r => r.actor).filter(a => !groupWeather.roadShelter(group, a)), builders);
  }

  /* Tools that help build a shelter (2024 PHB : proficient with a tool and a skill that both apply : Advantage) */
  static SHELTER_TOOLS = ["carpenter", "woodcarver"];

  static shelterTool(actor){
    if(!(Number(actor.system.skills?.sur?.value) >= 1)) return null;
    return actor.items.find(i => (i.type === "tool") && this.SHELTER_TOOLS.includes(i.system.type?.baseItem)
      && (Number(actor.system.tools?.[i.system.type.baseItem]?.value) >= 1)) ?? null;
  }

  /* Make Shelter : a Wisdom (Survival) check at the terrain's Foraging DC */
  static async shelterStart({ group, actors }){
    const { plan } = this.campOf(group);
    const dc = this.TERRAIN[plan.terrain] ?? 15;
    const who = actors.map(a => {
      const tool = this.shelterTool(a);
      return { actor : a.uuid, name : a.name, img : a.img, ...(tool ? { rollMode : { mode : "advantage", reason : this.i18n("shelterTool", { tool : tool.name }) } } : {}) };
    });
    const card = await rollRequests.request({ who, what : "skill:sur", dc, hideDC : false, speaker : group,
      label : this.i18n("surveyCard", { task : this.i18n("task.shelter"), skill : rollRequests.labelOf("skill", "sur"), terrain : this.i18n(`terrain.${plan.terrain}`) }) });
    return { message : card?.id ?? null, dc };
  }

  /* Setting up done : who built one (kept on the run : places counts only those) */
  static async shelterCollect({ group, actors, data }){
    const request = game.messages.get(data?.message)?.getFlag(module.id, "request");
    const built = [], lines = [];
    for(const actor of actors){
      const row = request?.rows.find(r => r.actor === actor.uuid);
      const result = row ? request.results?.[1]?.[row.key] : null;
      const ok = !!result && (Number.isFinite(Number(result.total)) ? (Number(result.total) >= data.dc) : !!result.success);
      if(ok) built.push(actor.id);
      lines.push(this.i18n(!result ? "shelterNone" : ok ? "shelterBuilt" : "shelterFail", { name : this.esc(actor.name) }));
    }
    await group.update({ [`flags.${module.id}.camp.run.data.shelter.built`] : built });
    return { lines };
  }

  /* A member's shelter in that camp hour : the inn, natural shelter, the Members tab's, then (set up) a tent or a shelter built */
  static shelterOf(group, camp, plan, places, actor, hour){
    if(this.atInn(camp.plan)) return "inn";
    if(camp.plan.shelter) return "natural";
    return groupWeather.roadShelter(group, actor) ?? (((hour >= plan.setup) && places.get(actor)) || null);
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

  /* Setting up done : the tasks' finds (food : an item that spoils; water : drunk, then into the waterskins), then
     the Meal window for everyone */
  static async nightStarts(group){
    const camp = this.campOf(group);
    const plan = this.schedule(group, camp);
    const found = { food : 0, water : 0 };
    const lines = [];
    for(const [id, task] of tasks){
      const actors = this.taskActors(group, plan, id);
      if(!actors.length || !task.collect) continue;
      try {
        const got = (await task.collect({ group, actors, data : camp.run.data?.[id] ?? null, camp })) ?? {};
        found.food += Number(got.food) || 0;
        found.water += Number(got.water) || 0;
        lines.push(...(got.lines ?? []));
      } catch(err) { log.error(`Camp task ${id} :`, err); }
    }
    await group.update({ [`flags.${module.id}.camp.run.fed`] : true });
    const actors = plan.rows.map(r => r.actor);
    if(found.food >= 1){
      const holder = groupTravel.arrivalHolder(group).actor ?? actors[0];
      await groupMeal.giveFood(holder, { identifier : groupMeal.FORAGED, name : this.i18n("foraged"), lb : found.food });
      lines.push(this.i18n("foragedTo", { food : Math.floor(found.food), name : this.esc(holder?.name) }));
    }
    /* Water nearby or at the inn : all anyone wants; else what's found */
    const there = !!camp.plan.water || this.atInn(camp.plan);
    if(there || (found.water > 0)) lines.push(...await groupMeal.drinkThere(group, actors, there ? Infinity : found.water));
    if(lines.length) await this.postLog(group, "found", { lines });
    const free = Object.fromEntries(plan.rows.map(r => [r.actor.id, this.freeFood(camp, r.actor, r.row)]).filter(([, f]) => f));
    await groupMeal.callAsGM(group, actors.filter(a => groupFood.tracked(group, a)).map(a => a.id), free);
    return true;
  }

  /* The group's food that would spoil (not made by magic), offered to the tasks taking it (Preserve) */
  static async preserveLeft(group){
    const camp = this.campOf(group);
    if(!camp.run) return;
    const plan = this.schedule(group, camp);
    const holders = [...new Set([...plan.rows.map(r => r.actor), ...groupInventory.packs(group)])];
    const items = () => holders.flatMap(a => a.items.filter(i => groupMeal.spoils(i) && !i.getFlag(module.id, "made")));
    const lines = [];
    for(const [id, task] of tasks){
      const actors = this.taskActors(group, plan, id);
      const food = Math.round(items().reduce((s, i) => s + groupMeal.unitsLeft(i) * groupMeal.perUnit(i, actors[0]), 0) * 100) / 100;
      if((food < 0.01) || !task.leftover || !actors.length) continue;
      try {
        const kept = (await task.leftover({ group, actors, food, camp })) ?? {};
        let used = Number(kept.food) || 0;
        for(const item of items()){
          if(used <= 1e-9) break;
          used -= await groupMeal.eatFrom(item, used, actors[0]);
        }
        lines.push(...(kept.lines ?? []));
      } catch(err) { log.error(`Camp task ${id} :`, err); }
    }
    if(lines.length) await this.postLog(group, "preserved", { lines });
  }

  /* Preserve (homebrew Camp Tasks) : each whole pound of the food left becomes a Ration, kept by the first preserver */
  static async preserve({ group, actors, food }){
    const count = Math.floor(food + 1e-9);
    const keeper = actors[0];
    if(!count || !keeper) return { food : 0 };
    await this.giveRations(group, keeper, count);
    return { food : count, lines : [this.i18n("preserved", { name : this.esc(keeper.name), count })] };
  }

  /* Rations onto a creature : its own stack, else a copy of one the group has, else dnd5e's */
  static async giveRations(group, actor, count){
    const stack = actor.items.find(i => i.system.identifier === "rations");
    if(stack) return stack.update({ "system.quantity" : (Number(stack.system.quantity) || 0) + count });
    let source = [...this.members(group), ...groupInventory.packs(group)].flatMap(a => a.items.contents).find(i => i.system.identifier === "rations")?.toObject();
    if(!source){
      const pack = game.packs.get("dnd5e.equipment24");
      const entry = pack?.index.find(e => e.name === "Rations");
      source = entry ? (await pack.getDocument(entry._id))?.toObject() : null;
    }
    source ??= { name : this.i18n("rations"), type : "consumable", system : { type : { value : "food" }, weight : { value : 2, units : "lb" } } };
    delete source._id;
    /* A copy starts whole */
    delete source.flags?.[module.id]?.eaten;
    foundry.utils.mergeObject(source, { "system.quantity" : count, "system.identifier" : "rations", "system.container" : null });
    return actor.createEmbeddedDocuments("Item", [source]);
  }

  /* The camp ends : sleepers wake, the rests, the tasks' finish, the log */
  static async end(group, done){
    const camp = this.campOf(group);
    if(!camp.run) return false;
    const plan = this.schedule(group, camp);
    await this.statuses(group, true);
    await this.preserveLeft(group);
    const hour = Math.min(camp.run.hour, plan.total);
    const rested = { long : [], short : [], none : [] };
    for(const r of plan.rows.filter(r => r.row.rest)){
      const hadRest = r.cells.slice(0, hour).filter(c => (c === "sleep") || (c === "trance")).length;
      const kind = (done || (hour >= r.restEnd)) && r.full ? "long" : (hadRest >= 1) ? "short" : "none";
      rested[kind].push(r.actor);
    }
    await group.unsetFlag(module.id, "camp.run");
    for(const actor of rested.long){
      const restStart = camp.run.start + (plan.rows.find(r => r.actor === actor)?.restStart ?? plan.setup) * groupTravel.secondsPerHour();
      try { await actor.longRest({ dialog : false, advanceTime : false, advanceBastionTurn : false, [module.id] : { restChecked : true, restStart } }); }
      catch(err) { log.error("Camp Long Rest :", err); }
    }
    /* A Short Rest : each player's own rest window (Hit Point Dice), through dnd5e's rest request card */
    if(rested.short.length) await this.shortRestCard(group, rested.short);
    for(const [id, task] of tasks){
      const actors = this.taskActors(group, plan, id);
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
      if(!r?.row.rest || (hour < r.restStart) || (hour >= r.restEnd)) continue;
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

  /* ---------- Finding food and water : Forage (2024 DMG), Gather Water, Hunt (homebrew) ---------- */

  /* The DCs a task's check meets, for food and for water (null : it doesn't find that); Hunt : the food DC + 5 */
  static surveyDCs(key, kind, plan){
    const step = (key === "hunt") ? 5 : 0;
    return { food : (kind !== "water") ? this.foragingDC(plan, "food") + step : null, water : (kind !== "food") ? this.foragingDC(plan, "water") + step : null };
  }

  /* A success finds 1d6 + WIS mod (2024 DMG Foraging); Hunt 2d6 + WIS mod */
  static surveyFormula(key){
    return (key === "hunt") ? "2d6 + @abilities.wis.mod" : "1d6 + @abilities.wis.mod";
  }

  static async surveyStart(key, kind, { group, actors }){
    const { plan } = this.campOf(group);
    const dcs = this.surveyDCs(key, kind, plan);
    const both = (dcs.food !== null) && (dcs.water !== null) && (dcs.food !== dcs.water);
    const card = await rollRequests.request({ who : actors.map(a => ({ actor : a.uuid, name : a.name, img : a.img })), what : "skill:sur",
      dc : Math.min(...[dcs.food, dcs.water].filter(dc => dc !== null)), hideDC : false, speaker : group,
      label : this.i18n("surveyCard", { task : this.i18n(`task.${key}`), skill : rollRequests.labelOf("skill", "sur"), terrain : this.whereLabel(plan) })
        + (both ? ` (${this.i18n("dcSplit", dcs)})` : "") });
    return { message : card?.id ?? null, kind, dcs };
  }

  static async surveyCollect(key, kind, { group, actors, data }){
    const message = game.messages.get(data?.message);
    const request = message?.getFlag(module.id, "request");
    kind = data?.kind ?? kind;
    const dcs = data?.dcs ?? this.surveyDCs(key, kind, this.campOf(group).plan);
    let food = 0, water = 0;
    const lines = [], finders = [];
    const plan = this.schedule(group);
    for(const actor of actors){
      const row = request?.rows.find(r => (r.actor === actor.uuid));
      const result = row ? request.results?.[1]?.[row.key] : null;
      const road = (key === "forage") && (plan.rows.find(r => r.actor === actor)?.row.task !== "forage");
      const task = this.i18n(road ? "task.road" : `task.${key}`);
      if(!result) { lines.push(this.i18n("surveyNone", { name : this.esc(actor.name), task })); continue; }
      const total = Number(result.total);
      const meets = dc => (dc !== null) && (Number.isFinite(total) ? (total >= dc) : !!result.success);
      const got = { food : meets(dcs.food), water : meets(dcs.water) };
      if(!got.food && !got.water) { lines.push(this.i18n("surveyFail", { name : this.esc(actor.name), task })); continue; }
      const roll = async () => Math.max(0, (await new Roll(this.surveyFormula(key), actor.getRollData()).evaluate()).total);
      const f = got.food ? await roll() : 0, w = got.water ? await roll() : 0;
      food += f; water += w;
      finders.push(actor);
      lines.push(this.i18n(`found.${(got.food && got.water) ? "both" : got.food ? "food" : "water"}`, { name : this.esc(actor.name), food : f, water : w }).replace(/\.$/, road ? ` (${task}).` : "."));
    }
    return { food, water, lines, finders };
  }

  /* "Forest", "Limited food and water", "Forest : food Abundant, water Very little" (by the Foraging DCs setting) */
  static whereLabel(plan){
    const mode = settings.value("campForageDC");
    if(mode === "2014") return this.i18n(`abundance.${plan.abundance}`);
    const terrain = this.i18n(`terrain.${plan.terrain}`);
    if(mode !== "combined") return terrain;
    return this.i18n("whereCombined", { terrain, food : this.i18n(`abundance.${plan.foodAbundance}`), water : this.i18n(`abundance.${plan.waterAbundance}`) });
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
      static DEFAULT_OPTIONS = { classes : ["macro-helper-camp"], window : { icon : "fa-solid fa-tents", resizable : true }, position : { width : 980, height : "auto" } };
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
    /* The Foraging DC's parts, by the setting : the terrain (2024), the abundance (2014), or both (combined) */
    const mode = settings.value("campForageDC");
    const dcText = dc => this.i18n("dc", { dc });
    const terrain = options(Object.entries(this.TERRAIN).map(([k, dc]) => [k, `${this.i18n(`terrain.${k}`)}${(mode === "2014") ? "" : ` (${dcText(dc)})`}`]), camp.plan.terrain);
    const abundance = (name, label, dcOf) => `<label>${this.i18n(label)} <select name="${name}" ${off(planner)}>${options(Object.keys(this.ABUNDANCE).map(k =>
      [k, `${this.i18n(`abundance.${k}`)} (${dcText(dcOf(k))})`]), camp.plan[name])}</select></label>`;
    const base = this.TERRAIN[camp.plan.terrain] ?? 15;
    const dcs = (mode === "2014") ? abundance("abundance", "abundanceLabel", k => this.ABUNDANCE[k])
      : (mode === "combined") ? `${abundance("foodAbundance", "foodLabel", k => base + this.ABUNDANCE_STEP[k])}${abundance("waterAbundance", "waterLabel", k => base + this.ABUNDANCE_STEP[k])}` : "";
    const lodging = options([["none", this.i18n("lodging.none")], ...Object.entries(this.LODGING).map(([k, [stay, meal]]) => [k, `${this.i18n(`lodging.${k}`)} (${this.coins(stay + meal)})`])], camp.plan.lodging);
    const where = `<section class="where">
        <h3>${this.i18n("where")}</h3>
        <div class="line"><label>${this.i18n("lodgingLabel")} <select name="lodging" ${off(planner)}>${lodging}</select></label>
          ${inn ? "" : `<label>${this.i18n("terrainLabel")} <select name="terrain" ${off(planner)}>${terrain}</select></label>${dcs}`}</div>
        <div class="line">${inn ? `<span class="hint">${this.i18n("innHint")}</span>` : `${toggle("water", "fa-water", "nearWater")}${toggle("food", "fa-apple-whole", "nearFood")}${toggle("grazing", "fa-wheat-awn", "grazing")}${toggle("shelter", "fa-person-shelter", "naturalShelter")}`}</div>
        <div class="line">${inn ? "" : `<label>${this.i18n("setup")} <input type="number" name="setup" min="0" max="24" step="1" value="${plan.setup}" ${off(planner)}></label>
          <label><input type="checkbox" name="watch" ${camp.plan.watch ? "checked" : ""} ${off(planner)}> ${this.i18n("keepWatch")}</label>`}
          <label data-tooltip="${e(this.i18n("nightHint"))}">${this.i18n("night")} <input type="number" name="night" min="1" max="48" step="1" value="${plan.night}" ${off(planner)}></label></div>
      </section>`;
    const payers = this.members(group).filter(a => a.hasPlayerOwner && !this.isBeast(a));
    const places = this.places(group, plan);
    const extreme = groupWeather.of(group).temperature !== "normal";
    const memberRows = plan.rows.map(r => {
      const where = this.shelterOf(group, camp, plan, places, r.actor, plan.setup);
      const shelter = `<td class="shelter ${(!where && extreme) ? "over" : ""}" data-tooltip="${e(this.i18n(`shelter.${where ?? "none"}Hint`))}">${this.i18n(`shelter.${where ?? "none"}`)}</td>`;
      const edit = !run && this.canEdit(group, r.actor);
      const box = (key, allowed = true) => `<input type="checkbox" data-key="${key}" ${r.row[key] ? "checked" : ""} ${off(edit && allowed)}>`;
      const tasksHere = this.offered(camp, r.actor, group);
      const road = (!inn && this.roadForager(group, r.actor)) ? `<i class="fa-solid fa-seedling road" data-tooltip="${e(this.i18n("roadHint"))}" inert></i>` : "";
      const task = inn ? `<span class="hint">—</span>` : `${road}<select data-key="task" ${off(edit && tasksHere.length)}>${options([["none", this.i18n("task.none")], ...tasksHere.map(t => [t.id, game.i18n.localize(t.label)])], r.row.task)}</select>`;
      const food = inn ? `<td><select data-key="food" ${off(edit)}>${options(this.INN_SOURCES.map(s => [s, this.i18n(`source.${s}`)]), r.row.food)}</select></td>` : "";
      const payer = inn ? `<td><select data-key="payer" ${off(edit)}>${options([...new Set([r.actor, ...payers])].map(a => [a.id, a.name]), r.row.payer)}</select></td>` : "";
      const summary = r.row.rest ? (r.short ? this.i18n("sumShort", { rest : r.sleep, watch : r.watch, source : r.source?.name ?? "" }) : this.i18n("sum", { sleep : r.sleep, watch : r.watch }))
        : this.i18n("sumOut", { watch : r.watch });
      return `<tr data-id="${r.actor.id}">
        <td class="who"><img src="${e(r.actor.img)}" alt=""><span>${e(r.actor.name)}</span></td>
        <td>${box("rest")}</td><td class="task">${task}</td>
        ${inn ? "" : `<td>${box("watch", !this.isBeast(r.actor) || game.user.isGM)}</td>`}
        ${food}${payer}${shelter}
        <td class="sum ${r.full ? "" : "over"}" data-tooltip="${e(this.i18n(r.full ? "full" : "notFull"))}"><i class="fa-solid ${r.full ? "fa-check" : "fa-triangle-exclamation"}" inert></i> ${e(summary)}</td></tr>`;
    }).join("");
    const members = `<section class="members"><h3>${this.i18n("membersLabel")}</h3><table>
        <thead><tr><th></th><th>${this.i18n("rests")}</th><th>${this.i18n("taskLabel")}</th>${inn ? "" : `<th>${this.i18n("watchLabel")}</th>`}
          ${inn ? `<th>${this.i18n("eat")}</th><th>${this.i18n("pays")}</th>` : ""}<th>${this.i18n("shelterLabel")}</th><th>${this.i18n("restLabel")}</th></tr></thead>
        <tbody>${memberRows}</tbody></table></section>`;
    const unwatched = new Set(plan.unwatched.map(h => h + plan.setup));
    const heads = Array.from({ length : plan.total }, (_, h) => `<th class="${(h < plan.setup) ? "setup" : ""} ${(run && (h === run.hour)) ? "now" : ""} ${unwatched.has(h) ? "over" : ""}"
      ${unwatched.has(h) ? `data-tooltip="${e(this.i18n("unwatched"))}"` : ""}>${e(at(h))}</th>`).join("");
    const rotaRows = plan.rows.map(r => {
      const pick = this.canRota(group, camp, r.actor);
      const short = r.row.rest && !r.full;
      return `<tr data-id="${r.actor.id}"><td class="who ${short ? "over" : ""}" ${short ? `data-tooltip="${e(this.i18n("notFull"))}"` : ""}>${short ? `<i class="fa-solid fa-triangle-exclamation" inert></i> ` : ""}${e(r.actor.name)}</td>${r.cells.map((c, h) => {
        const task = c.startsWith("task:") ? tasks.get(c.slice(5)) : null;
        const icon = task ? task.icon : `fa-solid ${this.CELLS[c] ?? ""}`;
        const tip = task ? game.i18n.localize(task.label) : this.i18n(`cell.${c}`);
        const night = pick && (h >= plan.setup) && (h < plan.setup + plan.night);
        return `<td class="cell ${task ? "task" : c} ${(h < plan.setup) ? "setup" : ""} ${(run && (h === run.hour)) ? "now" : ""} ${night ? "pick" : ""}"
          ${night ? `data-hour="${h - plan.setup}" data-watch="${c === "watch"}"` : ""} data-tooltip="${e(night ? `${tip}<br>${this.i18n((c === "watch") ? "rotaOff" : "rotaOn")}` : tip)}">${icon.trim() ? `<i class="${icon}" inert></i>` : ""}</td>`;
      }).join("")}</tr>`;
    }).join("");
    const reset = (plan.edited && !run) ? `<button type="button" class="rota-reset" data-tooltip="${e(this.i18n("rotaResetHint"))}" ${off(this.canRun(group))}><i class="fa-solid fa-rotate-left" inert></i> ${this.i18n("rotaReset")}</button>` : "";
    const rota = `<section class="rota"><h3>${this.i18n("rota")} <span class="hint">${this.i18n("length", { setup : plan.setup, night : plan.night, from : at(0), to : at(plan.total) })}</span> ${reset}</h3>
        <div class="grid"><table><thead><tr><th></th>${heads}</tr></thead><tbody>${rotaRows}</tbody></table></div></section>`;
    const s = this.supplies(group, camp);
    const short = (have, need) => (have < need) ? "over" : "";
    const supplies = `<p class="supplies">
        <span class="${short(s.food.rations + s.food.feed, s.food.need)}"><i class="fa-solid fa-drumstick-bite" inert></i> ${this.i18n("foodLine", { need : s.food.need, have : s.food.rations, feed : s.food.feed })}</span>
        <span class="${short(s.water.skins, s.water.need)}"><i class="fa-solid fa-droplet" inert></i> ${this.i18n("waterLine", { need : s.water.need, have : Math.round(s.water.skins * 100) / 100 })}</span></p>`;
    const buttons = !run ? [["make", "fa-tents"]] : run.paused ? [["resume", "fa-play"], ["break", "fa-person-walking-arrow-right"]]
      : [["step", "fa-forward-step"], ["finish", "fa-forward-fast"], ["stop", "fa-bell"], ["break", "fa-person-walking-arrow-right"]];
    const control = () => this.canRun(group);
    return `${where}${members}${rota}${supplies}
      ${run?.paused ? `<p class="paused over"><i class="fa-solid fa-pause" inert></i> ${this.i18n("paused")}</p>` : ""}
      <footer class="form-footer">${buttons.map(([op, icon]) =>
        `<button type="button" data-op="${op}" ${off(control(op))}><i class="fa-solid ${icon}" inert></i> ${this.i18n(`button.${op}`)}</button>`).join("")}</footer>`;
  }

  static listen(group, content){
    const send = data => gm.run("groupCamp", { group : group.uuid, ...data });
    for(const input of content.querySelectorAll(".members tr[data-id] [data-key]")){
      input.addEventListener("change", () => send({ op : "row", id : input.closest("tr").dataset.id,
        changes : { [input.dataset.key] : (input.type === "checkbox") ? input.checked : input.value } }));
    }
    for(const input of content.querySelectorAll(".where [name]")){
      input.addEventListener("change", () => send({ op : "plan", changes : { [input.name] : (input.type === "checkbox") ? input.checked : input.value } }));
    }
    for(const cell of content.querySelectorAll(".rota td.pick")){
      cell.addEventListener("click", () => send({ op : "rota", id : cell.closest("tr").dataset.id, hour : Number(cell.dataset.hour), watch : cell.dataset.watch !== "true" }));
    }
    content.querySelector(".rota-reset")?.addEventListener("click", () => send({ op : "rota", reset : true }));
    for(const button of content.querySelectorAll("footer [data-op]")){
      button.addEventListener("click", () => {
        if(button.dataset.op === "stop") return this.stopWindow(group);
        button.disabled = true;
        send({ op : button.dataset.op });
      });
    }
  }
}
