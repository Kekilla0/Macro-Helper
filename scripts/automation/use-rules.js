import { module } from '../module.js';
import { logger } from '../log.js';
import { limits } from './limits.js';
import { tokenOf } from '../helpers/tokens.js';
const log = logger.for(import.meta.url);

/**
 * The use legos : what a creature can't use while something holds (no spells while raging, no Rage in Heavy armor; a
 * monster that can't cast while Frightened), and what's free to use while something holds (Rage again while raging :
 * no use spent). Both judged before dnd5e's use (dnd5e.preUseActivity), on the creature using it (its token's own).
 *
 *   cantUseWhile("rageSpells", { uses : item => item.type === "spell", while : actor => isRaging(actor),
 *     reason : (actor, item) => `${actor.name} can't cast spells while raging.` });
 *   freeUseWhile("rageExtend", { uses : item => idOf(item) === "rage", while : actor => isRaging(actor) });
 *
 * cantUseWhile : Rule Limits decides (Warn : a notice, then the use; Block : no use).
 * freeUseWhile : nothing of the item's is spent (dnd5e's consume off); the use is marked, so what runs after it can
 *   tell : isFreeUse(usage, "rageExtend").
 * Both take enabled() (the rule's setting); the same id again replaces the rule (a macro).
 */
const cant = [];
const free = [];
let hooked = false;

const put = (list, id, rule) => {
  const old = list.findIndex(r => r.id === id);
  if(old >= 0) list[old] = { id, ...rule };
  else list.push({ id, ...rule });
  hook();
};

export function cantUseWhile(id, rule){ put(cant, id, rule); }
export function freeUseWhile(id, rule){ put(free, id, rule); }

/* Was this use made free by that rule (in a postUseActivity hook, or a macro's usage) */
export function isFreeUse(usage, id){
  return usage?.[module.id]?.freeUse === id;
}

/* The creature using it : its token's own actor (an unlinked token's) */
export function userOf(activity){
  return activity?.getUsageToken?.()?.actor ?? tokenOf(activity?.actor)?.actor ?? activity?.actor ?? null;
}

const on = rule => !rule.enabled || rule.enabled();

function hook(){
  if(hooked) return;
  hooked = true;
  Hooks.on("dnd5e.preUseActivity", (activity, usage) => preUse(activity, usage));
}

function preUse(activity, usage){
  const item = activity?.item;
  const actor = userOf(activity);
  if(!item || !actor) return;
  for(const rule of free){
    try {
      if(!on(rule) || !rule.uses(item, actor) || !rule.while(actor, item)) continue;
      usage.consume = false;
      usage[module.id] = { ...(usage[module.id] ?? {}), freeUse : rule.id };
      log.debug("Free use", rule.id, item.name);
      return;
    } catch(error){ log.error("Free use", rule.id, error); }
  }
  for(const rule of cant){
    try {
      if(!on(rule) || !rule.uses(item, actor) || !rule.while(actor, item)) continue;
      const reason = rule.reason?.(actor, item) ?? module.format("useRules.cant", { name : actor.name, item : item.name });
      if(!limits.allow(reason, { who : actor.name, what : item.name })) return false;
    } catch(error){ log.error("Can't use", rule.id, error); }
  }
}
