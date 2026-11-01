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
 *   Where : the terrain and the Foraging DC (setting campForageDC : 2024 DMG Travel Terrain; 2014 DMG by abundance;
 *   combined : the terrain's DC, food and water each by abundance), water nearby (everyone drinks for free, every
 *   waterskin is filled), food nearby (everyone eats for free), grazing (Beasts eat for free), or an inn (2024 PHB Food,
 *   Drink, and Lodging : a night's stay by lifestyle and a meal for those eating the inn's, a Beast's stabling and feed,
 *   paid by the member picked on each row; water and shelter included, no watch, no tasks).
 *   Plan : each member Rests or not, a Task for the setting-up hours (Forage, RAW; homebrew : Forage food only, Gather
 *   Water, Hunt, Preserve; more through campTask), stands Watch or not (not a Beast unless the GM ticks it), eats and
 *   drinks from : Automatic (free when nearby, what was found, then its own : a Beast's feed first, Rations; then what
 *   members share with it, then the pack animals' and vehicles'), What's found, Own stores, Free (nearby), the inn, or
 *   Nothing; a Full or Half portion (2024 PHB : half or more is no Malnutrition / Dehydration); shares its stores with
 *   no one, everyone or one member. A Forager on the road (the Members tab's job) forages once, at Make Camp, without
 *   a task (2024 DMG : foraging is done while travelling, once a day).
 *   The rota : the rest lasts as long as the longest rest among the members resting (2024 Elf Trance : 4 h), longer
 *   when the watchers can't cover every hour (a Long Rest allows 2 hours of light activity, standing watch among them;
 *   hours past one's own rest are free), or what the GM typed. A member resting with no task rests from the start, the
 *   others once the setting-up hours are done. Hours are handed out in the members' order.
 *   Running : Next Hour / To the End move the clock; sleepers are Unconscious (2024 PHB : during sleep), taken off when
 *   they wake (watch, the end). Setting up done : the tasks' finds (a success : 1d6 + WIS mod lb of food and as many
 *   gallons of water, 2024 DMG Foraging), shared out (each eater's need by default; the GM, the Leader's player or a
 *   finder's owner changes it; Eat goes on), then the meal (each member's daily food and water by size, 2024 PHB
 *   Malnutrition / Dehydration). What's left of the water fills the waterskins; the food left spoils, unless a task
 *   takes it (Preserve : Rations). Each member's meal is kept on it (flag fed) for the day's-end rules to come.
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
 *       setting up is done (return { food, water, lines, finders } : added to what's found), leftover after the meal
 *       (return { food (lb used), lines }), finish after the rests.
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
  static SOURCES = ["auto", "found", "own", "free", "none"];
  static INN_SOURCES = ["inn", "own", "none"];
  static PORTIONS = { full : 1, half : 0.5 };
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
    return { plan : { setup : 1, terrain : "forest", watch : true, night : null, water : false, food : false, grazing : false, lodging : "none",
      abundance : "limited", foodAbundance : "limited", waterAbundance : "limited", ...(camp.plan ?? {}) },
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

  /* A member's row : rests, task, watch (the players' creatures; a Beast only when the GM ticked it), food / water
     sources, portion, who it shares its stores with, who pays */
  static rowOf(camp, actor, group = null){
    const saved = camp.rows[actor.id] ?? {};
    const row = { rest : true, task : "none", watch : !!actor.hasPlayerOwner && !this.isBeast(actor), food : "auto", water : "auto", portion : "full", shares : "none", payer : null, ...saved };
    /* Rows saved before sources : eat / drink ticks */
    if((saved.eat === false) && !("food" in saved)) row.food = "none";
    if((saved.drink === false) && !("water" in saved)) row.water = "none";
    /* A Beast's watch from before the GM's tick (rows saved before Beasts were kept off watch) */
    if(this.isBeast(actor) && !saved.watchGM) row.watch = false;
    const inn = this.atInn(camp.plan);
    for(const kind of ["food", "water"]) if(!this.sourcesFor(camp.plan, actor, kind).includes(row[kind])) row[kind] = inn ? "inn" : "auto";
    if(!(row.portion in this.PORTIONS)) row.portion = "full";
    if(group && !["none", "all"].includes(row.shares) && ((row.shares === actor.id) || !groupTravel.memberActor(group, row.shares))) row.shares = "none";
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

  /* A member's daily need (2024 PHB, by size), at its portion */
  static portionOf(actor, row){
    return this.need(actor) * (this.PORTIONS[row.portion] ?? 1);
  }

  /* The members sharing their stores with this one */
  static givers(group, camp, actor){
    return this.members(group).filter(a => (a !== actor) && [actor.id, "all"].includes(this.rowOf(camp, a, group).shares));
  }

  /* Free food here for that member : food nearby, or grazing for a Beast */
  static freeFood(plan, actor){
    return !!plan.food || (!!plan.grazing && this.isBeast(actor));
  }

  static sourcesFor(plan, actor, kind){
    if(this.atInn(plan)) return this.INN_SOURCES;
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
    return { setup, night, total, rows };
  }

  /* What the members need and what they carry : { food : { need, rations, feed }, water : { need, skins } } */
  static supplies(group, camp = this.campOf(group)){
    const rows = this.members(group).map(a => ({ a, row : this.rowOf(camp, a, group) }));
    const holders = [...new Set([...rows.map(r => r.a), ...groupInventory.packs(group)])];
    const need = (key, free) => rows.filter(r => !["none", "free", "inn"].includes(r.row[key]) && !free(r.a)).reduce((s, r) => s + this.portionOf(r.a, r.row), 0);
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
          if("watch" in c){
            clean.watch = !!c.watch && (!this.isBeast(actor) || user.isGM);
            if(this.isBeast(actor)) clean.watchGM = clean.watch;
          }
          if("task" in c) clean.task = this.taskOffered(camp, c.task, actor, group) ? c.task : "none";
          for(const kind of ["food", "water"]) if((kind in c) && this.sourcesFor(camp.plan, actor, kind).includes(c[kind])) clean[kind] = c[kind];
          if(("portion" in c) && (c.portion in this.PORTIONS)) clean.portion = c.portion;
          if(("shares" in c) && (["none", "all"].includes(c.shares) || ((c.shares !== actor.id) && groupTravel.memberActor(group, c.shares)))) clean.shares = c.shares;
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
          for(const key of ["abundance", "foodAbundance", "waterAbundance"]) if((key in c) && (c[key] in this.ABUNDANCE)) clean[key] = c[key];
          if(("lodging" in c) && ((c.lodging === "none") || (c.lodging in this.LODGING))) clean.lodging = c.lodging;
          if("night" in c) clean.night = (Number(c.night) > 0) ? Math.min(48, Math.round(Number(c.night))) : null;
          await group.update({ [`flags.${module.id}.camp.plan`] : clean });
          return true;
        }
        case "make" : return (!camp.run && this.canRun(group, user)) ? this.make(group, camp) : false;
        case "step" : return (camp.run && !camp.run.paused && !camp.run.share && this.canRun(group, user)) ? this.step(group, 1) : false;
        case "finish" : return (camp.run && !camp.run.paused && !camp.run.share && this.canRun(group, user)) ? this.step(group, Infinity) : false;
        case "alloc" : {
          const share = camp.run?.share;
          const actor = groupTravel.memberActor(group, data.id);
          if(!share || !actor || !this.canShare(group, camp, user)) return false;
          const others = kind => Object.entries(share.alloc).filter(([id]) => id !== actor.id).reduce((s, [, a]) => s + (Number(a[kind]) || 0), 0);
          const clean = {};
          for(const kind of ["food", "water"]) if(kind in (data.changes ?? {})){
            clean[kind] = Math.round(Math.min(Math.max(0, Number(data.changes[kind]) || 0), Math.max(0, share[kind] - others(kind))) * 100) / 100;
          }
          await group.update({ [`flags.${module.id}.camp.run.share.alloc.${actor.id}`] : clean });
          return true;
        }
        case "eat" : return (camp.run?.share && this.canShare(group, camp, user)) ? this.eat(group) : false;
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
      if(!camp.run || camp.run.paused || camp.run.share) return true;
      const plan = this.schedule(group, camp);
      if(camp.run.hour >= plan.total) return this.end(group, true);
      await game.time.advance(groupTravel.secondsPerHour());
      const hour = camp.run.hour + 1;
      await group.update({ [`flags.${module.id}.camp.run.hour`] : hour });
      if((hour >= plan.setup) && !camp.run.fed && !camp.run.share) await this.nightStarts(group);
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

  /* Setting up done : the tasks' finds, shared out (Eat goes on), else straight to the meal */
  static async nightStarts(group){
    const camp = this.campOf(group);
    const plan = this.schedule(group, camp);
    const pool = { food : 0, water : 0 };
    const lines = [], finders = [];
    for(const [id, task] of tasks){
      const actors = this.taskActors(group, plan, id);
      if(!actors.length || !task.collect) continue;
      try {
        const found = (await task.collect({ group, actors, data : camp.run.data?.[id] ?? null, camp })) ?? {};
        pool.food += Number(found.food) || 0;
        pool.water += Number(found.water) || 0;
        lines.push(...(found.lines ?? []));
        finders.push(...(found.finders ?? []).map(a => a.id));
      } catch(err) { log.error(`Camp task ${id} :`, err); }
    }
    if(lines.length) await this.postLog(group, "found", { lines : [...lines, ...((pool.food + pool.water > 0) ? [this.i18n("shareHint")] : [])] });
    if(pool.food + pool.water <= 0) return this.eat(group);
    await group.update({ [`flags.${module.id}.camp.run.share`] : { ...pool, finders : [...new Set(finders)], alloc : this.shareOut(group, camp, plan, pool) } });
    return true;
  }

  /* What's found, by default : each member eating it gets its need (its portion), in the members' order */
  static shareOut(group, camp, plan, pool){
    const left = { ...pool }, alloc = {};
    for(const { actor, row } of plan.rows){
      const take = {};
      for(const kind of ["food", "water"]){
        if(!["auto", "found"].includes(this.sourceOf(camp.plan, actor, row, kind))) continue;
        take[kind] = Math.round(Math.min(left[kind], this.portionOf(actor, row)) * 100) / 100;
        left[kind] -= take[kind];
      }
      alloc[actor.id] = take;
    }
    return alloc;
  }

  /* Where a member's food or water comes from : Automatic is free when it's free here */
  static sourceOf(plan, actor, row, kind){
    if(row[kind] !== "auto") return row[kind];
    return ((kind === "food") ? this.freeFood(plan, actor) : !!plan.water) ? "free" : "auto";
  }

  /* Who shares out what's found : the camp's runner, or a finder's owner */
  static canShare(group, camp, user = game.user){
    return this.canRun(group, user) || (camp.run?.share?.finders ?? []).some(id => groupTravel.memberActor(group, id)?.testUserPermission(user, "OWNER"));
  }

  /* The meal, with what's found as shared out */
  static async eat(group){
    const camp = this.campOf(group);
    if(!camp.run || camp.run.fed) return false;
    const plan = this.schedule(group, camp);
    const lines = await this.meal(group, camp, plan, camp.run.share ?? { food : 0, water : 0, alloc : {} });
    await group.update({ [`flags.${module.id}.camp.run.fed`] : true });
    if(camp.run.share) await group.unsetFlag(module.id, "camp.run.share");
    await this.postLog(group, "meal", { lines });
    return true;
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

  /* Each member's food and water (its portion) from where its row says : what's found as shared out first, then its
     own stores, then what members share with it, then the pack animals' and vehicles' */
  static async meal(group, camp, plan, share){
    const lines = [];
    const shared = groupInventory.packs(group);
    const round = n => Math.round(n * 100) / 100;
    const pool = { food : Number(share.food) || 0, water : Number(share.water) || 0 };
    for(const { actor, row } of plan.rows){
      const full = this.need(actor), need = this.portionOf(actor, row);
      const holders = [...new Set([actor, ...this.givers(group, camp, actor), ...shared])];
      const mine = share.alloc?.[actor.id] ?? {};
      const fromFound = kind => { const n = Math.min(Number(mine[kind]) || 0, need, pool[kind]); pool[kind] -= n; return n; };
      let food = 0, water = 0;
      const foodFrom = this.sourceOf(camp.plan, actor, row, "food");
      if(["free", "inn"].includes(foodFrom)) food = need;
      else if(foodFrom !== "none") food += fromFound("food");
      if(["auto", "own"].includes(foodFrom) && (food < need)){
        /* A day of feed covers an animal's day; a Ration covers 1 lb */
        if(this.isBeast(actor) && (await this.useUp(holders.flatMap(a => this.feed(a)), 1, 1))) food = need;
        else food += await this.useUp(holders.flatMap(a => this.rations(a)), need - food, 1);
      }
      const waterFrom = this.sourceOf(camp.plan, actor, row, "water");
      if(["free", "inn"].includes(waterFrom)) water = need;
      else if(waterFrom !== "none") water += fromFound("water");
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
      await actor.setFlag(module.id, "fed", { at : game.time.worldTime, food, needFood : full, water, needWater : full, portion : row.portion });
      /* 2024 PHB : less than half the day's need is Malnutrition / Dehydration */
      const part = (got, from, key) => (from === "none") ? `<span class="none">${this.i18n(`${key}None`)}</span>`
        : `<span class="${(got < full / 2) ? "over" : ""}">${this.i18n(key, { got, need : full })}${["free", "inn"].includes(from) ? ` (${this.i18n(`source.${from}`)})` : ""}</span>`;
      lines.push(`${this.esc(actor.name)} : ${part(food, foodFrom, "ate")}, ${part(water, waterFrom, "drank")}${(row.portion === "half") ? ` (${this.i18n("portion.half")})` : ""}`);
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
    /* The food left : a task may take it (Preserve), else it spoils */
    for(const [id, task] of tasks){
      if((pool.food < 0.01) || !task.leftover) continue;
      const actors = this.taskActors(group, plan, id);
      if(!actors.length) continue;
      try {
        const kept = (await task.leftover({ group, actors, food : round(pool.food), camp })) ?? {};
        pool.food -= Number(kept.food) || 0;
        lines.push(...(kept.lines ?? []));
      } catch(err) { log.error(`Camp task ${id} :`, err); }
    }
    if(pool.food >= 0.01) lines.push(this.i18n("spoils", { food : round(pool.food) }));
    return lines;
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
    foundry.utils.mergeObject(source, { "system.quantity" : count, "system.identifier" : "rations", "system.container" : null });
    return actor.createEmbeddedDocuments("Item", [source]);
  }

  /* The camp ends : sleepers wake, the rests, the tasks' finish, the log */
  static async end(group, done){
    const camp = this.campOf(group);
    if(!camp.run) return false;
    const plan = this.schedule(group, camp);
    await this.statuses(group, true);
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
        <div class="line">${inn ? `<span class="hint">${this.i18n("innHint")}</span>` : `${toggle("water", "fa-water", "nearWater")}${toggle("food", "fa-apple-whole", "nearFood")}${toggle("grazing", "fa-wheat-awn", "grazing")}`}</div>
        <div class="line">${inn ? "" : `<label>${this.i18n("setup")} <input type="number" name="setup" min="0" max="24" step="1" value="${plan.setup}" ${off(planner)}></label>
          <label><input type="checkbox" name="watch" ${camp.plan.watch ? "checked" : ""} ${off(planner)}> ${this.i18n("keepWatch")}</label>`}
          <label data-tooltip="${e(this.i18n("nightHint"))}">${this.i18n("night")} <input type="number" name="night" min="1" max="48" step="1" value="${plan.night}" ${off(planner)}></label></div>
      </section>`;
    const payers = this.members(group).filter(a => a.hasPlayerOwner && !this.isBeast(a));
    const packs = groupInventory.packs(group);
    const memberRows = plan.rows.map(r => {
      const edit = !run && this.canEdit(group, r.actor);
      const box = (key, allowed = true) => `<input type="checkbox" data-key="${key}" ${r.row[key] ? "checked" : ""} ${off(edit && allowed)}>`;
      const tasksHere = this.offered(camp, r.actor, group);
      const road = (!inn && this.roadForager(group, r.actor)) ? `<i class="fa-solid fa-seedling road" data-tooltip="${e(this.i18n("roadHint"))}" inert></i>` : "";
      const task = inn ? `<span class="hint">—</span>` : `${road}<select data-key="task" ${off(edit && tasksHere.length)}>${options([["none", this.i18n("task.none")], ...tasksHere.map(t => [t.id, game.i18n.localize(t.label)])], r.row.task)}</select>`;
      const source = kind => `<select data-key="${kind}" ${off(edit)}>${options(this.sourcesFor(camp.plan, r.actor, kind).map(s => [s, this.i18n(`source.${s}`)]), r.row[kind])}</select>`;
      const portion = `<select data-key="portion" ${off(edit)} data-tooltip="${e(this.i18n("portionHint"))}">${options(Object.keys(this.PORTIONS).map(k => [k, this.i18n(`portion.${k}`)]), r.row.portion)}</select>`;
      const shares = packs.includes(r.actor) ? `<span class="hint" data-tooltip="${e(this.i18n("packHint"))}">${this.i18n("shares.pack")}</span>`
        : `<select data-key="shares" ${off(edit)}>${options([["none", this.i18n("shares.none")], ["all", this.i18n("shares.all")],
          ...plan.rows.filter(o => o.actor !== r.actor).map(o => [o.actor.id, o.actor.name])], r.row.shares)}</select>`;
      const payer = inn ? `<td><select data-key="payer" ${off(edit)}>${options([...new Set([r.actor, ...payers])].map(a => [a.id, a.name]), r.row.payer)}</select></td>` : "";
      const summary = r.row.rest ? (r.short ? this.i18n("sumShort", { rest : r.sleep, watch : r.watch, source : r.source?.name ?? "" }) : this.i18n("sum", { sleep : r.sleep, watch : r.watch }))
        : this.i18n("sumOut", { watch : r.watch });
      return `<tr data-id="${r.actor.id}">
        <td class="who"><img src="${e(r.actor.img)}" alt=""><span>${e(r.actor.name)}</span></td>
        <td>${box("rest")}</td><td class="task">${task}</td>
        ${inn ? "" : `<td>${box("watch", !this.isBeast(r.actor) || game.user.isGM)}</td>`}
        <td>${source("food")}</td><td>${source("water")}</td><td>${portion}</td><td>${shares}</td>${payer}
        <td class="sum ${r.full ? "" : "over"}" data-tooltip="${e(this.i18n(r.full ? "full" : "notFull"))}"><i class="fa-solid ${r.full ? "fa-check" : "fa-triangle-exclamation"}" inert></i> ${e(summary)}</td></tr>`;
    }).join("");
    const members = `<section class="members"><h3>${this.i18n("membersLabel")}</h3><table>
        <thead><tr><th></th><th>${this.i18n("rests")}</th><th>${this.i18n("taskLabel")}</th>${inn ? "" : `<th>${this.i18n("watchLabel")}</th>`}
          <th>${this.i18n("eat")}</th><th>${this.i18n("drink")}</th><th>${this.i18n("portionLabel")}</th><th>${this.i18n("sharesLabel")}</th>
          ${inn ? `<th>${this.i18n("pays")}</th>` : ""}<th>${this.i18n("restLabel")}</th></tr></thead>
        <tbody>${memberRows}</tbody></table></section>`;
    /* What's found, being shared out before the meal */
    let found = "";
    if(run?.share){
      const share = run.share;
      const given = kind => Object.values(share.alloc ?? {}).reduce((s, a) => s + (Number(a[kind]) || 0), 0);
      const round = n => Math.round(n * 100) / 100;
      const edit = this.canShare(group, camp);
      const cells = plan.rows.map(r => {
        const mine = share.alloc?.[r.actor.id] ?? {};
        const input = kind => `<input type="number" data-kind="${kind}" min="0" step="0.25" value="${round(Number(mine[kind]) || 0)}" ${off(edit && (share[kind] > 0))}>`;
        return `<tr data-id="${r.actor.id}"><td class="who"><img src="${e(r.actor.img)}" alt=""><span>${e(r.actor.name)}</span></td>
          <td>${input("food")} ${this.i18n("lb")}</td><td>${input("water")} ${this.i18n("gal")}</td>
          <td class="hint">${this.i18n("needs", { need : round(this.portionOf(r.actor, r.row)) })}</td></tr>`;
      }).join("");
      found = `<section class="found"><h3>${this.i18n("foundLabel")} <span class="hint">${this.i18n("foundLine", { food : round(share.food), water : round(share.water),
          foodLeft : round(share.food - given("food")), waterLeft : round(share.water - given("water")) })}</span></h3>
        <table><thead><tr><th></th><th>${this.i18n("foodHead")}</th><th>${this.i18n("waterHead")}</th><th></th></tr></thead><tbody>${cells}</tbody></table>
        <p class="hint">${this.i18n("shareHint")}</p></section>`;
    }
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
    const supplies = `<p class="supplies">
        <span class="${short(s.food.rations + s.food.feed, s.food.need)}"><i class="fa-solid fa-drumstick-bite" inert></i> ${this.i18n("foodLine", { need : s.food.need, have : s.food.rations, feed : s.food.feed })}</span>
        <span class="${short(s.water.skins, s.water.need)}"><i class="fa-solid fa-droplet" inert></i> ${this.i18n("waterLine", { need : s.water.need, have : Math.round(s.water.skins * 100) / 100 })}</span></p>`;
    const buttons = !run ? [["make", "fa-tents"]] : run.paused ? [["resume", "fa-play"], ["break", "fa-person-walking-arrow-right"]]
      : run.share ? [["eat", "fa-utensils"], ["stop", "fa-bell"], ["break", "fa-person-walking-arrow-right"]]
      : [["step", "fa-forward-step"], ["finish", "fa-forward-fast"], ["stop", "fa-bell"], ["break", "fa-person-walking-arrow-right"]];
    const control = op => (op === "eat") ? this.canShare(group, camp) : this.canRun(group);
    return `${where}${members}${found}${rota}${supplies}
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
    for(const input of content.querySelectorAll(".found tr[data-id] [data-kind]")){
      input.addEventListener("change", () => send({ op : "alloc", id : input.closest("tr").dataset.id, changes : { [input.dataset.kind] : input.value } }));
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
