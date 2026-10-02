import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { patch } from '../patch.js';
import { TYPES, registerMessages } from './message.js';
import { tokenOf, getRange, getTokensInArea } from '../helpers/tokens.js';
import { pickTargets } from '../helpers/targets.js';
import { pickAttack, attackModeFor } from '../helpers/items.js';
import { masteries } from './masteries.js';
import { maneuvers } from './maneuvers.js';
import { rerolls } from './rerolls.js';
import { conditions } from '../rules/conditions.js';
import { actions } from '../rules/actions.js';
const log = logger.for(import.meta.url);

/**
 * One-click rolling onto a single dnd5e-style card, using dnd5e's own roll math.
 *  attack : attack + damage rolled together
 *  save   : damage rolled up front, save buttons for the targets, damage tray halves for those who saved
 *  heal   : healing rolled up front with its apply tray (same card as save, dnd5e's usage card + the roll)
 */
export class rollItem{

  /**
   * @param {Item5e} item
   * @param {object} [options]
   * @param {string} [options.activity]  id or name of the activity, defaults to the first attack, then save, then heal
   * @param {Event}  [options.event]     triggering event, read for advantage/disadvantage keys
   * @param {number} [options.count]     number of attack rolls, overrides the activity's Attack Count formula
   * @param {string|Function} [options.attackMode]  dnd5e attack mode ("thrown", "twoHanded"...), or (targetToken) => mode
   *                                     per attack. Thrown attacks use up the weapon, like dnd5e's own thrown attacks.
   * @param {boolean|Function} [options.disadvantage]  roll with disadvantage, or (targetToken) => boolean per attack
   *                                     (long range...). Combines with the advantage keys like dnd5e : both = a normal roll.
   * @param {Token[]} [options.targets]  attack these, one attack each in order (the same token twice = two attacks at it),
   *                                     instead of spreading `count` over your targets. `count` defaults to their number.
   * @param {boolean} [options.cleave]   the Cleave mastery's extra attack : its damage leaves out a positive ability modifier
   */
  static async roll(item, { activity, event, count, attackMode, disadvantage, targets, cleave } = {}){
    const target = this.getActivity(item, activity);
    if(!target) return ui.notifications.warn(module.format("rollItem.warn.noAttack", { name : item?.name ?? "" }));

    /* Saves / heals go through dnd5e's use workflow (spell slots, uses, templates, effects), flagged so we take over the card */
    if(target.type !== "attack") return target.use({ event, [module.id] : { mode : target.type } });

    return this.rollActivity(target, { event, count, attackMode, disadvantage, targets, cleave });
  }

  /* A per-attack option for one target : a fixed value, or chosen per target by a function */
  static perTarget(value, target){
    if(typeof value === "function") return value(target) ?? undefined;
    return value ?? undefined;
  }

  /* dnd5e attack roll config for one target : attack mode, disadvantage, and who it's aimed at (Vex) */
  static attackConfig({ attackMode, disadvantage } = {}, target){
    const config = {};
    const uuid = target?.document?.uuid ?? target?.uuid;
    if(uuid) config[module.id] = { target : uuid };
    const mode = this.perTarget(attackMode, target);
    if(mode) config.attackMode = mode;
    const why = this.perTarget(disadvantage, target);
    if(why){
      config.disadvantage = true;
      config[module.id] = { ...(config[module.id] ?? {}), reasons : [{ mode : "disadvantage", reason : this.disadvantageReason(why) }] };
    }
    return config;
  }

  /* A disadvantage handed in : its reason when it says (pickAttack : long range, threatened), else "given" */
  static disadvantageReason(value){
    return (typeof value === "string") ? value : module.i18n("reasons.given");
  }

  /* An attack config's disadvantage : its reason, true when it has none, false when there's no disadvantage */
  static disadvantageOf(config){
    if(!config?.disadvantage) return false;
    return config[module.id]?.reasons?.find(r => r.mode === "disadvantage")?.reason ?? true;
  }

  /**
   * Roll an attack activity directly.
   * @param {Activity} activity   an attack activity, possibly a scaled clone from dnd5e's use workflow
   * @param {object} [options]
   * @param {Event}  [options.event]
   * @param {number} [options.scaling]  upcast levels, stored so rerolls keep them
   * @param {number} [options.count]    number of attack rolls, defaults to the activity's Attack Count formula
   * @param {string|Function} [options.attackMode]    see roll()
   * @param {boolean|Function} [options.disadvantage]  see roll()
   * @param {Token[]} [options.targets]                 see roll()
   * @param {boolean} [options.cleave]                  see roll()
   */
  static async rollActivity(activity, { event, scaling = 0, count, attackMode, disadvantage, targets, cleave } = {}){
    if(!this.ready("attack")) return;

    /* Advantage / disadvantage for the whole card : the keys held, or asked now (targets are already chosen) */
    const mode = await this.chooseMode(activity, event);
    if(!mode) return;

    /* Attack mode from the weapon's data when not given : Versatile (what's in hand), thrown beyond reach */
    attackMode ??= target => attackModeFor(activity.item, target) ?? undefined;

    const rays = this.countFor(activity, count ?? targets?.length);
    if(rays > 1) return this.rollRays(activity, rays, { event, scaling, attackMode, disadvantage, targets, mode });

    const target = targets?.[0] ?? game.user.targets.first() ?? null;
    const config = this.attackConfig({ attackMode, disadvantage }, target);
    const roll = await this.rollAttack(activity, event, config, mode);
    if(!roll) return;
    if(cleave) roll.options[module.id] = { ...(roll.options[module.id] ?? {}), noMod : true };
    const damage = await this.rollDamage(activity, roll);
    /* Graze : its damage for a miss, the card shows it when the attack misses */
    const graze = await masteries.grazeRolls(activity, roll, damage);
    for(const r of graze) r.options[module.id] = { part : "graze" };

    /* On-hit save from the same item (Giant Spider's poison) : its damage is rolled now too, never crits */
    const save = this.findRider(activity);
    const riderDamage = save ? await this.rollDamage(save, null) : [];
    for(const r of riderDamage) r.options[module.id] = { part : "save" };
    const rider = save ? {
      id : save.id,
      ability : save.save.ability.first() ?? "",
      dc : Number.isFinite(save.save.dc.value) ? save.save.dc.value : null,
      onSave : save.damage?.onSave ?? null,
    } : null;

    const why = this.disadvantageOf(config);
    const message = await this.attackCard(activity, [roll, ...damage, ...graze, ...riderDamage], { scaling, rider,
      disadvantage : !!why, disadvantageWhy : (typeof why === "string") ? why : "" });
    log.debug("Rolled", activity.item.name, { roll, damage, rider, riderDamage });

    return { attack : roll, damage, riderDamage, isCritical : roll.isCritical, isFumble : roll.isFumble, message };
  }

