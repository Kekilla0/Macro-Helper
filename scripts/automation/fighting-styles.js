import { module } from '../module.js';
import { idOf, esc, whisperOwners } from '../helpers/utils.js';
import { rollModes } from './roll-modes.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm, onTurnStart } from '../gm.js';
import { distanceBetween } from '../helpers/tokens.js';
import { hasShieldEquipped, isUnarmored } from '../helpers/items.js';
import { bonusOnlyWhen } from './bonus-only-when.js';
import { addTimedEffect } from '../helpers/actors.js';
import { giveMode } from '../roll-item/reasons.js';
import { masteries } from './masteries.js';
import { conditions } from './conditions.js';
import { hands } from './hands.js';
import { grappling } from '../roll-item/card-builder.js';
import { onDamage, attackOf } from '../roll-item/damage.js';
import { cutDamage, cutsOf } from '../roll-item/damage-cuts.js';
import { onAttacked } from '../roll-item/attacked.js';
import { unarmedDamage } from './unarmed.js';
const log = logger.for(import.meta.url);

/**
 * The Fighting Style feats (Feats setting), found by identifier : "dueling", or "fighting-style-dueling" when taken
 * through the class feature. Plutonium's data : Archery, Defense, Dueling and Blind Fighting come with effects,
 * Interception and Protection with an activity, Unarmed Fighting with attacks of its own; the rest with nothing.
 *
 *   Archery         : Plutonium's +2 to ranged weapon attacks; a thrown melee weapon (dnd5e counts it as a ranged
 *                     weapon attack) gets it taken off again : it isn't a Ranged weapon (bonusOnlyWhen).
 *   Defense         : Plutonium's +1 AC only while armor (light, medium, heavy) is worn : its effect is switched off
 *                     and on as armor is equipped (bonusOnlyWhen).
 *   Dueling         : +2 damage with a melee weapon held in one hand and no other weapon (a shield is fine). With
 *                     Plutonium's always-on effect, the +2 is taken off attacks that don't qualify (bonusOnlyWhen).
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
    const enabled = () => this.enabled();
    /* Archery : +2 with Ranged weapons (not a thrown melee weapon, which dnd5e counts as a ranged weapon attack) */
    bonusOnlyWhen(["archery", "fighting-style-archery"], "system.bonuses.rwak.attack", attack => attack.weapon && !attack.meleeWeapon, { value : "2", enabled });
    /* Dueling : +2 with a melee weapon in one hand and no other weapon */
    bonusOnlyWhen(["dueling", "fighting-style-dueling"], "system.bonuses.mwak.damage", attack => this.duels(attack), { value : "2", enabled });
    /* Defense : +1 AC only while wearing armor */
    bonusOnlyWhen(["defense", "fighting-style-defense"], "system.attributes.ac.bonus", actor => !isUnarmored(actor, { shield : false }), { enabled });
    rollModes.add("protection", config => this.protectedMode(config));
    onDamage((attack, damage) => this.onDamage(attack, damage));
    /* Unarmed Fighting : a d8 with no weapon or shield in hand, else a d6 */
    unarmedDamage(actor => this.styleOf(actor, "unarmed-fighting"), { id : "unarmed-fighting", enabled, bonus : "@abilities.str.mod",
      die : attack => (!this.otherWeapons(attack.actor, attack.item).length && !hasShieldEquipped(attack.actor)) ? 8 : 6 });
    /* Interception : a creature within 5 ft of yours is hit; Protection : attacked (not when the attack already had
       Disadvantage : they don't stack). The guard's Reaction. */
    onAttacked({ id : "interception", enabled, feature : actor => this.styleOf(actor, "interception"), when : "hit", within : 5, icon : "fa-shield",
      label : () => module.i18n("fightingStyles.interceptShort"), tooltip : c => module.format("fightingStyles.intercept", { guard : c.guard.name, target : c.target.name }),
      unmet : guard => this.unmet("interception", guard), done : c => cutsOf(c.message, c.target).some(cut => cut.id === "interception"),
      run : c => this.intercept(c) });
    onAttacked({ id : "protection", enabled, feature : actor => this.styleOf(actor, "protection"), within : 5, icon : "fa-shield-halved",
      label : () => module.i18n("fightingStyles.protectShort"), tooltip : c => module.format("fightingStyles.protect", { guard : c.guard.name, target : c.target.name }),
      unmet : guard => this.unmet("protection", guard), done : c => !!c.message.getFlag(module.id, `protect.${masteries.rayKey(c.ray)}`) || !!c.roll?.hasDisadvantage,
      run : c => this.protect(c) });
    /* Unarmed Fighting : at the start of its turn, 1d4 to each creature it grapples */
    onTurnStart({ id : "unarmedFighting", enabled, feature : actor => this.styleOf(actor, "unarmed-fighting"), run : (actor, token, combat, combatant) => this.onTurn(combat, combatant) });
    Hooks.on("renderChatMessageHTML", (message, html) => this.wireGrappleCard(message, html));
    gm.handle("protect", (data, user) => this.protectAsGM(data, user));
  }


  /* The creature's Fighting Style feat of this kind */
  static styleOf(actor, style){
    if(!this.enabled()) return null;
    return actor?.items?.find?.(i => [style, `fighting-style-${style}`].includes(idOf(i))) ?? null;
  }

  /* ---------- What the attack is : attackOf (the damage lego) ---------- */

  /* Other weapons in hand (natural weapons and Unarmed Strike don't count) */
  static otherWeapons(actor, item){
    /* Hands : the weapons held */
    /* Hands : the weapons held, and anything held that was swung as a weapon this turn (a torch) */
    if(hands.manages(actor)) return hands.heldItems(actor).filter(i => (i.id !== item?.id)
      && (((i.type === "weapon") && (i.system.type?.value !== "natural")) || hands.wieldedThisTurn(actor, i)));
    return (actor?.items ?? []).filter(i => (i.id !== item?.id) && (i.type === "weapon") && i.system.equipped
      && (i.system.type?.value !== "natural") && (idOf(i) !== "unarmed-strike"));
  }

  /* Dueling's attack : a melee weapon in one hand (not thrown, not two-handed), no other weapon */
  static duels(attack){
    return attack.weapon && attack.meleeWeapon && !attack.thrown && !attack.twoHanded && !attack.unarmed && !this.otherWeapons(attack.actor, attack.item).length;
  }

  /* ---------- Attacks : Protection ---------- */

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

  /* ---------- Damage : Dueling, Great Weapon, Thrown Weapon, Two-Weapon (Unarmed Fighting : the unarmedDamage lego) ---------- */

  /* The damage lego's rule for the fighting styles that change a weapon's damage */
  static onDamage(attack, damage){
    if(!this.enabled() || !attack.isAttack || !attack.weapon) return;
    const { actor, item } = attack;

    /* Great Weapon Fighting : 1s and 2s on the damage dice count as 3 */
    if(this.styleOf(actor, "great-weapon-fighting") && attack.meleeWeapon && !attack.thrown && attack.twoHanded){
      damage.minDie(3);
      log.debug("Great Weapon Fighting", item.name);
    }

    /* Thrown Weapon Fighting */
    if(this.styleOf(actor, "thrown-weapon-fighting") && attack.thrown && attack.properties.has("thr")) damage.add("2");

    /* Two-Weapon Fighting : the modifier dnd5e leaves off a Light weapon's extra attack */
    if(this.styleOf(actor, "two-weapon-fighting") && attack.offHand && (damage.modifier > 0) && !damage.has("@mod")) damage.add("@mod");
  }

  /* ---------- Interception, Protection : buttons on the attack card ---------- */

  /* The shield (or for Interception a weapon) in hand. "" when it's there (seeing the attacker and the Reaction : the
     onAttacked lego) */
  static unmet(style, guard){
    const shield = hasShieldEquipped(guard.actor);
    const inHand = hands.manages(guard.actor) ? hands.heldItems(guard.actor) : guard.actor.items.filter(i => i.system?.equipped);
    const weapon = inHand.some(i => (i.type === "weapon") && ["simpleM", "simpleR", "martialM", "martialR"].includes(i.system.type?.value));
    if((style === "protection") && !shield) return module.format("fightingStyles.noShield", { name : guard.name });
    if((style === "interception") && !shield && !weapon) return module.format("fightingStyles.noGuard", { name : guard.name });
    return "";
  }

  /* Interception : 1d10 + Proficiency off that creature's damage from this card. Rolled here, its dice shown, kept on
     the card (no chat message of its own) */
  static async intercept({ message, guard, target }){
    const roll = await new Roll("1d10 + @prof", guard.actor.getRollData()).evaluate();
    const { rollItem } = await import('../roll-item/roll-item.js');
    await rollItem.showDice([roll], message);
    await cutDamage(message, target, { id : "interception", amount : roll.total, by : guard.name, label : module.i18n("fightingStyles.interceptShort"), formula : roll.formula, result : roll.result });
  }

  /* Protection : the GM gives the attack Disadvantage and marks the creature Protected */
  static async protect({ message, ray, guard, target }){
    const notes = await gm.run("protect", { message : message.id, ray, guard : guard.document.uuid, target : target.document.uuid });
    for(const note of notes ?? []) ui.notifications.info(note);
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
    return (result === "same") ? [module.i18n("rollItem.d20.same")] : [];
  }

  /* ---------- Unarmed Fighting : 1d4 to the grappled, at the start of its turn ---------- */

  /* Creatures this one grapples (the grapple lego's record, or a Grappled from one of its items) */
  static grappledBy(actor){
    return grappling(actor).filter(t => t?.document);
  }

  /* Its turn starts : a card for its owner, a button per grappled creature (active GM posts it) */
  static async onTurn(combat, combatant){
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
        await activity.use({ [module.id] : { economy : "free" } }, { configure : false });
      });
    }
  }
}
