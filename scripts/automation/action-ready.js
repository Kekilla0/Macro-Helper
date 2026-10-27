import { module } from '../module.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { idOf, esc, chooseOption, waitFor } from '../helpers/utils.js';
import { cells, gridSteps, canSee } from '../helpers/tokens.js';
import { pickTargets } from '../helpers/targets.js';
import { actionTracker } from './action-tracker.js';
import { reactionMoveOf } from '../roll-item/card-builder.js';
import { hands } from './hands.js';
import { uses } from '../uses.js';
import { movement as moves } from './movement.js';
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
 *                   answered, the GM's client finishes the move (the GM may Continue or Stop here at any time). An
 *                   attack that hit waits for its damage first (brought to 0 HP, or its Speed now 0 : the move ends).
 *
 * The reaction attack lego : more moments for that card (Polearm Master's Reactive Strike, Sentinel's Guardian; a
 * monster's "when a creature enters its reach, it can bite as a Reaction"), and something to do instead of an
 * Opportunity Attack (War Caster's spell; a monster that breathes instead) :
 *
 *   reactionAttackOn(match, {
 *     on : "enters",                  "enters" (a creature's own move takes it into its reach : stopped there; not
 *                                     Disengage's, it isn't an Opportunity Attack), "disengages" (a creature within
 *                                     `within` ft takes the Disengage action), "hitsOther" (a creature within `within`
 *                                     ft hits someone else with an attack)
 *     within : 5,                     "disengages" / "hitsOther" : how close
 *     weapon : item => boolean,       what it may attack with (held, or part of its body); "enters" : their reach
 *     opportunity : true,             it's an Opportunity Attack (Sentinel's Halt reads that); false : a Reaction attack
 *     sees : false,                   only a creature it can see
 *     when : info => boolean,         info { actor, token (its), other (the creature's token), source }
 *     label : source => string,       the row's button (default : Opportunity Attack)
 *     enabled, id
 *   })
 *   opportunityInstead(match, {
 *     label : source => string, icon,
 *     choices : (actor, mover) => [{ value, label }],   what it can do (none : no button)
 *     run : (token, mover, value) => results,          does it at the mover (a use's results; null : nothing done)
 *     enabled, id
 *   })
 *   match : an item identifier the creature has (or several), or (actor) => the item (or anything truthy) that gives it
 */
const attackRules = new Map();
const insteadRules = new Map();

const keyOf = (match, id) => id ?? ((typeof match === "function") ? foundry.utils.randomID() : [match].flat().map(String).join(","));

function sourceOf(actor, match){
  if(!actor) return null;
  if(typeof match === "function"){
    try { return match(actor) || null; } catch(error){ log.error("Reaction attack match", error); return null; }
  }
  const ids = [match].flat();
  return actor.items?.find?.(i => (i.type !== "spell") && ids.includes(idOf(i))) ?? null;
}

/**
 * Another moment a creature may attack with its Reaction (see above).
 * @param {string|string[]|Function} match
 * @param {object} options
 * @returns {string}  the rule's id
 */
export function reactionAttackOn(match, { on, within = 5, weapon = null, opportunity = true, sees = false, when = null, label = null, enabled = null, id = null } = {}){
  const key = keyOf(match, id);
  attackRules.set(key, { id : key, match, on, within, weapon, opportunity, sees, when, label, enabled });
  return key;
}

/**
 * Something a creature may do instead of an Opportunity Attack (see above).
 * @param {string|string[]|Function} match
 * @param {object} options
 * @returns {string}  the rule's id
 */
export function opportunityInstead(match, { label = null, icon = "fa-wand-sparkles", choices, run, enabled = null, id = null } = {}){
  const key = keyOf(match, id);
  insteadRules.set(key, { id : key, match, label, icon, choices, run, enabled });
  return key;
}

const isOn = rule => !rule.enabled || rule.enabled();

export class actionReady{
  static TRIGGERS = ["enemyAttacks", "enemyComes", "enemyMoves", "enemyLeaves", "enemyHeals", "enemyStands", "allyAttacks", "allyMoves", "allyHeals", "turnStarts"];
  static DEFAULT_REACH = 5;

  static register(){
    if(game.system.id !== "dnd5e") return;
    gm.handle("readyAnswer", (data, user) => this.readyAnswerAsGM(data, user));
    gm.handle("oaAnswer", (data, user) => this.oaAnswerAsGM(data, user));
    gm.handle("oaDamaged", (data, user) => this.oaDamagedAsGM(data, user));
    /* An Opportunity Attack's damage landed : the move may go on */
    Hooks.on("dnd5e.applyDamage", (actor, amount, options) => this.onOADamage(actor, options));
    /* The reaction attack lego's moments : the Disengage action, a hit on someone else (the active GM) */
    Hooks.on("createActiveEffect", effect => this.onDisengage(effect));
    Hooks.on("createChatMessage", message => this.onHitOther(message));
    Hooks.on("updateChatMessage", message => this.onHitOther(message));
    Hooks.on("renderChatMessageHTML", (message, html) => { this.drawReadyCard(message, html); this.drawOACard(message, html); });
    /* Its readied action changed : its cards show it */
    Hooks.on("updateActor", (actor, changes) => {
      if(!foundry.utils.hasProperty(changes ?? {}, `flags.${module.id}.economy`)) return;
      for(const m of game.messages.contents.slice(-40)) if(m.getFlag(module.id, "readyPrompt")?.actor === actor.uuid) ui.chat?.updateMessage(m);
    });
    /* Triggers : the active GM's client watches */
    Hooks.on("createChatMessage", message => this.onCard(message));
    Hooks.on("moveToken", (token, movement, options) => this.onMove(token, movement, options));
    Hooks.on(`${module.id}.turnStart`, combat => this.onTurn(combat));
    /* Stands up : its Prone ends (an archer waiting until it's up, not at disadvantage) */
    Hooks.on("deleteActiveEffect", effect => this.onProneEnds(effect));
    /* Opportunity Attacks : the mover's client, before the move */
    Hooks.on("preMoveToken", (token, movement, options) => this.preMove(token, movement, options));
  }

  static enabled(){
    return actionTracker.enabled();
  }

  /* ---------- Ready ---------- */

  /* Actions with nothing to do as a Reaction once readied movement isn't offered (Dash, Disengage), or that make no sense
     readied (Dodge, Ready itself) */
  static NOT_READIED = ["dash", "disengage", "dodge", "ready"];

  /* What it can ready : its uses that take an Action and it could make now. Weapons : held (Hands; else equipped), or
     part of the body (Unarmed Strike, natural weapons). Spells : prepared, a slot left for a levelled one. Nothing with
     its uses spent */
  static readyChoices(actor){
    const out = [];
    const character = actor.type === "character";
    const held = hands.manages(actor) ? new Set(hands.heldItems(actor).map(i => i.id)) : null;
    for(const item of actor.items){
      if(this.NOT_READIED.includes(idOf(item))) continue;
      /* Held things (weapons, a torch to swing) : in a hand; body weapons always */
      if(character && !hands.isBody(item) && ((item.type === "weapon") || (held && hands.canHold(item)))
        && !(held ? held.has(item.id) : item.system.equipped)) continue;
      if(item.type === "spell"){
        const level = Number(item.system.level) || 0;
        if((level > 0) && (item.system.method === "spell") && !(Number(item.system.prepared) > 0)) continue;
        if((level > 0) && ["spell", "pact"].includes(item.system.method ?? "spell") && !this.lowestSlot(actor, level)) continue;
      }
      if((Number(item.system.uses?.max) > 0) && !(Number(item.system.uses?.value) > 0)) continue;
      for(const activity of item.system.activities ?? []){
        const type = activity.activation?.type || item.system.activation?.type;
        if(type !== "action") continue;
        if((Number(activity.uses?.max) > 0) && !(Number(activity.uses?.value) > 0)) continue;
        out.push({ value : `${item.id}.${activity.id}`, label : (activity.name && (activity.name !== item.name)) ? `${item.name} : ${activity.name}` : item.name });
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
        <ul class="unlist macro-helper-rows"><li class="macro-helper-row"><img class="token" src="${esc(entry.token.texture?.src ?? entry.actor.img)}" alt="" data-token="${esc(entry.token.uuid)}">
        <span class="name">${esc(entry.token.name)}</span><span class="${module.id}-ready-what">${esc(module.format("actionTracker.ready.marker", { what : entry.ready.name, trigger : this.triggerText(entry.ready) }))}</span>
        <span class="macro-helper-row-apply ${module.id}-ready-answer"></span></li></ul></div>`,
      flags : { [module.id] : { readyPrompt : { actor : entry.actor.uuid, token : entry.token.uuid, status : "pending", at : entry.ready.at } } },
    });
  }

  static async check(kind, other, { from = null, to = null } = {}){
    if(!this.enabled() || !game.users.activeGM?.isSelf || !other) return;
    for(const entry of this.waiting(other.parent)){
      if(entry.token === other) continue;
      const rel = this.relation(entry.token, other);
      const t = entry.ready.trigger;
      let hit = false;
      if(kind === "attacks") hit = (t === `${rel}Attacks`);
      else if(kind === "heals") hit = (t === `${rel}Heals`);
      else if(kind === "stands") hit = (t === `${rel}Stands`);
      else if(kind === "moves"){
        hit = (t === `${rel}Moves`);
        if((t === "enemyLeaves") && (rel === "enemy") && from){
          const reach = this.reachOf(entry.actor);
          hit = (this.feet(from, entry.token) <= reach) && (this.feet(to ?? other, entry.token) > reach);
        }
        /* Moves within the readied use's reach / range : the move ends inside it (coming in, or moving about in it) */
        if((t === "enemyComes") && (rel === "enemy")){
          const range = this.readyRange(entry.actor, entry.ready);
          if(range && (this.feet(to ?? other, entry.token) <= range)){
            if(!this.sees(entry.token, other)) continue;
            await this.fire(entry, module.format("actionTracker.happened.comes", { name : other.name, feet : range }));
          }
          continue;
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
    /* Where it went : the hook comes as the move starts, the document isn't there yet */
    const at = p => p ? { x : p.x, y : p.y, width : p.width ?? token.width, height : p.height ?? token.height, elevation : p.elevation ?? 0 } : null;
    this.check("moves", token, { from : at(movement?.origin), to : at(movement?.destination) });
  }

  static onProneEnds(effect){
    if(!this.enabled() || !game.users.activeGM?.isSelf || !effect?.statuses?.has?.("prone")) return;
    const actor = effect.parent;
    if((actor?.documentName !== "Actor") || actor.statuses?.has?.("prone")) return;
    const token = actor.token ?? actor.getActiveTokens?.(false, true)?.[0] ?? null;
    if(token) this.check("stands", token);
  }

  static onTurn(combat){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
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

  /* How close the readied use reaches : a melee attack's reach (a thrown weapon : its normal range), else its (normal)
     range; Touch : 5 ft */
  static readyRange(actor, ready){
    const item = actor?.items?.get(ready?.item);
    const activity = item?.system.activities?.get(ready?.activity);
    if(!activity) return null;
    const range = activity.range?.override ? activity.range : (item.system.range ?? activity.range ?? {});
    const melee = (activity.type === "attack") && ((activity.attack?.type?.value ?? "melee") === "melee");
    const reach = Number(item.system.range?.reach) || (item.system.properties?.has?.("rch") ? 10 : this.DEFAULT_REACH);
    /* A thrown weapon : as far as it's thrown (normal range) */
    if(melee) return item.system.properties?.has?.("thr") ? Math.max(reach, Number(item.system.range?.value) || 0) : reach;
    if(range.units === "touch") return this.DEFAULT_REACH;
    if(range.units === "ft") return Number(range.value) || null;
    if(range.units === "mi") return (Number(range.value) || 0) * 5280 || null;
    return null;
  }

  /* ---------- Opportunity Attacks ---------- */

  /* What it holds to attack with : held weapons (Hands; a creature before its hands are in use : what the GM marked
     equipped), or equipped ones without Hands. Natural weapons and Unarmed Strike are always there */
  static heldWeapons(actor){
    if(hands.manages(actor)) return new Set(hands.heldItems(actor).map(i => i.id));
    return new Set((actor?.items ?? []).filter(i => (i.type === "weapon") && (i.system.equipped || (actor.type === "npc"))).map(i => i.id));
  }

  static meleeAttackOf(item){
    return item?.system?.activities?.find?.(a => (a.type === "attack") && ((a.attack?.type?.value ?? "melee") === "melee")) ?? null;
  }

  /* Its reach : its held melee weapons' (Reach : 10 ft) and its natural ones, else none */
  static reachOf(actor){
    const held = this.heldWeapons(actor);
    let reach = 0;
    for(const item of actor?.items ?? []){
      if(!this.meleeAttackOf(item)) continue;
      if((item.type === "weapon") && !hands.isBody(item) && !held.has(item.id)) continue;
      const rch = !!(item.system.properties?.has?.("rch"));
      reach = Math.max(reach, Number(item.system.range?.reach) || (rch ? 10 : this.DEFAULT_REACH));
    }
    return reach;
  }

  /* The weapon an Opportunity Attack is made with : a melee weapon it holds, else a natural weapon or Unarmed Strike
     (never one it isn't holding : there's no drawing a weapon on someone else's turn) */
  static oaAttackOf(actor){
    const held = this.heldWeapons(actor);
    const melee = actor.items.filter(i => this.meleeAttackOf(i));
    const pick = melee.find(i => (i.type === "weapon") && !hands.isBody(i) && held.has(i.id))
      ?? melee.find(i => hands.isBody(i) && (idOf(i) !== "unarmed-strike")) ?? melee.find(i => idOf(i) === "unarmed-strike")
      ?? melee.find(i => i.type !== "weapon");
    return pick ? this.meleeAttackOf(pick) : null;
  }

  /* Two melee weapons in hand : which one */
  static async chooseOAAttack(actor){
    const held = this.heldWeapons(actor);
    const inHand = actor.items.filter(i => (i.type === "weapon") && !hands.isBody(i) && held.has(i.id) && this.meleeAttackOf(i));
    if(inHand.length < 2) return this.oaAttackOf(actor);
    const id = await chooseOption({ title : module.i18n("actionTracker.oa.attack"), icon : "fa-solid fa-hand-fist", prompt : module.i18n("actionTracker.oa.which"),
      options : inHand.map(i => ({ value : i.id, label : i.name })) });
    return id ? this.meleeAttackOf(actor.items.get(id)) : null;
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
      .map(p => ({ x : p.x, y : p.y, elevation : p.elevation ?? 0, ...(p.action ? { action : p.action } : {}) }));
    const out = points.length ? [points[0]] : [];
    const centre = p => ({ x : p.x + (token.width * size / 2), y : p.y + (token.height * size / 2) });
    for(let i = 1; i < points.length; i++){
      const cellsOn = grid.isGridless ? [] : grid.getDirectPath([centre(points[i - 1]), centre(points[i])]);
      if(!cellsOn.length){ out.push(points[i]); continue; }
      for(const cell of cellsOn.slice(1)){
        const c = grid.getCenterPoint(cell);
        out.push({ x : c.x - (token.width * size / 2), y : c.y - (token.height * size / 2), elevation : points[i].elevation, ...(points[i].action ? { action : points[i].action } : {}) });
      }
    }
    return out.filter((p, i, all) => !i || (p.x !== all[i - 1].x) || (p.y !== all[i - 1].y));
  }

  /* Its own movement provokes Opportunity Attacks (not Disengaged, not a Reaction move that doesn't, not Flyby, not a
     hook macro's suppressOA) : { spared (tokens it doesn't provoke) } or null */
  static provokes(token, movement){
    const actor = token.actor;
    const disengaged = actor?.statuses?.has?.("disengaged") || actor?.effects?.some?.(e => !e.disabled && (e.getFlag(module.id, "disengaged") || e.getFlag(module.id, "disengage")));
    if(!actor || disengaged) return null;
    /* A Reaction move (Mantle of Inspiration : none provoked; Maneuvering Attack : none from the creature hit) */
    const reacting = reactionMoveOf(actor);
    if(reacting?.noOA === true) return null;
    /* Flyby (Animated Broom, owls) : flying out of an enemy's reach provokes nothing */
    const action = movement.passed?.waypoints?.at?.(-1)?.action ?? movement.pending?.waypoints?.at?.(-1)?.action ?? token.movementAction;
    if((action === "fly") && actor.items?.some?.(i => (idOf(i) === "flyby") || /^flyby$/i.test(i.name ?? ""))) return null;
    /* "Before an Opportunity Attack" (hook macros) : suppressOA(args) : this move provokes none (Deer's Agile) */
    const info = { movement, skip : false };
    Hooks.callAll(`${module.id}.preOpportunityAttack`, token, info);
    if(info.skip) return null;
    return { spared : new Set(Array.isArray(reacting?.noOA) ? reacting.noOA : []) };
  }

  /* It can't make Opportunity Attacks (Open Hand Technique's Addle, Shocking Grasp) */
  static noOpportunity(actor){
    return !!actor?.appliedEffects?.some?.(e => e.getFlag(module.id, "rule")?.noOpportunity);
  }

  /* Could this creature react to `other` now : an enemy in the fight, its Reaction left, able to act */
  static canReact(t, other){
    return (t !== other) && !!t.actor && !t.hidden && (this.relation(t, other) === "enemy") && !!actionTracker.combatOf(t.actor)
      && actionTracker.left(t.actor, "reaction") && !actionTracker.OUT_OF_ACTION.some(s => t.actor.statuses?.has?.(s));
  }

  /* Its reaction attack rules for a moment : [{ rule, source }] */
  static rulesOf(t, kind, other){
    const out = [];
    for(const rule of attackRules.values()){
      if((rule.on !== kind) || !isOn(rule)) continue;
      const source = sourceOf(t.actor, rule.match);
      if(!source) continue;
      if(rule.sees && t.object && other.object && !canSee(t.object, other.object)) continue;
      try { if(rule.when && !rule.when({ actor : t.actor, token : t, other, source })) continue; }
      catch(error){ log.error("Reaction attack rule", error); continue; }
      if(!this.ruleWeapons(t.actor, rule).length) continue;
      out.push({ rule, source });
    }
    return out;
  }

  /* What a rule lets it attack with : its melee weapons in hand (or body weapons) that the rule takes */
  static ruleWeapons(actor, rule){
    const held = this.heldWeapons(actor);
    return actor.items.filter(i => this.meleeAttackOf(i) && ((i.type !== "weapon") || hands.isBody(i) || held.has(i.id))
      && (!rule?.weapon || rule.weapon(i)));
  }

  /* A rule's reach : its weapons' (Reach : 10 ft) */
  static ruleReach(actor, rule){
    let reach = 0;
    for(const item of this.ruleWeapons(actor, rule)) reach = Math.max(reach, Number(item.system.range?.reach) || (item.system.properties?.has?.("rch") ? 10 : this.DEFAULT_REACH));
    return reach;
  }

  /* Before a drag : the first square where it leaves someone's reach (stopped there), or enters the reach of someone
     with a rule for that (stopped inside) : ask them */
  static preMove(token, movement, options = {}){
    if(!this.enabled()) return;
    const own = options?.[module.id] ?? {};
    /* Its own movement : a drag, the keyboard, or a macro's leap (oaCheck); not a teleport or a forced move (a push) */
    if(own.oaSkip || !(["dragging", "keyboard"].includes(movement?.method) || own.oaResume || own.oaCheck)) return;
    const actor = token.actor;
    if(!actor || !actionTracker.combatOf(actor)) return;
    const done = new Set(own.oaDone ?? []);
    /* The creatures it drags (grappled) come along : they never see it leave or come */
    for(const t of moves.enabled() ? moves.heldBy(token) : []) done.add(t.uuid);
    const provoked = this.provokes(token, movement);
    const leavers = provoked ? token.parent.tokens.filter(t => this.canReact(t, token) && !done.has(t.uuid) && !provoked.spared.has(t.uuid)
      /* Can't make Opportunity Attacks (Open Hand Technique's Addle) */
      && !this.noOpportunity(t.actor)
      && (this.reachOf(t.actor) > 0) && (!t.object || !token.object || canSee(t.object, token.object))) : [];
    const enterers = attackRules.size ? token.parent.tokens.filter(t => this.canReact(t, token))
      .flatMap(t => this.rulesOf(t, "enters", token).filter(({ rule }) => !done.has(t.uuid) && !done.has(`${t.uuid}|${rule.id}`)
        && ((rule.opportunity === false) || !this.noOpportunity(t.actor)))
        .map(({ rule }) => ({ t, rule, reach : this.ruleReach(t.actor, rule) })).filter(e => e.reach > 0)) : [];
    if(!leavers.length && !enterers.length) return;
    const path = this.pathOf(token, movement);
    const foot = p => ({ x : p.x, y : p.y, width : token.width, height : token.height, elevation : p.elevation });
    let stop = -1, rows = [];
    for(let i = 0; i < path.length - 1; i++){
      const leaving = leavers.filter(t => { const r = this.reachOf(t.actor); return (this.feet(foot(path[i]), t) <= r) && (this.feet(foot(path[i + 1]), t) > r); });
      if(leaving.length){ stop = i; rows = leaving.map(t => ({ token : t.uuid, status : "pending" })); break; }
      const entering = enterers.filter(e => (this.feet(foot(path[i]), e.t) > e.reach) && (this.feet(foot(path[i + 1]), e.t) <= e.reach));
      if(entering.length){ stop = i + 1; rows = entering.map(e => ({ token : e.t.uuid, status : "pending", rule : e.rule.id })); break; }
    }
    if(stop < 0) return;
    /* Each part keeps its own kind of move (a jump's run-up walked, its leap a jump) */
    const part = p => ({ x : p.x, y : p.y, elevation : p.elevation, ...(p.action ? { action : p.action } : {}) });
    const rest = path.slice(stop + 1).map(part);
    const until = path.slice(1, stop + 1).map(part);
    this.stopForOA(token, until, rest, rows, [...done]);
    return false;
  }

  /* rows : [{ token (uuid), status : "pending", rule (a reaction attack rule's id; none : an Opportunity Attack for
     leaving its reach) }] */
  static async stopForOA(token, until, rest, rows, done){
    /* The refused drag winds down first (a new move during it collides with it) */
    await new Promise(resolve => setTimeout(resolve, 250));
    await token.object?.movementAnimationPromise?.catch?.(() => null);
    if(until.length) await token.move(until, { [module.id] : { oaSkip : true } }).catch(error => log.debug(error));
    const entering = rows.every(r => r.rule);
    const text = module.format(entering ? "actionTracker.oa.enters" : "actionTracker.oa.text", { name : token.name });
    /* Not an Opportunity Attack (Reactive Strike) : a Reaction attack's card */
    const title = rows.every(r => attackRules.get(r.rule)?.opportunity === false) ? module.i18n("actionTracker.oa.reactionTitle") : null;
    await this.oaCard(token, rows, { rest, done : [...done, ...rows.map(r => r.rule ? `${r.token}|${r.rule}` : r.token)], text, title });
  }

  /* The card : a row per creature that may react; rest : the move's rest (none : nothing to finish) */
  static async oaCard(token, rows, { rest = [], done = [], text = "", title = null } = {}){
    const users = new Set(game.users.filter(u => u.isGM).map(u => u.id));
    for(const row of rows){
      const t = fromUuidSync(row.token, { strict : false });
      for(const u of game.users) if(t?.actor?.testUserPermission(u, "OWNER")) users.add(u.id);
    }
    for(const u of game.users) if(token.actor?.testUserPermission(u, "OWNER")) users.add(u.id);
    await ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ token }),
      whisper : [...users],
      content : `<div class="${module.id}-oa-card"><p><strong>${esc(title ?? module.i18n("actionTracker.oa.title"))}</strong> ${esc(text)}</p>
        <ul class="unlist macro-helper-rows ${module.id}-oa-rows"></ul><div class="${module.id}-oa-gm"></div></div>`,
      flags : { [module.id] : { oaStop : { mover : token.uuid, rest, done, rows, status : "pending", noMove : !rest.length } } },
    });
  }

  /* The weapon a row's attack is made with : the rule's, else an Opportunity Attack's (two in hand : which) */
  static async rowAttack(actor, row){
    const rule = row.rule ? attackRules.get(row.rule) : null;
    if(!rule?.weapon) return this.chooseOAAttack(actor);
    const weapons = this.ruleWeapons(actor, rule);
    if(weapons.length < 2) return weapons[0] ? this.meleeAttackOf(weapons[0]) : null;
    const id = await chooseOption({ title : module.i18n("actionTracker.oa.attack"), icon : "fa-solid fa-hand-fist", prompt : module.i18n("actionTracker.oa.which"),
      options : weapons.map(i => ({ value : i.id, label : i.name })) });
    return id ? this.meleeAttackOf(actor.items.get(id)) : null;
  }

  /* Its "instead of an Opportunity Attack" rules (for leaving its reach only) : [{ rule, source, choices }] */
  static insteadsOf(actor, mover, row){
    if(row.rule || !actor) return [];
    const out = [];
    for(const rule of insteadRules.values()){
      if(!isOn(rule)) continue;
      const source = sourceOf(actor, rule.match);
      if(!source) continue;
      let choices = [];
      try { choices = rule.choices?.(actor, mover) ?? []; } catch(error){ log.error("Instead of an Opportunity Attack", error); }
      if(choices.length) out.push({ rule, source, choices });
    }
    return out;
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
      const rule = row.rule ? attackRules.get(row.rule) : null;
      const source = rule ? sourceOf(t?.actor, rule.match) : null;
      const attackLabel = (rule && source && rule.label?.(source)) || module.i18n("actionTracker.oa.attack");
      const mover = fromUuidSync(flag.mover, { strict : false });
      const insteads = may ? this.insteadsOf(t?.actor, mover, row) : [];
      li.innerHTML = `<img class="token" src="${esc(t?.texture?.src ?? t?.actor?.img ?? "")}" alt="" data-token="${esc(row.token ?? "")}"><span class="name">${esc(t?.name ?? "?")}</span>
        <span class="macro-helper-row-apply">${(row.status !== "pending") ? `<span class="applied">${esc(module.i18n(`actionTracker.oa.${row.status}`))}</span>`
          : may ? `<button type="button" data-answer="attacked"><i class="fa-solid fa-hand-fist" inert></i> ${esc(attackLabel)}</button>
                   ${insteads.map(x => `<button type="button" data-answer="instead" data-rule="${esc(x.rule.id)}"><i class="fa-solid ${esc(x.rule.icon)}" inert></i> ${esc(x.rule.label?.(x.source) ?? x.source.name ?? "")}</button>`).join("")}
                   <button type="button" data-answer="passed"><i class="fa-solid fa-forward" inert></i> ${esc(module.i18n("actionTracker.oa.pass"))}</button>` : ""}</span>`;
      for(const button of li.querySelectorAll("button")) button.addEventListener("click", async event => {
        event.preventDefault();
        const answer = event.currentTarget.dataset.answer;
        const ruleId = event.currentTarget.dataset.rule;
        const again = () => li.querySelectorAll("button").forEach(b => b.disabled = false);
        li.querySelectorAll("button").forEach(b => b.disabled = true);
        let card = null;
        if(answer === "attacked"){
          const attack = await this.rowAttack(t.actor, row);
          if(!attack || !mover?.object) return again();
          t.object?.control({ releaseOthers : true });
          canvas.tokens.setTargets([mover.id]);
          const used = await attack.use({ [module.id] : { economy : "reaction", oa : true, opportunity : rule ? (rule.opportunity !== false) : true, skipPick : true, useTargets : true } });
          const made = used ? await uses.cardOf(used).catch(() => null) : null;
          if(!made) return again();
          /* Roll Item's card (a builder : its message), or dnd5e's message; its attack roll may land after it */
          card = made.message ?? made;
          await waitFor(() => !!game.messages.get(card.id)?.system?.attackOf?.(null), { timeout : 15000 });
        }
        if(answer === "instead"){
          const x = insteads.find(i => i.rule.id === ruleId);
          const value = !x ? null : (x.choices.length === 1) ? x.choices[0].value
            : await chooseOption({ title : x.source.name, icon : `fa-solid ${x.rule.icon}`, prompt : module.i18n("actionTracker.oa.insteadWhat"), options : x.choices });
          if(!value || !mover?.object) return again();
          t.object?.control({ releaseOthers : true });
          const used = await x.rule.run(t, mover, value);
          if(!used || !(await uses.cardOf(used).catch(() => null))) return again();
        }
        await gm.run("oaAnswer", { message : message.id, index, status : answer, card : card?.id ?? null });
      });
      list.append(li);
    });
    const gmBox = html.querySelector(`.${module.id}-oa-gm`);
    if(gmBox && flag.noMove) gmBox.innerHTML = "";
    else if(gmBox && game.user.isGM && (flag.status === "pending")){
      const waiting = flag.waiting ? `<p><em>${esc(module.i18n("actionTracker.oa.waiting"))}</em></p>` : "";
      gmBox.innerHTML = `${waiting}<div class="card-buttons"><button type="button" data-answer="continue"><i class="fa-solid fa-play" inert></i> ${esc(module.i18n("actionTracker.oa.continue"))}</button>
        <button type="button" data-answer="stopped"><i class="fa-solid fa-hand" inert></i> ${esc(module.i18n("actionTracker.oa.stop"))}</button></div>`;
      for(const button of gmBox.querySelectorAll("button")) button.addEventListener("click", event => {
        event.preventDefault();
        gm.run("oaAnswer", { message : message.id, status : event.currentTarget.dataset.answer });
      });
    }
    else if(gmBox && (flag.status !== "pending")) gmBox.innerHTML = `<p><em>${esc(module.i18n(`actionTracker.oa.${flag.status}`))}</em></p>`;
  }

  /* GM : a row answered (its owner) or the move decided (GM); once all are answered, the move goes on */
  static async oaAnswerAsGM({ message : id, index = null, status, card = null } = {}, user){
    const message = game.messages.get(id);
    const flag = foundry.utils.deepClone(message?.getFlag(module.id, "oaStop"));
    if(!flag || (flag.status !== "pending")) return false;
    const forced = index === null;
    if(!forced){
      const row = flag.rows[index];
      const t = row ? fromUuidSync(row.token, { strict : false }) : null;
      if(!row || (row.status !== "pending") || !["attacked", "passed", "instead"].includes(status) || !(user.isGM || t?.actor?.testUserPermission(user, "OWNER"))) return false;
      row.status = status;
      /* A hit : the move waits for its damage */
      const hit = (status === "attacked") && card ? game.messages.get(card) : null;
      if(hit){
        row.card = hit.id;
        row.hit = !!hit.system?.hitTargets?.(null)?.some?.(t => (t?.document ?? t)?.uuid === flag.mover);
      }
    }
    else {
      if(!user.isGM || !["continue", "stopped"].includes(status)) return false;
      flag.status = status;
    }
    return this.oaSettle(message, flag, { forced });
  }

  /* All answered (and every hit's damage in) : the move goes on, unless it's down or its Speed is 0 now (Sentinel's Halt) */
  static async oaSettle(message, flag, { forced = false } = {}){
    const allDone = flag.rows.every(r => r.status !== "pending");
    flag.waiting = allDone && flag.rows.some(r => r.hit && !r.damaged);
    if(allDone && !flag.waiting && (flag.status === "pending")) flag.status = "continue";
    const mover = fromUuidSync(flag.mover, { strict : false });
    if((flag.status === "continue") && !forced && flag.rest?.length && mover?.actor && (this.speedOf(mover.actor) <= 0)) flag.status = "halted";
    await message.setFlag(module.id, "oaStop", flag);
    if(flag.status === "continue"){
      const alive = mover?.actor && !(Number(mover.actor.system?.attributes?.hp?.value) <= 0);
      if(alive && flag.rest?.length) await mover.move(flag.rest, { [module.id] : { oaResume : true, oaDone : flag.done } }).catch(error => log.debug(error));
    }
    return true;
  }

  /* Its fastest Speed now (a jump's distance isn't a Speed) */
  static speedOf(actor){
    const movement = actor?.system?.attributes?.movement ?? {};
    return Math.max(0, ...Object.keys(CONFIG.DND5E.movementTypes ?? { walk : {} }).filter(k => k !== "jump").map(k => Number(movement[k]) || 0));
  }

  /* A card's damage landed on a creature an Opportunity Attack card waits for */
  static onOADamage(actor, options = {}){
    if(!this.enabled()) return;
    const origin = options?.origin ?? options?.originatingMessage;
    if(!origin?.id) return;
    const stop = game.messages.contents.slice(-30).find(m => {
      const f = m.getFlag(module.id, "oaStop");
      return f && (f.status === "pending") && f.rows?.some(r => (r.card === origin.id) && r.hit && !r.damaged) && (fromUuidSync(f.mover, { strict : false })?.actor === actor);
    });
    if(stop) gm.run("oaDamaged", { message : stop.id, card : origin.id });
  }

  static async oaDamagedAsGM({ message : id, card } = {}){
    const message = game.messages.get(id);
    const flag = foundry.utils.deepClone(message?.getFlag(module.id, "oaStop"));
    if(!flag || (flag.status !== "pending")) return false;
    const row = flag.rows.find(r => r.card === card);
    if(!row || row.damaged) return false;
    row.damaged = true;
    return this.oaSettle(message, flag);
  }

  /* ---------- The reaction attack lego's moments without a move ---------- */

  /* The rows for a moment : creatures within `within` ft of `other` with a rule for it ([{ token, status, rule }]) */
  static momentRows(kind, other, { skip = [] } = {}){
    const rows = [];
    for(const t of other.parent?.tokens ?? []){
      if(skip.includes(t.uuid) || !this.canReact(t, other)) continue;
      const found = this.rulesOf(t, kind, other).find(({ rule }) => this.feet(other, t) <= (Number(rule.within) || 5));
      if(found) rows.push({ token : t.uuid, status : "pending", rule : found.rule.id });
    }
    return rows;
  }

  /* It takes the Disengage action (its Disengaged mark lands) : the active GM's card */
  static async onDisengage(effect){
    if(!this.enabled() || !game.users.activeGM?.isSelf || !attackRules.size) return;
    const actor = effect?.parent;
    if((actor?.documentName !== "Actor") || !(effect.getFlag(module.id, "disengaged") || effect.getFlag(module.id, "disengage"))) return;
    const token = actor.token ?? actor.getActiveTokens?.(false, true)?.[0] ?? null;
    if(!token || !actionTracker.combatOf(actor)) return;
    const rows = this.momentRows("disengages", token);
    if(rows.length) await this.oaCard(token, rows, { text : module.format("actionTracker.oa.disengages", { name : token.name }) });
  }

  static #hitsSeen = new Set();

  /* It hits someone else with an attack : the active GM's card, once per attack card */
  static async onHitOther(message){
    if(!this.enabled() || !game.users.activeGM?.isSelf || !attackRules.size || this.#hitsSeen.has(message?.id)) return;
    const { hitOf } = await import('../roll-item/hit-bonus.js');
    const system = message?.system;
    const rays = system?.isMulti ? system.rays.map((_, i) => i) : [null];
    const hits = rays.map(ray => hitOf(message, ray)).filter(Boolean);
    if(!hits.length || this.#hitsSeen.has(message.id)) return;
    this.#hitsSeen.add(message.id);
    const attacker = hits[0].token?.document ?? hits[0].token;
    if(!attacker || !actionTracker.combatOf(hits[0].actor)) return;
    const struck = hits.flatMap(h => h.targets).map(t => (t.document ?? t).uuid);
    const rows = this.momentRows("hitsOther", attacker, { skip : struck });
    if(rows.length) await this.oaCard(attacker, rows, { text : module.format("actionTracker.oa.hitsOther", { name : attacker.name }) });
  }
}

/* Roll Item makes its own cards : dnd5e's usage card then isn't the one to count */
function settings_rollItem(){
  try { return !!game.settings.get(module.id, "rollItemEnabled"); } catch { return false; }
}