  /**
   * A save activity on the same item that only happens as part of another action (activation "special"),
   * which is how dnd5e builds on-hit riders : Giant Spider Bite, Giant Poisonous Snake Bite, Wolf Bite, Ghoul Claws.
   */
  static findRider(activity){
    /* Grapple / Shove (Unarmed Strike, apart or as one "Grapple/Shove") are alternatives to the attack, never riders */
    const saves = activity?.item?.system.activities?.getByType("save")
      .filter(a => (a.id !== activity.id) && !maneuvers.isManeuver(a)) ?? [];
    /* 2014 monsters mark the rider "special", 2024 ones (Ghoul Claw) leave it as an action : the item's one save rides it */
    return saves.find(a => a.activation?.type === "special") ?? ((saves.length === 1) ? saves[0] : null);
  }

  /**
   * An item whose only usable activities are one attack + its save rider(s) (Giant Spider Bite, Ghoul Claw)
   * goes straight to the attack instead of dnd5e's "which activity?" prompt : the rider is on the attack's card anyway.
   * @returns {Activity|null}  the attack to use, or null to let dnd5e prompt as normal
   */
  static fastForward(item, config = {}){
    if(config.chooseActivity) return null;
    if(!settings.value("rollItem") || !settings.value("rollItemDefault")) return null;
    const usable = item?.system?.activities?.filter(a => a.canUse) ?? [];
    const attacks = usable.filter(a => a.type === "attack");
    if(attacks.length !== 1 || usable.length < 2) return null;
    /* Exactly one save, and not Grapple / Shove (Unarmed Strike offers those instead of the attack) */
    const saves = usable.filter(a => a.type === "save");
    if((saves.length !== 1) || maneuvers.isManeuver(saves[0])) return null;
    return usable.every(a => a === attacks[0] || a === saves[0]) ? attacks[0] : null;
  }

  /* ---------- Multiple attack rolls (Scorching Ray, Eldritch Blast...) ---------- */

  static get countFlag(){ return `flags.${module.id}.count`; }

  /**
   * Built-in counts for spells that make several attack rolls, by dnd5e item identifier.
   * @scaling is the cantrip tier (1-4) for cantrips, 1 + upcast levels for leveled spells.
   */
  static DEFAULT_COUNTS = {
    "scorching-ray" : "2 + @scaling",   // 3 rays at 2nd level, +1 per level above
    "eldritch-blast" : "@scaling",      // 1 / 2 / 3 / 4 beams at levels 1 / 5 / 11 / 17
    "magic-missile" : "2 + @scaling",   // 3 darts at 1st level, +1 per level above (damage only, no attack roll)
  };

  /* Attack Count flag on the activity, else the built-in default for the spell */
  static countFormula(activity){
    return foundry.utils.getProperty(activity, this.countFlag) || this.DEFAULT_COUNTS[activity?.item?.identifier] || "";
  }

  /* Evaluated with the activity's roll data, on dnd5e's scaled clone this includes the cast level */
  static countFor(activity, count){
    if(Number.isFinite(count)) return Math.max(1, Math.floor(count));
    const formula = this.countFormula(activity);
    if(!formula) return 1;
    const value = dnd5e.utils.simplifyBonus(formula, activity.getRollData());
    return Math.max(1, Math.floor(value) || 1);
  }

  /* Spread rays over the targets in order (your current targets unless given) : 4 rays, 2 targets -> A A B B.
     Given tokens keep their repeats : [A, A] -> both rays at A */
  static assignTargets(count, tokens){
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    const targets = tokens?.length ? tokens.flatMap(t => TargetsField.getDescriptors([t])) : TargetsField.getDescriptors();
    return Array.from({ length : count }, (_, i) => targets.length ? targets[Math.floor(i * targets.length / count)] : null);
  }

  /* A miss is below the target's AC or a fumble, a crit always hits, no AC known counts as a hit */
  static isHit(roll){
    if(!roll) return false;
    const ac = roll.options.target;
    /* Total cover (the GM's cover chips) : it can't be hit, a natural 20 included */
    if(Number.isFinite(ac) && (ac >= this.TOTAL_COVER_AC)) return false;
    if(roll.isCritical) return true;
    if(roll.isFumble) return false;
    return !Number.isFinite(ac) || roll.total >= ac;
  }

