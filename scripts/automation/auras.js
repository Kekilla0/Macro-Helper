import { module } from '../module.js';
import { logger } from '../log.js';
import { tokenOf } from '../helpers/tokens.js';
import { gm } from '../gm.js';
import { zones } from './zones.js';
const log = logger.for(import.meta.url);

/**
 * The aura lego : an area round a creature that goes where it goes, and gives the creatures inside it an effect or a
 * condition while they're there (a Flumph's stench : Poisoned; a homebrew "Aura of Dread"). It's a zone (zones.js) on
 * an emanation stuck to the creature's token : Foundry moves it with the token, and the active GM gives and takes.
 *
 *   giveAura(thing, { feet, status, effects, who, others, source, name })   one aura round that creature's token
 *     feet      its reach from the creature's space (default 5)
 *     status    a condition (its id : "poisoned") the creatures inside have
 *     effects   effect uuids : a copy of each on the creatures inside (lasting while inside)
 *     who       "any" (default), "ally", "enemy" or "nonAlly" : whose side, from the creature's
 *     others    true : not the creature itself (a stench); false : it too (Pass without Trace)
 *     source    the uuid of what it comes from (an effect : the aura goes when that effect goes or is switched off)
 *
 * An effect carrying flags["macro-helper"].aura = { radius, type, who } makes one as it lands on a creature (every
 * other creature within radius has the condition `type`) : card-builder's applyCondition({ aura }). An item's own
 * emanation (a spell's 30 ft round its caster) is the zone lego with `effect` and `who` (Pass without Trace).
 */
export async function giveAura(thing, { feet = 5, status = "", effects = [], who = "any", others = false, source = null, name = null } = {}){
  const token = tokenOf(thing?.actor ?? thing)?.document ?? thing?.document ?? thing;
  if(!token?.parent || (token.documentName !== "Token")) return null;
  const data = { token : token.uuid, feet : Number(feet) || 5, status, effects : [effects].flat().filter(Boolean), who, others : !!others, source, name };
  if(!game.users.activeGM?.isSelf) return gm.run("giveAura", data);
  return auras.make(data);
}

export const auras = {
  register(){
    gm.handle("giveAura", data => this.make(data));
    /* An aura effect : on as it lands (and when switched on), gone with it (and when switched off) */
    Hooks.on("createActiveEffect", effect => this.fromEffect(effect));
    Hooks.on("deleteActiveEffect", effect => this.removeFor(effect.uuid));
    Hooks.on("updateActiveEffect", (effect, changes) => {
      if(!("disabled" in (changes ?? {}))) return;
      if(effect.disabled) this.removeFor(effect.uuid);
      else this.fromEffect(effect);
    });
    /* A token placed for a creature under one : its own aura; a token gone : its auras too */
    Hooks.on("createToken", token => { for(const effect of token.actor?.effects ?? []) this.fromEffect(effect, token); });
    Hooks.on("deleteToken", token => this.removeFor(null, token));
  },

  /* The auras an effect makes (the active GM) : one round each of its creature's tokens on the viewed scene */
  async fromEffect(effect, only = null){
    const aura = effect?.getFlag?.(module.id, "aura");
    if(!aura || effect.disabled || !game.users.activeGM?.isSelf || (effect.parent?.documentName !== "Actor")) return;
    const tokens = only ? [only] : (effect.parent.getActiveTokens?.(false, true) ?? []);
    for(const token of tokens){
      if(token.parent?.regions?.some(r => (r.getFlag(module.id, "auraOf") === effect.uuid) && (r.attachment?.token?.id === token.id))) continue;
      await this.make({ token : token.uuid, feet : Number(aura.radius) || 5, status : aura.type ?? "", who : aura.who ?? "any",
        others : aura.others !== false, source : effect.uuid, name : effect.name }).catch(error => log.error(error));
    }
  },

  /* One aura : an emanation stuck to the token, with a Zone behavior that gives and takes */
  async make({ token : uuid, feet = 5, status = "", effects = [], who = "any", others = false, source = null, name = null } = {}){
    const token = fromUuidSync(uuid ?? "", { strict : false });
    const scene = token?.parent;
    if(!scene) return null;
    const perUnit = scene.grid.size / scene.grid.distance;
    const shape = { type : "emanation", radius : feet * perUnit,
      base : { type : "token", x : token.x, y : token.y, width : token.width, height : token.height, shape : token.shape } };
    const origin = fromUuidSync(source ?? "", { strict : false });
    const [region] = await scene.createEmbeddedDocuments("Region", [{
      name : name ?? origin?.name ?? module.i18n("zones.aura"), color : "#7a4fbf",
      visibility : CONST.REGION_VISIBILITY.GAMEMASTER, shapes : [shape], attachment : { token : token.id },
      behaviors : [{ type : zones.TYPE, name : module.i18n("zones.aura"), system : { item : source ?? "", status, effects, who, others } }],
      flags : { [module.id] : { auraOf : source ?? null, auraToken : token.id } } }]);
    if(!region) return null;
    log.debug("Aura", region.name, token.name, feet);
    return region;
  },

  /* The auras of an effect (or stuck to a token) gone (the active GM) */
  async removeFor(source, token = null){
    if(!game.users.activeGM?.isSelf) return;
    for(const scene of game.scenes){
      const ids = scene.regions.filter(r => r.getFlag(module.id, "auraOf") !== undefined)
        .filter(r => source ? (r.getFlag(module.id, "auraOf") === source) : ((scene === token?.parent) && (r.getFlag(module.id, "auraToken") === token.id)))
        .map(r => r.id);
      if(ids.length) await scene.deleteEmbeddedDocuments("Region", ids).catch(error => log.debug(error));
    }
  },
};
