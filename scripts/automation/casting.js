import { module } from '../module.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { spells } from './spells.js';
import { limits } from './limits.js';
import { esc, buttonRow, addButton, makeButton } from '../helpers/utils.js';
import { usedThisTurn, markUsedThisTurn } from '../helpers/actors.js';
import { components } from './components.js';
const log = logger.for(import.meta.url);

/**
 * Casting time (System Automation → Spells switch), PHB 2024 Chapter 7.
 *
 *   One slot a turn  : a spell paid with a spell slot (Pact slots too) when one already was this turn follows Rule
 *                      Limits (in combat; cantrips, rituals and free castings don't count).
 *   Long casts       : a spell whose casting time is 1 minute or more, or one cast as a Ritual (10 minutes more), is
 *                      begun, not cast : the caster concentrates on it ("Casting : <spell>", ending any other
 *                      Concentration, after asking) and a card follows the cast. Its owner's Finish Casting button
 *                      casts it once the time has passed on the world clock (in combat, rounds pass it); the GM's
 *                      Pass the Time button moves the clock on. The slot and the targets are spent / picked at the
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
    /* ---------- Long casts ---------- */
    uses.onItem("castingBusy", (item, ctx, next) => this.busyStep(item?.actor, ctx, next));
    uses.onActivity("castingBusy", (activity, ctx, next) => this.busyStep(activity?.actor, ctx, next));
    uses.onActivity("longCast", (activity, ctx, next) => this.longStep(activity, ctx, next));
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
    /* Concentration while casting : any other ends, after asking */
    const others = actor.effects.filter(e => e.statuses?.has?.(CONFIG.specialStatusEffects?.CONCENTRATING ?? "concentrating"));
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
    const effect = await actor.beginConcentrating(activity, {
      name : module.format("casting.effect", { spell : activity.item.name }),
      /* No duration of its own : the card says when it's done (an expiry would end it as a failure) */
      duration : { value : null, units : "", expiry : null },
      flags : { [module.id] : { casting : { activity : activity.uuid, end, config } } },
    });
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
    if(game.user.isGM && (game.time.worldTime < data.end)) addButton(row, makeButton({ icon : "fa-hourglass-half", text : module.i18n("casting.passTime"), once : true,
      onClick : () => game.time.advance(data.end - game.time.worldTime) }));
  }

  /* Finish Casting : the time passed, the spell is cast (its slot, its targets) */
  static async finish(message){
    const data = message.getFlag(module.id, "longCast");
    const actor = fromUuidSync(data?.actor ?? "", { strict : false });
    const effect = actor?.effects?.get?.(data?.effect);
    if(!effect) return;
    const left = data.end - game.time.worldTime;
    if(left > 0) return ui.notifications.info(module.format("casting.notYet", { spell : data.spell, time : this.timeLabel(left) }));
    const casting = effect.getFlag(module.id, "casting");
    const activity = fromUuidSync(casting.activity ?? "", { strict : false });
    if(!activity) return;
    await effect.delete({ [module.id] : { castFinished : true } });
    if(message.isOwner) await message.setFlag(module.id, "longCast.done", "finished");
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
