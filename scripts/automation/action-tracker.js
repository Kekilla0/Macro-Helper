import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { gm } from '../gm.js';
import { limits } from './limits.js';
import { combatLog } from './combat-log.js';
import { grapplesOn } from '../roll-item/card-builder.js';
import { idOf, esc } from '../helpers/utils.js';
const log = logger.for(import.meta.url);

/**
 * Action Tracker (System Automation → Rules, off by default) : in a started combat, each creature has an Action, a Bonus
 * Action and a Reaction (more when something gives them : Action Surge), given back when its turn starts. Using
 * something spends the one its activation says :
 *
 *   Action / Bonus Action : on its own turn. On someone else's turn : a player character's use goes as far as its
 *                           targets, then waits for the GM (a card : who, what, when; Approve / Deny). Approved, it's
 *                           its Reaction; denied, nothing is used. The GM's own creatures just use their Reaction.
 *   Reaction              : any time, once until its next turn (Shield, Hellish Rebuke). A weapon attack on someone
 *                           else's turn is an Opportunity Attack : the Reaction, no card. None left : Rule Limits.
 *   The Attack action     : the first attack spends the Action and gives its attacks : a character's from its classes
 *                           (Extra Attack : Fighter 5 / 11 / 20, Barbarian, Monk, Paladin, Ranger 5; Thirsting Blade
 *                           with the pact weapon), a creature's from its Multiattack's text (exactly those attacks;
 *                           anything else follows Rule Limits). After them, a Light weapon attack (after attacking
 *                           with a Light weapon) or an Unarmed Strike with Martial Arts is the Bonus Action.
 *   Object interactions   : on its turn, putting a weapon in a hand is free once per attack made, then the one free
 *                           object interaction, then the Utilize action; a shield in or out of a hand is the Utilize
 *                           action (Hands).
 *   Movement              : what Foundry measured this turn, against its Speed (Dashing : twice). Rule Limits on
 *                           Block stops a drag past it; Warn says so.
 *   Not counted           : casting times of 1 minute or more, Rituals, follow-ups that aren't a new casting (a
 *                           rider's save, Chromatic Orb's leap : noCast), and uses another one paid for, marked
 *                           config[module.id].economy = "free" (True Strike's attack, Flurry of Blows' second strike);
 *                           economy = "bonus" / "action" / "reaction" sets what a use costs (Witch Bolt's later damage).
 *
 *   Legendary actions     : dnd5e spends and resets them; here only off its own turn (Rule Limits), shown as crowns.
 *   Lair actions          : once a round (Rule Limits for a second).
 *   Readied actions and Opportunity Attacks : action-ready.js. A Reaction used on anything else loses the readied one.
 *
 * Every turn's uses go in a log (the action bar's list). Data : actor flag macro-helper.economy = { combat, round,
 * used : {action, bonus, reaction}, extra : {...}, attack : { any, left : {itemId : n}, text } | null, light, made,
 * swaps, objects, log : [] }.
 */
export class actionTracker{
  static KINDS = ["action", "bonus", "reaction"];
  static ICONS = { action : "fa-circle", bonus : "fa-play", reaction : "fa-rotate-left" };
  static EXTRA = { "extra-attack" : 2, "two-extra-attacks" : 3, "three-extra-attacks" : 4 };
  static CLASS_ATTACKS = { fighter : [[20, 4], [11, 3], [5, 2]], barbarian : [[5, 2]], monk : [[5, 2]], paladin : [[5, 2]], ranger : [[5, 2]] };
  static NUMBERS = { a : 1, an : 1, one : 1, two : 2, three : 3, four : 4, five : 5, six : 6 };
  static MANY = 99;
  static OUT_OF_ACTION = ["incapacitated", "unconscious", "paralyzed", "petrified", "stunned", "dead"];
  static LOG_MAX = 40;