  /* The AC a target behind total cover is given on a card : nothing reaches it */
  static TOTAL_COVER_AC = 999;

  /**
   * One ray : attack against its target's AC plus its damage, rolled either way so the GM can still apply a "miss".
   * Rolls are tagged with the ray index.
   * @param {object} [options]
   * @param {string} [options.attackMode]     dnd5e attack mode for this attack ("thrown" uses up the weapon)
   * @param {boolean} [options.disadvantage]  roll this attack with disadvantage (long range...)
   * @returns {Promise<Roll[]|null>}  null if the attack was cancelled
   */
  static async rollRay(activity, event, index, target, { attackMode, disadvantage, mode } = {}){
    const config = {};
    if(Number.isFinite(target?.ac)) config.target = target.ac;
    if(attackMode) config.attackMode = attackMode;
    if(disadvantage) config.disadvantage = true;
    if(target?.token) config[module.id] = { target : target.token };
    if(disadvantage) config[module.id] = { ...(config[module.id] ?? {}), reasons : [{ mode : "disadvantage", reason : this.disadvantageReason(disadvantage) }] };
    const attack = await this.rollAttack(activity, event, config, mode);
    if(!attack) return null;
    const damage = await this.rollDamage(activity, attack);
    const graze = await masteries.grazeRolls(activity, attack, damage);
    for(const roll of [attack, ...damage]) roll.options[module.id] = { ...(roll.options[module.id] ?? {}), ray : index };
    for(const roll of graze) roll.options[module.id] = { ray : index, part : "graze" };
    return [attack, ...damage, ...graze];
  }

  static async rollRays(activity, count, { event, scaling = 0, attackMode, disadvantage, targets : tokens, mode } = {}){
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    const targets = this.assignTargets(count, tokens);
    const rolls = [], rays = [];
    for(const [index, target] of targets.entries()){
      const config = this.attackConfig({ attackMode, disadvantage }, target ? TargetsField.resolve(target).token : null);
      const why = this.disadvantageOf(config);
      const ray = await this.rollRay(activity, event, index, target, { attackMode : config.attackMode, disadvantage : why, mode });
      if(!ray) return;
      rolls.push(...ray);
      /* Each ray keeps its target, attack mode and disadvantage (and why), so rerolls throw / shoot the same way */
      rays.push({
        target : target?.token ?? "",
        mode : ray[0].options.attackMode ?? config.attackMode ?? "",
        disadvantage : !!why,
        why : (typeof why === "string") ? why : "",
      });
    }
    const message = await this.attackCard(activity, rolls, { scaling, rays });
    log.debug("Rolled rays", activity.item.name, { rolls, rays });

    return { rolls, message };
  }

  /* Activity sheet ⋯ menu : set the Attack Count formula */
  static async editCount(activity){
    const current = foundry.utils.getProperty(activity, this.countFlag) ?? "";
    const value = await foundry.applications.api.DialogV2.prompt({
      window : { title : `${module.i18n("rollItem.count.title")}: ${activity.name}`, icon : "fa-solid fa-layer-group" },
      content : `
        <div class="form-group">
          <label>${module.i18n("rollItem.count.label")}</label>
          <div class="form-fields">
            <input type="text" name="count" value="${Handlebars.escapeExpression(current)}"
              placeholder="${Handlebars.escapeExpression(this.DEFAULT_COUNTS[activity.item?.identifier] ?? "1")}" autofocus>
          </div>
          <p class="hint">${module.i18n("rollItem.count.hint")}</p>
        </div>`,
      ok : { label : "rollItem.count.save", callback : (_event, button) => button.form.elements.count.value.trim() },
      rejectClose : false,
    });
    if(value === null || value === undefined) return;

    if(value){
      try { new Roll(value, activity.getRollData()); }
      catch(err) { return ui.notifications.error(module.format("rollItem.count.invalid", { formula : value })); }
    }
    await activity.update({ [this.countFlag] : value || null });
    ui.notifications.info(module.format("rollItem.count.saved", { name : activity.name, count : this.countFor(activity) }));
  }

  /* Setting on, and the message type registered (subtypes come from module.json, which the server only reads when Foundry starts) */
  static ready(mode, { notify = true } = {}){
    if(!settings.value("rollItem")){
      if(notify) ui.notifications.warn("rollItem.warn.disabled", { localize : true });
      return false;
    }
    if(!game.documentTypes.ChatMessage?.includes(this.typeFor(mode))){
      if(notify) ui.notifications.error("rollItem.error.type", { localize : true });
      return false;
    }
    return true;
  }

  /* Attack cards have their own message type, saves and heals share the usage-card-with-a-roll type */
  static typeFor(mode){
    return mode === "attack" ? TYPES.attack : TYPES.save;
  }

  /* ---------- dnd5e's use workflow, with our card instead of its usage card + prompts ---------- */

  /* Which activity types each "Roll Item for ..." setting covers */
  static DEFAULT_MODES = {
    attack : "rollItemDefault",
    save : "rollItemSaves",
    heal : "rollItemHeals",
    damage : "rollItemDamage",
    utility : "rollItemUtility",
  };

  static modeFor(activity, usage){
    /* Utility activities only have something to roll when they define a formula */
    if(activity?.type === "utility" && !activity.roll?.formula) return null;
    let mode = usage?.[module.id]?.mode;
    const setting = this.DEFAULT_MODES[activity?.type];
    if(!mode && setting && settings.value(setting)) mode = activity.type;
    return mode && this.ready(mode, { notify : !!usage?.[module.id] }) ? mode : null;
  }

