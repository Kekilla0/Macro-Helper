import { module } from '../module.js';
import { logger } from '../log.js';
import { idOf } from '../helpers/utils.js';
const log = logger.for(import.meta.url);

/**
 * The damage lego : a rule that changes a roll's own damage (Rage, Dueling, Great Weapon Fighting, a Tortle's claws)
 * says it once, as sentences, instead of reading dnd5e's roll config itself. A bonus in its own box is extraDamage.
 *
 *   onDamage((attack, damage) => {
 *     if(attack.weapon && attack.meleeWeapon && !attack.thrown) damage.add("2");
 *   });
 *
 * Every damage or healing roll dnd5e builds goes through the rules (Roll Item's cards and dnd5e's own), in the order
 * they were added, before its dice are rolled.
 */
const rules = [];
let hooked = false;

/**
 * Add a rule.
 * @param {(attack : object, damage : DamageParts) => void} fn  attack : what the roll is for (attackOf), damage : the
 *        roll's parts to change. Runs before the dice : no awaiting.
 * @param {object} [options]
 * @param {string} [options.id]  a macro's rule : added again with the same id, it replaces the old one
 */
export function onDamage(fn, { id = null } = {}){
  const old = id ? rules.findIndex(r => r.id === id) : -1;
  if(old >= 0) rules[old].fn = fn;
  else rules.push({ id, fn });
  if(hooked) return;
  hooked = true;
  Hooks.on("dnd5e.preRollDamageV2", config => runRules(config));
}

function runRules(config){
  if(!config?.rolls?.length) return;
  const attack = attackOf(config);
  const damage = new DamageParts(config, attack);
  for(const { fn } of rules){
    try { fn(attack, damage); }
    catch(error){ log.error("Damage rule", error); }
  }
}

/**
 * What a damage roll is for, read once.
 *   activity, item, actor, type (the activity's), isAttack, weapon, spell
 *   action      dnd5e's action type for this attack ("mwak", "rwak", "msak", "rsak"; a thrown melee weapon is "rwak")
 *   melee, ranged   the attack itself (a thrown dagger is a ranged attack)
 *   meleeWeapon     the weapon's category (a dagger is a melee weapon, thrown or not)
 *   thrown, twoHanded, offHand (a Light weapon's extra attack), unarmed (an Unarmed Strike), properties (a Set)
 *   attackMode, ability, critical, tags (rules' marks on the attack : Cleave's { noMod })
 *   baseDamage  the item's own damage formula ("1 + @mod" for an Unarmed Strike)
 * @param {object} config  dnd5e's damage roll process configuration
 */
export function attackOf(config){
  const activity = config?.subject ?? null;
  const item = activity?.item ?? null;
  const first = config?.rolls?.[0];
  const attackMode = String(config?.attackMode ?? first?.options?.attackMode ?? "");
  const properties = item?.system?.properties ?? new Set();
  const isAttack = activity?.type === "attack";
  const weapon = item?.type === "weapon";
  let action = "";
  try { action = isAttack ? String(activity.getActionType?.(config?.attackMode) ?? "") : ""; } catch {}
  return {
    activity, item, actor : activity?.actor ?? null, type : activity?.type ?? "",
    isAttack, weapon, spell : item?.type === "spell",
    action, melee : action.startsWith("m"), ranged : action.startsWith("r"),
    meleeWeapon : weapon && String(item.system.type?.value ?? "").endsWith("M"),
    thrown : attackMode.startsWith("thrown"),
    twoHanded : properties.has?.("two") || (attackMode === "twoHanded"),
    offHand : attackMode.endsWith("offhand"),
    unarmed : idOf(item) === "unarmed-strike",
    properties, attackMode,
    ability : config?.ability ?? first?.options?.ability ?? activity?.ability ?? null,
    critical : !!config?.isCritical,
    tags : config?.[module.id]?.tags ?? {},
    baseDamage : item?.system?.damage?.base?.formula ?? "",
  };
}

const flat = s => String(s).replace(/\s+/g, "");

/**
 * A damage roll's parts, changed before its dice are rolled.
 */
export class DamageParts{
  constructor(config, attack){
    this.config = config;
    this.attack = attack;
  }

  get rolls(){ return this.config.rolls ?? []; }

  /* The ability modifier dnd5e adds (@mod), 0 when there's none */
  get modifier(){ return Number(this.rolls[0]?.data?.mod) || 0; }

  /* A bonus in the same roll, the same type ("2", "@mod", "1d4") */
  add(part){
    const roll = this.rolls[0];
    if(roll) roll.parts = [...(roll.parts ?? []), String(part)];
    return this;
  }

