import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { idOf, chooseOption, esc, buttonRow, addButton, makeButton } from '../../helpers/utils.js';
import { addTimedEffect, usedThisTurn, markUsedThisTurn } from '../../helpers/actors.js';
import { limits } from '../limits.js';
import { giveMode } from '../../roll-item/reasons.js';
import { rollModes } from '../roll-modes.js';
import { uses } from '../../uses.js';
import { actions } from '../actions.js';
import { patch } from '../../patch.js';
import { restChoices } from '../rest-choices.js';
import { chooseOne } from '../../helpers/creatures.js';
const log = logger.for(import.meta.url);

/**
 * Sorcerer, levels 1-2 (Classes setting). Font of Magic's conversions (slots <-> Sorcery Points) are the items' own
 * activities; changing a prepared spell on a level is Prepared Spells. Works from item identifiers, whoever made them.
 *
 *   Innate Sorcery : using it puts its effect on the Sorcerer at once (its own token : the item's effect, +1 spell save
 *                    DC, for a minute). While it's on, the Sorcerer's spell attack rolls (Sorcerer spells) have
 *                    advantage (a roll-modes rule : the pick map shows it too). Its +1 is to every spell's DC in dnd5e;
 *                    the spells that aren't Sorcerer spells (a species' or feat's) get it taken back off.
 *   Metamagic      : casting a spell (any the Sorcerer has : 2024 Metamagic changes "spells you cast") with Metamagic
 *                    options known and Sorcery Points to pay : which option (or none). The card shows it under the
 *                    spell's description, like the spell (its header, its description folding under it), Empowered /
 *                    Seeking once used; its points are spent once the cast goes through (a pick closed, or no target
 *                    in range : nothing spent). Distant Spell doubles the range picked within (Touch : 30 ft).
 *                    Careful / Heightened : toggles per target on the save card's rows (Careful : up to the CHA
 *                    modifier, they succeed without rolling and take no damage where a success takes half; Heightened :
 *                    one, its first save has disadvantage). Empowered / Seeking : buttons on the card after the roll
 *                    (alongside another option) : the lowest CHA-modifier damage dice rolled again / a missed spell
 *                    attack's d20 rolled again. Extended : its Concentration and effects last twice as long (24 h at
 *                    most), advantage on its Concentration saves. Transmuted : the damage type chosen. Twinned : one
 *                    more target (effective level +1). Quickened / Subtle : recorded (casting time a Bonus Action /
 *                    no components) on the card's flags.metamagic; Quickened's turn rule follows Rule Limits.
 *                    Gaining a Sorcerer level : one option may be replaced per level (Rest Choices : which one goes,
 *                    which comes, from the Item compendiums : a copy you imported (Plutonium's, in any compendium of
 *                    yours) before dnd5e's own 2024 options).
 *   Font of Magic  : using it opens a window : a spell slot into Sorcery Points (each level you have a slot of, with the
 *                    points it gives, never past the maximum), or Sorcery Points into a new slot (2024 : levels 1-5,
 *                    each from a Sorcerer level : 2 / 3 / 5 / 7 / 9, costing 2 / 3 / 5 / 6 / 7; a full level too). A
 *                    slot made goes on top of that level's count (past its maximum); dnd5e's Long Rest sets every level
 *                    back to its maximum, so the slots made vanish then, as the rule says. Its own activities aren't used.
 */