  /* Let dnd5e handle dialogs, consumption, concentration and templates, but skip its card and follow-up prompts */
  static onPreUse(activity, usage, _dialog, message){
    const mode = rollItem.modeFor(activity, usage);
    if(!mode) return;
    message.create = false;
    usage.subsequentActions = false;
    usage[module.id] = { ...(usage[module.id] ?? {}), mode };
  }

  /* activity here is dnd5e's scaled clone, so upcast spells roll at the cast level */
  static onPostUse(activity, usage, results){
    /* An area placed by the use : whoever is inside becomes the targets, before any card is made */
    const area = rollItem.targetArea(activity, results);

    switch(usage[module.id]?.mode){
      case "attack" :
        return void rollItem.attackAfterUse(activity, usage, area);
      case "save" :
      case "heal" :
      case "damage" :
      case "utility" : {
        /* The card is made after dnd5e's use returns : its promise goes on the results, for helpers that wait on it */
        const card = rollItem.usageCard(activity, results.message, { area });
        if(results) results[module.id] = { card };
        return;
      }
    }
  }

  /**
   * An attack used through dnd5e (sheet, hotbar...), after its use (so the cast level, and the ray count, are known).
   * With the Pick Targets setting you pick on the map first, the same as pickAndAttack : range shown, thrown beyond reach,
   * disadvantage at long range or for ranged attacks while threatened. Several rays / attacks can pick a target again.
   * Without a token on the scene being viewed there's nothing to pick from, so it rolls against your targets as usual.
   */
  static async attackAfterUse(activity, usage, area = null){
    const event = usage.event;
    const scaling = activity.item.getFlag("dnd5e", "scaling") ?? 0;
    /* An area already chose the targets */
    if(area) return this.rollActivity(activity, { event, scaling, targets : area.length ? area : undefined });
    const pick = settings.value("rollItemPick");
    const attacker = tokenOf(activity.item);
    if((pick === "off") || !canvas.ready || !attacker || (attacker.document.parent !== canvas.scene)){
      return this.rollActivity(activity, { event, scaling });
    }

    const count = this.countFor(activity);
    const picked = await pickAttack(activity.item, { activity, count, repeat : count > 1, clearTargets : pick === "always", used : true });
    if(!picked) return;
    const { targets, attackMode, disadvantage } = picked;
    if(!this.announceTargets(activity, targets)) return;
    /* Fewer picks than rays : the rays are spread over the picks (3 rays, A and B -> A A B) */
    return this.rollActivity(activity, { event, scaling, count : Math.max(count, targets.length), targets, attackMode, disadvantage });
  }

  /* ---------- Picking targets for heals, saves and effects ---------- */

  /* Activity types picked for before their use (attacks pick after, see attackAfterUse) */
  static PICK_TYPES = ["heal", "save", "utility"];

  /**
   * With Pick Targets on, a heal / save / effect activity aimed at creatures (Healing Hands, Grapple, Shove, Mage Armor)
   * has you pick them on the map first, like attacks. Before dnd5e's use, so closing the pick spends nothing, and
   * the card is made for exactly those targets. Same `use` paths as Item Macro's wrappers, so they chain.
   */
  static wrapTargeting(){
    const types = CONFIG.DND5E?.activityTypes;
    if(!types) return;
    const owners = new Set();
    for(const [type, { documentClass }] of Object.entries(types)){
      let proto = documentClass?.prototype;
      while(proto && !Object.hasOwn(proto, "use")) proto = Object.getPrototypeOf(proto);
      if(!proto || owners.has(proto)) continue;
      owners.add(proto);

      patch.wrap(`CONFIG.DND5E.activityTypes.${type}.documentClass.prototype.use`, async function(wrapped, usage = {}, ...rest){
        /* Actions that choose and pick first (Help) : the card then shows who and what */
        const before = await actions.beforeUse(this);
        if(before === false) return;
        if(before){
          const [dialog = {}, message = {}] = rest;
          foundry.utils.mergeObject(message, { data : { flags : { [module.id] : before } } });
          rest = [dialog, message, ...rest.slice(2)];
          usage = { ...usage, [module.id] : { ...(usage?.[module.id] ?? {}), skipPick : true, before } };
        }
        /* One activity for Grapple and Shove : choose first, the card is that one */
        if(maneuvers.enabled() && maneuvers.isCombined(this) && !usage?.[module.id]?.maneuver){
          const choice = await maneuvers.choose(this);
          if(!choice) return;
          const [dialog = {}, message = {}] = rest;
          foundry.utils.setProperty(message, `data.flags.${module.id}.maneuver`, choice);
          rest = [dialog, message, ...rest.slice(2)];
          usage = { ...usage, [module.id] : { ...(usage?.[module.id] ?? {}), maneuver : choice } };
        }
        const spec = rollItem.pickSpec(this, usage);
        if(spec){
          const picks = await pickTargets(this.item, spec);
          if(!picks.length || !rollItem.announceTargets(this, picks)) return;
        }
        return wrapped(usage, ...rest);
      });
    }
  }

  /**
   * Does the activity only ever affect its user ? Target "Self", or "Range : Self" with no area and no other target
   * (Second Wind, Stone's Endurance). Its card is for the caster, never for what happens to be targeted.
   * @param {Activity} activity
   * @returns {boolean}
   */
  static isSelfOnly(activity){
    const target = activity?.target?.override ? activity.target : (activity?.item?.system?.target ?? activity?.target ?? {});
    const type = target.affects?.type || activity?.target?.affects?.type || "";
    if(type) return type === "self";
    if(target.template?.type || activity?.target?.template?.type) return false;
    const range = activity?.range?.override ? activity.range : (activity?.item?.system?.range ?? activity?.range);
    return range?.units === "self";
  }

