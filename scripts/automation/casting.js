import { module } from '../module.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { spells } from './spells.js';
import { limits } from './limits.js';
import { esc, buttonRow, addButton, makeButton, chooseOption } from '../helpers/utils.js';
import { usedThisTurn, markUsedThisTurn, slotsLeft } from '../helpers/actors.js';
import { components } from './components.js';
import { gm } from '../gm.js';
const log = logger.for(import.meta.url);

/**
 * Casting time (System Automation → Spells switch), PHB 2024 Chapter 7.
 *
 *   One slot a turn  : a spell paid with a spell slot (Pact slots too) when one already was this turn follows Rule
 *                      Limits (in combat; cantrips, rituals and free castings don't count).
 *   Long casts       : a spell whose casting time is 1 minute or more, or one cast as a Ritual (10 minutes more), is
 *                      begun, not cast : the caster concentrates on it ("Casting : <spell>", ending any other
 *                      Concentration, after asking) and a card follows the cast. Its Finish Casting button casts it :
 *                      its owner's once the time has passed on the world clock (in combat, rounds pass it); the
 *                      GM's moves the clock on first if it hasn't. The slot and the targets are spent / picked at the
 *                      end. It fails, nothing spent, when the Concentration breaks, or the caster does anything
 *                      else : any other use (an action, Bonus Action, Reaction, attack or spell, from the sheet or a
 *                      card) asks first, then fails it. Moving and rolls asked for (saves, checks) don't.
 *   Durations        : an effect whose time ran out (Foundry marks it expired, off) is removed, so what depends on it
 *                      ends too (Concentration). A rest counts as time passing when it didn't move the world clock
 *                      itself : Short Rest 1 hour, Long Rest 8 hours.
 */
