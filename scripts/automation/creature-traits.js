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
const log = logger.for(import.meta.url);

/**
 * Common creature traits, recognised by name on the creature (no macro needed) :
 *   Pack Tactics : advantage on an attack roll against a creature when one of its allies (not Incapacitated) is within
 *                  5 ft of that creature. Also shown by the target picker.
 *   Magic Resistance : advantage on saving throws against spells and other magical effects (a spell, or an item with
 *                  the Magical property, as the save's card says).
 *   Parry        : a melee attack roll hits it while it holds a weapon : a Parry button on the attack card (its owner,
 *                  the GM) : its Reaction, +2 AC against that attack (the hit judged again).
 * Flyby is with the Opportunity Attacks (action-ready.js).
 */
export class creatureTraits{
  static PARRY_AC = 2;
  static OUT = ["incapacitated", "unconscious", "paralyzed", "petrified", "stunned", "dead"];

  static enabled(){
    return (game.system.id === "dnd5e") && !!settings.value("featRules");
  }

  static has(actor, name){
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return !!actor?.items?.some?.(i => (idOf(i) === slug) || ((i.name ?? "").toLowerCase() === name.toLowerCase()));
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    rollModes.add("packTactics", config => this.packTactics(config));
    Hooks.on("dnd5e.preRollSavingThrowV2", (config, dialog, message) => this.magicResistance(config, message));
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, context) => this.parryButtons(message, buttons, context));
    Hooks.on(`${module.id}.cardButton`, (message, id) => { if(String(id).startsWith("parry|")) this.parry(message, String(id).slice(6)); });
    gm.handle("traitParry", (data, user) => this.parryAsGM(data, user));
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
      buttons.push({ id : `parry|${token.uuid}`, icon : "fa-shield", label : module.i18n("traits.parry"),
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
