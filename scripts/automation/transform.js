import { module } from '../module.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { tokenOf, fitSpace } from '../helpers/tokens.js';
const log = logger.for(import.meta.url);

/**
 * The transform lego : a creature takes another creature's form (Wild Shape, Polymorph, a Werewolf's Shape-Shift), and
 * leaves it again. dnd5e's transformInto / revertOriginalForm, done on the active GM's client (players can't create
 * actors), for the creature's tokens on every scene (dnd5e only changes the ones on the scene the GM is viewing). A
 * bigger form spreads where there's room around its token; none : nothing happens (false). Leaving it, the creature
 * goes back to its own size where it fits.
 *
 *   await transform(token, "Compendium.macro-helper.wild-shapes.Actor.abc", { preset : "wildshape" });
 *   await transform(actor, wolf, { activity });       // a transform activity's own settings
 *   await revert(form);
 *
 * Hooks : "macro-helper.reverting" (actor) as a form is left (its effects about to go), on the GM's client.
 */

/**
 * Take a form.
 * @param {Actor|Token} thing
 * @param {Actor|string} form             the creature (or its uuid : a compendium's, a world actor's)
 * @param {object} [options]
 * @param {Activity} [options.activity]   a transform activity : its settings (what the form keeps)
 * @param {object} [options.settings]     dnd5e's transformation settings (keep, merge, effects...), else the preset's
 * @param {string} [options.preset="polymorph"]   dnd5e's preset : "wildshape", "polymorph", "polymorphSelf"
 * @param {boolean} [options.place=true]  a bigger form spreads where there's room (none : false, nothing done)
 * @returns {Promise<boolean>}
 */
export async function transform(thing, form, { activity = null, settings = null, preset = "polymorph", place = true } = {}){
  const actor = thing?.actor ?? thing;
  const uuid = (typeof form === "string") ? form : form?.uuid;
  if(!actor || !uuid) return false;
  const token = tokenOf(thing);
  let spot = null;
  if(token && place){
    const source = (typeof form === "string") ? await fromUuid(form) : form;
    const size = source?.prototypeToken ?? {};
    spot = fitSpace(token, Number(size.width) || 1, Number(size.height) || Number(size.width) || 1);
    if(!spot){
      ui.notifications.error(module.i18n("transform.noRoom"));
      return false;
    }
  }
  return !!(await gm.run("transform", { actor : actor.uuid, form : uuid, activity : activity?.uuid ?? null,
    settings : settings ? foundry.utils.deepClone(settings) : null, preset, token : token?.document.uuid ?? null, x : spot?.x, y : spot?.y }));
}

/**
 * Leave a form : back to the creature's own (its size where it fits).
 * @param {Actor|Token} thing   the form
 * @param {object} [options]
 * @param {boolean} [options.place=true]
 * @returns {Promise<Actor|null>}  the creature
 */
export async function revert(thing, { place = true } = {}){
  const form = thing?.actor ?? thing;
  if(!form?.isPolymorphed) return null;
  const token = tokenOf(thing);
  const original = game.actors.get(form.getFlag("dnd5e", "originalActor"));
  const size = original?.prototypeToken ?? {};
  const spot = (token && place) ? fitSpace(token, Number(size.width) || 1, Number(size.height) || Number(size.width) || 1) : null;
  const uuid = await gm.run("revert", { actor : form.uuid, token : token?.document.uuid ?? null, x : spot?.x, y : spot?.y });
  return uuid ? fromUuidSync(uuid, { strict : false }) : null;
}

/* Is this form being left now (its effects going are the revert's, not ended one by one) */
export function isReverting(actorId){
  return reverting.has(actorId);
}

const reverting = new Set();
/* The new form's token data, caught as dnd5e builds it, for the creature's tokens on other scenes */
const prototypes = new Map();

export function registerTransform(){
  if(game.system.id !== "dnd5e") return;
  Hooks.on("dnd5e.transformActorV2", (actor, source, data) => {
    if(data?.prototypeToken) prototypes.set(actor.id, foundry.utils.deepClone(data.prototypeToken));
  });
  gm.handle("transform", (data, user) => transformAsGM(data, user));
  gm.handle("revert", (data, user) => revertAsGM(data, user));
}

/* The settings to transform with : the activity's, the ones given, else the preset's */
function settingsOf({ activity, settings, preset }){
  if(activity?.settings) return activity.settings;
  const Setting = activity?.settings?.constructor ?? globalThis.dnd5e?.dataModels?.settings?.TransformationSetting;
  const data = settings ?? { ...(CONFIG.DND5E.transformation?.presets?.[preset]?.settings ?? {}), preset };
  return Setting ? new Setting(data) : data;
}

