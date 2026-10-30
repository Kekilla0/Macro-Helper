import { module } from '../module.js';
import { logger } from '../log.js';
import { tokenOf, getTokensWithin } from '../helpers/tokens.js';
import { uses } from '../uses.js';
import { rollItem } from '../roll-item/roll-item.js';
const log = logger.for(import.meta.url);

/**
 * The emanation lego : a use that reaches every matching creature in a circle around its user, with no placement and
 * no pick (Turn Undead; a dragon's Frightful Presence; a Lich's aura). The creatures are targeted before the use (its
 * card's rows), and the circle shows on the map for everyone until the turn ends (Clear Instant Templates).
 *
 *   emanation("turnUndead", { applies : activity => isTurnUndead(activity), feet : 30, filter : token => isUndead(token.actor) });
 *
 * id           its key (the same id again replaces it : a macro)
 * applies      (activity) => boolean : the uses it's for
 * feet         its reach, a number or (activity) => number (default : the activity's range, else 30)
 * filter       (token, activity) => boolean : which creatures in it (default : all)
 * disposition  "nonAlly" (default), "enemy", "ally", "any" : whose side (as getTokensWithin)
 * self         count the user too (default false)
 * enabled()    the rule's setting
 */
const rules = new Map();
let hooked = false;

export function emanation(id, rule){
  if(!id || !rule?.applies) return;
  rules.set(id, rule);
  if(hooked) return;
  hooked = true;
  uses.onActivity("presetTargets", (activity, ctx, next) => {
    const rule = ruleFor(activity);
    if(rule){
      rollItem.announceTargets(activity, targetsOf(rule, activity), { keepEmpty : true });
      uses.mark(ctx, { skipPick : true });
    }
    return next();
  });
  Hooks.on("dnd5e.postUseActivity", activity => {
    const rule = ruleFor(activity);
    if(rule) showCircle(activity, feetOf(rule, activity));
  });
}

function ruleFor(activity){
  for(const rule of rules.values()){
    try { if((!rule.enabled || rule.enabled()) && rule.applies(activity) && tokenOf(activity.actor)) return rule; }
    catch(error){ log.error("Emanation", error); }
  }
  return null;
}

function feetOf(rule, activity){
  const given = (typeof rule.feet === "function") ? rule.feet(activity) : rule.feet;
  return Number(given || activity.range?.value || activity.item?.system?.range?.value) || 30;
}

/* Every matching creature within its reach */
export function targetsOf(rule, activity){
  const me = tokenOf(activity.actor);
  if(!me) return [];
  const within = getTokensWithin(me, feetOf(rule, activity), { disposition : rule.disposition ?? "nonAlly" });
  const all = rule.self ? [me, ...within.filter(t => t !== me)] : within.filter(t => t !== me);
  return rule.filter ? all.filter(t => rule.filter(t, activity)) : all;
}

/* Its reach on the map : a circle round the user's space, seen by everyone. Instantaneous : Clear Instant Templates
   removes it at the end of the turn */
async function showCircle(activity, feet){
  if(!canvas.ready) return;
  const me = tokenOf(activity.actor);
  if(!me || (me.document.parent !== canvas.scene)) return;
  const radius = (feet / canvas.scene.grid.distance) * canvas.grid.size + (Math.max(me.w, me.h) / 2);
  try {
    await canvas.scene.createEmbeddedDocuments("Region", [{
      name : activity.item.name, color : game.user.color?.css ?? "#ffd700",
      /* Seen by everyone on the map (a region otherwise only shows on the Regions layer) */
      visibility : CONST.REGION_VISIBILITY?.ALWAYS ?? 2,
      shapes : [{ type : "circle", x : me.center.x, y : me.center.y, radius }],
      flags : { dnd5e : { activity : activity.uuid, origin : me.document.uuid }, [module.id] : { emanation : true } },
    }]);
  } catch(error){
    log.error("Emanation's circle", error);
  }
}