export class casting{
  static enabled(){
    return spells.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    /* ---------- One spell slot a turn ---------- */
    uses.onActivity("slotPerTurn", (activity, ctx, next) => this.slotStep(activity, ctx, next));
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.onCast(activity, usage, results));
    Hooks.on(`${module.id}.useCancelled`, activity => this.onCancelled(activity));
    /* ---------- Long casts ---------- */
    uses.onItem("castingBusy", (item, ctx, next) => this.busyStep(item?.actor, ctx, next));
    uses.onActivity("castingBusy", (activity, ctx, next) => this.busyStep(activity?.actor, ctx, next));
    uses.onActivity("longCast", (activity, ctx, next) => this.longStep(activity, ctx, next));
    gm.handle("longCastDone", (data, user) => this.doneAsGM(data, user));
    Hooks.on("deleteActiveEffect", (effect, options, userId) => { if(userId === game.user.id) this.onCastingEnded(effect, options); });
    Hooks.on("dnd5e.renderChatMessage", (message, html) => this.cardButtons(message, html));
    /* ---------- Durations ---------- */
    Hooks.on("updateActiveEffect", (effect, changes) => this.onExpired(effect, changes));
    Hooks.on("dnd5e.restCompleted", (actor, result, config) => this.onRest(actor, config));
  }

  /* ========== One spell slot a turn ========== */

  /* A slot spent by this use : a levelled spell needing one, not a ritual, its slot not left unspent */
  static spendsSlot(activity, config = {}){
    const item = activity?.item;
    if((item?.type !== "spell") || !(Number(item.system.level) > 0) || !activity.requiresSpellSlot) return false;
    if((config.scaling === false) || config?.[module.id]?.ritual) return false;
    return (config.consume !== false) && (config.consume?.spellSlot !== false);
  }

  static async slotStep(activity, ctx, next){
    if(!this.enabled() || !this.spendsSlot(activity, ctx.config) || !usedThisTurn(activity.actor, "spellSlot")) return next();
    if(!limits.allow(module.format("casting.oneSlot", { name : activity.actor.name, spell : activity.item.name }), { who : activity.actor.name, what : activity.item.name })) return;
    return next();
  }

  /* A cast cancelled before its card (cancelUse) : its slot is back, so is the turn's one */
  static async onCancelled(activity){
    const actor = activity?.actor;
    if(this.enabled() && actor?.isOwner && this.spendsSlot(activity) && usedThisTurn(actor, "spellSlot")) await actor.unsetFlag(module.id, "turn.spellSlot");
  }

  static async onCast(activity, usage, results){
    if(!this.enabled() || !results || !activity?.actor?.isOwner || !this.spendsSlot(activity, usage)) return;
    await markUsedThisTurn(activity.actor, "spellSlot");
  }

  /**
   * The module's own casting flows (Hunter's Mark, Hex, the smites), which don't go through dnd5e's use : the spell's
   * components, and the one-slot rule when a slot pays for it. Rule Limits decides.
   * @param {Item} spell
   * @param {object} [options]
   * @param {boolean} [options.slot]  a spell slot pays for it
   * @returns {boolean}  go ahead
   */
  static allowsCast(spell, { slot = false } = {}){
    const actor = spell?.actor;
    const activity = spell?.system?.activities?.contents?.[0];
    if(!this.enabled() || !actor || !activity) return true;
    const found = components.problems(activity, {});
    if(slot && usedThisTurn(actor, "spellSlot")) found.push(module.format("casting.oneSlot", { name : actor.name, spell : spell.name }));
    return !found.length || limits.allow(found.join(" "), { who : actor.name, what : spell.name });
  }

  /* A slot spent by one of those flows : this turn's */
  static async slotSpent(actor){
    if(this.enabled() && actor?.isOwner) await markUsedThisTurn(actor, "spellSlot");
  }

  /**
   * One spell slot spent by a flow that casts without dnd5e's use (a mark, a smite) : its count down, and this turn's.
   * @param {Actor} actor
   * @param {string} key   "spell2", "pact" (slotsLeft)
   */
  static async spendSlot(actor, key){
    const slot = actor?.system?.spells?.[key];
    if(!slot) return;
    await actor.update({ [`system.spells.${key}.value`] : Math.max(0, (Number(slot.value) || 0) - 1) });
    await this.slotSpent(actor);
  }

  /**
   * Concentration on a spell cast without dnd5e's use (another one ends first) : dnd5e's own, through the spell's
   * activity that concentrates, or its effect made here for a spell without one.
   * @param {Actor} actor
   * @param {Item} spell
   * @param {number} seconds   how long
   * @returns {Promise<ActiveEffect|null>}
   */
  static async concentrate(actor, spell, seconds){
    for(const effect of actor.concentration?.effects ?? []) await actor.endConcentration(effect);
    const activity = spell.system.activities?.find?.(a => a.duration?.concentration);
    if(activity){
      try { return await actor.beginConcentrating(activity, { duration : { value : seconds, units : "seconds" }, start : { time : game.time.worldTime } }); }
      catch(error){ log.debug("Concentration through the activity", error); }
    }
    const status = CONFIG.statusEffects.find(e => e.id === CONFIG.specialStatusEffects.CONCENTRATING);
    const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [{
      name : `${game.i18n.localize("EFFECT.DND5E.StatusConcentrating")}: ${spell.name}`, img : status?.img, origin : spell.uuid,
      statuses : [status?.id ?? "concentrating"], duration : { value : seconds, units : "seconds" }, start : { time : game.time.worldTime },
      flags : { dnd5e : { item : { type : spell.type, id : spell.id, uuid : spell.uuid } } },
    }]);
    return effect ?? null;
  }

  /* The caster's Concentration on this spell */
  static concentrationOn(actor, spell){
    return actor?.effects?.find?.(e => e.statuses?.has?.(CONFIG.specialStatusEffects.CONCENTRATING) && (e.getFlag("dnd5e", "item")?.uuid === spell?.uuid)) ?? null;
  }

  /* ========== Long casts ========== */

  /* How long the casting takes, in seconds (0 : an action or less) */
  static castSeconds(activity, config = {}){
    const activation = activity?.activation?.override ? activity.activation : (activity?.item?.system?.activation ?? activity?.activation ?? {});
    const value = Number(activation.value) || 1;
    const base = { minute : 60, hour : 3600, day : 86400 }[activation.type] ?? 0;
    return (base * value) + (config?.[module.id]?.ritual ? 600 : 0);
  }

  static castingOf(actor){
    return actor?.effects?.find?.(e => e.getFlag(module.id, "casting")) ?? null;
  }

  static async longStep(activity, ctx, next){
    if(!this.enabled() || (activity?.item?.type !== "spell") || ctx.config?.[module.id]?.longCastDone) return next();
    const seconds = this.castSeconds(activity, ctx.config);
    if(!(seconds > 0)) return next();
    const actor = activity.actor;
    /* Its components are needed from the start (checked again when it's cast) */
    const missing = components.problems(activity, ctx.config);
    if(missing.length && !limits.allow(missing.join(" "), { who : actor.name, what : activity.item.name })) return;
    /* Concentration while casting : any other ends, after asking (one whose time ran out just goes) */
    const concentrating = actor.effects.filter(e => e.statuses?.has?.(CONFIG.specialStatusEffects?.CONCENTRATING ?? "concentrating"));
    const stale = concentrating.filter(e => e.disabled || e.duration?.expired || (Number.isFinite(e.duration?.secondsRemaining) && (e.duration.secondsRemaining <= 0)));
    if(stale.length) await actor.deleteEmbeddedDocuments("ActiveEffect", stale.map(e => e.id)).catch(error => log.debug(error));
    const others = concentrating.filter(e => !stale.includes(e));
    if(others.length){
      const ok = await foundry.applications.api.DialogV2.confirm({ window : { title : activity.item.name },
        content : `<p>${esc(module.format("casting.endsConcentration", { spell : activity.item.name, names : others.map(e => e.name).join(", ") }))}</p>`, rejectClose : false });
      if(!ok) return;
      for(const effect of others) await actor.endConcentration(effect).catch(error => log.debug(error));
    }
    const end = game.time.worldTime + seconds;
    /* What the cast was set to (level, ritual...), kept for the end : plain data only */
    const config = foundry.utils.deepClone({ spell : ctx.config?.spell, scaling : ctx.config?.scaling, consume : ctx.config?.consume,
      [module.id] : ctx.config?.[module.id] ?? {} }, { strict : false });
    /* A Concentration effect of our own (dnd5e's beginConcentrating only takes spells that need Concentration;
       casting one that takes 1 minute or more always does) : saves on damage, ends on Incapacitated like any other */
    const status = CONFIG.statusEffects[CONFIG.specialStatusEffects?.CONCENTRATING ?? "concentrating"] ?? {};
    const item = activity.item;
    const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [{
      name : module.format("casting.effect", { spell : item.name }),
      img : status.img ?? item.img,
      origin : item.uuid,
      statuses : [status.id ?? "concentrating", ...(status.statuses ?? [])],
      system : { type : "concentrating" },
      /* No duration of its own : the card says when it's done (an expiry would end it as a failure) */
      duration : { value : null, units : "", expiry : null },
      flags : { dnd5e : { activity : { type : activity.type, id : activity.id, uuid : activity.uuid }, item : { type : item.type, id : item.id, uuid : item.uuid } },
        [module.id] : { casting : { activity : activity.uuid, end, config } } },
    }]);
    if(!effect) return;
    const message = await ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor }),
      content : `<p>${esc(module.format("casting.begins", { name : actor.name, spell : activity.item.name, time : this.timeLabel(seconds) }))}</p>`,
      flags : { [module.id] : { longCast : { actor : actor.uuid, effect : effect.id, end, spell : activity.item.name } } },
    });
    await effect.setFlag(module.id, "casting.message", message.id);
    return null;
  }

  static timeLabel(seconds){
    if(seconds >= 3600) return module.format("casting.hours", { n : Math.round(seconds / 360) / 10 });
    return module.format("casting.minutes", { n : Math.max(1, Math.round(seconds / 60)) });
  }

  /* Anything else the caster uses ends the cast, after asking */
  static async busyStep(actor, ctx, next){
    const effect = this.enabled() && !ctx.config?.[module.id]?.longCastDone ? this.castingOf(actor) : null;
    if(!effect) return next();
    const spell = effect.getFlag(module.id, "casting")?.activity ? fromUuidSync(effect.getFlag(module.id, "casting").activity, { strict : false })?.item?.name : "";
    const ok = await foundry.applications.api.DialogV2.confirm({ window : { title : actor.name },
      content : `<p>${esc(module.format("casting.busy", { name : actor.name, spell : spell ?? "" }))}</p>`, rejectClose : false });
    if(!ok) return;
    await effect.delete({ [module.id] : { castFailed : "busy" } });
    return next();
  }

  /* The casting's Concentration gone : finished (said so), or failed */
  static async onCastingEnded(effect, options){
    const data = effect.getFlag(module.id, "casting");
    if(!data || options?.[module.id]?.castFinished) return;
    const actor = effect.parent;
    const message = game.messages.get(data.message);
    const why = options?.[module.id]?.castFailed === "busy" ? "casting.failedBusy" : "casting.failed";
    const spell = fromUuidSync(data.activity ?? "", { strict : false })?.item?.name ?? "";
    if(message?.isOwner) await message.setFlag(module.id, "longCast.done", "failed");
    await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }),
      content : `<p>${esc(module.format(why, { name : actor?.name ?? "", spell }))}</p>` });
  }

  static cardButtons(message, html){
    const data = message.getFlag?.(module.id, "longCast");
    if(!data || data.done) return;
    const actor = fromUuidSync(data.actor ?? "", { strict : false });
    const effect = actor?.effects?.get?.(data.effect);
    if(!effect) return;
    const row = buttonRow(html, { key : `${module.id}-long-cast` });
    if(row.childElementCount) return;
    if(actor.isOwner) addButton(row, makeButton({ icon : "fa-wand-sparkles", text : module.i18n("casting.finish"), onClick : () => this.finish(message) }));
  }

  /* The card's state (finished, failed), by its owner or the GM */
  static async markDone(message, state){
    if(message.isOwner) return message.setFlag(module.id, "longCast.done", state);
    return gm.run("longCastDone", { message : message.id, state });
  }

  static async doneAsGM({ message : id, state } = {}, user){
    const message = game.messages.get(id);
    const data = message?.getFlag(module.id, "longCast");
    const actor = fromUuidSync(data?.actor ?? "", { strict : false });
    if(!data || !actor?.testUserPermission(user, "OWNER")) return false;
    await message.setFlag(module.id, "longCast.done", state);
    return true;
  }

  /* Finish Casting : the time passed, the spell is cast (its slot, its targets) */
  static async finish(message){
    const data = message.getFlag(module.id, "longCast");
    const actor = fromUuidSync(data?.actor ?? "", { strict : false });
    const effect = actor?.effects?.get?.(data?.effect);
    /* Already finished (someone else pressed it) or failed */
    if(!effect){
      ui.notifications.info(module.format("casting.gone", { spell : data?.spell ?? "" }));
      if(data && !data.done) await this.markDone(message, "gone").catch(error => log.debug(error));
      return;
    }
    const left = data.end - game.time.worldTime;
    /* The GM's Finish Casting moves the clock on; a player's waits for it */
    if(left > 0){
      if(!game.user.isGM) return ui.notifications.info(module.format("casting.notYet", { spell : data.spell, time : this.timeLabel(left) }));
      await game.time.advance(left);
    }
    const casting = effect.getFlag(module.id, "casting");
    const activity = fromUuidSync(casting.activity ?? "", { strict : false });
    if(!activity || !actor.effects.get(effect.id)) return;
    await effect.delete({ [module.id] : { castFinished : true } });
    await this.markDone(message, "finished").catch(error => log.debug(error));
    const config = foundry.utils.deepClone(casting.config ?? {});
    config[module.id] = { ...(config[module.id] ?? {}), longCastDone : true };
    return activity.use(config);
  }

  /* ========== Durations ========== */

  /* Foundry marked it expired (its time ran out) : removed, by the active GM */
  static async onExpired(effect, changes){
    if(!this.enabled() || !game.users.activeGM?.isSelf || (foundry.utils.getProperty(changes ?? {}, "duration.expired") !== true)) return;
    if((effect.parent?.documentName !== "Actor") || effect.getFlag(module.id, "casting")) return;
    await effect.delete().catch(error => log.debug(error));
  }

  /* A rest that didn't move the world clock : its time passes for this creature's effects */
  static async onRest(actor, config = {}){
    if(!this.enabled() || !actor?.isOwner || config.advanceTime) return;
    const seconds = (config.type === "long") ? 8 * 3600 : 3600;
    const done = actor.effects.filter(e => (e.duration?.units && !["turns", "rounds"].includes(e.duration.units)) && Number.isFinite(e.duration.secondsRemaining)
      && (e.duration.secondsRemaining <= seconds) && !e.getFlag(module.id, "casting"));
    if(done.length) await actor.deleteEmbeddedDocuments("ActiveEffect", done.map(e => e.id)).catch(error => log.debug(error));
  }
}

