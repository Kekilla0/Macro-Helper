import { module } from '../../module.js';
import { idOf } from '../../helpers/utils.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { isUnarmored, multiattack, spendUses } from '../../helpers/items.js';
import { bonusOnlyWhen } from '../bonus-only-when.js';
import { actions } from '../actions.js';
import { weaponUses } from '../weapon-uses.js';
import { uses } from '../../uses.js';
import { onInitiative } from '../initiative.js';
import { itemFixes } from '../item-fixes.js';
import { tokenOf } from '../../helpers/tokens.js';
import { addTimedEffect } from '../../helpers/actors.js';
import { pickTargets } from '../../helpers/targets.js';
import { cutDamage, cutsOf } from '../../roll-item/damage-cuts.js';
import { cardBuilder } from '../../roll-item/card-builder.js';
import { actionTracker } from '../action-tracker.js';
import { TYPES } from '../../roll-item/message.js';
import { bonusAttackAfter } from '../bonus-attacks.js';
const log = logger.for(import.meta.url);

/**
 * Monk, levels 1-2 (Classes setting). Unarmored Defense is dnd5e's own AC. Works with either layout : dnd5e's own (one
 * "Monk's Focus" item holding the Focus Points, with Flurry of Blows, Patient Defense and Step of the Wind as its
 * activities) or separate items (Plutonium's : a "Focus Point" item, and one item each).
 *
 *   Martial Arts       : while wearing no armor and holding no shield, an Unarmed Strike or Monk weapon (Simple melee,
 *                        Martial melee with Light) uses the better of STR and DEX, and the Martial Arts die instead of
 *                        its own when that's bigger. Done as dnd5e prepares the weapon, so the sheet, the card and the
 *                        rolls all show it (Plutonium's enchantment would force the die, and stay on in armor). Its
 *                        Unarmed Strike as a Bonus Action : the bonus attack lego (after : "any" : with or without the
 *                        Attack action; the Action Tracker spends it once the Action's attacks are made or gone).
 *   Flurry of Blows    : a Focus Point, then the character's own Unarmed Strike twice (three times from level 10), each
 *                        its own use : Attack, Grapple or Shove (multiattack, economy "bonus", tag "flurry").
 *   Patient Defense    : the free use : Disengage; with a Focus Point : Disengage and Dodge (the Default Actions, free).
 *   Step of the Wind   : like Patient Defense : the free use : Dash; with a Focus Point : Dash and Disengage, and its
 *                        jump distance doubled for the turn (a mark : flags.macro-helper.jump.times). Plutonium's
 *                        item (one Focus Point activity, its own uses) is given the free activity when it lands.
 *   Unarmored Movement : its speed only while wearing no armor and holding no shield (bonusOnlyWhen).
 *   Uncanny Metabolism : a button on the Monk's initiative roll (onInitiative; Initiative Each Round : the combat's first
 *                        roll only) while its use is left : uses the item (Focus Points back, the healing roll).
 *   Deflect Attacks    : (level 3) an attack roll hits the Monk with Bludgeoning, Piercing or Slashing damage : Deflect
 *                        on the card (its owner, its Reaction left) rolls 1d10 + DEX + Monk level, and that card's
 *                        damage to it is that much lower. Brought to 0 : Redirect (a Focus Point) picks a creature within
 *                        5 ft (a melee attack) or 60 ft (a ranged one), and uses the item's Redirect save activity at it,
 *                        with the attack's damage type.
 */
