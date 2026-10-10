import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { idOf } from '../helpers/utils.js';
import { tokenOf, getRange, distanceBetween } from '../helpers/tokens.js';
import { limits } from './limits.js';
import { conditions } from './conditions.js';
import { actions } from './actions.js';
import { itemFixes } from './item-fixes.js';
import { chooseOption } from '../helpers/utils.js';
import { TYPES } from '../roll-item/message.js';
const log = logger.for(import.meta.url);

/**
 * Spells (Characters → Spells setting) : what spells need beyond their data, by identifier, whoever made the item.
 *
 *   Blade Ward      : cast, its effect goes on the caster (ending with the Concentration); attack rolls against a
 *                     warded creature subtract 1d4. Its "Attack Penalty" die is the attacker's : no card rolls it.
 *                     The effect is added to the item when it's missing (Plutonium's has none).
 *   Ray of Sickness : Poisoned on a hit, until the end of the caster's next turn (an effect added to the item when
 *                     it's missing; the attack card's effect tray applies it).
 *   Chill Touch     : its effect (Plutonium's "Blocked Healing", a description only) is tagged noHealing; a creature with a
 *                     noHealing effect can't regain Hit Points (healing applied to it is stopped, with a notice;
 *                     temporary HP aren't regaining). Any effect with flags["macro-helper"].noHealing does the same.
 *                     Both last until the END of the caster's next turn : 1 round, expiring at a turn's end (Foundry
 *                     counts that from the turn it began in, the caster's; Plutonium's Chill Touch ends at its start).
 *   Giant Insect    : the Centipede's Venomous Spew is a utility with Self range in Plutonium's data; it becomes the
 *                     CON save its text gives (one creature within 10 ft, Poisoned on a failure), and the spell's summon
 *                     matches saves, so the DC is the caster's spell save DC.
 *   Mind Sliver     : its effect (Plutonium's "Slivered", -1d4 to saves) lasts until the end of the caster's next turn and
 *                     ends once the creature has made a saving throw (it subtracts from the next one only). Any effect
 *                     flagged flags["macro-helper"].nextSave does the same.
 *   Armor of Agathys: cast, the caster is marked (an effect : the Cold damage, 5 a slot level) for its hour, until its
 *                     Temporary Hit Points are gone. A melee attack card that hits a marked creature (with Temporary HP
 *                     left as it's made) gets the GM's button : that damage to the attacker.
 *   Rituals         : a spell with the Ritual tag you have prepared : cast normally (a slot, a higher level allowed) or
 *                     as a Ritual (10 minutes longer, no slot, its own level). A Wizard with Ritual Adept casts the
 *                     rituals in its spellbook (its Wizard spells) without preparing them : as a Ritual only. The card
 *                     notes it (flags.ritual for the action tracker).
 *   Range           : Rule Limits on and no target pick (Pick Targets off, or Roll Item off) : a spell aimed at
 *                     creatures out of its range (Distant Spell's doubled range, Touch 30 ft) follows Rule Limits.
 */