async function transformAsGM({ actor : uuid, form, activity : activityUuid = null, settings = null, preset = "polymorph", token : tokenUuid = null, x, y } = {}, user){
  const actor = fromUuidSync(uuid ?? "", { strict : false });
  if(!actor?.testUserPermission(user, "OWNER")) return false;
  const source = await fromUuid(form ?? "");
  const activity = activityUuid ? await fromUuid(activityUuid) : null;
  if(!source) return false;
  const setting = settingsOf({ activity, settings, preset });
  const place = (Number.isFinite(x) && Number.isFinite(y)) ? { token : tokenUuid, x, y } : null;
  /* Unlinked token : dnd5e changes the token itself, wherever it is; then it goes where it fits */
  if(actor.isToken){
    const done = !!(await actor.transformInto(source, setting, { renderSheet : false }));
    if(done && place) await actor.token?.update({ x : place.x, y : place.y });
    return done;
  }
  const original = actor.isPolymorphed ? (game.actors.get(actor.getFlag("dnd5e", "originalActor")) ?? actor) : actor;
  const tokens = game.scenes.contents.flatMap(s => s.tokens.filter(t => t.actorLink && (t.actorId === actor.id)));
  await actor.transformInto(source, setting.clone ? setting.clone({ transformTokens : false }) : { ...setting, transformTokens : false }, { renderSheet : false });
  const shape = game.actors.filter(a => a.isPolymorphed && (a.getFlag("dnd5e", "originalActor") === original.id) && (a.id !== actor.id))
    .sort((a, b) => (a._stats?.createdTime ?? 0) - (b._stats?.createdTime ?? 0)).pop();
  const prototype = prototypes.get(actor.id);
  prototypes.delete(actor.id);
  if(!shape || !prototype) return !!shape;
  await retarget(tokens, shape, prototype, source, place);
  return true;
}

/* The creature's tokens become the form's (what dnd5e's transformInto does for the viewed scene) */
async function retarget(tokens, shape, prototype, source, place = null){
  const fromSource = ["width", "height", "alpha", "lockRotation", "ring"];
  const textureFromSource = ["offsetX", "offsetY", "scaleX", "scaleY", "src", "tint"];
  const fromSelf = ["bar1", "bar2", "displayBars", "displayName", "actorLink", "disposition"];
  const kept = [...fromSelf, "rotation", "elevation", "hidden", "level"];
  const byScene = new Map();
  for(const t of tokens){
    const data = foundry.utils.deepClone(prototype);
    data._id = t.id;
    data.actorId = shape.id;
    data.actorLink = true;
    for(const k of kept) data[k] = t[k];
    /* The token the player used : where the form fits (worked out on their map) */
    if(place && (t.uuid === place.token)){ data.x = place.x; data.y = place.y; }
    data.name = `${t.name} (${source.name})`;
    foundry.utils.setProperty(data, "flags.dnd5e.originalActor", shape.getFlag("dnd5e", "originalActor"));
    foundry.utils.setProperty(data, "flags.dnd5e.isPolymorphed", true);
    if(!t.flags.dnd5e?.previousTokenData){
      const previous = { texture : {} };
      for(const k of [...fromSource, ...fromSelf, "name"]) previous[k] = t[k];
      for(const k of textureFromSource) previous.texture[k] = t.texture[k];
      foundry.utils.setProperty(data, "flags.dnd5e.previousTokenData", previous);
    }
    if(!byScene.has(t.parent)) byScene.set(t.parent, []);
    byScene.get(t.parent).push(data);
  }
  for(const [scene, updates] of byScene) await scene.updateEmbeddedDocuments("Token", updates);
}

async function revertAsGM({ actor : uuid, token : tokenUuid = null, x, y } = {}, user){
  const actor = fromUuidSync(uuid ?? "", { strict : false });
  if(!actor?.testUserPermission(user, "OWNER") || !actor.isPolymorphed) return null;
  const original = await revertEverywhere(actor);
  /* Back to its own size where it fits (a smaller creature stays put; no room : it stays where the form was) */
  const token = tokenUuid ? fromUuidSync(tokenUuid, { strict : false }) : null;
  if(token && Number.isFinite(x) && Number.isFinite(y)) await token.update({ x, y }).catch(() => {});
  return original?.uuid ?? null;
}

/**
 * End the form (GM). dnd5e reverts the tokens on the scene the GM is viewing; the ones on other scenes are put back
 * here first, the way it does them.
 * @returns {Promise<Actor|null>}  the creature
 */
export async function revertEverywhere(actor){
  if(!actor.isToken){
    const original = game.actors.get(actor.getFlag("dnd5e", "originalActor"));
    if(original){
      const base = (await original.getTokenDocument()).toObject();
      for(const scene of game.scenes){
        if(canvas.ready && (scene === canvas.scene)) continue;
        const updates = scene.tokens.filter(t => t.actorId === actor.id).map(t => {
          const update = foundry.utils.deepClone(base);
          update._id = t.id;
          foundry.utils.mergeObject(update, t.getFlag("dnd5e", "previousTokenData") ?? {});
          for(const k of ["x", "y", "elevation", "hidden", "rotation", "level"]) delete update[k];
          return update;
        });
        if(updates.length) await scene.updateEmbeddedDocuments("Token", updates, { diff : false, recursive : false });
      }
    }
  }
  reverting.add(actor.id);
  Hooks.callAll(`${module.id}.reverting`, actor);
  let reverted;
  try { reverted = await actor.revertOriginalForm({ renderSheet : false }); }
  catch(error){ log.error("Revert", error); }
  finally { setTimeout(() => reverting.delete(actor.id), 2000); }
  return (reverted?.documentName === "Token") ? reverted.actor : (reverted ?? null);
}