export class sorcerer{
  static INNATE = "innate-sorcery";
  static FONT = "font-of-magic";
  /* Points into a slot (2024) : level -> Sorcery Points */
  static SLOT_COST = { 1 : 2, 2 : 3, 3 : 5, 4 : 6, 5 : 7 };
  /* The Sorcerer level a slot level can be made from (2024) */
  static SLOT_MIN_LEVEL = { 1 : 2, 2 : 3, 3 : 5, 4 : 7, 5 : 9 };
  /* Where the Sorcery Points are : Plutonium's "Sorcery Points" item, or dnd5e's Font of Magic */
  static POINTS = ["sorcery-points", "font-of-magic"];
  /* 2024 Metamagic options : their cost in Sorcery Points */
  static METAMAGIC = {
    "careful-spell" : 1, "distant-spell" : 1, "empowered-spell" : 1, "extended-spell" : 1, "heightened-spell" : 2,
    "quickened-spell" : 2, "seeking-spell" : 1, "subtle-spell" : 1, "transmuted-spell" : 1, "twinned-spell" : 1,
  };

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.onInnate(activity, results));
    Hooks.on(`${module.id}.selfEffects`, activity => !(this.enabled() && (idOf(activity?.item) === this.INNATE)));
    rollModes.add("innate", config => this.innateMode(config));
    uses.onActivity("metamagic", (activity, ctx, next) => this.metamagicStep(activity, ctx, next));
    /* Metamagic on the cards : Careful / Heightened rows, Empowered / Seeking buttons, Extended, Transmuted */
    foundry.applications.handlebars.loadTemplates({ [`${module.id}.metamagic`] : `${module.path}/templates/metamagic.hbs` });
    Hooks.on(`${module.id}.cardSections`, (message, sections) => this.cardSection(message, sections));
    Hooks.on(`${module.id}.cardFaces`, (message, faces) => this.cardFaces(message, faces));
    Hooks.on(`${module.id}.rowResults`, (message, results) => this.carefulResults(message, results));
    Hooks.on(`${module.id}.saveHint`, (message, actor, ability, { dis }) => this.heightenedHint(message, actor, dis));
    Hooks.on("dnd5e.preRollSavingThrowV2", (config, dialog, message) => this.heightenedSave(config, message));
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => {
      const seeking = this.seekingButton(message, ray ?? null);
      if(seeking) buttons.push(seeking);
      const empowered = !Number.isInteger(ray) && this.empoweredButton(message);
      if(empowered) buttons.push(empowered);
    });
    Hooks.on(`${module.id}.cardButton`, (message, id, { ray, button } = {}) => {
      if(id === "seeking") this.useSeeking(message, ray ?? null);
      else if(id === "empowered") this.useEmpowered(message);
      else if(id === "metamagicRow") this.toggleRow(message, button?.dataset?.target);
    });
    Hooks.on("dnd5e.renderChatMessage", (message, html) => this.saveCardButtons(message, html));
    Hooks.on("preCreateActiveEffect", (effect, data, options, userId) => { if(userId === game.user.id) this.extendEffect(effect); });
    Hooks.on("dnd5e.preRollConcentrationV2", config => this.extendedConcentration(config));
    Hooks.on("dnd5e.preRollDamageV2", config => this.transmute(config));
    /* Innate Sorcery's DC : Sorcerer spells only (dnd5e's bonus is to every spell) */
    patch.wrap("CONFIG.DND5E.activityTypes.save.documentClass.prototype.prepareFinalData", function(wrapped, ...args){
      const result = wrapped(...args);
      try { sorcerer.innateDC(this); } catch(error){ log.debug("Innate Sorcery DC", error); }
      return result;
    });
    restChoices.add({
      id : "metamagic", label : "restChoices.metamagic", rest : "level", classes : ["sorcerer"],
      applies : actor => this.enabled() && (this.optionsOf(actor).length > 0),
      grant : (actor, { levels = 1 } = {}) => actor.setFlag(module.id, "metamagicSwaps", Math.max(1, Number(levels) || 1)),
      summary : actor => module.format("classes.sorcerer.swapSummary", { names : this.optionsOf(actor).map(o => o.item.name).join(", "),
        swaps : Number(actor.getFlag(module.id, "metamagicSwaps")) || 0 }),
      open : actor => this.swapMetamagic(actor),
    });
    uses.onItem("fontOfMagic", (item, ctx, next) => {
      if(!this.enabled() || (idOf(item) !== this.FONT) || !item.actor) return next();
      return this.font(item.actor, item);
    });
    /* Innate Sorcery's minute over : Foundry only marks it expired (it stops counting); the GM removes it */
    Hooks.on("updateActiveEffect", effect => {
      if(game.users.activeGM?.isSelf && effect?.duration?.expired && effect.getFlag?.(module.id, "innateSorcery")) effect.delete().catch(() => {});
    });
  }

  /* A spell cast as a Sorcerer spell (its class link) */
  static isSorcererSpell(item){
    if(item?.type !== "spell") return false;
    const source = String(item.system?.sourceItem ?? "");
    return (source === "class:sorcerer") || (item.system?.classIdentifier === "sorcerer");
  }

  /* ---------- Innate Sorcery ---------- */

  static innateOn(actor){
    /* Not disabled, not past its minute (Foundry marks it expired) */
    return !!actor?.effects?.some?.(e => !e.disabled && !e.duration?.expired && !e.isSuppressed
      && (e.getFlag(module.id, "innateSorcery") || (idOf(fromUuidSync(e.origin ?? "", { strict : false })) === this.INNATE)));
  }

  /* Used : its effect on the Sorcerer (the item's, else +1 spell save DC), for a minute */
  static async onInnate(activity, results){
    const actor = activity?.actor;
    if(!this.enabled() || (idOf(activity?.item) !== this.INNATE) || !actor?.isOwner) return;
    const own = activity.getUsageToken?.()?.actor ?? actor;
    if(this.innateOn(own)) return;
    const source = activity.item.effects?.contents?.[0] ?? [...(activity.item.effects ?? [])][0];
    const data = source?.toObject?.() ?? { name : activity.item.name, img : activity.item.img,
      changes : [{ key : "system.bonuses.spell.dc", type : "add", mode : 2, value : "1" }] };
    delete data._id;
    await own.createEmbeddedDocuments("ActiveEffect", [foundry.utils.mergeObject(data, {
      origin : activity.item.uuid, transfer : false, disabled : false, showIcon : CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2,
      duration : { value : 60, units : "seconds" }, start : { time : game.time.worldTime },
      flags : { [module.id] : { innateSorcery : true } },
    }, { inplace : false })]);
    await actions.autoApplied(results);
    log.debug("Innate Sorcery", own.name);
  }

  /* The spell DC bonus Innate Sorcery's effect gives (its changes to system.bonuses.spell.dc) */
  static innateBonus(actor){
    let bonus = 0;
    for(const e of actor?.effects ?? []){
      if(e.disabled || e.duration?.expired || e.isSuppressed) continue;
      if(!(e.getFlag?.(module.id, "innateSorcery") || (idOf(fromUuidSync(e.origin ?? "", { strict : false })) === this.INNATE))) continue;
      for(const change of [...(e.system?.changes ?? e.changes ?? [])]){
        if(change.key === "system.bonuses.spell.dc") bonus += Number(change.value) || 0;
      }
    }
    return bonus;
  }

  /* A save activity's DC as dnd5e prepares it : a spell that isn't a Sorcerer spell loses Innate Sorcery's bonus */
  static innateDC(activity){
    if(!this.enabled() || (activity?.item?.type !== "spell") || this.isSorcererSpell(activity.item)) return;
    const bonus = this.innateBonus(activity.actor);
    if(!bonus || !Number.isFinite(activity.save?.dc?.value)) return;
    activity.save.dc.value -= bonus;
    if(activity.labels?.save) activity.labels.save = game.i18n.format("DND5E.SaveDC", { dc : activity.save.dc.value, ability : CONFIG.DND5E.abilities[activity.ability]?.label ?? "" });
  }

  /* Its advantage : the Sorcerer's spell attacks with a Sorcerer spell */
  static innateMode(config){
    const activity = config?.subject, actor = activity?.actor;
    const roll = config?.rolls?.[0];
    if(!this.enabled() || !roll || !this.isSorcererSpell(activity?.item) || !this.innateOn(actor)) return;
    giveMode(roll, "advantage", module.i18n("classes.sorcerer.innate"));
  }

  /* ---------- Metamagic ---------- */

  static pointsOf(actor){
    return actor?.items?.find?.(i => this.POINTS.includes(idOf(i)) && i.system?.uses?.max) ?? null;
  }

  static pointsLeft(actor){
    return Number(this.pointsOf(actor)?.system?.uses?.value) || 0;
  }

  /* The options this Sorcerer knows ("metamagic-quickened-spell", "quickened-spell"...) : [{ id, item, cost }] */
  static optionsOf(actor){
    const out = [];
    for(const item of actor?.items ?? []){
      const id = String(idOf(item)).replace(/^metamagic-/, "");
      if(this.METAMAGIC[id]) out.push({ id, item, cost : this.METAMAGIC[id] });
    }
    return out;
  }

  static knows(actor, id){
    return this.optionsOf(actor).find(o => o.id === id) ?? null;
  }

  /* Empowered and Seeking are used after the roll (on the card, alongside another option); the rest when casting */
  static AFTER = ["empowered-spell", "seeking-spell"];
  static TRANSMUTABLE = ["acid", "cold", "fire", "lightning", "poison", "thunder"];

  /* The spell's damage types (all its damage activities) */
  static damageTypes(item){
    const types = new Set();
    for(const a of item?.system?.activities ?? []) for(const part of a.damage?.parts ?? []) for(const t of part.types ?? []) types.add(t);
    return types;
  }

  /* Does a cast-time option fit this spell ? */
  static fits(id, activity){
    const item = activity?.item;
    const save = [...(item?.system?.activities ?? [])].some(a => a.type === "save");
    const range = activity?.range?.override ? activity.range : (item?.system?.range ?? {});
    const duration = item?.system?.duration ?? {};
    switch(id){
      case "careful-spell" :
      case "heightened-spell" : return save;
      case "distant-spell" : return (range.units === "touch") || (Number(range.value) >= 5);
      case "extended-spell" : return !["inst", ""].includes(duration.units ?? "") && (Number(duration.value) > 0 || duration.units === "perm");
      case "quickened-spell" : return (activity?.activation?.type ?? "action") === "action";
      case "transmuted-spell" : return [...this.damageTypes(item)].some(t => this.TRANSMUTABLE.includes(t));
      case "twinned-spell" : return (Number(item?.system?.level) > 0) && !activity?.target?.template?.type && !item?.system?.target?.template?.type;
      default : return true;
    }
  }

  /* 2024 Quickened : not after a level 1+ spell this turn, and no level 1+ spell after it */
  static quickenedRule(actor, activity, chosen){
    const leveled = Number(activity?.item?.system?.level) > 0;
    if(chosen && usedThisTurn(actor, "leveledSpell")) return limits.allow(module.i18n("classes.sorcerer.quickenedAfter"), { who : actor.name, what : activity.item.name });
    if(!chosen && leveled && usedThisTurn(actor, "quickened")) return limits.allow(module.i18n("classes.sorcerer.afterQuickened"), { who : actor.name, what : activity.item.name });
    return true;
  }

  /* Transmuted Spell : which type it becomes */
  static async chooseType(item){
    const from = [...this.damageTypes(item)].filter(t => this.TRANSMUTABLE.includes(t));
    return chooseOption({ title : item.name, icon : "fa-solid fa-shuffle", prompt : module.i18n("classes.sorcerer.transmutePrompt"),
      options : this.TRANSMUTABLE.filter(t => !from.includes(t) || (from.length > 1)).map(t => ({ value : t, label : game.i18n.localize(CONFIG.DND5E.damageTypes[t]?.label ?? t) })) });
  }

  static #transmuted = new Map();

  /* Before a spell is cast (any the Sorcerer has) : which Metamagic (or none), recorded on the use and the card, paid
     once the cast goes through */
  static async metamagicStep(activity, ctx, next){
    const actor = activity?.actor;
    if(!this.enabled() || !actor?.isOwner || (activity?.item?.type !== "spell") || ctx.config?.[module.id]?.metamagic) return this.afterCast(activity, ctx, next, null);
    /* Quickened's turn rule for a spell without Metamagic too */
    const points = this.pointsOf(actor);
    const left = this.pointsLeft(actor);
    const options = this.optionsOf(actor).filter(o => !this.AFTER.includes(o.id) && (o.cost <= left) && this.fits(o.id, activity));
    if(!points || !options.length) return this.afterCast(activity, ctx, next, null);
    const value = await chooseOption({ title : module.format("classes.sorcerer.metamagicTitle", { spell : activity.item.name }), icon : "fa-solid fa-wand-sparkles",
      prompt : module.format("classes.sorcerer.metamagicPrompt", { left }),
      options : [{ value : "none", label : module.i18n("classes.sorcerer.none") },
        ...options.map(o => ({ value : o.id, label : module.format("classes.sorcerer.option", { name : o.item.name, cost : o.cost }) }))] });
    if(!value) return;
    const chosen = options.find(o => o.id === value);
    if(!chosen) return this.afterCast(activity, ctx, next, null);
    if((chosen.id === "quickened-spell") && !this.quickenedRule(actor, activity, true)) return;

    /* What it changes, recorded : on the card (dnd5e's / Roll Item's), and on the use for the rules reading it */
    const record = { id : chosen.id, cost : chosen.cost, name : chosen.item.name, uuid : chosen.item.uuid };
    const mark = { metamagic : chosen.id };
    if(chosen.id === "distant-spell") mark.rangeMultiplier = 2;
    if(chosen.id === "quickened-spell") record.castingTime = "bonus";
    if(chosen.id === "subtle-spell") record.components = [];
    if(chosen.id === "twinned-spell"){ record.effectiveLevel = 1; mark.extraTargets = 1; }
    if(chosen.id === "careful-spell") record.careful = Math.max(1, Number(actor.system.abilities?.cha?.mod) || 0);
    if(chosen.id === "transmuted-spell"){
      const type = await this.chooseType(activity.item);
      if(!type) return;
      record.damageType = type;
      this.#transmuted.set(activity.item.uuid, { type, at : Date.now() });
    }
    uses.mark(ctx, { ...mark, cardFlags : { metamagic : record } });
    uses.flag(ctx, { metamagic : record });
    return this.afterCast(activity, ctx, next, chosen);
  }

  /* The cast itself : paid once it goes through (a closed pick costs nothing), then what lasts after it */
  static async afterCast(activity, ctx, next, chosen){
    const actor = activity?.actor;
    if(!chosen && this.enabled() && actor && (activity?.item?.type === "spell") && this.knows(actor, "quickened-spell") && !this.quickenedRule(actor, activity, false)) return;
    const result = await next();
    if(!result || ((result?.[module.id]?.card) && !(await uses.cardOf(result)))) return result;
    if(this.enabled() && actor && (Number(activity?.item?.system?.level) > 0)) await markUsedThisTurn(actor, "leveledSpell");
    if(!chosen) return result;
    const points = this.pointsOf(actor);
    await points.update({ "system.uses.spent" : (Number(points.system.uses.spent) || 0) + chosen.cost });
    if(chosen.id === "quickened-spell") await markUsedThisTurn(actor, "quickened");
    if(chosen.id === "extended-spell") await this.extend(actor, activity.item);
    log.debug("Metamagic", actor.name, chosen.id, activity.item.name);
    return result;
  }

  /* ---------- Extended Spell ---------- */

  /* Its Concentration lasts twice as long (24 hours at most) and has advantage on its saves; its effects too */
  static async extend(actor, item){
    const concentration = actor.effects.find(e => e.statuses?.has?.(CONFIG.specialStatusEffects.CONCENTRATING) && (e.getFlag("dnd5e", "item")?.id === item.id));
    if(concentration) await concentration.update({ "duration.value" : this.doubled(concentration.duration), [`flags.${module.id}.extended`] : true });
    await actor.setFlag(module.id, `extended.${item.id}`, { at : game.time.worldTime, concentration : concentration?.uuid ?? null });
  }

  /* Twice a duration, as dnd5e stores it (value in its units), capped at 24 hours */
  static doubled(duration){
    const value = (Number(duration?.value) || 0) * 2;
    const toSeconds = { seconds : 1, minutes : 60, hours : 3600, days : 86400, rounds : 6, turns : 6 }[duration?.units] ?? 1;
    return Math.min(value, Math.floor(86400 / toSeconds));
  }

  /* An effect from an Extended spell landing on a creature : twice as long (while its Concentration lasts) */
  static extendEffect(effect){
    if(!this.enabled() || !(effect.parent?.documentName === "Actor") || effect.getFlag?.(module.id, "extended")) return;
    const origin = effect.origin ? fromUuidSync(effect.origin, { strict : false }) : null;
    const item = (origin?.documentName === "Item") ? origin : (origin?.item ?? null);
    const mark = item?.actor?.getFlag?.(module.id, `extended.${item.id}`);
    if(!mark || (effect.parent === item.actor)) return;
    if(mark.concentration && !fromUuidSync(mark.concentration, { strict : false })) return;
    if(!(Number(effect.duration?.value) > 0)) return;
    effect.updateSource({ "duration.value" : this.doubled(effect.duration), [`flags.${module.id}.extended`] : true });
  }

  /* Concentration saves for an Extended spell : advantage */
  static extendedConcentration(config){
    const actor = config?.subject;
    if(!this.enabled() || !actor?.effects?.some?.(e => e.statuses?.has?.(CONFIG.specialStatusEffects.CONCENTRATING) && e.getFlag(module.id, "extended"))) return;
    config.advantage = true;
    for(const roll of config.rolls ?? []) if(roll?.options) giveMode(roll, "advantage", module.i18n("classes.sorcerer.extended"));
  }

  /* ---------- Transmuted Spell ---------- */

  /* Its damage (cast now, or rolled again from its card within the minute) : the chosen type instead */
  static transmute(config){
    const item = config?.subject?.item;
    const chosen = item ? this.#transmuted.get(item.uuid) : null;
    if(!this.enabled() || !chosen || ((Date.now() - chosen.at) > 60000)) return;
    for(const roll of config.rolls ?? []){
      const options = roll.options ?? (roll.options = {});
      if(this.TRANSMUTABLE.includes(options.type)) options.type = chosen.type;
      if(Array.isArray(options.types)) options.types = options.types.map(t => this.TRANSMUTABLE.includes(t) ? chosen.type : t);
    }
  }

  /* ---------- Careful Spell, Heightened Spell : the save card's rows ---------- */

  static metamagicOf(card){
    return card?.getFlag?.(module.id, "metamagic") ?? null;
  }

  /* On the card, under the spell's description : the option chosen when casting, then Empowered / Seeking once used,
     each laid out like the spell (its header : name, cost, the damage type Transmuted chose; its description) */
  static cardFaces(card, faces){
    const actor = card?.getAssociatedActor?.();
    const used = [];
    const record = this.metamagicOf(card);
    if(record?.id) used.push(record);
    if(card?.getFlag?.(module.id, "empowered")) used.push({ id : "empowered-spell" });
    if(Object.values(card?.getFlag?.(module.id, "seeking") ?? {}).some(Boolean)) used.push({ id : "seeking-spell" });
    for(const entry of used){
      const option = actor ? this.knows(actor, entry.id) : null;
      const cost = entry.cost ?? option?.cost ?? this.METAMAGIC[entry.id];
      const type = entry.damageType ? game.i18n.localize(CONFIG.DND5E.damageTypes[entry.damageType]?.label ?? entry.damageType) : null;
      faces.push({
        uuid : entry.uuid ?? option?.item?.uuid ?? null,
        name : entry.name ?? option?.item?.name ?? undefined,
        img : option?.item?.img ?? undefined,
        subtitle : module.format(type ? "classes.sorcerer.faceType" : "classes.sorcerer.face", { cost, type }),
      });
    }
  }

  /* The section on a save card : a toggle per target that hasn't rolled, for the caster's owner */
  static cardSection(card, sections){
    const record = this.metamagicOf(card);
    if(!this.enabled() || !card?.isOwner || !["careful-spell", "heightened-spell"].includes(record?.id)) return;
    const careful = card.getFlag(module.id, "careful") ?? {};
    const heightened = card.getFlag(module.id, "heightened") ?? null;
    const outcomes = card.system?.outcomes ?? new Map();
    const limit = (record.id === "careful-spell") ? (record.careful ?? 1) : 1;
    const chosen = (record.id === "careful-spell") ? Object.keys(careful).filter(k => careful[k]).length : (heightened ? 1 : 0);
    const rows = (card.system?.targets ?? []).map(t => {
      const key = t.token.replaceAll(".", "-");
      const on = (record.id === "careful-spell") ? !!careful[key] : (heightened === t.token);
      const rolled = outcomes.has?.(t.token) && !on;
      return { uuid : t.token, name : t.name, on, disabled : rolled || (!on && (chosen >= limit)) };
    });
    if(!rows.length) return;
    sections.push({ partial : `${module.id}.metamagic`, context : { rows, label : record.name, icon : (record.id === "careful-spell") ? "fa-shield-heart" : "fa-arrow-trend-up",
      hint : module.format((record.id === "careful-spell") ? "classes.sorcerer.carefulHint" : "classes.sorcerer.heightenedHint", { n : limit }) } });
  }

  static async toggleRow(card, uuid){
    const record = this.metamagicOf(card);
    if(!card?.isOwner || !uuid) return;
    const key = uuid.replaceAll(".", "-");
    if(record?.id === "careful-spell"){
      const careful = card.getFlag(module.id, "careful") ?? {};
      return card.setFlag(module.id, `careful.${key}`, !careful[key]);
    }
    if(record?.id === "heightened-spell") return card.setFlag(module.id, "heightened", (card.getFlag(module.id, "heightened") === uuid) ? null : uuid);
  }

  /* Careful : the chosen creatures succeed without rolling, and take no damage where a success would take half */
  static carefulResults(card, results){
    const careful = card?.getFlag?.(module.id, "careful");
    if(!careful || (this.metamagicOf(card)?.id !== "careful-spell")) return;
    const onSave = card.system?.rider?.onSave ?? card.getAssociatedActivity?.()?.damage?.onSave;
    for(const [key, on] of Object.entries(careful)){
      if(on) results.set(key.replaceAll("-", "."), { total : null, success : true, auto : this.metamagicOf(card).name, noDamage : onSave === "half" });
    }
  }

  /* Heightened : the chosen creature's first save from the card has disadvantage */
  static heightenedSave(config, message){
    const card = game.messages.get(message?.data?.system?.origin?.id ?? message?.data?.system?.origin);
    const uuid = card?.getFlag?.(module.id, "heightened");
    if(!this.enabled() || !uuid || (this.metamagicOf(card)?.id !== "heightened-spell")) return;
    const token = message?.data?.speaker?.token;
    if(!token || !uuid.endsWith(`Token.${token}`)) return;
    const already = game.messages.contents.some(m => (m.type === "save") && ((m.system?.origin?.id ?? m.system?.origin) === card.id) && (m.speaker?.token === token));
    if(already) return;
    config.disadvantage = true;
    for(const roll of config.rolls ?? []) if(roll?.options) giveMode(roll, "disadvantage", this.metamagicOf(card).name);
  }

  /* The save button's hint names it */
  static heightenedHint(card, actor, dis){
    const uuid = card?.getFlag?.(module.id, "heightened");
    if(uuid && (this.metamagicOf(card)?.id === "heightened-spell") && (fromUuidSync(uuid, { strict : false })?.actor === actor)) dis.push(this.metamagicOf(card).name);
  }

  /* ---------- Empowered Spell, Seeking Spell : buttons on the card after the roll ---------- */

  static spellCaster(card){
    const item = card?.getAssociatedItem?.();
    return (item?.type === "spell") ? card.getAssociatedActor?.() : null;
  }

  /* Empowered : reroll the lowest CHA-modifier (at least 1) damage dice, once per card */
  static empoweredButton(card){
    const actor = this.spellCaster(card);
    const option = actor && this.knows(actor, "empowered-spell");
    if(!this.enabled() || !option || !actor.isOwner || card.getFlag(module.id, "empowered") || (this.pointsLeft(actor) < option.cost)) return null;
    if(!(card.system?.damageRolls?.length)) return null;
    const n = Math.max(1, Number(actor.system.abilities?.cha?.mod) || 0);
    return { id : "empowered", label : module.format("classes.sorcerer.empowered", { name : option.item.name, n, cost : option.cost }), icon : "fa-burst", n, option };
  }

  /* Seeking : a missed spell attack's d20 rolled again (the new roll kept), once per attack */
  static seekingButton(card, ray){
    const actor = this.spellCaster(card);
    const option = actor && this.knows(actor, "seeking-spell");
    if(!this.enabled() || !option || !actor.isOwner || !card.system?.isHitOn || card.system.isHitOn(ray)) return null;
    if(card.getFlag(module.id, `seeking.${Number.isInteger(ray) ? ray : "single"}`) || (this.pointsLeft(actor) < option.cost)) return null;
    return { id : "seeking", label : module.format("classes.sorcerer.seeking", { name : option.item.name, cost : option.cost }), icon : "fa-crosshairs", option };
  }

  static async payFor(actor, option){
    const points = this.pointsOf(actor);
    if(!points || (this.pointsLeft(actor) < option.cost)) return false;
    await points.update({ "system.uses.spent" : (Number(points.system.uses.spent) || 0) + option.cost });
    return true;
  }

  static async useEmpowered(card){
    const button = this.empoweredButton(card);
    if(!button || !(await this.payFor(this.spellCaster(card), button.option))) return;
    await card.setFlag(module.id, "empowered", true);
    await card.system.rerollLowestDamage(button.n);
  }

  static async useSeeking(card, ray){
    const button = this.seekingButton(card, ray);
    if(!button || !(await this.payFor(this.spellCaster(card), button.option))) return;
    await card.setFlag(module.id, `seeking.${Number.isInteger(ray) ? ray : "single"}`, true);
    await card.system.rerollAttackRoll(ray);
  }

  /* Save cards (no card buttons there) : Empowered's button in a row of its own */
  static saveCardButtons(card, html){
    if(card?.type !== `${module.id}.save`) return;
    const button = this.empoweredButton(card);
    if(!button) return;
    const row = buttonRow(html, { key : `${module.id}-metamagic` });
    if(row.childElementCount) return;
    addButton(row, makeButton({ icon : button.icon, text : button.label, once : true, onClick : () => this.useEmpowered(card) }));
  }

  /* ---------- Metamagic : replacing an option on gaining a level ---------- */

  /* Every 2024 Metamagic option the compendiums have, one per option : a copy of yours first (not dnd5e's own), else
     dnd5e's 2024 one; 2014 copies (dnd5e's legacy class features) are left out */
  static async metamagicPool(){
    const found = new Map();
    const packs = [...game.packs].filter(p => p.documentName === "Item")
      .sort((a, b) => Number(a.metadata.packageName === "dnd5e") - Number(b.metadata.packageName === "dnd5e"));
    for(const pack of packs){
      let index;
      /* system.source whole : the server's index can't take source.rules where an item's source is a number */
      try { index = await pack.getIndex({ fields : ["system.identifier", "system.source"] }); } catch { continue; }
      for(const entry of index){
        if(String(entry.system?.source?.rules ?? "") === "2014") continue;
        const id = String(entry.system?.identifier ?? "").replace(/^metamagic-/, "");
        if(this.METAMAGIC[id] && !found.has(id)) found.set(id, { id, uuid : entry.uuid, name : entry.name, img : entry.img });
      }
    }
    return found;
  }

  /**
   * Replace a Metamagic option : one swap per Sorcerer level gained (the GM : freely; past that, Rule Limits Off / Warn
   * ask and tell the GM). Which one goes, then which comes; the new one takes the old one's place under the class.
   */
  static async swapMetamagic(actor){
    const known = this.optionsOf(actor);
    if(!known.length) return;
    const swaps = game.user.isGM ? Infinity : (Number(actor.getFlag(module.id, "metamagicSwaps")) || 0);
    let past = false;
    if(!(swaps > 0)){
      if(!limits.canGoPast()) return ui.notifications.warn(module.format("classes.sorcerer.noSwap", { name : actor.name }));
      past = await foundry.applications.api.DialogV2.confirm({ window : { title : module.i18n("restChoices.metamagic") },
        content : `<p>${esc(module.format("classes.sorcerer.pastPrompt", { name : actor.name }))}</p>`, rejectClose : false });
      if(!past) return;
    }
    /* Reading every Item compendium the first time takes a few seconds */
    const notice = ui.notifications.info(module.i18n("classes.sorcerer.looking"), { progress : true });
    const pool = await this.metamagicPool().finally(() => notice?.update?.({ pct : 1 }));
    const others = [...pool.values()].filter(o => !known.some(k => k.id === o.id));
    if(!pool.size) return ui.notifications.warn(module.i18n("classes.sorcerer.noOptions"));
    if(!others.length) return ui.notifications.warn(module.format("classes.sorcerer.allOptions", { name : actor.name }));
    const out = await chooseOne(known.map(o => ({ value : o.item.id, label : o.item.name, img : o.item.img })), {
      title : module.format("classes.sorcerer.swapTitle", { name : actor.name }), icon : "fa-solid fa-wand-sparkles", columns : 2,
      prompt : module.i18n("classes.sorcerer.swapOut") });
    const current = out ? actor.items.get(out) : null;
    if(!current) return;
    const chosen = await chooseOne(others.map(o => ({ value : o.uuid, label : o.name, img : o.img })), {
      title : module.format("classes.sorcerer.swapTitle", { name : actor.name }), icon : "fa-solid fa-wand-sparkles", columns : 2,
      prompt : module.format("classes.sorcerer.swapIn", { name : current.name }) });
    const source = chosen ? await fromUuid(chosen) : null;
    if(!source) return;
    const data = source.toObject();
    /* In the old one's place : its id (the class's advancement still points to it) and its class link */
    const origin = current.getFlag("dnd5e", "advancementOrigin");
    if(origin) foundry.utils.setProperty(data, "flags.dnd5e.advancementOrigin", origin);
    data._id = current.id;
    await current.delete();
    await actor.createEmbeddedDocuments("Item", [data], { keepId : true });
    if(Number.isFinite(swaps)) await actor.setFlag(module.id, "metamagicSwaps", Math.max(0, swaps - 1));
    if(past) await limits.tellGM({ who : actor.name, what : module.format("classes.sorcerer.swapped", { from : current.name, to : source.name }), rule : module.i18n("classes.sorcerer.swapRule") });
    log.debug("Metamagic swap", actor.name, current.name, "->", source.name);
  }

  /* ---------- Font of Magic ---------- */

  /* Spell slots : [{ level, value, max }] for levels 1-9 that exist */
  static slots(actor){
    const out = [];
    for(let level = 1; level <= 9; level++){
      const slot = actor?.system?.spells?.[`spell${level}`];
      if(Number(slot?.max) > 0) out.push({ level, value : Number(slot.value) || 0, max : Number(slot.max) });
    }
    return out;
  }

  /**
   * The window : a slot into points (levels with a slot left, the points it gives) or points into a slot (levels 1-5
   * not full, what it costs). One conversion a use.
   */
  static async font(actor, item){
    const points = this.pointsOf(actor);
    if(!points) return ui.notifications.warn(module.format("classes.sorcerer.noPoints", { name : actor.name }));
    const left = Number(points.system.uses.value) || 0;
    const max = Number(points.system.uses.max) || 0;
    const slots = this.slots(actor);
    const sorcererLevel = Number(actor.classes?.sorcerer?.system?.levels) || 0;
    const toPoints = slots.filter(s => s.value > 0).map(s => ({ level : s.level, gain : Math.min(s.level, max - left) }));
    /* A new slot : any level 1-5 you have slots of (dnd5e casts only from those), from its Sorcerer level */
    const toSlot = slots.filter(s => s.level <= 5).map(s => ({ level : s.level, cost : this.SLOT_COST[s.level],
      locked : sorcererLevel < this.SLOT_MIN_LEVEL[s.level], made : Math.max(0, s.value - s.max) }));
    const made = toSlot.reduce((n, t) => n + t.made, 0);
    const button = (action, label, sub, disabled) => `<button type="button" data-convert="${action}"${disabled ? " disabled" : ""}><strong>${esc(label)}</strong><br><span class="hint">${esc(sub)}</span></button>`;
    const rowA = toPoints.map(t => button(`points|${t.level}`, module.format("classes.sorcerer.slotLevel", { level : t.level }),
      module.format("classes.sorcerer.gain", { n : t.gain }), t.gain <= 0)).join("") || `<p class="hint">${esc(module.i18n("classes.sorcerer.noSlots"))}</p>`;
    const rowB = toSlot.map(t => button(`slot|${t.level}`, module.format("classes.sorcerer.slotLevel", { level : t.level }),
      t.locked ? module.format("classes.sorcerer.fromLevel", { n : this.SLOT_MIN_LEVEL[t.level] }) : module.format("classes.sorcerer.cost", { n : t.cost }),
      t.locked || (t.cost > left))).join("") || `<p class="hint">${esc(module.i18n("classes.sorcerer.noSlotLevels"))}</p>`;
    let picked = null;
    await foundry.applications.api.DialogV2.wait({
      window : { title : item.name, icon : "fa-solid fa-wand-magic-sparkles" },
      content : `<p>${esc(module.format("classes.sorcerer.fontPoints", { left, max }))}</p>
        <h4>${esc(module.i18n("classes.sorcerer.toPoints"))}</h4><div class="${module.id}-font-row">${rowA}</div>
        <h4>${esc(module.i18n("classes.sorcerer.toSlot"))}</h4><div class="${module.id}-font-row">${rowB}</div>
        <p class="hint">${esc(module.format(made ? "classes.sorcerer.madeSlots" : "classes.sorcerer.madeHint", { n : made }))}</p>`,
      buttons : [{ action : "cancel", label : module.i18n("restChoices.done"), icon : "fa-solid fa-xmark" }],
      render : (event, dialog) => {
        dialog.element.querySelectorAll("button[data-convert]").forEach(b => b.addEventListener("click", () => {
          picked = b.dataset.convert;
          dialog.close();
        }));
      },
      rejectClose : false,
    }).catch(() => null);
    const choice = (typeof picked === "string" && picked.includes("|")) ? picked : null;
    if(!choice) return null;
    const [kind, lvl] = choice.split("|");
    const level = Number(lvl);
    const key = `system.spells.spell${level}.value`;
    const slot = actor.system.spells[`spell${level}`];
    if(kind === "points"){
      const gain = Math.min(level, max - (Number(points.system.uses.value) || 0));
      if(!(gain > 0) || !(Number(slot?.value) > 0)) return null;
      await actor.update({ [key] : Number(slot.value) - 1 });
      await points.update({ "system.uses.spent" : Math.max(0, (Number(points.system.uses.spent) || 0) - gain) });
      ui.notifications.info(module.format("classes.sorcerer.gained", { name : actor.name, n : gain, level }));
    }
    else {
      const cost = this.SLOT_COST[level];
      const sorcerer = Number(actor.classes?.sorcerer?.system?.levels) || 0;
      if(!cost || ((Number(points.system.uses.value) || 0) < cost) || !(Number(slot?.max) > 0) || (sorcerer < this.SLOT_MIN_LEVEL[level])) return null;
      await points.update({ "system.uses.spent" : (Number(points.system.uses.spent) || 0) + cost });
      await actor.update({ [key] : Number(slot.value) + 1 });
      ui.notifications.info(module.format("classes.sorcerer.created", { name : actor.name, n : cost, level }));
    }
    log.debug("Font of Magic", actor.name, choice);
    return true;
  }
}