/* ---------- Paying for a casting outside dnd5e's use : the payCasting lego ---------- */

/**
 * The ways a creature can pay to cast a spell now : its free castings first, then each spell slot level left from the
 * spell's level up (Pact Magic's too). Each way can pay for itself : `await option.pay()`.
 * @param {Actor} actor
 * @param {Item} spell
 * @param {object} [options]
 * @param {object} [options.free]      free castings : { left(actor) -> number, spend(actor), label(left, spell) }
 * @param {number} [options.minLevel]  the lowest slot (default : the spell's level)
 * @param {object} [options.labels]    { slot(slot, spell) } instead of "Level 2 slot (1 left)"
 * @returns {object[]}  [{ value, label, spell, level, free, slot, pay() }]
 */
export function castingOptions(actor, spell, { free = null, minLevel = null, labels = {} } = {}){
  const out = [];
  const level = minLevel ?? Math.max(1, Number(spell?.system?.level) || 1);
  const left = free ? (Number(free.left(actor)) || 0) : 0;
  if(left > 0) out.push({ value : `${spell?.id ?? ""}|free`, label : free.label?.(left, spell) ?? module.format("casting.payFree", { left }), spell,
    level, free : true, pay : () => free.spend(actor) });
  for(const slot of slotsLeft(actor, level)){
    out.push({ value : `${spell?.id ?? ""}|${slot.key}`, spell, level : slot.level, slot, free : false,
      label : labels.slot?.(slot, spell) ?? module.format(slot.pact ? "marks.payPact" : "marks.paySlot", { level : slot.level, left : slot.value }),
      pay : () => casting.spendSlot(actor, slot.key) });
  }
  return out;
}