export class monk{
  static FLURRY = "flurry-of-blows";
  static PATIENT = "patient-defense";
  static STEP = "step-of-the-wind";
  static MOVEMENT = "unarmored-movement";
  static METABOLISM = "uncanny-metabolism";
  /* Where the Focus Points are : dnd5e's Monk's Focus, or a Focus Point item */
  static FOCUS = ["monks-focus", "focus-point"];
  static POOL = "monks-focus";
  static UNARMED = "unarmed-strike";
  static DEFLECT = "deflect-attacks";
  static DEFLECTED = ["bludgeoning", "piercing", "slashing"];

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.onUse(activity, usage, results));
    /* Martial Arts : an Unarmed Strike as a Bonus Action */
    bonusAttackAfter("martial-arts", { id : "martial-arts", after : "any", when : ({ item }) => idOf(item) === this.UNARMED });
    /* Patient Defense / Step of the Wind : the Default Actions' marks are put on instead of the item's own effects
       (dnd5e's Monk's Focus carries a Dodging effect that never ends) */
    Hooks.on(`${module.id}.selfEffects`, activity => !(this.enabled() && [...this.FOCUS, this.PATIENT, this.STEP].includes(idOf(activity?.item))));
    /* Unarmored Movement : its speed only while unarmored */
    bonusOnlyWhen(this.MOVEMENT, "system.attributes.movement.walk", actor => this.unarmored(actor), { enabled : () => this.enabled(), id : "unarmoredMovement" });
    /* Step of the Wind with only its Focus Point use : the free Dash added (dnd5e's and Plutonium's) */
    itemFixes.add({ name : "Step of the Wind", where : "owned", plan : item => { const update = this.stepUpdate(item); return update ? { update } : null; } });
    /* Uncanny Metabolism : a button on the initiative roll, its first one with Initiative Each Round */
    onInitiative({ id : "metabolism", feature : this.METABOLISM, icon : "fa-yin-yang", firstOnly : true, when : actor => this.isMonk(actor) });
    /* Flurry of Blows : the Unarmed Strike, not its own attack (an item of its own, or Monk's Focus's activity) */
    uses.onItem("flurry", (item, ctx, next) => {
      if(this.isMonk(item.actor) && (idOf(item) === this.FLURRY) && this.unarmedOf(item.actor)) return this.flurry(item, ctx.config);
      return next();
    });
    uses.onActivity("flurry", (activity, ctx, next) => {
      if(this.isMonk(activity.actor) && (idOf(activity.item) === this.POOL) && (this.kindOf(activity) === this.FLURRY) && this.unarmedOf(activity.actor)){
        return this.flurry(activity.item, ctx.config);
      }
      return next();
    });
    /* Deflect Attacks */
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => this.deflectButtons(message, buttons, ray ?? null));
    Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => {
      if(String(id).startsWith("deflect|")) this.deflect(message, ray ?? null, String(id).slice(8));
      else if(String(id).startsWith("redirect|")) this.redirect(message, ray ?? null, String(id).slice(9));
    });
    Hooks.on(`${module.id}.damageType`, (activity, { types, preset }) => {
      const kept = this.#redirectType;
      if(kept && (kept.item === activity?.item?.id) && ((Date.now() - kept.at) < 15000) && types.includes(kept.type)) preset.type = kept.type;
    });
    /* Martial Arts : the weapon-uses lego (the better of STR and DEX, the Martial Arts die) */
    weaponUses.add("martialArts", { applies : item => this.appliesTo(item), abilities : () => ["str", "dex"], die : item => this.facesOf(item.actor) });
  }


  static isMonk(actor){
    return this.enabled() && !!actor?.classes?.monk;
  }

  /* No armor worn, no shield held (Martial Arts, Unarmored Movement) */
  static unarmored(actor){
    return isUnarmored(actor);
  }

  /* Unarmed Strike, or a Monk weapon : Simple melee, or Martial melee with Light */
  static monkWeapon(item){
    if(idOf(item) === this.UNARMED) return true;
    if(item?.type !== "weapon") return false;
    const type = item.system.type?.value;
    return (type === "simpleM") || ((type === "martialM") && !!item.system.properties?.has?.("lgt"));
  }

  /* Martial Arts applies to this weapon now */
  static appliesTo(item){
    return this.isMonk(item?.actor) && this.monkWeapon(item) && this.unarmored(item.actor);
  }

  /* The Martial Arts die's faces, from the class's scale */
  static facesOf(actor){
    const die = actor?.system?.scale?.monk?.die;
    return Number(die?.faces) || Number(/d(\d+)/i.exec(die?.formula ?? "")?.[1]) || 6;
  }

  /* ---------- Flurry of Blows ---------- */

  static unarmedOf(actor){
    return actor?.items?.find?.(i => idOf(i) === this.UNARMED) ?? null;
  }

  /* A Focus Point, then the Unarmed Strike two times (three from level 10), each Attack, Grapple or Shove, together
     one Bonus Action (multiattack's economy); its cards tagged "flurry" (Open Hand Technique). The first closed : the
     point back */
  static async flurry(item, config = {}){
    const actor = item.actor;
    const focus = this.focusOf(actor);
    if(focus && !(Number(focus.system.uses?.value) > 0)){
      ui.notifications.warn(module.format("classes.monk.noFocus", { name : actor.name, item : focus.name }));
      return null;
    }
    if(focus) await spendUses(focus, 1);
    const count = 2 + Math.min(1, Math.floor((Number(actor.classes.monk.system?.levels) || 1) / 10));
    const results = await multiattack(actor, [{ weapon : this.unarmedOf(actor), count }], { economy : "bonus", tag : "flurry", event : config.event }) ?? [];
    if(!results.length && focus) await focus.update({ "system.uses.spent" : Math.max(0, (Number(focus.system.uses?.spent) || 1) - 1) });
    log.debug("Flurry of Blows", actor.name, results.length, "of", count);
    return results.at(-1) ?? null;
  }

  /* ---------- Focus : Patient Defense, Step of the Wind ---------- */

  /* The item holding the Focus Points */
  static focusOf(actor){
    return actor?.items?.find?.(i => this.FOCUS.includes(idOf(i))) ?? null;
  }

  /**
   * Which Focus feature an activity is : its own item's identifier (separate items), or on Monk's Focus by its name.
   * @returns {string|null}  FLURRY, PATIENT, STEP or null
   */
  static kindOf(activity){
    const id = idOf(activity?.item);
    if([this.FLURRY, this.PATIENT, this.STEP].includes(id)) return id;
    if(id !== this.POOL) return null;
    const name = String(activity.name ?? "").toLowerCase();
    return name.includes("flurry") ? this.FLURRY : name.includes("patient") ? this.PATIENT : name.includes("step of the wind") ? this.STEP : null;
  }

  /* A Focus Point spent by this use (its activity spends from the Focus Point item) */
  static spendsFocus(activity, usage){
    if(usage?.consume === false) return false;
    return (activity?.consumption?.targets ?? []).some(t => t.type === "itemUses");
  }

  static async onUse(activity, usage, results){
    const actor = activity?.actor;
    if(!this.isMonk(actor) || !actor.isOwner) return;
    const id = this.kindOf(activity);
    if(![this.PATIENT, this.STEP].includes(id)) return;
    const own = activity.getUsageToken?.()?.actor ?? actor;
    const focus = this.spendsFocus(activity, usage);
    /* The Default Actions, free (the feature's Bonus Action paid) */
    const pair = (id === this.PATIENT) ? ["disengage", "dodge"] : ["dash", "disengage"];
    await actions.useDefault(own, pair[0]);
    if(focus) await actions.useDefault(own, pair[1]);
    /* Step of the Wind with its Focus Point : its jump distance doubled for the turn (jump.js reads the flag) */
    if(focus && (id === this.STEP)) await addTimedEffect(own, { name : module.i18n("jump.stepMark"), img : activity.item.img,
      flags : { [module.id] : { jump : { times : 2 } } } }, { until : "turnEnd", thisTurn : true });
    await actions.autoApplied(results);
    log.debug("Monk", activity.item.name, focus ? "Focus Point" : "free");
  }

  /**
   * Plutonium's Step of the Wind : one activity spending a Focus Point, and uses of its own. Made like Patient Defense :
   * no uses of its own, the free activity (Dash) beside the Focus Point one (Dash and Disengage).
   * @returns {object|null}  the update, null : nothing to change
   */
  static stepUpdate(item){
    if((item?.type !== "feat") || ![this.STEP, this.POOL].includes(idOf(item))) return null;
    const activities = item.system.activities?.contents ?? [...(item.system.activities ?? [])];
    /* Its own item : every activity is it; on Monk's Focus : by name */
    const steps = (idOf(item) === this.STEP) ? activities : activities.filter(a => this.kindOf(a) === this.STEP);
    if(steps.length !== 1) return null;
    const paid = steps[0];
    if(!(paid.consumption?.targets ?? []).some(t => t.type === "itemUses")) return null;
    const source = foundry.utils.deepClone(paid.toObject?.() ?? paid);
    const id = foundry.utils.randomID();
    const name = (idOf(item) === this.STEP) ? item.name : (paid.name || item.name);
    return {
      /* Its own item (Plutonium's) : its uses were the Focus Points' copy */
      ...((idOf(item) === this.STEP) ? { "system.uses.max" : "", "system.uses.spent" : 0 } : {}),
      [`system.activities.${paid.id}.name`] : module.format("classes.monk.stepFocusName", { item : name }),
      [`system.activities.${id}`] : { ...source, _id : id, name, effects : [], consumption : { ...(source.consumption ?? {}), targets : [] }, sort : (source.sort ?? 0) + 1 },
    };
  }

  /* ---------- Deflect Attacks ---------- */

  static #redirectType = null;

  /* The Monks whose Flurry of Blows is being made (their strikes' cards are marked) */

  /* This attack's damage rolls (its own and its extra boxes), for one attack on the card */
  static attackDamage(message, ray){
    const card = message.system;
    const base = (Number.isInteger(ray) ? card.rayDamage?.(ray) : card.damageRolls) ?? [];
    const extra = Number.isInteger(ray) ? (card.rayDamage?.(ray, "extra") ?? []) : (card.extraRolls?.(null) ?? []);
    return [...base, ...extra];
  }

  /* The Monk's tokens this attack hit, that can deflect it now */
  static deflectors(message, ray){
    if((message.type !== TYPES.attack) || !message.system?.isHitOn?.(ray)) return [];
    const rolls = this.attackDamage(message, ray);
    if(!rolls.some(r => this.DEFLECTED.includes(r.options?.type))) return [];
    return (message.system.hitTargets?.(ray) ?? []).map(t => tokenOf(t)).filter(t => t?.actor?.isOwner
      && t.actor.items.some(i => idOf(i) === this.DEFLECT) && !actionTracker.OUT_OF_ACTION.some(s => t.actor.statuses?.has?.(s)));
  }

  static deflectButtons(message, buttons, ray){
    if(!this.enabled()) return;
    for(const token of this.deflectors(message, ray)){
      const item = token.actor.items.find(i => idOf(i) === this.DEFLECT);
      if(!cutsOf(message, token).some(c => c.id === this.DEFLECT)){
        if(actionTracker.left(token.actor, "reaction")) buttons.push({ id : `deflect|${token.document.uuid}`, icon : "fa-hand", label : item.name });
        continue;
      }
      /* Brought to 0 : Redirect, once */
      const done = token.actor.getFlag(module.id, "deflect");
      const focus = this.focusOf(token.actor);
      if((done?.message === message.id) && ((done.ray ?? null) === ray) && done.zero && !done.redirected && (!focus || (Number(focus.system.uses?.value) > 0))){
        buttons.push({ id : `redirect|${token.document.uuid}`, icon : "fa-arrow-rotate-left", label : module.i18n("classes.monk.redirect") });
      }
    }
  }

  /* 1d10 + DEX + Monk level off this card's damage to the Monk */
  static async deflect(message, ray, uuid){
    const token = tokenOf(fromUuidSync(uuid, { strict : false }));
    if(!this.enabled() || !token || !this.deflectors(message, ray).includes(token)) return;
    const actor = token.actor;
    const item = actor.items.find(i => idOf(i) === this.DEFLECT);
    const roll = await new Roll("1d10 + @abilities.dex.mod + @classes.monk.levels", actor.getRollData()).evaluate();
    const { rollItem } = await import('../../roll-item/roll-item.js');
    await rollItem.showDice([roll], message);
    if(!await cutDamage(message, token, { id : this.DEFLECT, amount : roll.total, by : token.name, label : item.name, formula : roll.formula, result : roll.result })) return;
    await actionTracker.spend(actor, { kind : "reaction", what : item.name }).catch(() => null);
    const rolls = this.attackDamage(message, ray);
    const total = rolls.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
    const activity = message.getAssociatedActivity?.();
    let action = "";
    try { action = String(activity?.getActionType?.(message.system.attackOf?.(ray)?.options?.attackMode) ?? ""); } catch {}
    const type = rolls.map(r => r.options?.type).find(t => this.DEFLECTED.includes(t)) ?? "bludgeoning";
    await actor.setFlag(module.id, "deflect", { message : message.id, ray, zero : roll.total >= total, melee : !action.startsWith("r"), type, redirected : false });
    /* Redirect's button reads that flag : drawn again now */
    ui.chat?.updateMessage(message);
    log.debug("Deflect Attacks", actor.name, roll.total, "of", total);
  }

  /* The attack's force back at a creature : the item's Redirect save, at it, the attack's damage type */
  static async redirect(message, ray, uuid){
    const token = tokenOf(fromUuidSync(uuid, { strict : false }));
    const actor = token?.actor;
    const done = actor?.getFlag(module.id, "deflect");
    if(!actor?.isOwner || !done?.zero || done.redirected || (done.message !== message.id)) return;
    const item = actor.items.find(i => idOf(i) === this.DEFLECT);
    const activity = [...(item?.system?.activities ?? [])].find(a => a.type === "save");
    if(!activity) return ui.notifications.warn(module.format("classes.monk.noRedirect", { item : item?.name ?? "" }));
    const [target] = await pickTargets(token, { count : 1, range : done.melee ? 5 : 60, disposition : "any", confirm : "auto", useTargets : false,
      filter : t => (t !== token) }) ?? [];
    if(!target) return;
    this.#redirectType = { item : item.id, type : done.type, at : Date.now() };
    const card = await cardBuilder.roll(item, { activity : activity.id, targets : [target], damageType : done.type });
    if(card) await actor.setFlag(module.id, "deflect", { ...done, redirected : true });
  }
}
