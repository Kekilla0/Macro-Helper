import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { idOf } from '../helpers/utils.js';
import { tokenOf, distanceBetween } from '../helpers/tokens.js';
import { isAlly } from '../helpers/targets.js';
import { giveMode } from '../roll-item/reasons.js';
import { TYPES } from '../roll-item/message.js';
import { rollModes } from './roll-modes.js';
import { actionTracker } from './action-tracker.js';
import { patch } from '../patch.js';
import { uses } from '../uses.js';
import { chooseOption } from '../helpers/utils.js';
import { actions } from './actions.js';
import { compendiums } from './compendiums.js';
import { dragsFreely } from './movement.js';
const log = logger.for(import.meta.url);

/**
 * Common creature traits, recognised by name on the creature (no macro needed) :
 *   Pack Tactics : advantage on an attack roll against a creature when one of its allies (not Incapacitated) is within
 *                  5 ft of that creature. Also shown by the target picker.
 *   Magic Resistance : advantage on saving throws against spells and other magical effects (a spell, or an item with
 *                  the Magical property, as the save's card says).
 *   Incorporeal Movement : it moves through other creatures (their spaces difficult terrain, as dnd5e counts them);
 *                  through objects and walls, and the damage for ending inside one, stay with the GM.
 *   Parry        : a melee attack roll hits it while it holds a weapon : a Parry button on the attack card (its owner,
 *                  the GM) : its Reaction, +2 AC against that attack (the hit judged again).
 *   Abduct       : dragging a creature it grapples costs no extra movement (dragsFreely).
 *   Nimble Escape : using it takes the Disengage or Hide action (asked), as its Bonus Action; a creature without that
 *                  Default Action's item gets a copy from Macro Helper's Actions compendium first.
 * Flyby is with the Opportunity Attacks (action-ready.js).
 */
export class creatureTraits{
  static PARRY_AC = 2;
  static OUT = ["incapacitated", "unconscious", "paralyzed", "petrified", "stunned", "dead"];

  static enabled(){
    return (game.system.id === "dnd5e") && !!settings.value("featRules");
  }

  /* By identifier, or by name : case and anything in parentheses ignored ("Relentless Endurance (1/Day)") */
  static has(actor, name){
    return !!this.itemOf(actor, name);
  }

