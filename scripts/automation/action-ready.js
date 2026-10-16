import { module } from '../module.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { idOf, esc, chooseOption } from '../helpers/utils.js';
import { cells, gridSteps, canSee } from '../helpers/tokens.js';
import { pickTargets } from '../helpers/targets.js';
import { actionTracker } from './action-tracker.js';
import { uses } from '../uses.js';
const log = logger.for(import.meta.url);

/**
 * Action Tracker : readied actions and Opportunity Attacks.
 *
 *   Ready         : on its turn (the action bar's Ready), its Action : which use, and its trigger from a list (what it
 *                   can see, off its turn, before its next turn) : an enemy / an ally attacks (an attack or a spell, once
 *                   its card is out), moves, heals; an enemy leaves its reach; a creature's turn starts (picked on the
 *                   map). A levelled spell is cast now : its slot spent, Concentration held (Readied). When the trigger
 *                   happens, a card for its owners and the GM : Initiate (the use, its Reaction; targets picked then)
 *                   or Wait. It's gone when its next turn starts, or when its Reaction goes on something else.
 *   Opportunity   : a token dragged out of the reach of a creature that can see it, has its Reaction and a melee
 *   Attacks         attack (not Disengaged; teleports and forced moves never) stops on the last square in reach. A
 *                   card : a row per such creature, Opportunity Attack or Pass (its owners, the GM); once all have
 *                   answered, the GM's client finishes the move (the GM may Continue or Stop here at any time).
 */
export class actionReady{
  static TRIGGERS = ["enemyAttacks", "enemyMoves", "enemyLeaves", "enemyHeals", "allyAttacks", "allyMoves", "allyHeals", "turnStarts"];
  static DEFAULT_REACH = 5;

  static register(){
    if(game.system.id !== "dnd5e") return;
    gm.handle("readyAnswer", (data, user) => this.readyAnswerAsGM(data, user));
    gm.handle("oaAnswer", (data, user) => this.oaAnswerAsGM(data, user));
    Hooks.on("renderChatMessageHTML", (message, html) => { this.drawReadyCard(message, html); this.drawOACard(message, html); });
    /* Its readied action changed : its cards show it */
    Hooks.on("updateActor", (actor, changes) => {
      if(!foundry.utils.hasProperty(changes ?? {}, `flags.${module.id}.economy`)) return;
      for(const m of game.messages.contents.slice(-40)) if(m.getFlag(module.id, "readyPrompt")?.actor === actor.uuid) ui.chat?.updateMessage(m);
    });
    /* Triggers : the active GM's client watches */
    Hooks.on("createChatMessage", message => this.onCard(message));
    Hooks.on("moveToken", (token, movement, options) => this.onMove(token, movement, options));
    Hooks.on("updateCombat", (combat, changes) => this.onTurn(combat, changes));
    /* Opportunity Attacks : the mover's client, before the move */
    Hooks.on("preMoveToken", (token, movement, options) => this.preMove(token, movement, options));
  }

  static enabled(){
    return actionTracker.enabled();
  }

  /* ---------- Ready ---------- */

