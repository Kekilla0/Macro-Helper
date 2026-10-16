import { module } from '../module.js';
import { giveMode } from './reasons.js';

/**
 * item.roll()'s options for the use under way, read by the stages that need them (the picker, the attack roll, the
 * range, the damage roll). Held from the start of the use until its card is made.
 *
 *   advantage / disadvantage : true, a check (target) => boolean, or { when, reason }   the attack roll, per target
 *   targets      : [tokens] (no pick) or a check (token) => boolean (the picker shows only those)
 *   cost         : "free" | "action" | "bonus" | "reaction"   what the Action Tracker counts for it
 *   attackBonus  : "+2"                  added to the attack roll
 *   critical     : 19                    a critical hit on that roll or higher
 *   ignoreCover  : true                  half and three-quarters cover don't count (total cover still does)
 *   damageType   : "fire"                its damage is that type instead
 *   range / reach : feet                 instead of the item's own
 *   d20          : 15 or [15, 3]         what the attack's d20 shows (one value : every d20; a list : die by die)
 *   damageDice   : 4 or [6, 1, 3]        what the damage dice show, the same way (a list runs across all its rolls,
 *                                        crit dice included; past its end, the last value)
 */
const active = new Map();

export const rollOptions = {
  set(keys, options){ for(const k of keys.filter(Boolean)) active.set(k, options); },
  clear(keys){ for(const k of keys.filter(Boolean)) active.delete(k); },
  /* By the activity, else its item */
  of(activity){
    if(!activity) return null;
    return active.get(activity.uuid) ?? active.get(activity.item?.uuid) ?? null;
  },
};

const judge = (value, target) => (typeof value === "function") ? !!value(target) : !!value;

/* The attack roll (and the picker's colours, from the same rules) : advantage, disadvantage, bonus, critical range */
export function rollOptionModes(config){
  const options = rollOptions.of(config?.subject);
  const roll = config?.rolls?.[0];
  if(!options || !roll) return;
  const uuid = config[module.id]?.target;
  const token = uuid ? fromUuidSync(uuid, { strict : false }) : null;
  const target = token?.object ?? token;
  for(const mode of ["advantage", "disadvantage"]){
    const value = options[mode];
    if(value === undefined || value === null || value === false) continue;
    const spec = ((typeof value === "object") && !Array.isArray(value)) ? value : { when : value };
    if(judge(spec.when ?? true, target)) giveMode(roll, mode, spec.reason ?? module.format("cardBuilder.reason", { item : config.subject?.item?.name ?? "" }));
  }
  if(options.attackBonus && !roll[`${module.id}Bonus`]){
    roll.parts = [...(roll.parts ?? []), String(options.attackBonus)];
    roll[`${module.id}Bonus`] = true;
  }
  if(Number(options.critical) > 0){
    roll.options ??= {};
    roll.options.criticalSuccess = Number(options.critical);
  }
}

/* The damage roll : another damage type */
export function rollOptionDamage(config){
  const type = rollOptions.of(config?.subject)?.damageType;
  if(!type) return;
  for(const roll of config.rolls ?? []){
    roll.options ??= {};
    roll.options.type = type;
    roll.options.types = [type];
  }
}

/* Forced dice : each die term of the built rolls gives these faces instead of rolling (still dice : crits, icons,
   rerolls work). A value past a die's faces is held to them. */
function forceDice(rolls, value){
  if((value === undefined) || (value === null)) return;
  const list = (Array.isArray(value) ? value : [value]).map(Number).filter(n => Number.isFinite(n));
  if(!list.length) return;
  let i = 0;
  const next = faces => Math.clamp(Math.round(list[Math.min(i++, list.length - 1)]), 1, faces);
  for(const roll of rolls ?? []){
    for(const term of roll.dice ?? []){
      term._roll = async () => next(term.faces);
    }
  }
}

export function rollOptionD20(rolls, config){
  forceDice(rolls, rollOptions.of(config?.subject)?.d20);
}

export function rollOptionDamageDice(rolls, config){
  forceDice(rolls, rollOptions.of(config?.subject)?.damageDice);
}

/* The range / reach : instead of the item's */
export function rollOptionRange(activity){
  const options = rollOptions.of(activity);
  const feet = Number(options?.range ?? options?.reach);
  return Number.isFinite(feet) && (feet > 0) ? feet : null;
}

/* The picker : only these */
export function rollOptionFilter(activity){
  const targets = rollOptions.of(activity)?.targets;
  return (typeof targets === "function") ? (t => !!targets(t)) : null;
}
