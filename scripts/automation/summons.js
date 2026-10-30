import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { tokenOf, getRange } from '../helpers/tokens.js';
import { pickSpace } from '../helpers/targets.js';
import { fitsProfile } from '../helpers/creatures.js';
const log = logger.for(import.meta.url);

/**
 * The summon lego : a summon activity's creature put on the map, through dnd5e's own summon data (its profile's
 * changes, its flags : the summoner, the item), on the summoner's side and owned by its players. The token is made by
 * the GM's client (a player can't make tokens). Find Familiar, Wild Companion and Pact of the Chain use it; so can a
 * homebrew "summon a spirit" or a monster calling for help.
 *
 *   await MacroHelper.summon(activity, creatureUuid);                       a space picked within the activity's range
 *   await MacroHelper.summon(activity, creatureUuid, { space : { x, y }, profile });
 *
 * The creature must be one the activity allows (one of its profiles' creatures, or one its profile's CR and type fit),
 * unless the GM summons it, or `kind` names a kind registered with summonKind that allows it.
 * summonKind(id, { allowed(activity, creature), before(summoner, activity), after(created, summoner, activity) }) :
 * a feature's own rules around it, on the GM's client (one at a time, no attacks...).
 *
 * With `controlled`, the creature acts with its summoner's actions : its uses spend the summoner's Action / Bonus Action
 * (Spiritual Weapon's force, Flaming Sphere : flags.macro-helper.controlledBy, the summoner's uuid; controllerOf(actor)).
 * Any summon (dnd5e's own, this lego's, a placed one) from a spell with Concentration goes when that Concentration ends
 * (Spell Rules setting).
 */
const kinds = new Map();

export function summonKind(id, rule){
  kinds.set(id, rule);
}

export function registerSummons(){
  gm.handle("summon", (data, user) => summonAsGM(data, user));
  Hooks.on("deleteActiveEffect", effect => endWithConcentration(effect));
}

/**
 * Who a summoned creature acts for : its summoner, when it uses the summoner's actions (`controlled`), else null.
 * @param {Actor} actor
 * @returns {Actor|null}
 */
export function controllerOf(actor){
  const uuid = actor?.getFlag?.(module.id, "controlledBy");
  return uuid ? (fromUuidSync(uuid, { strict : false }) ?? null) : null;
}

/* A spell's Concentration ended : the creatures it summoned go (the active GM) */
async function endWithConcentration(effect){
  if(!game.users.activeGM?.isSelf || !settings.value("spellRules")) return;
  if(!effect?.statuses?.has?.(CONFIG.specialStatusEffects?.CONCENTRATING ?? "concentrating")) return;
  const item = effect.getFlag("dnd5e", "item")?.uuid;
  if(!item) return;
  for(const scene of game.scenes){
    const ids = scene.tokens.filter(t => t.actor?.getFlag("dnd5e", "summon.origin") === item).map(t => t.id);
    if(!ids.length) continue;
    /* Out of the combat too (a token's combatant stays when only its token goes) */
    for(const combat of game.combats){
      const gone = combat.combatants.filter(c => (c.sceneId === scene.id) && ids.includes(c.tokenId)).map(c => c.id);
      if(gone.length) await combat.deleteEmbeddedDocuments("Combatant", gone).catch(error => log.debug(error));
    }
    await scene.deleteEmbeddedDocuments("Token", ids).catch(error => log.debug(error));
  }
}

/**
 * @param {Activity} activity   a summon activity
 * @param {string} creature     the creature's uuid
 * @param {object} [options]
 * @param {object} [options.space]       { x, y } (top-left), else picked on the map within `range`
 * @param {number} [options.range]       feet (default : the activity's range)
 * @param {string} [options.profile]     the profile's id (default : the creature's own, else the first)
 * @param {string} [options.kind]        a summonKind
 * @param {boolean} [options.controlled] it acts with its summoner's actions
 * @returns {Promise<boolean>}
 */