/**
 * Cast a spell outside dnd5e's use (a mark, a smite, a homebrew "cast it as part of the attack") : choose how to pay
 * (castingOptions), check it may be cast (its components, one slot a turn : Casting), and pay.
 *   const cast = await MacroHelper.payCasting(actor, spell, { free });             paid; cast.level, cast.free
 *   const cast = await MacroHelper.payCasting(actor, spell, { spend : false });    chosen and checked; await cast.pay() later
 * @param {Actor} actor
 * @param {Item} spell
 * @param {object} [options]   castingOptions' (free, minLevel, labels), and :
 * @param {object} [options.choice]     one of castingOptions' already chosen (no question)
 * @param {boolean} [options.spend=true]
 * @param {string} [options.title], [options.prompt], [options.icon]
 * @returns {Promise<object|null>}  the way chosen, null : none, or cancelled, or not allowed
 */
export async function payCasting(actor, spell, { choice = null, spend = true, title = null, prompt = null, icon = "fa-solid fa-wand-sparkles", ...rest } = {}){
  if(!choice){
    const options = castingOptions(actor, spell, rest);
    if(!options.length){
      ui.notifications.warn(module.format("marks.noPay", { name : actor?.name ?? "", spell : spell?.name ?? "" }));
      return null;
    }
    const value = await chooseOption({ title : title ?? spell.name, icon, prompt : prompt ?? module.i18n("marks.payPrompt"), options });
    choice = options.find(o => o.value === value) ?? null;
  }
  if(!choice || !casting.allowsCast(choice.spell ?? spell, { slot : !choice.free })) return null;
  if(spend) await choice.pay();
  return choice;
}
