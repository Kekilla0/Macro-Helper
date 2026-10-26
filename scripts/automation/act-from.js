import { module } from '../module.js';
import { uses } from '../uses.js';
import { tokenOf, setActingNow, getRange, distanceBetween, getTokensWithin } from '../helpers/tokens.js';
import { chooseOption } from '../helpers/utils.js';
import { hasReaction, useReaction } from '../roll-item/card-builder.js';

/**
 * The actFrom lego : a use measured from another token's space. Its range, long range and walls are counted from there
 * (Roll Item's pick, the Rule Limits range checks); its user still sees with its own senses, and its conditions and
 * threats stay its own. Invoke Duplicity : spells cast as though you were in the illusion's space; a familiar
 * delivering a touch spell; a monster casting through its projected image.
 *
 *   await MacroHelper.actFrom(activity, token, usage);         use the activity from that token
 *   MacroHelper.actFromPlace(id, activity => token | null);    a place a use can be made from : when one applies, its
 *                                                              user is asked where from (themself, or there)
 *   MacroHelper.actFromPlace(id, fn, { reaction : true });     the place's creature spends its Reaction when chosen
 *                                                              (offered only while it can take one)
 *   MacroHelper.actFromPlace(id, fn, { inRange : true });      offered only when the use reaches from there : your
 *                                                              targets all in its range, or with none, someone is
 *
 * While the use runs, the picks inside it (a placed summon's space, a creature touched) measure from there too
 * (actingNowFrom). Areas are still placed by dnd5e from its user's token.
 */
const places = new Map();  // id -> { fn, reaction, inRange }
let hooked = false;

/**
 * @param {Activity} activity
 * @param {Token|TokenDocument} token   where it's used from
 * @param {object} [usage]              the use's config
 */
export async function actFrom(activity, token, usage = {}){
  const from = tokenOf(token);
  if(!activity || !from) return null;
  hook();
  return activity.use(foundry.utils.mergeObject(usage, { [module.id] : { from : from.document.uuid } }, { inplace : false }));
}

/**
 * @param {string} id
 * @param {(activity : Activity) => Token|null} fn   the token that activity can be used from, or null
 * @param {object} [options]
 * @param {boolean} [options.reaction=false]       choosing it spends that token's creature's Reaction
 * @param {boolean} [options.inRange=false]        only when a creature is in the use's range from there (areas : always)
 */
export function actFromPlace(id, fn, { reaction = false, inRange = false } = {}){
  if(!id || (typeof fn !== "function")) return;
  places.set(id, { fn, reaction, inRange });
  hook();
}

function hook(){
  if(hooked) return;
  hooked = true;
  uses.onActivity("actFrom", (activity, ctx, next) => step(activity, ctx, next));
}

/* Does the use reach from that token : the user's targets all within its range from there, or with none targeted,
   any other creature (its user too). An area is placed from its user : always. */
function reaches(activity, from, me){
  if(activity.target?.template?.type) return true;
  const feet = getRange(activity);
  const targets = [...game.user.targets].filter(t => t.document.parent === from.document.parent);
  if(targets.length) return targets.every(t => (t === from) || (distanceBetween(from, t) <= feet));
  return getTokensWithin(from, feet).length > 0;
}

/* A place applies : themself or there (closed : nothing used) */
async function step(activity, ctx, next){
  /* actFrom(activity, token) : already chosen */
  const given = ctx.config?.[module.id]?.from;
  if(given){
    setActingNow(activity.actor, fromUuidSync(given, { strict : false }));
    try { return await next(); }
    finally { setActingNow(activity.actor, null); }
  }
  const me = tokenOf(activity.getUsageToken?.() ?? activity.actor);
  const found = [];
  for(const [id, { fn, reaction, inRange }] of places){
    const place = fn(activity);
    const token = place ? tokenOf(place) : null;
    if(!token || (token === me) || (token.document.parent !== me?.document?.parent)) continue;
    if(reaction && !hasReaction(token.actor)) continue;
    if(inRange && !reaches(activity, token, me)) continue;
    found.push({ id, token, reaction });
  }
  if(!me || !found.length) return next();
  const value = await chooseOption({ title : activity.item?.name ?? activity.name, icon : "fa-solid fa-location-crosshairs",
    prompt : module.i18n("actFrom.prompt"),
    options : [{ value : "self", label : module.format("actFrom.self", { name : me.name }) },
      ...found.map(f => ({ value : f.token.document.uuid, label : module.format("actFrom.there", { name : f.token.name }) }))] });
  if(!value) return;
  if(value === "self") return next();
  const chosen = found.find(f => f.token.document.uuid === value);
  if(chosen?.reaction && !await useReaction(chosen.token.actor, activity.item?.name ?? "")){
    ui.notifications.warn(module.format("cardBuilder.noReaction", { name : chosen.token.name }));
    return;
  }
  uses.mark(ctx, { from : value });
  /* Its own picks inside the use (a space, a creature touched) measure from there too */
  setActingNow(activity.actor, fromUuidSync(value, { strict : false }));
  try { return await next(); }
  finally { setActingNow(activity.actor, null); }
}
