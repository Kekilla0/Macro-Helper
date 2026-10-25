import { module } from '../module.js';
import { uses } from '../uses.js';
import { tokenOf, setActingNow } from '../helpers/tokens.js';
import { chooseOption } from '../helpers/utils.js';

/**
 * The actFrom lego : a use measured from another token's space. Its range, long range and walls are counted from there
 * (Roll Item's pick, the Rule Limits range checks); its user still sees with its own senses, and its conditions and
 * threats stay its own. Invoke Duplicity : spells cast as though you were in the illusion's space; later a familiar
 * delivering a touch spell, a monster casting through its projected image.
 *
 *   await MacroHelper.actFrom(activity, token, usage);         use the activity from that token
 *   MacroHelper.actFromPlace(id, activity => token | null);    a place a use can be made from : when one applies, its
 *                                                              user is asked where from (themself, or there)
 *
 * While the use runs, the picks inside it (a placed summon's space, a creature touched) measure from there too
 * (actingNowFrom). Areas are still placed by dnd5e from its user's token.
 */
const places = new Map();
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
 */
export function actFromPlace(id, fn){
  if(!id || (typeof fn !== "function")) return;
  places.set(id, fn);
  hook();
}

function hook(){
  if(hooked) return;
  hooked = true;
  uses.onActivity("actFrom", (activity, ctx, next) => step(activity, ctx, next));
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
  for(const [id, fn] of places){
    const place = fn(activity);
    const token = place ? tokenOf(place) : null;
    if(token && (token !== me) && (token.document.parent === me?.document?.parent)) found.push({ id, token });
  }
  if(!me || !found.length) return next();
  const value = await chooseOption({ title : activity.item?.name ?? activity.name, icon : "fa-solid fa-location-crosshairs",
    prompt : module.i18n("actFrom.prompt"),
    options : [{ value : "self", label : module.format("actFrom.self", { name : me.name }) },
      ...found.map(f => ({ value : f.token.document.uuid, label : module.format("actFrom.there", { name : f.token.name }) }))] });
  if(!value) return;
  if(value === "self") return next();
  uses.mark(ctx, { from : value });
  /* Its own picks inside the use (a space, a creature touched) measure from there too */
  setActingNow(activity.actor, fromUuidSync(value, { strict : false }));
  try { return await next(); }
  finally { setActingNow(activity.actor, null); }
}
