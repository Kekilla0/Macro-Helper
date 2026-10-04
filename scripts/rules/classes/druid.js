import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { gm } from '../../gm.js';
import { patch } from '../../patch.js';
import { folderActors, fitsProfile, chooseCreature, chooseCreatures } from '../../helpers/creatures.js';
import { restChoices } from '../rest-choices.js';
import { familiars } from '../familiars.js';
const log = logger.for(import.meta.url);

/**
 * Druid, levels 1-2 (Classes setting). Druidic and Primal Order are the items' own data. dnd5e's Wild Shape preset
 * keeps the Druid's HP and features, gives temp HP equal to its Druid level, and leaves its spells behind (no casting
 * while shifted).
 *
 *   Known forms    : chosen from the Actors folder "Wild Shapes" (any depth), only the creatures the item's current
 *                    profile allows (CR ¼ Beast, no fly speed at level 2), up to the class's Known Forms. Kept on the
 *                    Druid's Wild Shape item. Free to add up to the limit; replacing one needs a Long Rest (Rest
 *                    Choices : one swap per Long Rest). The GM can change them freely.
 *   Wild Shape     : using it asks which known form, and the form is taken straight away (no chat button). The GM's
 *                    client does the transform (players can't create actors), on whichever scene the Druid is.
 *                    Used while shifted : Leave form (the bonus action, nothing spent) or New form (spends a use).
 *                    The form carries a "Wild Shape" effect lasting half the Druid level in hours; the form ends when
 *                    that time is up, or when the creature is Incapacitated or dies (those conditions go with the
 *                    Druid). Uses spent while shifted (a new form, Wild Companion) are kept when the form ends.
 *   Familiars      : Wild Companion's familiar is the Find Familiar handling (rules/familiars.js).
 */
