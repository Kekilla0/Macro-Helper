import { module } from '../module.js';
import { settings } from '../settings.js';
import { idOf } from '../helpers/utils.js';
import { onDamage } from '../roll-item/damage.js';
import { ignoresDisadvantage, ignoresCover, ignoresProperty, ignoresResistance } from './ignores.js';
import { addRange } from './ranges.js';
import { itemChoice, choiceOf } from './item-choices.js';

/**
 * General feats (level 4+, Feats setting), each built from legos the way an Item Macro would be :
 *
 *   Sharpshooter     : its ranged weapon attacks ignore Half and Three-Quarters Cover (thrown ones too); with a Ranged
 *                      weapon, no disadvantage for an enemy within 5 ft or for long range.
 *   Spell Sniper     : its spell attacks ignore Half and Three-Quarters Cover, have no disadvantage for an enemy within
 *                      5 ft, and a spell attack with a range of 10 ft or more reaches 60 ft farther.
 *   Crossbow Expert  : no Loading limit, loading with no free hand, and no disadvantage for an enemy within 5 ft with a
 *                      crossbow; a Light
 *                      crossbow's extra attack adds the ability modifier.
 *   Elemental Adept  : a damage type chosen for each copy of the feat (Acid, Cold, Fire, Lightning, Thunder); its
 *                      spells' damage of that type ignores Resistance, and a 1 on those damage dice counts as a 2.
 *   Poisoner         : its Poison damage ignores Resistance (Brew Poison : the feat's own activities).
 */
export class generalFeats{
  static SHARPSHOOTER = "sharpshooter";
  static SPELL_SNIPER = "spell-sniper";
  static CROSSBOW_EXPERT = "crossbow-expert";
  static ELEMENTAL_ADEPT = "elemental-adept";
  static POISONER = "poisoner";
  static ELEMENTS = ["acid", "cold", "fire", "lightning", "thunder"];

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("featRules");
  }

  /* A Ranged weapon (bow, crossbow, Dart, Sling), not a thrown melee weapon */
  static rangedWeapon(item){
    return (item?.type === "weapon") && String(item.system?.type?.value ?? "").endsWith("R");
  }

  /* A ranged attack with a weapon : a Ranged weapon, or a weapon thrown (the card's attack mode) */
  static rangedWeaponAttack(item, message = null){
    if(this.rangedWeapon(item)) return true;
    if(item?.type !== "weapon") return false;
    return !!message?.rolls?.some?.(r => String(r.options?.attackMode ?? "").startsWith("thrown"));
  }

  static crossbow(item){
    if(item?.type !== "weapon") return false;
    return /crossbow/.test(String(item.system?.type?.baseItem || idOf(item) || item.name || "").toLowerCase().replace(/[^a-z]/g, ""));
  }

  /* A spell attack : a spell whose activity (or first activity) is an attack */
  static spellAttack(item, activity = null){
    if(item?.type !== "spell") return false;
    return (activity ?? item.system?.activities?.find?.(a => a.type === "attack"))?.type === "attack";
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    const enabled = () => this.enabled();

    /* Sharpshooter */
    ignoresCover(this.SHARPSHOOTER, { enabled, when : ({ item, message }) => this.rangedWeaponAttack(item, message) });
    ignoresDisadvantage(this.SHARPSHOOTER, ["threatened", "longRange"], { enabled, when : ({ item }) => this.rangedWeapon(item) });

    /* Spell Sniper */
    ignoresCover(this.SPELL_SNIPER, { enabled, when : ({ item, activity }) => this.spellAttack(item, activity) });
    ignoresDisadvantage(this.SPELL_SNIPER, "threatened", { enabled, when : ({ item, activity }) => this.spellAttack(item, activity) });
    addRange(this.SPELL_SNIPER, 60, { enabled, when : ({ item }) => this.spellAttack(item)
      && ((item.system.range?.units ?? "ft") === "ft") && (Number(item.system.range?.value) >= 10) });

    /* Crossbow Expert */
    ignoresProperty(this.CROSSBOW_EXPERT, ["lod", "amm"], { enabled, when : ({ item }) => this.crossbow(item) });
    ignoresDisadvantage(this.CROSSBOW_EXPERT, "threatened", { enabled, when : ({ item }) => this.crossbow(item) });

    /* Elemental Adept : the type, then the spells' damage */
    itemChoice(this.ELEMENTAL_ADEPT, { id : "damageType", label : module.i18n("feats.elementalAdept.title"), unique : true, enabled,
      prompt : module.i18n("feats.elementalAdept.prompt"),
      options : () => this.ELEMENTS.map(t => ({ value : t, label : CONFIG.DND5E.damageTypes[t]?.label ?? t })) });
    ignoresResistance(this.ELEMENTAL_ADEPT, feat => [choiceOf(feat, "damageType")], { enabled, when : ({ item }) => item?.type === "spell" });

    /* Poisoner */
    ignoresResistance(this.POISONER, ["poison"], { enabled });

    onDamage((attack, damage) => {
      if(!this.enabled() || !attack.actor) return;
      /* Crossbow Expert : the modifier on a Light crossbow's extra attack */
      if(attack.offHand && this.crossbow(attack.item) && attack.properties.has?.("lgt") && (damage.modifier > 0) && !damage.has("@mod")
        && attack.actor.items.some(i => idOf(i) === this.CROSSBOW_EXPERT)) damage.add("@mod");
      /* Elemental Adept : 1s count as 2s on its type's dice */
      if(attack.spell){
        const types = attack.actor.items.filter(i => idOf(i) === this.ELEMENTAL_ADEPT).map(i => choiceOf(i, "damageType")).filter(Boolean);
        if(types.length) damage.minDie(2, { types });
      }
    });
  }
}
