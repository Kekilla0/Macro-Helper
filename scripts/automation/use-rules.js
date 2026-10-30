import { module } from '../module.js';
import { logger } from '../log.js';
import { limits } from './limits.js';
import { tokenOf } from '../helpers/tokens.js';
import { uses } from '../uses.js';
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
 *
 * cantUseWhile's `instead` : a change that would make the use allowed (Rule Fixes : Offer a Fix asks, Fix
 * Automatically just does it; Off : Rule Limits decides). Judged as the item is used (a use step), not before dnd5e's use :
 *   instead : {
 *     label,                       the Fix button ("Leave the form and cast"), or (actor, item) => it
 *     run(actor, item),            async : the change (leave the Wild Shape form)
 *     when(actor, item),           offer it only while true (a Bonus Action spell in combat can't follow leaving : no)
 *     use(item, ctx, next),        what then (default : next(), the use goes on); `ctx.config["macro-helper"].insteadDone`
 *   }
 * Allowed past the rule (Warn) : the use goes on, marked config["macro-helper"].cantAllowed = id.
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
  /* The rules with `instead` : as the item is used, so the fix can be asked and awaited */
  uses.onItem("cantUseInstead", (item, ctx, next) => insteadStep(item, ctx, next));
}

async function insteadStep(item, ctx, next){
  const own = ctx.config?.[module.id] ?? {};
  if(own.insteadDone || own.cantAllowed) return next();
  const actor = tokenOf(item.actor)?.actor ?? item.actor;
  for(const rule of cant){
    if(!rule.instead || !on(rule)) continue;
    let applies = false;
    try { applies = rule.uses(item, actor) && rule.while(actor, item); } catch(error){ log.error("Can't use", rule.id, error); }
    if(!applies) continue;
    const reason = rule.reason?.(actor, item) ?? module.format("useRules.cant", { name : actor.name, item : item.name });
    const who = actor.name, what = item.name;
    const mark = key => { ctx.config = { ...(ctx.config ?? {}), [module.id] : { ...(ctx.config?.[module.id] ?? {}), [key] : rule.id } }; };
    const offer = (limits.fixMode() !== "off") && (!rule.instead.when || rule.instead.when(actor, item));
    if(!offer){
      if(!limits.allow(rule.instead.whyNot?.(actor, item) ?? reason, { who, what })) return null;
      mark("cantAllowed");
      return next();
    }
    const outcome = await limits.resolve(reason, { who, what, fixLabel : (typeof rule.instead.label === "function") ? rule.instead.label(actor, item) : rule.instead.label, fix : () => rule.instead.run(actor, item) });
    if(outcome === "fixed"){
      mark("insteadDone");
      return rule.instead.use ? rule.instead.use(item, ctx, next) : next();
    }
    if(outcome !== "allowed") return null;
    mark("cantAllowed");
    return next();
  }
  return next();
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
      /* `instead` rules : judged in their use step (already allowed there : not again) */
      if(rule.instead || !on(rule) || !rule.uses(item, actor) || !rule.while(actor, item)) continue;
      const reason = rule.reason?.(actor, item) ?? module.format("useRules.cant", { name : actor.name, item : item.name });
      if(!limits.allow(reason, { who : actor.name, what : item.name })) return false;
    } catch(error){ log.error("Can't use", rule.id, error); }
  }
}