export class druid{
  static WILD_SHAPE = "wild-shape";
  static WILD_COMPANION = "wild-companion";
  static FORMS_FOLDERS = ["Wild Shapes"];
  static INCAPACITATED = ["incapacitated", "unconscious", "paralyzed", "petrified", "stunned", "dead"];

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.transformActorV2", (actor, source, data, transform) => this.onTransform(actor, data, transform));
    Hooks.on("createActiveEffect", effect => this.onEffect(effect));
    Hooks.on("updateActiveEffect", effect => this.onEffect(effect));
    Hooks.on("updateItem", (item, changes) => this.keepUses(item, changes));
    Hooks.on("dnd5e.postUseActivity", (activity, usage) => this.onUse(activity, usage));
    Hooks.on("dnd5e.restCompleted", (actor, result, config) => this.onRest(actor, result, config));
    /* Our uses take the form or make the familiar themselves : dnd5e's own buttons would do it again */
    Hooks.on("dnd5e.renderChatMessage", (message, html) => {
      if(message.getFlag?.(module.id, "auto")) html.querySelectorAll('[data-action="transformActor"], [data-action="placeSummons"]').forEach(b => b.remove());
    });
    /* dnd5e asks for a creature (its compendium search) : the one already chosen here. Its usage window can put
       back a profile, so this is the one sure way it doesn't search. */
    patch.wrap("CONFIG.DND5E.activityTypes.transform.documentClass.prototype.queryActor", async function(wrapped, ...args){
      return druid.takeChosen(this) ?? wrapped(...args);
    });
    gm.handle("wildShape", (data, user) => this.wildShapeAsGM(data, user));
    gm.handle("wildShapeLeave", (data, user) => this.leaveAsGM(data, user));
    restChoices.add({
      id : "wildShapeForms", label : "restChoices.wildShapeForms", rest : "long",
      applies : actor => this.enabled() && !!this.wildShapeItem(this.originalOf(actor)),
      grant : actor => this.wildShapeItem(this.originalOf(actor))?.setFlag(module.id, "formSwaps", 1),
      summary : actor => this.formsSummary(actor),
      open : actor => this.manageForms(actor),
    });
  }

  static idOf(item){
    return item?.identifier ?? item?.system?.identifier ?? "";
  }

  /**
   * Before dnd5e uses an activity (Roll Item's use wrapper) : Wild Shape's form, a familiar and its space.
   * @param {Activity} activity
   * @param {object} usage
   * @returns {Promise<{usage : object, flags : object}|false|null>}  false : stop the use; null : nothing to do here
   */
  static async beforeUse(activity, usage = {}){
    const id = this.idOf(activity?.item);
    if((activity?.type === "transform") && (id === this.WILD_SHAPE) && this.enabled()) return this.beforeWildShape(activity, usage);
    if(activity?.type === "summon") return familiars.beforeUse(activity, usage);
    return null;
  }

  /* ---------- Known forms ---------- */

  /* A Wild Shape form's own actor is a copy : the Druid's choices live on the original */
  static originalOf(actor){
    if(!this.isWildShaped(actor)) return actor;
    return game.actors.get(actor.getFlag("dnd5e", "originalActor")) ?? actor;
  }

  static wildShapeItem(actor){
    return actor?.items?.find(i => this.idOf(i) === this.WILD_SHAPE) ?? null;
  }

  static wildShapeActivity(item){
    return item?.system?.activities?.find?.(a => a.type === "transform") ?? null;
  }

  /* The profile the Druid's level allows now (CR ¼ Beast, no fly speed at level 2), and the roll data for its CR */
  static profileOf(actor){
    const activity = this.wildShapeActivity(this.wildShapeItem(actor));
    const profile = activity?.availableProfiles?.[0] ?? null;
    return { profile, rollData : activity?.getRollData?.({ deterministic : true }) ?? {} };
  }

  /* How many forms the Druid knows : the class's Known Forms scale (4 at level 2, 6 at 4, 8 at 8) */
  static formLimit(actor){
    const scale = Number(actor?.system?.scale?.druid?.["known-forms"]?.value);
    if(scale > 0) return scale;
    const level = Number(actor?.classes?.druid?.system?.levels) || 0;
    return (level >= 8) ? 8 : (level >= 4) ? 6 : (level >= 2) ? 4 : 0;
  }

  static knownForms(actor){
    return [...(this.wildShapeItem(actor)?.getFlag(module.id, "forms") ?? [])];
  }

  /* The folder's creatures the Druid may know now */
  static eligibleForms(actor){
    const { profile, rollData } = this.profileOf(actor);
    if(!profile) return [];
    return folderActors(this.FORMS_FOLDERS).filter(a => fitsProfile(a, profile, rollData));
  }

  static formsSummary(actor){
    const original = this.originalOf(actor);
    const swaps = Number(this.wildShapeItem(original)?.getFlag(module.id, "formSwaps")) || 0;
    return module.format("classes.druid.formsSummary", { known : this.knownForms(original).length, max : this.formLimit(original), swaps });
  }

  /**
   * Change the known forms : add up to the limit; replace only with a swap (a Long Rest gives one). The GM : freely.
   * @param {Actor} actor
   * @returns {Promise<string[]|null>}  the new list, null if nothing changed
   */
  static async manageForms(actor){
    const original = this.originalOf(actor);
    const item = this.wildShapeItem(original);
    if(!item) return null;
    const eligible = this.eligibleForms(original);
    if(!eligible.length){
      ui.notifications.warn(module.format("classes.druid.noForms", { folder : this.FORMS_FOLDERS[0] }));
      return null;
    }
    const known = this.knownForms(original);
    const swaps = game.user.isGM ? Infinity : (Number(item.getFlag(module.id, "formSwaps")) || 0);
    const chosen = await chooseCreatures(eligible, {
      known, max : this.formLimit(original), swaps,
      title : module.format("classes.druid.formsTitle", { name : original.name }),
      prompt : module.i18n("classes.druid.formsPrompt"),
    });
    if(!chosen) return null;
    const removed = known.filter(uuid => eligible.some(a => a.uuid === uuid) && !chosen.includes(uuid)).length;
    const update = { [`flags.${module.id}.forms`] : chosen };
    if(Number.isFinite(swaps)) update[`flags.${module.id}.formSwaps`] = Math.max(0, swaps - removed);
    await item.update(update);
    return chosen;
  }

  /* ---------- Wild Shape ---------- */

  /* A creature in a Wild Shape form (dnd5e's Wild Shape preset) */
  static isWildShaped(actor){
    return !!actor?.isPolymorphed && (actor.getFlag("dnd5e", "transformOptions")?.preset === "wildshape");
  }

  static async beforeWildShape(activity, usage){
    const actor = activity.actor;
    const original = this.originalOf(actor);
    /* Shifted : leave (the bonus action, nothing spent) or take a new form (spends a use) */
    if(this.isWildShaped(actor)){
      const choice = await foundry.applications.api.DialogV2.wait({
        window : { title : activity.item.name, icon : "fa-solid fa-paw" },
        content : `<p>${module.i18n("classes.druid.shiftedPrompt")}</p>`,
        buttons : [
          { action : "leave", label : module.i18n("classes.druid.leave"), icon : "fa-solid fa-person", default : true },
          { action : "new", label : module.i18n("classes.druid.newForm"), icon : "fa-solid fa-paw" },
        ],
        rejectClose : false,
      });
      if(choice === "leave"){
        await gm.run("wildShapeLeave", { actor : actor.uuid });
        return false;
      }
      if(choice !== "new") return false;
    }
    /* No use left : dnd5e says so */
    const uses = activity.item.system.uses;
    if(uses?.max && !(uses.value > 0)) return null;

    let form = null;
    while(!form){
      const { profile, rollData } = this.profileOf(original);
      const forms = this.knownForms(original).map(uuid => fromUuidSync(uuid, { strict : false }))
        .filter(a => a && fitsProfile(a, profile, rollData));
      if(!forms.length){
        if(!(await this.manageForms(original))?.length) return false;
        continue;
      }
      const chosen = await chooseCreature(forms, {
        title : activity.item.name, prompt : module.i18n("classes.druid.formPrompt"),
        extra : [{ action : "manage", label : module.i18n("classes.druid.knownForms"), icon : "fa-solid fa-list" }],
      });
      if(!chosen) return false;
      if(chosen === "manage"){ await this.manageForms(original); continue; }
      form = chosen;
    }
    this.#chosen.set(activity.item.uuid, { uuid : form, at : Date.now() });
    return {
      usage : { ...usage, [module.id] : { ...(usage[module.id] ?? {}), skipPick : true, wildShape : { form } } },
      flags : { auto : true },
    };
  }

  /* The creature chosen for a use, by item (dnd5e works on a copy of the item, same uuid), for a minute */
  static #chosen = new Map();

  static takeChosen(activity){
    const key = activity?.item?.uuid;
    const chosen = key ? this.#chosen.get(key) : null;
    if(!chosen) return null;
    this.#chosen.delete(key);
    return ((Date.now() - chosen.at) < 60000) ? chosen.uuid : null;
  }

  static async onUse(activity, usage){
    const own = usage?.[module.id];
    if(!own || !activity?.actor?.isOwner) return;
    this.#chosen.delete(activity.item?.uuid);
    try {
      if(own.wildShape?.form){
        await gm.run("wildShape", { actor : activity.actor.uuid, item : activity.item.uuid, activity : activity.id, form : own.wildShape.form });
      }
    } catch(error){
      log.error(error);
      ui.notifications.warn(error.message);
    }
  }

  /* The new form's token data, caught as dnd5e builds it, for the Druid's tokens on other scenes */
  static #prototype = new Map();

  /* The form's duration, as an effect on it : half the Druid level in hours (at least 1) */
  static onTransform(actor, data, transform){
    if((transform?.preset !== "wildshape") || !data) return;
    if(data.prototypeToken) this.#prototype.set(actor.id, foundry.utils.deepClone(data.prototypeToken));
    if(!this.enabled() || !Array.isArray(data.effects)) return;
    /* Temp HP don't stack : dnd5e sets the form's, keep the Druid's own when they're higher */
    const hp = data.system?.attributes?.hp;
    const had = Number(actor.system?.attributes?.hp?.temp) || 0;
    if(hp && (had > (Number(hp.temp) || 0))) hp.temp = had;
    const levels = Number(actor.classes?.druid?.system?.levels) || 0;
    const hours = Math.max(1, Math.floor(levels / 2));
    const item = actor.items.find(i => this.idOf(i) === this.WILD_SHAPE);
    /* A new form from a form : the old form's Wild Shape effect comes along with its effects; the new use starts a new one */
    data.effects = data.effects.filter(e => !foundry.utils.getProperty(e, `flags.${module.id}.wildShape`));
    data.effects.push({
      _id : foundry.utils.randomID(),
      name : item?.name ?? module.i18n("classes.druid.wildShape"),
      img : item?.img ?? "icons/creatures/mammals/wolf-howl-moon-gray.webp",
      origin : item?.uuid ?? null,
      transfer : false,
      duration : { value : hours, units : "hours", expiry : null },
      start : { time : game.time.worldTime },
      showIcon : CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2,
      flags : { [module.id] : { wildShape : true } },
    });
  }

  /**
   * GM : take the form, for the Druid's owner. Only a form it knows (the GM : any). dnd5e only updates the tokens on
   * the scene the GM is viewing, so the Druid's tokens elsewhere are updated here, from the same token data.
   */
  static async wildShapeAsGM({ actor : uuid, item : itemUuid, activity : activityId, form } = {}, user){
    const actor = fromUuidSync(uuid ?? "", { strict : false });
    if(!actor?.testUserPermission(user, "OWNER")) return false;
    const original = this.originalOf(actor);
    if(!user.isGM && !this.knownForms(original).includes(form)) return false;
    const source = await fromUuid(form ?? "");
    const activity = fromUuidSync(itemUuid ?? "", { strict : false })?.system?.activities?.get(activityId);
    if(!source || !activity?.settings) return false;

    /* Unlinked token : dnd5e changes the token itself, wherever it is */
    if(actor.isToken) return !!(await actor.transformInto(source, activity.settings, { renderSheet : false }));

    const tokens = game.scenes.contents.flatMap(s => s.tokens.filter(t => t.actorLink && (t.actorId === actor.id)));
    await actor.transformInto(source, activity.settings.clone({ transformTokens : false }), { renderSheet : false });
    const shape = game.actors.filter(a => a.isPolymorphed && (a.getFlag("dnd5e", "originalActor") === original.id) && (a.id !== actor.id))
      .sort((a, b) => (a._stats?.createdTime ?? 0) - (b._stats?.createdTime ?? 0)).pop();
    const prototype = this.#prototype.get(actor.id);
    this.#prototype.delete(actor.id);
    if(!shape || !prototype) return !!shape;
    await this.#retarget(tokens, shape, prototype, source);
    return true;
  }

  /* The Druid's tokens become the form's (what dnd5e's transformInto does for the viewed scene) */
  static async #retarget(tokens, shape, prototype, source){
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

  /* GM : leave the form, for its owner */
  static async leaveAsGM({ actor : uuid } = {}, user){
    const actor = fromUuidSync(uuid ?? "", { strict : false });
    if(!actor?.testUserPermission(user, "OWNER") || !this.isWildShaped(actor)) return false;
    await this.revertEverywhere(actor);
    return true;
  }

  /**
   * End the form. dnd5e reverts the tokens on the scene the GM is viewing; the ones on other scenes are put back here
   * first, the way it does them.
   * @returns {Promise<Actor|null>}  the Druid
   */
  static async revertEverywhere(actor){
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
    const reverted = await actor.revertOriginalForm({ renderSheet : false });
    return (reverted?.documentName === "Token") ? reverted.actor : (reverted ?? null);
  }

  /* A Wild Shape use spent while shifted is spent on the form's copy of the item : the Druid's own follows (GM) */
  static async keepUses(item, changes){
    if(!game.users.activeGM?.isSelf || (this.idOf(item) !== this.WILD_SHAPE)) return;
    if(!foundry.utils.hasProperty(changes ?? {}, "system.uses.spent")) return;
    const actor = item.parent;
    if(!this.isWildShaped(actor)) return;
    const own = this.wildShapeItem(this.originalOf(actor));
    if(own && (own !== item) && (own.system.uses?.spent !== item.system.uses?.spent)){
      await own.update({ "system.uses.spent" : item.system.uses.spent });
    }
  }

  static #busy = Promise.resolve();

  /* Incapacitated, dead, or its time up : the form ends. Several changes arrive together : one at a time */
  static onEffect(effect){
    const run = this.#busy.then(() => this.#check(effect));
    this.#busy = run.catch(() => {});
    return run;
  }

  static async #check(effect){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    const actor = (effect?.parent?.documentName === "Actor") ? effect.parent : null;
    if(!this.isWildShaped(actor)) return;
    const down = this.INCAPACITATED.some(s => actor.statuses?.has(s));
    const expired = !!effect.getFlag(module.id, "wildShape") && !!effect.duration?.expired;
    if(!down && !expired) return;
    await this.endWildShape(actor, module.i18n(down ? "classes.druid.incapacitated" : "classes.druid.expired"));
  }

  /* The form's conditions that end it go with the Druid (reverting drops the form's effects : Unconscious at 0 HP) */
  static CARRIED = [...this.INCAPACITATED, "prone"];

  static async endWildShape(actor, why){
    if(!this.isWildShaped(actor)) return;
    log.debug("Wild Shape ends", actor.name, why);
    const carried = this.CARRIED.filter(s => actor.statuses?.has(s));
    const original = await this.revertEverywhere(actor);
    for(const status of carried){
      if(original && !original.statuses?.has(status)) await original.toggleStatusEffect(status, { active : true });
    }
    ui.notifications.info(module.format("classes.druid.ended", { name : actor.name, why }));
  }

  /**
   * A rest : a Wild Shape form with no more time left than the rest lasted ends (1 hour at levels 2-3 : any rest);
   * Wild Companion's familiar goes when the Druid finishes a Long Rest (resting shifted too : the familiar is the Druid's).
   */
  static onRest(actor, result, config){
    if(!this.enabled() || !actor?.isOwner) return;
    if(this.restEndsForm(actor, config)){
      gm.run("wildShapeLeave", { actor : actor.uuid })
        .then(() => ui.notifications.info(module.format("classes.druid.ended", { name : actor.name, why : module.i18n("classes.druid.rested") })))
        .catch(error => log.error(error));
    }
    if(!(result?.longRest || (config?.type === "long"))) return;
    const druidActor = this.originalOf(actor);
    if(!druidActor.items.some(i => this.idOf(i) === this.WILD_COMPANION)) return;
    gm.run("wildCompanionDismiss", { actor : druidActor.uuid }).catch(error => log.error(error));
  }

  static UNIT_SECONDS = { seconds : 1, minutes : 60, hours : 3600, days : 86400 };

  /* Does the rest outlast the form ? The rest's own length (dnd5e, in minutes) against the Wild Shape effect's time left.
     A GM's rest that moved the clock has already counted it (the effect expires on its own). */
  static restEndsForm(actor, config){
    if(!this.isWildShaped(actor)) return false;
    const effect = actor.effects?.find(e => e.getFlag(module.id, "wildShape"));
    const value = Number(effect?.duration?.value);
    if(!effect || !(value > 0)) return false;
    const end = (Number(effect.start?.time) || 0) + (value * (this.UNIT_SECONDS[effect.duration.units] ?? 3600));
    const moved = !!config?.advanceTime && game.user.isGM;
    const rest = moved ? 0 : (Number(config?.duration) || 0) * 60;
    return (end - game.time.worldTime - rest) <= 0;
  }
}