  /* Does the activity's area come out of its user ("Range : Self" cones and lines : Burning Hands, Lightning Bolt) ? */
  static isFromSelf(activity){
    const range = activity?.range?.override ? activity.range : (activity?.item?.system?.range ?? activity?.range);
    return (range?.units === "self") && ["cone", "line"].includes(activity?.target?.template?.type);
  }

  /**
   * A "Range : Self" cone or line is placed from its caster : while placing, its point stays on the caster's token and
   * the mouse only aims it. dnd5e places templates through core's canvas.regions.placeRegions without an onMove; this
   * gives the next call one, then steps aside.
   */
  static anchorToSelf(activity){
    if(!settings.value("rollItem") || !canvas.ready) return;
    if(!this.isFromSelf(activity)) return this.keepInRange(activity);
    const token = activity.getUsageToken?.()?.object ?? tokenOf(activity.item);
    const layer = canvas.regions;
    if(!token || !layer || layer.placeRegions?.[`${module.id}Anchor`]) return;

    const hadOwn = Object.hasOwn(layer, "placeRegions");
    const original = layer.placeRegions;
    const restore = () => { if(hadOwn) layer.placeRegions = original; else delete layer.placeRegions; };
    const anchored = function(data, options = {}){
      restore();
      const onMove = args => {
        const { shape, position } = args;
        const center = token.center;
        const rotation = Math.toDegrees(Math.atan2(position.y - center.y, position.x - center.x));
        shape.updateSource({ x : center.x, y : center.y, rotation });
        options.onMove?.(args);
        return false;
      };
      return original.call(this, data, { ...options, onMove });
    };
    anchored[`${module.id}Anchor`] = true;
    layer.placeRegions = anchored;
  }

  /**
   * A template with a range (Fireball 150 ft) : while placing, its centre stays within that range of the caster (from
   * the edge of its space), with a clear path to it : it stops at the first wall in the way (walls that block movement,
   * so a window stops it, an open door doesn't). Somewhere it can't see is fine.
   */
  static keepInRange(activity){
    const feet = this.activityRange(activity);
    const token = activity.getUsageToken?.()?.object ?? tokenOf(activity.item);
    const layer = canvas.regions;
    if(!(feet > 0) || !Number.isFinite(feet) || !token || !layer || layer.placeRegions?.[`${module.id}Anchor`]) return;

    const hadOwn = Object.hasOwn(layer, "placeRegions");
    const original = layer.placeRegions;
    const restore = () => { if(hadOwn) layer.placeRegions = original; else delete layer.placeRegions; };
    const limit = (feet / canvas.scene.grid.distance) * canvas.grid.size + (Math.max(token.w, token.h) / 2);
    const ranged = function(data, options = {}){
      restore();
      const onMove = args => {
        const { shape, position } = args;
        const center = token.center;
        const dx = position.x - center.x, dy = position.y - center.y;
        const gap = Math.hypot(dx, dy);
        let point = (gap <= limit) ? { x : position.x, y : position.y } : { x : center.x + (dx * limit / gap), y : center.y + (dy * limit / gap) };
        /* A clear path : the first wall in the way, a step back towards the caster */
        const wall = rollItem.firstWall(center, point);
        if(wall){
          const back = Math.hypot(wall.x - center.x, wall.y - center.y);
          const step = Math.max(0, back - 2) / (back || 1);
          point = { x : center.x + ((wall.x - center.x) * step), y : center.y + ((wall.y - center.y) * step) };
        }
        if(!wall && (gap <= limit)) return options.onMove?.(args);
        shape.updateSource(point);
        options.onMove?.(args);
        return false;
      };
      return original.call(this, data, { ...options, onMove });
    };
    ranged[`${module.id}Anchor`] = true;
    layer.placeRegions = ranged;
  }

  /**
   * After dnd5e places an activity's template(s) : target the tokens inside, so the card, its save buttons and its
   * trays are for exactly them. The caster counts too, except for their own cone or line (its point isn't in its area).
   * With the Template Targeting setting.
   * @returns {Token[]|null}  the tokens inside, null when nothing was placed (or the setting is off)
   */
  static targetArea(activity, results){
    const templates = results?.templates ?? [];
    if(!templates.length || !settings.value("rollItem") || !settings.value("rollItemTemplateTargets") || !canvas.ready) return null;
    const caster = this.isFromSelf(activity) ? tokenOf(activity.item) : null;
    const inside = [...new Set(templates.flatMap(t => getTokensInArea(t)))].filter(t => t !== caster);
    this.announceTargets(activity, inside, { keepEmpty : true });
    log.debug("Area targets", activity.item?.name, inside.map(t => t.name));
    return inside;
  }

  /**
   * Stage hook "macro-helper.targets" (activity, tokens) : a macro can drop targets from the list (splice it), e.g.
   * Luring Song keeping only Humanoids and Giants. Whatever is left becomes your targets.
   * @param {Activity} activity
   * @param {Token[]} tokens           changed in place
   * @param {object} [options]
   * @param {boolean} [options.keepEmpty=false]  an area can end up with nobody in it and still go ahead
   * @returns {boolean}  false when no target is left (and the use should stop)
   */
  static announceTargets(activity, tokens, { keepEmpty = false } = {}){
    Hooks.callAll(`${module.id}.targets`, activity, tokens);
    if(canvas.ready) canvas.tokens.setTargets(tokens.map(t => t.id));
    if(tokens.length || keepEmpty) return true;
    ui.notifications.info(module.i18n("rollItem.noTargetsLeft"));
    return false;
  }