export async function summon(activity, creature, { space = null, range = null, profile = null, kind = null, controlled = false } = {}){
  const from = tokenOf(activity?.getUsageToken?.() ?? activity?.actor);
  if(!activity || !creature) return false;
  if(!from){
    ui.notifications.warn(module.i18n("helpers.pick.noToken"));
    return false;
  }
  if(!space){
    const actor = fromUuidSync(creature, { strict : false });
    const size = Math.max(1, Math.round(Number(actor?.prototypeToken?.width) || 1));
    space = await pickSpace(from, { range : range ?? (getRange(activity) || 10), size, notice : actor?.name ?? "" });
    if(!space) return false;
  }
  const own = activity.profiles?.find?.(p => p.uuid === creature);
  return !!await gm.run("summon", { item : activity.item.uuid, activity : activity.id, creature, x : space.x, y : space.y,
    scene : from.document.parent.id, elevation : from.document.elevation ?? 0, profile : profile ?? own?._id ?? null, kind, controlled,
    disposition : from.document.disposition ?? activity.actor.prototypeToken?.disposition ?? 1 });
}

/* May this user summon that creature with this activity */
async function allowed(activity, creature, kind, user){
  if(user.isGM) return true;
  if(kind && kinds.get(kind)?.allowed) return !!await kinds.get(kind).allowed(activity, creature);
  if(activity.profiles?.some?.(p => p.uuid === creature)) return true;
  const entry = fromUuidSync(creature, { strict : false });
  const rollData = activity.getRollData?.({ deterministic : true }) ?? {};
  return !!entry && (activity.availableProfiles ?? []).some(p => !p.uuid && fitsProfile(entry, p, rollData));
}

/* GM : the token, for the summoner's owner */
export async function summonAsGM({ item : itemUuid, activity : activityId, creature, x, y, scene : sceneId, elevation = 0, profile : profileId, disposition = 1, kind = null, controlled = false } = {}, user){
  const activity = fromUuidSync(itemUuid ?? "", { strict : false })?.system?.activities?.get(activityId);
  const summoner = activity?.actor;
  if(!summoner?.testUserPermission(user, "OWNER") || !await allowed(activity, creature, kind, user)) return false;
  const scene = game.scenes.get(sceneId);
  /* A world copy of the compendium's creature for its token (dnd5e's own : reused the next time) */
  const actor = creature ? await dnd5e.documents.Actor5e.fetchExisting(creature).catch(error => { log.error(error); return null; }) : null;
  const profile = activity.profiles.find(p => p._id === profileId) ?? activity.availableProfiles?.[0];
  if(!scene || !actor || !profile) return false;
  const rule = kind ? kinds.get(kind) : null;
  await rule?.before?.(summoner, activity);
  const options = { profile : profile._id, creatureType : activity.creatureTypes?.first?.() ?? null, creatureSize : activity.creatureSizes?.first?.() ?? null };
  const changes = await activity.getChanges(actor, profile, options);
  changes.tokenUpdates.disposition = disposition;
  const owners = Object.fromEntries(game.users.filter(u => !u.isGM && summoner.testUserPermission(u, "OWNER")).map(u => [u.id, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER]));
  changes.actorUpdates.ownership = { ...(actor.ownership ?? {}), ...owners };
  if(controlled) changes.actorUpdates[`flags.${module.id}.controlledBy`] = summoner.uuid;
  const config = { actor, placement : { x, y, elevation, rotation : 0 }, ...changes };
  if(Hooks.call("dnd5e.preSummonToken", activity, profile, config, options) === false) return false;
  const tokenData = await activity.getTokenData(config);
  Hooks.callAll("dnd5e.summonToken", activity, profile, tokenData, options);
  const created = await scene.createEmbeddedDocuments("Token", [tokenData], { dnd5e : { autoRollNPCHP : "no" } });
  Hooks.callAll("dnd5e.postSummon", activity, profile, created, options);
  await rule?.after?.(created, summoner, activity);
  log.debug("Summoned", summoner.name, actor.name, kind ?? "");
  return true;
}