  /* A bonus dnd5e put in (an effect's melee damage bonus, maybe with others in one part) taken out again; not found :
     cancelled with its negative */
  remove(part){
    const roll = this.rolls[0];
    if(!roll) return this;
    const parts = roll.parts ?? [];
    const target = flat(part).replace(/^\+/, "");
    for(let i = 0; i < parts.length; i++){
      const here = flat(parts[i]);
      if(!here.includes(target)) continue;
      const rest = here.replace(`+${target}`, "").replace(target, "").replace(/^\+/, "");
      const copy = [...parts];
      if(rest) copy[i] = rest; else copy.splice(i, 1);
      roll.parts = copy;
      return this;
    }
    roll.parts = [...parts, `-(${part})`];
    return this;
  }

  /**
   * The item's own damage replaced (Unarmed Fighting's d6 / d8, a Tortle's claws), in the roll that has it.
   * @param {string|null} formula  the new formula, null to keep it
   * @param {object} [options]
   * @param {string} [options.type]  that roll's damage type too
   * @returns {boolean}  false when the roll doesn't have the item's own damage (another rule already replaced it)
   */
  setBase(formula, { type } = {}){
    const base = flat(this.attack?.baseDamage ?? "");
    if(!base) return false;
    for(const roll of this.rolls){
      const i = (roll.parts ?? []).findIndex(p => flat(p) === base);
      if(i < 0) continue;
      if(formula) roll.parts[i] = formula;
      if(type){ roll.options ??= {}; roll.options.type = type; roll.options.types = [type]; }
      return true;
    }
    return false;
  }

  /* A part already in the roll ("@mod" : the modifier is added) */
  has(part){
    const target = flat(part);
    return this.rolls.some(roll => (roll.parts ?? []).some(p => flat(p).includes(target)));
  }

  /**
   * Each die counts at least this (Great Weapon Fighting : 1s and 2s count as 3).
   * @param {number} n
   * @param {object} [options]
   * @param {string[]} [options.types]  only the rolls of these damage types (Elemental Adept : its type)
   */
  minDie(n, { types = null } = {}){
    for(const roll of this.rolls){
      if(types && !types.includes(roll.options?.type)) continue;
      roll.parts = (roll.parts ?? []).map(p => /min/i.test(String(p)) ? p : String(p).replace(/(\d*)d(\d+)/gi, `$1d$2min${n}`));
    }
    return this;
  }

  /**
   * More dice on a critical hit : n more of each roll's first die, on top of dnd5e's doubling (Piercer : one more of
   * its Piercing dice). Nothing on a roll that isn't a critical.
   * @param {number} [n=1]
   * @param {object} [options]
   * @param {string[]} [options.types]  only the rolls of these damage types
   */
  critDice(n = 1, { types = null } = {}){
    for(const roll of this.rolls){
      if(types && !types.includes(roll.options?.type)) continue;
      if(!/\d*d\d+/i.test((roll.parts ?? []).join(" "))) continue;
      roll.options ??= {};
      roll.options.critical ??= {};
      roll.options.critical.bonusDice = (Number(roll.options.critical.bonusDice) || 0) + n;
    }
    return this;
  }

  /* Dice showing this or lower are rolled again, once (the Healer feat : 1s) */
  reroll(n = 1){
    for(const roll of this.rolls){
      roll.parts = (roll.parts ?? []).map(p => String(p).replace(/(\d*d\d+)(?![a-z0-9])/gi, `$1r${n === 1 ? "1" : `<=${n}`}`));
    }
    return this;
  }

  /**
   * The damage type.
   * @param {string} type
   * @param {object} [options]
   * @param {string[]} [options.only]  only these types change (Transmuted Spell : acid, cold, fire...), the rest stay
   */
  setType(type, { only = null } = {}){
    for(const roll of this.rolls){
      const options = roll.options ?? (roll.options = {});
      if(!only){ options.type = type; options.types = [type]; continue; }
      if(only.includes(options.type)) options.type = type;
      if(Array.isArray(options.types)) options.types = options.types.map(t => only.includes(t) ? type : t);
    }
    return this;
  }

  /* No positive ability modifier (Cleave's extra attack, a Light weapon's extra attack without Two-Weapon Fighting) */
  noModifier(){
    for(const roll of this.rolls){
      if(roll.data && (Number(roll.data.mod) > 0)) roll.data.mod = 0;
    }
    return this;
  }
}
