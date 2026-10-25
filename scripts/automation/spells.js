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
import { patch } from '../patch.js';
import { chooseOption, plainText } from '../helpers/utils.js';
import { TYPES } from '../roll-item/message.js';
import { isClassSpell } from '../helpers/items.js';
import { originItem } from '../helpers/utils.js';
import { rollModeFrom } from './roll-modes.js';
import { onMiss } from '../roll-item/miss-damage.js';
import { willingSave } from './willing.js';
import { sharesDamage } from '../roll-item/card-builder.js';
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
 *   Emanations      : an area that comes from the caster (Detect Magic, Word of Radiance; dnd5e's "Emanation") is
 *                     always made, round the caster's token with no click, and follows it (dnd5e attaches it). It
 *                     shows on the map for everyone and goes with the spell (its Concentration, or the end of the
 *                     turn for an instantaneous one : Clear Instant Areas). The caster isn't in it.
 *   Casting level   : a levelled spell aimed at creatures (no area) asks its slot level first, before its targets are
 *                     picked, so the pick knows how many (dnd5e's own window then can't change it). "One additional
 *                     creature for each spell slot level above N" in its text adds those targets (Bless, Command...),
 *                     with or without a pick; with no pick, more targets than that follow Rule Limits.
 *   Rituals         : a spell with the Ritual tag you have prepared : cast normally (a slot, a higher level allowed) or
 *                     as a Ritual (10 minutes longer, no slot, its own level), asked only when it's a real choice : a
 *                     spell that takes 1 minute or more (Find Familiar), or with no slot left, is just cast as a Ritual.
 *   Material cost   : a spell whose material says "worth 10+ GP" but has no cost in its data (Find Familiar) gets it. A Wizard with Ritual Adept casts the
 *                     rituals in its spellbook (its Wizard spells) without preparing them : as a Ritual only. The card
 *                     notes it (flags.ritual for the action tracker).
 *   Blur            : attack rolls against the caster have disadvantage, unless the attacker has Blindsight or
 *                     Truesight reaching it (its Concentration is the effect).
 *   Invisibility    : ends just after its creature makes an attack roll or casts a spell.
 *   Melf's Acid Arrow : a miss deals half the attack's damage (no acid later); a hit's acid at the end of the target's
 *                     next turn is a repeating effect (automation/repeating.js).
 *   Warding Bond    : each time the bonded creature takes damage, its caster takes the same amount (no type : its
 *                     resistances don't cut it). The bond ends when the caster drops to 0 HP, when they're more than
 *                     60 ft apart, or when the spell is cast again on either of them.
 *   Range           : Rule Limits on and no target pick (Pick Targets off, or Roll Item off) : a spell aimed at
 *                     creatures out of its range (Distant Spell's doubled range, Touch 30 ft) follows Rule Limits.
 */
export class spells{
  static BLADE_WARD = "blade-ward";
  static RAY_OF_SICKNESS = "ray-of-sickness";
  static BLUR = "blur";
  static INVISIBILITY = "invisibility";
  static ACID_ARROW = "melfs-acid-arrow";
  static ENLARGE_REDUCE = "enlarge-reduce";
  static WARDING_BOND = "warding-bond";
  /* The effects the fixes add (16-character ids, so a fix can tell it's done) */
  static EFFECT_IDS = { "blade-ward" : "mhBladeWardWard1", "ray-of-sickness" : "mhRaySicknessPsn" };

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("spellRules");
  }

  /* Does one of these senses of the attacker reach the target (its range, in feet) */
  static sensesReach(actor, target, senses){
    const ranges = actor?.system?.attributes?.senses?.ranges ?? {};
    const best = Math.max(0, ...senses.map(s => Number(ranges[s]) || 0));
    if(!best) return false;
    const from = tokenOf(actor);
    return !from || !target || (distanceBetween(from, target) <= best);
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
    itemFixes.add({ name : "Produce Flame", where : "owned", plan : item => this.produceFlameFix(item) });
    itemFixes.add({ name : "Jump", where : "owned", plan : item => this.jumpFix(item) });
    itemFixes.add({ name : "Grease", where : "owned", plan : item => this.greaseFix(item) });
    itemFixes.add({ name : "Material cost", where : "owned", plan : item => this.materialCostFix(item) });
    Hooks.on("dnd5e.rollSavingThrow", (rolls, data) => this.nextSaveUsed(data?.subject ?? rolls?.[0]?.data?.actor ?? null));
    Hooks.on("dnd5e.preApplyDamage", (actor, amount) => this.blockHealing(actor, amount));
    itemFixes.add({ name : "Giant Insect", where : "owned", plan : item => this.giantInsectFix(item) });
    itemFixes.add({ name : "Enlarge/Reduce", where : "owned", plan : item => this.enlargeReduceFix(item) });
    /* Enlarge/Reduce : only an unwilling target saves (the GM says which) */
    willingSave({ id : this.ENLARGE_REDUCE, enabled : () => this.enabled(), applies : activity => idOf(activity?.item) === this.ENLARGE_REDUCE });
    /* Blade Ward's die is the attacker's : Roll Item doesn't roll it on a card */
    Hooks.on(`${module.id}.preRollItem`, activity => !(this.enabled() && (idOf(activity?.item) === this.BLADE_WARD)));
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.onCast(activity, results));
    Hooks.on(`${module.id}.selfEffects`, activity => !(this.enabled() && (idOf(activity?.item) === this.BLADE_WARD)));
    Hooks.on("dnd5e.preRollAttackV2", config => this.bladeWardPenalty(config));
    uses.onActivity("spellRange", (activity, ctx, next) => this.rangeStep(activity, ctx, next));
    uses.onActivity("ritual", (activity, ctx, next) => this.ritualStep(activity, ctx, next));
    uses.onActivity("castLevel", (activity, ctx, next) => this.castLevelStep(activity, ctx, next));
    /* Emanations : made, round the caster, no placing */
    Hooks.on("dnd5e.preUseActivity", (activity, usage) => this.emanationMade(activity, usage));
    Hooks.on("dnd5e.preCreateMeasuredTemplate", (activity, config) => this.emanationOrigin(activity, config));
    Hooks.on("deleteActiveEffect", effect => this.emanationEnded(effect));
    Hooks.once("setup", () => patch.wrap("dnd5e.canvas.TemplatePlacement.place", function(wrapped, config, ...rest){
      return spells.emanationPlacement(config) ?? wrapped(config, ...rest);
    }));
    /* The level chosen first : dnd5e's window keeps it */
    Hooks.on("renderActivityUsageDialog", (app, html) => this.lockSlot(app, html));
    /* Upcasting adds targets : Roll Item's pick counts them */
    Hooks.on(`${module.id}.targetCount`, (activity, usage, data) => { data.count += this.upcastTargets(activity, usage); });
    Hooks.on("dnd5e.postUseActivity", (activity, usage) => this.agathysCast(activity, usage));
    Hooks.on("updateActor", (actor, changes) => this.agathysGone(actor, changes));
    /* Blur : not against an attacker whose Blindsight or Truesight reaches it */
    rollModeFrom(this.BLUR, { against : { mode : "disadvantage", when : (attack, target) => !this.sensesReach(attack.actor, target, ["blindsight", "truesight"]),
      reason : () => module.i18n("spells.blurred") }, enabled : () => this.enabled(), id : this.BLUR });
    conditions.endsWhen(effect => this.enabled() && (idOf(originItem(effect)) === this.INVISIBILITY), { attacks : true, casts : true });
    /* Warding Bond : its caster takes the same damage as the bonded creature; ends at 0 HP, beyond 60 ft, or cast again */
    sharesDamage(effect => this.enabled() && (idOf(originItem(effect)) === this.WARDING_BOND), { fraction : 1, keep : true });
    conditions.endsWhen(effect => this.enabled() && (idOf(originItem(effect)) === this.WARDING_BOND), { sourceZeroHP : true, apart : 60, recast : true });
    /* Melf's Acid Arrow : half the attack's damage on a miss */
    onMiss({ id : "melfsAcidArrow", enabled : () => this.enabled(), when : miss => idOf(miss.item) === this.ACID_ARROW,
      formula : miss => String(Math.floor(miss.damage.reduce((sum, roll) => sum + (Number(roll.total) || 0), 0) / 2)),
      type : () => "acid", label : miss => miss.item.name });
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

  /* ---------- Grease : a failed save leaves it Prone (Plutonium's save has no effect to apply) ---------- */

  static GREASE_PRONE = "mhGreaseProne000";

  static greaseFix(item){
    if(!this.enabled() || this.is2014(item) || (item?.type !== "spell") || (idOf(item) !== "grease")) return null;
    const save = [...(item.system?.activities ?? [])].find(a => a.type === "save");
    if(!save || item.effects?.get?.(this.GREASE_PRONE)) return null;
    const effects = (item.effects?.contents ?? []).filter(e => e.statuses?.has?.("prone"));
    if(effects.length) return null;
    return {
      create : { effects : [{ _id : this.GREASE_PRONE, name : game.i18n.localize(CONFIG.statusEffects.find(e => e.id === "prone")?.name ?? "Prone"),
        img : CONFIG.statusEffects.find(e => e.id === "prone")?.img ?? "icons/svg/falling.svg", statuses : ["prone"], transfer : false }] },
      update : { [`system.activities.${save.id}.effects`] : [...(save.toObject?.().effects ?? []), { _id : this.GREASE_PRONE, onSave : false }] },
    };
  }

  /* ---------- Material cost : "worth 10+ GP" in the text, no cost in the data ---------- */

  static materialCostFix(item){
    if(!this.enabled() || (item?.type !== "spell")) return null;
    const m = item.system?.materials;
    if(!m || (Number(m.cost) > 0)) return null;
    const worth = String(m.value ?? "").match(/worth\s+(?:at\s+least\s+)?([\d,]+)\s*\+?\s*GP/i);
    if(!worth) return null;
    const update = { "system.materials.cost" : Number(worth[1].replaceAll(",", "")) };
    if(/consume/i.test(m.value) && !m.consumed) update["system.materials.consumed"] = true;
    return { update };
  }

  /* ---------- Jump : its effect sets the creature's jump speed to 30 ft (the token ruler's Jump action uses it) ---------- */

  static jumpFix(item){
    if(!this.enabled() || this.is2014(item) || (item?.type !== "spell") || (idOf(item) !== "jump")) return null;
    const KEY = "system.attributes.movement.speeds.jump";
    const effects = item.effects?.contents ?? [...(item.effects ?? [])];
    const updateEffects = effects.filter(e => !e.transfer && !(e.changes ?? []).some(c => c.key === KEY))
      .map(e => ({ _id : e.id, changes : [...(e.toObject().changes ?? []), { key : KEY, type : "upgrade", mode : 4, value : "30" }] }));
    return updateEffects.length ? { updateEffects } : null;
  }

  /* ---------- Produce Flame : its hurl has the range of a hurl (60 ft), not the spell's Self ---------- */

  static produceFlameFix(item){
    if(!this.enabled() || this.is2014(item) || (item?.type !== "spell") || (idOf(item) !== "produce-flame")) return null;
    const hurl = [...(item.system?.activities ?? [])].find(a => a.type === "attack");
    if(!hurl || (hurl.range?.override && (Number(hurl.range?.value) > 0))) return null;
    return { update : { [`system.activities.${hurl.id}.range`] : { override : true, value : "60", units : "ft" } } };
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

  /* ---------- Enlarge/Reduce : a size larger or smaller, Strength checks and saves with advantage / disadvantage ---------- */

  static enlargeReduceFix(item){
    if(!this.enabled() || this.is2014(item) || (item?.type !== "spell") || (idOf(item) !== this.ENLARGE_REDUCE)) return null;
    const MODES = ["system.abilities.str.check.roll.mode", "system.abilities.str.save.roll.mode"];
    const updateEffects = [];
    for(const effect of item.effects ?? []){
      if(effect.transfer || effect.getFlag(module.id, "rule")?.size) continue;
      const changes = [...(effect.system?.changes ?? effect.changes ?? [])].map(c => ({ ...c }));
      /* Reduced : its damage is less (Plutonium's "- 1d4"), else by its name */
      const smaller = changes.some(c => /^\s*-/.test(String(c.value)) && /damage$/.test(c.key)) || /reduc/i.test(effect.name);
      const mode = smaller ? -1 : 1;
      for(const key of MODES){
        const change = changes.find(c => c.key === key);
        if(change) change.value = mode;
        else changes.push({ key, type : "add", value : mode });
      }
      updateEffects.push({ _id : effect.id, ...((effect.system?.changes !== undefined) ? { "system.changes" : changes } : { changes }),
        [`flags.${module.id}.rule`] : { ...(effect.getFlag(module.id, "rule") ?? {}), size : mode } });
    }
    return updateEffects.length ? { updateEffects } : null;
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
    const wizard = isClassSpell(item, "wizard");
    return (wizard && item.actor?.items?.some?.(i => idOf(i) === "ritual-adept")) ? "only" : null;
  }

  static async ritualStep(activity, ctx, next){
    const mode = this.enabled() ? this.ritualMode(activity?.item) : null;
    if(!mode || ctx.config?.[module.id]?.ritual !== undefined) return next();
    let ritual = (mode === "only");
    /* Only a real choice is asked : 1 minute or more saves just 10 minutes for a slot; no slot left, no choice */
    const activation = activity.item.system?.activation ?? {};
    const seconds = (Number(activation.value) || 1) * ({ minute : 60, hour : 3600, day : 86400 }[activation.type] ?? 0);
    const level = Number(activity.item.system?.level) || 1;
    const slotLeft = Object.values(activity.actor?.system?.spells ?? {}).some(s => (Number(s?.value) > 0) && (Number(s?.level) >= level));
    if((mode === "choice") && ((seconds >= 60) || !slotLeft)) ritual = true;
    else if(mode === "choice"){
      const time = s => s ? this.timeText(s) : (CONFIG.DND5E.activityActivationTypes?.[activation.type]?.label ?? activation.type ?? "");
      const value = await chooseOption({ title : activity.item.name, icon : "fa-solid fa-book-open", prompt : module.i18n("spells.ritual.prompt"),
        options : [{ value : "normal", label : module.format("spells.ritual.normal", { time : time(seconds) }) },
          { value : "ritual", label : module.format("spells.ritual.ritual", { time : this.timeText(seconds + 600) }) }] });
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

  /* 4200 -> "1 hour 10 minutes" */
  static timeText(seconds){
    const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
    return [h ? module.format(h === 1 ? "spells.ritual.hour" : "spells.ritual.hours", { n : h }) : "", m ? module.format(m === 1 ? "spells.ritual.minute" : "spells.ritual.minutes", { n : m }) : ""].filter(Boolean).join(" ");
  }

  /* ---------- Emanations ---------- */

  static isEmanation(activity){
    const template = activity?.target?.template ?? {};
    return !!template.type && (CONFIG.DND5E.areaTargetTypes?.[template.type]?.template === "emanation") && !template.stationary;
  }

  /* Always made (dnd5e only offers it when the activity asks to place its area) */
  static emanationMade(activity, usage){
    if(!this.enabled() || !usage || !this.isEmanation(activity)) return;
    const token = tokenOf(activity.actor);
    if(!token || (token.document.parent !== canvas.scene)) return;
    usage.create = { ...(usage.create ?? {}), measuredTemplate : true };
  }

  /* Whose token it comes from, for the placement */
  static emanationOrigin(activity, config){
    if(!this.enabled() || !this.isEmanation(activity) || !config?.shapes?.every?.(s => s.type === "emanation")) return;
    const token = tokenOf(activity.actor);
    if(token && (token.document.parent === canvas.scene)) config[module.id] = { token : token.document.id };
  }

  /* The spell's Concentration ended : its emanations go too (dnd5e doesn't tie areas to it), by the active GM */
  static async emanationEnded(effect){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    if(!effect?.statuses?.has?.(CONFIG.specialStatusEffects?.CONCENTRATING ?? "concentrating")) return;
    const flag = effect.getFlag("dnd5e", "item");
    const actor = effect.parent;
    const uuid = flag?.uuid ?? (flag?.id ? actor?.items?.get?.(flag.id)?.uuid : null);
    if(!uuid) return;
    for(const scene of game.scenes){
      const ids = scene.regions.filter(r => (r.getFlag("dnd5e", "item") === uuid) && r.shapes.some(s => s.type === "emanation")).map(r => r.id);
      if(ids.length) await scene.deleteEmbeddedDocuments("Region", ids).catch(error => log.debug(error));
    }
  }

  /* dnd5e's placement for an emanation : its shape round that token, without asking where (dnd5e attaches it) */
  static emanationPlacement(config){
    const id = config?.[module.id]?.token;
    if(!id || !canvas.scene?.tokens?.get(id)) return null;
    const perUnit = canvas.scene.grid.size / canvas.scene.grid.distance;
    const shape = canvas.grid.isHexagonal ? CONST.TOKEN_SHAPES.ELLIPSE_1 : CONST.TOKEN_SHAPES.RECTANGLE_1;
    return Promise.resolve(config.shapes.map(s => ({ x : 0, y : 0, rotation : 0, type : "emanation", radius : (Number(s.size) || 0) * perUnit,
      base : { x : 0, y : 0, rotation : 0, width : 1, height : 1, type : "token", shape }, token : id })));
  }

  /* ---------- Casting level (before the targets) ---------- */

  /* A levelled spell paid with a slot, aimed at creatures without an area, its level not already set (a ritual, a scroll) */
  static asksLevel(activity, config = {}){
    const item = activity?.item;
    if((item?.type !== "spell") || !(Number(item.system.level) > 0) || !activity.requiresSpellSlot) return false;
    if((config.scaling === false) || config.spell?.slot || item.getFlag?.("dnd5e", "spellLevel")) return false;
    if((config.consume === false) || (config.consume?.spellSlot === false)) return false;
    const target = activity.target?.override ? activity.target : (item.system.target ?? activity.target ?? {});
    if(target.template?.type || activity.target?.template?.type) return false;
    return !["self", "space", "object", ""].includes(target.affects?.type ?? "");
  }

  /* The slots it can be cast with, as dnd5e's window offers them : { key, level, label } (spell slots, Pact slots) */
  static slotOptions(activity){
    const item = activity.item, actor = activity.actor;
    const base = Number(item.system.level) || 1;
    const method = CONFIG.DND5E.spellcasting?.[item.system.method];
    const out = [];
    for(const [key, slot] of Object.entries(actor?.system?.spells ?? {})){
      if(!(Number(slot?.max) > 0) || !slot.type || (Number(slot.level) < base) || !(Number(slot.value) > 0)) continue;
      if(method?.exclusive?.spells && (item.system.method !== slot.type)) continue;
      if(CONFIG.DND5E.spellcasting?.[slot.type]?.exclusive?.slots && (item.system.method !== slot.type)) continue;
      const model = CONFIG.DND5E.spellcasting?.[slot.type];
      const label = game.i18n.format(`DND5E.SpellLevel${slot.type.capitalize()}`, { level : model?.isSingleLevel ? slot.level : slot.label, n : slot.value });
      out.push({ key, level : Number(slot.level), label });
    }
    return out.sort((a, b) => a.level - b.level);
  }

  static async castLevelStep(activity, ctx, next){
    if(!this.enabled() || !this.asksLevel(activity, ctx.config)) return next();
    const options = this.slotOptions(activity);
    /* None left : dnd5e's own window says so; one way only : nothing to ask */
    if(options.length > 1){
      const key = await chooseOption({ title : activity.item.name, icon : "fa-solid fa-wand-sparkles", prompt : module.i18n("spells.castLevel.prompt"),
        options : options.map(o => ({ value : o.key, label : o.label })), value : options[0].key });
      if(!key) return;
      this.setSlot(ctx, activity, options.find(o => o.key === key));
    }
    else if(options.length === 1) this.setSlot(ctx, activity, options[0]);
    return next();
  }

  static setSlot(ctx, activity, option){
    ctx.config = { ...ctx.config, spell : { ...(ctx.config?.spell ?? {}), slot : option.key }, scaling : Math.max(0, option.level - (Number(activity.item.system.level) || 1)) };
    uses.mark(ctx, { castLevel : option.level });
  }

  /* dnd5e's usage window : the level already chosen is shown, not changed */
  static lockSlot(app, html){
    if(!app?.config?.[module.id]?.castLevel) return;
    const select = (html instanceof HTMLElement ? html : html?.[0])?.querySelector?.('[name="spell.slot"]');
    if(select){ select.disabled = true; select.dataset.tooltip = module.i18n("spells.castLevel.locked"); }
  }

  /* "You can target one additional creature for each spell slot level above 1" : how many more at the level cast */
  static upcastTargets(activity, usage = {}){
    const item = activity?.item;
    if((item?.type !== "spell") || !(Number(item.system.level) > 0)) return 0;
    const level = Number(activity.actor?.system?.spells?.[usage?.spell?.slot]?.level) || 0;
    if(!level) return 0;
    const text = plainText(item.system.description?.value);
    const m = /\b(one|two|three|\d+) additional (?:[a-z]+ )?(?:creatures?|targets?|beasts?|humanoids?|undead|allies|ally)\b[^.]*?\bfor each (?:spell )?slot level above (\d+)/i.exec(text);
    if(!m) return 0;
    const per = { one : 1, two : 2, three : 3 }[m[1].toLowerCase()] ?? Number(m[1]);
    return Math.max(0, level - Number(m[2])) * (per || 1);
  }

  /* How many creatures it may target at the level cast (its count, upcasting, Twinned Spell); null : no count */
  static allowedTargets(activity, usage = {}){
    const target = activity.target?.override ? activity.target : (activity.item?.system?.target ?? activity.target ?? {});
    const raw = target?.affects?.count;
    if(!raw) return null;
    let count = Number(raw);
    if(!Number.isFinite(count)){ try { count = dnd5e.utils.simplifyBonus(raw, activity.getRollData?.() ?? {}); } catch { return null; } }
    if(!(count > 0)) return null;
    return Math.floor(count) + this.upcastTargets(activity, usage) + (Number(usage?.[module.id]?.extraTargets) || 0);
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
    /* Targets a rule set itself (an area round the target, a leap) : not the caster's to hold to range or count */
    if(ctx.config?.[module.id]?.useTargets) return next();
    /* An area : its template finds who's in it */
    if(activity.target?.template?.type || activity.item.system?.target?.template?.type) return next();
    const caster = tokenOf(activity.actor);
    const targets = [...(game.user.targets ?? [])].filter(t => t !== caster);
    const range = this.rangeOf(activity, Number(ctx.config?.[module.id]?.rangeMultiplier) || 1);
    if(!caster || !targets.length || (range === null)) return next();
    const out = targets.filter(t => distanceBetween(caster, t) > range);
    if(out.length && !limits.allow(module.format("spells.outOfRange", { spell : activity.item.name, names : out.map(t => t.name).join(", "), range }),
      { who : activity.actor.name, what : activity.item.name })) return;
    /* More creatures than the level cast allows */
    const allowed = this.allowedTargets(activity, ctx.config);
    if((allowed !== null) && (targets.length > allowed) && !limits.allow(module.format("spells.tooManyTargets", { spell : activity.item.name, n : targets.length, allowed }),
      { who : activity.actor.name, what : activity.item.name })) return;
    return next();
  }
}
