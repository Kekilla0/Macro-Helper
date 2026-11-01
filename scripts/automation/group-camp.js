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
import { idOf } from '../helpers/utils.js';
const log = logger.for(import.meta.url);

/**
 * Group Travel : Camp (the group sheet's Camp button; the GM or the Leader's player runs it, everyone in the group sees
 * it and sets their own creatures' rows).
 *   Where : the terrain and the Foraging DC (setting campForageDC : 2024 DMG Travel Terrain; 2014 DMG by abundance;
 *   combined : the terrain's DC, food and water each by abundance), water nearby (everyone drinks for free, every
 *   waterskin is filled), food nearby (everyone eats for free), grazing (Beasts eat for free), or an inn (2024 PHB Food,
 *   Drink, and Lodging : a night's stay by lifestyle and a meal for those eating the inn's, a Beast's stabling and feed,
 *   paid by the member picked on each row; water and shelter included, no watch, no tasks).
 *   Plan : each member ticks what it does (icons) : Rest, Watch (not a Beast unless the GM ticks it), and any number of
 *   tasks (Forage, RAW; homebrew Camp Tasks : Forage food only, Gather Water, Hunt, Build a Fire, Preserve; Make Shelter;
 *   more through campTask), an hour each; at an inn, eats the inn's meal or its own (no watch, no tasks). A Beast may
 *   only Forage, for itself, and only with a keen sense (a "Keen ..." feature) or Perception proficiency. A Forager on
 *   the road (the Members tab's job) forages once in the first hour without a task (2024 DMG : once a day, travelling).
 *   The rota : each member's tasks first (in the order ticked), then its rest (2024 Elf Trance : 4 h), then awake;
 *   watches spread over the watchers (a Long Rest allows 2 hours of light activity, a watch or a task in it among them;
 *   hours past one's own rest are free). A cell clicked cycles through that member's own picks (its tasks, Watch, Rest) :
 *   the rota as it stands is kept from then on (nothing filled or spread again : the players' choice, no watch is no
 *   watch), a task moved there swapping with its old hour (flag camp.rota { actorId : { hour : "task:id" | "watch" |
 *   "sleep" } }; Auto-fill forgets it); a task with no hour then isn't done until clicked into one. A right-click on an
 *   awake hour : it eats at the end of that one (flag camp.meals { actorId : hour }; once made, camp.run.rows.*.meal). The camp lasts as long as the members' picks need, or exactly the hours the GM typed (a
 *   rest it cuts short is warned of, not refused). Make Camp freezes the rota (flag camp.run.rows { actorId : { cells,
 *   restStart } }); its future hours may still be changed (a task clicked into a later hour swaps with it).
 *   A task's check (a request card) starts as its hour does and is collected as it ends; missing the DC by less than 5
 *   lets that member put the task in a later hour again (a retry), by 5 or more (or a success) not (flag
 *   camp.run.outcomes). The Camp window opens for every player with a member, and the GM, at Make Camp.
 *   Running : Next Hour / To the End move the clock; sleepers are Unconscious (2024 PHB : during sleep), taken off when
 *   they wake (watch, a task, the end). A task's finds (a success : 1d6 + WIS mod lb of food and as many gallons of water,
 *   2024 DMG Foraging) : the food a "Foraged food" item given to the member new items go to (a Beast keeps its own; it
 *   spoils at midnight); the water drunk at once up to each member's need, then filling the waterskins, the rest lost
 *   (water nearby or at an inn : all of it at Make Camp, every waterskin full). Each member eats at the end of its last
 *   awake hour before it first sleeps (never sleeping : after its last task; sleeping from the start : at Make Camp) :
 *   the Meal window (group-meal.js), free food nearby (grazing : Beasts) and the inn's meal among its sources. Food that
 *   would spoil (at midnight, or when the camp ends) is first offered to a task (leftover).
 *   Build a Fire (homebrew Camp Tasks; a Tinderbox, its own or a pack's, or a spell that lights one) : a Wisdom (Survival)
 *   check at the terrain's Foraging DC (gathering firewood), light rain or snow +2 to the DC, heavy +4, unless the camp
 *   has shelter (natural, a tent, one built); heavy rain or strong wind put it out (and keep it out). Preserve (homebrew Camp Tasks) : a Cook's Utensils
 *   check, DC 10 (proficiency as dnd5e adds it, Advantage carrying them), the DC moved by heavy rain or snow or a
 *   sandstorm +4, light rain or snow or strong wind +2 (none with shelter), Extreme Heat +2, Extreme Cold -2, a
 *   fire lit -2 (all together at most 4 either way); a success turns up to 6 lb of the group's spoiling food (not made
 *   by magic) into 3 Rations (2 lb each, parts too); a failure none (homebrew Partial preserving : 20% fewer for each
 *   point missed, a natural 1 none). The Rations cure for 7 hours (flag curing; they don't spoil, the GM may spoil them
 *   from the Camp window), then join the cook's stack.
 *   Weather (group-weather.js) : each camp hour brings Extreme Cold / Heat saves for the exposed. Sheltered : at an inn,
 *   in the camp's natural shelter (Where), the Members tab's ticks, a tent's place (a tent anywhere in the group : a member,
 *   a mount, a vehicle, the group itself; set up at once) or, from the hour after, one in a shelter built (Make
 *   Shelter : a Wisdom (Survival) check at the terrain's Foraging DC, Advantage with Carpenter's or Woodcarver's Tools
 *   carried and proficient in both (2024 PHB Tools); a success : two Small or Medium places).
 *   Interruptions (2024 PHB Long Rest) : Interrupt (the GM picks who; they wake) or rolling Initiative pauses the camp
 *   (Resume goes on, sleepers back to sleep); each, damage, or a spell other than a cantrip adds an hour to that member's
 *   rest. Moving the Group's token is refused while camping.
 *   The end : dnd5e's Long Rest for each member whose rest is done (one a day : rest-limit.js, checked when the camp is
 *   made); Break Camp : a Short Rest request card (each player's own rest window) for those who rested an hour or more.
 *
 *   campTask(id, { label, hint (its tooltip : what it does), icon, homebrew, beast(actor), applies(actor, group), available({ group, plan }), start({ group,
 *     actors, camp, hour }), collect({ group, actors, data, camp, hour }), leftover({ group, actors, food, camp }),
 *     finish({ group, actors, data, camp, rested }) })
 *       a task of an hour : start as its hour does, for the members working it then (its return is kept as data), collect
 *       as the hour ends (return { food, water, lines, outcomes : { actorId : "ok" | "fail" | "abject" } } : food and
 *       water added to what's found; outcomes : who may retry, none given : nobody), leftover when the group's spoiling
 *       food (not made by magic) would spoil (return { food (lb used), lines }), finish after the rests (data : the
 *       first hour's). beast : a Beast may take it when this says so (else no Beast).
 */
const tasks = new Map();