  /* The first wall that blocks movement between two points, or null */
  static firstWall(from, to){
    try {
      return CONFIG.Canvas.polygonBackends.move.testCollision(from, to, { type : "move", mode : "closest" }) ?? null;
    } catch(error){
      log.debug("Wall test", error);
      return null;
    }
  }

  /* An activity's reach in feet : its own range, else the item's, Touch = 5 ft */
  static activityRange(activity){
    const feet = getRange(activity);
    if(feet > 0) return feet;
    const range = activity.range ?? {};
    if(range.units === "touch") return canvas.scene?.grid.distance ?? 5;
    if(range.units === "any") return Infinity;
    return Number(range.value) || 0;
  }

  /**
   * How to pick for an activity, or null when it doesn't need it : not a heal / save / effect, aimed at yourself,
   * an area (its template does it), no range, or the setting is off.
   *   who : "willing" / "ally" -> your allies and yourself, "enemy" or a save -> enemies, else anyone (yourself too)
   *   how many : the target count (fewer is fine, Enter)
   */
  static pickSpec(activity, usage = {}, { types = this.PICK_TYPES } = {}){
    const pick = settings.value("rollItemPick");
    if((pick === "off") || !settings.value("rollItem") || !types.includes(activity?.type)) return null;
    if(usage?.[module.id]?.skipPick || !canvas.ready) return null;
    const caster = tokenOf(activity.item);
    if(!caster || (caster.document.parent !== canvas.scene)) return null;

    /* Effects only : a utility without effects to apply (Arcane Recovery...) has no one to aim at */
    if((activity.type === "utility") && !(activity.applicableEffects?.length)) return null;

    const target = activity.target?.override ? activity.target : (activity.item.system.target ?? activity.target ?? {});
    if(target.template?.type || activity.target?.template?.type) return null;
    const type = target.affects?.type || activity.target?.affects?.type || "";
    if(["self", "space", "object"].includes(type)) return null;

    const range = this.activityRange(activity);
    if(!(range > 0)) return null;

    const disposition = ["ally", "willing"].includes(type) ? "ally"
      : ((type === "enemy") || ["save", "damage"].includes(activity.type)) ? "nonAlly" : "any";
    return {
      count : Math.max(1, parseInt(target.affects?.count) || 1),
      range, disposition,
      includeSelf : disposition === "ally" || disposition === "any",
      useTargets : pick !== "always",
      confirm : "auto",
    };
  }

  /* ---------- Rolling ---------- */

  /* dnd5e attack roll, no dialog, no message */
  /* dnd5e attack roll, no dialog, no message. `mode` is the card's chosen advantage / disadvantage (chooseMode) :
     dnd5e combines it with everything else (long range, Poisoned, Vex...), advantage and disadvantage cancel out */
  static async rollAttack(activity, event, config = {}, mode = {}){
    const rollConfig = { ...config, event : this.keyEvent(event) };
    const reasons = [...(config[module.id]?.reasons ?? [])];
    if(mode?.advantage){ rollConfig.advantage = true; reasons.push({ mode : "advantage", reason : module.i18n("reasons.chosen") }); }
    if(mode?.disadvantage){ rollConfig.disadvantage = true; reasons.push({ mode : "disadvantage", reason : module.i18n("reasons.chosen") }); }
    const keys = rollConfig.event && dnd5e.utils?.areKeysPressed;
    if(keys && keys(rollConfig.event, "skipDialogAdvantage")) reasons.push({ mode : "advantage", reason : module.i18n("reasons.keys") });
    if(keys && keys(rollConfig.event, "skipDialogDisadvantage")) reasons.push({ mode : "disadvantage", reason : module.i18n("reasons.keys") });
    if(reasons.length) rollConfig[module.id] = { ...(rollConfig[module.id] ?? {}), reasons };

    /* Stage hook : change the roll before it happens (rollConfig.advantage / disadvantage, rollConfig.rolls...),
       or return false to stop it. config[module.id].target is the token uuid it's aimed at. */
    if(Hooks.call(`${module.id}.preAttack`, activity, rollConfig) === false) return null;
    const [roll] = await activity.rollAttack(rollConfig, { configure : false }, { create : false }) ?? [];
    if(!roll) return null;
    /* Who it was aimed at, kept on the roll (auto-crits, rerolls) */
    const target = rollConfig[module.id]?.target;
    if(target) roll.options[module.id] = { ...(roll.options[module.id] ?? {}), target };
    Hooks.callAll(`${module.id}.attack`, activity, roll);
    return roll;
  }

  /**
   * The Advantage setting :
   *   keys   : dnd5e's advantage / disadvantage keys held while rolling (Configure Controls, default Alt / Ctrl)
   *   prompt : ask Advantage / Normal / Disadvantage before rolling (after targets are picked)
   *   none   : neither, only what the rules give (long range, conditions, Vex...)
   * @returns {Promise<{ advantage? : boolean, disadvantage? : boolean }|null>}  null if the prompt was closed
   */
  static async chooseMode(activity, event){
    if(settings.value("rollItemAdvantage") !== "prompt") return {};
    const choice = await foundry.applications.api.DialogV2.wait({
      window : { title : activity?.item?.name ?? module.i18n("rollItem.mode.title"), icon : "fa-solid fa-dice-d20" },
      content : `<p>${module.i18n("rollItem.mode.hint")}</p>`,
      buttons : [
        { action : "advantage", label : "DND5E.Advantage", icon : "fa-solid fa-angles-up" },
        { action : "normal", label : "DND5E.Normal", icon : "fa-solid fa-dice-d20", default : true },
        { action : "disadvantage", label : "DND5E.Disadvantage", icon : "fa-solid fa-angles-down" },
      ],
      position : { width : 400 },
      rejectClose : false,
    });
    if(!choice) return null;
    return { advantage : choice === "advantage", disadvantage : choice === "disadvantage" };
  }

