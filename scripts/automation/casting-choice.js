import { module } from '../module.js';
import { logger } from '../log.js';
import { chooseOption } from '../helpers/utils.js';
import { hasUses, spendUses, getUses } from '../helpers/items.js';
import { uses } from '../uses.js';
const log = logger.for(import.meta.url);

/**
 * The casting choice lego : as a spell (or any use a rule picks) is cast, one choice from a list of options, each paid
 * from a pool once the cast goes through (Metamagic; a homebrew "Overchannel"; a lich's "it can empower one spell a
 * round"). The chosen option is recorded on the use and on its card, and shown under the spell's description, laid
 * out like the option's item.
 *
 *   castingChoice({
 *     id : "metamagic",                                the rule's key
 *     applies : (activity, actor) => true,             which uses ask (default : spells)
 *     pool : actor => item,                            the item whose uses pay (none : the options are free)
 *     options : (actor, activity) => [{
 *       id : "quickened-spell", item, cost : 2,         the option, its item (shown on the card), its cost
 *       label : "Quickened Spell (2 SP)",
 *       fits : (activity, actor) => true,             offered for this use (default : yes)
 *       allowed : async (actor, activity) => true,    chosen : may it be (false : the use stops; Rule Limits)
 *       choose : async (actor, activity) => ({}),     more to ask (a damage type), kept in the record; null : the use stops
 *       usage : (actor, activity, data) => ({ economy : "bonus" }),   marks on the use (rangeMultiplier, extraTargets,
 *                                                     economy, components : { v : false, s : false }...)
 *       after : async (actor, activity, data, results) => {},       once the cast went through and was paid
 *     }],
 *     title : activity => "...", prompt : (actor, left) => "...", none : () => "No Metamagic", icon,
 *     subtitle : record => "Metamagic · 1 SP",       the card face's line
 *     enabled : () => true,
 *   })
 *
 * An option costing more than the pool has left isn't offered; no option offered : no question. The record
 * ({ id, cost, name, uuid, ...choose's data }) : castingChoiceOf(cardOrUsage, "metamagic").
 */
const rules = new Map();
let hooked = false;

export function castingChoice(rule){
  if(!rule?.id) return;
  rules.set(rule.id, rule);
  if(hooked) return;
  hooked = true;
  uses.onActivity("castingChoice", (activity, ctx, next) => step([...rules.values()], activity, ctx, next));
  Hooks.on(`${module.id}.cardFaces`, (card, faces) => {
    for(const rule of rules.values()){
      const record = castingChoiceOf(card, rule.id);
      if(!record?.id) continue;
      const item = record.uuid ? fromUuidSync(record.uuid, { strict : false }) : null;
      faces.push({ uuid : record.uuid ?? null, name : record.name ?? item?.name, img : item?.img ?? undefined, subtitle : rule.subtitle?.(record) ?? "" });
    }
  });
}

/**
 * The option chosen, from a card (Roll Item's or dnd5e's) or a use's config / usage.
 * @returns {object|null}  { id, cost, name, uuid, ... }
 */
export function castingChoiceOf(thing, id){
  if(!thing) return null;
  if(typeof thing.getFlag === "function") return thing.getFlag(module.id, `choices.${id}`) ?? null;
  return thing?.[module.id]?.choices?.[id] ?? null;
}

const on = rule => !rule.enabled || rule.enabled();
const leftIn = pool => pool ? (Number(getUses(pool)?.value) || 0) : Infinity;

/* Each rule in turn asks (one already chosen on this use : not again), then the cast, then each is paid */
async function step(list, activity, ctx, next, chosen = []){
  const rule = list[0];
  if(!rule) return cast(activity, ctx, next, chosen);
  const rest = list.slice(1);
  const actor = activity?.actor;
  const asks = on(rule) && actor?.isOwner && !castingChoiceOf(ctx.config, rule.id)
    && (rule.applies ? rule.applies(activity, actor) : (activity?.item?.type === "spell"));
  if(!asks) return step(rest, activity, ctx, next, chosen);
  const pool = rule.pool?.(actor) ?? null;
  if(rule.pool && !pool) return step(rest, activity, ctx, next, chosen);
  const left = leftIn(pool);
  const options = (rule.options?.(actor, activity) ?? []).filter(o => ((Number(o.cost) || 0) <= left) && (!o.fits || o.fits(activity, actor)));
  if(!options.length) return step(rest, activity, ctx, next, chosen);
  const value = await chooseOption({ title : rule.title?.(activity) ?? activity.item.name, icon : rule.icon ?? "fa-solid fa-wand-sparkles",
    prompt : rule.prompt?.(actor, left) ?? "",
    options : [{ value : "none", label : ((typeof rule.none === "function") ? rule.none() : rule.none) ?? module.i18n("castingChoice.none") }, ...options.map(o => ({ value : o.id, label : o.label ?? o.item?.name ?? o.id }))] });
  if(!value) return;
  const option = options.find(o => o.id === value);
  if(!option) return step(rest, activity, ctx, next, chosen);
  if(option.allowed && !(await option.allowed(actor, activity))) return;
  const data = option.choose ? await option.choose(actor, activity) : {};
  if(!data) return;
  const record = { id : option.id, cost : Number(option.cost) || 0, name : option.item?.name ?? option.label ?? option.id, uuid : option.item?.uuid ?? null, ...data };
  const own = ctx.config?.[module.id] ?? {};
  uses.mark(ctx, { ...(option.usage?.(actor, activity, data) ?? {}),
    choices : { ...(own.choices ?? {}), [rule.id] : record },
    cardFlags : { ...(own.cardFlags ?? {}), choices : { ...(own.cardFlags?.choices ?? {}), [rule.id] : record } } });
  uses.flag(ctx, { choices : { [rule.id] : record } });
  return step(rest, activity, ctx, next, [...chosen, { rule, option, record, pool }]);
}

/* The cast : paid once it went through (a pick closed, nothing rolled : nothing paid) */
async function cast(activity, ctx, next, chosen){
  const results = await next();
  if(!chosen.length || !results) return results;
  if(results?.[module.id]?.card && !(await uses.cardOf(results))) return results;
  const actor = activity.actor;
  for(const { option, record, pool } of chosen){
    if(pool && record.cost && hasUses(pool, record.cost)) await spendUses(pool, record.cost);
    await option.after?.(actor, activity, record, results);
    log.debug("Casting choice", actor.name, record.id, activity.item.name);
  }
  return results;
}