export function campTask(id, { label, hint = "", icon = "fa-solid fa-person-digging", homebrew = false, beast = null, applies = null, available = null, start = null, collect = null, leftover = null, finish = null } = {}){
  if(!id || (id === "none")) return;
  tasks.set(id, { id, label : label ?? id, hint, icon, homebrew, beast, applies, available, start, collect, leftover, finish });
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
    campTask("forage", { label : "groupTravel.camp.task.forage", hint : "groupTravel.camp.task.forageHint", icon : "fa-solid fa-seedling", available : ({ plan }) => !(plan.food && (plan.water || this.homebrewTasks())),
      beast : actor => this.keenBeast(actor), applies : (actor, group) => !this.roadForager(group, actor), ...survey("forage", forage) });
    campTask("water", { label : "groupTravel.camp.task.water", hint : "groupTravel.camp.task.waterHint", icon : "fa-solid fa-bucket", homebrew : true, available : ({ plan }) => !plan.water, ...survey("water", () => "water") });
    campTask("hunt", { label : "groupTravel.camp.task.hunt", hint : "groupTravel.camp.task.huntHint", icon : "fa-solid fa-crosshairs", homebrew : true, available : ({ plan }) => !plan.food, ...survey("hunt", () => "food") });
    campTask("shelter", { label : "groupTravel.camp.task.shelter", hint : "groupTravel.camp.task.shelterHint", icon : "fa-solid fa-person-shelter", available : ({ plan }) => !plan.shelter,
      start : data => this.shelterStart(data), collect : data => this.shelterCollect(data) });
    campTask("fire", { label : "groupTravel.camp.task.fire", hint : "groupTravel.camp.task.fireHint", icon : "fa-solid fa-fire", homebrew : true, applies : (actor, group) => this.canLight(actor, group),
      start : data => this.fireStart(data), collect : data => this.fireCollect(data) });
    campTask("preserve", { label : "groupTravel.camp.task.preserve", hint : "groupTravel.camp.task.preserveHint", icon : "fa-solid fa-jar", homebrew : true, late : true,
      start : data => this.preserveStart(data), collect : data => this.preserveCollect(data) });
    Hooks.on("renderActorSheetV2", (app, html) => this.renderHeader(app, html));
    Hooks.on("updateActor", (actor, changes) => this.changed(actor, changes));
    Hooks.on("updateWorldTime", () => { this.redraw(); this.cureDue(); });
    Hooks.on("updateActor", (actor, changes) => this.opened(actor, changes));
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
    return { plan : { terrain : "forest", watch : true, night : null, water : false, food : false, grazing : false, shelter : false, lodging : "none",
      abundance : "limited", foodAbundance : "limited", waterAbundance : "limited", ...(camp.plan ?? {}) },
      rows : camp.rows ?? {}, rota : camp.rota ?? {}, meals : camp.meals ?? {}, run : camp.run ?? null };
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

  /* A member's row : rests, tasks (in the order ticked), watch (the players' creatures; a Beast only when the GM ticked
     it), at an inn the inn's meal or its own food, who pays */
  static rowOf(camp, actor, group = null){
    const saved = camp.rows[actor.id] ?? {};
    const row = { rest : true, watch : !!actor.hasPlayerOwner && !this.isBeast(actor), food : "inn", payer : null, ...saved };
    /* One task a row, before any number */
    row.tasks = Array.isArray(saved.tasks) ? [...saved.tasks] : (saved.task && (saved.task !== "none")) ? [saved.task] : [];
    delete row.task; delete row.late;
    /* A Beast's watch from before the GM's tick (rows saved before Beasts were kept off watch) */
    if(this.isBeast(actor) && !saved.watchGM) row.watch = false;
    if(!this.INN_SOURCES.includes(row.food)) row.food = "inn";
    if(group) row.tasks = row.tasks.filter(id => this.taskOffered(camp, id, actor, group));
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

  /* A Beast that can find its own food : a keen sense ("Keen Smell", "Keen Hearing and Smell"...) or Perception proficiency */
  static keenBeast(actor){
    return actor.items.some(i => (i.type === "feat") && /^keen[- ]/i.test(idOf(i) || i.name)) || (Number(actor.system.skills?.prc?.value) >= 1);
  }

  /* The tasks this member may take here (none at an inn; a Beast : those that allow it) */
  static offered(camp, actor, group){
    if(this.atInn(camp.plan)) return [];
    return [...tasks.values()].filter(t => (!t.homebrew || this.homebrewTasks()) && (!t.available || t.available({ group, plan : camp.plan }))
      && (!this.isBeast(actor) || !!t.beast?.(actor)) && (!t.applies || t.applies(actor, group)));
  }

  static taskOffered(camp, id, actor, group){
    return this.offered(camp, actor, group).some(t => t.id === id);
  }

  /* Who works a task in that hour (null : in any), and for Forage in the first hour the Foragers on the road too */
  static taskActors(group, plan, id, hour = null){
    const actors = plan.rows.filter(r => (hour === null) ? r.cells.includes(`task:${id}`) : (r.cells[hour] === `task:${id}`)).map(r => r.actor);
    if(((hour === null) || (hour === 0)) && (id === "forage") && !this.atInn(this.campOf(group).plan)) actors.push(...plan.rows.filter(r => this.roadForager(group, r.actor) && !actors.includes(r.actor)).map(r => r.actor));
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
   * Hour by hour, from the camp's start : { night (the hours the picks need, or the GM's), total, rows : [{ actor, row,
   * hours (rest), short (a shortened rest : Trance), restStart, cells, restEnd, sleep, watch, full, meal (the hour it
   * eats at the end of; -1 : at Make Camp) }], unwatched (hours), edited (hours placed by hand) }. Cells : "task:<id>",
   * "awake", "watch", "sleep", "trance", "out" (not resting, not watching). Once the camp is made, its frozen rows.
   */
  static schedule(group, camp = this.campOf(group)){
    const inn = this.atInn(camp.plan);
    const rows = this.members(group).map(actor => {
      const row = this.rowOf(camp, actor, group);
      const { minutes, source } = restMinutesOf(actor, "long");
      const hours = Math.max(1, Math.ceil(minutes / 60));
      return { actor, row, hours, short : !!source, source, allowance : Math.min(2, Math.max(0, hours - 6)) };
    });
    const watchers = (camp.plan.watch && !inn) ? rows.filter(r => r.row.watch) : [];
    let night, edited = false;
    if(camp.run?.rows){
      for(const r of rows){
        const frozen = camp.run.rows[r.actor.id] ?? {};
        r.cells = [...(frozen.cells ?? [])];
        r.restStart = frozen.restStart ?? 0;
        r.mealAt = frozen.meal;
      }
      night = Math.max(1, ...rows.map(r => r.cells.length));
    }
    else {
      ({ night, edited } = this.plan(camp, rows, watchers));
      for(const r of rows) r.mealAt = camp.meals?.[r.actor.id];
      edited ||= !foundry.utils.isEmpty(camp.meals ?? {});
    }
    for(const r of rows){
      while(r.cells.length < night) r.cells.push(r.row.rest ? "awake" : "out");
      this.restOf(r);
    }
    /* Hours with no one on watch */
    const unwatched = watchers.length ? Array.from({ length : night }, (_, h) => h).filter(h => !watchers.some(r => r.cells[h] === "watch")) : [];
    return { night, total : night, rows, unwatched, edited };
  }

  /* A member's picks for a cell : its tasks, Watch, Rest */
  static picks(camp, r){
    return [...r.row.tasks.map(id => `task:${id}`), ...(camp.plan.watch && !this.atInn(camp.plan) && r.row.watch ? ["watch"] : []), ...(r.row.rest ? ["sleep"] : [])];
  }

  /* Before the camp is made : tasks (placed by hand, the others in the first hours left), the rest after the tasks
     not placed, the watches spread; the hours the picks need, or the GM's */
  static plan(camp, rows, watchers){
    for(const r of rows){
      /* (A "rest" from before tasks had hours : only "not on watch", left out) */
      const pins = Object.entries(camp.rota?.[r.actor.id] ?? {}).map(([h, v]) => [Number(h), v])
        .filter(([h, v]) => (h >= 0) && (h < 48) && this.picks(camp, r).includes(v));
      r.pins = new Map(pins);
      r.taskAt = new Map();
      const placed = new Set();
      for(const [h, v] of pins) if(v.startsWith("task:") && !placed.has(v)) { r.taskAt.set(h, v.slice(5)); placed.add(v); }
      let last = -1;
      /* Placed by hand : a task with no hour isn't done (r.unplaced) until clicked into one */
      r.unplaced = r.pins.size ? r.row.tasks.filter(id => !placed.has(`task:${id}`)) : [];
      for(const id of r.row.tasks.filter(id => !placed.has(`task:${id}`) && !r.unplaced.includes(id))){
        let h = 0;
        while(r.taskAt.has(h) || r.pins.has(h)) h++;
        r.taskAt.set(h, id);
        last = Math.max(last, h);
      }
      /* The rest starts after the tasks not placed by hand (or at an hour placed as rest) */
      let start = last + 1;
      while(r.taskAt.has(start)) start++;
      const sleeps = pins.filter(([, v]) => v === "sleep").map(([h]) => h);
      r.restStart = r.row.rest ? Math.min(start, ...sleeps) : 0;
      r.free = h => !r.taskAt.has(h) && (r.pins.get(h) !== "sleep");
    }
    const span = n => Array.from({ length : n }, (_, h) => h);
    /* Hours one may watch : those free before its rest, and in it what its rest and 2 hours of light activity allow
       (tasks in it take from those 2; a camp too short for its rest anyway : still what's left of them) */
    const cap = (r, n) => {
      const free = span(n).filter(h => r.free(h));
      if(!r.row.rest) return free.length;
      const before = free.filter(h => h < r.restStart).length, inRest = free.length - before;
      const light = r.allowance - [...r.taskAt.keys()].filter(h => (h >= r.restStart) && (h < n)).length;
      return before + Math.max(0, Math.min(inRest, Math.max(light, inRest + r.allowance - r.hours)));
    };
    const coverable = n => span(n).filter(h => watchers.some(r => r.free(h))).length;
    const need = r => Math.max(r.row.rest ? r.restStart + r.hours : 0, ...[...r.taskAt.keys()].map(h => h + 1), ...[...r.pins.keys()].map(h => h + 1));
    const typed = Math.round(Number(camp.plan.night) || 0);
    let night = Math.max(1, ...rows.map(need));
    /* Placed by hand : the players' choice, the camp doesn't grow to cover the watches */
    const edited = rows.some(r => r.pins.size);
    if(watchers.length && !edited) while((watchers.reduce((s, r) => s + cap(r, night), 0) < coverable(night)) && (night < 48)) night++;
    if(typed > 0) night = typed;
    /* Watches placed by hand : no cap on them, the hours left are filled around them */
    const handWatch = r => [...r.pins].filter(([h, v]) => (v === "watch") && (h < night) && r.free(h)).map(([h]) => h);
    const pinned = new Set(watchers.flatMap(handWatch));
    const open = edited ? [] : span(night).filter(h => !pinned.has(h) && watchers.some(r => r.free(h)));
    /* Each watcher's share, round and round, then one block each in order */
    const share = new Map(watchers.map(r => [r, 0]));
    for(let left = open.length, moved = true; left && moved;){
      moved = false;
      for(const r of watchers) if(left && (share.get(r) + handWatch(r).length < cap(r, night))){ share.set(r, share.get(r) + 1); left--; moved = true; }
    }
    const watchOf = new Map();
    for(const r of watchers){
      const mine = open.filter(h => r.free(h) && !r.pins.has(h)).slice(0, share.get(r));
      for(const h of mine) open.splice(open.indexOf(h), 1);
      watchOf.set(r, new Set([...handWatch(r), ...mine]));
    }
    /* Hours left (given back by hand, or no one free in its block) : to another free with room left */
    for(const h of open){
      const r = watchers.find(r => r.free(h) && !r.pins.has(h) && (watchOf.get(r).size < cap(r, night)));
      r && watchOf.get(r).add(h);
    }
    for(const r of rows){
      const mine = watchOf.get(r) ?? new Set();
      r.cells = [];
      let rested = 0;
      for(let h = 0; h < night; h++){
        if(r.taskAt.has(h)) r.cells.push(`task:${r.taskAt.get(h)}`);
        else if(mine.has(h)) r.cells.push("watch");
        else if(!r.row.rest) r.cells.push("out");
        else if((h < r.restStart) || (r.short && (rested >= r.hours))) r.cells.push("awake");
        else { r.cells.push(r.short ? "trance" : "sleep"); rested++; }
      }
    }
    return { night, edited };
  }

  /* Its rest ends once it has had its hours : rest, and watches or tasks within its 2 hours of light activity; the hour
     it eats at the end of : the last awake one before it first sleeps (never sleeping : its last task) */
  static restOf(r){
    const restCells = c => (c === "sleep") || (c === "trance");
    const first = r.cells.findIndex(restCells);
    r.meal = (first >= 0) ? first - 1 : r.cells.findLastIndex(c => c.startsWith("task:"));
    /* The hour picked by hand (a right-click), while it's still an awake one */
    if(Number.isInteger(r.mealAt) && (r.mealAt >= 0) && (r.mealAt < r.cells.length) && !restCells(r.cells[r.mealAt])) r.meal = r.mealAt;
    r.sleep = r.cells.filter(restCells).length;
    r.watch = r.cells.filter(c => c === "watch").length;
    if(!r.row.rest) return Object.assign(r, { restEnd : 0, full : true });
    let had = 0, light = 0;
    for(let h = r.restStart; h < r.cells.length; h++){
      if(restCells(r.cells[h])) had++;
      else if(((r.cells[h] === "watch") || r.cells[h].startsWith("task:")) && (light < r.allowance)) { had++; light++; }
      if(had >= r.hours) return Object.assign(r, { restEnd : h + 1, full : true });
    }
    return Object.assign(r, { restEnd : r.cells.findLastIndex(restCells) + 1, full : false });
  }

  /* Who may change this member's hours : the camp's runner, or its owner (a Beast : the GM) */
  static canRota(group, actor, user = game.user){
    return this.isBeast(actor) ? user.isGM : this.canEdit(group, actor, user);
  }

  /* What a cell becomes when clicked : the member's next pick (once made : later hours only, and a task not tried yet
     or one that may be tried again); a task already in another hour comes last (clicking past it would move it here) */
  static nextCell(camp, r, hour){
    let picks = this.picks(camp, r);
    const from = camp.run ? camp.run.hour + 1 : 0;
    if(camp.run){
      if(hour < from) return null;
      const outcomes = camp.run.outcomes?.[r.actor.id] ?? {};
      const later = r.cells.slice(from);
      picks = picks.filter(v => !v.startsWith("task:") || later.includes(v) || (outcomes[v.slice(5)] === "fail")
        || (!(v.slice(5) in outcomes) && !r.cells.slice(0, from).includes(v)));
    }
    /* Rest, the tasks not placed yet, Watch, then those placed in another hour */
    const elsewhere = v => v.startsWith("task:") && r.cells.some((c, h) => (h >= from) && (h !== hour) && (c === v));
    const task = v => v.startsWith("task:");
    picks = [...picks.filter(v => v === "sleep"), ...picks.filter(v => task(v) && !elsewhere(v)), ...picks.filter(v => v === "watch"), ...picks.filter(elsewhere)];
    const now = r.cells[hour];
    const at = picks.indexOf(now);
    return [...picks.slice(at + 1), ...picks.slice(0, Math.max(0, at))].find(v => v !== now) ?? null;
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
          /* A task ticked or not : added at the end of its tasks, or taken out */
          if(("task" in c) && this.taskOffered(camp, c.task, actor, group)){
            const list = this.rowOf(camp, actor, group).tasks.filter(id => id !== c.task);
            clean.tasks = c.on ? [...list, c.task] : list;
          }
          if(("food" in c) && this.INN_SOURCES.includes(c.food)) clean.food = c.food;
          if(("payer" in c) && groupTravel.memberActor(group, c.payer) && (this.canRun(group, user) || groupTravel.memberActor(group, c.payer).testUserPermission(user, "OWNER"))) clean.payer = c.payer;
          await group.update({ [`flags.${module.id}.camp.rows.${actor.id}`] : clean });
          return true;
        }
        case "plan" : {
          if(camp.run || !this.canRun(group, user)) return false;
          const c = data.changes ?? {}, clean = {};
          if(("terrain" in c) && (c.terrain in this.TERRAIN)) clean.terrain = c.terrain;
          for(const key of ["watch", "water", "food", "grazing", "shelter"]) if(key in c) clean[key] = !!c[key];
          for(const key of ["abundance", "foodAbundance", "waterAbundance"]) if((key in c) && (c[key] in this.ABUNDANCE)) clean[key] = c[key];
          if(("lodging" in c) && ((c.lodging === "none") || (c.lodging in this.LODGING))) clean.lodging = c.lodging;
          if("night" in c) clean.night = (Number(c.night) > 0) ? Math.min(48, Math.round(Number(c.night))) : null;
          await group.update({ [`flags.${module.id}.camp.plan`] : clean });
          return true;
        }
        case "meal" : {
          /* A right-click : it eats at the end of that hour (an awake one; once made, not one gone, nor once fed) */
          const actor = groupTravel.memberActor(group, data.id);
          const hour = Math.round(Number(data.hour));
          if(!actor || !this.canRota(group, actor, user)) return false;
          const r = this.schedule(group, camp).rows.find(r => r.actor === actor);
          if(!r || !(hour >= 0) || (hour >= r.cells.length) || ["sleep", "trance"].includes(r.cells[hour])) return false;
          if(camp.run){
            if((hour < camp.run.hour) || (camp.run.fed ?? []).includes(actor.id)) return false;
            await group.update({ [`flags.${module.id}.camp.run.rows.${actor.id}.meal`] : hour });
          }
          else await group.update({ [`flags.${module.id}.camp.meals.${actor.id}`] : hour });
          return true;
        }
        case "rota" : {
          if(data.reset){
            if(camp.run || !this.canRun(group, user)) return false;
            await group.update({ [`flags.${module.id}.camp.rota`] : new foundry.data.operators.ForcedDeletion(), [`flags.${module.id}.camp.meals`] : new foundry.data.operators.ForcedDeletion() });
            return true;
          }
          /* A cell clicked : the member's next pick there (a task leaves the hour it was in : before the camp, its
             pin; once made, it swaps with that later hour) */
          const actor = groupTravel.memberActor(group, data.id);
          const hour = Math.round(Number(data.hour));
          if(!actor || !(hour >= 0) || (hour >= 48) || !this.canRota(group, actor, user)) return false;
          const plan = this.schedule(group, camp);
          const r = plan.rows.find(r => r.actor === actor);
          const value = r && this.nextCell(camp, r, hour);
          if(!value || (value !== data.value)) return false;
          if(camp.run){
            const cells = [...r.cells];
            const other = value.startsWith("task:") ? cells.findIndex((c, h) => (h > camp.run.hour) && (h !== hour) && (c === value)) : -1;
            if(other >= 0) cells[other] = cells[hour];
            cells[hour] = value;
            await group.update({ [`flags.${module.id}.camp.run.rows.${actor.id}.cells`] : cells });
            return true;
          }
          /* Before the camp : the whole rota as it stands is kept (nothing is filled or spread again around a click),
             then this cell; a task swaps with the hour it was in */
          const rota = Object.fromEntries(plan.rows.map(row => [row.actor.id, Object.fromEntries(row.cells.map((c, h) => [h, (c === "trance") ? "sleep" : c])
            .filter(([, v]) => this.picks(camp, row).includes(v)))]));
          const mine = rota[actor.id];
          const was = mine[hour];
          const other = value.startsWith("task:") ? Object.keys(mine).find(h => (mine[h] === value) && (Number(h) !== hour)) : undefined;
          if(other !== undefined){ if(was) mine[other] = was; else delete mine[other]; }
          mine[hour] = value;
          await group.update({ [`flags.${module.id}.camp.rota`] : new foundry.data.operators.ForcedDeletion() });
          await group.update({ [`flags.${module.id}.camp.rota`] : rota });
          return true;
        }
        case "spoil" : {
          const item = await fromUuid(data.item ?? "");
          if(!user.isGM || !groupMeal.curing(item) || (item.getFlag(module.id, "curing").group !== group.uuid)) return false;
          const count = item.getFlag(module.id, "curing").count;
          await item.delete();
          await this.postLog(group, "curingSpoiled", { lines : [this.i18n("curingSpoiled", { name : this.esc(item.parent?.name), count })] });
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
    /* The rota frozen : later hours may still change, the hours gone stay as they were */
    const rows = Object.fromEntries(plan.rows.map(r => [r.actor.id, { cells : r.cells, restStart : r.restStart, meal : r.meal }]));
    const run = { start : game.time.worldTime, hour : 0, paused : false, interrupts : {}, applied : [], prone : [], data : {}, outcomes : {}, fed : [], rows };
    await group.update({ [`flags.${module.id}.camp.run`] : run });
    await this.postLog(group, "made", { lines : [...this.rotaLines(group), ...lines] });
    /* Water nearby or at the inn : all anyone wants */
    if(camp.plan.water || this.atInn(camp.plan)){
      const drank = await groupMeal.drinkThere(group, plan.rows.map(r => r.actor), Infinity);
      if(drank.length) await this.postLog(group, "found", { lines : drank });
    }
    await this.hourStarts(group, 0);
    await this.meals(group, -1);
    await this.statuses(group);
    return true;
  }

  /* The tasks of that hour start (flag camp.run.data["<id>@<hour>"]) */
  static async hourStarts(group, hour){
    const camp = this.campOf(group);
    const plan = this.schedule(group, camp);
    if(hour >= plan.total) return;
    const data = {};
    for(const [id, task] of tasks){
      const actors = this.taskActors(group, plan, id, hour);
      if(!actors.length) continue;
      try { data[`${id}@${hour}`] = task.start ? ((await task.start({ group, actors, camp, hour })) ?? null) : null; } catch(err) { log.error(`Camp task ${id} :`, err); }
    }
    if(!foundry.utils.isEmpty(data)) await group.update({ [`flags.${module.id}.camp.run.data`] : data });
  }

  /* ... and end with it : the finds (food : an item that spoils, a Beast's its own; water : drunk, then into the
     waterskins), who may try again */
  static async hourEnds(group, hour){
    const camp = this.campOf(group);
    const plan = this.schedule(group, camp);
    const found = { food : 0, water : 0 };
    const lines = [], outcomes = {};
    for(const [id, task] of tasks){
      const actors = this.taskActors(group, plan, id, hour);
      if(!actors.length || !(`${id}@${hour}` in (camp.run.data ?? {}))) continue;
      try {
        const got = task.collect ? ((await task.collect({ group, actors, data : camp.run.data[`${id}@${hour}`], camp, hour })) ?? {}) : {};
        found.food += Number(got.food) || 0;
        found.water += Number(got.water) || 0;
        lines.push(...(got.lines ?? []));
        for(const actor of actors) outcomes[`${actor.id}.${id}`] = got.outcomes?.[actor.id] ?? "ok";
      } catch(err) { log.error(`Camp task ${id} :`, err); }
    }
    if(!foundry.utils.isEmpty(outcomes)) await group.update(Object.fromEntries(Object.entries(outcomes).map(([k, v]) => [`flags.${module.id}.camp.run.outcomes.${k}`, v])));
    const actors = plan.rows.map(r => r.actor);
    if(found.food >= 1){
      const holder = groupTravel.arrivalHolder(group).actor ?? actors[0];
      await groupMeal.giveFood(holder, { identifier : groupMeal.FORAGED, name : this.i18n("foraged"), lb : found.food });
      lines.push(this.i18n("foragedTo", { food : Math.floor(found.food), name : this.esc(holder?.name) }));
    }
    if(found.water > 0) lines.push(...await groupMeal.drinkThere(group, actors, found.water));
    if(lines.length) await this.postLog(group, "found", { lines });
  }

  /* The members whose meal hour has ended (up to that hour) : the Meal window */
  static async meals(group, hour){
    const camp = this.campOf(group);
    if(!camp.run) return;
    const plan = this.schedule(group, camp);
    const fed = new Set(camp.run.fed ?? []);
    const now = plan.rows.filter(r => !fed.has(r.actor.id) && (r.meal <= hour)).map(r => r.actor);
    if(!now.length) return;
    await group.update({ [`flags.${module.id}.camp.run.fed`] : [...fed, ...now.map(a => a.id)] });
    const free = Object.fromEntries(plan.rows.map(r => [r.actor.id, this.freeFood(camp, r.actor, r.row)]).filter(([, f]) => f));
    const ids = now.filter(a => groupFood.tracked(group, a)).map(a => a.id);
    if(ids.length) await groupMeal.callAsGM(group, ids, free);
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

  /* An hour (or all that's left) of the camp : its tasks end, the meals due, the next hour's tasks; the last ends it */
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
        shelter : actor => this.shelterOf(group, camp, plan, places, actor),
        asleep : actor => ["sleep", "trance"].includes(plan.rows.find(r => r.actor === actor)?.cells[hour - 1]), where : { water : !!camp.plan.water || this.atInn(camp.plan) } })
        .catch(err => log.error("Camp weather :", err));
      await this.fireOut(group);
      await this.hourEnds(group, hour - 1);
      await this.meals(group, hour - 1);
      if(hour >= this.schedule(group).total) return this.end(group, true);
      await this.hourStarts(group, hour);
      await this.statuses(group);
    }
    return true;
  }

  /* Tent places and shelters built (before the camp : those planned; once made : the successes so far), for those
     with no other shelter : Map(actor -> "tent" | "built") */
  static places(group, plan){
    const run = this.campOf(group).run;
    const builders = run ? (run.built ?? []).map(id => groupTravel.memberActor(group, id)).filter(a => a) : plan.rows.filter(r => r.row.tasks.includes("shelter")).map(r => r.actor);
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

  /* Its hour done : who built one (flag camp.run.built : places counts only those, from the next hour) */
  static async shelterCollect({ group, actors, data }){
    const built = [], lines = [], outcomes = {};
    for(const actor of actors){
      const got = this.checked(data, actor, data?.dc);
      outcomes[actor.id] = got?.outcome ?? "fail";
      if(got?.outcome === "ok") built.push(actor.id);
      lines.push(this.i18n(!got ? "shelterNone" : (got.outcome === "ok") ? "shelterBuilt" : "shelterFail", { name : this.esc(actor.name) }));
    }
    const run = this.campOf(group).run;
    await group.update({ [`flags.${module.id}.camp.run.built`] : [...new Set([...(run?.built ?? []), ...built])] });
    return { lines, outcomes };
  }

  /* A member's shelter : the inn, natural shelter, the Members tab's, then a tent or a shelter built */
  static shelterOf(group, camp, plan, places, actor){
    if(this.atInn(camp.plan)) return "inn";
    if(camp.plan.shelter) return "natural";
    return groupWeather.roadShelter(group, actor) ?? places.get(actor) ?? null;
  }

  /* The camp has shelter for a fire or food curing : natural, a tent or one built (shelter is shelter) */
  static sheltered(group, camp){
    if(camp.plan.shelter || this.atInn(camp.plan)) return true;
    return groupWeather.campPlaces(group, this.members(group), []).size > 0 || !!camp.run?.built?.length;
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

  /* ---------- Build a Fire, Preserve (homebrew Camp Tasks) ---------- */

  static FIRE_SPELLS = ["prestidigitation", "produce-flame", "fire-bolt", "control-flames", "burning-hands"];
  static PRESERVE_DC = 10;
  /* A cook's most : 3 Rations, from 2 lb of fresh food each; they cure for 7 hours */
  static PRESERVE_RATIONS = 3;
  static PRESERVE_LB = 2;
  static CURE_HOURS = 7;

  static preservePartial(){
    return !!settings.value("homebrewPreservePartial");
  }

  /* Something to light it with : a spell, or a Tinderbox (its own or a pack's) */
  static canLight(actor, group){
    if(actor.items.some(i => (i.type === "spell") && this.FIRE_SPELLS.includes(idOf(i)))) return true;
    return [actor, ...(group ? groupInventory.packs(group) : [])].some(a => groupWeather.hasItem(a, ["tinderbox"]));
  }

  static fireLit(camp){
    return !!camp.run?.fire;
  }

  /* Heavy rain or strong wind : no fire, unless the camp has shelter */
  static doused(group, camp){
    return !this.sheltered(group, camp) && groupWeather.effectsOf(groupWeather.of(group)).douses;
  }

  /* What moves a check's DC : [{ value (on the roll), label }] (the fire's : rain or snow; Preserve's : wind, heat, cold,
     a fire too) */
  static weatherMods(group, camp, kind){
    const w = groupWeather.of(group);
    const mods = [];
    const add = (value, label) => mods.push({ value, label });
    if(!this.sheltered(group, camp)){
      if(["rain", "snow"].includes(w.precipitation)) add(-4, groupWeather.i18n(`precipitation.${w.precipitation}`));
      else if(w.precipitation === "light") add(-2, groupWeather.i18n("precipitation.light"));
      if(kind === "preserve"){
        if(w.wind === "sandstorm") add(-4, groupWeather.i18n("wind.sandstorm"));
        else if(w.wind === "strong") add(-2, groupWeather.i18n("wind.strong"));
      }
    }
    if(kind === "preserve"){
      if(w.temperature === "heat") add(-2, groupWeather.i18n("temperature.heat"));
      if(w.temperature === "cold") add(2, groupWeather.i18n("temperature.cold"));
      if(this.fireLit(camp)) add(2, this.i18n("fireLit"));
    }
    return mods;
  }

  /* Together, at most 4 either way */
  static modTotal(mods){
    return Math.max(-4, Math.min(4, mods.reduce((s, m) => s + m.value, 0)));
  }

  static modText(mods){
    return mods.map(m => `${m.label} ${(m.value > 0) ? "+" : ""}${m.value}`).join(", ");
  }

  /* Build a Fire : a Wisdom (Survival) check at the terrain's Foraging DC (gathering firewood) */
  static async fireStart({ group, actors }){
    const camp = this.campOf(group);
    const mods = this.weatherMods(group, camp, "fire");
    const dc = (this.TERRAIN[camp.plan.terrain] ?? 15) - this.modTotal(mods);
    const card = await rollRequests.request({ who : actors.map(a => ({ actor : a.uuid, name : a.name, img : a.img })), what : "skill:sur", dc, hideDC : false, speaker : group,
      label : this.i18n("surveyCard", { task : this.i18n("task.fire"), skill : rollRequests.labelOf("skill", "sur"), terrain : this.i18n(`terrain.${camp.plan.terrain}`) })
        + (mods.length ? ` (${this.esc(this.modText(mods))})` : "") });
    return { message : card?.id ?? null, dc };
  }

  /* Missing the DC by this much or more : a full failure, no trying again */
  static ABJECT = 5;

  /* A row's result on a request card : { result, total, fumble, outcome ("ok", "fail" : may try again, "abject") } */
  static checked(data, actor, dc = data?.dc){
    const request = game.messages.get(data?.message)?.getFlag(module.id, "request");
    const row = request?.rows.find(r => r.actor === actor.uuid);
    const result = row ? request.results?.[1]?.[row.key] : null;
    if(!result) return null;
    const roll = rollRequests.rollOf(result);
    const total = Number(result.total);
    const outcome = !Number.isFinite(total) ? (result.success ? "ok" : "fail") : (total >= dc) ? "ok" : (total <= dc - this.ABJECT) ? "abject" : "fail";
    return { result, total, fumble : roll?.isFumble ?? (roll?.dice?.[0]?.total === 1), outcome };
  }

  static async fireCollect({ group, actors, data }){
    const lines = [], outcomes = {};
    let lit = false;
    for(const actor of actors){
      const got = this.checked(data, actor);
      outcomes[actor.id] = got?.outcome ?? "fail";
      lit ||= got?.outcome === "ok";
      lines.push(this.i18n(!got ? "fireNone" : (got.outcome === "ok") ? "fireDone" : "fireFail", { name : this.esc(actor.name) }));
    }
    if(lit && this.doused(group, this.campOf(group))){ lit = false; lines.push(this.i18n("fireOut")); }
    if(lit) await group.update({ [`flags.${module.id}.camp.run.fire`] : true });
    return { lines, outcomes };
  }

  /* Each hour : heavy rain or strong wind puts the fire out */
  static async fireOut(group){
    const camp = this.campOf(group);
    if(!this.fireLit(camp) || !this.doused(group, camp)) return;
    await group.update({ [`flags.${module.id}.camp.run.fire`] : false });
    await this.postLog(group, "fire", { lines : [this.i18n("fireOut")] });
  }

  /* Preserve : a Cook's Utensils check, DC 10 moved by the weather and a fire; Advantage carrying them */
  static async preserveStart({ group, actors }){
    const camp = this.campOf(group);
    const mods = this.weatherMods(group, camp, "preserve");
    const dc = this.PRESERVE_DC - this.modTotal(mods);
    const who = actors.map(a => {
      const tool = a.items.find(i => (i.type === "tool") && (i.system.type?.baseItem === "cook"));
      return { actor : a.uuid, name : a.name, img : a.img, ...(tool ? { rollMode : { mode : "advantage", reason : this.i18n("cookTool", { tool : tool.name }) } } : {}) };
    });
    const card = await rollRequests.request({ who, what : "tool:cook", dc, hideDC : false, speaker : group,
      label : this.i18n("preserveCard", { tool : rollRequests.labelOf("tool", "cook") }) + (mods.length ? ` (${this.esc(this.modText(mods))})` : "") });
    return { message : card?.id ?? null, dc };
  }

  /* Each cook in turn : up to 6 lb of the group's spoiling food (not made by magic) into Rations that cure */
  static async preserveCollect({ group, actors, data }){
    const plan = this.schedule(group);
    const holders = [...new Set([...plan.rows.map(r => r.actor), ...groupInventory.packs(group)])];
    const items = () => holders.flatMap(a => a.items.filter(i => groupMeal.spoils(i) && !i.getFlag(module.id, "made") && (groupMeal.unitsLeft(i) > 0)));
    const lines = [], outcomes = {};
    for(const actor of actors){
      const name = this.esc(actor.name);
      const got = this.checked(data, actor);
      /* Nothing tried (no roll, no food) : it may try again; some kept : done; none kept : its outcome (a natural 1 : abject) */
      outcomes[actor.id] = "fail";
      if(!got) { lines.push(this.i18n("preserveNone", { name })); continue; }
      const fresh = Math.min(this.PRESERVE_LB * this.PRESERVE_RATIONS, groupMeal.round(items().reduce((s, i) => s + groupMeal.unitsLeft(i) * groupMeal.perUnit(i, actor), 0)));
      if(fresh < 0.01) { lines.push(this.i18n("preserveNoFood", { name })); continue; }
      const miss = data.dc - got.total;
      const share = got.fumble ? 0 : (miss <= 0) ? 1 : this.preservePartial() ? Math.max(0, 1 - 0.2 * miss) : 0;
      const rations = groupMeal.round(fresh / this.PRESERVE_LB * share);
      outcomes[actor.id] = got.fumble ? "abject" : (rations >= 0.01) ? "ok" : got.outcome;
      if(rations < 0.01) { lines.push(this.i18n(got.fumble ? "preserveFumble" : "preserveFail", { name })); continue; }
      let used = fresh;
      for(const item of items()){
        if(used <= 1e-9) break;
        used -= await groupMeal.eatFrom(item, used, actor);
      }
      await this.cure(group, actor, rations);
      lines.push(this.i18n((share < 1) ? "preservePart" : "preserveDone", { name, fresh, rations, hours : this.CURE_HOURS }));
    }
    return { lines, outcomes };
  }

  /* Rations curing : one item (flag curing { until, group, count }) that can't be eaten and doesn't spoil */
  static async cure(group, actor, count){
    const data = groupMeal.wholeData(await this.rationsSource(group, actor), 1);
    const until = game.time.worldTime + this.CURE_HOURS * groupTravel.secondsPerHour();
    foundry.utils.mergeObject(data, { name : this.i18n("curingName", { name : data.name, count }),
      system : { weight : { value : groupMeal.round((Number(data.system?.weight?.value) || 0) * count) }, price : { value : 0 } },
      flags : { [module.id] : { curing : { until, group : group.uuid, count } } } });
    return actor.createEmbeddedDocuments("Item", [data]);
  }

  static #curing = null;

  /* The clock past their time : cured Rations join the cook's stack (the active GM) */
  static cureDue(){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    this.#curing = (this.#curing ?? Promise.resolve()).then(async () => {
      const now = game.time.worldTime;
      const lines = new Map();
      for(const actor of game.actors) for(const item of actor.items.filter(i => groupMeal.curing(i) && (Number(i.getFlag(module.id, "curing").until) <= now))){
        const { group : uuid, count } = item.getFlag(module.id, "curing");
        const group = fromUuidSync(uuid ?? "", { strict : false });
        await item.delete();
        await this.giveRations((group?.type === "group") ? group : null, actor, Number(count) || 0);
        if(group) lines.set(group, [...(lines.get(group) ?? []), this.i18n("cured", { name : this.esc(actor.name), count })]);
      }
      for(const [group, list] of lines) await this.postLog(group, "cured", { lines : list });
    }).catch(err => log.error("Camp curing :", err));
  }

  /* Rations to copy : one the group has, else dnd5e's */
  static async rationsSource(group, actor){
    const holders = group ? [...this.members(group), ...groupInventory.packs(group)] : [actor];
    let source = holders.flatMap(a => a.items.contents).find(i => (i.system.identifier === "rations") && !groupMeal.curing(i))?.toObject();
    if(!source){
      const pack = game.packs.get("dnd5e.equipment24");
      const entry = pack?.index.find(e => e.name === "Rations");
      source = entry ? (await pack.getDocument(entry._id))?.toObject() : null;
    }
    source ??= { name : this.i18n("rations"), type : "consumable", system : { type : { value : "food" }, weight : { value : 2, units : "lb" } } };
    return foundry.utils.mergeObject(source, { "system.identifier" : "rations" });
  }

  /* Rations (parts too) onto a creature */
  static async giveRations(group, actor, count){
    return groupMeal.addFood(actor, await this.rationsSource(group, actor), count);
  }

  /* The camp ends : sleepers wake, the rests, the tasks' finish, the log */
  static async end(group, done){
    const camp = this.campOf(group);
    if(!camp.run) return false;
    const plan = this.schedule(group, camp);
    await this.statuses(group, true);
    /* Those who never reached their meal (the camp broken) eat now */
    await this.meals(group, Infinity);
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
      const restStart = camp.run.start + (plan.rows.find(r => r.actor === actor)?.restStart ?? 0) * groupTravel.secondsPerHour();
      try { await actor.longRest({ dialog : false, advanceTime : false, advanceBastionTurn : false, [module.id] : { restChecked : true, restStart } }); }
      catch(err) { log.error("Camp Long Rest :", err); }
    }
    /* A Short Rest : each player's own rest window (Hit Point Dice), through dnd5e's rest request card */
    if(rested.short.length) await this.shortRestCard(group, rested.short);
    for(const [id, task] of tasks){
      const actors = this.taskActors(group, plan, id);
      if(!actors.length || !task.finish) continue;
      const data = Object.entries(camp.run.data ?? {}).find(([key]) => key.startsWith(`${id}@`))?.[1] ?? null;
      try { await task.finish({ group, actors, data, camp, rested }); } catch(err) { log.error(`Camp task ${id} :`, err); }
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
      /* RAW : resuming adds an hour of rest, after its rest's end */
      const cells = [...r.cells];
      cells.splice(r.restEnd, 0, r.short ? "trance" : "sleep");
      if((cells.length > plan.total) && (cells.at(-1) === "awake")) cells.pop();
      updates[`flags.${module.id}.camp.run.rows.${actor.id}.cells`] = cells;
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
    const lines = [this.i18n("length", { hours : plan.total, from : at(0), to : at(plan.total) })];
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

  /* A Beast's finds are its own (eaten or drunk by it alone) */
  static async surveyCollect(key, kind, { group, actors, data, hour }){
    kind = data?.kind ?? kind;
    const dcs = data?.dcs ?? this.surveyDCs(key, kind, this.campOf(group).plan);
    const low = Math.min(...[dcs.food, dcs.water].filter(dc => dc !== null));
    let food = 0, water = 0;
    const lines = [], finders = [], outcomes = {};
    const plan = this.schedule(group);
    for(const actor of actors){
      const checked = this.checked(data, actor, low);
      const road = (key === "forage") && (plan.rows.find(r => r.actor === actor)?.cells[hour] !== "task:forage");
      const task = this.i18n(road ? "task.road" : `task.${key}`);
      outcomes[actor.id] = checked?.outcome ?? "fail";
      if(!checked) { lines.push(this.i18n("surveyNone", { name : this.esc(actor.name), task })); continue; }
      const { result, total } = checked;
      const meets = dc => (dc !== null) && (Number.isFinite(total) ? (total >= dc) : !!result.success);
      const got = { food : meets(dcs.food), water : meets(dcs.water) };
      if(!got.food && !got.water) { lines.push(this.i18n("surveyFail", { name : this.esc(actor.name), task })); continue; }
      const roll = async () => Math.max(0, (await new Roll(this.surveyFormula(key), actor.getRollData()).evaluate()).total);
      const f = got.food ? await roll() : 0, w = got.water ? await roll() : 0;
      finders.push(actor);
      lines.push(this.i18n(`found.${(got.food && got.water) ? "both" : got.food ? "food" : "water"}`, { name : this.esc(actor.name), food : f, water : w }).replace(/\.$/, road ? ` (${task}).` : "."));
      if(!this.isBeast(actor)) { food += f; water += w; continue; }
      if(f >= 1){
        await groupMeal.giveFood(actor, { identifier : groupMeal.FORAGED, name : this.i18n("foraged"), lb : f });
        lines.push(this.i18n("foragedTo", { food : Math.floor(f), name : this.esc(actor.name) }));
      }
      if(w > 0) lines.push(...await groupMeal.drinkThere(group, [actor], w));
    }
    return { food, water, lines, finders, outcomes };
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

  /* Make Camp : the window opens for the GM and each player with a member */
  static opened(actor, changes){
    if((actor.type !== "group") || !this.enabled() || !foundry.utils.hasProperty(changes, `flags.${module.id}.camp.run.start`)) return;
    if(game.user.isGM || this.members(actor).some(a => a.isOwner)) this.open(actor);
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
        <div class="line">${inn ? "" : `<label><input type="checkbox" name="watch" ${camp.plan.watch ? "checked" : ""} ${off(planner)}> ${this.i18n("keepWatch")}</label>`}
          <label data-tooltip="${e(this.i18n("nightHint"))}">${this.i18n("night")} <input type="number" name="night" min="1" max="48" step="1" value="${(Number(camp.plan.night) > 0) ? camp.plan.night : ""}" placeholder="${plan.night}" ${off(planner)}></label></div>
      </section>`;
    const payers = this.members(group).filter(a => a.hasPlayerOwner && !this.isBeast(a));
    const places = this.places(group, plan);
    const extreme = groupWeather.of(group).temperature !== "normal";
    const memberRows = plan.rows.map(r => {
      const where = this.shelterOf(group, camp, plan, places, r.actor);
      const shelter = `<td class="shelter ${(!where && extreme) ? "over" : ""}" data-tooltip="${e(this.i18n(`shelter.${where ?? "none"}Hint`))}">${this.i18n(`shelter.${where ?? "none"}`)}</td>`;
      const edit = !run && this.canEdit(group, r.actor);
      /* What it does : Rest, Watch, its tasks, each an icon ticked or not */
      const pick = (data, on, icon, tip, allowed = true) => `<button type="button" class="pick ${on ? "on" : ""}" ${data} data-tooltip="${e(tip)}" ${off(edit && allowed)}><i class="${icon}" inert></i></button>`;
      const road = (!inn && this.roadForager(group, r.actor)) ? `<i class="fa-solid fa-seedling road" data-tooltip="${e(this.i18n("roadHint"))}" inert></i>` : "";
      const picks = [pick(`data-key="rest"`, r.row.rest, "fa-solid fa-bed", this.i18n("pickRest")),
        ...(inn ? [] : [pick(`data-key="watch"`, r.row.watch, "fa-solid fa-eye", this.i18n("pickWatch"), !this.isBeast(r.actor) || game.user.isGM)]),
        ...this.offered(camp, r.actor, group).map(t => pick(`data-task="${t.id}" ${r.unplaced?.includes(t.id) ? `data-unplaced="true"` : ""}`, r.row.tasks.includes(t.id), t.icon,
          (t.hint ? `${game.i18n.localize(t.label)} : ${game.i18n.localize(t.hint)}` : game.i18n.localize(t.label)) + (r.unplaced?.includes(t.id) ? `<br>${this.i18n("unplaced")}` : "")))];
      const food = inn ? `<td><select data-key="food" ${off(edit)}>${options(this.INN_SOURCES.map(s => [s, this.i18n(`source.${s}`)]), r.row.food)}</select></td>` : "";
      const payer = inn ? `<td><select data-key="payer" ${off(edit)}>${options([...new Set([r.actor, ...payers])].map(a => [a.id, a.name]), r.row.payer)}</select></td>` : "";
      const summary = r.row.rest ? (r.short ? this.i18n("sumShort", { rest : r.sleep, watch : r.watch, source : r.source?.name ?? "" }) : this.i18n("sum", { sleep : r.sleep, watch : r.watch }))
        : this.i18n("sumOut", { watch : r.watch });
      return `<tr data-id="${r.actor.id}">
        <td class="who"><img src="${e(r.actor.img)}" alt=""><span>${e(r.actor.name)}</span></td>
        <td class="picks">${road}${picks.join("")}</td>
        ${food}${payer}${shelter}
        <td class="sum ${r.full ? "" : "over"}" data-tooltip="${e(this.i18n(r.full ? "full" : "notFull"))}"><i class="fa-solid ${r.full ? "fa-check" : "fa-triangle-exclamation"}" inert></i> ${e(summary)}</td></tr>`;
    }).join("");
    const members = `<section class="members"><h3>${this.i18n("membersLabel")}</h3><table>
        <thead><tr><th>${this.i18n("playerLabel")}</th><th>${this.i18n("tasksLabel")}</th>
          ${inn ? `<th>${this.i18n("eat")}</th><th>${this.i18n("pays")}</th>` : ""}<th>${this.i18n("shelterLabel")}</th><th>${this.i18n("restLabel")}</th></tr></thead>
        <tbody>${memberRows}</tbody></table></section>`;
    const unwatched = new Set(plan.unwatched);
    const heads = Array.from({ length : plan.total }, (_, h) => `<th class="${(run && (h === run.hour)) ? "now" : ""} ${unwatched.has(h) ? "over" : ""}"
      ${unwatched.has(h) ? `data-tooltip="${e(this.i18n("unwatched"))}"` : ""}>${e(at(h))}</th>`).join("");
    const label = c => c.startsWith("task:") ? game.i18n.localize(tasks.get(c.slice(5))?.label ?? c) : this.i18n(`cell.${c}`);
    const rotaRows = plan.rows.map(r => {
      const mine = this.canRota(group, r.actor);
      const short = r.row.rest && !r.full;
      return `<tr data-id="${r.actor.id}"><td class="who ${short ? "over" : ""}" ${short ? `data-tooltip="${e(this.i18n("notFull"))}"` : ""}>${short ? `<i class="fa-solid fa-triangle-exclamation" inert></i> ` : ""}${e(r.actor.name)}</td>${r.cells.map((c, h) => {
        const task = c.startsWith("task:") ? tasks.get(c.slice(5)) : null;
        const icon = task ? task.icon : `fa-solid ${this.CELLS[c] ?? ""}`;
        const next = mine ? this.nextCell(camp, r, h) : null;
        const meal = (r.meal === h) ? `<i class="fa-solid fa-utensils meal" inert></i>` : "";
        /* Right-click : eats after this hour (an awake one) */
        const eat = mine && !meal && !["sleep", "trance"].includes(c) && (!run || ((h >= run.hour) && !(run.fed ?? []).includes(r.actor.id)));
        /* Its check missed by less than 5, and not placed again yet */
        const retry = task && run && (h <= run.hour) && (run.outcomes?.[r.actor.id]?.[task.id] === "fail") && !r.cells.slice(run.hour + 1).includes(c);
        const tip = `${label(c)}${meal ? `<br>${this.i18n("mealHere")}` : ""}${retry ? `<br>${this.i18n("retryHint")}` : ""}${next ? `<br>${this.i18n("rotaNext", { next : label(next) })}` : ""}${eat ? `<br>${this.i18n("mealPick")}` : ""}`;
        return `<td class="cell ${task ? "task" : c} ${(run && (h === run.hour)) ? "now" : ""} ${next ? "pick" : ""} ${eat ? "eat" : ""}"
          data-hour="${h}" ${next ? `data-value="${next}"` : ""} data-tooltip="${e(tip)}">${icon.trim() ? `<i class="${icon}" inert></i>` : ""}${meal}</td>`;
      }).join("")}</tr>`;
    }).join("");
    const reset = (plan.edited && !run) ? `<button type="button" class="rota-reset" data-tooltip="${e(this.i18n("rotaResetHint"))}" ${off(this.canRun(group))}><i class="fa-solid fa-rotate-left" inert></i> ${this.i18n("rotaReset")}</button>` : "";
    const rota = `<section class="rota"><h3>${this.i18n("rota")} <span class="hint">${this.i18n("length", { hours : plan.total, from : at(0), to : at(plan.total) })}</span> ${reset}</h3>
        <div class="grid"><table><thead><tr><th>${this.i18n("playerLabel")}</th>${heads}</tr></thead><tbody>${rotaRows}</tbody></table></div></section>`;
    const s = this.supplies(group, camp);
    const short = (have, need) => (have < need) ? "over" : "";
    const supplies = `<p class="supplies">
        <span class="${short(s.food.rations + s.food.feed, s.food.need)}"><i class="fa-solid fa-drumstick-bite" inert></i> ${this.i18n("foodLine", { need : s.food.need, have : s.food.rations, feed : s.food.feed })}</span>
        <span class="${short(s.water.skins, s.water.need)}"><i class="fa-solid fa-droplet" inert></i> ${this.i18n("waterLine", { need : s.water.need, have : Math.round(s.water.skins * 100) / 100 })}</span>
        ${this.fireLit(camp) ? `<span class="fire"><i class="fa-solid fa-fire" inert></i> ${this.i18n("fireLit")}</span>` : ""}</p>`;
    /* Rations curing (the GM may spoil them : animals, weather) */
    const curing = [...new Set([...this.members(group), ...groupInventory.packs(group)])].flatMap(a => a.items.filter(i => groupMeal.curing(i) && (i.getFlag(module.id, "curing").group === group.uuid)));
    const cured = curing.length ? `<section class="curing"><h3>${this.i18n("curingLabel")}</h3>${curing.map(i => {
      const flag = i.getFlag(module.id, "curing");
      return `<div class="line"><i class="fa-solid fa-jar" inert></i> ${this.i18n("curingLine", { name : e(i.parent.name), count : flag.count, at : e(groupTravel.formatted(flag.until).time) })}
        ${game.user.isGM ? `<button type="button" data-spoil="${i.uuid}" data-tooltip="${e(this.i18n("spoilHint"))}"><i class="fa-solid fa-trash" inert></i> ${this.i18n("spoil")}</button>` : ""}</div>`;
    }).join("")}</section>` : "";
    const buttons = !run ? [["make", "fa-tents"]] : run.paused ? [["resume", "fa-play"], ["break", "fa-person-walking-arrow-right"]]
      : [["step", "fa-forward-step"], ["finish", "fa-forward-fast"], ["stop", "fa-bell"], ["break", "fa-person-walking-arrow-right"]];
    const control = () => this.canRun(group);
    return `${where}${members}${rota}${supplies}${cured}
      ${run?.paused ? `<p class="paused over"><i class="fa-solid fa-pause" inert></i> ${this.i18n("paused")}</p>` : ""}
      <footer class="form-footer">${buttons.map(([op, icon]) =>
        `<button type="button" data-op="${op}" ${off(control(op))}><i class="fa-solid ${icon}" inert></i> ${this.i18n(`button.${op}`)}</button>`).join("")}</footer>`;
  }

  static listen(group, content){
    const send = data => gm.run("groupCamp", { group : group.uuid, ...data });
    for(const input of content.querySelectorAll(".members tr[data-id] select[data-key]")){
      input.addEventListener("change", () => send({ op : "row", id : input.closest("tr").dataset.id, changes : { [input.dataset.key] : input.value } }));
    }
    for(const button of content.querySelectorAll(".members tr[data-id] button.pick")){
      const on = !button.classList.contains("on");
      button.addEventListener("click", () => { button.disabled = true; send({ op : "row", id : button.closest("tr").dataset.id,
        changes : button.dataset.task ? { task : button.dataset.task, on } : { [button.dataset.key] : on } }); });
    }
    for(const input of content.querySelectorAll(".where [name]")){
      input.addEventListener("change", () => send({ op : "plan", changes : { [input.name] : (input.type === "checkbox") ? input.checked : input.value } }));
    }
    for(const cell of content.querySelectorAll(".rota td.pick")){
      cell.addEventListener("click", () => send({ op : "rota", id : cell.closest("tr").dataset.id, hour : Number(cell.dataset.hour), value : cell.dataset.value }));
    }
    for(const cell of content.querySelectorAll(".rota td.eat")){
      cell.addEventListener("contextmenu", event => { event.preventDefault(); send({ op : "meal", id : cell.closest("tr").dataset.id, hour : Number(cell.dataset.hour) }); });
    }
    content.querySelector(".rota-reset")?.addEventListener("click", () => send({ op : "rota", reset : true }));
    for(const button of content.querySelectorAll(".curing [data-spoil]")) button.addEventListener("click", () => { button.disabled = true; send({ op : "spoil", item : button.dataset.spoil }); });
    for(const button of content.querySelectorAll("footer [data-op]")){
      button.addEventListener("click", () => {
        if(button.dataset.op === "stop") return this.stopWindow(group);
        button.disabled = true;
        send({ op : button.dataset.op });
      });
    }
  }
}