  static isTrait(item, name){
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const plain = n => String(n ?? "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    /* A Battle Master's maneuver of the same name (Parry) isn't the creature trait */
    return !!item && (item.system?.type?.subtype !== "maneuver") && ((idOf(item) === slug) || (plain(item.name) === plain(name)));
  }

  static itemOf(actor, name){
    return actor?.items?.find?.(i => this.isTrait(i, name)) ?? null;
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    rollModes.add("packTactics", config => this.packTactics(config));
    Hooks.on("dnd5e.preRollSavingThrowV2", (config, dialog, message) => this.magicResistance(config, message));
    const self = this;
    patch.wrap("CONFIG.Token.objectClass.prototype.constrainMovementPath", function(wrapped, waypoints, options = {}){
      if(self.enabled() && self.has(this.actor, "Incorporeal Movement")) options = { ...options, ignoreTokens : true };
      return wrapped(waypoints, options);
    });
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, context) => this.parryButtons(message, buttons, context));
    Hooks.on(`${module.id}.cardButton`, (message, id) => { if(String(id).startsWith("traitParry|")) this.parry(message, String(id).slice(11)); });
    gm.handle("traitParry", (data, user) => this.parryAsGM(data, user));
    dragsFreely(actor => this.enabled() ? this.itemOf(actor, "Abduct") : null, { id : "abduct" });
    uses.onActivity("nimbleEscape", (activity, ctx, next) => this.nimbleEscape(activity, ctx, next));
  }

  /* ---------- Nimble Escape ---------- */

  static async nimbleEscape(activity, ctx, next){
    if(!this.enabled() || !this.isTrait(activity?.item, "Nimble Escape") || !activity.actor?.isOwner) return next();
    const actor = activity.getUsageToken?.()?.actor ?? activity.actor;
    const id = await chooseOption({ title : activity.item.name, icon : "fa-solid fa-person-running", prompt : module.i18n("traits.nimbleEscape"),
      options : [actions.DISENGAGE, actions.HIDE].map(value => ({ value, label : module.i18n(`traits.nimble.${value}`) })) });
    if(!id) return null;
    await this.defaultActionItem(actor, id);
    return actions.useDefault(actor, id, { economy : "bonus" });
  }

  /* The creature's Default Action item, copied from the Actions compendium when it has none */
  static async defaultActionItem(actor, id){
    const had = actor.items.find(i => idOf(i) === id);
    if(had) return had;
    const pack = compendiums.pack(compendiums.ACTIONS);
    const entry = pack ? [...await pack.getIndex({ fields : ["system.identifier"] })].find(e => e.system?.identifier === id) : null;
    const source = entry ? await pack.getDocument(entry._id) : null;
    if(!source) return null;
    const [made] = await actor.createEmbeddedDocuments("Item", [source.toObject()]);
    log.debug("Nimble Escape : gave", actor.name, made?.name);
    return made ?? null;
  }

  /* ---------- Pack Tactics ---------- */

  static packTactics(config){
    if(!this.enabled()) return;
    const attacker = config.subject?.actor;
    if(!this.has(attacker, "Pack Tactics")) return;
    const uuid = config[module.id]?.target;
    const target = uuid ? (fromUuidSync(uuid, { strict : false })?.object ?? null) : null;
    const me = tokenOf(attacker);
    if(!target || !me) return;
    const ally = canvas.tokens.placeables.find(t => (t !== me) && (t !== target) && t.actor && isAlly(t, me)
      && !this.OUT.some(s => t.actor.statuses?.has?.(s)) && (distanceBetween(t, target) <= 5));
    if(ally) giveMode(config.rolls[0], "advantage", module.format("traits.packTactics", { name : ally.name }));
  }

  /* ---------- Magic Resistance ---------- */

  static magicResistance(config, message){
    const actor = config?.subject;
    if(!this.enabled() || !this.has(actor, "Magic Resistance")) return;
    const card = game.messages.get(message?.data?.system?.origin?.id ?? message?.data?.system?.origin);
    const item = card?.getAssociatedItem?.();
    const magical = (item?.type === "spell") || !!item?.system?.properties?.has?.("mgc");
    if(!magical) return;
    if(config.rolls?.[0]) giveMode(config.rolls[0], "advantage", module.i18n("traits.magicResistance"));
    else config.advantage = true;
  }

  /* ---------- Parry ---------- */

  static parryKey(uuid){
    return `parried.${String(uuid).replaceAll(".", "-")}`;
  }

  static holdsWeapon(actor){
    return !!actor?.items?.some?.(i => (i.type === "weapon") && (i.system?.equipped || (actor.type === "npc")) && (i.system?.type?.value !== "natural"));
  }

  /* Attack cards : a melee hit on a creature with Parry, holding a weapon, its Reaction left */
  static parryButtons(message, buttons, { ray } = {}){
    if(!this.enabled() || (message.type !== TYPES.attack) || (typeof message.system?.raiseAC !== "function")) return;
    const attack = message.system.attackOf?.(ray);
    if(!attack || attack.isCritical) return;
    const activity = message.getAssociatedActivity?.();
    const melee = (activity?.attack?.type?.value ?? "melee") === "melee";
    if(!melee) return;
    for(const hit of message.system.hitTargets?.(ray) ?? []){
      const token = hit?.document ?? hit;
      const actor = token?.actor;
      if(!actor || !(game.user.isGM || actor.isOwner) || message.getFlag(module.id, this.parryKey(token.uuid))) continue;
      if(!this.has(actor, "Parry") || !this.holdsWeapon(actor) || this.OUT.some(s => actor.statuses?.has?.(s)) || !actionTracker.left(actor, "reaction")) continue;
      buttons.push({ id : `traitParry|${token.uuid}`, icon : "fa-shield", label : module.i18n("traits.parry"),
        tooltip : module.format("traits.parryTip", { name : token.name, ac : this.PARRY_AC }) });
    }
  }

  static async parry(message, uuid){
    const token = fromUuidSync(uuid, { strict : false });
    if(!token?.actor || message.getFlag(module.id, this.parryKey(uuid))) return;
    const ok = await gm.run("traitParry", { message : message.id, target : uuid });
    if(ok) await actionTracker.spend(token.actor, { kind : "reaction", what : module.i18n("traits.parry") }).catch(() => null);
  }

  /* GM : the card remembers it, and the hit is judged again at AC +2 */
  static async parryAsGM({ message : id, target : uuid } = {}, user){
    const message = game.messages.get(id);
    const token = fromUuidSync(uuid ?? "", { strict : false });
    if(!message || !token?.actor || !(user.isGM || token.actor.testUserPermission(user, "OWNER")) || message.getFlag(module.id, this.parryKey(uuid))) return false;
    await message.setFlag(module.id, this.parryKey(uuid), true);
    await message.system.raiseAC(uuid, this.PARRY_AC);
    log.debug("Parry", token.name);
    return true;
  }
}

/* ---------- The sense lego ---------- */

const senses = new Map();
let sensesPatched = false;

/**
 * A detection mode on the tokens of every creature that has a feature (Devil's Sight; a devil's own; a homebrew
 * "sees invisible creatures within 30 ft"). The mode itself is Foundry's or one registered in
 * CONFIG.Canvas.detectionModes (Devil's Sight : "devilsSight"); Vision Rules count it like any sense.
 *
 *   addSense("devilsSight", { feature : "devils-sight", mode : "devilsSight", range : 120 });
 *   addSense("trueSight", { feature : actor => actor.name === "Lich", mode : "seeAll", range : 120 });
 *
 * feature   the item (identifier) the creature has, or (actor) => boolean
 * mode      the detection mode's id
 * range     feet
 * enabled() the rule's setting
 * The same id again replaces it (a macro).
 */
export function addSense(id, { feature, mode, range = 60, enabled = null } = {}){
  if(!id || !feature || !mode) return;
  senses.set(id, { feature, mode, range, enabled });
  if(!sensesPatched){
    sensesPatched = true;
    patch.wrap("CONFIG.Token.documentClass.prototype._prepareDetectionModes", function(wrapped, ...args){
      try {
        for(const sense of senses.values()){
          if(sense.enabled && !sense.enabled()) continue;
          const actor = this.actor;
          const has = (typeof sense.feature === "function") ? sense.feature(actor) : actor?.items?.some?.(i => idOf(i) === sense.feature);
          if(has) this.detectionModes[sense.mode] ??= { enabled : true, range : sense.range };
        }
      }
      catch(error){ log.debug("Sense", error); }
      return wrapped(...args);
    });
  }
  /* Added after the world loaded (a macro) : the tokens on the map see with it now */
  if(game.ready && canvas.ready){
    for(const token of canvas.tokens.placeables) token.document.reset?.();
    canvas.perception?.update?.({ initializeVision : true, refreshVision : true });
  }
}