  /* What it can ready : its uses that take an Action */
  static readyChoices(actor){
    const out = [];
    for(const item of actor.items){
      if((item.type === "spell") && (Number(item.system.level) > 0) && (item.system.method === "spell") && !(Number(item.system.prepared) > 0)) continue;
      for(const activity of item.system.activities ?? []){
        const type = activity.activation?.type || item.system.activation?.type;
        if(type === "action") out.push({ value : `${item.id}.${activity.id}`, label : (activity.name && (activity.name !== item.name)) ? `${item.name} : ${activity.name}` : item.name });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  static lowestSlot(actor, level){
    const slots = Object.entries(actor.system?.spells ?? {})
      .filter(([, s]) => (Number(s?.value) > 0) && (Number(s?.level) >= level))
      .sort(([, a], [, b]) => a.level - b.level);
    return slots[0] ?? null;
  }

  /* The bar's Ready : choose, pay (its Action; a spell's slot and Concentration), mark */
  static async ready(token, actor){
    const st = actionTracker.state(actor);
    if(!st?.mine || st.rec.ready) return;
    if((actionTracker.remaining(st.rec, "action") <= 0)
      && !(await import('./limits.js')).limits.allow(module.format("actionTracker.spent", { name : actor.name, kind : actionTracker.label("action") }), { who : actor.name, what : module.i18n("actionTracker.ready.title") })) return;
    const choices = this.readyChoices(actor);
    if(!choices.length) return ui.notifications.warn(module.i18n("actionTracker.ready.none"));
    const use = await chooseOption({ title : module.i18n("actionTracker.ready.title"), icon : "fa-solid fa-hourglass-half", prompt : module.i18n("actionTracker.ready.what"), options : choices });
    if(!use) return;
    const trigger = await chooseOption({ title : module.i18n("actionTracker.ready.title"), icon : "fa-solid fa-hourglass-half", prompt : module.i18n("actionTracker.ready.when"),
      options : this.TRIGGERS.map(t => ({ value : t, label : module.i18n(`actionTracker.trigger.${t}`) })) });
    if(!trigger) return;
    let turnOf = null;
    if(trigger === "turnStarts"){
      const [picked] = await pickTargets(token, { count : 1, range : Infinity, disposition : "any", includeSelf : false, useTargets : false, setTargets : false,
        notice : module.i18n("actionTracker.ready.pickTurn") }) ?? [];
      if(!picked) return;
      turnOf = { token : picked.document.uuid, name : picked.name };
    }
    const [itemId, activityId] = use.split(".");
    const item = actor.items.get(itemId);
    const activity = item?.system.activities?.get(activityId);
    if(!activity) return;
    /* A levelled spell : cast now (its slot, Concentration on it), released later */
    let slot = null, concentration = null;
    if((item.type === "spell") && (Number(item.system.level) > 0)){
      const found = this.lowestSlot(actor, Number(item.system.level));
      if(!found) return ui.notifications.warn(module.format("actionTracker.ready.noSlot", { spell : item.name }));
      slot = { key : found[0], level : Number(found[1].level) };
      await actor.update({ [`system.spells.${found[0]}.value`] : Number(found[1].value) - 1 });
      const effect = await actor.beginConcentrating?.(activity, { name : module.format("actionTracker.ready.concentration", { spell : item.name }),
        flags : { [module.id] : { readied : true } } }).catch(error => { log.debug(error); return null; });
      concentration = effect?.id ?? null;
    }
    const fresh = actionTracker.state(actor);
    if(!fresh) return;
    fresh.rec.used.action = (Number(fresh.rec.used.action) || 0) + 1;
    fresh.rec.ready = { item : item.id, activity : activity.id, name : item.name, trigger, turnOf, slot, concentration, at : Date.now() };
    actionTracker.note(fresh.rec, module.format("actionTracker.log.ready", { what : item.name, trigger : this.triggerText(fresh.rec.ready) }));
    await actionTracker.save(actor, fresh.rec);
  }

  static triggerText(ready){
    const text = module.i18n(`actionTracker.trigger.${ready?.trigger}`);
    return ready?.turnOf ? `${text} (${ready.turnOf.name})` : text;
  }

  /* Its readied use goes (Reaction used elsewhere, its turn) : its readied Concentration ends with it */
  static async dropReady(actor, ready){
    if(!ready?.concentration) return;
    const effect = actor.effects.get(ready.concentration);
    if(effect) await effect.delete().catch(error => log.debug(error));
  }

  /* Initiate : the readied use, as its Reaction (a spell : the slot already paid) */
  static async release(actor, at = null){
    const st = actionTracker.state(actor);
    const ready = st?.rec.ready;
    if(at && (ready?.at !== at)) return null;
    const item = ready ? actor.items.get(ready.item) : null;
    const activity = item?.system.activities?.get(ready.activity);
    if(!activity) return null;
    if(ready.concentration) await this.dropReady(actor, ready);
    const config = { [module.id] : { economy : "reaction", readied : true } };
    if(ready.slot){
      config.consume = { spellSlot : false };
      config.spell = { slot : ready.slot.key };
      config.scaling = Math.max(0, ready.slot.level - (Number(item.system.level) || 0));
    }
    return activity.use(config);
  }

  /* ---------- Triggers (the active GM's client) ---------- */

  static relation(reader, other){
    const a = reader.document?.disposition ?? reader.disposition, b = other.document?.disposition ?? other.disposition;
    const N = CONST.TOKEN_DISPOSITIONS.NEUTRAL;
    if((a === N) || (b === N) || (a === CONST.TOKEN_DISPOSITIONS.SECRET) || (b === CONST.TOKEN_DISPOSITIONS.SECRET)) return null;
    return (a === b) ? "ally" : "enemy";
  }

  /* The creatures with something readied, off their turn, Reaction left : [{ actor, token, ready, combat }] */
  static waiting(scene){
    const out = [];
    for(const combat of game.combats.filter(c => c.started)){
      for(const combatant of combat.combatants){
        const token = combatant.token;
        const actor = combatant.actor;
        if(!actor || !token || (scene && (token.parent !== scene))) continue;
        const st = actionTracker.state(actor);
        if(!st?.rec.ready || st.mine || (actionTracker.remaining(st.rec, "reaction") <= 0)) continue;
        out.push({ actor, token, ready : st.rec.ready, combat });
      }
    }
    return out;
  }

  static sees(reader, other){
    if(!canvas.ready || (canvas.scene?.id !== reader.parent?.id)) return true;
    const a = reader.object, b = other.object ?? other;
    return (a && b) ? canSee(a, b) : true;
  }

  /* One card at a time per creature : a new trigger while one waits for an answer is skipped */
  static async fire(entry, text){
    const pending = game.messages.contents.slice(-30).some(m => { const f = m.getFlag(module.id, "readyPrompt"); return f && (f.actor === entry.actor.uuid) && (f.status === "pending") && (f.at === entry.ready.at); });
    if(pending) return;
    const owners = game.users.filter(u => entry.actor.testUserPermission(u, "OWNER")).map(u => u.id);
    await ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor : entry.actor, token : entry.token }),
      whisper : [...new Set([...owners, ...game.users.filter(u => u.isGM).map(u => u.id)])],
      content : `<div class="${module.id}-ready-card"><p><strong>${esc(module.i18n("actionTracker.ready.triggered"))}</strong> ${esc(text)}</p>
        <ul class="unlist macro-helper-rows"><li class="macro-helper-row"><img class="token" src="${esc(entry.token.texture?.src ?? entry.actor.img)}" alt="">
        <span class="name">${esc(entry.token.name)}</span><span class="${module.id}-ready-what">${esc(module.format("actionTracker.ready.marker", { what : entry.ready.name, trigger : this.triggerText(entry.ready) }))}</span>
        <span class="macro-helper-row-apply ${module.id}-ready-answer"></span></li></ul></div>`,
      flags : { [module.id] : { readyPrompt : { actor : entry.actor.uuid, token : entry.token.uuid, status : "pending", at : entry.ready.at } } },
    });
  }

  static async check(kind, other, { from = null } = {}){
    if(!this.enabled() || !game.users.activeGM?.isSelf || !other) return;
    for(const entry of this.waiting(other.parent)){
      if(entry.token === other) continue;
      const rel = this.relation(entry.token, other);
      const t = entry.ready.trigger;
      let hit = false;
      if(kind === "attacks") hit = (t === `${rel}Attacks`);
      else if(kind === "heals") hit = (t === `${rel}Heals`);
      else if(kind === "moves"){
        hit = (t === `${rel}Moves`);
        if((t === "enemyLeaves") && (rel === "enemy") && from){
          const reach = this.reachOf(entry.actor);
          hit = (this.feet(from, entry.token) <= reach) && (this.feet(other, entry.token) > reach);
        }
      }
      else if(kind === "turn") hit = (t === "turnStarts") && (entry.ready.turnOf?.token === other.uuid);
      if(!hit || ((kind !== "turn") && !this.sees(entry.token, other))) continue;
      await this.fire(entry, module.format(`actionTracker.happened.${kind}`, { name : other.name }));
    }
  }

  static onCard(message){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    /* Use cards only (dnd5e's turn / rest messages have no activity : asking throws) */
    if(!["usage", "macro-helper.rollItem", "macro-helper.save"].includes(message.type)) return;
    let activity = null;
    try { activity = message.getAssociatedActivity?.(); } catch { return; }
    const token = message.getAssociatedToken?.() ?? (message.speaker?.token ? game.scenes.get(message.speaker.scene)?.tokens.get(message.speaker.token) : null);
    if(!activity || !token) return;
    /* Roll Item's cards and dnd5e's usage cards : once per use (the usage card when there's no Roll Item card) */
    const kind = (activity.type === "heal") ? "heals" : ["attack", "save", "damage"].includes(activity.type) ? "attacks" : null;
    if(!kind) return;
    if((message.type === "usage") && settings_rollItem()) return;
    this.check(kind, token);
  }

  static onMove(token, movement){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    const from = movement?.origin ? { x : movement.origin.x, y : movement.origin.y, width : token.width, height : token.height, elevation : movement.origin.elevation ?? 0 } : null;
    this.check("moves", token, { from });
  }

  static onTurn(combat, changes){
    if(!this.enabled() || !game.users.activeGM?.isSelf || !(("turn" in (changes ?? {})) || ("round" in (changes ?? {})))) return;
    const token = combat.combatant?.token;
    if(token) this.check("turn", token);
    /* Its turn : a readied spell not released is lost */
    const actor = combat.combatant?.actor;
    const effect = actor?.effects?.find(e => e.getFlag(module.id, "readied"));
    if(effect) effect.delete().catch(error => log.debug(error));
  }

  /* ---------- The readied card ---------- */

  static drawReadyCard(message, html){
    const flag = message.getFlag?.(module.id, "readyPrompt");
    const box = flag ? html.querySelector(`.${module.id}-ready-answer`) : null;
    if(!box) return;
    if(flag.status !== "pending"){
      box.innerHTML = `<span class="applied">${esc(module.i18n(`actionTracker.ready.${flag.status}`))}</span>`;
      return;
    }
    const actor = fromUuidSync(flag.actor, { strict : false });
    /* Not that readied action any more (released, lost, its turn came) */
    if(actionTracker.state(actor)?.rec.ready?.at !== flag.at){
      box.innerHTML = `<span class="applied">${esc(module.i18n("actionTracker.ready.stale"))}</span>`;
      return;
    }
    if(!(game.user.isGM || actor?.isOwner)) return;
    box.innerHTML = `<button type="button" data-answer="initiated"><i class="fa-solid fa-bolt" inert></i> ${esc(module.i18n("actionTracker.ready.initiate"))}</button>
      <button type="button" data-answer="waited"><i class="fa-solid fa-hourglass-half" inert></i> ${esc(module.i18n("actionTracker.ready.wait"))}</button>`;
    for(const button of box.querySelectorAll("button")) button.addEventListener("click", async event => {
      event.preventDefault();
      const answer = event.currentTarget.dataset.answer;
      box.querySelectorAll("button").forEach(b => b.disabled = true);
      if(answer === "initiated"){
        const token = fromUuidSync(flag.token, { strict : false });
        token?.object?.control({ releaseOthers : true });
        const used = await this.release(actor, flag.at);
        /* Closed before anything was rolled (the target pick) : still readied */
        if(!used || !(await uses.cardOf(used).catch(() => null))){ box.querySelectorAll("button").forEach(b => b.disabled = false); return; }
      }
      await gm.run("readyAnswer", { message : message.id, status : answer });
    });
  }

  static async readyAnswerAsGM({ message : id, status } = {}, user){
    const message = game.messages.get(id);
    const flag = message?.getFlag(module.id, "readyPrompt");
    const actor = flag ? fromUuidSync(flag.actor, { strict : false }) : null;
    if(!flag || (flag.status !== "pending") || !["initiated", "waited"].includes(status) || !(user.isGM || actor?.testUserPermission(user, "OWNER"))) return false;
    await message.setFlag(module.id, "readyPrompt", { ...flag, status });
    return true;
  }

  /* ---------- Opportunity Attacks ---------- */

  /* Its reach : its melee attacks' (Reach weapons 10 ft), else none */
  static reachOf(actor){
    let reach = 0;
    for(const item of actor?.items ?? []){
      if(!item.system?.activities?.some?.(a => a.type === "attack")) continue;
      if((item.type === "weapon") && (actor.type === "character") && !item.system.equipped) continue;
      const attack = item.system.activities.find(a => a.type === "attack");
      const melee = (attack?.attack?.type?.value ?? attack?.actionType ?? "melee") === "melee" || /^m/.test(attack?.actionType ?? "");
      if(!melee) continue;
      const props = item.system.properties;
      const rch = !!(props?.has?.("rch"));
      reach = Math.max(reach, Number(item.system.range?.reach) || (rch ? 10 : this.DEFAULT_REACH));
    }
    return reach;
  }

  /* The weapon an Opportunity Attack is made with : a melee attack in a hand, else any melee attack */
  static oaAttackOf(actor){
    const melee = actor.items.filter(i => i.system?.activities?.some?.(a => (a.type === "attack") && ((a.attack?.type?.value ?? "melee") === "melee")));
    const held = actor.getFlag?.(module.id, "hands") ?? {};
    const inHand = i => [held.main, held.off].includes(i.id);
    const pick = melee.find(i => inHand(i) && (i.type === "weapon")) ?? melee.find(i => i.system.equipped && (i.type === "weapon") && (idOf(i) !== "unarmed-strike"))
      ?? melee.find(i => i.type === "weapon") ?? melee[0];
    return pick?.system.activities.find(a => a.type === "attack") ?? null;
  }

  /* Two melee weapons in hand : which one */
  static async chooseOAAttack(actor){
    const held = actor.getFlag?.(module.id, "hands") ?? {};
    const inHand = [...new Set([held.main, held.off])].map(id => actor.items.get(id))
      .filter(i => (i?.type === "weapon") && i.system.activities?.some?.(a => (a.type === "attack") && ((a.attack?.type?.value ?? "melee") === "melee")));
    if(inHand.length < 2) return this.oaAttackOf(actor);
    const id = await chooseOption({ title : module.i18n("actionTracker.oa.attack"), icon : "fa-solid fa-hand-fist", prompt : module.i18n("actionTracker.oa.which"),
      options : inHand.map(i => ({ value : i.id, label : i.name })) });
    return id ? actor.items.get(id)?.system.activities.find(a => a.type === "attack") ?? null : null;
  }

  /* Feet between a footprint ({x, y, width, height, elevation}) and a token */
  static feet(a, b){
    const ca = cells(a), cb = cells(b.document ?? b);
    const gx = Math.max(0, cb.left - ca.right, ca.left - cb.right);
    const gy = Math.max(0, cb.top - ca.bottom, ca.top - cb.bottom);
    return gridSteps(gx, gy) * (canvas.scene?.grid?.distance || 5);
  }

  /* Its path, square by square (top-left positions) */
  static pathOf(token, movement){
    const grid = token.parent.grid;
    const size = grid.size;
    const points = [movement.origin, ...(movement.passed?.waypoints ?? []), ...(movement.pending?.waypoints ?? [])].filter(Boolean)
      .map(p => ({ x : p.x, y : p.y, elevation : p.elevation ?? 0 }));
    const out = points.length ? [points[0]] : [];
    const centre = p => ({ x : p.x + (token.width * size / 2), y : p.y + (token.height * size / 2) });
    for(let i = 1; i < points.length; i++){
      const cellsOn = grid.isGridless ? [] : grid.getDirectPath([centre(points[i - 1]), centre(points[i])]);
      if(!cellsOn.length){ out.push(points[i]); continue; }
      for(const cell of cellsOn.slice(1)){
        const c = grid.getCenterPoint(cell);
        out.push({ x : c.x - (token.width * size / 2), y : c.y - (token.height * size / 2), elevation : points[i].elevation });
      }
    }
    return out.filter((p, i, all) => !i || (p.x !== all[i - 1].x) || (p.y !== all[i - 1].y));
  }

  /* Before a drag : the first square where it leaves someone's reach : stop there, ask them */
  static preMove(token, movement, options = {}){
    if(!this.enabled()) return;
    const own = options?.[module.id] ?? {};
    if(own.oaSkip || !(["dragging", "keyboard"].includes(movement?.method) || own.oaResume)) return;
    const actor = token.actor;
    const disengaged = actor?.statuses?.has?.("disengaged") || actor?.effects?.some?.(e => !e.disabled && (e.getFlag(module.id, "disengaged") || e.getFlag(module.id, "disengage")));
    if(!actor || disengaged) return;
    if(!actionTracker.combatOf(actor)) return;
    const done = new Set(own.oaDone ?? []);
    const threats = token.parent.tokens.filter(t => (t !== token) && t.actor && !t.hidden && !done.has(t.uuid) && (this.relation(t, token) === "enemy")
      && actionTracker.combatOf(t.actor) && actionTracker.left(t.actor, "reaction") && !actionTracker.OUT_OF_ACTION.some(s => t.actor.statuses?.has?.(s))
      && (this.reachOf(t.actor) > 0) && (!t.object || !token.object || canSee(t.object, token.object)));
    if(!threats.length) return;
    const path = this.pathOf(token, movement);
    const foot = p => ({ x : p.x, y : p.y, width : token.width, height : token.height, elevation : p.elevation });
    let stop = -1, who = [];
    for(let i = 0; (i < path.length - 1) && (stop < 0); i++){
      const leaving = threats.filter(t => { const r = this.reachOf(t.actor); return (this.feet(foot(path[i]), t) <= r) && (this.feet(foot(path[i + 1]), t) > r); });
      if(leaving.length){ stop = i; who = leaving; }
    }
    if(stop < 0) return;
    const rest = path.slice(stop + 1).map(p => ({ x : p.x, y : p.y, elevation : p.elevation }));
    const until = path.slice(1, stop + 1).map(p => ({ x : p.x, y : p.y, elevation : p.elevation }));
    this.stopForOA(token, until, rest, who, [...done]);
    return false;
  }

  static async stopForOA(token, until, rest, threats, done){
    /* The refused drag winds down first (a new move during it collides with it) */
    await new Promise(resolve => setTimeout(resolve, 250));
    await token.object?.movementAnimationPromise?.catch?.(() => null);
    if(until.length) await token.move(until, { [module.id] : { oaSkip : true } }).catch(error => log.debug(error));
    const rows = threats.map(t => ({ token : t.uuid, status : "pending" }));
    const users = new Set(game.users.filter(u => u.isGM).map(u => u.id));
    for(const t of threats) for(const u of game.users) if(t.actor.testUserPermission(u, "OWNER")) users.add(u.id);
    for(const u of game.users) if(token.actor?.testUserPermission(u, "OWNER")) users.add(u.id);
    await ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ token }),
      whisper : [...users],
      content : `<div class="${module.id}-oa-card"><p><strong>${esc(module.i18n("actionTracker.oa.title"))}</strong> ${esc(module.format("actionTracker.oa.text", { name : token.name }))}</p>
        <ul class="unlist macro-helper-rows ${module.id}-oa-rows"></ul><div class="${module.id}-oa-gm"></div></div>`,
      flags : { [module.id] : { oaStop : { mover : token.uuid, rest, done : [...done, ...threats.map(t => t.uuid)], rows, status : "pending" } } },
    });
  }

  static drawOACard(message, html){
    const flag = message.getFlag?.(module.id, "oaStop");
    const list = flag ? html.querySelector(`.${module.id}-oa-rows`) : null;
    if(!list) return;
    list.innerHTML = "";
    flag.rows.forEach((row, index) => {
      const t = fromUuidSync(row.token, { strict : false });
      const li = document.createElement("li");
      li.className = "macro-helper-row";
      const may = (flag.status === "pending") && (row.status === "pending") && (game.user.isGM || t?.actor?.isOwner);
      li.innerHTML = `<img class="token" src="${esc(t?.texture?.src ?? t?.actor?.img ?? "")}" alt=""><span class="name">${esc(t?.name ?? "?")}</span>
        <span class="macro-helper-row-apply">${(row.status !== "pending") ? `<span class="applied">${esc(module.i18n(`actionTracker.oa.${row.status}`))}</span>`
          : may ? `<button type="button" data-answer="attacked"><i class="fa-solid fa-hand-fist" inert></i> ${esc(module.i18n("actionTracker.oa.attack"))}</button>
                   <button type="button" data-answer="passed"><i class="fa-solid fa-forward" inert></i> ${esc(module.i18n("actionTracker.oa.pass"))}</button>` : ""}</span>`;
      for(const button of li.querySelectorAll("button")) button.addEventListener("click", async event => {
        event.preventDefault();
        const answer = event.currentTarget.dataset.answer;
        li.querySelectorAll("button").forEach(b => b.disabled = true);
        if(answer === "attacked"){
          const attack = await this.chooseOAAttack(t.actor);
          const mover = fromUuidSync(flag.mover, { strict : false });
          if(!attack || !mover?.object){ li.querySelectorAll("button").forEach(b => b.disabled = false); return; }
          t.object?.control({ releaseOthers : true });
          canvas.tokens.setTargets([mover.id]);
          const used = await attack.use({ [module.id] : { economy : "reaction", oa : true, skipPick : true, useTargets : true } });
          if(!used || !(await uses.cardOf(used).catch(() => null))){ li.querySelectorAll("button").forEach(b => b.disabled = false); return; }
        }
        await gm.run("oaAnswer", { message : message.id, index, status : answer });
      });
      list.append(li);
    });
    const gmBox = html.querySelector(`.${module.id}-oa-gm`);
    if(gmBox && game.user.isGM && (flag.status === "pending")){
      gmBox.innerHTML = `<div class="card-buttons"><button type="button" data-answer="continue"><i class="fa-solid fa-play" inert></i> ${esc(module.i18n("actionTracker.oa.continue"))}</button>
        <button type="button" data-answer="stopped"><i class="fa-solid fa-hand" inert></i> ${esc(module.i18n("actionTracker.oa.stop"))}</button></div>`;
      for(const button of gmBox.querySelectorAll("button")) button.addEventListener("click", event => {
        event.preventDefault();
        gm.run("oaAnswer", { message : message.id, status : event.currentTarget.dataset.answer });
      });
    }
    else if(gmBox && (flag.status !== "pending")) gmBox.innerHTML = `<p><em>${esc(module.i18n(`actionTracker.oa.${flag.status}`))}</em></p>`;
  }

  /* GM : a row answered (its owner) or the move decided (GM); once all are answered, the move goes on */
  static async oaAnswerAsGM({ message : id, index = null, status } = {}, user){
    const message = game.messages.get(id);
    const flag = foundry.utils.deepClone(message?.getFlag(module.id, "oaStop"));
    if(!flag || (flag.status !== "pending")) return false;
    if(index !== null){
      const row = flag.rows[index];
      const t = row ? fromUuidSync(row.token, { strict : false }) : null;
      if(!row || (row.status !== "pending") || !["attacked", "passed"].includes(status) || !(user.isGM || t?.actor?.testUserPermission(user, "OWNER"))) return false;
      row.status = status;
    }
    else {
      if(!user.isGM || !["continue", "stopped"].includes(status)) return false;
      flag.status = status;
    }
    const allDone = flag.rows.every(r => r.status !== "pending");
    if(allDone && (flag.status === "pending")) flag.status = "continue";
    await message.setFlag(module.id, "oaStop", flag);
    if(flag.status === "continue"){
      const mover = fromUuidSync(flag.mover, { strict : false });
      const alive = mover?.actor && !(Number(mover.actor.system?.attributes?.hp?.value) <= 0);
      if(alive && flag.rest?.length) await mover.move(flag.rest, { [module.id] : { oaResume : true, oaDone : flag.done } }).catch(error => log.debug(error));
    }
    return true;
  }
}

/* Roll Item makes its own cards : dnd5e's usage card then isn't the one to count */
function settings_rollItem(){
  try { return !!game.settings.get(module.id, "rollItemEnabled"); } catch { return false; }
}
