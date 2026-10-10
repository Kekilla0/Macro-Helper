import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { uses } from '../uses.js';
import { idOf, chooseOption } from '../helpers/utils.js';
import { tokenOf, getRange } from '../helpers/tokens.js';
import { pickSpace } from '../helpers/targets.js';
const log = logger.for(import.meta.url);

/**
 * Dancing Lights (Characters → Spells), when the item has nothing to summon (Plutonium's summon has no profiles; an
 * item with a profile is left to dnd5e's own summoning).
 *
 *   Cast   : four lights or one glowing Medium form, then where each goes on the map (within the spell's range, each
 *            light within 20 ft of another; over a creature is fine). Esc after the first : no more lights. Closing
 *            before the first : nothing cast.
 *   Lights : tokens made by the GM's client, nothing drawn but their light (Dim Light in a 10 ft radius), Neutral (no
 *            one's ally : not a creature beside a target for Sneak Attack or flanking), owned by the caster's players (moved by hand : the spell's Move Lights). Not creatures : no combat, no sheet to fill in
 *            (one "Dancing Light" actor in the summons folder stands behind them all).
 *   Ending : with the spell's Concentration; casting it again replaces them; a light moved beyond the spell's range
 *            (from the caster) vanishes.
 */
export class dancingLights{
  static ID = "dancing-lights";
  static COUNT = 4;
  static SPREAD = 20;
  /* The spell's range when the item has none (120 ft) */
  static RANGE = 120;
  /* The actor's icon in the sidebar (the tokens show nothing but their light) */
  static ICON = "icons/svg/light.svg";

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("spellRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    uses.onActivity("dancingLights", (activity, ctx, next) => this.step(activity, ctx, next));
    gm.handle("dancingLights", (data, user) => this.createAsGM(data, user));
    Hooks.on("deleteActiveEffect", effect => this.onConcentrationEnd(effect));
    Hooks.on("updateToken", (token, changes) => this.onMove(token, changes));
    /* Lights made before they were Neutral */
    Hooks.once("ready", () => this.neutralAsGM());
  }

  static async neutralAsGM(){
    if(!game.users.activeGM?.isSelf) return;
    const NEUTRAL = CONST.TOKEN_DISPOSITIONS.NEUTRAL;
    for(const scene of game.scenes){
      const updates = scene.tokens.filter(t => t.getFlag(module.id, "dancingLight") && (t.disposition !== NEUTRAL)).map(t => ({ _id : t.id, disposition : NEUTRAL }));
      if(updates.length) await scene.updateEmbeddedDocuments("Token", updates).catch(error => log.debug(error));
    }
  }

  /* Ours to do : the spell, its summon, nothing for dnd5e to summon */
  static applies(activity){
    return this.enabled() && (activity?.type === "summon") && (idOf(activity.item) === this.ID) && !(activity.availableProfiles?.length);
  }

  /* ---------- Casting ---------- */

  static async step(activity, ctx, next){
    if(!this.applies(activity)) return next();
    const from = tokenOf(activity.actor);
    if(!from){
      ui.notifications.warn(module.i18n("helpers.pick.noToken"));
      return;
    }
    const form = await chooseOption({ title : activity.item.name, icon : "fa-solid fa-lightbulb", prompt : module.i18n("spells.dancingLights.prompt"),
      options : [{ value : "lights", label : module.format("spells.dancingLights.lights", { n : this.COUNT }) }, { value : "form", label : module.i18n("spells.dancingLights.form") }] });
    if(!form) return;
    const range = getRange(activity) || this.RANGE;
    const points = await this.pickPoints(from, form === "form" ? 1 : this.COUNT, range);
    if(!points.length) return;

    uses.mark(ctx, { skipPick : true });
    ctx.config = { ...ctx.config, create : { ...(ctx.config?.create ?? {}), summons : false } };
    const result = await next();
    /* Cast (a card made, or dnd5e's message) : the lights */
    if(!result || ((result?.[module.id]?.card) && !(await uses.cardOf(result)))) return result;
    try {
      await gm.run("dancingLights", { item : activity.item.uuid, scene : from.document.parent.id, points, form, range,
        caster : from.document.uuid });
    } catch(error){
      log.error(error);
      ui.notifications.warn(error.message);
    }
    return result;
  }

  /* Where each goes : within range, each light within 20 ft of one already placed */
  static async pickPoints(from, count, range){
    const grid = canvas.grid.size;
    const centre = p => ({ x : p.x + (grid / 2), y : p.y + (grid / 2) });
    const points = [];
    for(let i = 0; i < count; i++){
      const point = await pickSpace(from, { range, occupied : true,
        banner : module.i18n("spells.dancingLights.banner"),
        notice : (count > 1) ? module.format("spells.dancingLights.which", { n : i + 1, of : count }) : "",
        keys : module.i18n(points.length ? "spells.dancingLights.done" : "helpers.space.keys"),
        check : at => (points.length && !points.some(p => canvas.grid.measurePath([centre(p), centre(at)]).distance <= this.SPREAD))
          ? module.format("spells.dancingLights.spread", { feet : this.SPREAD }) : "" });
      if(!point) break;
      points.push(point);
    }
    return points;
  }

  /* ---------- The GM's client : the tokens ---------- */

