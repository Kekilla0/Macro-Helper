import { rollOptionFilter, rollOptions } from './roll-options.js';
import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { patch } from '../patch.js';
import { TYPES, registerMessages } from './message.js';
import { tokenOf, getRange, getTokensInArea } from '../helpers/tokens.js';
import { pickTargets } from '../helpers/targets.js';
import { pickAttack, attackModeFor } from '../helpers/items.js';
import { rerolls } from './rerolls.js';
import { chooseOption, wait, makeButton, originItem, plainText } from '../helpers/utils.js';
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
   * @param {object}  [options.tags]    marks a rule puts on the attack ({ noMod : true } : Cleave's extra attack), kept on
   *                                     rerolls and handed to its damage roll (config["macro-helper"].tags)
   */
  static async roll(item, { activity, event, count, attackMode, disadvantage, targets, tags } = {}){
    const target = this.getActivity(item, activity);
    if(!target) return ui.notifications.warn(module.format("rollItem.warn.noAttack", { name : item?.name ?? "" }));

    /* Saves / heals go through dnd5e's use workflow (spell slots, uses, templates, effects), flagged so we take over the card */
    if(target.type !== "attack") return target.use({ event, [module.id] : { mode : target.type } });

    return this.rollActivity(target, { event, count, attackMode, disadvantage, targets, tags });
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
   * @param {object}  [options.tags]                    see roll()
   */
  static async rollActivity(activity, { event, scaling = 0, count, attackMode, disadvantage, targets, tags, note, cardFlags } = {}){
    if(!this.ready("attack")) return;

    /* Advantage / disadvantage for the whole card : the keys held, or asked now (targets are already chosen) */
    const mode = await this.chooseMode(activity, event);
    if(!mode) return this.cancelUse(activity);
    /* A damage type to choose (necrotic or radiant) : asked before anything is rolled */
    if(!await this.chooseDamageTypes(activity)) return this.cancelUse(activity);

    /* Attack mode from the weapon's data when not given : Versatile (what's in hand), thrown beyond reach */
    attackMode ??= target => attackModeFor(activity.item, target) ?? undefined;

    const rays = this.countFor(activity, count ?? targets?.length);
    if(rays > 1) return this.rollRays(activity, rays, { event, scaling, attackMode, disadvantage, targets, mode, note, cardFlags });

    const target = targets?.[0] ?? game.user.targets.first() ?? null;
    const config = this.attackConfig({ attackMode, disadvantage }, target);
    const why = this.disadvantageOf(config);
    const roll = await this.attackStep(activity, event, { target, attackMode : config.attackMode, disadvantage : why, mode, tags });
    if(!roll) return;
    const { damage, added, extras, riderDamage, rider } = await this.hitStep(activity, roll, { target, extras : true, rider : true });

    const message = await this.attackCard(activity, [roll, ...damage, ...added, ...extras, ...riderDamage], { scaling, rider, note, cardFlags,
      disadvantage : !!why, disadvantageWhy : (typeof why === "string") ? why : "" });
    log.debug("Rolled", activity.item.name, { roll, damage, rider, riderDamage });

    return { attack : roll, damage, riderDamage, isCritical : roll.isCritical, isFumble : roll.isFumble, message };
  }

  /**
   * The attack lego : one attack roll at one target, nothing else (no damage, no card). Every attack Roll Item makes
   * goes through it : a single attack, each ray of a multi-attack, and the card's Reroll Attack.
   * @param {Activity} activity
   * @param {Event} [event]
   * @param {object} [options]
   * @param {Token|object|string|null} [options.target]  a token, a card's target descriptor ({ token, ac } : judged
   *                                     against that AC) or a token uuid
   * @param {string} [options.attackMode]                dnd5e attack mode ("thrown"...)
   * @param {boolean|string} [options.disadvantage]      with disadvantage, a string says why (long range)
   * @param {string} [options.ability]                   the ability it's made with (a reroll keeps the first's)
   * @param {object} [options.mode]                      the card's chosen advantage / disadvantage (chooseMode)
   * @param {object} [options.tags]                      rules' marks on the attack (Cleave's extra attack), kept on rerolls
   * @param {number} [options.ray]                       its index on a multi-attack card
   * @returns {Promise<D20Roll|null>}  null if it was stopped
   */
  static async attackStep(activity, event, { target = null, attackMode, disadvantage, ability, mode = {}, tags, ray } = {}){
    const config = {};
    const uuid = (typeof target === "string") ? target : (target?.document?.uuid ?? target?.token ?? target?.uuid ?? null);
    if(Number.isFinite(target?.ac)) config.target = target.ac;
    if(ability) config.ability = ability;
    if(attackMode) config.attackMode = attackMode;
    if(uuid) config[module.id] = { target : uuid };
    if(disadvantage){
      config.disadvantage = true;
      config[module.id] = { ...(config[module.id] ?? {}), reasons : [{ mode : "disadvantage", reason : this.disadvantageReason(disadvantage) }] };
    }
    const roll = await this.rollAttack(activity, event, config, mode);
    if(!roll) return null;
    if(tags) roll.options[module.id] = { ...(roll.options[module.id] ?? {}), tags };
    if(Number.isInteger(ray)) roll.options[module.id] = { ...(roll.options[module.id] ?? {}), ray };
    return roll;
  }

  /**
   * The hit lego : everything an attack brings with its result (its damage, rules' added rolls such as Graze's for a
   * miss, the item's other damage, its on-hit save and that save's damage), all rolled now. The card shows each part
   * only once the attack's result calls for it, and plays its dice then (playOutcomes).
   * @param {Activity} activity
   * @param {D20Roll} attack
   * @param {object} [options]
   * @param {Token|null} [options.target]  who it's aimed at (for the on-hit save's own creatures : macro-helper.riderTargets)
   * @param {number} [options.ray]          its index on a multi-attack card
   * @param {boolean} [options.extras]      the item's other damage activities too
   * @param {boolean} [options.rider]       the item's on-hit save too
   * @returns {Promise<{ damage : DamageRoll[], added : DamageRoll[], extras : DamageRoll[], riderDamage : DamageRoll[], rider : object|null }>}
   */
  static async hitStep(activity, attack, { target = null, ray, extras : withExtras = false, rider : withRider = false } = {}){
    const damage = await this.rollDamage(activity, attack);
    /* Rolls rules add to the attack (Graze's damage for a miss) */
    const added = await this.addedRolls(activity, attack, damage, ray);
    if(Number.isInteger(ray)) for(const roll of damage) roll.options[module.id] = { ...(roll.options[module.id] ?? {}), ray };

    /* Extra damage from the same item (a monster's charge, a second damage activity) : boxes of its own, each with
       its APPLY once the attack hits (crits like the attack) */
    const extras = withExtras ? await this.extraDamage(activity, attack) : [];

    /* On-hit save from the same item (Giant Spider's poison) : the save lego, its damage rolled now too */
    const save = withRider ? this.findRider(activity) : null;
    const { damage : riderDamage, save : rider } = save ? await this.saveStep(save, { tag : { part : "save" } }) : { damage : [], save : null };
    /* Rules can give the save its own creatures (Ice Knife : everyone within 5 ft of the target) : macro-helper.riderTargets */
    if(rider){
      const around = [];
      Hooks.callAll(`${module.id}.riderTargets`, save, target, around);
      if(around.length) rider.targets = around;
    }
    return { damage, added, extras, riderDamage, rider };
  }

  /**
   * The save lego : what a save activity brings, rolled now : its damage (never crits), spread over the targets like
   * rays when it rolls several instances (Magic Missile's darts), and the save itself (its ability, DC, what a success
   * does). A save card rolls it (usageCard, which rolls heals and damage-only activities the same way), and so does an
   * attack's on-hit save (hitStep).
   * @param {Activity} activity
   * @param {object} [options]
   * @param {number}  [options.count]    instances of its damage (1)
   * @param {Token[]} [options.targets]  who the instances go to, in order (default : your targets)
   * @param {object}  [options.tag]      marks for each damage roll (the on-hit save's { part : "save" })
   * @returns {Promise<{ damage : DamageRoll[], rays : object[], save : { id, ability, dc, onSave }|null }>}
   */
  static async saveStep(activity, { count = 1, targets, tag } = {}){
    const damage = [];
    let rays = [];
    if(count > 1){
      const spread = this.assignTargets(count, targets);
      for(const i of spread.keys()){
        for(const roll of await this.rollDamage(activity, null)){
          roll.options[module.id] = { ...tag, ray : i };
          damage.push(roll);
        }
      }
      rays = spread.map(t => ({ target : t?.token ?? "" }));
    }
    else for(const roll of await this.rollDamage(activity, null)){
      if(tag) roll.options[module.id] = { ...tag };
      damage.push(roll);
    }
    const save = activity?.save ? {
      id : activity.id,
      ability : activity.save.ability?.first() ?? "",
      dc : Number.isFinite(activity.save.dc?.value) ? activity.save.dc.value : null,
      onSave : activity.damage?.onSave ?? null,
    } : null;
    return { damage, rays, save };
  }

  /**
   * Which result a card's roll waits for : "hit" (its damage, extra damage, an on-hit save's damage), "miss" (Graze's),
   * or null : shown either way (the attack itself; a save for creatures of its own, Ice Knife's).
   * @param {Roll} roll
   * @param {object} [card]  the card's rider ({ rider })
   */
  static outcomeOf(roll, { rider = null } = {}){
    if(!(roll instanceof CONFIG.Dice.DamageRoll)) return null;
    const tag = roll.options?.[module.id] ?? {};
    if(tag.onMiss) return "miss";
    if(tag.part === "save") return rider?.targets?.length ? null : "hit";
    if((tag.part === "extra") && !tag.onHit && !tag.alternative) return null;
    return "hit";
  }

  /* Where a card keeps whether a result's dice have played : "single.hit", "2.miss" */
  static outcomeKey(roll, { rider = null, rays = [] } = {}){
    const outcome = this.outcomeOf(roll, { rider });
    if(!outcome) return null;
    const ray = roll.options?.[module.id]?.ray;
    return `${((rays?.length > 1) && Number.isInteger(ray)) ? ray : "single"}.${outcome}`;
  }

  /* One playOutcomes at a time per card */
  static #playing = new Map();

  /**
   * Dice So Nice : the dice of what an attack card's results now call for and haven't played yet (a miss turned into a
   * hit plays its damage), then shown on the card. Played once, by the roller (the GM when the roller is away).
   * @param {ChatMessage} message
   */
  static playOutcomes(message){
    const id = message?.id;
    if(!id) return Promise.resolve();
    const next = (this.#playing.get(id) ?? Promise.resolve()).then(() => this.#playOutcomes(game.messages.get(id))).catch(error => log.error("Outcome dice", error));
    this.#playing.set(id, next);
    next.finally(() => { if(this.#playing.get(id) === next) this.#playing.delete(id); });
    return next;
  }

  static async #playOutcomes(message){
    const card = message?.system;
    const flags = message?.getFlag(module.id, "dice");
    if(!card?.resultsOf || !flags || !message.isOwner) return;
    const rolls = [], update = {};
    for(const [key, outcomes] of Object.entries(flags)){
      const ray = (key === "single") ? null : Number(key);
      const results = card.resultsOf(ray);
      for(const [outcome, played] of Object.entries(outcomes ?? {})){
        if((played !== false) || !results[outcome]) continue;
        rolls.push(...card.outcomeRolls(ray, outcome));
        update[`flags.${module.id}.dice.${key}.${outcome}`] = true;
      }
    }
    if(foundry.utils.isEmpty(update)) return;
    await Promise.race([this.showDice(rolls, message), wait(8000)]);
    await message.update(update);
  }

  /* Whose client plays a card's outcome dice : the roller's, else the GM's, else whoever changed it */
  static playsOutcomes(message, userId){
    const roller = message.author;
    if(roller?.active) return roller.isSelf;
    const gm = game.users.activeGM;
    if(gm) return gm.isSelf;
    return userId === game.user.id;
  }

  /* A card's results changed (a reroll, Bardic Inspiration, cover, the GM's Count as hit) : the dice they now call for */
  static onCardUpdate(message, changes, options, userId){
    if(message.type !== TYPES.attack) return;
    if(!Object.values(message.getFlag(module.id, "dice") ?? {}).some(o => Object.values(o ?? {}).includes(false))) return;
    if((this.revealOf(message) < 2) || !this.playsOutcomes(message, userId)) return;
    this.playOutcomes(message);
  }

  static #addRolls = [];

  /**
   * A rule adding rolls to every attack Roll Item makes (Graze's damage for a miss), rolled with it and again when the
   * attack is rerolled. Each roll keeps the tag the rule gives it in options["macro-helper"] : { part, label, onMiss }
   * (part : any name but "base", "extra" and "save"; onMiss : applied by Apply Hits on a miss). The card shows them
   * where the rule's card section puts them (macro-helper.cardSections).
   * @param {Function} fn  async (activity, attack, damage) => Roll[]
   */
  static addRolls(fn){
    this.#addRolls.push(fn);
  }

  /* The rolls rules add to this attack, tagged (and with the ray's index on a multi-attack card) */
  static async addedRolls(activity, attack, damage, ray){
    const rolls = [];
    for(const fn of this.#addRolls){
      try {
        for(const roll of (await fn(activity, attack, damage)) ?? []){
          const tag = roll.options[module.id] ?? {};
          roll.options[module.id] = { ...tag, part : tag.part ?? "added", added : true, ...(Number.isInteger(ray) ? { ray } : {}) };
          rolls.push(roll);
        }
      } catch(error){ log.error("Added rolls", error); }
    }
    return rolls;
  }

  /* Is this save a rider on the item's attack : rules say no for alternatives to it (Grapple, Shove) */
  static isRider(activity){
    return Hooks.call(`${module.id}.isRider`, activity) !== false;
  }

  /* The item's other damage activities, rolled for this attack (tagged as extras that only apply on a hit) */
  static async extraDamage(activity, attack){
    /* A card macro that named the activity (item.roll({ activity })) : only that one, the macro adds the rest */
    if(rollOptions.of(activity)?.only) return [];
    /* Rules can say a damage activity isn't rolled with the attack (macro-helper.isExtra : Witch Bolt's later turns) */
    const others = activity?.item?.system?.activities?.filter(a => (a.type === "damage") && (a.id !== activity.id) && (a.canUse !== false)
      && (Hooks.call(`${module.id}.isExtra`, a) !== false)) ?? [];
    const rolls = [];
    for(const extra of others){
      for(const roll of await this.rollDamage(extra, attack)){
        roll.options[module.id] = { part : "extra", key : `extra-${extra.id}`, label : extra.name || extra.item.name, onHit : true };
        rolls.push(roll);
      }
    }
    return rolls;
  }

  /**
   * A save activity on the same item that only happens as part of another action (activation "special"),
   * which is how dnd5e builds on-hit riders : Giant Spider Bite, Giant Poisonous Snake Bite, Wolf Bite, Ghoul Claws.
   */
  static findRider(activity){
    /* Rules can say a save is no rider (macro-helper.isRider : Grapple and Shove are alternatives to the attack) */
    const saves = activity?.item?.system.activities?.getByType("save")
      .filter(a => (a.id !== activity.id) && this.isRider(a)) ?? [];
    /* 2014 monsters mark the rider "special", 2024 ones (Ghoul Claw) leave it as an action : the item's one save rides it */
    return saves.find(a => a.activation?.type === "special") ?? ((saves.length === 1) ? saves[0] : null);
  }

  /**
   * An item whose usable activities are one attack plus what rides on it (Giant Spider Bite and Ghoul Claw's save;
   * the Elk's Ram and its charge damage : any number of damage activities, at most one save) goes straight to the
   * attack instead of dnd5e's "which activity?" prompt : the rest is rolled onto the attack's card. Grapple and Shove
   * aren't riders (Unarmed Strike offers them instead of the attack). Shift : dnd5e's choice anyway.
   * @returns {Activity|null}  the attack to use, or null to let dnd5e prompt as normal
   */
  static fastForward(item, config = {}){
    if(config.chooseActivity || config.event?.shiftKey) return null;
    if(!settings.value("rollItem") || !settings.value("rollItemDefault")) return null;
    const usable = item?.system?.activities?.filter(a => a.canUse) ?? [];
    const attacks = usable.filter(a => a.type === "attack");
    if(attacks.length !== 1 || usable.length < 2) return null;
    const saves = usable.filter(a => a.type === "save");
    if((saves.length > 1) || saves.some(s => !this.isRider(s))) return null;
    return usable.every(a => (a === attacks[0]) || (a.type === "damage") || (a === saves[0])) ? attacks[0] : null;
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
    /* The GM counted it as a hit (Count as hit) */
    if(roll.options?.[module.id]?.forcedHit) return true;
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
   * One ray : attack against its target's AC (the attack lego) plus what comes with its result (the hit lego), rolled
   * either way : the card shows the damage once it hits (a reroll, or the GM's Count as hit).
   * Rolls are tagged with the ray index.
   * @param {object} [options]
   * @param {string} [options.attackMode]     dnd5e attack mode for this attack ("thrown" uses up the weapon)
   * @param {boolean} [options.disadvantage]  roll this attack with disadvantage (long range...)
   * @returns {Promise<Roll[]|null>}  null if the attack was cancelled
   */
  static async rollRay(activity, event, index, target, { attackMode, disadvantage, mode } = {}){
    const attack = await this.attackStep(activity, event, { target, attackMode, disadvantage, mode, ray : index });
    if(!attack) return null;
    const { damage, added } = await this.hitStep(activity, attack, { ray : index });
    return [attack, ...damage, ...added];
  }

  static async rollRays(activity, count, { event, scaling = 0, attackMode, disadvantage, targets : tokens, mode, note, cardFlags } = {}){
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
    const message = await this.attackCard(activity, rolls, { scaling, rays, note, cardFlags });
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
    /* Utility activities : a formula to roll, or effects for creatures other than the user (Bless : a row each, its Apply) */
    if((activity?.type === "utility") && !activity.roll?.formula && !(activity.effects?.length && !this.isSelfOnly(activity)) && !usage?.[module.id]?.mode) return null;
    /* Rules can keep Roll Item off an activity (macro-helper.preRollItem : Bardic Inspiration's die is rolled when used) */
    if(Hooks.call(`${module.id}.preRollItem`, activity, usage) === false) return null;
    let mode = usage?.[module.id]?.mode;
    const setting = this.DEFAULT_MODES[activity?.type];
    if(!mode && setting && settings.value(setting)) mode = activity.type;
    return mode && this.ready(mode, { notify : !!usage?.[module.id] }) ? mode : null;
  }

  /* Let dnd5e handle dialogs, consumption, concentration and templates, but skip its card and follow-up prompts */
  static onPreUse(activity, usage, dialog, message){
    rollItem.skipTemplateQuestion(activity, dialog);
    const mode = rollItem.modeFor(activity, usage);
    if(!mode) return;
    message.create = false;
    usage.subsequentActions = false;
    usage[module.id] = { ...(usage[module.id] ?? {}), mode };
  }

  /* The breakdown's dice parts, in the order of roll.dice : "+N" or "-N" by the operator before each (top level) */
  static signTooltip(roll, html){
    try {
      const dice = roll?.dice ?? [];
      const constants = (roll?.terms ?? []).filter(t => t instanceof foundry.dice.terms.NumericTerm);
      if(!html || ((dice.length + constants.length) < 2)) return html;
      const signs = new Map();
      let op = "+";
      for(const term of roll.terms){
        if(term instanceof foundry.dice.terms.OperatorTerm){ op = term.operator; continue; }
        if(term instanceof foundry.dice.terms.DiceTerm) signs.set(term, (op === "-") ? "-" : "+");
        op = "+";
      }
      const template = document.createElement("template");
      template.innerHTML = html;
      const parts = [...template.content.querySelectorAll("section.tooltip-part:not(.constant-term)")];
      parts.forEach((part, i) => {
        const value = part.querySelector(".total .value");
        const die = dice[i];
        if(!value || !die) return;
        value.textContent = `${signs.get(die) ?? "+"}${Math.abs(Number(die.total) || 0)}`;
      });
      return template.innerHTML;
    } catch(error){
      log.debug("Signed tooltip", error);
      return html;
    }
  }

  /* activity here is dnd5e's scaled clone, so upcast spells roll at the cast level */
  static onPostUse(activity, usage, results){
    /* What the use spent and placed, in case it's cancelled before its card (cancelUse) */
    rollItem.#lastUse = { uuid : activity.uuid, results, at : Date.now() };
    /* An area placed by the use : whoever is inside becomes the targets, before any card is made */
    const area = rollItem.targetArea(activity, results);

    switch(usage[module.id]?.mode){
      case "attack" : {
        /* The pick and card come after dnd5e's use returns : the promise goes on the results (Flurry of Blows waits) */
        const card = rollItem.chooseInArea(activity, area).then(chosen => rollItem.attackAfterUse(activity, usage, chosen));
        if(results) results[module.id] = { card };
        return;
      }
      case "save" :
      case "heal" :
      case "damage" :
      case "utility" : {
        /* The card is made after dnd5e's use returns : its promise goes on the results, for helpers that wait on it */
        const card = rollItem.chooseInArea(activity, area).then(chosen => rollItem.usageCard(activity, results.message, { area : chosen, useTargets : !!usage?.[module.id]?.useTargets }));
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
    /* What rules noted on the use : a note for the card, a stretched range (Distant Spell) */
    const note = usage?.[module.id]?.note ?? null;
    const cardFlags = usage?.[module.id]?.cardFlags ?? null;
    const rangeMultiplier = Number(usage?.[module.id]?.rangeMultiplier) || 1;
    /* An area already chose the targets; a rule set them (a leap, a sustained spell : usage useTargets) */
    if(area) return this.rollActivity(activity, { event, scaling, note, cardFlags, targets : area.length ? area : undefined });
    if(usage?.[module.id]?.useTargets && game.user.targets.size) return this.rollActivity(activity, { event, scaling, note, cardFlags, targets : [...game.user.targets] });
    const pick = settings.value("rollItemPick");
    const attacker = tokenOf(activity.item);
    if((pick === "off") || !canvas.ready || !attacker || (attacker.document.parent !== canvas.scene)){
      if(!game.user.targets.size) return this.rollActivity(activity, { event, scaling, note, cardFlags });
      const checked = await this.checkTargets(activity, [...game.user.targets]);
      if(!checked?.length) return this.cancelUse(activity);
      return this.rollActivity(activity, { event, scaling, note, cardFlags, targets : checked });
    }

    const count = this.countFor(activity);
    const picked = await pickAttack(activity.item, { activity, count, repeat : count > 1, clearTargets : pick === "always", used : true, rangeMultiplier, filter : rollOptionFilter(activity) ?? undefined });
    if(!picked) return this.cancelUse(activity);
    const { attackMode, disadvantage } = picked;
    const targets = await this.checkTargets(activity, picked.targets);
    if(!targets?.length) return this.cancelUse(activity);
    if(!this.announceTargets(activity, targets)) return this.cancelUse(activity);
    /* Fewer picks than rays : the rays are spread over the picks (3 rays, A and B -> A A B) */
    return this.rollActivity(activity, { event, scaling, note, cardFlags, count : Math.max(count, targets.length), targets, attackMode, disadvantage });
  }

  /**
   * Roll Type : Normal : an attack picks its targets on the map before dnd5e's use, like Roll Item's own cards
   * (range, long range, ammunition), then dnd5e makes its card for them.
   * @returns {Promise<boolean|null>}  false : the pick was closed (nothing used); null : nothing to pick here
   */
  static async pickForNormal(activity, usage = {}){
    const pick = settings.value("rollItemPick");
    const attacker = tokenOf(activity.item);
    if(!settings.value("rollItem") || (pick === "off") || !canvas.ready || !attacker || (attacker.document.parent !== canvas.scene)) return null;
    const picked = await pickAttack(activity.item, { activity, count : this.countFor(activity), repeat : this.countFor(activity) > 1,
      clearTargets : pick === "always", used : false, rangeMultiplier : Number(usage?.[module.id]?.rangeMultiplier) || 1, filter : rollOptionFilter(activity) ?? undefined });
    if(!picked?.targets?.length) return false;
    return this.announceTargets(activity, picked.targets);
  }

  static #lastUse = { uuid : null, results : null, at : 0 };

  /**
   * A use stopped part way (the pick closed, a question closed) : as if it never happened. What dnd5e spent is
   * refunded (a slot, a use), the templates it placed are removed, and no card is made.
   * @param {Activity} activity
   */
  static async cancelUse(activity){
    const last = this.#lastUse;
    this.#lastUse = { uuid : null, results : null, at : 0 };
    if(!last.results || (last.uuid !== activity?.uuid) || ((Date.now() - last.at) > 600000)) return null;
    const message = last.results.message;
    const deltas = message?.data?.system?.deltas ?? message?.system?.deltas;
    try {
      if(deltas) await activity.refund(deltas);
      const placed = (last.results.templates ?? []).filter(t => t?.id && t.parent?.regions?.has?.(t.id));
      for(const scene of new Set(placed.map(t => t.parent))){
        await scene.deleteEmbeddedDocuments("Region", placed.filter(t => t.parent === scene).map(t => t.id));
      }
      ui.notifications.info(module.format("rollItem.cancelled", { name : activity.item?.name ?? "" }));
    } catch(error){
      log.error("Cancelling the use", error);
    }
    return null;
  }

  /* ---------- Picking targets for heals, saves and effects ---------- */

  /* Activity types picked for before their use (attacks pick after, see attackAfterUse) */
  static PICK_TYPES = ["heal", "save", "utility"];

  /**
   * Roll Item's steps on an activity's use (uses.js). Rules add their own before these (Turn Undead's preset targets mark
   * skipPick; Grapple / Shove's choice) :
   *   offScene      : a creature with no token on the scene being viewed can't see anything there to target : it rolls
   *                   without targets (yours are let go, with a notice), and nothing is picked.
   *   pickTargets   : with Pick Targets on, a heal / save / effect aimed at creatures (Healing Hands, Grapple, Mage
   *                   Armor) picks them on the map first, like attacks : closing the pick spends nothing, and the card
   *                   is made for exactly those. Roll Type Normal : dnd5e's own attack card, aimed at the picks.
   */
  static registerSteps(){
    uses.onActivity("offScene", (activity, ctx, next) => {
      if(!settings.value("rollItem") || !canvas.ready || !activity?.actor || tokenOf(activity.actor)) return next();
      if(game.user.targets.size){
        canvas.tokens.setTargets([]);
        ui.notifications.info(module.format("rollItem.offScene", { name : activity.actor.name }));
      }
      uses.mark(ctx, { skipPick : true });
      return next();
    });
    uses.onActivity("pickTargets", async (activity, ctx, next) => {
      if((activity.type === "attack") && !rollItem.modeFor(activity, ctx.config) && !ctx.config?.[module.id]?.skipPick){
        const picked = await rollItem.pickForNormal(activity, ctx.config);
        if(picked === false) return;
      }
      const spec = rollItem.pickSpec(activity, ctx.config);
      if(spec){
        const picks = await rollItem.checkTargets(activity, await pickTargets(activity.item, spec));
        if(!picks?.length || !rollItem.announceTargets(activity, picks)) return;
      }
      /* No pick (your own targets) : the same checks, before it's used (attacks check theirs after the pick) */
      else if((activity.type !== "attack") && game.user.targets.size && !ctx.config?.[module.id]?.skipPick){
        const checked = await rollItem.checkTargets(activity, [...game.user.targets]);
        if(!checked?.length) return;
        canvas.tokens.setTargets(checked.map(t => t.id));
      }
      return next();
    });
    /* Attack + save rider items skip dnd5e's activity choice (sheet, hotbar, anything calling item.use) */
    uses.onItem("fastForward", (item, ctx, next) => {
      const attack = rollItem.fastForward(item, ctx.config);
      if(!attack) return next();
      const { chooseActivity, ...usage } = ctx.config;
      return attack.use(usage, ctx.dialog, ctx.message);
    });
  }

  /**
   * Does the activity only ever affect its user ? Target "Self", or "Range : Self" with no area and no other target
   * (Second Wind, Stone's Endurance). Its card is for the caster, never for what happens to be targeted.
   * @param {Activity} activity
   * @returns {boolean}
   */
  /* A summoned creature is on its summoner's side, even when the activity doesn't ask dnd5e to match it (Plutonium's
     Wild Companion : a familiar would otherwise keep the beast's own hostile disposition) */
  static summonOnSide(activity, config){
    if(!settings.value("rollItem") || !config?.tokenUpdates || !activity?.actor) return;
    if(activity.match?.disposition || ("disposition" in config.tokenUpdates)) return;
    const token = activity.getUsageToken?.()?.document ?? (activity.actor.isToken ? activity.actor.token : activity.actor.prototypeToken);
    if(token?.disposition !== undefined) config.tokenUpdates.disposition = token.disposition;
  }

  /**
   * A self-only activity's effects (Armor of Shadows' Mage Armor) : put on its user by the client that used it (its
   * owner), since dnd5e only lets players apply them from the card with its Allow Player Effects Tray setting. Tied to
   * the item's Concentration when there is one. Rules that put on the item's effect themselves say so :
   * Hooks "macro-helper.selfEffects" (activity) returning false (Rage, Dodge, Innate Sorcery, Blade Ward); an item that
   * already has an effect on the creature (its own, switched on, too) is skipped.
   */
  static async selfEffects(activity, results){
    if(!settings.value("rollItem") || !this.isSelfOnly(activity) || !activity?.effects?.length) return;
    /* An enchanting activity's effects go on items (dnd5e's applyEnchantment), never on the creature */
    if(activity.type === "enchant") return;
    if(Hooks.call(`${module.id}.selfEffects`, activity) === false) return;
    const actor = activity.getUsageToken?.()?.actor ?? activity.actor;
    if(!actor?.isOwner) return;
    await wait(400);
    const item = activity.item;
    const fromItem = e => !e.disabled && ((e.parent === item) || (originItem(e) === item) || ((originItem(e)?.id === item.id) && (originItem(e)?.parent === item.parent)));
    if([...(actor.allApplicableEffects?.() ?? actor.effects)].some(fromItem)) return;
    const concentration = actor.effects.find(e => e.statuses?.has?.(CONFIG.specialStatusEffects.CONCENTRATING) && (e.getFlag("dnd5e", "item")?.id === item.id));
    const data = [];
    for(const { _id } of activity.effects){
      const effect = item.effects.get(_id);
      if(!effect || (effect.type === "enchantment")) continue;
      const copy = foundry.utils.mergeObject(effect.toObject(), { origin : activity.uuid, transfer : false, disabled : false,
        start : { time : game.time.worldTime }, ...(concentration ? { flags : { dnd5e : { dependentOn : concentration.uuid } } } : {}) }, { inplace : false });
      delete copy._id;
      data.push(copy);
    }
    if(!data.length) return;
    await actor.createEmbeddedDocuments("ActiveEffect", data);
    if(results?.message?.setFlag && results.message.isOwner) await results.message.setFlag(module.id, "autoApplied", true).catch(() => {});
    log.debug("Self effects", actor.name, item.name, data.length);
  }

  static hideSelfTray(message, html){
    if(!settings.value("rollItem") || (message?.type !== "usage")) return;
    let activity = null;
    try { activity = message.getAssociatedActivity?.(); } catch { return; }
    if(!activity?.effects?.length || (activity.type === "enchant") || !this.isSelfOnly(activity)) return;
    html?.querySelector?.("effect-application")?.remove();
  }

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

  /* A "Range : Self" cube (Thunderwave's 15 ft cube "originating from you") : against one side of its caster */
  static isCubeFromSelf(activity){
    const range = activity?.range?.override ? activity.range : (activity?.item?.system?.range ?? activity?.range);
    return (range?.units === "self") && ["cube", "square"].includes(activity?.target?.template?.type);
  }

  /* The cube's place while placing : touching the caster's space on the side (of 8) the mouse is towards */
  static anchorCube(activity){
    const token = activity.getUsageToken?.()?.object ?? tokenOf(activity.item);
    const layer = canvas.regions;
    if(!token || !layer || layer.placeRegions?.[`${module.id}Anchor`]) return;
    const hadOwn = Object.hasOwn(layer, "placeRegions");
    const original = layer.placeRegions;
    const restore = () => { if(hadOwn) layer.placeRegions = original; else delete layer.placeRegions; };
    const DIRS = { 0 : [1, 0], 1 : [1, 1], 2 : [0, 1], 3 : [-1, 1], 4 : [-1, 0], [-4] : [-1, 0], [-3] : [-1, -1], [-2] : [0, -1], [-1] : [1, -1] };
    const anchored = function(data, options = {}){
      restore();
      const onMove = args => {
        const { shape, position } = args;
        const b = token.bounds;
        const size = Number(shape.width) || canvas.grid.size;
        const cx = b.x + (b.width / 2), cy = b.y + (b.height / 2);
        const [dx, dy] = DIRS[Math.round(Math.atan2(position.y - cy, position.x - cx) / (Math.PI / 4))] ?? [1, 0];
        const x = (dx > 0) ? (b.x + b.width) : (dx < 0) ? (b.x - size) : (cx - (size / 2));
        const y = (dy > 0) ? (b.y + b.height) : (dy < 0) ? (b.y - size) : (cy - (size / 2));
        shape.updateSource({ x, y, rotation : 0, anchorX : 0, anchorY : 0 });
        options.onMove?.(args);
        return false;
      };
      return original.call(this, data, { ...options, onMove, onRotate : () => false });
    };
    anchored[`${module.id}Anchor`] = true;
    layer.placeRegions = anchored;
  }

  /**
   * A "Range : Self" cone or line is placed from its caster : while placing, its point stays on the caster's token and
   * the mouse only aims it. dnd5e places templates through core's canvas.regions.placeRegions without an onMove; this
   * gives the next call one, then steps aside.
   */
  static anchorToSelf(activity){
    if(!settings.value("rollItem") || !canvas.ready) return;
    if(this.isCubeFromSelf(activity)) return this.anchorCube(activity);
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
        const { shape } = args;
        /* A cube on a square grid : its corner on a grid point, so it covers whole squares (a 5 ft cube : one square) */
        const g = canvas.grid.size;
        const snap = (shape.type === "rectangle") && canvas.grid.isSquare;
        const position = snap ? { x : Math.round(args.position.x / g) * g, y : Math.round(args.position.y / g) * g } : args.position;
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
        if(!wall && (gap <= limit) && !snap) return options.onMove?.(args);
        if(snap) point = { x : Math.round(point.x / g) * g, y : Math.round(point.y / g) * g };
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
   * trays are for exactly them. The caster counts too, except for their own cone or line (its point isn't in its area)
   * or emanation (2024 : an emanation leaves out the creature it comes from).
   * With the Template Targeting setting.
   * @returns {Token[]|null}  the tokens inside, null when nothing was placed (or the setting is off)
   */
  static targetArea(activity, results){
    const templates = results?.templates ?? [];
    if(!templates.length || !settings.value("rollItem") || !settings.value("rollItemTemplateTargets") || !canvas.ready) return null;
    const template = activity?.target?.template ?? {};
    const emanation = (CONFIG.DND5E.areaTargetTypes?.[template.type]?.template === "emanation") && !template.stationary;
    const caster = (this.isFromSelf(activity) || this.isCubeFromSelf(activity) || emanation) ? tokenOf(activity.item) : null;
    /* GM-hidden creatures are in it too (the card shows them to players as Unknown with the DM screen) */
    const inside = [...new Set(templates.flatMap(t => getTokensInArea(t, { includeHidden : true })))].filter(t => t !== caster);
    this.announceTargets(activity, inside, { keepEmpty : true });
    log.debug("Area targets", activity.item?.name, inside.map(t => t.name));
    return inside;
  }

  /* ---------- Target checks ---------- */

  static #targetChecks = [];

  /**
   * A rule looking at the targets once they're known, before anything is rolled (Sanctuary : the attacker saves, or
   * targets again). fn(activity, tokens) returns the targets to go on with (the same, others), or nothing to stop.
   * @param {(activity : Activity, tokens : Token[]) => Promise<Token[]|null>} fn
   */
  static addTargetCheck(fn){
    this.#targetChecks.push(fn);
  }

  static async checkTargets(activity, tokens){
    let current = tokens ?? [];
    for(const fn of this.#targetChecks){
      if(!current.length) return current;
      try { current = (await fn(activity, current)) ?? []; }
      catch(error){ log.error("Target check", error); }
    }
    return current;
  }

  /**
   * "Each creature of your choice" in an area (Word of Radiance) : the caster picks which of those inside, on the map
   * (the area stays shown; any number, Enter to confirm). Anything else : everyone inside, as placed.
   * @param {Activity} activity
   * @param {Token[]|null} inside   targetArea's tokens
   * @returns {Promise<Token[]|null>}
   */
  static async chooseInArea(activity, inside){
    if(!inside?.length) return inside;
    const text = plainText(activity?.item?.system?.description?.value);
    if(!/\b(?:creatures?|targets?|allies|enemies) of your choice\b/i.test(text)) return inside;
    const picks = await pickTargets(activity.item, { count : inside.length, range : Infinity, disposition : "any", includeSelf : false, useTargets : false,
      sight : false, confirm : "auto", filter : t => inside.includes(t), notice : module.format("rollItem.areaChoice", { n : inside.length }) });
    this.announceTargets(activity, picks ?? [], { keepEmpty : true });
    log.debug("Area choice", activity.item?.name, (picks ?? []).map(t => t.name));
    return picks ?? [];
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

  /**
   * Clear Instant Templates : at the end of a turn, the areas placed by that creature's instantaneous activities
   * (Fireball, Burning Hands) are removed. Areas that last (a duration, or Concentration) stay. Done by the active GM.
   */
  static async clearTemplates(combat, prior, current){
    if(!game.users.activeGM?.isSelf || !settings.value("clearTemplates")) return;
    if((prior?.round === current?.round) && (prior?.turn === current?.turn)) return;   // a re-sorted order
    const actor = combat.combatants.get(prior?.combatantId)?.actor;
    if(actor) await this.#clearInstant(region => this.#placedBy(region, [actor]));
  }

  /* The combat is over : every instant area its combatants placed goes */
  static async clearCombatTemplates(combat){
    if(!game.users.activeGM?.isSelf || !settings.value("clearTemplates")) return;
    const actors = [...(combat?.combatants ?? [])].map(c => c.actor).filter(Boolean);
    if(actors.length) await this.#clearInstant(region => this.#placedBy(region, actors));
  }

  /* Out of combat there are no turns : an instant area goes after a minute */
  static onTemplateCreated(region){
    if(!game.users.activeGM?.isSelf || !settings.value("clearTemplates") || game.combat?.started) return;
    if(!this.#isInstant(region)) return;
    setTimeout(() => {
      const scene = region.parent;
      if(scene?.regions?.has?.(region.id)) scene.deleteEmbeddedDocuments("Region", [region.id]).catch(() => {});
    }, this.TEMPLATE_MINUTE);
  }

  static TEMPLATE_MINUTE = 60000;

  /* An area placed by an instantaneous activity (not a duration, not Concentration) */
  static #isInstant(region){
    const activity = fromUuidSync(region?.getFlag?.("dnd5e", "activity") ?? "", { strict : false });
    if(!activity) return false;
    const duration = activity.duration ?? {};
    return (duration.units === "inst") && !duration.concentration;
  }

  /* Placed by one of these creatures */
  static #placedBy(region, actors){
    const activity = fromUuidSync(region.getFlag?.("dnd5e", "activity") ?? "", { strict : false });
    const origin = fromUuidSync(region.getFlag?.("dnd5e", "origin") ?? "", { strict : false });
    const by = origin?.actor ?? origin?.parent ?? activity?.actor;
    return actors.some(a => (by?.uuid === a.uuid) || (by?.id === a.id));
  }

  /* On every scene (the GM may be looking at another one than the fight's) */
  static async #clearInstant(test){
    for(const scene of new Set([canvas.scene, ...(game.scenes?.contents ?? [])].filter(Boolean))){
      const gone = (scene.regions?.contents ?? [...(scene.regions ?? [])]).filter(r => this.#isInstant(r) && test(r)).map(r => r.id);
      if(gone.length) await scene.deleteEmbeddedDocuments("Region", gone);
      if(gone.length) log.debug("Cleared templates", scene.name, gone.length);
    }
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

    let range = this.activityRange(activity);
    /* Distant Spell (Metamagic) : twice the range, Touch becomes 30 ft */
    const multiplier = Number(usage?.[module.id]?.rangeMultiplier) || 1;
    if(multiplier > 1) range = (activity.range?.units === "touch") ? 30 : (range * multiplier);
    if(!(range > 0)) return null;

    const disposition = ["ally", "willing"].includes(type) ? "ally"
      : ((type === "enemy") || ["save", "damage"].includes(activity.type)) ? "nonAlly" : "any";
    /* More creatures a rule allows : usage extraTargets (Twinned Spell); Hooks "macro-helper.targetCount" (activity,
       usage, { count }) adds to it (a spell's upcast targets) */
    const counted = { count : this.targetCount(activity, target) + (Number(usage?.[module.id]?.extraTargets) || 0) };
    Hooks.callAll(`${module.id}.targetCount`, activity, usage, counted);
    return {
      count : counted.count,
      range, disposition,
      includeSelf : disposition === "ally" || disposition === "any",
      useTargets : pick !== "always",
      confirm : "auto",
    };
  }

  /* How many creatures an activity affects : a number, or a formula from the item ("2 + @item.level" : Bless) */
  static targetCount(activity, target){
    const raw = target?.affects?.count;
    if(!raw) return 1;
    let count = Number(raw);
    if(!Number.isFinite(count)){
      try { count = dnd5e.utils.simplifyBonus(raw, activity.getRollData?.() ?? {}); }
      catch { count = parseInt(raw); }
    }
    return Math.max(1, Math.floor(count) || 1);
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

  /**
   * An area with nothing else to ask (no spell slot level, no scaling to choose) : dnd5e's usage dialog would only
   * ask whether to place the template. Skip it : the template is placed (Fireball from a monster's innate spells).
   */
  static skipTemplateQuestion(activity, dialog){
    if(!settings.value("rollItem") || !dialog || !activity?.target?.template?.type) return;
    const item = activity.item;
    const slots = activity.requiresSpellSlot && (Number(item?.system?.level) > 0)
      && Object.values(activity.actor?.system?.spells ?? {}).some(s => Number(s?.max) > 0);
    if(slots || activity.consumption?.scaling?.allowed) return;
    dialog.configure = false;
  }

  /* A utility activity's own roll formula (dnd5e's "Roll" button), no dialog, no message */
  static async rollFormula(activity){
    if(!activity?.roll?.formula) return [];
    /* Rules can keep a formula off the card (Resistance's 1d4 is rolled when the damage comes) : macro-helper.rollFormula */
    if(Hooks.call(`${module.id}.rollFormula`, activity) === false) return [];
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
      /* A crit; rules make others one in preDamage (a hit on a Paralyzed target from within 5 ft) */
      isCritical : !!attack?.isCritical,
      /* The attack's tags (Cleave's extra attack : no positive ability modifier) */
      ...(attack?.options?.[module.id]?.tags ? { [module.id] : { tags : attack.options[module.id].tags } } : {}),
    };

    /* A damage part with several types (Divine Spark : necrotic or radiant) : which one */
    if(!await this.chooseDamageTypes(activity)) return [];

    /* Stage hook : change the damage before it's rolled (config.rolls, config.isCritical...), or return false to skip it */
    if(Hooks.call(`${module.id}.preDamage`, activity, config, attack) === false) return [];
    const rolled = await activity.rollDamage(config, { configure : false }, { create : false }) ?? [];
    /* A part that came to no dice at all (True Strike's extra Radiant below level 5 : 0d6) isn't damage : left out */
    const rolls = rolled.filter(r => !(r.dice?.length && r.dice.every(d => !(Number(d.number) > 0)) && !Number(r.total)));
    Hooks.callAll(`${module.id}.damage`, activity, rolls, attack);
    return rolls;
  }

  static #typesAsked = { uuid : null, at : 0 };

  /**
   * A damage part that offers several types (Divine Spark : necrotic or radiant ; Chromatic Orb) : ask which, once
   * per use (several rays don't ask again). The answer is dnd5e's own "last damage type" for that part, which it
   * rolls with, and the next time's default.
   * @returns {Promise<boolean>}  false when closed (no damage)
   */
  static async chooseDamageTypes(activity){
    if(!activity?.item?.isOwner || (activity.type === "heal")) return true;
    const asked = this.#typesAsked;
    if((asked.uuid === activity.uuid) && ((Date.now() - asked.at) < 10000)) return true;
    /* A cast spell's activity is a scaled copy : remember the answer on the real item */
    const item = activity.actor?.items?.get(activity.item.id) ?? activity.item;
    /* Only activities with damage (a utility has none : dnd5e's _getDamageParts would throw) */
    if(!activity.damage && (activity.type === "utility")) return true;
    let parts = activity.damage?.parts ?? [];
    try { if(typeof activity._getDamageParts === "function") parts = activity._getDamageParts({}) ?? parts; }
    catch(error){ log.debug("Damage parts", activity.item?.name, error); }
    const chosenTypes = {};
    for(const [index, part] of [...parts].entries()){
      const types = [...(part?.types ?? [])];
      if(types.length < 2) continue;
      /* A rule settles it without asking (macro-helper.damageType : a pact weapon's normal type, changed on the card) */
      const preset = {};
      Hooks.callAll(`${module.id}.damageType`, activity, { index, types, preset });
      if(preset.type && types.includes(preset.type)){ chosenTypes[index] = preset.type; continue; }
      /* An enchanted item (Shillelagh, True Strike) : the answer can be kept for that enchantment ("don't ask again");
         casting the spell again makes a new enchantment, which asks again */
      const enchantment = item.effects?.find?.(e => (e.type === "enchantment") && !e.disabled) ?? null;
      /* An instantaneous spell's enchantment lasts one attack (True Strike) : the answer is kept on the item for that
         spell instead, until a long rest */
      const spell = enchantment ? (originItem(enchantment) ?? fromUuidSync(enchantment.origin ?? "", { strict : false })?.item ?? null) : null;
      const instant = spell && (spell.system?.duration?.units === "inst");
      const spellKey = instant ? `keptDamageType.${spell.system?.identifier || spell.id}.${index}` : null;
      const kept = instant ? item.getFlag(module.id, spellKey) : enchantment?.getFlag?.(module.id, `damageType.${index}`);
      if(kept && types.includes(kept)){ chosenTypes[index] = kept; continue; }
      const key = `last.${activity.id}.damageType.${index}`;
      const answer = await chooseOption({
        title : activity.item.name, icon : "fa-solid fa-burst", prompt : module.i18n("rollItem.damageType"),
        options : types.map(t => ({ value : t, label : game.i18n.localize(CONFIG.DND5E.damageTypes[t]?.label ?? t) })),
        value : item.getFlag("dnd5e", key), confirm : module.i18n("rollItem.damageTypeRoll"),
        remember : instant ? module.format("rollItem.damageTypeKeepItem", { spell : spell.name, name : item._source?.name ?? item.name })
          : enchantment ? module.format("rollItem.damageTypeKeep", { name : enchantment.name }) : null,
      });
      const chosen = (typeof answer === "object") ? answer?.value : answer;
      if(!chosen) return false;
      chosenTypes[index] = chosen;
      if(item.isOwner) await item.setFlag("dnd5e", key, chosen);
      if(answer?.remember && instant && item.isOwner) await item.setFlag(module.id, spellKey, chosen);
      else if(answer?.remember && enchantment?.isOwner) await enchantment.setFlag(module.id, `damageType.${index}`, chosen);
    }
    this.#typesAsked = { uuid : activity.uuid, at : Date.now(), types : chosenTypes };
    return true;
  }

  /* The damage roll gets the chosen type itself (dnd5e's damage application reads the roll's type) */
  static applyDamageTypes(config){
    const asked = this.#typesAsked;
    if(!asked.types || (config?.subject?.uuid !== asked.uuid) || ((Date.now() - asked.at) > 10000)) return;
    for(const [index, roll] of (config.rolls ?? []).entries()){
      const type = asked.types[index];
      if(!type) continue;
      roll.options ??= {};
      roll.options.type = type;
      if(roll.data?.roll?.damage) roll.data.roll.damage.type = type;
    }
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
    /* A roll without dice (Graze's flat damage) has nothing to show : no wait for it */
    rolls = rolls.filter(r => r.dice?.length);
    if(!rolls.length) return;
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
    rerolls.register();
    /* dnd5e's effects tray on a self-only use's card (Rage, Dodge) : its effects are already on its user (selfEffects, or
       the rule that handles it), so a second way to apply them is only a trap */
    Hooks.on("dnd5e.renderChatMessage", (message, html) => this.hideSelfTray(message, html));
    /* An attack card still revealing (its dice playing) : its buttons wait (a press then could be lost); the card is
       drawn again once everything shows */
    const wait = (message, html) => {
      if((message?.type !== TYPES.attack) || (rollItem.revealOf(message) >= 2)) return;
      for(const button of html?.querySelectorAll?.("button") ?? []){ button.disabled = true; button.dataset.tooltip = game.i18n.localize("rollItem.rolling"); }
    };
    Hooks.on("renderChatMessageHTML", wait);
    Hooks.on("dnd5e.renderChatMessage", wait);
    Hooks.on("dnd5e.preUseActivity", rollItem.onPreUse);
    Hooks.on("dnd5e.postUseActivity", rollItem.onPostUse);
    /* A roll's breakdown : each die's total signed (+ added, - taken off, as Blade Ward's 1d4) when there's more than one part */
    Hooks.once("setup", () => patch.wrap("CONFIG.Dice.BasicRoll.prototype.getTooltip", async function(wrapped, ...args){
      const html = await wrapped(...args);
      return settings.value("rollItem") ? rollItem.signTooltip(this, html) : html;
    }));
    /* Damage types kept for a one-attack enchantment (True Strike) : asked again after a long rest */
    Hooks.on("dnd5e.restCompleted", (actor, result) => {
      if(!result?.longRest || !actor?.isOwner) return;
      for(const item of actor.items) if(item.getFlag(module.id, "keptDamageType")) item.unsetFlag(module.id, "keptDamageType").catch(() => {});
    });
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => rollItem.selfEffects(activity, results));

    rollItem.registerSteps();
    /* Debug (the GM, Debug setting) : make an attack a crit or a miss, beside its reroll buttons */
    Hooks.on("dnd5e.renderChatMessage", (message, html) => rollItem.debugButtons(message, html));
    Hooks.on("dnd5e.preCreateMeasuredTemplate", activity => rollItem.anchorToSelf(activity));
    Hooks.on("combatTurnChange", (combat, prior, current) => rollItem.clearTemplates(combat, prior, current));
    Hooks.on("deleteCombat", combat => rollItem.clearCombatTemplates(combat));
    Hooks.on("createRegion", region => rollItem.onTemplateCreated(region));
    Hooks.on("updateChatMessage", (message, changes, options, userId) => rollItem.onCardUpdate(message, changes, options, userId));
    Hooks.on("dnd5e.preRollDamageV2", config => rollItem.applyDamageTypes(config));
    Hooks.on("dnd5e.preSummonToken", (activity, profile, config) => rollItem.summonOnSide(activity, config));

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

  /* The GM's debug buttons : a crit (d20 to 20) or a miss (d20 to 1), next to the attack's (or each ray's) reroll */
  static debugButtons(message, html){
    if(!game.user.isGM || !settings.value("debug") || !message.system?.forceD20) return;
    /* Each in its own list item, in line after the reroll buttons (crit, then miss) */
    const add = (button, ray) => {
      let anchor = button?.closest("li");
      if(!anchor || anchor.parentElement?.querySelector(`:scope > .${module.id}-debug`)) return;
      for(const [value, icon, key] of [[20, "fa-bug", "rollItem.debug.crit"], [1, "fa-bug-slash", "rollItem.debug.miss"]]){
        const li = document.createElement("li");
        li.className = `${module.id}-debug`;
        li.append(makeButton({ icon, label : module.i18n(key), className : "icon", onClick : () => message.system.forceD20(ray, value) }));
        anchor.after(li);
        anchor = li;
      }
    };
    add(html.querySelector('[data-action="rerollDamage"]') ?? html.querySelector('[data-action="rerollAttack"]'), null);
    html.querySelectorAll('[data-action="rerollRay"][data-ray]').forEach(button => add(button, Number(button.dataset.ray)));
  }

  /* ---------- Cards ---------- */

  /**
   * Attack : one message of our attack type, the rolls are attached so dnd5e renders them.
   * @param {Roll[]} rolls  attack roll(s) + damage rolls, multi-ray rolls tagged with options[module.id].ray
   * @param {object[]} [rays]  one { target : tokenUuid } per ray when rolling more than one attack
   */
  static async attackCard(activity, rolls, { scaling = 0, rays = [], rider = null, disadvantage = false, disadvantageWhy = "", note = null, cardFlags = null } = {}){
    /* The card is going out : nothing left to cancel */
    this.#lastUse = { uuid : null, results : null, at : 0 };
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
      /* A note a rule put on the use (Metamagic : which option, its points) */
      /* and what rules record about it (usage cardFlags : Metamagic's option, casting time, components) */
      ...((note || cardFlags) ? { flags : { [module.id] : { ...(cardFlags ?? {}), ...(note ? { note } : {}) } } } : {}),
    };
    ChatMessage.implementation.applyMode(messageData, CONFIG.Dice.BasicRoll.getMessageMode());

    /* Damage after the attack : everything is already rolled, this only staggers what is shown, so a natural 20
       isn't given away by crit damage dice rolling alongside it. The card goes out with every roll but shows
       "Rolling..." (flags.reveal 0), the attack dice play and the attack shows (1), then the damage dice and the
       damage (2). Dice So Nice's own animation of the card is skipped : the dice are played here, in order.
       What waits on the attack's result (a hit's damage, a miss's Graze) is only played, and shown, once the result
       calls for it (flags.dice : false until played) : a miss plays no damage dice, a reroll that hits plays them then. */
    const { DamageRoll } = CONFIG.Dice;
    const attacks = rolls.filter(r => !(r instanceof DamageRoll));
    const damage = rolls.filter(r => r instanceof DamageRoll);
    const staged = settings.value("rollItemStaged") && attacks.length && damage.length;
    const waiting = (game.dice3d && attacks.length) ? damage.filter(r => this.outcomeKey(r, { rider, rays })) : [];
    if(!staged && !waiting.length) return await ChatMessage.implementation.create(messageData);

    const flags = { ...(messageData.flags?.[module.id] ?? {}) };
    if(staged) flags.reveal = 0;
    for(const roll of waiting) foundry.utils.setProperty(flags, `dice.${this.outcomeKey(roll, { rider, rays })}`, false);
    messageData.flags = { ...(messageData.flags ?? {}), [module.id] : flags };
    if(game.dice3d) messageData.flags["dice-so-nice"] = { skip : true };
    const message = await ChatMessage.implementation.create(messageData);
    if(!message) return message;

    /* Dice that never report landing (Dice So Nice hiccup) don't leave the card on "Rolling..." */
    const landed = rolls => Promise.race([this.showDice(rolls, message), wait(8000)]);
    const always = damage.filter(r => !waiting.includes(r));
    try {
      if(staged){
        await landed(attacks);
        await message.setFlag(module.id, "reveal", 1);
        if(always.length) await landed(always);
      }
      else await landed([...attacks, ...always]);
      await this.playOutcomes(message);
    }
    finally {
      if(staged) await message.setFlag(module.id, "reveal", 2);
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
  static async usageCard(activity, data, { area = null, useTargets = false } = {}){
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
        if(!picks.length || !this.announceTargets(activity, picks)) return this.cancelUse(activity);
      }
    }
    /* A rule set the targets (an area round the target : usage useTargets) */
    if(!picks && useTargets && game.user.targets.size) picks = [...game.user.targets];
    /* Self only : the caster, not whoever is still targeted from an earlier attack */
    if(!picks && this.isSelfOnly(activity)){
      const caster = tokenOf(activity.item);
      picks = (caster && (caster.document.parent === canvas.scene)) ? [caster] : [];
      if(canvas.ready) canvas.tokens.setTargets([]);
    }
    /* A damage type to choose : asked before anything is rolled; closing it cancels the use */
    if(!await this.chooseDamageTypes(activity)) return this.cancelUse(activity);
    if(picks) data.system.targets = TargetsField.getDescriptors([...new Set(picks)]);
    data.system.targets ??= TargetsField.getDescriptors();

    /* Its damage (or healing), the save lego : instances spread over the targets like rays */
    const { damage, rays } = await this.saveStep(activity, { count, targets : picks ?? undefined });
    if(count > 1) data.system.rays = rays;

    /* Utility : its roll formula (dnd5e's "Roll" button) */
    const formula = await this.rollFormula(activity);
    for(const roll of formula) roll.options[module.id] = { part : "formula" };

    /* The card is going out : nothing left to cancel */
    this.#lastUse = { uuid : null, results : null, at : 0 };
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
    const message = await ChatMessage.implementation.create(data);
    await this.applyOwnBuffs(activity, message);
    return message;
  }

  /**
   * A buff's or a heal's card (a utility with effects, healing, temporary HP) : it goes at once on the caster's own character (the caster
   * itself, or the character assigned to one of its players : theirs, not one they merely have access to); their rows
   * show them applied. Anyone else's waits for its row's Apply.
   */
  static async applyOwnBuffs(activity, message){
    const heal = activity?.type === "heal";
    if(!(heal || ((activity?.type === "utility") && activity.effects?.length)) || (typeof message?.system?.applyEffectsTo !== "function")) return;
    const caster = activity.actor;
    const assigned = game.users.filter(u => !u.isGM && caster?.testUserPermission(u, "OWNER")).map(u => u.character).filter(Boolean);
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    for(const descriptor of message.system.targets ?? []){
      const { actor } = TargetsField.resolve(descriptor);
      if(!actor?.isOwner) continue;
      const base = actor.isToken ? actor.token?.baseActor : actor;
      const own = (actor === caster) || (actor.uuid === caster?.uuid) || assigned.some(c => (c === actor) || (c === base));
      if(!own) continue;
      /* Healing or temporary HP (Cure Wounds, Armor of Agathys), then the effects */
      if(heal) await message.system.applyRollsTo(descriptor.token).catch(error => log.debug("Own heal", error));
      if(activity.effects?.length) await message.system.applyEffectsTo(descriptor.token).catch(error => log.debug("Own buff", error));
    }
  }
}
