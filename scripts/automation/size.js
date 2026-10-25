import { module } from '../module.js';
import { logger } from '../log.js';
import { stepSize, giveEffect } from '../helpers/actors.js';
import { fitSpace } from '../helpers/tokens.js';
const log = logger.for(import.meta.url);

/**
 * The size lego : an effect that changes a creature's size (Enlarge/Reduce; a Goliath's Large Form; a homebrew "Giant
 * Growth"). Any effect with a system.traits.size change : the active GM makes room for the creature's tokens on the
 * scene, growing the way there's room (fitSpace : centred first, else whichever way it fits), and puts them back on
 * their own square when the effect ends or is switched off (if they haven't moved since). dnd5e's token size sync (on
 * by default) sizes the token itself; with it off, or a token's size locked, the token is resized too, in proportion
 * (a Tiny 0.5 token one size up : 1 square).
 * An effect can give the size as steps instead : flags["macro-helper"].rule.size = 1 (one size larger) or -1; as it
 * lands, the step becomes the change, from the creature's size then (Tiny can't get smaller, Gargantuan bigger).
 *
 *   changeSize(thing, 1, { name : "Giant Growth", origin, img })   an effect of its own (giveEffect : the GM's button
 *                                                                  for a creature that isn't yours)
 */
export class sizes{
  static KEY = "system.traits.size";

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("preCreateActiveEffect", effect => { this.stepToChange(effect); this.noteFrom(effect); });
    Hooks.on("createActiveEffect", effect => this.changed(effect, !effect.disabled));
    Hooks.on("deleteActiveEffect", effect => this.changed(effect, false));
    Hooks.on("updateActiveEffect", (effect, changes) => { if("disabled" in (changes ?? {})) this.changed(effect, !effect.disabled); });
  }

  static changesOf(effect){
    return [...(effect?.system?.changes ?? effect?.changes ?? [])];
  }

  /* The size an effect gives (its system.traits.size change), null : none */
  static sizeOf(effect){
    return this.changesOf(effect).findLast(c => c.key === this.KEY)?.value ?? null;
  }

  /* A step (rule.size) : the size it makes, as a change */
  static stepToChange(effect){
    const steps = Number(effect?.getFlag?.(module.id, "rule")?.size);
    const actor = effect?.parent;
    if(!steps || (actor?.documentName !== "Actor") || this.sizeOf(effect)) return;
    const from = actor.system?.traits?.size;
    const to = from ? stepSize(from, steps) : null;
    if(!to || (to === from)) return;
    const changes = [...this.changesOf(effect).map(c => ({ ...c })), { key : this.KEY, type : "override", value : to }];
    effect.updateSource((effect.system?.changes !== undefined) ? { "system.changes" : changes } : { changes });
    log.debug("Size", actor.name, from, "->", to);
  }

  /* The size it had before (the GM's resize needs the space the token covered) */
  static noteFrom(effect){
    const actor = effect?.parent;
    if((actor?.documentName !== "Actor") || !this.sizeOf(effect)) return;
    effect.updateSource({ [`flags.${module.id}.sizeFrom`] : actor.system?.traits?.size ?? null });
  }

  /* The creature's size changed (on : the effect began; off : it ended or was switched off) : its tokens follow (the active GM) */
  static async changed(effect, on){
    const actor = effect?.parent;
    const size = this.sizeOf(effect);
    if((actor?.documentName !== "Actor") || !size || !game.users.activeGM?.isSelf) return;
    actor.reset();
    const to = actor.system?.traits?.size;
    const from = on ? (effect.getFlag(module.id, "sizeFrom") ?? actor._source?.system?.traits?.size) : size;
    if(!to || !from || (to === from)) return;
    const tokens = actor.isToken ? [actor.token] : actor.getActiveTokens(false, true);
    for(const token of tokens) await this.resize(token, from, to).catch(error => log.warn("Size", error));
  }

  /* One token from one size to another. dnd5e's token size sync on : dnd5e sizes the token, only where it stands
     changes; off (or the token's size locked) : its width and height too, in proportion (a Tiny 0.5 token one
     size up : 1). Growing : the way there's room; shrinking back where it hasn't moved since : its own square again */
  static async resize(token, from, to){
    const table = CONFIG.DND5E.actorSizes ?? {};
    const scale = (table[to]?.token ?? 1) / (table[from]?.token ?? 1);
    const synced = !!game.settings.get("dnd5e", "tokenSizeSync") && !token.getFlag("dnd5e", "lockSize") && !!token.actor?.system?.isCreature;
    const old = synced ? { width : table[from]?.token ?? 1, height : table[from]?.token ?? 1 } : { width : token._source.width, height : token._source.height };
    const width = old.width * scale, height = old.height * scale;
    const update = {};
    const grown = token.getFlag(module.id, "grown");
    if(scale > 1){
      const here = (token.parent === canvas.scene) && token.object;
      const spot = here ? fitSpace(token.object, width, height, { from : old }) : null;
      if(spot && ((spot.x !== token.x) || (spot.y !== token.y))){
        Object.assign(update, spot);
        update[`flags.${module.id}.grown`] = { x : token.x, y : token.y, movedTo : spot };
      }
      else if(here && !spot) ui.notifications.warn(module.format("size.noRoom", { name : token.name }));
    }
    else if(grown){
      if((token.x === grown.movedTo?.x) && (token.y === grown.movedTo?.y)) Object.assign(update, { x : grown.x, y : grown.y });
      update[`flags.${module.id}.grown`] = new foundry.data.operators.ForcedDeletion();
    }
    if(!Object.keys(update).length && synced) return;
    /* With the sync, dnd5e saves the token's new size itself (the active GM) : the same size here, whichever lands last */
    await token.update({ ...update, width, height }, { animate : false, teleport : true });
  }
}

/**
 * Change a creature's size by steps, as an effect of its own (ended like any effect).
 * @param {Actor|Token|TokenDocument} thing
 * @param {number} steps        1 : one size larger, -1 : smaller
 * @param {object} [data]       ActiveEffect data (name, img, origin, duration, more changes...)
 * @returns {Promise<object>}   giveEffect's result
 */
export function changeSize(thing, steps = 1, data = {}){
  const name = data.name ?? module.i18n((steps > 0) ? "size.larger" : "size.smaller");
  return giveEffect(thing, foundry.utils.mergeObject({ name, img : "icons/svg/up.svg", flags : { [module.id] : { rule : { size : steps } } } }, data, { inplace : false }));
}