  /* The one actor behind every light (not a creature to look after) */
  static async lightActor(img){
    const found = game.actors.find(a => a.getFlag(module.id, "dancingLight"));
    if(found && (found.img !== img)) await found.update({ img, "prototypeToken.texture.src" : img });
    if(found) return found;
    const folder = game.folders.find(f => (f.type === "Actor") && f.getFlag(module.id, "summons"))
      ?? await Folder.implementation.create({ name : module.i18n("compendiums.summonsFolder"), type : "Actor", flags : { [module.id] : { summons : true } } });
    const name = module.i18n("spells.dancingLights.actor");
    return Actor.implementation.create({
      name, type : "npc", img, folder : folder?.id ?? null, ownership : { default : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
      system : { attributes : { hp : { value : 1, max : 1 } }, traits : { size : "tiny" } },
      prototypeToken : { name, actorLink : false, width : 0.5, height : 0.5, texture : { src : img },
        displayName : CONST.TOKEN_DISPLAY_MODES.NONE, displayBars : CONST.TOKEN_DISPLAY_MODES.NONE, sight : { enabled : false } },
      flags : { [module.id] : { dancingLight : true } },
    });
  }

  /* The lights of a caster (any scene) */
  static lightsOf(casterActorUuid){
    return game.scenes.contents.flatMap(s => s.tokens.filter(t => t.getFlag(module.id, "dancingLight")?.actor === casterActorUuid));
  }

  static async createAsGM({ item : itemUuid, scene : sceneId, points = [], form = "lights", range, caster : casterUuid } = {}, user){
    const item = fromUuidSync(itemUuid ?? "", { strict : false });
    const actor = item?.actor;
    const scene = game.scenes.get(sceneId);
    if(!actor?.testUserPermission(user, "OWNER") || !scene || (idOf(item) !== this.ID)) return false;
    const count = Math.min(points.length, (form === "form") ? 1 : this.COUNT);
    if(!count) return false;

    /* Casting it again : the old ones go */
    await this.remove(this.lightsOf(actor.uuid));
    /* Its Concentration (dnd5e starts it as the spell is cast) : they end with it */
    let concentration = null;
    for(let i = 0; (i < 10) && !concentration; i++){
      concentration = actor.effects.find(e => e.statuses?.has?.(CONFIG.specialStatusEffects.CONCENTRATING) && (e.getFlag("dnd5e", "item")?.id === item.id)) ?? null;
      if(!concentration) await new Promise(r => setTimeout(r, 100));
    }

    const base = await this.lightActor(this.ICON);
    const owners = Object.fromEntries(game.users.filter(u => !u.isGM && actor.testUserPermission(u, "OWNER")).map(u => [u.id, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER]));
    const grid = scene.grid.size;
    const size = (form === "form") ? 1 : 0.5;
    const offset = (1 - size) * grid / 2;
    const data = [];
    for(const point of points.slice(0, count)){
      const token = await base.getTokenDocument({
        x : point.x + offset, y : point.y + offset, width : size, height : size, name : item.name,
        /* Just the light : the token itself isn't drawn (still there to grab and move) */
        texture : { src : this.ICON }, alpha : 0, disposition : CONST.TOKEN_DISPOSITIONS.NEUTRAL,
        light : { dim : 10, bright : 0, color : "#ffd27a", alpha : 0.4, animation : { type : "torch", speed : 2, intensity : 2 } },
        delta : { ownership : { default : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, ...owners } },
        flags : { [module.id] : { dancingLight : { actor : actor.uuid, caster : casterUuid ?? null, concentration : concentration?.uuid ?? null, range : Number(range) || this.RANGE } } },
      });
      data.push(token.toObject());
    }
    const created = await scene.createEmbeddedDocuments("Token", data, { dnd5e : { autoRollNPCHP : "no" } });
    log.debug("Dancing Lights", actor.name, created.length, form);
    return true;
  }

  static async remove(tokens){
    const byScene = new Map();
    for(const t of tokens) byScene.set(t.parent, [...(byScene.get(t.parent) ?? []), t.id]);
    for(const [scene, ids] of byScene) await scene.deleteEmbeddedDocuments("Token", ids).catch(error => log.debug(error));
  }

  /* The Concentration ended : so do its lights */
  static async onConcentrationEnd(effect){
    if(!game.users.activeGM?.isSelf) return;
    const lights = game.scenes.contents.flatMap(s => s.tokens.filter(t => t.getFlag(module.id, "dancingLight")?.concentration === effect.uuid));
    if(lights.length) await this.remove(lights);
  }

  /* Beyond the spell's range from the caster (a light moved, or the caster) : that light vanishes */
  static async onMove(token, changes){
    if(!game.users.activeGM?.isSelf || !(("x" in (changes ?? {})) || ("y" in (changes ?? {})))) return;
    const scene = token.parent;
    const flag = token.getFlag(module.id, "dancingLight");
    const pairs = flag ? [[token, this.casterToken(scene, flag)]]
      : scene.tokens.filter(t => (t.getFlag(module.id, "dancingLight")?.caster === token.uuid)).map(t => [t, token]);
    const centre = t => ({ x : t.x + (t.width * scene.grid.size / 2), y : t.y + (t.height * scene.grid.size / 2) });
    const far = pairs.filter(([light, caster]) => caster && (scene.grid.measurePath([centre(light), centre(caster)]).distance > (Number(light.getFlag(module.id, "dancingLight")?.range) || this.RANGE))).map(([light]) => light);
    if(far.length) await this.remove(far);
  }

  static casterToken(scene, flag){
    const token = flag?.caster ? fromUuidSync(flag.caster, { strict : false }) : null;
    return (token?.parent === scene) ? token : null;
  }
}