  static enabled(){
    return (game.system.id === "dnd5e") && !!settings.value("actionTracker");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("deleteActiveEffect", (effect, options, userId) => this.effectEnded(effect, options, userId));
    /* Death saves : a line when they change without a roll (damage at 0 HP, healing); Dead at 3 failures */
    Hooks.on("dnd5e.rollDeathSave", (rolls, details) => { if(details?.subject) this.#rolled.add(details.subject.uuid); });
    Hooks.on("preUpdateActor", (actor, changes, options) => {
      if(foundry.utils.hasProperty(changes ?? {}, "system.attributes.death")) options[module.id] = { ...(options[module.id] ?? {}),
        deathWas : { ...(actor.system.attributes?.death ?? {}) } };
    });
    Hooks.on("updateActor", (actor, changes, options, userId) => this.deathChanged(actor, changes, options, userId));
    uses.onActivity("economy", (activity, ctx, next) => this.step(activity, ctx, next));
    uses.onActivity("economyApproval", (activity, ctx, next) => this.approvalStep(activity, ctx, next));
    gm.handle("economyAnswer", (data, user) => this.answerAsGM(data, user));
    Hooks.on("renderChatMessageHTML", (message, html) => this.drawRequest(message, html));
    Hooks.on("updateChatMessage", message => this.answered(message));
    Hooks.on("renderCombatTracker", (app, html) => this.drawTracker(html));
    Hooks.on("updateActor", (actor, changes) => {
      if(this.enabled() && foundry.utils.hasProperty(changes ?? {}, `flags.${module.id}.economy`)) ui.combat?.render();
    });
    Hooks.on("updateCombatant", () => { if(this.enabled()) ui.combat?.render(); });
    Hooks.on("updateCombat", (combat, changes) => this.skipTurn(combat, changes));
    Hooks.on("createChatMessage", (message, options, userId) => this.fromMessage(message, userId));
    Hooks.on("createActiveEffect", (effect, options, userId) => this.fromEffect(effect, userId));
    Hooks.on("dnd5e.postUseActivity", activity => this.onUsed(activity));
    Hooks.on("preMoveToken", (token, movement) => this.preMove(token, movement));
    Hooks.on("moveToken", (token, movement, options, user) => this.logMove(token, movement, user));
    Hooks.on("preUpdateActor", (actor, changes, options) => this.preHands(actor, changes, options));
    Hooks.on("updateActor", (actor, changes, options, userId) => this.onHands(actor, options, userId));
  }

  /* An effect with a duration ended on a creature in combat : a line for the GM and its owners (the reason, when a rule gave one) */
  static async effectEnded(effect, options = {}, userId){
    if(!this.enabled() || (userId !== game.user.id) || options?.[module.id]?.silent) return;
    const actor = effect.parent;
    if((actor?.documentName !== "Actor") || !this.combatOf(actor)) return;
    const reason = options?.[module.id]?.reason ?? "";
    /* A real duration (not a status dnd5e switches by itself : Bloodied), or a rule's reason */
    const d = effect.duration ?? {};
    if(!reason && !(d.seconds || d.rounds || d.turns || d.value)) return;
    const status = (effect.statuses?.size === 1) ? CONFIG.statusEffects.find(s => s.id === [...effect.statuses][0]) : null;
    const label = status ? game.i18n.localize(status.name ?? status.label ?? effect.name) : effect.name;
    const line = module.format("actionTracker.effectEnded", { effect : label }) + (reason ? ` ${reason}` : "");
    await combatLog.add(actor, line);
    if(!settings.value("combatLogChat")) return;
    const users = new Set(game.users.filter(u => u.isGM || actor.testUserPermission(u, "OWNER")).map(u => u.id));
    await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }), whisper : [...users],
      content : `<p><i class="fa-solid fa-hourglass-end" inert></i> ${esc(line)}</p>` });
  }

  static #rolled = new Set();

  /* A creature that can't act on its turn : dead, defeated, an NPC at 0 HP, or a character at 0 HP that's stable */
  static cantAct(actor){
    if(!actor) return false;
    if(actor.statuses?.has?.("dead") || actor.statuses?.has?.("defeated")) return true;
    if(Number(actor.system?.attributes?.hp?.value) > 0) return false;
    if(actor.type !== "character") return true;
    const death = actor.system?.attributes?.death ?? {};
    return actor.statuses?.has?.("stable") || ((Number(death.failure) || 0) >= 3);
  }

  static async skipTurn(combat, changes){
    if(!this.enabled() || !game.users.activeGM?.isSelf || !combat?.started || !(("turn" in (changes ?? {})) || ("round" in (changes ?? {})))) return;
    if(!this.cantAct(combat.combatant?.actor)) return;
    if(combat.combatants.every(c => this.cantAct(c.actor))) return;
    await new Promise(resolve => setTimeout(resolve, 300));
    await combatLog.add(combat.combatant.actor, module.i18n("actionTracker.log.skipped"));
    await combat.nextTurn();
  }

  /* Death saves changed : a line for its owners and the GM (a roll's own card already says it), Dead at 3 failures */
  static async deathChanged(actor, changes, options = {}, userId){
    if((userId !== game.user.id) || !foundry.utils.hasProperty(changes ?? {}, "system.attributes.death")) return;
    const death = actor.system.attributes?.death ?? {};
    const was = options[module.id]?.deathWas ?? {};
    const failures = Number(death.failure) || 0, successes = Number(death.success) || 0;
    if((failures >= 3) && actor.isOwner && !actor.statuses?.has?.("dead")) await actor.toggleStatusEffect("dead", { active : true, overlay : true }).catch(() => null);
    if(this.#rolled.delete(actor.uuid)) return;
    if((failures === (Number(was.failure) || 0)) && (successes === (Number(was.success) || 0))) return;
    const marks = "✓".repeat(successes) + "·".repeat(Math.max(0, 3 - successes)) + "  " + "✗".repeat(failures) + "·".repeat(Math.max(0, 3 - failures));
    const key = (failures >= 3) ? "deathDead" : (!failures && !successes) ? "deathReset" : "deathChanged";
    await combatLog.add(actor, module.format(`actionTracker.${key}`, { name : actor.name, marks }));
    if(!settings.value("combatLogChat") && this.combatOf(actor)) return;
    await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }),
      whisper : game.users.filter(u => u.isGM || actor.testUserPermission(u, "OWNER")).map(u => u.id),
      content : `<p><i class="fa-solid fa-skull" inert></i> ${esc(module.format(`actionTracker.${key}`, { name : actor.name, marks }))}</p>` });
  }

  /* Its turn, dying : roll the death save, then the turn ends */
  static async deathSave(actor, combat){
    const rolls = await actor.rollDeathSave?.({ event : null }).catch(error => { log.debug(error); return null; });
    if(!rolls) return;
    const st = this.state(actor);
    if(combat?.combatant && (combat.combatant.actor === actor)) await combat.nextTurn();
  }

  /* Grappled : each grapple with its escape DC (card-builder.js) */
  static grappleOf(actor){
    return grapplesOn(actor)[0] ?? null;
  }

  /* Its turn, Grappled : escape (its Action) : the better of Athletics and Acrobatics against the escape DC */
  static async escape(actor, effectId = null){
    const grapple = grapplesOn(actor).find(g => !effectId || (g.effect.id === effectId)) ?? null;
    if(!grapple) return;
    if(!this.left(actor, "action") && !limits.allow(module.format("actionTracker.spent", { name : actor.name, kind : this.label("action") }), { who : actor.name, what : module.i18n("actionTracker.escape") })) return;
    const skills = actor.system?.skills ?? {};
    const skill = ((Number(skills.acr?.total) || 0) > (Number(skills.ath?.total) || 0)) ? "acr" : "ath";
    const rolls = await actor.rollSkill?.({ skill, target : grapple.dc }, { configure : false }).catch(error => { log.debug(error); return null; });
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    if(!roll) return;
    await this.spend(actor, { kind : "action", what : module.i18n("actionTracker.escape") });
    const freed = roll.total >= grapple.dc;
    if(freed){
      await grapple.effect.delete({ [module.id] : { reason : module.i18n("actionTracker.escaped") } }).catch(() => null);
    }
    const st = this.state(actor);
    if(st){
      this.note(st.rec, module.format(freed ? "actionTracker.log.escaped" : "actionTracker.log.stillHeld", { total : roll.total, dc : grapple.dc }), { barOnly : true });
      await this.save(actor, st.rec);
    }
  }

  /* Its turn, Prone : stand up (half its Speed of movement) */
  static async standUp(actor, token){
    const st = this.state(actor);
    if(!st || !actor.statuses?.has?.("prone")) return;
    const cost = Math.floor(this.speedOf(actor, "walk") / (actor.statuses?.has?.("dashing") ? 4 : 2));
    const moved = token ? this.movedOf(token) : 0;
    const left = this.speedOf(actor, "walk") - moved - (Number(st.rec.standing) || 0);
    if((cost > left) && !limits.allow(module.format("actionTracker.cantStand", { name : actor.name, cost, left }), { who : actor.name, what : module.i18n("actionTracker.standUp") })) return;
    await actor.toggleStatusEffect("prone", { active : false });
    st.rec.standing = (Number(st.rec.standing) || 0) + cost;
    this.note(st.rec, module.format("actionTracker.log.stood", { cost }));
    await this.save(actor, st.rec);
  }

  /* ---------- State ---------- */

  static combatantOf(combat, actor){
    return combat.combatants.find(c => c.actor?.uuid === actor.uuid)
      ?? combat.combatants.find(c => (c.actorId === actor.id) && c.token?.actorLink);
  }

  /* Its turn's round : this round once its turn came, else the last one */
  static turnRound(combat, combatant){
    const index = combat.turns.findIndex(c => c.id === combatant.id);
    if(index < 0) return null;
    return ((combat.turn ?? 0) >= index) ? combat.round : combat.round - 1;
  }

  static fresh(combat, round){
    return { combat : combat.id, round, used : { action : 0, bonus : 0, reaction : 0 }, extra : { action : 0, bonus : 0, reaction : 0 },
      attack : null, light : false, made : 0, swaps : 0, objects : 0, log : [] };
  }

  /* The started combat it's in (the one being viewed first : a combat with no scene shows on every scene) */
  static combatOf(actor){
    const list = game.combats?.filter?.(c => c.started && this.combatantOf(c, actor)) ?? [];
    return list.find(c => c === game.combat) ?? list.find(c => c.scene?.id === canvas.scene?.id) ?? list.find(c => c.active) ?? list[0] ?? null;
  }

  /* { combat, combatant, rec, mine } in a started combat it's in, else null */
  static state(actor){
    if(!this.enabled() || !actor) return null;
    const combat = this.combatOf(actor);
    if(!combat) return null;
    const combatant = this.combatantOf(combat, actor);
    const round = combatant ? this.turnRound(combat, combatant) : null;
    if(round === null) return null;
    const saved = actor.getFlag(module.id, "economy");
    const rec = ((saved?.combat === combat.id) && (saved.round === round) && saved.used) ? foundry.utils.deepClone(saved) : this.fresh(combat, round);
    return { combat, combatant, rec, mine : combat.combatant?.id === combatant.id };
  }

  static total(rec, kind){
    return 1 + (Number(rec.extra?.[kind]) || 0);
  }

  static remaining(rec, kind){
    return this.total(rec, kind) - (Number(rec.used?.[kind]) || 0);
  }

  /* Has it this one left ? (out of combat, or the tracker off : yes) */
  static left(actor, kind){
    const st = this.state(actor);
    return !st || (this.remaining(st.rec, kind) > 0);
  }

  static label(kind){
    return module.i18n(`actionTracker.${kind}`);
  }

  static async save(actor, rec){
    if(!actor?.isOwner) return;
    rec.log = (rec.log ?? []).slice(-this.LOG_MAX);
    /* What's new in its turn's log goes to the fight's log too */
    const before = actor.getFlag(module.id, "economy");
    const old = ((before?.combat === rec.combat) && (before?.round === rec.round)) ? (before.log ?? []) : [];
    const fresh = rec.log.filter(e => !old.some(o => (o.at === e.at) && (o.text === e.text)));
    await actor.setFlag(module.id, "economy", rec);
    for(const e of fresh) if(!e.barOnly) await combatLog.add(actor, e.text);
  }

  static note(rec, text, extra = {}){
    (rec.log ??= []).push({ text, at : Date.now(), ...extra });
  }

  /* More of one this turn (Action Surge, Haste) : shown as an added pip */
  static async give(actor, kind, n = 1, source = ""){
    const st = this.state(actor);
    if(!st) return;
    st.rec.extra[kind] = (Number(st.rec.extra[kind]) || 0) + n;
    this.note(st.rec, module.format("actionTracker.log.give", { n, kind : this.label(kind), source }));
    await this.save(actor, st.rec);
  }

  /* ---------- What a use costs ---------- */

  static costOf(activity, config = {}){
    const own = config?.[module.id] ?? {};
    if(own.economy) return (own.economy === "free") ? null : own.economy;
    if(own.ritual || own.noCast) return null;
    const type = activity.activation?.type || activity.item?.system?.activation?.type;
    return this.KINDS.includes(type) ? type : null;
  }

  static isMultiattack(item){
    return (idOf(item) === "multiattack") || /multiattack/i.test(item?.name ?? "");
  }

  static multiattackOf(actor){
    return actor?.items?.find?.(i => this.isMultiattack(i)) ?? null;
  }

  /* An attack that's part of the Attack action : a weapon's, or any attack of a creature with Multiattack */
  static isAttack(activity){
    if(activity?.type !== "attack") return false;
    return (activity.item?.type === "weapon") || !!this.multiattackOf(activity.actor);
  }

  static isLight(item){
    const props = item?.system?.properties;
    return !!(props?.has?.("lgt") ?? (Array.isArray(props) && props.includes("lgt")));
  }

  /* A character's attacks per Attack action : its classes' Extra Attack, its features; the most wins */
  static attacksPerAction(actor, item = null){
    let n = 1;
    for(const [id, cls] of Object.entries(actor.classes ?? {})){
      const level = Number(cls.system?.levels) || 0;
      const step = (this.CLASS_ATTACKS[id] ?? []).find(([at]) => level >= at);
      if(step) n = Math.max(n, step[1]);
    }
    for(const i of actor.items ?? []) n = Math.max(n, this.EXTRA[idOf(i)] ?? 1);
    if(item && actor.items?.some?.(i => idOf(i) === "thirsting-blade") && (item.getFlag?.(module.id, "pactWeapon") || item.effects?.some?.(e => /pact/i.test(e.name ?? "")))) n = Math.max(n, 2);
    return n;
  }

  /**
   * A creature's Multiattack, from its text : "makes two Claw attacks and one Bite attack" -> { left : {claw : 2, bite : 1} },
   * "makes two attacks" -> { any : 2 }. Unreadable : as many as it likes.
   */
  static parseMultiattack(actor, item){
    const text = (item?.system?.description?.value ?? "").replace(/<[^>]+>/g, " ").replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1").replace(/\s+/g, " ");
    const attacks = (actor.items?.contents ?? []).filter(i => i.system?.activities?.some?.(a => a.type === "attack"));
    const find = name => {
      const n = name.toLowerCase().replace(/^(its|their|the)\s+/, "").replace(/s$/, "");
      return attacks.find(i => i.name.toLowerCase() === n) ?? attacks.find(i => n.startsWith(i.name.toLowerCase()) || i.name.toLowerCase().startsWith(n));
    };
    const out = { any : 0, left : {}, text };
    const count = w => this.NUMBERS[w.toLowerCase()] ?? Number(w);
    const named = /\b(a|an|one|two|three|four|five|six|\d+)\s+(?:attacks?\s+with\s+(?:its|their)\s+([\w' -]+?)(?=[.,;]|\s+and\b|$)|([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\s+attacks?\b|attacks?\b)/g;
    for(const m of text.matchAll(named)){
      const n = count(m[1]);
      if(!Number.isFinite(n) || (n < 1)) continue;
      const name = m[2] ?? m[3];
      const hit = name ? find(name) : null;
      if(hit) out.left[hit.id] = (out.left[hit.id] ?? 0) + n;
      else if(!name) out.any += n;
    }
    if(!out.any && !Object.keys(out.left).length) out.any = this.MANY;
    return out;
  }

  /* The pool the first attack opens : { any, left, text } */
  static attackPool(actor, activity){
    const multi = this.multiattackOf(actor);
    const pool = multi ? this.parseMultiattack(actor, multi) : { any : this.attacksPerAction(actor, activity?.item), left : {}, text : "" };
    pool.total = this.poolLeft(pool);
    return pool;
  }

  /* Take one attack from the pool : true if it had one for this item */
  static takeAttack(pool, item){
    if(!pool) return false;
    if((pool.left?.[item?.id] ?? 0) > 0){ pool.left[item.id] -= 1; return true; }
    if((pool.any ?? 0) > 0){ pool.any -= 1; return true; }
    return false;
  }

  static poolLeft(pool){
    return (pool?.any ?? 0) + Object.values(pool?.left ?? {}).reduce((a, b) => a + b, 0);
  }

  /* After the Attack action's attacks : the Bonus Action attack it allows */
  static bonusAttack(activity, rec){
    const item = activity.item;
    if(rec.light && this.isLight(item)) return true;
    return (idOf(item) === "unarmed-strike") && !!activity.actor?.items?.some?.(i => idOf(i) === "martial-arts");
  }

  /* { kind, attack : "new" | "more" | "bonus" | "over" | null, offTurn, ask } */
  static plan(activity, cost, st){
    const attack = this.isAttack(activity);
    if(cost === "reaction") return { kind : "reaction" };
    if(!st.mine) return { kind : "reaction", offTurn : cost, attackOffTurn : attack, ask : !attack && !!activity.actor?.hasPlayerOwner && !game.user.isGM };
    if((attack || this.isMultiattack(activity.item)) && (cost === "action")){
      if(st.rec.attack){
        const pool = foundry.utils.deepClone(st.rec.attack);
        if(attack && this.takeAttack(pool, activity.item)) return { kind : null, attack : "more", pool };
        if(attack && (this.remaining(st.rec, "bonus") > 0) && this.bonusAttack(activity, st.rec)) return { kind : "bonus", attack : "bonus" };
        if(this.remaining(st.rec, "action") > 0) return { kind : "action", attack : "new" };
        return { kind : "action", attack : "over", pool };
      }
      return { kind : "action", attack : "new" };
    }
    return { kind : cost };
  }

  /* ---------- The use ---------- */

  static async step(activity, ctx, next){
    const actor = activity?.actor;
    if(!this.enabled() || !actor) return next();
    const special = await this.specialStep(activity, ctx);
    if(special === false) return null;
    const cost = this.costOf(activity, ctx.config);
    const st = cost ? this.state(actor) : null;
    if(!st) return next();
    const plan = this.plan(activity, cost, st);
    const own = ctx.config?.[module.id] ?? {};
    if(own.readied){ plan.readied = true; plan.ask = false; plan.offTurn = null; }
    if(own.oa){ plan.oa = true; plan.ask = false; plan.offTurn = null; }
    const what = activity.item?.name ?? activity.name ?? "";
    if(plan.attackOffTurn && !plan.readied && !plan.oa
      && !limits.allow(module.format("actionTracker.noAttackOffTurn", { name : actor.name }), { who : actor.name, what })) return null;
    const who = actor.name;
    if((plan.attack === "over") && st.rec.attack?.text
      && !limits.allow(module.format("actionTracker.multiattack", { name : who, text : st.rec.attack.text }), { who, what })) return null;
    if(plan.kind && (this.remaining(st.rec, plan.kind) <= 0)
      && !limits.allow(module.format("actionTracker.spent", { name : who, kind : this.label(plan.kind) }), { who, what })) return null;
    /* Off its turn, a player's : the GM says, once its targets are picked (the step after them) */
    if(plan.ask) uses.mark(ctx, { economyAsk : { kind : plan.offTurn } });
    /* Spent now (a quick second attack sees it), given back if the use doesn't happen (cancelled, denied), or if
       its card never comes (an attack's target pick, made after the use, closed) */
    await this.spend(actor, plan, activity).catch(error => log.error(error));
    const spent = foundry.utils.deepClone(actor.getFlag(module.id, "economy"));
    let result = null;
    try { result = await next(); }
    finally { if(!result) await this.save(actor, st.rec).catch(error => log.error(error)); }
    if(result) uses.cardOf(result).then(card => card ? null : this.refund(actor, st.rec, spent)).catch(error => log.debug(error));
    return result;
  }

  /* The use came to nothing : as it was, unless something else was spent since */
  static async refund(actor, before, spent){
    const now = actor.getFlag(module.id, "economy");
    if(JSON.stringify(now) !== JSON.stringify(spent)) return;
    log.debug("Refunded", actor.name);
    await this.save(actor, foundry.utils.deepClone(before));
    await combatLog.add(actor, module.i18n("combatLog.cancelled"));
  }

  static async spend(actor, plan = {}, activity = null){
    const st = this.state(actor);
    if(!st || !actor.isOwner) return;
    const rec = st.rec;
    const { kind = null, attack = null } = plan;
    if(kind) rec.used[kind] = (Number(rec.used[kind]) || 0) + 1;
    /* The Reaction : the readied use released, or lost to something else */
    if((kind === "reaction") && rec.ready){
      if(!plan.readied){
        this.note(rec, module.format("actionTracker.log.readyLost", { what : rec.ready.name }));
        const effect = rec.ready.concentration ? actor.effects.get(rec.ready.concentration) : null;
        if(effect) effect.delete().catch(error => log.debug(error));
      }
      rec.ready = null;
    }
    if(attack === "new"){
      rec.attack = this.attackPool(actor, activity);
      if(this.isAttack(activity)) this.takeAttack(rec.attack, activity.item);
      rec.light = this.isAttack(activity) && this.isLight(activity.item);
    }
    else if(attack === "more"){
      rec.attack = plan.pool;
      rec.light = rec.light || this.isLight(activity?.item);
    }
    if(this.isAttack(activity)) rec.made = (Number(rec.made) || 0) + 1;
    const name = activity?.item?.name ?? activity?.name ?? plan.what ?? "";
    const total = Number(rec.attack?.total) || 0;
    const nth = (total && (total < this.MANY - 1)) ? module.format("actionTracker.log.nth", { n : total - this.poolLeft(rec.attack), total }) : "";
    const text = plan.readied ? module.format("actionTracker.log.released", { what : name })
      : plan.oa ? module.format("actionTracker.log.oa", { what : name })
      : plan.offTurn ? module.format("actionTracker.log.offTurn", { what : name, kind : this.label(plan.offTurn) })
      : ((attack === "new") || (attack === "more")) && this.isAttack(activity) ? module.format(kind ? "actionTracker.log.attackOf" : "actionTracker.log.attackMore", { what : name, kind : kind ? this.label(kind) : "", nth })
      : kind ? module.format("actionTracker.log.used", { what : name, kind : this.label(kind) })
      : name;
    const isAttackLine = ((attack === "new") || (attack === "more")) && this.isAttack(activity) && !plan.readied && !plan.oa && !plan.offTurn;
    this.note(rec, text, isAttackLine ? { barOnly : true, item : name, nth, kind : kind ?? "" } : {});
    log.debug("Spent", actor.name, kind ?? attack, rec.used);
    await this.save(actor, rec);
  }

  /* Legendary actions (off its turn) and Lair actions (once a round) : false stops the use */
  static async specialStep(activity, ctx){
    const type = activity.activation?.type || activity.item?.system?.activation?.type;
    if(!["legendary", "mythic", "lair"].includes(type)) return true;
    const actor = activity.actor;
    const combat = this.combatOf(actor);
    if(!combat) return true;
    const who = actor.name, what = activity.item?.name ?? "";
    if(type === "lair"){
      const last = actor.getFlag(module.id, "lairRound");
      if((last?.combat === combat.id) && (last.round === combat.round)
        && !limits.allow(module.format("actionTracker.lairUsed", { name : who }), { who, what })) return false;
      if(actor.isOwner) await actor.setFlag(module.id, "lairRound", { combat : combat.id, round : combat.round });
      return true;
    }
    const st = this.state(actor);
    if(st?.mine && !limits.allow(module.format("actionTracker.legendaryOwnTurn", { name : who }), { who, what })) return false;
    if(st){
      this.note(st.rec, module.format("actionTracker.log.legendary", { what, n : Number(activity.activation?.value) || 1 }));
      await this.save(actor, st.rec);
    }
    return true;
  }

  /* Legendary actions : { value, max } (dnd5e's own count); a lair : used this round ? */
  static legendaryOf(actor){
    const l = actor?.system?.resources?.legact;
    return (Number(l?.max) > 0) ? { value : Number(l.value) || 0, max : Number(l.max) } : null;
  }

  static lairOf(actor){
    const has = actor?.items?.some?.(i => [...(i.system?.activities ?? [])].some(a => (a.activation?.type || i.system?.activation?.type) === "lair"));
    if(!has) return null;
    const combat = this.combatOf(actor);
    const last = actor.getFlag(module.id, "lairRound");
    return { used : !!(combat && (last?.combat === combat.id) && (last.round === combat.round)) };
  }

  static extrasHTML(actor){
    const legendary = this.legendaryOf(actor);
    const lair = this.lairOf(actor);
    let html = "";
    if(legendary) html += `<span class="legendary" data-tooltip="${esc(module.format("actionTracker.legendary", legendary))}">${Array.from({ length : legendary.max }, (_, i) =>
      `<i class="fa-solid fa-crown${(i >= legendary.value) ? " spent" : ""}"></i>`).join("")}</span>`;
    if(lair) html += `<i class="fa-solid fa-dungeon lair${lair.used ? " spent" : ""}" data-tooltip="${esc(module.i18n(lair.used ? "actionTracker.lairSpent" : "actionTracker.lairReady"))}"></i>`;
    return html;
  }

  static readyHTML(rec){
    if(!rec.ready) return "";
    const trigger = module.i18n(`actionTracker.trigger.${rec.ready.trigger}`) + (rec.ready.turnOf ? ` (${rec.ready.turnOf.name})` : "");
    return `<span class="readied" data-tooltip="${esc(module.format("actionTracker.ready.marker", { what : rec.ready.name, trigger }))}"><i class="fa-solid fa-hourglass-half" inert></i></span>`;
  }

  /* Action Surge : one more Action this turn */
  static async onUsed(activity){
    if(!this.enabled() || !activity?.actor?.isOwner) return;
    if(idOf(activity.item) === "action-surge") await this.give(activity.actor, "action", 1, activity.item.name);
  }

  /* A chat line saying what it used (Mage Hand moved : flags.actionUsed { type }) : its author's client */
  static async fromMessage(message, userId){
    if(!this.enabled() || (userId !== game.user.id)) return;
    const used = message.getFlag?.(module.id, "actionUsed");
    if(!this.KINDS.includes(used?.type)) return;
    const actor = message.getAssociatedActor?.() ?? ChatMessage.implementation.getSpeakerActor(message.speaker);
    const item = used.item ? fromUuidSync(used.item, { strict : false }) : null;
    if(actor) await this.spend(actor, { kind : used.type, what : item?.name ?? "" });
  }

  /* An effect that took its Reaction (Dissonant Whispers' flee : flags.reactionUsed) : the client that made it */
  static async fromEffect(effect, userId){
    if(!this.enabled() || (userId !== game.user.id) || !effect.getFlag?.(module.id, "reactionUsed")) return;
    const actor = effect.parent;
    if(actor?.documentName === "Actor") await this.spend(actor, { kind : "reaction", what : effect.name });
  }

  /* ---------- Off its turn : the GM approves ---------- */

  static #waiting = new Map();

  static async approvalStep(activity, ctx, next){
    const ask = ctx.config?.[module.id]?.economyAsk;
    if(!ask || !this.enabled()) return next();
    const actor = activity.actor;
    const combat = this.combatOf(actor);
    const targets = [...game.user.targets].map(t => t.name);
    const when = combat?.started ? module.format("actionTracker.request.when", { round : combat.round, name : combat.combatant?.name ?? "—" }) : "";
    const message = await ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor }),
      whisper : [...new Set([...game.users.filter(u => u.isGM).map(u => u.id), game.user.id])],
      content : `<div class="${module.id}-economy-request"><p>${esc(module.format("actionTracker.request.text", { name : actor.name, what : activity.item?.name ?? activity.name, kind : this.label(ask.kind) }))}</p>
        <ul class="unlist"><li><strong>${esc(module.i18n("actionTracker.request.who"))}</strong> ${esc(actor.name)}</li>
        <li><strong>${esc(module.i18n("actionTracker.request.what"))}</strong> ${esc(activity.item?.name ?? "")}${activity.item?.name !== activity.name ? ` (${esc(activity.name ?? "")})` : ""}</li>
        <li><strong>${esc(module.i18n("actionTracker.request.whenLabel"))}</strong> ${esc(when)}</li>
        ${targets.length ? `<li><strong>${esc(module.i18n("actionTracker.request.targets"))}</strong> ${esc(targets.join(", "))}</li>` : ""}</ul>
        <div class="${module.id}-economy-answer"></div></div>`,
      flags : { [module.id] : { economyRequest : { actor : actor.uuid, user : game.user.id, status : "pending" } } },
    });
    const answer = await new Promise(resolve => {
      this.#waiting.set(message.id, resolve);
    });
    if(answer !== "approved") return null;
    return next();
  }

  /* The card : Approve / Deny for the GM, Cancel for the one asking; the answer once given */
  static drawRequest(message, html){
    const req = message.getFlag?.(module.id, "economyRequest");
    const box = req ? html.querySelector(`.${module.id}-economy-answer`) : null;
    if(!box) return;
    if(req.status !== "pending"){
      box.innerHTML = `<p class="${module.id}-economy-status ${req.status}"><strong>${esc(module.i18n(`actionTracker.request.${req.status}`))}</strong></p>`;
      return this.answered(message);
    }
    const buttons = game.user.isGM
      ? [["approved", "fa-check", "approve"], ["denied", "fa-xmark", "deny"]]
      : (req.user === game.user.id) ? [["cancelled", "fa-ban", "cancel"]] : [];
    box.innerHTML = `<div class="card-buttons">${buttons.map(([status, icon, key]) =>
      `<button type="button" data-status="${status}"><i class="fa-solid ${icon}" inert></i> ${esc(module.i18n(`actionTracker.request.${key}`))}</button>`).join("")}</div>`
      + (game.user.isGM ? "" : `<p><em>${esc(module.i18n("actionTracker.request.waiting"))}</em></p>`);
    for(const button of box.querySelectorAll("button")) button.addEventListener("click", async event => {
      event.preventDefault();
      event.currentTarget.disabled = true;
      await gm.run("economyAnswer", { message : message.id, status : event.currentTarget.dataset.status });
    });
  }

  /* The answer reached the one waiting for it */
  static answered(message){
    const status = message.getFlag?.(module.id, "economyRequest")?.status;
    const resolve = (status && (status !== "pending")) ? this.#waiting.get(message.id) : null;
    if(!resolve) return;
    this.#waiting.delete(message.id);
    resolve(status);
  }

  static async answerAsGM({ message : id, status } = {}, user){
    const message = game.messages.get(id);
    const req = message?.getFlag(module.id, "economyRequest");
    if(!req || (req.status !== "pending") || !["approved", "denied", "cancelled"].includes(status)) return false;
    if((status !== "cancelled") && !user.isGM) return false;
    if((status === "cancelled") && !user.isGM && (user.id !== req.user)) return false;
    await message.setFlag(module.id, "economyRequest", { ...req, status });
    return true;
  }

  /* ---------- Movement ---------- */

  static speedOf(actor, action = "walk"){
    const m = actor?.system?.attributes?.movement ?? {};
    const kind = ["fly", "swim", "climb", "burrow"].includes(action) ? action : "walk";
    const speed = Number(m[kind]) || ((kind !== "walk") ? Number(m.walk) || 0 : 0);
    return speed * (actor.statuses?.has?.("dashing") ? 2 : 1);
  }

  /* Feet moved this turn (Foundry clears the history when a turn starts) */
  static movedOf(token){
    const doc = token?.document ?? token;
    const history = doc?.movementHistory ?? [];
    if(history.length < 2) return 0;
    try { return Math.round(doc.measureMovementPath(history).cost ?? 0); }
    catch { return 0; }
  }

  /* A drag on its turn past its Speed : Rule Limits */
  static preMove(token, movement){
    if(!this.enabled() || !["dragging", "keyboard"].includes(movement?.method)) return;
    const actor = token.actor;
    const st = this.state(actor);
    if(!st?.mine || (st.combatant.tokenId !== token.id)) return;
    const action = movement.passed?.waypoints?.at?.(-1)?.action ?? movement.pending?.waypoints?.at?.(-1)?.action ?? token.movementAction;
    const speed = this.speedOf(actor, action);
    const total = (movement.history?.cost ?? 0) + (movement.passed?.cost ?? 0) + (movement.pending?.cost ?? 0) + (Number(st.rec.standing) || 0);
    if(!speed || (total <= speed + 0.01)) return;
    return limits.allow(module.format("actionTracker.tooFar", { name : actor.name, moved : Math.round(total), speed }), { who : actor.name, what : module.i18n("actionTracker.movement") }) ? undefined : false;
  }

  /* Its turn's log : how far it moved (the client that moved it) */
  static async logMove(token, movement, user){
    if(!this.enabled() || (user?.id ?? user) !== game.user.id) return;
    const feet = Math.round(movement?.passed?.cost ?? 0);
    const actor = token.actor;
    const st = feet ? this.state(actor) : null;
    if(!st?.mine || (st.combatant.tokenId !== token.id)) return;
    const moved = Math.round((movement.history?.cost ?? 0) + feet);
    this.note(st.rec, module.format("actionTracker.log.moved", { feet, moved, speed : this.speedOf(actor, movement.passed?.waypoints?.at?.(-1)?.action) }));
    await this.save(actor, st.rec);
  }

  /* ---------- Object interactions (Hands) ---------- */

  static isShield(item){
    return (item?.type === "equipment") && (item.system?.type?.value === "shield");
  }

  /* What goes into a hand on its turn : a weapon free with an attack, else the free interaction, else Utilize; a shield : Utilize */
  static preHands(actor, changes, options){
    const next = foundry.utils.getProperty(changes ?? {}, `flags.${module.id}.hands`);
    if(!next || !this.enabled()) return;
    const st = this.state(actor);
    if(!st?.mine) return;
    const was = actor.getFlag(module.id, "hands") ?? {};
    const before = new Set([was.main, was.off].filter(Boolean));
    const after = new Set([next.main ?? was.main, next.off ?? was.off].filter(Boolean));
    const moved = [...new Set([...after].filter(id => !before.has(id)).concat([...before].filter(id => !after.has(id))))].map(id => actor.items.get(id)).filter(Boolean);
    if(!moved.length) return;
    const rec = st.rec;
    let swaps = Number(rec.swaps) || 0, objects = Number(rec.objects) || 0, utilize = 0;
    const entries = [];
    for(const item of moved){
      const into = after.has(item.id);
      if(this.isShield(item)){ utilize += 1; entries.push([item, "utilize", into]); continue; }
      if(!into){ entries.push([item, "free", into]); continue; }
      if((item.type === "weapon") && (swaps < (Number(rec.made) || 0))){ swaps += 1; entries.push([item, "attack", into]); continue; }
      if(objects < 1){ objects += 1; entries.push([item, "object", into]); continue; }
      utilize += 1; entries.push([item, "utilize", into]);
    }
    if(utilize && (this.remaining(rec, "action") < utilize)
      && !limits.allow(module.format("actionTracker.utilize", { name : actor.name, item : entries.filter(e => e[1] === "utilize").map(e => e[0].name).join(", ") }), { who : actor.name, what : module.i18n("actionTracker.objects") })) return false;
    options[module.id] = { ...(options[module.id] ?? {}), economyHands : { swaps, objects, utilize, entries : entries.map(([item, how, into]) => ({ name : item.name, how, into })) } };
  }

  static async onHands(actor, options, userId){
    const plan = options?.[module.id]?.economyHands;
    if(!plan || (userId !== game.user.id)) return;
    const st = this.state(actor);
    if(!st) return;
    const rec = st.rec;
    rec.swaps = plan.swaps;
    rec.objects = plan.objects;
    if(plan.utilize) rec.used.action = (Number(rec.used.action) || 0) + plan.utilize;
    for(const e of plan.entries) this.note(rec, module.format(`actionTracker.log.${e.into ? "in" : "out"}`, { what : e.name, how : module.i18n(`actionTracker.how.${e.how}`) }));
    await this.save(actor, rec);
  }

  /* ---------- The combat tracker ---------- */

  static pipsHTML(rec, { small = false } = {}){
    return this.KINDS.map(kind => {
      const total = this.total(rec, kind);
      const used = Number(rec.used?.[kind]) || 0;
      const attacksLeft = (kind === "action") ? this.poolLeft(rec.attack) : 0;
      return Array.from({ length : total }, (_, i) => {
        const spent = i >= total - used;
        const added = i >= 1;
        const half = spent && (i === total - used) && (attacksLeft > 0);
        const tip = half ? module.format("actionTracker.attacks", { n : (attacksLeft >= this.MANY - 1) ? "…" : attacksLeft })
          : module.format(spent ? "actionTracker.used" : "actionTracker.left", { kind : this.label(kind) });
        const icon = half ? "fa-circle-half-stroke" : this.ICONS[kind];
        return `<i class="fa-solid ${icon} ${kind}${(spent && !half) ? " spent" : ""}${half ? " half" : ""}${added ? " added" : ""}" data-kind="${kind}" data-tooltip="${esc(tip)}"></i>`;
      }).join("");
    }).join(small ? "" : `<span class="sep"></span>`);
  }

  static drawTracker(html){
    if(!this.enabled()) return;
    const root = (html instanceof HTMLElement) ? html : html?.[0];
    const combat = ui.combat?.viewed ?? game.combat;
    if(!root || !combat?.started) return;
    for(const li of root.querySelectorAll("[data-combatant-id]")){
      const actor = combat.combatants.get(li.dataset.combatantId)?.actor;
      if(!actor || !(game.user.isGM || actor.isOwner)) continue;
      const st = this.state(actor);
      if(!st) continue;
      li.querySelector(`.${module.id}-economy`)?.remove();
      const box = document.createElement("div");
      box.className = `${module.id}-economy`;
      const left = this.poolLeft(st.rec.attack);
      box.innerHTML = this.pipsHTML(st.rec, { small : true }) + (((left > 0) && (left < this.MANY - 1))
        ? `<span class="attacks" data-tooltip="${esc(module.format("actionTracker.attacks", { n : left }))}">+${left}</span>` : "")
        + this.extrasHTML(actor) + this.readyHTML(st.rec);
      this.listen(box, actor);
      (li.querySelector(".token-name") ?? li).append(box);
    }
  }

  /* Clicks on pips : mark one used or give it back */
  static listen(box, actor){
    for(const type of ["pointerdown", "mousedown", "dblclick"]) box.addEventListener(type, event => event.stopPropagation());
    box.addEventListener("click", event => {
      const kind = event.target?.dataset?.kind;
      if(!kind) return;
      event.stopPropagation();
      event.preventDefault();
      this.toggle(actor, kind, event.target.classList.contains("spent"));
    });
  }

  /* Its owner or the GM : one used, or given back; a player's change is told to the GM */
  static async toggle(actor, kind, spent){
    const st = this.state(actor);
    if(!st || !actor.isOwner) return;
    const used = Number(st.rec.used[kind]) || 0;
    st.rec.used[kind] = spent ? Math.max(0, used - 1) : Math.min(this.total(st.rec, kind), used + 1);
    const text = module.format(spent ? "actionTracker.log.back" : "actionTracker.log.marked", { kind : this.label(kind), user : game.user.name });
    this.note(st.rec, text);
    await this.save(actor, st.rec);
    if(!game.user.isGM) await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }),
      whisper : game.users.filter(u => u.isGM).map(u => u.id), content : `<p>${esc(`${actor.name} : ${text}`)}</p>` });
  }
}