  /* A utility activity's own roll formula (dnd5e's "Roll" button), no dialog, no message */
  static async rollFormula(activity){
    if(!activity?.roll?.formula) return [];
    return await activity.rollFormula({}, { configure : false }, { create : false }) ?? [];
  }

  /* Heal activities keep their formula in `healing`, everything else in `damage.parts` */
  static hasDamage(activity){
    return activity?.type === "heal" ? !!activity.healing?.formula : !!activity?.damage?.parts?.length;
  }

  /* dnd5e damage (or healing) roll, no dialog, no message. Same hand-off dnd5e does from its attack card to its damage roll */
  static async rollDamage(activity, attack){
    if(!this.hasDamage(activity)) return [];
    const { ability, ammunition, attackMode } = attack?.options ?? {};
    const config = {
      ability, attackMode,
      ammunition : activity.actor?.items.get(ammunition),
      /* A crit, or a hit on a Paralyzed / Unconscious target from within 5 ft (conditions.autoCrit) */
      isCritical : !!(attack?.isCritical || conditions.autoCrit(activity, attack)),
      /* Cleave's extra attack : masteries.onPreRollDamage takes a positive ability modifier off */
      ...(attack?.options?.[module.id]?.noMod ? { [module.id] : { noMod : true } } : {}),
    };

    /* Stage hook : change the damage before it's rolled (config.rolls, config.isCritical...), or return false to skip it */
    if(Hooks.call(`${module.id}.preDamage`, activity, config, attack) === false) return [];
    const rolls = await activity.rollDamage(config, { configure : false }, { create : false }) ?? [];
    Hooks.callAll(`${module.id}.damage`, activity, rolls, attack);
    return rolls;
  }

  /**
   * Play Dice So Nice for rolls that are not being added to a new message (DSN animates those itself),
   * resolves once the dice have landed. Visibility follows the message's roll mode.
   */
  static async showDice(rolls, message){
    if(!game.dice3d){
      foundry.audio.AudioHelper.play({ src : CONFIG.sounds.dice }, true);
      return;
    }
    const whisper = message.whisper.length ? message.whisper : null;
    await Promise.all(rolls.map(roll => game.dice3d.showForRoll(roll, game.user, true, whisper, message.blind, message.id, message.speaker)));
  }

  static getActivity(item, id){
    const activities = item?.system?.activities;
    if(!activities) return null;
    const usable = ["attack", "save", "damage", "heal", "utility"].flatMap(type => activities.getByType(type))
      .filter(a => (a.type !== "utility") || a.roll?.formula);
    if(!id) return usable[0] ?? null;
    return usable.find(a => a.id === id || a.name === id) ?? null;
  }

  /**
   * dnd5e reads advantage/disadvantage from an event using its keybindings (Configure Controls).
   * Macros may not have an event, so fall back to what is held down right now.
   */
  static keyEvent(event){
    if(settings.value("rollItemAdvantage") !== "keys") return undefined;
    if(event) return event;

    const kb = game.keyboard;
    return {
      altKey : kb.isModifierActive("ALT"),
      ctrlKey : kb.isModifierActive("CONTROL"),
      shiftKey : kb.isModifierActive("SHIFT"),
      metaKey : false,
      target : document.body,
    };
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    registerMessages();
    masteries.register();
    maneuvers.register();
    rerolls.register();
    Hooks.on("dnd5e.preUseActivity", rollItem.onPreUse);
    Hooks.on("dnd5e.postUseActivity", rollItem.onPostUse);

    rollItem.wrapTargeting();
    Hooks.on("dnd5e.preCreateMeasuredTemplate", activity => rollItem.anchorToSelf(activity));

    /* Attack + save rider items skip dnd5e's activity choice (sheet, hotbar, anything calling item.use) */
    patch.wrap("CONFIG.Item.documentClass.prototype.use", async function(wrapped, config = {}, dialog = {}, message = {}){
      const attack = rollItem.fastForward(this, config);
      if(!attack) return wrapped(config, dialog, message);
      const { chooseActivity, ...usage } = config;
      return attack.use(usage, dialog, message);
    });

    Hooks.on("getHeaderControlsActivitySheet", (app, controls)=> {
      if(!["attack", "damage"].includes(app.document?.type)) return;
      controls.push({
        icon : "fa-solid fa-layer-group",
        label : "rollItem.count.control",
        visible : ()=> app.isEditable,
        onClick : ()=> rollItem.editCount(app.document),
      });
    });
  }

  /* ---------- Cards ---------- */

