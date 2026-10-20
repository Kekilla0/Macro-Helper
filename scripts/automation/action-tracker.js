import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { gm } from '../gm.js';
import { limits } from './limits.js';
import { combatLog } from './combat-log.js';
import { grapplesOn, reactionMoveOf } from '../roll-item/card-builder.js';
import { idOf, esc } from '../helpers/utils.js';
import { getTokensWithin, movedThisTurn } from '../helpers/tokens.js';
import { masteries } from './masteries.js';
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
 *                           Block stops a drag past it; Warn says so. A player dragging its creature on someone else's
 *                           turn : Rule Limits too (the GM's drags are free : forced movement, setting the scene).
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
    gm.handle("wake", (data, user) => this.wakeAsGM(data, user));
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
    /* token.hasReaction() (card macros) : false when its Reaction is spent or it can't take one */
    Hooks.on(`${module.id}.hasReaction`, actor => this.left(actor, "reaction") ? undefined : false);
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

  /* Asleep and can be woken (Sleep Breath) : its effects a creature within 5 ft can end with its Action */
  static wakeEffects(actor){
    return (actor?.effects?.contents ?? []).filter(e => !e.disabled && e.getFlag(module.id, "repeat")?.wake);
  }

  /* The creatures within 5 ft of this token that it can wake */
  static sleepersNear(token){
    if(!token) return [];
    return getTokensWithin(token, 5, { includeDead : true }).filter(t => (t !== token) && this.wakeEffects(t.actor).length);
  }

  /* Its turn : its Action wakes a creature within 5 ft */
  static async wake(actor, token, sleeper){
    const what = module.format("actionTracker.bar.wake", { name : sleeper?.name ?? "" });
    if(!sleeper || !this.wakeEffects(sleeper.actor).length) return;
    if(!this.left(actor, "action") && !limits.allow(module.format("actionTracker.spent", { name : actor.name, kind : this.label("action") }), { who : actor.name, what })) return;
    const ok = await gm.run("wake", { target : (sleeper.document ?? sleeper).uuid, by : (token.document ?? token).uuid });
    if(ok) await this.spend(actor, { kind : "action", what });
  }

  /* GM : the waker's owner (or the GM) pressed Wake, and it's still within 5 ft */
  static async wakeAsGM({ target : uuid, by } = {}, user){
    const sleeper = fromUuidSync(uuid ?? "", { strict : false });
    const waker = fromUuidSync(by ?? "", { strict : false });
    if(!sleeper?.actor || !waker?.actor || !(user.isGM || waker.actor.testUserPermission(user, "OWNER"))) return false;
    if(!this.sleepersNear(waker.object).some(t => t.document === sleeper)) return false;
    const ids = this.wakeEffects(sleeper.actor).map(e => e.id);
    await sleeper.actor.deleteEmbeddedDocuments("ActiveEffect", ids, { [module.id] : { reason : module.format("actionTracker.woken", { name : waker.name }) } });
    return true;
  }

  /* Its turn, Grappled : escape (its Action) : the better of Athletics and Acrobatics against the escape DC */
  static async escape(actor, effectId = null){
    const grapple = grapplesOn(actor).find(g => !effectId || (g.effect.id === effectId)) ?? null;
    if(!grapple) return;
    if(!this.left(actor, "action") && !limits.allow(module.format("actionTracker.spent", { name : actor.name, kind : this.label("action") }), { who : actor.name, what : module.i18n("actionTracker.escape") })) return;
    const skills = actor.system?.skills ?? {};
    /* The better of Athletics and Acrobatics, unless it says which (a Darkmantle's attach : Athletics) */
    const skill = grapple.skill ?? (((Number(skills.acr?.total) || 0) > (Number(skills.ath?.total) || 0)) ? "acr" : "ath");
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
    const cost = Math.floor(this.speedOf(actor, "walk") / (this.isDashing(actor) ? 4 : 2));
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

  /* Every key a turn's record can hold : save() merges into the flag, so a key left out would carry on from the last turn */
  static fresh(combat, round){
    return { combat : combat.id, round, used : { action : 0, bonus : 0, reaction : 0 }, extra : { action : 0, bonus : 0, reaction : 0 },
      attack : null, light : false, nick : false, made : 0, swaps : 0, objects : 0, standing : 0, moreMove : 0, ready : null, log : [] };
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
    /* It can't take Reactions (Arms of Hadar, Slowing Breath : flags.macro-helper.rule.noReactions) : none to offer */
    if((kind === "reaction") && actor?.effects?.some?.(e => !e.disabled && !e.isSuppressed && e.getFlag(module.id, "rule")?.noReactions)) return false;
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

  /* Uses that take the place of one of the Attack action's attacks (Commander's Strike), by item identifier */
  static REPLACES_ATTACK = new Set();

  static costOf(activity, config = {}){
    const own = config?.[module.id] ?? {};
    if(own.economy) return (own.economy === "free") ? null : own.economy;
    if(own.ritual || own.noCast) return null;
    /* A Cast activity (Steps of the Fey's free Misty Step) : the spell it casts spends it */
    if(activity.type === "cast") return null;
    if(this.REPLACES_ATTACK.has(idOf(activity.item))) return "action";
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

  /* An effect that allows an Action or a Bonus Action, not both (Slowing Breath : flags.macro-helper.rule.oneAction) */
  static oneAction(actor){
    return !!actor?.effects?.some?.(e => !e.disabled && !e.isSuppressed && e.getFlag(module.id, "rule")?.oneAction);
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
   * A creature's Multiattack, from its text, sentence by sentence :
   *   "two Claw attacks and one Bite attack"            left   : { claw : 2, bite : 1 }
   *   "two attacks"                                     any    : 2
   *   "two Rend or Slam attacks",
   *   "two attacks, using A, B, or C in any combination" shared : [{ n : 2, ids : [a, b, c] }]
   *   "five Slam attacks or five Discharge attacks"     choice : [[{ id : slam, n : 5 }], [{ id : discharge, n : 5 }]]
   *   "It can replace one attack with a Bite attack"    swap   : [bite]   (stands in for one attack of the pool)
   *   "uses Paralyzing Tentacles", "uses Antennae twice" uses : { tentacles : 1, antennae : 2 }   (part of it, no Action)
   * Unreadable : as many as it likes.
   */
  static parseMultiattack(actor, item){
    const text = (item?.system?.description?.value ?? "").replace(/<[^>]+>/g, " ").replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1").replace(/@\w+\[([^\]|]+)[^\]]*\]/g, "$1").replace(/\s+/g, " ").trim();
    const items = actor.items?.contents ?? [];
    const attacks = items.filter(i => i.system?.activities?.some?.(a => a.type === "attack"));
    const find = (name, list = attacks) => {
      const n = name.toLowerCase().replace(/^(its|their|the)\s+/, "").replace(/s$/, "").trim();
      return list.find(i => i.name.toLowerCase() === n) ?? list.find(i => n.startsWith(i.name.toLowerCase()) || i.name.toLowerCase().startsWith(n));
    };
    const ids = list => list.split(/\s*,\s*(?:or\s+|and\s+)?|\s+(?:or|and)\s+/).map(n => find(n)?.id).filter(Boolean);
    const out = { any : 0, left : {}, shared : [], choice : [], swap : [], uses : {}, text };
    const TIMES = { once : 1, twice : 2, thrice : 3 };
    const count = w => this.NUMBERS[w.toLowerCase()] ?? Number(w);
    const N = "(a|an|one|two|three|four|five|six|\\d+)", NAME = "[A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*";
    const named = new RegExp(`\\b${N}\\s+(?:attacks?\\s+with\\s+(?:its|their)\\s+([\\w' -]+?)(?=[.,;]|\\s+and\\b|$)|(${NAME})\\s+attacks?\\b|attacks?\\b)`, "g");
    for(let s of text.split(/(?<=\.)\s+/)){
      const swap = s.match(new RegExp(`replace\\s+one\\s+attack\\s+with\\s+(?:a\\s+use\\s+of\\s+|an?\\s+)?(?:its\\s+)?(${NAME})`));
      if(swap){
        const hit = find(swap[1], items);
        if(hit) out.swap.push(hit.id);
        continue;
      }
      /* "it can use Spellcasting to cast Charm Monster" : that spell is part of it */
      s = s.replace(new RegExp(`\\b(?:can\\s+)?uses?\\s+Spellcasting\\s+to\\s+cast\\s+(${NAME})`, "g"), (all, name) => {
        const hit = find(name, items);
        if(hit) out.uses[hit.id] = (out.uses[hit.id] ?? 0) + 1;
        return hit ? " " : all;
      });
      /* "uses Constrict", "uses Antennae twice" : those uses are part of it */
      s = s.replace(new RegExp(`\\buses\\s+(?:its\\s+)?(${NAME})(?:\\s+(once|twice|thrice|(\\d+|two|three|four)\\s+times))?`, "g"), (all, name, times, n) => {
        const hit = find(name, items);
        if(hit) out.uses[hit.id] = (out.uses[hit.id] ?? 0) + (TIMES[times] ?? (n ? count(n) : 1));
        return hit ? " " : all;
      });
      s = s.replace(new RegExp(`\\b${N}\\s+attacks?,?\\s+using\\s+(.+?)\\s+in\\s+any\\s+combination`, "g"), (all, n, list) => {
        const group = ids(list);
        if(group.length) out.shared.push({ n : count(n), ids : group });
        return group.length ? " " : all;
      });
      s = s.replace(new RegExp(`\\b${N}\\s+(${NAME})\\s+attacks?\\s+or\\s+${N}\\s+(${NAME})\\s+attacks?\\b`, "g"), (all, n1, a, n2, b) => {
        const [x, y] = [find(a), find(b)];
        if(x && y) out.choice.push([{ id : x.id, n : count(n1) }], [{ id : y.id, n : count(n2) }]);
        return (x && y) ? " " : all;
      });
      s = s.replace(new RegExp(`\\b${N}\\s+(${NAME}(?:\\s*,\\s*${NAME})*,?\\s+or\\s+${NAME})\\s+attacks?\\b`, "g"), (all, n, list) => {
        const group = ids(list);
        if(group.length) out.shared.push({ n : count(n), ids : group });
        return group.length ? " " : all;
      });
      for(const m of s.matchAll(named)){
        const n = count(m[1]);
        if(!Number.isFinite(n) || (n < 1)) continue;
        const name = m[2] ?? m[3];
        const hit = name ? find(name) : null;
        if(hit) out.left[hit.id] = (out.left[hit.id] ?? 0) + n;
        else if(!name) out.any += n;
      }
    }
    if(!this.poolLeft(out)) out.any = this.MANY;
    return out;
  }

  /* The pool the first attack opens : { any, left, shared, choice, swap, uses, text } */
  static attackPool(actor, activity){
    const multi = this.multiattackOf(actor);
    const pool = multi ? this.parseMultiattack(actor, multi) : { any : this.attacksPerAction(actor, activity?.item), left : {}, text : "" };
    pool.total = this.poolLeft(pool);
    return pool;
  }

  /* Take one attack from the pool : true if it had one for this item. The first attack of an either/or picks its branch;
     an attack (or use) the Multiattack lets replace one attack takes one from anywhere in the pool */
  static takeAttack(pool, item){
    if(!pool || !item) return false;
    const id = item.id;
    if(pool.choice?.length){
      const branch = pool.choice.find(b => b.some(e => e.id === id));
      if(branch){
        for(const e of branch) pool.left[e.id] = (pool.left[e.id] ?? 0) + e.n;
        pool.choice = [];
      }
    }
    if((pool.left?.[id] ?? 0) > 0){ pool.left[id] -= 1; return true; }
    if((pool.uses?.[id] ?? 0) > 0){ pool.uses[id] -= 1; return true; }
    const group = pool.shared?.find(g => (g.n > 0) && g.ids.includes(id));
    if(group){ group.n -= 1; return true; }
    if(this.isSwap(pool, item)){
      pool.swap = [];
      if(pool.choice?.length){
        for(const e of pool.choice[0]) pool.left[e.id] = (pool.left[e.id] ?? 0) + e.n;
        pool.choice = [];
      }
      if((pool.any ?? 0) > 0){ pool.any -= 1; return true; }
      const shared = pool.shared?.find(g => g.n > 0);
      if(shared){ shared.n -= 1; return true; }
      const left = Object.keys(pool.left ?? {}).find(k => pool.left[k] > 0);
      if(left){ pool.left[left] -= 1; return true; }
    }
    if((pool.any ?? 0) > 0){ pool.any -= 1; return true; }
    return false;
  }

  /* Can this use stand in for one of the pool's attacks ("It can replace one attack with a use of Roar") */
  static isSwap(pool, item){
    return !!item && !!pool?.swap?.includes(item.id) && (this.poolLeft(pool) > 0);
  }

  static poolLeft(pool){
    return (pool?.any ?? 0) + Object.values(pool?.left ?? {}).reduce((a, b) => a + b, 0)
      + Object.values(pool?.uses ?? {}).reduce((a, b) => a + b, 0)
      + (pool?.shared ?? []).reduce((a, g) => a + g.n, 0)
      + Math.max(0, ...(pool?.choice ?? []).map(b => b.reduce((a, e) => a + e.n, 0)));
  }

  /* After the Attack action's attacks : the Bonus Action attack it allows */
  static bonusAttack(activity, rec){
    const item = activity.item;
    /* The Light property's extra attack, unless Nick already made it part of the Attack action */
    if(rec.light && this.isLight(item) && !rec.nick) return true;
    return (idOf(item) === "unarmed-strike") && !!activity.actor?.items?.some?.(i => idOf(i) === "martial-arts");
  }

  /* A use that's part of its Multiattack without being an attack : "uses Paralyzing Tentacles", or one that stands in
     for an attack ("It can replace one attack with a use of Roar") */
  static swapsIn(activity){
    const multi = this.multiattackOf(activity?.actor);
    if(!multi || !activity.item) return false;
    const pool = this.parseMultiattack(activity.actor, multi);
    return pool.swap.includes(activity.item.id) || ((pool.uses[activity.item.id] ?? 0) > 0);
  }

  /* { kind, attack : "new" | "more" | "bonus" | "over" | null, offTurn, ask } */
  static plan(activity, cost, st){
    const attack = this.isAttack(activity);
    if(cost === "reaction") return { kind : "reaction" };
    if(!st.mine) return { kind : "reaction", offTurn : cost, attackOffTurn : attack, ask : !attack && !!activity.actor?.hasPlayerOwner && !game.user.isGM };
    const swap = !attack && (cost === "action") && (this.swapsIn(activity) || this.REPLACES_ATTACK.has(idOf(activity.item)));
    if((attack || swap || this.isMultiattack(activity.item)) && (cost === "action")){
      if(st.rec.attack){
        const pool = foundry.utils.deepClone(st.rec.attack);
        if((attack || swap) && this.takeAttack(pool, activity.item)) return { kind : null, attack : "more", pool };
        /* Nick (mastery) : the Light property's extra attack is part of the Attack action, once a turn */
        if(attack && st.rec.light && this.isLight(activity.item) && !st.rec.nick && masteries.nick(activity)) return { kind : null, attack : "more", pool, nick : true };
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
    /* In its shell (a Tortle's Shell Defense) : nothing but Emerge (its action bar's button) */
    if(actor.effects?.some?.(e => !e.disabled && e.getFlag(module.id, "rule")?.shell)
      && !limits.allow(module.format("species.inShell", { name : actor.name }), { who : actor.name, what : activity.item?.name ?? "" })) return null;
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
    finally {
      /* Refused or cancelled (dnd5e : no uses left) : as it was, and the log says so */
      if(!result){
        await this.save(actor, st.rec).catch(error => log.error(error));
        await combatLog.add(actor, module.i18n("combatLog.cancelled")).catch(error => log.debug(error));
      }
    }
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
    /* An Action or a Bonus Action, not both (Slowing Breath) : using one spends the other too */
    if(["action", "bonus"].includes(kind) && this.oneAction(actor)){
      const other = (kind === "action") ? "bonus" : "action";
      rec.used[other] = Math.max(Number(rec.used[other]) || 0, this.total(rec, other));
    }
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
      if(this.isAttack(activity) || this.swapsIn(activity) || this.REPLACES_ATTACK.has(idOf(activity?.item))) this.takeAttack(rec.attack, activity.item);
      rec.light = this.isAttack(activity) && this.isLight(activity.item);
    }
    else if(attack === "more"){
      rec.attack = plan.pool;
      if(plan.nick) rec.nick = true;
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

  /* A macro's Reaction (an Ochre Jelly's Split) : false when it has none left (spent, or it can't take Reactions);
     otherwise spent and logged. Out of combat, or the tracker off : true, nothing to spend. */
  static async useReaction(thing, what = ""){
    const actor = thing?.actor ?? thing;
    if(!this.left(actor, "reaction")) return false;
    if(this.state(actor)) await this.spend(actor, { kind : "reaction", what });
    return true;
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
    return speed * (this.isDashing(actor) ? 2 : 1);
  }

  /* Dashing : the status (Dissonant Whispers' flee), or the Dash action's own mark (Dash, Step of the Wind) */
  static isDashing(actor){
    return !!(actor?.statuses?.has?.("dashing") || actor?.effects?.some?.(e => !e.disabled && e.getFlag(module.id, "dash")));
  }

  /* Its movement this turn : its Speed, and what macros added (token.useMovement(50) : Trampling Charge, like a Dash) */
  static movementOf(actor, action = "walk"){
    return this.speedOf(actor, action) + (Number(this.state(actor)?.rec?.moreMove) || 0);
  }

  static isTeleport(action){
    return !!CONFIG.Token.movement?.actions?.[action]?.teleport;
  }

  /* Feet moved this turn (Foundry clears the history when a turn starts); a teleport (Misty Step) spends none */
  static movedOf(token){
    return movedThisTurn(token);
  }

  /* A drag on its turn past its Speed : Rule Limits */
  static preMove(token, movement){
    if(!this.enabled() || !["dragging", "keyboard"].includes(movement?.method)) return;
    const actor = token.actor;
    const st = this.state(actor);
    if(!st) return;
    /* Its Reaction spent moving (Mantle of Inspiration) : up to its feet, no question */
    const reacting = !st.mine ? reactionMoveOf(actor) : null;
    if(reacting){
      const total = (Number(reacting.moved) || 0) + (movement.passed?.cost ?? 0) + (movement.pending?.cost ?? 0);
      if(total <= reacting.feet + 0.01) return;
      return limits.allow(module.format("actionTracker.tooFar", { name : actor.name, moved : Math.round(total), speed : reacting.feet }), { who : actor.name, what : module.i18n("actionTracker.movement") }) ? undefined : false;
    }
    /* A player moving its creature on someone else's turn : Rule Limits (the GM's moves are free : forced movement) */
    if(!st.mine && !game.user.isGM)
      return limits.allow(module.format("actionTracker.notItsTurn", { name : actor.name, turn : st.combat.combatant?.name ?? "" }), { who : actor.name, what : module.i18n("actionTracker.movement") }) ? undefined : false;
    if(!st.mine || (st.combatant.tokenId !== token.id)) return;
    const action = movement.passed?.waypoints?.at?.(-1)?.action ?? movement.pending?.waypoints?.at?.(-1)?.action ?? token.movementAction;
    const speed = this.movementOf(actor, action);
    const total = this.movedOf(token) + (movement.passed?.cost ?? 0) + (movement.pending?.cost ?? 0) + (Number(st.rec.standing) || 0);
    if(!speed || (total <= speed + 0.01)) return;
    return limits.allow(module.format("actionTracker.tooFar", { name : actor.name, moved : Math.round(total), speed }), { who : actor.name, what : module.i18n("actionTracker.movement") }) ? undefined : false;
  }

  /* Its turn's log : how far it moved (the client that moved it) */
  static async logMove(token, movement, user){
    if(!this.enabled() || (user?.id ?? user) !== game.user.id) return;
    const feet = Math.round(movement?.passed?.cost ?? 0);
    /* A leap (token.leap), even split by an Opportunity Attack stop : every part of it until it lands */
    const mark = this.#leaping.get(token.id);
    const leapt = !!mark && (Date.now() < mark.until);
    const to = movement?.destination ?? token;
    if(mark && (!leapt || ((to.x === mark.x) && (to.y === mark.y)))) this.#leaping.delete(token.id);
    const actor = token.actor;
    const st = feet ? this.state(actor) : null;
    if(!st?.mine || (st.combatant.tokenId !== token.id)) return;
    const action = movement.passed?.waypoints?.at?.(-1)?.action;
    /* A leap (token.leap) : its distance isn't movement spent (the macro says what it costs : token.useMovement) */
    if(leapt){
      st.rec.standing = (Number(st.rec.standing) || 0) - feet;
      this.note(st.rec, module.format("actionTracker.log.leapt", { feet }));
    }
    else if(this.isTeleport(action)) this.note(st.rec, module.format("actionTracker.log.teleported", { feet }));
    else this.note(st.rec, module.format("actionTracker.log.moved", { feet, moved : this.movedOf(token) + (Number(st.rec.standing) || 0), speed : this.movementOf(actor, action) }));
    await this.save(actor, st.rec);
  }

  /* token.leap : its moves until it lands there are the leap (logMove takes them off the movement spent) */
  static #leaping = new Map();
  static markLeap(tokenId, { x, y } = {}){
    this.#leaping.set(tokenId, { x, y, until : Date.now() + 120000 });
  }

  /**
   * Its movement this turn, outside a move : token.useMovement(-10) spends 10 ft (a leap's cost; past its movement :
   * Rule Limits), token.useMovement(50) gives it 50 ft more this turn (Trampling Charge, like a Dash).
   * Not in a combat (no turn) : nothing to count.
   * @returns {Promise<boolean>}  false if Rule Limits stopped it
   */
  static async useMovement(thing, feet){
    const token = thing?.document ? thing : (thing?.object ?? null);
    const actor = thing?.actor ?? thing;
    const st = this.enabled() ? this.state(actor) : null;
    const n = Math.round(Number(feet) || 0);
    if(!st || !n) return true;
    const action = token?.document?.movementAction ?? "walk";
    const moved = (token ? this.movedOf(token) : 0) + (Number(st.rec.standing) || 0);
    if(n > 0){
      st.rec.moreMove = (Number(st.rec.moreMove) || 0) + n;
      this.note(st.rec, module.format("actionTracker.log.movementMore", { feet : n, moved, speed : this.speedOf(actor, action) + st.rec.moreMove }));
      await this.save(actor, st.rec);
      return true;
    }
    const spend = -n, speed = this.movementOf(actor, action);
    if(speed && (moved + spend > speed + 0.01)
      && !limits.allow(module.format("actionTracker.tooFar", { name : actor.name, moved : moved + spend, speed }), { who : actor.name, what : module.i18n("actionTracker.movement") })) return false;
    st.rec.standing = (Number(st.rec.standing) || 0) + spend;
    this.note(st.rec, module.format("actionTracker.log.movementUsed", { feet : spend, moved : moved + spend, speed }));
    await this.save(actor, st.rec);
    return true;
  }

  /* ---------- Object interactions (Hands) ---------- */

  static isShield(item){
    return (item?.type === "equipment") && (item.system?.type?.value === "shield");
  }

  /* What goes into a hand on its turn : a weapon free with an attack, else the free interaction, else Utilize; a shield : Utilize */
  static preHands(actor, changes, options){
    const next = foundry.utils.getProperty(changes ?? {}, `flags.${module.id}.hands`);
    /* A creature's first hand change starts from the shield the GM marked equipped : bookkeeping, free */
    if(!next || !this.enabled() || options?.[module.id]?.handsAdopt) return;
    const st = this.state(actor);
    if(!st?.mine) return;
    const was = actor.getFlag(module.id, "hands") ?? {};
    const before = new Set([was.main, was.off].filter(Boolean));
    const after = new Set([next.main ?? was.main, next.off ?? was.off].filter(Boolean));
    const moved = [...new Set([...after].filter(id => !before.has(id)).concat([...before].filter(id => !after.has(id))))].map(id => actor.items.get(id))
      /* Unarmed Strike and natural weapons aren't objects : nothing to count */
      .filter(item => item && !((item.type === "weapon") && ((item.system.type?.value === "natural") || (idOf(item) === "unarmed-strike"))));
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
        /* The Attack action's pip empties as its attacks are made */
        const all = Number(rec.attack?.total) || 0;
        if(half && (attacksLeft < this.MANY - 1) && (all > 0))
          return `<i class="pie ${kind}${added ? " added" : ""}" style="--left:${Math.round(100 * attacksLeft / all)}%" data-kind="${kind}" data-tooltip="${esc(tip)}"></i>`;
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
      box.innerHTML = this.pipsHTML(st.rec, { small : true }) + this.extrasHTML(actor) + this.readyHTML(st.rec);
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
