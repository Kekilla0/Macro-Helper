import { module } from '../module.js';
import { idOf, esc, whisperOwners } from '../helpers/utils.js';
import { rollModes } from './roll-modes.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { tokenOf, distanceBetween, canSee } from '../helpers/tokens.js';
import { hasShieldEquipped } from '../helpers/items.js';
import { addTimedEffect } from '../helpers/actors.js';
import { giveMode } from '../roll-item/reasons.js';
import { masteries } from './masteries.js';
import { conditions } from './conditions.js';
import { limits } from './limits.js';
import { hands } from './hands.js';
const log = logger.for(import.meta.url);

/**
 * The Fighting Style feats (Feats setting), found by identifier : "dueling", or "fighting-style-dueling" when taken
 * through the class feature. Plutonium's data : Archery, Defense, Dueling and Blind Fighting come with effects,
 * Interception and Protection with an activity, Unarmed Fighting with attacks of its own; the rest with nothing.
 *
 *   Archery         : Plutonium's +2 to ranged weapon attacks; a thrown melee weapon (dnd5e counts it as a ranged
 *                     weapon attack) gets it taken off again : it isn't a Ranged weapon.
 *   Defense         : Plutonium's +1 AC only while armor (light, medium, heavy) is worn : its effect is switched off
 *                     and on as armor is equipped.
 *   Dueling         : +2 damage with a melee weapon held in one hand and no other weapon (a shield is fine). With
 *                     Plutonium's always-on effect, the +2 is taken off attacks that don't qualify.
 *   Great Weapon    : a melee weapon held in two hands (Two-Handed, or Versatile used two-handed) : 1s and 2s on the
 *                     attack's damage dice count as 3.
 *   Thrown Weapon   : +2 damage on a ranged attack with a Thrown weapon.
 *   Two-Weapon      : the Light weapon's extra attack (off-hand, Nick) adds the ability modifier dnd5e leaves out.
 *   Blind Fighting  : Plutonium's Blindsight 10 ft (the vision rules use it).
 *   Unarmed         : the Unarmed Strike does 1d6 + STR bludgeoning, 1d8 holding no weapon or shield (the feat's own
 *                     attacks aren't needed). At the start of its turn, a card offers 1d4 to each creature it grapples.
 *   Interception    : an attack hits a creature within 5 ft of yours : Intercept on the card (its owner) rolls 1d10 +
 *                     Proficiency, and the damage applied to that creature from the card is that much lower.
 *   Protection      : a creature within 5 ft of yours is attacked : Protect on the card adds a second d20, keeping the
 *                     lower (Disadvantage; after the roll, unlike the rule's timing). It is then Protected until the
 *                     start of your next turn : attacks against it have Disadvantage while you're within 5 ft with a shield.
 * Interception and Protection need a shield (Interception : or a Simple / Martial weapon) and to see the attacker :
 * Rule Limits decides (Warn : the button, with a notice; Block : no button).
 */