  /**
   * Attack : one message of our attack type, the rolls are attached so dnd5e renders them.
   * @param {Roll[]} rolls  attack roll(s) + damage rolls, multi-ray rolls tagged with options[module.id].ray
   * @param {object[]} [rays]  one { target : tokenUuid } per ray when rolling more than one attack
   */
  static async attackCard(activity, rolls, { scaling = 0, rays = [], rider = null, disadvantage = false, disadvantageWhy = "" } = {}){
    const attack = rolls.find(r => r instanceof CONFIG.Dice.D20Roll);
    const { ability, ammunition, attackMode, mastery } = attack?.options ?? {};
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;

    const messageData = {
      type : TYPES.attack,
      speaker : ChatMessage.implementation.getSpeaker({ actor : activity.actor }),
      rolls,
      system : {
        ...activity.messageSources,
        targets : TargetsField.getDescriptors(),
        ability, ammunition, mastery, scaling, rays, rider, disadvantage, disadvantageWhy,
        mode : attackMode,
      },
    };
    ChatMessage.implementation.applyMode(messageData, CONFIG.Dice.BasicRoll.getMessageMode());

    /* Damage after the attack : everything is already rolled, this only staggers what is shown, so a natural 20
       isn't given away by crit damage dice rolling alongside it. The card goes out with every roll but shows
       "Rolling..." (flags.reveal 0), the attack dice play and the attack shows (1), then the damage dice and the
       damage (2). Dice So Nice's own animation of the card is skipped : the dice are played here, in order. */
    const { DamageRoll } = CONFIG.Dice;
    const attacks = rolls.filter(r => !(r instanceof DamageRoll));
    const damage = rolls.filter(r => r instanceof DamageRoll);
    const staged = settings.value("rollItemStaged") && attacks.length && damage.length;
    if(!staged) return await ChatMessage.implementation.create(messageData);

    messageData.flags = { [module.id] : { reveal : 0 } };
    if(game.dice3d) messageData.flags["dice-so-nice"] = { skip : true };
    const message = await ChatMessage.implementation.create(messageData);
    if(!message) return message;

    try {
      await this.showDice(attacks, message);
      await message.setFlag(module.id, "reveal", 1);
      await this.showDice(damage, message);
    }
    finally {
      await message.setFlag(module.id, "reveal", 2);
    }
    return message;
  }

  /* How much of a staged attack card can be shown : 0 nothing yet, 1 the attack, 2 everything.
     A card left half revealed (its roller disconnected) shows everything after 30 seconds. */
  static revealOf(message){
    const reveal = message?.getFlag(module.id, "reveal");
    if(!Number.isInteger(reveal) || (reveal >= 2)) return 2;
    if((Date.now() - (message.timestamp ?? 0)) > 30000) return 2;
    return reveal;
  }

  /**
   * Save / heal : dnd5e already built its usage card data (buttons, targets, effects, scaling, roll mode) but did not create it.
   * Roll the damage (or healing) onto it, swap its "roll damage/healing" button for a reroll, and create it as our type.
   */
  static async usageCard(activity, data, { area = null } = {}){
    if(!data?.system) return;
    const isHeal = activity.type === "heal";
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;

    /* Damage-only activities can roll several instances (Magic Missile darts), spread over the targets like rays */
    const count = activity.type === "damage" ? this.countFor(activity) : 1;

    /* Who it's for : an area's occupants, else (damage-only) picked now that the cast level, and so the count, is known */
    let picks = area;
    if(!picks && (activity.type === "damage")){
      const spec = this.pickSpec(activity, {}, { types : ["damage"] });
      if(spec){
        picks = await pickTargets(activity.item, { ...spec, count, repeat : count > 1 });
        if(!picks.length || !this.announceTargets(activity, picks)) return null;
      }
    }
    /* Self only : the caster, not whoever is still targeted from an earlier attack */
    if(!picks && this.isSelfOnly(activity)){
      const caster = tokenOf(activity.item);
      picks = (caster && (caster.document.parent === canvas.scene)) ? [caster] : [];
      if(canvas.ready) canvas.tokens.setTargets([]);
    }
    if(picks) data.system.targets = TargetsField.getDescriptors([...new Set(picks)]);
    data.system.targets ??= TargetsField.getDescriptors();

    const damage = [];
    if(count > 1){
      const targets = this.assignTargets(count, picks ?? undefined);
      for(const i of targets.keys()){
        const rolls = await this.rollDamage(activity, null);
        for(const roll of rolls) roll.options[module.id] = { ray : i };
        damage.push(...rolls);
      }
      data.system.rays = targets.map(t => ({ target : t?.token ?? "" }));
    }
    else damage.push(...await this.rollDamage(activity, null));

    /* Utility : its roll formula (dnd5e's "Roll" button) */
    const formula = await this.rollFormula(activity);
    for(const roll of formula) roll.options[module.id] = { part : "formula" };

    data.type = TYPES.save;
    data.rolls = [...(data.rolls ?? []), ...damage, ...formula];
    data.system.onSave = activity.damage?.onSave ?? null;
    data.system.buttons = (data.system.buttons ?? []).filter(b => !["rollDamage", "rollHealing", "rollFormula"].includes(b.action));
    if(formula.length) data.system.buttons.push({
      action : "rerollFormula",
      icon : "fa-solid fa-dice",
      label : { value : "rollItem.reroll.formula" },
    });
    if(damage.length) data.system.buttons.push({
      action : "rerollDamage",
      icon : isHeal ? "systems/dnd5e/icons/svg/damage/healing.svg" : "fa-solid fa-burst",
      label : { value : isHeal ? "rollItem.reroll.healing" : "rollItem.reroll.damage" },
    });
    if(count > 1 && damage.length) data.system.buttons.push({
      action : "applyRays",
      icon : "fa-solid fa-heart-crack",
      label : { value : "rollItem.apply.all" },
    });

    log.debug("Usage card", activity.item.name, { data, damage });
    return await ChatMessage.implementation.create(data);
  }
}
