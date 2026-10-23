import { module } from '../../module.js';
import { idOf, buttonRow, addButton, wait, waitFor } from '../../helpers/utils.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { hasShieldEquipped } from '../../helpers/items.js';
import { actions } from '../actions.js';
import { weaponUses } from '../weapon-uses.js';
import { uses } from '../../uses.js';
import { initiative } from '../initiative.js';
import { itemFixes } from '../item-fixes.js';
import { tokenOf } from '../../helpers/tokens.js';
import { pickTargets } from '../../helpers/targets.js';
import { cutDamage, cutsOf } from '../../roll-item/damage-cuts.js';
import { cardBuilder } from '../../roll-item/card-builder.js';
import { actionTracker } from '../action-tracker.js';
import { TYPES } from '../../roll-item/message.js';
const log = logger.for(import.meta.url);

/**
 * Monk, levels 1-2 (Classes setting). Unarmored Defense is dnd5e's own AC. Works with either layout : dnd5e's own (one
 * "Monk's Focus" item holding the Focus Points, with Flurry of Blows, Patient Defense and Step of the Wind as its
 * activities) or separate items (Plutonium's : a "Focus Point" item, and one item each).
 *
 *   Martial Arts       : while wearing no armor and holding no shield, an Unarmed Strike or Monk weapon (Simple melee,
 *                        Martial melee with Light) uses the better of STR and DEX, and the Martial Arts die instead of
 *                        its own when that's bigger. Done as dnd5e prepares the weapon, so the sheet, the card and the
 *                        rolls all show it (Plutonium's enchantment would force the die, and stay on in armor). The
 *                        bonus Unarmed Strike waits for the action tracker.
 *   Flurry of Blows    : a Focus Point, then the character's own Unarmed Strike twice (three times from level 10), each
 *                        its own use : Attack, Grapple or Shove.
 *   Patient Defense    : the free use : Disengage; with a Focus Point : Disengage and Dodge (the Default Actions' marks).
 *   Step of the Wind   : like Patient Defense : the free use : Dash; with a Focus Point : Dash and Disengage. Plutonium's
 *                        item (one Focus Point activity, its own uses) is given the free activity when it lands.
 *   Unarmored Movement : its speed only while wearing no armor and holding no shield (its effect follows).
 *   Uncanny Metabolism : (Homebrew's Initiative Each Round : only the combat's first roll) a button on the Monk's initiative roll (its owner and the GM) while its use is left : uses
 *                        the item (Focus Points back, the healing roll).
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
    /* Patient Defense / Step of the Wind : the Default Actions' marks are put on instead of the item's own effects
       (dnd5e's Monk's Focus carries a Dodging effect that never ends) */
    Hooks.on(`${module.id}.selfEffects`, activity => !(this.enabled() && [...this.FOCUS, this.PATIENT, this.STEP].includes(idOf(activity?.item))));
    for(const hook of ["createItem", "updateItem", "deleteItem"]){
      Hooks.on(hook, (item, ...rest) => { if(rest.at(-1) === game.user.id) this.syncMovement(item?.parent); });
    }
    /* What's in the hands changed (a shield) */
    Hooks.on("updateActor", (actor, changes, options, userId) => {
      if((userId === game.user.id) && foundry.utils.hasProperty(changes ?? {}, `flags.${module.id}.hands`)) this.syncMovement(actor);
    });
    /* Step of the Wind with only its Focus Point use : the free Dash added (dnd5e's and Plutonium's) */
    itemFixes.add({ name : "Step of the Wind", where : "owned", plan : item => { const update = this.stepUpdate(item); return update ? { update } : null; } });
    /* Uncanny Metabolism : on the initiative roll */
    Hooks.on("macro-helper.initiativeFeet", (combatant, add) => this.metabolismFoot(combatant, add));
    /* Used : the cards show it greyed, on every client */
    Hooks.on("updateItem", item => { if(idOf(item) === this.METABOLISM) this.redrawMetabolism(item.actor); });
    Hooks.on("dnd5e.renderChatMessage", (message, html) => this.metabolismMessage(message, html));
    /* Flurry of Blows : the Unarmed Strike, not its own attack (an item of its own, or Monk's Focus's activity) */
    uses.onItem("flurry", (item, ctx, next) => {
      if(this.isMonk(item.actor) && (idOf(item) === this.FLURRY) && this.unarmedOf(item.actor)) return this.flurry(item, ctx.config, ctx.dialog, ctx.message);
      return next();
    });
    uses.onActivity("flurry", (activity, ctx, next) => {
      if(this.isMonk(activity.actor) && (idOf(activity.item) === this.POOL) && (this.kindOf(activity) === this.FLURRY) && this.unarmedOf(activity.actor)){
        return this.flurry(activity.item, ctx.config, ctx.dialog, ctx.message);
      }
      return next();
    });
    /* A Flurry of Blows strike's card says so (Open Hand Technique) : flags["macro-helper"].flurry */
    Hooks.on("preCreateChatMessage", (message, data, options, userId) => {
      if((userId !== game.user.id) || !this.#flurrying.size || (message.type !== TYPES.attack)) return;
      const actor = ChatMessage.implementation.getSpeakerActor(message.speaker);
      if(actor && this.#flurrying.has(actor.uuid)) message.updateSource({ [`flags.${module.id}.flurry`] : true });
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
    const armor = actor?.items?.some?.(i => (i.type === "equipment") && ["light", "medium", "heavy"].includes(i.system.type?.value) && i.system.equipped);
    return !armor && !hasShieldEquipped(actor);
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

  /* A Focus Point, then the Unarmed Strike two times (three from level 10), each Attack, Grapple or Shove. The first
     closed : the point back; a later one closed : the rest skipped */
  static async flurry(item, config = {}, dialog = {}, message = {}){
    const actor = item.actor;
    const focus = this.focusOf(actor);
    if(focus && !(Number(focus.system.uses?.value) > 0)){
      ui.notifications.warn(module.format("classes.monk.noFocus", { name : actor.name, item : focus.name }));
      return null;
    }
    if(focus) await focus.update({ "system.uses.spent" : (Number(focus.system.uses?.spent) || 0) + 1 });
    const strike = this.unarmedOf(actor);
    const count = 2 + Math.min(1, Math.floor((Number(actor.classes.monk.system?.levels) || 1) / 10));
    const results = [];
    this.#flurrying.add(actor.uuid);
    try {
      for(let i = 0; i < count; i++){
        /* Action Tracker : the first strike is the Bonus Action, the others come with it */
        const used = await this.untilShown(() => strike.use({ event : config.event, [module.id] : { economy : i ? "free" : "bonus" } }, { ...dialog }, { ...message }));
        if(!used) break;
        results.push(used);
      }
    }
    finally {
      this.#flurrying.delete(actor.uuid);
      if(!results.length && focus) await focus.update({ "system.uses.spent" : Math.max(0, (Number(focus.system.uses?.spent) || 1) - 1) });
    }
    log.debug("Flurry of Blows", actor.name, results.length, "of", count);
    return results.at(-1) ?? null;
  }

  /**
   * Run a use, then wait until the cards it made are shown : Dice So Nice's dice landed, Roll Item's staged card
   * revealed (each at most a few seconds). The next strike's window opens after the first one's result.
   */
  static async untilShown(fn){
    const made = [], landed = new Set();
    const onCreate = (message, options, userId) => { if(userId === game.user.id) made.push(message); };
    const onLanded = id => landed.add(id);
    Hooks.on("createChatMessage", onCreate);
    Hooks.on("diceSoNiceRollComplete", onLanded);
    try {
      const result = await fn();
      /* Roll Item picks and makes its card after the use : closed (nothing rolled) counts as not used */
      if(result?.[module.id]?.card && !(await uses.cardOf(result))) return null;
      /* A card can still be on its way */
      await wait(300);
      for(const message of made){
        const live = game.messages.get(message.id) ?? message;
        /* Roll Item's staged card : attack, then damage (it plays its own dice) */
        if(live.getFlag?.(module.id, "reveal") !== undefined){
          await waitFor(() => (game.messages.get(message.id)?.getFlag(module.id, "reveal") ?? 2) >= 2, { timeout : 15000 });
          continue;
        }
        if(game.dice3d && live.rolls?.length && !live.getFlag?.("dice-so-nice", "skip")) await waitFor(() => landed.has(message.id), { timeout : 10000 });
      }
      return result;
    }
    finally {
      Hooks.off("createChatMessage", onCreate);
      Hooks.off("diceSoNiceRollComplete", onLanded);
    }
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
    if(id === this.PATIENT){
      await actions.mark(own, "disengage", "actions.disengage.mark", "icons/skills/movement/arrow-upward-yellow.webp");
      if(focus) await actions.dodge(own);
    }
    else {
      await actions.mark(own, "dash", "actions.dash.mark", "icons/skills/movement/feet-winged-boots-glowing-yellow.webp");
      if(focus) await actions.mark(own, "disengage", "actions.disengage.mark", "icons/skills/movement/arrow-upward-yellow.webp");
    }
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

  /* ---------- Unarmored Movement ---------- */

  static async syncMovement(actor){
    if(!this.isMonk(actor) || !actor.isOwner) return;
    const item = actor.items.find(i => idOf(i) === this.MOVEMENT);
    if(!item) return;
    const disabled = !this.unarmored(actor);
    const updates = item.effects.filter(e => e.transfer && (e.disabled !== disabled)).map(e => ({ _id : e.id, disabled }));
    if(updates.length) await item.updateEmbeddedDocuments("ActiveEffect", updates);
  }

  /* ---------- Uncanny Metabolism ---------- */

  /**
   * Its button on a roll (for its owner and the GM) : usable while its use is left, greyed once used on this roll.
   * @param {Actor} actor
   * @param {string} key   the roll : "<combat>.<round>" (the round's card) or a message id
   * @returns {{ item : Item, used : boolean }|null}
   */
  static metabolismOf(actor, key){
    if(!this.isMonk(actor) || !actor.isOwner) return null;
    const item = actor.items.find(i => idOf(i) === this.METABOLISM);
    if(!item) return null;
    if(Number(item.system.uses?.value) > 0) return { item, used : false };
    return (item.getFlag(module.id, "usedOn") === key) ? { item, used : true } : null;
  }

  static async useMetabolism(item, key){
    const activity = item.system.activities?.contents?.[0] ?? [...(item.system.activities ?? [])][0];
    const result = await (activity ? activity.use({}, { configure : false }) : item.use({}, { configure : false }));
    if(result) await item.setFlag(module.id, "usedOn", key);
    return result;
  }

  /* The cards with its button drawn again (greyed) */
  static redrawMetabolism(actor){
    if(game.combat) initiative.redraw(game.combat);
    const latest = game.messages.contents.findLast(m => m.getFlag?.("core", "initiativeRoll") && (m.speaker?.actor === actor?.id));
    if(latest) ui.chat?.updateMessage(latest);
  }

  static metabolismLabel(item, name){
    return module.format("requests.featFor", { feat : item.name, name });
  }

  /* The compact initiative card : at its foot */
  /* "When you roll Initiative" : once a combat. Homebrew's Initiative Each Round re-rolls it every round : only the
     combat's first roll offers it (it can't be saved for later) */
  static firstInitiative(combat){
    return !settings.value("homebrewInitiative") || !combat || ((Number(combat.round) || 0) <= 1);
  }

  static metabolismFoot(combatant, add){
    const combat = combatant?.combat ?? combatant?.parent;
    const key = `${combat?.id}.${combat?.round}`;
    const found = this.metabolismOf(combatant?.actor, key);
    if(found && !found.used && !this.firstInitiative(combat)) return;
    if(found) add("fa-yin-yang", this.metabolismLabel(found.item, combatant.name), () => this.useMetabolism(found.item, key), { disabled : found.used });
  }

  /* dnd5e's own initiative message (Compact Initiative off) : the Monk's latest one */
  static metabolismMessage(message, html){
    if(!message?.getFlag?.("core", "initiativeRoll")) return;
    const actor = ChatMessage.implementation.getSpeakerActor?.(message.speaker) ?? game.actors.get(message.speaker?.actor);
    const found = this.metabolismOf(actor, message.id);
    if(!found) return;
    if(!found.used && !this.firstInitiative(game.combat)) return;
    const latest = game.messages.contents.findLast(m => m.getFlag?.("core", "initiativeRoll") && (m.speaker?.actor === message.speaker?.actor));
    if(latest && (latest.id !== message.id)) return;
    if(html.querySelector(`.${module.id}-initiative-feet`)) return;
    addButton(buttonRow(html, { key : `${module.id}-initiative-feet` }),
      initiative.footButton("fa-yin-yang", this.metabolismLabel(found.item, actor.name), () => this.useMetabolism(found.item, message.id), { disabled : found.used }));
  }
  /* ---------- Deflect Attacks ---------- */

  static #redirectType = null;

  /* The Monks whose Flurry of Blows is being made (their strikes' cards are marked) */
  static #flurrying = new Set();

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