export class fightingStyles{
  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("featRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.preRollAttackV2", config => this.onPreRollAttack(config));
    rollModes.add("protection", config => this.protectedMode(config));
    Hooks.on("dnd5e.preRollDamageV2", config => this.onPreRollDamage(config));
    Hooks.on("dnd5e.calculateDamage", (actor, damages, options) => this.intercepted(actor, damages, options));
    for(const hook of ["createItem", "updateItem", "deleteItem"]){
      Hooks.on(hook, (item, ...rest) => this.onGear(item, rest.at(-1)));
    }
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, context) => this.cardButtons(message, buttons, context));
    Hooks.on(`${module.id}.cardButton`, (message, id, context) => this.cardClicked(message, id, context));
    Hooks.on(`${module.id}.cardNotes`, (message, notes, { ray } = {}) => { if(!Number.isInteger(ray)) notes.push(...this.cardNotes(message)); });
    Hooks.on(`${module.id}.turnStart`, (combat, combatant) => this.onTurn(combat, combatant));
    Hooks.on("renderChatMessageHTML", (message, html) => this.wireGrappleCard(message, html));
    gm.handle("intercept", (data, user) => this.interceptAsGM(data, user));
    gm.handle("protect", (data, user) => this.protectAsGM(data, user));
  }


  /* The creature's Fighting Style feat of this kind */
  static styleOf(actor, style){
    if(!this.enabled()) return null;
    return actor?.items?.find?.(i => [style, `fighting-style-${style}`].includes(idOf(i))) ?? null;
  }

  /* Its transfer effect is on (Plutonium's Archery / Defense / Dueling) */
  static effectOn(item){
    return !!item?.effects?.some?.(e => e.transfer && !e.disabled);
  }

  /* ---------- What the attack is ---------- */

  static attackInfo(config){
    const activity = config?.subject;
    const item = activity?.item;
    if((activity?.type !== "attack") || (item?.type !== "weapon")) return null;
    const mode = String(config.attackMode ?? config.rolls?.[0]?.options?.attackMode ?? "");
    const props = item.system.properties ?? new Set();
    const melee = String(item.system.type?.value ?? "").endsWith("M");
    const thrown = mode.startsWith("thrown");
    return { activity, item, actor : activity.actor, mode, props, melee, thrown, twoHanded : props.has("two") || (mode === "twoHanded"),
      unarmed : idOf(item) === "unarmed-strike" };
  }

  /* Other weapons in hand (natural weapons and Unarmed Strike don't count) */
  static otherWeapons(actor, item){
    /* Hands : the weapons held */
    /* Hands : the weapons held, and anything held that was swung as a weapon this turn (a torch) */
    if(hands.manages(actor)) return hands.heldItems(actor).filter(i => (i.id !== item?.id)
      && (((i.type === "weapon") && (i.system.type?.value !== "natural")) || hands.wieldedThisTurn(actor, i)));
    return (actor?.items ?? []).filter(i => (i.id !== item?.id) && (i.type === "weapon") && i.system.equipped
      && (i.system.type?.value !== "natural") && (idOf(i) !== "unarmed-strike"));
  }

  static addPart(roll, part){
    roll.parts = [...(roll.parts ?? []), part];
  }

  /* ---------- Attacks : Archery, Protection ---------- */

  static onPreRollAttack(config){
    if(!this.enabled()) return;
    const roll = config.rolls?.[0];
    const info = this.attackInfo(config);
    if(roll && info){
      /* Archery : +2 with Ranged weapons. Plutonium's own effect gives it to any ranged weapon attack, a thrown melee
         weapon too (taken off again); the compendium's feat has no effect, it's added here when it applies */
      const archery = this.styleOf(info.actor, "archery");
      if(archery){
        const ranged = !info.melee;
        if(this.effectOn(archery) && info.melee && info.thrown) this.addPart(roll, "-2");
        else if(!this.effectOn(archery) && ranged) this.addPart(roll, "2");
      }
    }
  }

  /* Protected : Disadvantage while its protector is within 5 ft with a shield */
  static protectedMode(config){
    if(!this.enabled()) return;
    const roll = config.rolls?.[0];
    const target = conditions.targetOf(config);
    const protector = target && this.protectorOf(target);
    if(roll && protector){
      roll.options ??= {};
      giveMode(roll, "disadvantage", module.format("fightingStyles.protected", { name : protector.name }));
    }
  }

  /* The token protecting this one now, if it's still within 5 ft, holding a shield */
  static protectorOf(target){
    const uuid = target?.document?.uuid ?? target?.uuid;
    for(const by of canvas.tokens?.placeables ?? []){
      const mark = by.actor?.effects?.find?.(e => e.getFlag(module.id, "protection")?.target === uuid);
      if(mark && (distanceBetween(by, target) <= 5) && hasShieldEquipped(by.actor)) return by;
    }
    return null;
  }

  /* ---------- Damage : Dueling, Great Weapon, Thrown Weapon, Two-Weapon, Unarmed ---------- */

  static onPreRollDamage(config){
    if(!this.enabled()) return;
    const info = this.attackInfo(config);
    const roll = config.rolls?.[0];
    if(!info || !roll) return;
    const { actor, item } = info;

    /* Dueling */
    const dueling = this.styleOf(actor, "dueling");
    if(dueling){
      const qualifies = info.melee && !info.thrown && !info.twoHanded && !info.unarmed && !this.otherWeapons(actor, item).length;
      const given = this.effectOn(dueling);
      if(given && !qualifies) this.addPart(roll, "-2");
      else if(!given && qualifies) this.addPart(roll, "2");
    }

    /* Great Weapon Fighting : 1s and 2s on the damage dice count as 3 */
    if(this.styleOf(actor, "great-weapon-fighting") && info.melee && !info.thrown && info.twoHanded){
      for(const r of config.rolls ?? []){
        r.parts = (r.parts ?? []).map(p => /min/i.test(String(p)) ? p : String(p).replace(/(\d*)d(\d+)/gi, "$1d$2min3"));
      }
      log.debug("Great Weapon Fighting", item.name);
    }

    /* Thrown Weapon Fighting */
    if(this.styleOf(actor, "thrown-weapon-fighting") && info.thrown && info.props.has("thr")) this.addPart(roll, "2");

    /* Two-Weapon Fighting : the modifier dnd5e leaves off a Light weapon's extra attack */
    if(this.styleOf(actor, "two-weapon-fighting") && info.mode.endsWith("offhand") && (Number(roll.data?.mod) > 0)) this.addPart(roll, "@mod");

    /* Unarmed Fighting */
    if(info.unarmed && this.styleOf(actor, "unarmed-fighting")) this.unarmedDamage(config, info);
  }

  static unarmedDamage(config, { actor, item }){
    const base = item.system.damage?.base?.formula;
    /* Already a die of its own (a Monk's Martial Arts) : left alone */
    if(!base || /\d*d\d+/i.test(base)) return;
    const empty = !this.otherWeapons(actor, item).length && !hasShieldEquipped(actor);
    const formula = `1d${empty ? 8 : 6} + @abilities.str.mod`;
    for(const roll of config.rolls ?? []){
      const i = (roll.parts ?? []).findIndex(p => String(p).replace(/\s+/g, "") === base.replace(/\s+/g, ""));
      if(i >= 0){ roll.parts[i] = formula; log.debug("Unarmed Fighting", actor.name, formula); return; }
    }
  }

  /* ---------- Defense ---------- */

  static wearsArmor(actor){
    return !!actor?.items?.some(i => (i.type === "equipment") && ["light", "medium", "heavy"].includes(i.system.type?.value) && i.system.equipped);
  }

  /* Armor or the feat changed (by this user) : Defense's effect follows */
  static async onGear(item, userId){
    if(!this.enabled() || (userId && (userId !== game.user.id))) return;
    const actor = item?.parent;
    if((actor?.documentName !== "Actor") || !actor.isOwner) return;
    const relevant = (item.type === "equipment") || ["defense", "fighting-style-defense"].includes(idOf(item));
    if(!relevant) return;
    const defense = this.styleOf(actor, "defense");
    if(!defense) return;
    const disabled = !this.wearsArmor(actor);
    const updates = defense.effects.filter(e => e.transfer && (e.disabled !== disabled)).map(e => ({ _id : e.id, disabled }));
    if(updates.length) await defense.updateEmbeddedDocuments("ActiveEffect", updates);
  }

  /* ---------- Interception, Protection : buttons on the attack card ---------- */

  /* The user's tokens with this style, near a creature : within 5 ft, not it, not the attacker */
  static guardsNear(style, target, attackerToken){
    const side = t => t?.document?.disposition;
    return (canvas.tokens?.placeables ?? []).filter(t => t.actor?.isOwner && (t !== target) && (t !== attackerToken)
      /* Shielding its own side from the other : not a creature an ally attacks */
      && (side(target) === side(t)) && (!attackerToken || (side(attackerToken) !== side(t)))
      && this.styleOf(t.actor, style) && (distanceBetween(t, target) <= 5));
  }

  /* Its requirements : seeing the attacker, and the shield (or for Interception a weapon) in hand. "" when met */
  static unmet(style, guard, attackerToken){
    if(attackerToken && !canSee(guard, attackerToken)) return module.format("fightingStyles.cantSee", { name : guard.name });
    const shield = hasShieldEquipped(guard.actor);
    const inHand = hands.manages(guard.actor) ? hands.heldItems(guard.actor) : guard.actor.items.filter(i => i.system?.equipped);
    const weapon = inHand.some(i => (i.type === "weapon") && ["simpleM", "simpleR", "martialM", "martialR"].includes(i.system.type?.value));
    if((style === "protection") && !shield) return module.format("fightingStyles.noShield", { name : guard.name });
    if((style === "interception") && !shield && !weapon) return module.format("fightingStyles.noGuard", { name : guard.name });
    return "";
  }

  /* Rule Limits : Off and Warn show the button, Block / Change don't */
  static offered(problem){
    return !problem || ["off", "warn"].includes(limits.mode());
  }

  static cardButtons(message, buttons, { ray } = {}){
    if(!this.enabled() || !message.system?.attackOf?.(ray)) return;
    const attackerToken = tokenOf(message.getAssociatedToken?.() ?? message.getAssociatedActor?.());
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    const key = masteries.rayKey(ray);
    const hit = new Set((message.system.hitTargets?.(ray) ?? []).map(t => tokenOf(t)));
    for(const t of message.system.targetsOf(ray) ?? []){
      const target = tokenOf(TargetsField.resolve(t).token);
      if(!target) continue;
      const targetKey = target.document.uuid.replaceAll(".", "-");
      /* Interception : the attack hit it */
      if(hit.has(target) && !message.getFlag(module.id, `intercept.${targetKey}`)){
        for(const guard of this.guardsNear("interception", target, attackerToken)){
          if(this.offered(this.unmet("interception", guard, attackerToken))){
            buttons.push({ id : `intercept|${guard.document.uuid}|${target.document.uuid}`, icon : "fa-shield", label : module.i18n("fightingStyles.interceptShort"),
              tooltip : module.format("fightingStyles.intercept", { guard : guard.name, target : target.name }) });
          }
        }
      }
      /* Protection : it was attacked (not when the attack already had disadvantage : they don't stack) */
      if(!message.getFlag(module.id, `protect.${key}`) && !message.system.attackOf?.(ray)?.hasDisadvantage){
        for(const guard of this.guardsNear("protection", target, attackerToken)){
          if(this.offered(this.unmet("protection", guard, attackerToken))){
            buttons.push({ id : `protect|${guard.document.uuid}|${target.document.uuid}`, icon : "fa-shield-halved", label : module.i18n("fightingStyles.protectShort"),
              tooltip : module.format("fightingStyles.protect", { guard : guard.name, target : target.name }) });
          }
        }
      }
    }
  }

  static async cardClicked(message, id, { ray } = {}){
    const [kind, guardUuid, targetUuid] = String(id).split("|");
    if(!this.enabled() || !["intercept", "protect"].includes(kind)) return;
    const guard = fromUuidSync(guardUuid, { strict : false })?.object;
    if(!guard?.actor?.isOwner) return;
    const attackerToken = tokenOf(message.getAssociatedToken?.() ?? message.getAssociatedActor?.());
    const problem = this.unmet(kind === "intercept" ? "interception" : "protection", guard, attackerToken);
    if(problem && !limits.allow(problem, { who : guard.name, what : kind === "intercept" ? module.i18n("fightingStyles.interceptShort") : module.i18n("fightingStyles.protectShort") })) return;
    if(kind === "intercept"){
      /* Rolled here, its dice shown, and kept on this card (no chat message of its own) */
      const roll = await new Roll("1d10 + @prof", guard.actor.getRollData()).evaluate();
      const { rollItem } = await import('../roll-item/roll-item.js');
      await rollItem.showDice([roll], message);
      await gm.run("intercept", { message : message.id, guard : guardUuid, target : targetUuid, amount : roll.total, formula : roll.formula, result : roll.result });
    }
    else {
      const notes = await gm.run("protect", { message : message.id, ray, guard : guardUuid, target : targetUuid });
      for(const note of notes ?? []) ui.notifications.info(note);
    }
  }

  /* GM : the card remembers how much less its damage does to that creature */
  static async interceptAsGM({ message : id, guard : guardUuid, target : targetUuid, amount, formula = "", result = "" } = {}, user){
    const message = game.messages.get(id);
    const guard = fromUuidSync(guardUuid ?? "", { strict : false });
    const target = fromUuidSync(targetUuid ?? "", { strict : false });
    if(!message || !guard?.actor?.testUserPermission(user, "OWNER")) return false;
    const key = String(targetUuid).replaceAll(".", "-");
    if(message.getFlag(module.id, `intercept.${key}`)) return false;
    await message.setFlag(module.id, `intercept.${key}`, { amount : Math.max(0, Number(amount) || 0), by : guard.name, target : target?.name ?? "", formula, result });
    return true;
  }

  /* Notes for the card : how much less each intercepted creature takes from it */
  static cardNotes(message){
    return Object.values(message?.getFlag?.(module.id, "intercept") ?? {}).map(e => ({
      icon : "fa-shield", tooltip : `${e.formula} = ${e.result}`,
      text : module.format("fightingStyles.interceptNote", { guard : e.by, amount : e.amount, target : e.target }),
    }));
  }

  /* Damage from an intercepted card to that creature : that much lower */
  static intercepted(actor, damages, options = {}){
    const message = options.origin ?? options.originatingMessage;
    const all = message?.getFlag?.(module.id, "intercept");
    if(!all || !(damages?.amount > 0)) return;
    const token = actor.token ?? actor.getActiveTokens?.(false, true)?.[0];
    const entry = token ? all[token.uuid.replaceAll(".", "-")] : null;
    if(!entry) return;
    damages.amount = Math.max(0, damages.amount - entry.amount);
    log.debug("Interception", actor.name, -entry.amount);
  }

  /* GM : Disadvantage on the attack (a second d20, the lower kept), and the creature Protected */
  static async protectAsGM({ message : id, ray = null, guard : guardUuid, target : targetUuid } = {}, user){
    const message = game.messages.get(id);
    const guard = fromUuidSync(guardUuid ?? "", { strict : false });
    const target = fromUuidSync(targetUuid ?? "", { strict : false });
    if(!message?.system?.addD20 || !guard?.actor?.testUserPermission(user, "OWNER") || !target?.actor) return [];
    const key = `protect.${masteries.rayKey(ray)}`;
    if(message.getFlag(module.id, key)) return [module.i18n("fightingStyles.done")];
    const result = await message.system.addD20(ray, "kl");
    await message.setFlag(module.id, key, true);
    /* On the protector (its player's own token), naming who it protects : nothing changes on the creature itself */
    await addTimedEffect(guard.actor, {
      name : module.format("fightingStyles.protectingMark", { name : target.name }), img : "icons/equipment/shield/heater-steel-worn.webp",
      flags : { [module.id] : { protection : { token : guard.uuid, target : target.uuid } } },
    }, { of : guard.actor, until : "turnStart" });
    return (result === "same") ? [module.i18n("feats.lucky.same")] : [];
  }

  /* ---------- Unarmed Fighting : 1d4 to the grappled, at the start of its turn ---------- */

  /* Creatures this one grapples : Grappled, from one of its items */
  static grappledBy(actor){
    return (canvas.tokens?.placeables ?? []).filter(t => t.actor?.statuses?.has("grappled") && t.actor.effects.some(e => {
      const origin = e.origin ? fromUuidSync(e.origin, { strict : false }) : null;
      return e.statuses?.has?.("grappled") && (origin?.actor === actor);
    }));
  }

  /* Its turn starts : a card for its owner, a button per grappled creature (active GM posts it) */
  static async onTurn(combat, combatant){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    const actor = combatant?.actor;
    const feat = this.styleOf(actor, "unarmed-fighting");
    if(!feat) return;
    const grappled = this.grappledBy(actor);
    if(!grappled.length) return;
    await whisperOwners(actor, `<div class="${module.id}-grapple"><p>${esc(module.format("fightingStyles.grappleCard", { name : feat.name }))}</p>
        <div class="card-buttons">${grappled.map(t => `<button type="button" data-macro-helper-grapple="${esc(t.document.uuid)}"><i class="fa-solid fa-hand-fist" inert></i> ${esc(t.name)}</button>`).join("")}</div></div>`,
      { flags : { [module.id] : { grappleDamage : { actor : actor.uuid, item : feat.uuid } } } });
  }

  /* A button : the feat's own "Grappled Damage" activity, aimed at that creature (dnd5e's damage card, the GM applies it) */
  static wireGrappleCard(message, html){
    const info = message.getFlag?.(module.id, "grappleDamage");
    if(!info) return;
    for(const button of html.querySelectorAll("[data-macro-helper-grapple]")){
      const feat = fromUuidSync(info.item ?? "", { strict : false });
      button.disabled = !feat?.isOwner;
      button.addEventListener("click", async event => {
        event.preventDefault();
        const token = fromUuidSync(button.dataset.macroHelperGrapple, { strict : false })?.object;
        const activity = feat?.system?.activities?.find?.(a => a.type === "damage");
        if(!token || !activity) return;
        canvas.tokens.setTargets([token.id]);
        button.disabled = true;
        await activity.use({}, { configure : false });
      });
    }
  }
}
