import { module } from '../module.js';
import { logger } from '../log.js';
import { idOf } from '../helpers/utils.js';
import { ruleArgs } from '../helpers/rules.js';
import { isType } from '../roll-item/card-builder.js';
const log = logger.for(import.meta.url);

/**
 * The target type lego : a use that only works on some creature types (Hold Person : a Humanoid; Dominate Beast : a
 * Beast; a homebrew "only Fiends"). A target of another type stays on the card, as the 2024 rule has it (the caster
 * isn't told) : its save row succeeds without a roll, nothing applied to it (no damage, no effect). The GM's row says
 * why; a player's only shows the success. The active GM marks the card's invalid targets as it's made (a player's
 * client can't read a creature it doesn't own), and every client's rows read the mark.
 *
 *   onlyTypes(match, { types : ["humanoid"], enabled : () => true, id })
 *
 * match : the used item's identifier (or several), or (item) => boolean. types : dnd5e's creature types.
 */
const rules = new Map();
let hooked = false;

export function onlyTypes(match, rule){
  rule = ruleArgs(match, rule);
  rules.set(rule.id ?? Symbol(), rule);
  if(hooked) return;
  hooked = true;
  Hooks.on("createChatMessage", card => mark(card));
  Hooks.on(`${module.id}.rowResults`, (card, results) => rowResults(card, results));
  Hooks.on(`${module.id}.rowEffect`, (card, uuid, row) => { if(marked(card).includes(uuid)) row.show = false; });
}

/* The rule for the card's item, or null */
function ruleFor(item){
  if(!item) return null;
  for(const rule of rules.values()){
    if(rule.enabled && !rule.enabled()) continue;
    try {
      if((typeof rule.match === "function") ? rule.match(item) : [rule.match].flat().includes(idOf(item))) return rule;
    } catch(error){ log.error("Target types", error); }
  }
  return null;
}

/* The types that target isn't one of, or null (it's fine, or no rule) */
function invalid(card, uuid){
  const rule = ruleFor(card?.getAssociatedItem?.());
  if(!rule) return null;
  const { actor } = dnd5e.dataModels.chatMessage.fields.TargetsField.resolve({ token : uuid });
  if(!actor || isType(actor, rule.types)) return null;
  return [rule.types].flat();
}

/* The active GM : the card's invalid targets, on the card */
async function mark(card){
  if(!game.users.activeGM?.isSelf || !ruleFor(card?.getAssociatedItem?.())) return;
  const uuids = (card.system?.targets ?? []).map(t => t.token).filter(uuid => invalid(card, uuid));
  if(uuids.length) await card.setFlag(module.id, "invalidTargets", uuids).catch(error => log.warn("Target types", error));
}

const marked = card => card?.getFlag?.(module.id, "invalidTargets") ?? [];

function rowResults(card, results){
  for(const uuid of marked(card)){
    const types = game.user.isGM ? invalid(card, uuid) : null;
    const names = types?.map(t => CONFIG.DND5E.creatureTypes?.[t]?.label ?? t).join(", ");
    results.set(uuid, { total : null, success : true, noDamage : true, auto : names ? module.format("targetTypes.not", { types : names }) : null });
  }
}
