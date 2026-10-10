import { module } from '../module.js';
import { idOf, whisperOwners, wait } from '../helpers/utils.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { patch } from '../patch.js';
import { uses } from '../uses.js';
import { initiative } from './initiative.js';
import { limits } from './limits.js';
import { tokenOf, getRange } from '../helpers/tokens.js';
import { pickSpace } from '../helpers/targets.js';
import { fitsProfile, chooseCreature } from '../helpers/creatures.js';
import { compendiums } from './compendiums.js';
const log = logger.for(import.meta.url);

/**
 * Familiars (2024 Find Familiar) : the spell itself (Spells setting) and the Druid's Wild Companion, which casts it
 * (Classes setting).
 *
 *   Summoning  : choose from the Familiars compendium (Macro Helper) (what the activity's profile allows :
 *                CR 0 Beast), then an empty space within the spell's range (10 ft) on the map. The token is made there
 *                by the GM's client, on the summoner's side and owned by its players. Not in a Wild Shape form (it's a
 *                spell). One familiar at a time : a new one replaces the last.
 *   Can't attack : the familiar's items with an attack are removed when it's summoned.
 *   0 HP       : it disappears; only casting the spell again brings one back.
 *   Already one : using the item again asks first. With a familiar out : Store it (kept as it is now : HP,
 *                conditions...), Summon New (casts again, replacing it) or Release it. With one stored : Bring It Back
 *                (an empty space within 30 ft, exactly as it was, nothing spent) or Summon New. Storing, releasing and
 *                bringing back spend nothing (they're the spell's Magic actions, not a new casting).
 *   Long Rest  : Wild Companion's familiar disappears (resting in a Wild Shape form too : the familiar is the Druid's).
 *   Pact of the Chain (Warlock invocation, Classes) : its own summons and the Warlock's Find Familiar are handled the
 *                same way, offering the special forms too (the activity's own creatures : Imp, Pseudodragon, Quasit...).
 *                A Pact of the Chain Warlock's familiar keeps its attacks (it can attack with its Reaction).
 */