export class spells{
  static BLADE_WARD = "blade-ward";
  static RAY_OF_SICKNESS = "ray-of-sickness";
  /* The effects the fixes add (16-character ids, so a fix can tell it's done) */
  static EFFECT_IDS = { "blade-ward" : "mhBladeWardWard1", "ray-of-sickness" : "mhRaySicknessPsn" };

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("spellRules");
  }

  /* Fixes are for 2024 items (a 2014 copy of the spell or creature is left as it is) */
  static is2014(item){
    return String(item?.system?.source?.rules ?? item?.parent?.system?.source?.rules ?? "") === "2014";
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    itemFixes.add({ name : "Blade Ward", where : "owned", plan : item => this.bladeWardFix(item) });
    itemFixes.add({ name : "Ray of Sickness", where : "owned", plan : item => this.rayFix(item) });
    itemFixes.add({ name : "Venomous Spew", where : "owned", plan : item => this.spewFix(item) });
    itemFixes.add({ name : "Chill Touch", where : "owned", plan : item => this.chillTouchFix(item) });
    itemFixes.add({ name : "Mind Sliver", where : "owned", plan : item => this.mindSliverFix(item) });
    Hooks.on("dnd5e.rollSavingThrow", (rolls, data) => this.nextSaveUsed(data?.subject ?? rolls?.[0]?.data?.actor ?? null));
    Hooks.on("dnd5e.preApplyDamage", (actor, amount) => this.blockHealing(actor, amount));
    itemFixes.add({ name : "Giant Insect", where : "owned", plan : item => this.giantInsectFix(item) });
    /* Blade Ward's die is the attacker's : Roll Item doesn't roll it on a card */
    Hooks.on(`${module.id}.preRollItem`, activity => !(this.enabled() && (idOf(activity?.item) === this.BLADE_WARD)));
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.onCast(activity, results));
    Hooks.on(`${module.id}.selfEffects`, activity => !(this.enabled() && (idOf(activity?.item) === this.BLADE_WARD)));
    Hooks.on("dnd5e.preRollAttackV2", config => this.bladeWardPenalty(config));
    uses.onActivity("spellRange", (activity, ctx, next) => this.rangeStep(activity, ctx, next));
    uses.onActivity("ritual", (activity, ctx, next) => this.ritualStep(activity, ctx, next));
    Hooks.on("dnd5e.postUseActivity", (activity, usage) => this.agathysCast(activity, usage));
    Hooks.on("updateActor", (actor, changes) => this.agathysGone(actor, changes));
    Hooks.on("createChatMessage", (message, options, userId) => { if(userId === game.user.id) this.agathysCard(message); });
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => this.agathysButtons(message, buttons, ray));
    Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => { if(String(id).startsWith("agathys|")) this.agathysHit(message, id.split("|")[1], ray ?? null); });
  }

  /* ---------- Armor of Agathys ---------- */

  static AGATHYS = "armor-of-agathys";

  /* Cast : the caster marked with its Cold damage (5 a slot level), for an hour */
  static async agathysCast(activity, usage){
    if(!this.enabled() || (idOf(activity?.item) !== this.AGATHYS) || this.is2014(activity.item) || !activity.actor?.isOwner) return;
    /* Its Frost Damage activity (the damage itself) isn't a casting */
    if(activity.type === "damage") return;
    const actor = activity.getUsageToken?.()?.actor ?? activity.actor;
    const level = (Number(activity.item.system.level) || 1) + (Number(usage?.scaling) || 0);
    const slot = String(usage?.spell?.slot ?? "");
    const castLevel = (slot === "pact") ? (Number(actor.system.spells?.pact?.level) || level) : (Number(slot.replace("spell", "")) || level);
    for(const old of actor.effects.filter(e => e.getFlag(module.id, "agathys"))) await old.delete();
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name : activity.item.name, img : activity.item.img, origin : activity.item.uuid, transfer : false,
      description : module.format("spells.agathys.effect", { damage : 5 * castLevel }),
      duration : { value : 3600, units : "seconds" }, start : { time : game.time.worldTime },
      flags : { [module.id] : { agathys : { damage : 5 * castLevel } } },
    }]);
  }

  /* Its Temporary Hit Points gone : so is the armor */
  static async agathysGone(actor, changes){
    if(!foundry.utils.hasProperty(changes ?? {}, "system.attributes.hp.temp") || (Number(actor.system.attributes.hp.temp) > 0)) return;
    if(!game.users.activeGM?.isSelf) return;
    for(const e of actor.effects.filter(x => x.getFlag(module.id, "agathys"))) await e.delete().catch(() => {});
  }

  static agathysOf(actor){
    const effect = actor?.effects?.find?.(e => !e.disabled && e.getFlag(module.id, "agathys"));
    return (effect && (Number(actor.system?.attributes?.hp?.temp) > 0)) ? Number(effect.getFlag(module.id, "agathys").damage) || 5 : 0;
  }

  /* A melee attack card : which targets have the armor up as it's made (their Temporary HP may be gone once it lands) */
  static async agathysCard(message){
    if(!this.enabled() || (message.type !== TYPES.attack)) return;
    const activity = message.getAssociatedActivity?.();
    if(activity?.attack?.type?.value !== "melee") return;
    if(message.rolls?.[0]?.options?.attackMode === "thrown") return;
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    const armored = {};
    for(const t of message.system.targets ?? []){
      const token = TargetsField.resolve(t)?.token;
      const damage = this.agathysOf(token?.actor);
      if(damage) armored[token.document?.id ?? token.id] = { damage, name : token.name };
    }
    if(Object.keys(armored).length) await message.setFlag(module.id, "agathys", armored);
  }

  /* The GM's button : on each hit on an armored target */
  static agathysButtons(message, buttons, ray){
    const armored = message.getFlag?.(module.id, "agathys");
    if(!armored || !game.user.isGM) return;
    for(const token of message.system.hitTargets?.(Number.isInteger(ray) ? ray : null) ?? []){
      const id = token.document?.id ?? token.id;
      const entry = armored[id];
      if(!entry || entry.done) continue;
      buttons.push({ id : `agathys|${id}`, icon : "fa-snowflake", label : module.format("spells.agathys.button", { damage : entry.damage, name : message.getAssociatedActor?.()?.name ?? "" }) });
    }
  }

  static async agathysHit(message, id, ray){
    const entry = message.getFlag(module.id, `agathys.${id}`);
    const attacker = message.getAssociatedToken?.()?.actor ?? message.getAssociatedActor?.();
    if(!game.user.isGM || !entry || entry.done || !attacker) return;
    await attacker.applyDamage([{ value : entry.damage, type : "cold" }], { isDelta : true });
    await message.setFlag(module.id, `agathys.${id}.done`, true);
    ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor : attacker }),
      content : `<p>${foundry.utils.escapeHTML(module.format("spells.agathys.dealt", { name : attacker.name, damage : entry.damage, from : entry.name }))}</p>` });
  }

  /* ---------- Blade Ward ---------- */

  static bladeWardFix(item){
    if(!this.enabled() || this.is2014(item) || (item?.type !== "spell") || (idOf(item) !== this.BLADE_WARD)) return null;
    const _id = this.EFFECT_IDS[this.BLADE_WARD];
    if(item.effects?.has?.(_id)) return null;
    return { create : { effects : [{ _id, name : item.name, img : item.img, transfer : false,
      description : module.i18n("spells.bladeWard.effect"), duration : { value : 1, units : "minutes" },
      flags : { [module.id] : { bladeWard : true } } }] } };
  }

  /* Cast : the ward on the caster (its own token's actor), tied to its Concentration */
  static async onCast(activity, results){
    if(!this.enabled() || (idOf(activity?.item) !== this.BLADE_WARD) || !activity.actor?.isOwner) return;
    const actor = activity.getUsageToken?.()?.actor ?? activity.actor;
    const item = actor.items.get(activity.item.id) ?? activity.item;
    const source = item.effects?.get?.(this.EFFECT_IDS[this.BLADE_WARD]);
    for(const old of actor.effects.filter(e => e.getFlag(module.id, "bladeWard"))) await old.delete();
    const concentration = actor.effects.find(e => e.statuses?.has?.(CONFIG.specialStatusEffects.CONCENTRATING) && (e.getFlag("dnd5e", "item")?.id === item.id));
    const data = foundry.utils.mergeObject(source?.toObject?.() ?? { name : item.name, img : item.img, flags : { [module.id] : { bladeWard : true } } }, {
      origin : item.uuid, transfer : false, disabled : false, showIcon : CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2,
      start : { time : game.time.worldTime }, duration : { value : 1, units : "minutes" },
      flags : { [module.id] : { bladeWard : true }, ...(concentration ? { dnd5e : { dependentOn : concentration.uuid } } : {}) },
    }, { inplace : false });
    delete data._id;
    await actor.createEmbeddedDocuments("ActiveEffect", [data]);
    await actions.autoApplied(results);
    log.debug("Blade Ward", actor.name);
  }

  /* An attack against a warded creature : 1d4 off the roll */
  static bladeWardPenalty(config){
    if(!this.enabled()) return;
    const target = conditions.targetOf(config);
    const roll = config?.rolls?.[0];
    if(!roll || !target?.actor?.effects?.some?.(e => !e.disabled && e.getFlag(module.id, "bladeWard"))) return;
    roll.parts ??= [];
    roll.parts.push("-1d4");
    log.debug("Blade Ward : -1d4", target.name);
  }

  /* ---------- Ray of Sickness ---------- */

  static rayFix(item){
    if(!this.enabled() || this.is2014(item) || (item?.type !== "spell") || (idOf(item) !== this.RAY_OF_SICKNESS)) return null;
    const _id = this.EFFECT_IDS[this.RAY_OF_SICKNESS];
    if(item.effects?.has?.(_id)) return this.untilTurnEnd(item, [item.effects.get(_id)]);
    const attack = [...(item.system?.activities ?? [])].find(a => a.type === "attack");
    const status = CONFIG.statusEffects.find(e => e.id === "poisoned");
    const links = (item._source?.system?.activities?.[attack?.id]?.effects ?? []).filter(e => e?._id !== _id);
    return {
      create : { effects : [{ _id, name : game.i18n.localize(status?.name ?? "Poisoned"), img : status?.img, statuses : ["poisoned"], transfer : false,
        description : module.i18n("spells.rayOfSickness.effect"), duration : { value : 1, units : "rounds", expiry : "turnEnd" } }] },
      ...(attack ? { update : { [`system.activities.${attack.id}.effects`] : [...links, { _id }] } } : {}),
    };
  }

  /* ---------- Chill Touch : can't regain Hit Points ---------- */

  static CHILL_TOUCH = "chill-touch";

  /* Its effect tagged noHealing (the tag goes with it when it's applied to a creature) */
  static chillTouchFix(item){
    if(!this.enabled() || this.is2014(item) || (item?.type !== "spell") || (idOf(item) !== this.CHILL_TOUCH)) return null;
    const effects = item.effects?.contents ?? [...(item.effects ?? [])];
    const updateEffects = [
      ...effects.filter(e => !e.getFlag?.(module.id, "noHealing")).map(e => ({ _id : e.id, [`flags.${module.id}.noHealing`] : true })),
      ...(this.untilTurnEnd(item, effects)?.updateEffects ?? []),
    ];
    return updateEffects.length ? { updateEffects } : null;
  }

  /* ---------- Mind Sliver : the next save only ---------- */

  static MIND_SLIVER = "mind-sliver";

  static mindSliverFix(item){
    if(!this.enabled() || this.is2014(item) || (item?.type !== "spell") || (idOf(item) !== this.MIND_SLIVER)) return null;
    const effects = item.effects?.contents ?? [...(item.effects ?? [])];
    const updateEffects = [
      ...effects.filter(e => !e.getFlag?.(module.id, "nextSave")).map(e => ({ _id : e.id, [`flags.${module.id}.nextSave`] : true })),
      ...(this.untilTurnEnd(item, effects)?.updateEffects ?? []),
    ];
    return updateEffects.length ? { updateEffects } : null;
  }

  /* A saving throw made : effects that only count for the next one end (the roller's client, when it owns the creature) */
  static async nextSaveUsed(actor){
    if(!this.enabled() || !actor?.isOwner || (actor.documentName !== "Actor")) return;
    const used = actor.effects.filter(e => !e.disabled && e.getFlag(module.id, "nextSave"));
    if(used.length) await actor.deleteEmbeddedDocuments("ActiveEffect", used.map(e => e.id)).catch(error => log.debug(error));
  }

  /* "Until the end of your next turn" : 1 round, expiring at a turn's end (Foundry counts it from the turn the effect
     began in : the caster's, as it's cast) */
  static untilTurnEnd(item, effects){
    const updateEffects = effects.filter(e => e && ((e.duration?.expiry ?? e._source?.duration?.expiry) !== "turnEnd"))
      .map(e => ({ _id : e.id, "duration.value" : 1, "duration.units" : "rounds", "duration.expiry" : "turnEnd" }));
    return updateEffects.length ? { updateEffects } : null;
  }

  /* The effect stopping a creature's healing, if any (tagged, or from Chill Touch) */
  static healingBlockOf(actor){
    return actor?.effects?.find?.(e => !e.disabled && !e.isSuppressed && !e.duration?.expired
      && (e.getFlag?.(module.id, "noHealing") || (idOf(fromUuidSync(e.origin ?? "", { strict : false })?.item ?? fromUuidSync(e.origin ?? "", { strict : false })) === this.CHILL_TOUCH))) ?? null;
  }

  /* Healing applied (a negative amount) to a creature that can't regain Hit Points : stopped */
  static blockHealing(actor, amount){
    if(!this.enabled() || !(amount < 0)) return;
    const block = this.healingBlockOf(actor);
    if(!block) return;
    ui.notifications.warn(module.format("spells.noHealing", { name : actor.name, effect : block.name }));
    return false;
  }

  /* ---------- Giant Insect ---------- */

  static SPEW_ID = "mhVenomSpewSave1";

  /* The Centipede's Venomous Spew : its utility replaced by the CON save (its Poisoned effect on a failure) */
  static spewFix(item){
    if(!this.enabled() || this.is2014(item) || !String(idOf(item)).startsWith("venomous-spew")) return null;
    const activities = [...(item.system?.activities ?? [])];
    if(activities.some(a => a.type === "save")) return null;
    const utility = activities.find(a => a.type === "utility");
    if(!utility) return null;
    const source = item._source?.system?.activities?.[utility.id] ?? {};
    return {
      activities : [utility.id],
      update : { [`system.activities.${this.SPEW_ID}`] : {
        _id : this.SPEW_ID, type : "save", name : "", activation : source.activation ?? { type : "action" },
        range : { units : "ft", value : "10", override : true },
        target : { affects : { count : "1", type : "creature" }, override : true },
        save : { ability : ["con"], dc : { calculation : "", formula : "@attributes.spell.dc" } },
        effects : (source.effects ?? []).map(e => ({ _id : e._id, onSave : false })),
      } },
    };
  }

  /* The spell's summon matches saves : the creature's save DCs are the caster's spell save DC */
  static giantInsectFix(item){
    if(!this.enabled() || this.is2014(item) || (item?.type !== "spell") || (idOf(item) !== "giant-insect")) return null;
    const summon = [...(item.system?.activities ?? [])].find(a => a.type === "summon");
    if(!summon || summon.match?.saves) return null;
    return { update : { [`system.activities.${summon.id}.match.saves`] : true } };
  }

  /* ---------- Rituals ---------- */

  static isRitual(item){
    const props = item?.system?.properties;
    return !!(props?.has?.("ritual") ?? (Array.isArray(props) && props.includes("ritual")));
  }

  /* How the spell can be cast as a Ritual : "choice" (prepared), "only" (a Wizard's unprepared spellbook spell), null */
  static ritualMode(item){
    if((item?.type !== "spell") || !this.isRitual(item) || !(Number(item.system?.level) > 0)) return null;
    const method = item.system?.method ?? "";
    if(["ritual", "innate", "atwill"].includes(method)) return null;
    if(Number(item.system?.prepared) >= 1) return "choice";
    const wizard = (String(item.system?.sourceItem ?? "") === "class:wizard") || (item.system?.classIdentifier === "wizard");
    return (wizard && item.actor?.items?.some?.(i => idOf(i) === "ritual-adept")) ? "only" : null;
  }

  static async ritualStep(activity, ctx, next){
    const mode = this.enabled() ? this.ritualMode(activity?.item) : null;
    if(!mode || ctx.config?.[module.id]?.ritual !== undefined) return next();
    let ritual = (mode === "only");
    if(mode === "choice"){
      const value = await chooseOption({ title : activity.item.name, icon : "fa-solid fa-book-open", prompt : module.i18n("spells.ritual.prompt"),
        options : [{ value : "normal", label : module.i18n("spells.ritual.normal") }, { value : "ritual", label : module.i18n("spells.ritual.ritual") }] });
      if(!value) return;
      ritual = (value === "ritual");
    }
    if(!ritual) return next();
    /* No slot, its own level */
    ctx.config = { ...ctx.config, consume : { ...((typeof ctx.config?.consume === "object") ? ctx.config.consume : {}), spellSlot : false }, scaling : false };
    const note = module.i18n("spells.ritual.note");
    uses.mark(ctx, { ritual : true, note, cardFlags : { ritual : true } });
    uses.flag(ctx, { ritual : true, note });
    return next();
  }

  /* ---------- Range (Rule Limits, no pick) ---------- */

  /* Will a pick on the map choose the targets (and hold them to the range) ? */
  static picks(){
    return !!settings.value("rollItem") && (settings.value("rollItemPick") !== "off");
  }

  /* The spell's range in feet, stretched by Distant Spell (double; Touch 30 ft); null : no range to hold to */
  static rangeOf(activity, multiplier = 1){
    const range = activity?.range?.override ? activity.range : (activity?.item?.system?.range ?? {});
    if(["self", "spec", "any", ""].includes(range.units ?? "")) return null;
    const feet = getRange(activity);
    if(!Number.isFinite(feet) || !(feet > 0)) return null;
    if(multiplier > 1) return (range.units === "touch") ? Math.max(feet, 30) : feet * multiplier;
    return feet;
  }

  static async rangeStep(activity, ctx, next){
    if((limits.mode() === "off") || (activity?.item?.type !== "spell") || this.picks()) return next();
    /* An area : its template finds who's in it */
    if(activity.target?.template?.type || activity.item.system?.target?.template?.type) return next();
    const caster = tokenOf(activity.actor);
    const targets = [...(game.user.targets ?? [])].filter(t => t !== caster);
    const range = this.rangeOf(activity, Number(ctx.config?.[module.id]?.rangeMultiplier) || 1);
    if(!caster || !targets.length || (range === null)) return next();
    const out = targets.filter(t => distanceBetween(caster, t) > range);
    if(out.length && !limits.allow(module.format("spells.outOfRange", { spell : activity.item.name, names : out.map(t => t.name).join(", "), range }),
      { who : activity.actor.name, what : activity.item.name })) return;
    return next();
  }
}