export class familiars{
  static WILD_COMPANION = "wild-companion";
  static FIND_FAMILIAR = "find-familiar";
  static PACT = "pact-of-the-chain";
  static IDS = [this.WILD_COMPANION, this.FIND_FAMILIAR, this.PACT];
  /* Find Familiar's range (Wild Companion casts it), and how far a dismissed familiar can reappear */
  static RANGE = 10;
  static RETURN_RANGE = 30;

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.postUseActivity", (activity, usage) => this.onUse(activity, usage));
    Hooks.on("updateActor", (actor, changes) => this.onDamaged(actor, changes));
    /* Anything that gives it an attack later (a macro adding Unarmed Strike to new tokens) : taken away again */
    Hooks.on("createItem", item => this.onItemAdded(item));
    /* Asked at the item, before dnd5e's choice of activity (spell slot / Wild Shape) : storing needs neither */
    uses.onItem("familiar", async (item, ctx, next) => {
      const choice = await this.beforeItemUse(item);
      if(choice === false) return;
      if(choice) uses.mark(ctx, { familiarChoice : choice });
      return next();
    });
    /* dnd5e's own summoning (its chat button, a use our question didn't see) : our compendium, never its browser */
    Hooks.once("setup", () => patch.wrap("CONFIG.DND5E.activityTypes.summon.documentClass.prototype.queryActor", async function(wrapped, ...args){
      if(!familiars.enabledFor(idOf(this.item))) return wrapped(...args);
      const profile = args[0];
      const creatures = (await compendiums.entries(compendiums.FAMILIARS)).filter(a => !profile || fitsProfile(a, profile, this.getRollData?.({ deterministic : true }) ?? {}));
      return creatures.length ? chooseCreature(creatures, { title : this.item.name, prompt : module.i18n("classes.druid.familiarPrompt") }) : wrapped(...args);
    }));
    gm.handle("summonFamiliar", (data, user) => this.summonAsGM(data, user));
    gm.handle("familiarStore", (data, user) => this.storeAsGM(data, user));
    gm.handle("familiarRelease", (data, user) => this.releaseAsGM(data, user));
    gm.handle("familiarReturn", (data, user) => this.returnAsGM(data, user));
    gm.handle("wildCompanionDismiss", (data, user) => this.longRestAsGM(data, user));
  }


  /* Wild Companion : Classes. Find Familiar : Spells */
  static enabledFor(id){
    if(game.system.id !== "dnd5e") return false;
    if(id === this.WILD_COMPANION) return settings.value("classRules");
    if(id === this.FIND_FAMILIAR) return settings.value("spellRules");
    if(id === this.PACT) return settings.value("classRules");
    return false;
  }

  /* A Pact of the Chain Warlock (its familiars can attack, and have the special forms) */
  static chainOf(actor){
    return actor?.items?.find?.(i => idOf(i) === this.PACT) ?? null;
  }

  /* One of the special forms ? Plutonium's creatures resolve to its compendium copy or to the world's imported one,
     depending on what a client has loaded : by reference, else by name */
  static async isSpecialForm(activity, uuid){
    const forms = await this.specialForms(activity);
    if(forms.some(a => a.uuid === uuid)) return true;
    const doc = fromUuidSync(uuid, { strict : false }) ?? await fromUuid(uuid).catch(() => null);
    return !!doc?.name && forms.some(a => a.name === doc.name);
  }

  /* The special forms an activity names itself (Pact of the Chain's), and a Pact Warlock's on Find Familiar : creatures */
  static async specialForms(activity){
    const sources = [activity, ...(this.chainOf(activity?.actor)?.system?.activities ?? [])];
    const found = new Map();
    for(const source of sources){
      for(const profile of source?.profiles ?? []){
        if(!profile?.uuid || found.has(profile.uuid)) continue;
        /* Plutonium's creatures resolve synchronously only (fromUuid finds nothing for them on a player's client); a
           compendium's (dnd5e's own Pact of the Chain) give only an index entry that way : loaded */
        let actor = fromUuidSync(profile.uuid, { strict : false });
        if(actor?.documentName !== "Actor") actor = await fromUuid(profile.uuid).catch(() => null) ?? actor;
        if(actor?.documentName === "Actor") found.set(profile.uuid, actor);
      }
    }
    return [...found.values()];
  }

  static isWildShaped(actor){
    return !!actor?.isPolymorphed && (actor.getFlag("dnd5e", "transformOptions")?.preset === "wildshape");
  }

  /* The item that summoned a creature, if it's a familiar of ours */
  static originOf(actor){
    const origin = fromUuidSync(actor?.getFlag?.("dnd5e", "summon.origin") ?? "", { strict : false });
    return (origin && this.IDS.includes(idOf(origin))) ? origin : null;
  }

  static async remove(tokens){
    for(const token of new Set(tokens)){
      if(token?.parent?.tokens?.has?.(token.id)) await token.delete().catch(error => log.debug("Already gone", error));
    }
  }

  /* The summoner's familiars (from these items), as tokens */
  static tokensOf(actor, ids = this.IDS){
    const creatures = dnd5e.registry?.summons?.creatures?.(actor) ?? [];
    return creatures.filter(c => ids.includes(idOf(this.originOf(c))))
      .flatMap(c => c.token ? [c.token] : c.getActiveTokens(false, true));
  }

  /* ---------- Summoning ---------- */

  /**
   * Before dnd5e uses the activity (Roll Item's use wrapper) : the familiar and its space.
   * @returns {Promise<{usage : object, flags : object}|false|null>}  false : stop the use; null : dnd5e's own summoning
   */
  static async beforeUse(activity, usage = {}){
    if((activity?.type !== "summon") || !this.enabledFor(idOf(activity.item))) return null;
    /* A familiar out, or one stored : what to do with it (storing, releasing, bringing back spend nothing) */
    const summoner = activity.actor;
    const out = this.tokensOf(this.druidOf(summoner));
    const stored = this.druidOf(summoner)?.getFlag(module.id, "pocketFamiliar");
    if((out.length || stored) && (usage?.[module.id]?.familiarChoice !== "new")){
      const choice = await this.askExisting(activity, { out, stored });
      if(choice === "store"){ await gm.run("familiarStore", { summoner : this.druidOf(summoner).uuid }); return false; }
      if(choice === "release"){ await gm.run("familiarRelease", { summoner : this.druidOf(summoner).uuid }); return false; }
      if(choice === "back"){ await this.bringBack(this.druidOf(summoner)); return false; }
      if(choice !== "new") return false;
    }
    /* It casts a spell, and no spells can be cast in a Wild Shape form */
    if(this.isWildShaped(activity.actor) && !usage?.[module.id]?.shiftedAllowed && !limits.allow(module.format("classes.druid.noSpellsShifted", { name : activity.item.name }), { who : activity.actor.name, what : activity.item.name })) return false;
    const profile = activity.availableProfiles?.find?.(p => !p.uuid) ?? activity.availableProfiles?.[0];
    const rollData = activity.getRollData?.({ deterministic : true }) ?? {};
    const creatures = (await compendiums.entries(compendiums.FAMILIARS)).filter(a => !profile || profile.uuid || fitsProfile(a, profile, rollData));
    /* Pact of the Chain : its special forms too */
    if(this.chainOf(activity.actor)) for(const form of await this.specialForms(activity)) if(!creatures.some(c => c.name === form.name)) creatures.push(form);
    if(!creatures.length){
      ui.notifications.warn(module.i18n("classes.druid.noFamiliars"));
      return null;
    }
    const creature = await chooseCreature(creatures, { title : activity.item.name, prompt : module.i18n("classes.druid.familiarPrompt") });
    if(!creature) return false;
    const actor = creatures.find(a => a.uuid === creature);
    /* A special form : its own profile when the activity has one */
    const ownProfile = activity.profiles?.find?.(p => p.uuid === creature);
    const from = tokenOf(activity.actor);
    if(!from){
      ui.notifications.warn(module.i18n("helpers.pick.noToken"));
      return false;
    }
    const range = (idOf(activity.item) === this.WILD_COMPANION) ? this.RANGE : (getRange(activity) || this.RANGE);
    const size = Math.max(1, Math.round(Number(actor?.prototypeToken?.width) || 1));
    const space = await pickSpace(from, { range, size, notice : actor?.name ?? "" });
    if(!space) return false;
    return {
      usage : { ...usage, create : { ...(usage.create ?? {}), summons : false },
        [module.id] : { ...(usage[module.id] ?? {}), skipPick : true,
          familiar : { creature, x : space.x, y : space.y, scene : from.document.parent.id, elevation : from.document.elevation ?? 0, profile : (ownProfile ?? profile)?._id ?? null } } },
      flags : { auto : true },
    };
  }

  static async onUse(activity, usage){
    const familiar = usage?.[module.id]?.familiar;
    if(!familiar?.creature || !activity?.actor?.isOwner) return;
    try {
      const token = tokenOf(activity.actor)?.document;
      await gm.run("summonFamiliar", { item : activity.item.uuid, activity : activity.id, ...familiar,
        disposition : token?.disposition ?? activity.actor.prototypeToken?.disposition ?? 1 });
    } catch(error){
      log.error(error);
      ui.notifications.warn(error.message);
    }
  }

  /* Items it could attack with (a familiar can't attack) */
  static attackItems(actor){
    return (actor?.items ?? []).filter(i => i.system?.activities?.some?.(a => a.type === "attack"));
  }

  /**
   * GM : make the familiar's token, for the summoner's owner : a creature from the Familiars compendium, in the space it
   * picked, through dnd5e's own summon data (Fey, its flags), on the summoner's side and owned by its players, with
   * nothing to attack with.
   */
  static async summonAsGM({ item : itemUuid, activity : activityId, creature, x, y, scene : sceneId, elevation = 0, profile : profileId, disposition = 1 } = {}, user){
    const activity = fromUuidSync(itemUuid ?? "", { strict : false })?.system?.activities?.get(activityId);
    const summoner = activity?.actor;
    if(!summoner?.testUserPermission(user, "OWNER")) return false;
    if(!user.isGM && !(await compendiums.entries(compendiums.FAMILIARS)).some(a => a.uuid === creature) && !(await this.isSpecialForm(activity, creature))) return false;
    const scene = game.scenes.get(sceneId);
    /* A world copy of the compendium's creature for its token (dnd5e's own : reused the next time) */
    const actor = creature ? await dnd5e.documents.Actor5e.fetchExisting(creature).catch(error => { log.error(error); return null; }) : null;
    const profile = activity.profiles.find(p => p._id === profileId) ?? activity.availableProfiles?.[0];
    if(!scene || !actor || !profile) return false;

    /* One familiar at a time : a new one replaces the last, or the one in its pocket dimension */
    await this.remove(this.tokensOf(summoner));
    await this.forget(summoner);
    const options = { profile : profile._id, creatureType : activity.creatureTypes?.first?.() ?? null, creatureSize : activity.creatureSizes?.first?.() ?? null };
    const changes = await activity.getChanges(actor, profile, options);
    changes.tokenUpdates.disposition = disposition;
    const owners = Object.fromEntries(game.users.filter(u => !u.isGM && summoner.testUserPermission(u, "OWNER")).map(u => [u.id, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER]));
    changes.actorUpdates.ownership = { ...(actor.ownership ?? {}), ...owners };
    const config = { actor, placement : { x, y, elevation, rotation : 0 }, ...changes };
    if(Hooks.call("dnd5e.preSummonToken", activity, profile, config, options) === false) return false;
    const tokenData = await activity.getTokenData(config);
    Hooks.callAll("dnd5e.summonToken", activity, profile, tokenData, options);
    const created = await scene.createEmbeddedDocuments("Token", [tokenData], { dnd5e : { autoRollNPCHP : "no" } });
    Hooks.callAll("dnd5e.postSummon", activity, profile, created, options);

    /* A familiar can't attack (a Pact of the Chain Warlock's can) */
    const familiar = created?.[0]?.actor;
    const attacks = this.chainOf(summoner) ? [] : this.attackItems(familiar).map(i => i.id);
    if(attacks.length) await familiar.deleteEmbeddedDocuments("Item", attacks);
    log.debug("Familiar", summoner.name, actor.name, "attacks removed", attacks.length);
    return true;
  }

  /* ---------- 0 HP ---------- */

  /* At 0 HP it disappears (the active GM) */
  static async onDamaged(actor, changes){
    if(!game.users.activeGM?.isSelf || !foundry.utils.hasProperty(changes ?? {}, "system.attributes.hp")) return;
    const origin = this.originOf(actor);
    const down = () => (Number(actor.system?.attributes?.hp?.value) || 0) <= 0;
    if(!origin || !this.enabledFor(idOf(origin)) || !down()) return;
    /* After whatever else answers this damage (dnd5e, conditions, hook macros) has finished with it */
    await wait(this.DROP_DELAY);
    const tokens = (actor.token ? [actor.token] : actor.getActiveTokens(false, true)).filter(t => t?.parent?.tokens?.has?.(t.id));
    if(!tokens.length || !down()) return;
    await this.remove(tokens);
    ui.notifications.info(module.format("familiars.dropped", { name : actor.name }));
  }

  static DROP_DELAY = 750;

  /* An attack item added to a familiar after it was summoned : removed (the active GM) */
  static async onItemAdded(item){
    if(!game.users.activeGM?.isSelf) return;
    const actor = item?.parent;
    const origin = this.originOf(actor);
    if(!origin || !this.enabledFor(idOf(origin)) || this.chainOf(origin.actor) || !this.attackItems({ items : [item] }).length) return;
    await item.delete().catch(error => log.debug("Already gone", error));
  }

  /* ---------- Store, release, bring back ---------- */

  /* The Druid behind a Wild Shape form : the familiar and its store are the Druid's */
  static druidOf(actor){
    if(!this.isWildShaped(actor)) return actor;
    return game.actors.get(actor.getFlag("dnd5e", "originalActor")) ?? actor;
  }

  /**
   * Using the item (before dnd5e asks which activity) : with a familiar out or stored, what to do. Store, Release and
   * Bring It Back happen here, and the use stops.
   * @returns {Promise<"new"|false|null>}  "new" : go on to a new summoning; false : done here; null : nothing to ask
   */
  static async beforeItemUse(item){
    const id = idOf(item);
    if(!this.IDS.includes(id) || !this.enabledFor(id) || !item.actor) return null;
    if(!item.system?.activities?.some?.(a => a.type === "summon")) return null;
    const druid = this.druidOf(item.actor);
    const out = this.tokensOf(druid);
    const stored = druid?.getFlag(module.id, "pocketFamiliar");
    if(!out.length && !stored) return null;
    const choice = await this.askExisting(item, { out, stored });
    if(choice === "store"){ await gm.run("familiarStore", { summoner : druid.uuid }); return false; }
    if(choice === "release"){ await gm.run("familiarRelease", { summoner : druid.uuid }); return false; }
    if(choice === "back"){ await this.bringBack(druid); return false; }
    return (choice === "new") ? "new" : false;
  }

  /* Store / Summon New / Release (one out), or Bring It Back / Summon New (one stored) */
  static async askExisting(source, { out, stored }){
    const name = out[0]?.name ?? stored?.data?.name ?? "";
    const buttons = out.length
      ? [{ action : "store", label : module.i18n("familiars.store"), icon : "fa-solid fa-box-archive", default : true },
         { action : "new", label : module.i18n("familiars.new"), icon : "fa-solid fa-wand-sparkles" },
         { action : "release", label : module.i18n("familiars.release"), icon : "fa-solid fa-dove" }]
      : [{ action : "back", label : module.i18n("familiars.back"), icon : "fa-solid fa-door-closed", default : true },
         { action : "new", label : module.i18n("familiars.new"), icon : "fa-solid fa-wand-sparkles" }];
    return foundry.applications.api.DialogV2.wait({
      window : { title : source.item?.name ?? source.name, icon : "fa-solid fa-feather" },
      content : `<p>${foundry.utils.escapeHTML(module.format(out.length ? "familiars.outPrompt" : "familiars.storedPrompt", { name }))}</p>`,
      buttons,
      rejectClose : false,
    });
  }

  /* Forget the stored familiar */
  static async forget(summoner){
    if(summoner?.getFlag(module.id, "pocketFamiliar")) await summoner.unsetFlag(module.id, "pocketFamiliar");
  }

  /* GM : store the familiar as it is now (its token : HP, conditions, what was removed) and take it off the map */
  static async storeAsGM({ summoner : uuid } = {}, user){
    const summoner = fromUuidSync(uuid ?? "", { strict : false });
    if(!summoner?.testUserPermission(user, "OWNER")) return false;
    const [token] = this.tokensOf(summoner);
    if(!token) return false;
    const data = token.toObject();
    delete data._id;
    await summoner.setFlag(module.id, "pocketFamiliar", { data });
    await this.remove(this.tokensOf(summoner));
    log.debug("Familiar stored", summoner.name, token.name);
    return true;
  }

  /* GM : let it go : off the map, nothing stored */
  static async releaseAsGM({ summoner : uuid } = {}, user){
    const summoner = fromUuidSync(uuid ?? "", { strict : false });
    if(!summoner?.testUserPermission(user, "OWNER")) return false;
    await this.remove(this.tokensOf(summoner));
    await this.forget(summoner);
    return true;
  }

  /* Bring it back : an empty space within 30 ft of the summoner (or its Wild Shape form) */
  static async bringBack(summoner){
    const pocket = summoner?.getFlag(module.id, "pocketFamiliar");
    if(!pocket) return;
    const from = tokenOf(summoner) ?? canvas.tokens?.placeables.find(t => t.actor?.getFlag("dnd5e", "originalActor") === summoner.id);
    if(!from) return ui.notifications.warn(module.i18n("helpers.pick.noToken"));
    const size = Math.max(1, Math.round(Number(pocket.data?.width) || 1));
    const space = await pickSpace(from, { range : this.RETURN_RANGE, size, notice : pocket.data?.name ?? "" });
    if(!space) return;
    await gm.run("familiarReturn", { summoner : summoner.uuid, x : space.x, y : space.y, scene : from.document.parent.id, elevation : from.document.elevation ?? 0 });
  }

  /* GM : bring it back exactly as it was stored */
  static async returnAsGM({ summoner : uuid, x, y, scene : sceneId, elevation = 0 } = {}, user){
    const summoner = fromUuidSync(uuid ?? "", { strict : false });
    const pocket = summoner?.getFlag(module.id, "pocketFamiliar");
    const scene = game.scenes.get(sceneId);
    if(!pocket || !scene || !summoner.testUserPermission(user, "OWNER")) return false;
    const created = await scene.createEmbeddedDocuments("Token", [{ ...pocket.data, x, y, elevation }]);
    await this.forget(summoner);
    /* Back in the combat, like any summon */
    await initiative.summonsJoinAsGM({ summoner : summoner.uuid, tokens : (created ?? []).map(t => t.uuid) }, user);
    return true;
  }

  /* ---------- Long Rest ---------- */

  /* GM : Wild Companion's familiar disappears when the Druid finishes a Long Rest, in its pocket dimension too */
  static async longRestAsGM({ actor : uuid } = {}, user){
    const actor = fromUuidSync(uuid ?? "", { strict : false });
    if(!actor || !actor.testUserPermission(user, "OWNER")) return false;
    const tokens = this.tokensOf(actor, [this.WILD_COMPANION]);
    const names = tokens.map(t => t.name);
    await this.remove(tokens);
    const pocket = actor.getFlag(module.id, "pocketFamiliar");
    const kept = fromUuidSync(foundry.utils.getProperty(pocket?.data ?? {}, "delta.flags.dnd5e.summon.origin") ?? "", { strict : false });
    if(pocket && (!kept || (idOf(kept) === this.WILD_COMPANION))){
      names.push(module.format("familiars.storedName", { name : pocket.data?.name ?? "" }));
      await this.forget(actor);
    }
    /* Its players hear about it */
    if(names.length){
      await whisperOwners(actor, module.format("familiars.longRest", { names : names.join(", ") }));
      log.debug("Wild Companion dismissed", actor.name, names);
    }
    return true;
  }
}
