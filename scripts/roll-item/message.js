import { module } from '../module.js';
import { settings } from '../settings.js';
import { limits } from '../rules/limits.js';
import { rollItem } from './roll-item.js';
import { masteries } from './masteries.js';
import { maneuvers } from './maneuvers.js';
import { extraD20, rerolls, addDie } from './rerolls.js';
import { originOf } from '../helpers/utils.js';
import { conditions } from '../rules/conditions.js';
import { feats } from '../rules/feats.js';

/* Declared in module.json documentTypes.ChatMessage, Foundry prefixes them with the module id */
export const TYPES = {
  attack : `${module.id}.rollItem`,
  save : `${module.id}.save`,
};

export function registerMessages(){
  const { AttackMessageData, UsageMessageData } = dnd5e.dataModels.chatMessage;
  const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
  const { DamageRoll, aggregateDamageRolls } = dnd5e.dice;

  /* Shared markup for damage boxes, one per damage type : {{> "macro-helper.damage-rows" damage }} */
  foundry.applications.handlebars.loadTemplates({
    [`${module.id}.damage-rows`] : `${module.path}/templates/damage-rows.hbs`,
    [`${module.id}.mastery`] : `${module.path}/templates/mastery.hbs`,
    [`${module.id}.extras`] : `${module.path}/templates/extras.hbs`,
    [`${module.id}.rows`] : `${module.path}/templates/rows.hbs`,
    [`${module.id}.cover`] : `${module.path}/templates/cover.hbs`,
  });

  /**
   * DM screen (Roll Item setting) : players see an NPC's card but not its numbers (the d20, totals, damage) : only
   * GMs, and players who own the creature that rolled, see those. Hit / miss and save success still show.
   */
  const hidesNumbers = message => {
    if(game.user.isGM || !settings.value("rollItemDmScreen")) return false;
    const actor = message.getAssociatedActor?.() ?? message.getSpeakerActor?.();
    return !actor?.hasPlayerOwner;
  };

  /* A token players aren't meant to know about (GM-hidden, or Invisible) : shown to them as "Unknown" with the DM screen */
  const isHiddenToken = token => !!token && (token.document?.hidden || token.hidden || token.actor?.statuses?.has("invisible"));
  const maskTarget = descriptor => {
    if(!descriptor || game.user.isGM || !settings.value("rollItemDmScreen")) return descriptor;
    const token = TargetsField.resolve(descriptor).token;
    if(!isHiddenToken(token?.object ?? token)) return descriptor;
    return { ...descriptor, name : module.i18n("rollItem.unknown"), img : "icons/svg/mystery-man.svg", ac : null };
  };

  /* ---------- Rows : one per target, its save then its damage / healing (save cards, and on-hit saves) ---------- */

  /**
   * Save results by token uuid, for the saves linked to a card : total + success from the save messages, and for
   * saves the GM rolled privately (DM screen) the success the GM recorded on the card.
   * @returns {Map<string, { total : number|null, success : boolean }>}
   */
  const saveResultsOf = message => {
    const results = new Map();
    for(const save of message.getAssociatedRolls?.("save") ?? []){
      const outcome = conditions.saveOutcome(save);
      const uuid = save.getAssociatedToken()?.uuid;
      if(!outcome || !uuid) continue;
      /* Cover set (or changed) after a DEX save was rolled from a row : the total and its success follow */
      const rolled = save.getFlag?.(module.id, "row");
      if(rolled && !outcome.auto){
        const now = (rolled.ability === "dex") ? (COVER[coverOf(message, uuid)] || 0) : 0;
        const shift = now - (rolled.cover || 0);
        const dc = save.rolls[0]?.options?.target;
        if(shift && Number.isFinite(outcome.total)){
          outcome.shift = shift;
          outcome.total += shift;
          if(Number.isFinite(dc)) outcome.success = outcome.total >= dc;
        }
      }
      results.set(uuid, { ...outcome, message : save });
    }
    /* Automatic failures (STR / DEX while Paralyzed, Stunned...) : no roll, a failure */
    const abilities = message.system?.saveAbilities ?? [];
    if(abilities.length){
      for(const descriptor of message.system?.targets ?? []){
        if(results.has(descriptor.token)) continue;
        const { actor } = TargetsField.resolve(descriptor);
        const autos = abilities.map(a => conditions.autoFailOf(actor, a));
        if(autos.every(Boolean)) results.set(descriptor.token, { total : null, success : false, auto : autos[0] });
      }
    }
    for(const [key, value] of Object.entries(message.getFlag(module.id, "saves") ?? {})){
      if(!results.has(keyUuid(key))) results.set(keyUuid(key), { total : null, success : !!value?.success });
    }
    return results;
  };

  /**
   * What was applied from this card to a creature (conditions.onApplyDamage notes it, by part : "rows", "hits", "tray") :
   * "−7" damage, "+5" healing, "✓" when an NPC's numbers are behind the DM screen.
   * @param {ChatMessage} message
   * @param {string} tokenUuid
   * @param {string[]} [parts]
   * @returns {{ text : string, healing : boolean }|null}
   */
  const appliedOn = (message, tokenUuid, parts = ["rows"]) => {
    const actor = tokenUuid ? fromUuidSync(tokenUuid, { strict : false })?.actor : null;
    const here = actor?.getFlag?.(module.id, `applied.${message.id}`) ?? {};
    const found = parts.filter(p => Number.isFinite(here[p]));
    if(!found.length) return null;
    const amount = found.reduce((sum, p) => sum + here[p], 0);
    const hide = !game.user.isGM && settings.value("rollItemDmScreen") && !actor.hasPlayerOwner;
    return { text : hide ? "✓" : ((amount >= 0) ? `−${amount}` : `+${-amount}`), healing : amount < 0 };
  };

  /**
   * What a rolled save was made of, for its result's tooltip : "d20 : 2, 12 (Advantage, kept 12) · 12 + 2 = 14".
   * @param {D20Roll} roll
   * @param {number} [shift]  cover added since it was rolled
   */
  const rollDetail = (roll, shift = 0) => {
    if(!roll) return "";
    const sign = n => (n >= 0 ? `+ ${n}` : `- ${-n}`);
    const d20 = roll.dice?.[0];
    const mode = Number(roll.options?.advantageMode ?? 0);
    const kept = d20?.results?.filter(r => r.active).map(r => r.result) ?? [];
    let dice = d20 ? `d20 : ${d20.results.map(r => r.result).join(", ")}` : "";
    if(d20 && (d20.results.length > 1)){
      dice += ` (${mode > 0 ? game.i18n.localize("DND5E.Advantage") : mode < 0 ? game.i18n.localize("DND5E.Disadvantage") : module.i18n("rollItem.hint.rerolled")}, ${module.i18n("rollItem.hint.kept")} ${kept.join(", ")})`;
    }
    const sum = `${roll.result ?? roll.formula} = ${roll.total}`;
    const cover = shift ? ` · ${module.i18n("rollItem.hint.cover")} ${sign(shift)} = ${roll.total + shift}` : "";
    return [dice, sum].filter(Boolean).join(" · ") + cover;
  };

  /* Save outcomes as dnd5e's trays read them : "success" / "failure" by token uuid */
  const outcomesOf = message => new Map([...saveResultsOf(message)].map(([uuid, r]) => [uuid, r.success ? "success" : "failure"]));

  /**
   * What a save will add, shown on its button before it's rolled : "DEX +5 : DEX +3, Prof +2 · Advantage : Dodging".
   * Only the creature's owner and the GM see save buttons, so its numbers aren't hidden.
   */
  const saveHint = (message, actor, ability, { dc, bonus = "", cover = 0 } = {}) => {
    const abl = actor?.system?.abilities?.[ability];
    const abbr = String(CONFIG.DND5E.abilities[ability]?.abbreviation ?? ability).toUpperCase();
    if(!abl) return abbr;
    const sign = n => (n >= 0 ? `+${n}` : `${n}`);
    const prof = Number(abl.save?.prof?.flat ?? 0) || 0;
    const parts = [`${abbr} (${sign(abl.mod)})`];
    if(prof) parts.push(`${module.i18n("rollItem.hint.prof")} (${sign(prof)})`);
    const other = (Number(abl.save?.value) || 0) - abl.mod - prof;
    if(other) parts.push(`${module.i18n("rollItem.hint.other")} (${sign(other)})`);
    if(cover) parts.push(`${module.i18n("rollItem.hint.cover")} (${sign(cover)})`);
    if(bonus) parts.push(`${module.i18n("rollItem.hint.activity")} (${bonus})`);
    const total = `${sign((Number(abl.save?.value) || 0) + cover)}${bonus ? ` + ${bonus}` : ""}`;
    const adv = [], dis = [];
    const has = key => actor.hasConditionEffect?.(key);
    const named = key => [...(actor.statuses ?? [])].filter(s => CONFIG.DND5E.conditionEffects?.[key]?.has?.(s)).map(s => conditionNameOf(s));
    if((ability === "dex") && has("dexteritySaveAdvantage")) adv.push(...named("dexteritySaveAdvantage"));
    if((ability === "dex") && has("dexteritySaveDisadvantage")) dis.push(...named("dexteritySaveDisadvantage"));
    if(has("abilitySaveDisadvantage")) dis.push(...named("abilitySaveDisadvantage"));
    if((CONFIG.DND5E.abilities[ability]?.type === "physical") && has("physicalSaveDisadvantage")) dis.push(...named("physicalSaveDisadvantage"));
    const trait = feats.saveTraitFor(actor, message);
    if(trait) adv.push(trait.name);
    /* Effects that set the save's roll mode (Danger Sense, Rage...) */
    const key = `system.abilities.${ability}.save.roll.mode`;
    const incapacitated = ["incapacitated", "unconscious", "paralyzed", "petrified", "stunned"].some(st => actor.statuses?.has(st));
    for(const effect of actor.appliedEffects ?? []){
      /* Danger Sense gives nothing while Incapacitated (classes/barbarian.js) */
      if(incapacitated && /danger sense/i.test(effect.name ?? "")) continue;
      for(const change of [...(effect.system?.changes ?? effect.changes ?? [])]){
        if(change.key !== key) continue;
        if(Number(change.value) > 0) adv.push(effect.name);
        else if(Number(change.value) < 0) dis.push(effect.name);
      }
    }
    const modes = [];
    if(adv.length) modes.push(`${game.i18n.localize("DND5E.Advantage")} : ${[...new Set(adv)].join(", ")}`);
    if(dis.length) modes.push(`${game.i18n.localize("DND5E.Disadvantage")} : ${[...new Set(dis)].join(", ")}`);
    return `${module.i18n("rollItem.hint.bonus")} : ${total}${modes.length ? ` (${modes.join(" · ")})` : ""} = ${parts.join(" + ")}`;
  };
  const conditionNameOf = id => game.i18n.localize(CONFIG.DND5E.conditionTypes?.[id]?.name ?? CONFIG.statusEffects?.find(e => e.id === id)?.name ?? id);

  /* ---------- Cover : the GM's chips at the top of a card, per target ---------- */

  /* +AC / +DEX save; total : can't be targeted (attacks miss, no save, nothing applied) */
  const COVER = { none : 0, half : 2, threeQuarters : 5, total : null };
  const COVER_LABELS = { none : "–", half : "½", threeQuarters : "¾", total : "✕" };

  /* A target pill behind total cover : ✕ for its AC, and a miss */
  const coverShown = t => (Number.isFinite(t?.ac) && (t.ac >= rollItem.TOTAL_COVER_AC)) ? { ac : COVER_LABELS.total, hasAC : true, isMiss : true } : {};

  const coverOf = (message, uuid) => message.getFlag?.(module.id, `cover.${uuidKey(uuid)}`)?.level ?? "none";

  /* The chips : GM only, one group per target (named when there are several) */
  const coverContext = (message, targets = []) => {
    if(!game.user.isGM || !message.isContentVisible || !targets.length) return null;
    return {
      named : targets.length > 1,
      targets : targets.map(t => {
        const level = coverOf(message, t.token);
        return {
          uuid : t.token, name : t.name,
          levels : Object.keys(COVER).map(id => ({ id, label : COVER_LABELS[id], active : id === level, tooltip : module.i18n(`cover.${id}`) })),
        };
      }),
    };
  };

  /**
   * Set a target's cover on a card (GM). Attack cards change that target's AC, on the card and on the attack rolls aimed
   * at it, from the AC it had before any cover, so every hit / miss on the card follows. Save cards keep it for the rows.
   */
  const setCover = async (message, uuid, level, { attack = false } = {}) => {
    if(!game.user.isGM || !(level in COVER) || !uuid) return;
    const key = uuidKey(uuid);
    const prior = message.getFlag(module.id, `cover.${key}`);
    const update = {};
    let base = null;
    if(attack){
      const targets = foundry.utils.deepClone(message.system._source.targets ?? []);
      const target = targets.find(t => t.token === uuid);
      base = prior ? prior.base : (target?.ac ?? null);
      const ac = (level === "total") ? rollItem.TOTAL_COVER_AC : (Number.isFinite(base) ? base + COVER[level] : base);
      if(target) target.ac = ac;
      update["system.targets"] = targets;
      const rays = message.system.rays ?? [];
      let changed = false;
      const rolls = message.rolls.map(roll => {
        if(!(roll instanceof CONFIG.Dice.D20Roll)) return roll;
        const ray = roll.options?.[module.id]?.ray;
        const aimed = (Number.isInteger(ray) && rays[ray]?.target) ? (rays[ray].target === uuid) : (targets.length === 1);
        if(!aimed) return roll;
        const copy = roll.constructor.fromData(roll.toJSON());
        if(Number.isFinite(ac)) copy.options.target = ac;
        else delete copy.options.target;
        changed = true;
        return copy;
      });
      if(changed) update.rolls = rolls.map(r => JSON.stringify(r));
    }
    update[`flags.${module.id}.cover.${key}`] = { level, base };
    await message.update(update);
  };

  /* Full damage on a failure, onSave (half / none) on a success */
  const multiplierFor = (result, onSave) => {
    if(!result?.success) return 1;
    return (onSave === "none") ? 0 : (onSave === "half") ? 0.5 : 1;
  };

  /**
   * The rows for a card : each target's save buttons (for its owner and the GM), result, and Apply sized by the result.
   * @param {ChatMessage} message
   * @param {object} options   { targets, hasSave, abilities, dc, onSave, hasRolls, isHeal }
   */
  const buildRows = (message, { targets = [], hasSave = false, abilities = [], dc, onSave, hasRolls = false, isHeal = false, bonus = "", effects = [] } = {}) => {
    if(!targets.length || !message.isContentVisible) return [];
    const results = saveResultsOf(message);
    const dmScreen = settings.value("rollItemDmScreen");
    return targets.map(descriptor => {
      const shown = maskTarget(descriptor);
      const { actor } = TargetsField.resolve(descriptor);
      const owner = game.user.isGM || !!actor?.isOwner;
      const result = results.get(descriptor.token) ?? null;
      /* An NPC's save total stays behind the DM screen; whether it saved shows */
      const hideTotal = !game.user.isGM && dmScreen && !actor?.hasPlayerOwner;
      const multiplier = multiplierFor(result, onSave);
      const labelKey = isHeal ? "rollItem.row.heal" : (multiplier === 0) ? "rollItem.row.none" : (multiplier === 0.5) ? "rollItem.row.half" : "rollItem.row.full";
      /* The save's own message (hidden in the log by dnd5e's chat card summary) : reroll / Lucky it from here */
      const saveOptions = result?.message ? rerolls.optionsFor(result.message) : null;
      /* Total cover : out of it (no save, nothing applied) */
      const cover = coverOf(message, descriptor.token);
      if(cover === "total") return { uuid : descriptor.token, name : shown.name, img : shown.img, saves : [], covered : module.i18n("cover.total") };
      return {
        uuid : descriptor.token,
        name : shown.name,
        img : shown.img,
        saveMessage : result?.message?.id ?? "",
        canReroll : !!saveOptions?.reroll && !result?.auto,
        lucky : (saveOptions?.lucky && !result?.auto) ? module.format("feats.lucky.adv", { name : saveOptions.lucky.name, left : saveOptions.lucky.system.uses.value }) : null,
        inspire : (saveOptions?.inspiration && !result?.auto && !result?.success) ? module.format("classes.bard.use", { die : saveOptions.inspiration.die }) : null,
        applied : appliedOn(message, descriptor.token, ["rows"]),
        saves : (hasSave && !result && owner) ? abilities.map(ability => ({
          ability, label : `${String(CONFIG.DND5E.abilities[ability]?.abbreviation ?? ability).toUpperCase()} ${dc ?? ""}`.trim(),
          hint : saveHint(message, actor, ability, { dc, bonus, cover : (ability === "dex") ? COVER[cover] : 0 }),
        })) : [],
        pending : hasSave && !result,
        result : result ? {
          total : result.auto ? module.format("rollItem.row.autoFail", { condition : result.auto })
            : (hideTotal || (result.total === null)) ? "?" : result.total,
          success : result.success,
          /* The dice behind it (not behind the DM screen) */
          detail : (!hideTotal && result.message) ? rollDetail(result.message.rolls?.[0], result.shift ?? 0) : "",
        } : null,
        /* Once applied from this card, the amount shows instead */
        apply : (hasRolls && owner && (!hasSave || result) && !appliedOn(message, descriptor.token, ["rows"])) ? { multiplier, label : labelKey } : null,
        /* The save's effects (Turned, Paralyzed...) : the GM applies them once it's rolled, to those they apply to */
        ...effectRow(message, descriptor.token, { hasSave, result, effects }),
      };
    });
  };

  /* A row's effect button (GM) : on a failure all of them, on a success those that apply anyway; applied once */
  const effectRow = (message, uuid, { hasSave, result, effects }) => {
    if(!game.user.isGM || !hasSave || !result || !effects.length) return {};
    const due = effects.filter(e => !result.success || e.onSave);
    if(!due.length) return {};
    const names = due.map(e => e.doc.name).join(", ");
    if(message.getFlag(module.id, `effects.${uuidKey(uuid)}`)) return { effectApplied : names };
    return { effectApply : module.format("rollItem.row.applyEffect", { names }) };
  };

  /* The GM applies a row's effects to its creature */
  const applyRowEffects = async (message, button, { activity, targets = [] } = {}) => {
    if(!game.user.isGM) return;
    const uuid = button.dataset.target;
    const descriptor = targets.find(t => t.token === uuid) ?? { token : uuid };
    const { actor } = TargetsField.resolve(descriptor);
    const result = saveResultsOf(message).get(uuid);
    if(!actor || !result) return;
    const due = effectsOf(activity).filter(e => !result.success || e.onSave);
    if(!due.length) return;
    /* Grapple : only a creature no more than one size larger than the grappler */
    const grappler = message.getAssociatedActor?.();
    if((maneuvers.ofCard(message) === "grapple") && grappler && !maneuvers.fits(actor, grappler)){
      if(!limits.allow(module.format("rollItem.maneuver.tooBig", { name : actor.name, action : module.i18n("rollItem.maneuver.grapple") }), { who : grappler.name, what : `Grapple ${actor.name}` })) return;
    }
    const data = due.map(({ doc }) => {
      const d = foundry.utils.mergeObject(doc.toObject(), { origin : activity.item?.uuid ?? doc.parent?.uuid, transfer : false, disabled : false,
        start : { time : game.time.worldTime, ...(game.combat?.started ? { combat : game.combat.id, round : game.combat.round, turn : game.combat.turn ?? 0 } : {}) },
        flags : { [module.id] : { fromCard : message.id } } });
      delete d._id;
      return d;
    });
    button.disabled = true;
    await actor.createEmbeddedDocuments("ActiveEffect", data);
    await message.setFlag(module.id, `effects.${uuidKey(uuid)}`, true);
  };

  /**
   * A row's save : rolled by the target's owner (or the GM) with the keys they hold, no dialog, linked to the card.
   * With the DM screen, an NPC's save is a private GM roll, and the GM notes its success on the card.
   */
  const rollRowSave = async (message, event, button, { activity, dc, targets = [] } = {}) => {
    const { target : uuid, ability } = button.dataset;
    const descriptor = targets.find(t => t.token === uuid) ?? { token : uuid };
    const { actor, token } = TargetsField.resolve(descriptor);
    if(!actor?.isOwner || !activity) return;

    const config = { event, ability, target : dc };
    const bonus = CONFIG.Dice.BasicRoll.replaceFormulaData(activity.save?.bonus ?? "", activity.getRollData(), { missing : 0 });
    /* Cover the GM set on the card : +2 / +5 to a DEX save */
    const cover = (ability === "dex") ? (COVER[coverOf(message, uuid)] || 0) : 0;
    const bonusData = CONFIG.Dice.BasicRoll.constructParts({ activityBonus : bonus, cover : cover || "" });
    if(bonusData.parts.length) config.rolls = [bonusData];

    const secret = settings.value("rollItemDmScreen") && !actor.hasPlayerOwner;
    const speaker = ChatMessage.implementation.getSpeaker({ actor, scene : canvas.scene, token : token?.document });
    const messageConfig = { data : { speaker, system : { ...activity.messageSources, origin : message.id },
      flags : { [module.id] : { row : { ability, cover } } } } };
    if(secret) messageConfig.rollMode = "gm";

    button.disabled = true;
    try {
      const [roll] = (await actor.rollSavingThrow(config, { configure : false }, messageConfig)) ?? [];
      if(roll && secret && game.user.isGM && Number.isFinite(dc)){
        await message.setFlag(module.id, `saves.${uuidKey(uuid)}`, { success : roll.total >= dc });
      }
    } finally {
      button.disabled = false;
    }
  };

  /* A row's save rerolled / Lucky'd : the save message itself (dnd5e's summary hides it in the log) */
  const rowReroll = async (event, button) => {
    const save = game.messages.get(button.dataset.message);
    if(save) await rerolls.reroll(save, event);
  };
  const rowLucky = async (event, button) => {
    const save = game.messages.get(button.dataset.message);
    if(save) await rerolls.lucky(save, save.getAssociatedActor?.());
  };
  /* Apply effect on a row : the rider's activity on an attack card, the card's own on a save card */
  async function RowEffect(event, button){
    const activity = this.riderActivity ?? this.parent.getAssociatedActivity({ scaled : true });
    await applyRowEffects(this.parent, button, { activity, targets : this.targets });
  }
  const rowInspire = async (event, button) => {
    const save = game.messages.get(button.dataset.message);
    if(save) await rerolls.inspire(save, save.getAssociatedActor?.());
  };

  /* A row's damage / healing : only the target's owner (or the GM) can apply it, sized by its save */
  const applyRow = async (message, button, { rolls = [], targets = [] } = {}) => {
    const uuid = button.dataset.target;
    const descriptor = targets.find(t => t.token === uuid) ?? { token : uuid };
    const { actor } = TargetsField.resolve(descriptor);
    if(!actor?.isOwner) return;
    const multiplier = Number(button.dataset.multiplier ?? 1);
    /* Hook : a rule can add to applying (Battle Medic spends the target's Hit Die) or stop it (return false) */
    if(Hooks.call(`${module.id}.preApplyRow`, message, actor, { multiplier }) === false) return;
    button.disabled = true;
    await applyDamageRolls(message, actor, rolls, { multiplier, part : "rows" });
  };

  /* Does an attack roll hit this AC : crits always, fumbles never, no AC known counts as a hit */
  const hitsAC = (roll, ac) => {
    if(!roll) return false;
    if(Number.isFinite(ac) && (ac >= rollItem.TOTAL_COVER_AC)) return false;
    if(roll.isCritical) return true;
    if(roll.isFumble) return false;
    return !Number.isFinite(ac) || (roll.total >= ac);
  };

  /**
   * Damage for display, split by damage type (1d8 slashing + 1d6 fire = two boxes), since targets can resist one and not the other.
   * The trays apply per type as well : they hand dnd5e one entry per type, which applies resistances per type.
   * Same breakdown data as dnd5e's DamageMessageData#_prepareContext.
   */
  const damageContext = (message, rolls, { hidden = false } = {}) => {
    const isPrivate = !message.isContentVisible || hidden;
    const total = rolls.reduce((total, roll) => total + Math.max(0, roll.total), 0);
    const showTray = (game.user.isGM || dnd5e.settings.allowPlayerDamageTray) && !isPrivate;

    /* Hidden cards show one "?" box, the number of boxes would give the types away */
    if(isPrivate) return { isPrivate, total, showTray, types : [{ total : "?", isPrivate }] };

    const types = aggregateDamageRolls(rolls).map(roll => {
      const part = roll.aggregateTerms();
      const config = CONFIG.DND5E.damageTypes[part.type] ?? CONFIG.DND5E.healingTypes[part.type] ?? null;
      part.config = config;
      part.label = config?.labelShort ?? config?.label ?? "";
      return {
        type : part.type,
        label : config?.label ? game.i18n.localize(config.label) : "",
        icon : config?.icon ?? "",
        total : Math.max(0, roll.total),
        parts : [part],
      };
    });

    return { isPrivate, total, showTray, types };
  };

  /**
   * Swap rolls in once Dice So Nice has finished showing them, so the card never shows a result early.
   * @param {ChatMessage5e} message
   * @param {object} changes
   * @param {Roll[]} changes.rolls   the full new rolls array
   * @param {Roll[]} changes.shown   the rolls that are new and should be animated
   * @param {object} [changes.system]
   */
  const replaceRolls = async (message, { rolls, shown, system = {} }) => {
    await rollItem.showDice(shown, message);
    return message.update({ rolls : rolls.filter(Boolean).map(r => JSON.stringify(r)), system });
  };

  /* Rolls on our cards are tagged options[module.id] = { ray, part }, untagged rolls are ray 0 / "base" */
  const tagOf = roll => ({ ray : 0, part : "base", ...(roll.options?.[module.id] ?? {}) });
  const tag = (rolls, data) => { for(const roll of rolls) roll.options[module.id] = { ...tagOf(roll), ...data }; return rolls; };

  /**
   * The ActiveEffects an activity applies, for dnd5e's <effect-application> tray (which wants full uuids).
   * Activity effect links hold a uuid only for external effects, item effects are referenced by _id.
   */
  const effectDocs = activity => (activity?.applicableEffects ?? [])
    .map(e => e.uuid ? fromUuidSync(e.uuid, { strict : false }) : activity.item?.effects.get(e._id))
    .filter(Boolean);

  /* An activity's effects with whether each applies on a successful save too : [{ doc, onSave }] */
  const effectsOf = activity => (activity?.applicableEffects ?? [])
    .map(e => ({ doc : e.uuid ? fromUuidSync(e.uuid, { strict : false }) : activity.item?.effects.get(e._id), onSave : !!e.onSave }))
    .filter(e => e.doc);

  /* Same permission dnd5e uses for its effect tray */
  const canApplyEffects = message => message.isContentVisible && (game.user.isGM || dnd5e.settings.allowPlayerEffectsTray);

  /* dnd5e's compact roll box, used for non-damage rolls (utility formulas) */
  const ROLL_TEMPLATE = "systems/dnd5e/templates/chat/parts/roll-compact.hbs";

  /* Who damage lands on : the stored target, or the selected tokens if there was none. Only actors the user owns. */
  const targetActors = descriptor => {
    const actors = descriptor
      ? [TargetsField.resolve(descriptor).actor]
      : (canvas.tokens?.controlled ?? []).map(t => t.actor);
    return [...new Set(actors.filter(a => a?.isOwner))];
  };

  /* Same call dnd5e's damage tray makes : one entry per damage type, dnd5e applies resistances per type */
  const applyDamageRolls = async (message, actor, rolls, { multiplier = 1, part = "hits" } = {}) => {
    if(!rolls.length) return;
    const damages = aggregateDamageRolls(rolls, { respectProperties : true }).map(roll => ({
      properties : new Set(roll.options.properties ?? []),
      type : roll.options.type,
      value : Math.max(0, roll.total),
    }));
    await actor.applyDamage(damages, { isDelta : true, multiplier, origin : message, [module.id] : { part } });
  };

  /* Flag keys can't hold dots : token uuids are stored with dashes (ids never contain one) */
  const uuidKey = uuid => uuid.replaceAll(".", "-");
  const keyUuid = key => key.replaceAll("-", ".");

  /**
   * dnd5e's damage tray, limited to one part of the card (dnd5e's own applies every damage roll on the message).
   *  data-part="base" | "save" | "graze"  the attack's damage, the on-hit save's damage (halved for targets that saved),
 *                             or the Graze mastery's damage for a miss
   *  data-ray="n"               one ray of a multi attack card
   * The parent fills `damages` and `chatMessage` when it connects; here `damages` always reads this part's rolls,
   * and for the save part `chatMessage.system` exposes the save's onSave + outcomes, which the parent uses for its save multiplier.
   */
  const DamageApplication = customElements.get("damage-application");
  class PartDamageApplication extends DamageApplication{
    static tagName = `${module.id}-damage`;

    #message = null;

    constructor(){
      super();
      Object.defineProperty(this, "damages", {
        configurable : true,
        get : ()=> this.partDamages(),
        set : ()=> {},
      });
      Object.defineProperty(this, "chatMessage", {
        configurable : true,
        get : ()=> this.#message && this.dataset.part === "save" ? this.#saveView(this.#message) : this.#message,
        set : message => this.#message = message ?? null,
      });
    }

    /* Extra damage added as an alternative (Savage Attacker's second roll) : applying the first roll or the
       alternative keeps that one, the other goes away */
    async _onApplyDamage(event){
      await super._onApplyDamage(event);
      const message = this.#message;
      const part = this.dataset.part || "base";
      if(!message?.isOwner || !["base", "extra"].includes(part) || !message.system?.alternativesOf) return;
      const ray = ("ray" in this.dataset) ? Number(this.dataset.ray) : null;
      if(!message.system.alternativesOf(ray).length) return;
      await message.setFlag(module.id, `choice.${masteries.rayKey(ray)}`, (part === "extra") ? this.dataset.key : "base");
    }

    matches(roll){
      if(!(roll instanceof DamageRoll)) return false;
      const { ray, part, key } = tagOf(roll);
      if(("ray" in this.dataset) && ray !== Number(this.dataset.ray)) return false;
      if(("key" in this.dataset) && (key !== this.dataset.key)) return false;
      return part === (this.dataset.part || "base");
    }

    partDamages(){
      const rolls = (this.#message?.rolls ?? []).filter(r => this.matches(r));
      return aggregateDamageRolls(rolls, { respectProperties : true }).map(roll => ({
        properties : new Set(roll.options.properties ?? []),
        type : roll.options.type,
        value : Math.max(0, roll.total),
      }));
    }

    /* The message as the tray sees it : system.onSave is the rider's, system.origin.system.outcomes are the rider saves */
    #saveView(message){
      const system = new Proxy(message.system, {
        get : (target, key) => {
          if(key === "onSave") return target.rider?.onSave ?? null;
          if(key === "origin") return { system : { outcomes : target.outcomes } };
          return Reflect.get(target, key, target);
        },
      });
      return new Proxy(message, {
        get : (target, key) => {
          if(key === "system") return system;
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
  }
  if(!customElements.get(PartDamageApplication.tagName)) customElements.define(PartDamageApplication.tagName, PartDamageApplication);

  /* Let dnd5e collapse / remember our trays like its own */
  const trays = CONFIG.ChatMessage.documentClass.TRAY_TYPES;
  if(Array.isArray(trays) && !trays.includes(PartDamageApplication.tagName)) trays.push(PartDamageApplication.tagName);

  /**
   * Attack : dnd5e's attack message with the damage rolls folded in underneath.
   * The attack half renders exactly like dnd5e (header, properties, targets, compact roll box),
   * the damage half mirrors dnd5e's damage message (total, breakdown, damage tray).
   */
  class RollItemMessageData extends AttackMessageData{
    static metadata = Object.freeze(foundry.utils.mergeObject(super.metadata, {
      template : `${module.path}/templates/roll-card.hbs`,
      actions : {
        rerollAttack : RollItemMessageData.#rerollAttack,
        rerollDamage : RollItemMessageData.#rerollDamage,
        rerollRay : RollItemMessageData.#rerollRay,
        applyHits : RollItemMessageData.#applyHits,
        rollRiderSave : RollItemMessageData.#rollRiderSave,
        rerollRiderDamage : RollItemMessageData.#rerollRiderDamage,
        useMastery : RollItemMessageData.#useMastery,
        cardButton : RollItemMessageData.#cardButton,
        rowSave : RollItemMessageData.#rowSave,
        rowApply : RollItemMessageData.#rowApply,
        setCover : RollItemMessageData.#setCover,
        rowReroll : rowReroll,
        rowLucky : rowLucky,
        rowInspire : rowInspire,
        rowEffect : RowEffect,
      },
    }, { inplace : false }));

    static defineSchema(){
      const { ArrayField, BooleanField, NumberField, SchemaField, StringField } = foundry.data.fields;
      return {
        ...super.defineSchema(),
        /* Upcast levels, dnd5e's getAssociatedActivity({ scaled : true }) reads message.system.scaling */
        scaling : new NumberField({ integer : true, min : 0, initial : 0 }),
        /* Single attack made with disadvantage (long range...), so a reroll keeps it */
        disadvantage : new BooleanField({ initial : false }),
        disadvantageWhy : new StringField({ blank : true, initial : "" }),
        /* One entry per attack roll when rolling more than one (Scorching Ray, cleave...) :
           target is a token uuid, mode the dnd5e attack mode ("thrown"...) and disadvantage it was made with, so rerolls match */
        rays : new ArrayField(new SchemaField({
          target : new StringField({ blank : true, initial : "" }),
          mode : new StringField({ blank : true, initial : "" }),
          disadvantage : new BooleanField({ initial : false }),
          why : new StringField({ blank : true, initial : "" }),
        })),
        /* On-hit save from the same item (Giant Spider's poison), captured when rolled */
        rider : new SchemaField({
          id : new StringField({ blank : true, initial : "" }),
          ability : new StringField({ blank : true, initial : "" }),
          dc : new NumberField({ integer : true, nullable : true, initial : null }),
          onSave : new StringField({ blank : true, nullable : true, initial : null }),
        }, { nullable : true, initial : null }),
      };
    }

    get canApplyDamage(){
      return true;
    }

    get isMulti(){
      return this.rays.length > 1;
    }

    get attackRoll(){
      return this.parent.rolls.find(r => !(r instanceof DamageRoll)) ?? null;
    }

    /* The attack's own damage */
    get damageRolls(){
      return this.parent.rolls.filter(r => r instanceof DamageRoll && tagOf(r).part === "base");
    }

    /* Graze's damage for a miss (masteries.js) */
    get grazeRolls(){
      return this.parent.rolls.filter(r => r instanceof DamageRoll && tagOf(r).part === "graze");
    }

    /* ---------- Weapon mastery (masteries.js) : ray is the attack's index on a multi card, null for a single attack ---------- */

    attackOf(ray){
      return Number.isInteger(ray) ? this.rayAttack(ray) : this.attackRoll;
    }

    /* The mastery the attack used, as dnd5e chose it (only for actors who have mastered the weapon) */
    masteryOf(ray){
      return (Number.isInteger(ray) ? this.attackOf(ray)?.options?.mastery : this.mastery) || null;
    }

    targetsOf(ray){
      return Number.isInteger(ray) ? [this.rayTarget(ray)].filter(Boolean) : this.targets;
    }

    /* Tokens the attack hit, from the card's targets */
    hitTargets(ray){
      const attack = this.attackOf(ray);
      return this.targetsOf(ray).filter(t => hitsAC(attack, t.ac)).map(t => TargetsField.resolve(t).token).filter(Boolean);
    }

    masteryUsed(ray){
      return !!this.parent.getFlag(module.id, `mastery.${masteries.rayKey(ray)}`);
    }

    /* The mastery part of the card for one attack : Graze's damage on a miss, or the button for a hit */
    masteryContext(ray){
      const key = this.masteryOf(ray);
      if(!key || !masteries.enabled() || !this.parent.isContentVisible) return null;
      const attack = this.attackOf(ray);
      const targets = this.targetsOf(ray);
      const hits = targets.filter(t => hitsAC(attack, t.ac));
      const missed = targets.length > hits.length;

      const grazeRolls = Number.isInteger(ray) ? this.rayDamage(ray, "graze") : this.grazeRolls;
      const graze = (grazeRolls.length && (missed || !targets.length))
        ? { ...damageContext(this.parent, grazeRolls), showTray : this.canApply, onMiss : !targets.length }
        : null;

      /* Cleave is another attack : its roller's. The rest change the target (Prone, moved, an effect) : outcomes the
         GM decides on, so only the GM sees those buttons. Cleave's own extra attack can't Cleave again. */
      const isCleave = !!attack?.options?.[module.id]?.noMod;
      const mayUse = (key === "cleave") ? (this.parent.isOwner && !isCleave) : game.user.isGM;
      const canUse = mayUse && masteries.ACTIONS.includes(key);
      const action = (canUse && hits.length) ? {
        label : masteries.buttonLabel(key, this.parent.getAssociatedActor(), attack),
        used : this.masteryUsed(ray),
      } : null;
      if(!graze && !action) return null;

      return {
        key, graze, action,
        label : masteries.label(key),
        icon : masteries.ICONS[key] ?? "fa-star",
        ray : Number.isInteger(ray) ? ray : "",
        hasRay : Number.isInteger(ray),
      };
    }

    /* ---------- Extensions : extra damage and buttons added by item macros (stage hooks) ---------- */

    /* Did the attack hit : some target's AC, or no target to judge by */
    isHitOn(ray){
      const attack = this.attackOf(ray);
      const targets = this.targetsOf(ray);
      return targets.length ? targets.some(t => hitsAC(attack, t.ac)) : rollItem.isHit(attack);
    }

    /* Extra damage on one attack (all of it, or one key's) */
    extraRolls(ray, key){
      const all = Number.isInteger(ray) ? this.rayDamage(ray, "extra")
        : this.parent.rolls.filter(r => r instanceof DamageRoll && tagOf(r).part === "extra");
      return key ? all.filter(r => tagOf(r).key === key) : all;
    }

    /* Extra damage added as an alternative to the attack's own damage */
    alternativesOf(ray){
      return this.extraRolls(ray).filter(r => tagOf(r).alternative);
    }

    /* Which damage was applied when there are alternatives : "base", an extra key, or null while all are on offer */
    choiceOf(ray){
      return this.parent.getFlag(module.id, `choice.${masteries.rayKey(ray)}`) ?? null;
    }

    /**
     * Roll the attack's damage again, the way the card rolled it (crit included), without adding it to the card.
     * @param {number|null} [ray=null]
     * @returns {Promise<DamageRoll[]>}
     */
    async rollDamage(ray = null){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      return activity ? rollItem.rollDamage(activity, this.attackOf(ray)) : [];
    }

    /**
     * Add damage to an attack on this card, in its own labelled box with its own APPLY (Savage Attacker's second roll,
     * Divine Smite, Sneak Attack...). The dice are shown first.
     * @param {DamageRoll[]} rolls
     * @param {object} options
     * @param {string} options.key            what it is ("savage"), one box per key
     * @param {string} [options.label]        the box's title, default the key
     * @param {number|null} [options.ray]     which attack on a multi card, null for a single attack
     * @param {boolean} [options.alternative] instead of the attack's damage, not on top : applying one hides the other
     */
    async addDamage(rolls, { key, label, ray = null, alternative = false } = {}){
      if(!rolls?.length || !key) return;
      for(const roll of rolls){
        roll.options[module.id] = { ...(Number.isInteger(ray) ? { ray } : {}), part : "extra", key, label : label ?? key, alternative };
      }
      await rollItem.showDice(rolls, this.parent);
      const update = { rolls : [...this.parent.rolls, ...rolls].map(r => JSON.stringify(r)) };
      /* Already shown : Dice So Nice mustn't animate the added rolls a second time */
      if(game.dice3d) update["flags.dice-so-nice.skip"] = true;
      await this.parent.update(update);
    }

    /**
     * A second d20 for an attack already rolled, keeping the higher ("kh", advantage) or lower ("kl", disadvantage) :
     * Lucky after the roll. Advantage and disadvantage don't stack : if the roll already had the same, nothing changes;
     * if it had the opposite, they cancel and the first d20 stands. When the result changes whether it's a crit, the
     * damage is rolled again to match. The new die is shown first.
     * @param {number|null} ray
     * @param {"kh"|"kl"} keep
     * @returns {Promise<"applied"|"cancelled"|"same"|null>}  null if there's no d20 to change
     */
    async addD20(ray, keep){
      const old = this.attackOf(ray);
      const result = await extraD20(old, keep);
      if(!result) return null;
      if(result.status === "same") return "same";
      const { updated, extra } = result;

      /* Crit changed : the damage follows */
      let rolls = this.parent.rolls.map(r => (r === old) ? updated : r);
      const shown = extra ? [extra] : [];
      if(updated.isCritical !== old.isCritical){
        const activity = this.parent.getAssociatedActivity({ scaled : true });
        const base = Number.isInteger(ray) ? this.rayDamage(ray) : this.damageRolls;
        const damage = activity ? await rollItem.rollDamage(activity, updated) : [];
        if(damage.length){
          tag(damage, Number.isInteger(ray) ? { ray, part : "base" } : { part : "base" });
          rolls = [...rolls.filter(r => !base.includes(r)), ...damage];
          shown.push(...damage);
        }
      }
      await replaceRolls(this.parent, { rolls, shown });
      return result.status;
    }

    /* A die added to one attack roll (Bardic Inspiration) : the card re-judges the hit */
    async addBonus(ray, formula){
      const old = this.attackOf(ray);
      if(!old) return false;
      const { updated, extra } = await addDie(old, formula);
      const rolls = this.parent.rolls.map(r => (r === old) ? updated : r);
      await replaceRolls(this.parent, { rolls, shown : [extra] });
      return true;
    }

    /* The extra boxes for one attack, and the buttons item macros add to it (macro-helper.cardButtons) */
    extrasContext(ray){
      if(!this.parent.isContentVisible) return null;
      const hasRay = Number.isInteger(ray);
      const choice = this.choiceOf(ray);

      const groups = new Map();
      for(const roll of this.extraRolls(ray)){
        const { key, label } = tagOf(roll);
        if(!groups.has(key)) groups.set(key, { key, label, rolls : [] });
        groups.get(key).rolls.push(roll);
      }
      const extras = [...groups.values()]
        .filter(g => !choice || (choice === g.key) || !g.rolls.some(r => tagOf(r).alternative))
        .map(g => ({ key : g.key, label : g.label, chosen : choice === g.key,
          damage : { ...damageContext(this.parent, g.rolls), showTray : this.canApply && (!g.rolls.some(r => tagOf(r).onHit) || this.isHitOn(ray)) } }));

      /* Buttons : item macros listening to macro-helper.cardButtons push { id, label, icon, tooltip } */
      const buttons = [];
      Hooks.callAll(`${module.id}.cardButtons`, this.parent, buttons, { ray });
      const valid = buttons.filter(b => b?.id && b?.label);
      /* Notes : what changed the card's outcome (Interception) push { text, icon, tooltip } */
      const notes = [];
      Hooks.callAll(`${module.id}.cardNotes`, this.parent, notes, { ray });

      if(!extras.length && !valid.length && !notes.length) return null;
      return { extras, buttons : valid, notes, ray : hasRay ? ray : "", hasRay };
    }

    /* ---------- Rider (on-hit save) ---------- */

    get riderRolls(){
      return this.parent.rolls.filter(r => r instanceof DamageRoll && tagOf(r).part === "save");
    }

    get riderActivity(){
      if(!this.rider?.id) return null;
      return this.parent.getAssociatedItem({ scaled : true })?.system.activities?.get(this.rider.id) ?? null;
    }

    /* Save results rolled from this card's save button, by token uuid (same as dnd5e's usage card) */
    get outcomes(){
      return outcomesOf(this.parent);
    }

    /* The abilities the on-hit save uses (automatic failures) */
    get saveAbilities(){
      const save = this.riderActivity;
      if(!save) return [];
      return this.rider?.ability ? [this.rider.ability] : [...(save.save?.ability ?? [])];
    }

    /* With dnd5e's "Chat Card Summary" on, save results fold into this card instead of posting separately */
    get rendersSummaries(){
      return !!this.rider?.id;
    }

    /* ---------- Rays ---------- */

    rayOf(roll){
      return tagOf(roll).ray;
    }

    rayRolls(index){
      return this.parent.rolls.filter(r => this.rayOf(r) === index);
    }

    rayTarget(index){
      const uuid = this.rays[index]?.target;
      return uuid ? this.targets.find(t => t.token === uuid) ?? null : null;
    }

    /* Rebuild the rolls array in ray order, replacing the rays given */
    withRays(replaced){
      return this.rays.flatMap((_, i) => replaced.has(i) ? replaced.get(i) : this.rayRolls(i));
    }

    rayAttack(index){
      return this.rayRolls(index).find(r => !(r instanceof DamageRoll)) ?? null;
    }

    /* A ray's own damage ("base"), or its Graze damage ("graze") */
    rayDamage(index, part = "base"){
      return this.rayRolls(index).filter(r => r instanceof DamageRoll && tagOf(r).part === part);
    }

    /* Who a ray's damage lands on : its target, or the selected tokens if it had none */
    rayActors(index){
      return targetActors(this.rayTarget(index));
    }

    get canApply(){
      return this.parent.isContentVisible && (game.user.isGM || dnd5e.settings.allowPlayerDamageTray);
    }

    async applyRolls(actor, rolls){
      return applyDamageRolls(this.parent, actor, rolls);
    }

    async _prepareContext(options){
      const context = await super._prepareContext(options);
      const rolls = this.parent.rolls;
      const rendered = context.rolls;
      context.cover = coverContext(this.parent, this.targets);
      /* The item's description, as dnd5e's own cards show it (folds under the header) */
      if(this.parent.isContentVisible){
        const activity = this.parent.getAssociatedActivity?.();
        const item = activity?.item ?? this.parent.getAssociatedItem?.();
        context.description = (await Promise.resolve(item?.system?.getCardData?.({ activity })).catch(() => null))?.description || null;
      }


      /* Only whoever can update the message (roller / GM) can reroll it */
      const activity = this.parent.getAssociatedActivity();
      const canReroll = this.parent.isOwner && this.parent.isContentVisible && !!activity;
      context.buttons = canReroll ? { damage : !!activity.damage?.parts?.length } : null;

      /* Effects the attack applies (Guiding Bolt, Ray of Frost), normally on dnd5e's usage card which we replace.
         Effects the rider also carries (2024 Ghoul's Paralyzed) only apply on a failed save, they show in the save section. */
      context.effects = [];
      if(canApplyEffects(this.parent)){
        const riderEffects = new Set(effectDocs(this.riderActivity).map(e => e.id));
        context.effects = effectDocs(this.parent.getAssociatedActivity({ scaled : true })).filter(e => !riderEffects.has(e.id));
      }

      if(this.isMulti){
        /* dnd5e's target pills judge every target against the first roll, the rows show each ray's own target instead */
        context.targets = [];
        context.rolls = [];
        const visible = this.parent.isContentVisible;
        const canApply = this.canApply;

        /* Same visibility rules dnd5e uses for its target pills */
        const visibility = dnd5e.settings.attackRollVisibility;
        const showAC = game.user.isGM || (visibility === "all");
        const showResult = game.user.isGM || (visibility !== "none");

        const hidden = hidesNumbers(this.parent);
        context.rays = await Promise.all(this.rays.map(async (_, i) => {
          const attackIndex = rolls.findIndex(r => !(r instanceof DamageRoll) && this.rayOf(r) === i);
          const attack = rolls[attackIndex];
          const damage = this.rayDamage(i);
          const target = visible ? maskTarget(this.rayTarget(i)) : null;
          const hit = rollItem.isHit(attack);
          return {
            index : i,
            number : i + 1,
            canReroll,
            attack : (hidden && attack) ? await attack.render({ template : ROLL_TEMPLATE, isPrivate : true }) : (rendered[attackIndex] ?? ""),
            /* Hidden cards must not give away hits through the miss styling */
            hit : visible ? rollItem.isHit(attack) : true,
            target : target ? {
              ...target,
              hasAC : target.ac !== null,
              isMiss : !rollItem.isHit(attack),
              showAC, showResult,
              ...coverShown(target),
              applied : appliedOn(this.parent, target.token, ["hits", "tray"]),
            } : null,
            damage : (damage.length || !visible) ? damageContext(this.parent, damage, { hidden }) : null,
            /* Damage is rolled either way; APPLY only shows on a hit (a reroll that hits brings it back) */
            showTray : canApply && (damage.length > 0) && hit,
            mastery : this.masteryContext(i),
            extras : this.extrasContext(i),
          };
        }));
        /* An alternative was the damage applied : the attack's own goes away */
        for(const ray of context.rays){
          const choice = this.choiceOf(ray.index);
          if(choice && (choice !== "base")){ ray.damage = null; ray.showTray = false; }
        }
        context.applyHits = canApply && context.rays.some(r => (r.hit && r.showTray) || r.mastery?.graze);
        return this._hideUnrevealed(context);
      }

      /* Single attack : super renders every roll as a compact box, keep only the attack there */
      const hidden = hidesNumbers(this.parent);
      context.rolls = (hidden && this.attackRoll)
        ? [await this.attackRoll.render({ template : ROLL_TEMPLATE, isPrivate : true })]
        : rendered.filter((_, i) => !(rolls[i] instanceof DamageRoll));
      if(context.targets) context.targets = context.targets.map(t => ({ ...maskTarget(t), ...coverShown(t), applied : appliedOn(this.parent, t.token, ["hits", "tray"]) }));
      const damage = this.damageRolls;
      /* Damage is rolled either way; APPLY only shows on a hit (a reroll that hits brings it back) */
      if(damage.length) context.damage = { ...damageContext(this.parent, damage, { hidden }), showTray : this.canApply && this.isHitOn(null) };

      context.mastery = this.masteryContext(null);
      context.extras = this.extrasContext(null);
      const choice = this.choiceOf(null);
      if(choice && (choice !== "base")) context.damage = null;

      if(this.rider?.id) context.rider = await this._prepareRiderContext(options);
      if(context.buttons && context.rider) context.buttons.rider = context.rider.hasDamage;

      return this._hideUnrevealed(context);
    }

    /**
     * Damage after the attack (rollItem.attackCard) : leave out what hasn't been rolled on screen yet.
     *   reveal 0 : nothing but "Rolling..." (no attack totals, no hit / miss on the targets)
     *   reveal 1 : the attack(s), not the damage, masteries, rider or buttons
     */
    _hideUnrevealed(context){
      const reveal = rollItem.revealOf(this.parent);
      if(reveal >= 2) return context;

      context.pending = true;
      context.damage = null;
      context.mastery = null;
      context.extras = null;
      context.rider = null;
      context.applyHits = false;
      context.buttons = null;
      context.effects = [];
      context.rays = (context.rays ?? []).map(ray => ({
        ...ray, damage : null, showTray : false, mastery : null, extras : null, canReroll : false,
        ...(reveal < 1 ? { attack : "", hit : true, target : ray.target ? { ...ray.target, showResult : false } : null } : {}),
      }));
      if(reveal < 1){
        context.rolls = [];
        context.targets = (context.targets ?? []).map(t => ({ ...t, showResult : false }));
      }
      return context;
    }

    /* The on-hit save's rows : the targets the attack hit (or all of them when it can't tell), each saving on its own */
    riderRows(){
      const save = this.riderActivity;
      if(!save) return [];
      const attack = this.attackRoll;
      const targets = this.targets.filter(t => hitsAC(attack, t.ac));
      return buildRows(this.parent, {
        targets,
        hasSave : true,
        abilities : this.rider.ability ? [this.rider.ability] : [...(save.save?.ability ?? [])],
        dc : Number.isFinite(this.rider.dc) ? this.rider.dc : save.save?.dc?.value,
        onSave : this.rider.onSave,
        hasRolls : this.riderRolls.length > 0,
        bonus : save.save?.bonus ?? "",
        effects : effectsOf(save),
      });
    }

    async _prepareRiderContext(options){
      const save = this.riderActivity;
      const visible = this.parent.isContentVisible;
      const rolls = this.riderRolls;

      const ability = CONFIG.DND5E.abilities[this.rider.ability]?.label ?? "";
      const dc = this.rider.dc;
      const label = (this.parent.shouldDisplayChallenge && Number.isFinite(dc))
        ? game.i18n.format("DND5E.SavingThrowDC", { ability, dc })
        : game.i18n.format("DND5E.SavePromptTitle", { ability });

      /* Save results as lines on this card (dnd5e "Chat Card Summary") */
      let summaries = [];
      if(game.settings.get("dnd5e", "chatCardSummary")){
        summaries = (await Promise.all(this.parent.getAssociatedRolls("save")
          .filter(m => m.visible)
          .map(async m => ({ html : await m.system.render({ summary : true }), id : m.id, token : m.getAssociatedToken() }))))
          .filter(s => s.html);
      }

      return {
        name : save?.name || game.i18n.localize("DND5E.SavingThrow"),
        label,
        /* Faded when the attack is known to have missed, the GM can still use it */
        miss : visible && !rollItem.isHit(this.attackRoll),
        hasDamage : rolls.length > 0,
        damage : rolls.length ? { ...damageContext(this.parent, rolls, { hidden : hidesNumbers(this.parent) }), showTray : this.canApply && rollItem.isHit(this.attackRoll) } : null,
        summaries,
        rows : this.riderRows(),
        /* The rows apply the save's effects (Apply effect, GM) : no tray, which would use the GM's selection */
        effects : [],
      };
    }

    /* ---------- Actions ---------- */

    /** @this {RollItemMessageData} */
    static async #rerollAttack(event, target){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      if(!activity) return;
      target.disabled = true;

      const mode = await rollItem.chooseMode(activity, event);
      if(!mode) return target.disabled = false;

      /* Multi : every ray again, damage follows the new hits */
      if(this.isMulti){
        const replaced = new Map();
        for(const i of this.rays.keys()){
          const ray = await rollItem.rollRay(activity, event, i, this.rayTarget(i), { attackMode : this.rays[i].mode || undefined, disadvantage : this.rays[i].why || this.rays[i].disadvantage, mode });
          if(!ray) return target.disabled = false;
          replaced.set(i, ray);
        }
        return replaceRolls(this.parent, { rolls : this.withRays(replaced), shown : [...replaced.values()].flat() });
      }

      const attack = await rollItem.rollAttack(activity, event, {
        ability : this.ability ?? undefined,
        attackMode : this.mode ?? undefined,
        ...(this.disadvantage ? { disadvantage : true } : {}),
        [module.id] : {
          ...(this.targets.length === 1 ? { target : this.targets[0].token } : {}),
          ...(this.disadvantage ? { reasons : [{ mode : "disadvantage", reason : rollItem.disadvantageReason(this.disadvantageWhy || true) }] } : {}),
        },
      }, mode);
      if(!attack) return target.disabled = false;

      /* Cleave's extra attack stays one, and Graze follows the new attack */
      if(this.attackRoll?.options?.[module.id]?.noMod) attack.options[module.id] = { ...(attack.options[module.id] ?? {}), noMod : true };
      const graze = tag(await masteries.grazeRolls(activity, attack, this.damageRolls), { part : "graze" });

      const { ability, ammunition, attackMode, mastery } = attack.options;
      await replaceRolls(this.parent, {
        rolls : [attack, ...this.damageRolls, ...graze, ...this.riderRolls],
        shown : [attack],
        system : { ability, ammunition, mastery, mode : attackMode },
      });
    }

    /** @this {RollItemMessageData} */
    static async #rerollDamage(event, target){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      if(!activity) return;
      target.disabled = true;

      /* Multi : new damage for every ray, attacks stay */
      if(this.isMulti){
        const replaced = new Map(), shown = [];
        for(const i of this.rays.keys()){
          const attack = this.rayAttack(i);
          const damage = tag(await rollItem.rollDamage(activity, attack), { ray : i });
          replaced.set(i, [attack, ...damage, ...this.rayDamage(i, "graze"), ...this.rayDamage(i, "extra")]);
          shown.push(...damage);
        }
        if(!shown.length) return target.disabled = false;
        return replaceRolls(this.parent, { rolls : this.withRays(replaced), shown });
      }

      const damage = await rollItem.rollDamage(activity, this.attackRoll);
      if(!damage.length) return target.disabled = false;

      await replaceRolls(this.parent, { rolls : [this.attackRoll, ...damage, ...this.grazeRolls, ...this.extraRolls(null), ...this.riderRolls], shown : damage });
    }

    /** @this {RollItemMessageData} */
    static async #rerollRiderDamage(event, target){
      const save = this.riderActivity;
      if(!save) return;
      target.disabled = true;

      const damage = tag(await rollItem.rollDamage(save, null), { part : "save" });
      if(!damage.length) return target.disabled = false;
      await replaceRolls(this.parent, { rolls : [this.attackRoll, ...this.damageRolls, ...this.grazeRolls, ...this.extraRolls(null), ...damage], shown : damage });
    }

    /**
     * Same as dnd5e's save button : each clicking user rolls for the targets they own (the GM for NPCs),
     * falling back to their selected tokens, then their character. Results link back to this card.
     * @this {RollItemMessageData}
     */
    static async #rollRiderSave(event, target){
      const save = this.riderActivity;
      if(!save) return;

      let tokens = this.targets.map(t => TargetsField.resolve(t).token).filter(t => t?.actor?.isOwner);
      if(!tokens.length) tokens = (canvas.tokens?.controlled ?? []).filter(t => t.actor?.isOwner);
      const rollers = tokens.length
        ? tokens.map(token => ({ actor : token.actor, token }))
        : (game.user.character ? [{ actor : game.user.character }] : []);
      if(!rollers.length) return ui.notifications.warn("DND5E.ActionWarningNoToken", { localize : true });

      const bonus = CONFIG.Dice.BasicRoll.replaceFormulaData(save.save.bonus ?? "", save.getRollData(), { missing : 0 });
      const bonusData = CONFIG.Dice.BasicRoll.constructParts({ activityBonus : bonus });

      target.disabled = true;
      try {
        for(const { actor, token } of rollers){
          const speaker = ChatMessage.implementation.getSpeaker({ actor, scene : canvas.scene, token : token?.document });
          const rollData = {
            event,
            ability : this.rider.ability || save.save.ability.first(),
            target : Number.isFinite(this.rider.dc) ? this.rider.dc : save.save.dc.value,
          };
          if(bonusData.parts.length) rollData.rolls = [bonusData];
          await actor.rollSavingThrow(rollData, {}, { data : { speaker, system : { ...save.messageSources, origin : this.parent.id } } });
        }
      } finally {
        target.disabled = false;
      }
    }

    /* A button an item macro added (macro-helper.cardButtons) : tell it it was clicked (macro-helper.cardButton) */
    /** @this {RollItemMessageData} */
    static async #cardButton(event, target){
      const ray = (target.dataset.ray === "" || target.dataset.ray === undefined) ? null : Number(target.dataset.ray);
      Hooks.callAll(`${module.id}.cardButton`, this.parent, target.dataset.id, { ray, event });
    }

    /* The on-hit save, from a row (rollRowSave / applyRow) */
    /** @this {RollItemMessageData} */
    /** @this {RollItemMessageData} */
    static async #setCover(event, target){
      await setCover(this.parent, target.dataset.target, target.dataset.level, { attack : true });
    }

    static async #rowSave(event, target){
      const save = this.riderActivity;
      if(!save) return;
      await rollRowSave(this.parent, event, target, { activity : save, dc : Number.isFinite(this.rider.dc) ? this.rider.dc : save.save?.dc?.value, targets : this.targets });
    }

    /** @this {RollItemMessageData} */
    static async #rowApply(event, target){
      await applyRow(this.parent, target, { rolls : this.riderRolls, targets : this.targets });
    }

    /* The mastery button : data-ray is the attack on a multi card, empty for a single attack */
    /** @this {RollItemMessageData} */
    static async #useMastery(event, target){
      const ray = (target.dataset.ray === "" || target.dataset.ray === undefined) ? null : Number(target.dataset.ray);
      target.disabled = true;
      try { await masteries.use(this.parent, ray, event); }
      catch(error){
        console.error("Macro Helper | mastery", error);
        ui.notifications.warn(error.message);
      }
      finally { target.disabled = this.masteryUsed(ray); }
    }

    /** @this {RollItemMessageData} */
    static async #rerollRay(event, target){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      const index = Number(target.dataset.ray);
      if(!activity || !this.rays[index]) return;
      target.disabled = true;

      const mode = await rollItem.chooseMode(activity, event);
      if(!mode) return target.disabled = false;
      const ray = await rollItem.rollRay(activity, event, index, this.rayTarget(index), { attackMode : this.rays[index].mode || undefined, disadvantage : this.rays[index].why || this.rays[index].disadvantage, mode });
      if(!ray) return target.disabled = false;
      await replaceRolls(this.parent, { rolls : this.withRays(new Map([[index, ray]])), shown : ray });
    }

    /* Every ray that hit onto its own target, rays without a target go to the selected tokens. Misses with Graze deal that. */
    /** @this {RollItemMessageData} */
    static async #applyHits(event, target){
      const byActor = new Map();
      for(const i of this.rays.keys()){
        const hit = rollItem.isHit(this.rayAttack(i));
        let rolls = hit ? this.rayDamage(i) : (masteries.enabled() ? this.rayDamage(i, "graze") : []);
        if(hit){
          const choice = this.choiceOf(i);
          const extras = this.extraRolls(i);
          if(choice && (choice !== "base")) rolls = extras.filter(r => tagOf(r).key === choice);
          rolls = [...rolls, ...extras.filter(r => !tagOf(r).alternative)];
        }
        if(!rolls.length) continue;
        for(const actor of this.rayActors(i)){
          byActor.set(actor, [...(byActor.get(actor) ?? []), ...rolls]);
        }
      }
      if(!byActor.size) return ui.notifications.warn("rollItem.apply.noTarget", { localize : true });

      target.disabled = true;
      for(const [actor, rolls] of byActor) await this.applyRolls(actor, rolls);
      target.disabled = false;
    }
  }

  /**
   * Save / heal / damage : dnd5e's usage card (header, description, targets, save buttons, save summaries, effects)
   * with the damage (or healing) already rolled onto it, and a damage tray that knows who saved.
   * Damage-only activities can roll several instances (Magic Missile darts), each with its own target and tray.
   */
  class RollItemSaveData extends UsageMessageData{
    static metadata = Object.freeze(foundry.utils.mergeObject(super.metadata, {
      template : `${module.path}/templates/save-card.hbs`,
      actions : {
        rerollDamage : RollItemSaveData.#rerollDamage,
        rerollRay : RollItemSaveData.#rerollRay,
        applyRays : RollItemSaveData.#applyRays,
        rerollFormula : RollItemSaveData.#rerollFormula,
        shove : RollItemSaveData.#shove,
        rowSave : RollItemSaveData.#rowSave,
        rowApply : RollItemSaveData.#rowApply,
        setCover : RollItemSaveData.#setCover,
        rowReroll : rowReroll,
        rowLucky : rowLucky,
        rowInspire : rowInspire,
        rowEffect : RowEffect,
      },
    }, { inplace : false }));

    static defineSchema(){
      const { ArrayField, SchemaField, StringField } = foundry.data.fields;
      return {
        ...super.defineSchema(),
        onSave : new StringField({ blank : false, initial : null, nullable : true, required : false }),
        /* One entry per damage instance when rolling more than one (Magic Missile), target is a token uuid */
        rays : new ArrayField(new SchemaField({
          target : new StringField({ blank : true, initial : "" }),
        })),
      };
    }

    get canApplyDamage(){
      return true;
    }

    /**
     * dnd5e's damage tray reads save outcomes from message.system.origin.system.outcomes.
     * On a normal usage the damage is its own message whose origin is the usage card; here they are the same card.
     */
    get origin(){
      return game.messages.has(this.parent.id) ? this.parent : null;
    }

    get isMulti(){
      return this.rays.length > 1;
    }

    get damageRolls(){
      return this.parent.rolls.filter(r => r instanceof DamageRoll);
    }

    rayDamage(index){
      return this.damageRolls.filter(r => tagOf(r).ray === index);
    }

    /* A utility activity's roll formula, rolled onto the card */
    get formulaRolls(){
      return this.parent.rolls.filter(r => tagOf(r).part === "formula");
    }

    async _prepareFormulaContext(){
      const [roll] = this.formulaRolls;
      if(!roll) return null;
      const activity = this.parent.getAssociatedActivity();
      return {
        label : activity?.roll?.name || game.i18n.localize("DND5E.Roll"),
        html : await roll.render({ template : ROLL_TEMPLATE, isPrivate : !this.parent.isContentVisible }),
      };
    }

    rayTarget(index){
      const uuid = this.rays[index]?.target;
      return uuid ? this.targets.find(t => t.token === uuid) ?? null : null;
    }

    /* ---------- One row per target (shared buildRows) ---------- */

    saveResults(){
      return saveResultsOf(this.parent);
    }

    targetRows(){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      const hasSave = activity?.type === "save";
      return buildRows(this.parent, {
        targets : this.targets,
        hasSave,
        abilities : hasSave ? [...(activity.save?.ability ?? [])] : [],
        dc : activity?.save?.dc?.value,
        onSave : this.onSave ?? activity?.damage?.onSave,
        hasRolls : this.damageRolls.length > 0,
        isHeal : activity?.type === "heal",
        bonus : activity?.save?.bonus ?? "",
        effects : hasSave ? effectsOf(activity) : [],
      });
    }

    /* The abilities this card's saves use (automatic failures) */
    get saveAbilities(){
      const activity = this.parent.getAssociatedActivity();
      return (activity?.type === "save") ? [...(activity.save?.ability ?? [])] : [];
    }

    /* Save outcomes for dnd5e's trays (and Shove's buttons) : read fresh, automatic failures fail */
    get outcomes(){
      return outcomesOf(this.parent);
    }

    async _prepareContext(options){
      const context = await super._prepareContext(options);
      if(context.content) return context;
      context.cover = coverContext(this.parent, this.parent.getAssociatedActivity()?.type === "save" ? this.targets : []);
      context.note = this.parent.getFlag(module.id, "note") ?? null;

      context.formula = await this._prepareFormulaContext();

      if(this.isMulti){
        const visible = this.parent.isContentVisible;
        const canReroll = this.parent.isOwner && visible;
        const canApply = visible && (game.user.isGM || dnd5e.settings.allowPlayerDamageTray);
        context.rays = this.rays.map((_, i) => {
          const damage = this.rayDamage(i);
          return {
            index : i,
            number : i + 1,
            canReroll,
            target : visible ? this.rayTarget(i) : null,
            damage : damageContext(this.parent, damage),
            showTray : canApply && damage.length > 0,
          };
        });
        return context;
      }

      const damage = this.damageRolls;
      if(damage.length) context.damage = damageContext(this.parent, damage, { hidden : hidesNumbers(this.parent) });

      /* A row per target replaces dnd5e's single save button summary and tray : each target saves and takes its own */
      context.rows = this.targetRows();
      if(context.rows.length){
        if(context.damage) context.damage.showTray = false;
        if(this.parent.getAssociatedActivity()?.type === "save") context.effects = [];
        context.summaries = [];
        /* dnd5e's own save button rolls for everyone through its dialog : the rows replace it */
        if(context.buttonGroups){
          delete context.buttonGroups.rollSave;
          if(foundry.utils.isEmpty(context.buttonGroups)) delete context.buttonGroups;
        }
      }

      /* Shove : Prone or Push 5 ft for each target that failed its save */
      context.shove = maneuvers.shoveContext(this.parent);

      return context;
    }

    /* Re-roll one instance's damage, tagged with its index */
    async _rollRay(activity, index){
      return tag(await rollItem.rollDamage(activity, null), { ray : index });
    }

    /** @this {RollItemSaveData} */
    static async #rerollDamage(event, target){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      if(!activity) return;
      target.disabled = true;

      const keep = this.parent.rolls.filter(r => !(r instanceof DamageRoll));
      const damage = [];
      if(this.isMulti) for(const i of this.rays.keys()) damage.push(...await this._rollRay(activity, i));
      else damage.push(...await rollItem.rollDamage(activity, null));
      if(!damage.length) return target.disabled = false;

      await replaceRolls(this.parent, { rolls : [...keep, ...damage], shown : damage });
    }

    /** @this {RollItemSaveData} */
    static async #rerollRay(event, target){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      const index = Number(target.dataset.ray);
      if(!activity || !this.rays[index]) return;
      target.disabled = true;

      const damage = await this._rollRay(activity, index);
      if(!damage.length) return target.disabled = false;
      const rolls = this.parent.rolls.filter(r => !(r instanceof DamageRoll) || tagOf(r).ray !== index);
      await replaceRolls(this.parent, { rolls : [...rolls, ...damage], shown : damage });
    }

    /** @this {RollItemSaveData} */
    static async #rerollFormula(event, target){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      if(!activity) return;
      target.disabled = true;

      const rolls = tag(await rollItem.rollFormula(activity), { part : "formula" });
      if(!rolls.length) return target.disabled = false;
      const keep = this.parent.rolls.filter(r => tagOf(r).part !== "formula");
      await replaceRolls(this.parent, { rolls : [...keep, ...rolls], shown : rolls });
    }

    /* A target's save, from its row (rollRowSave) */
    /** @this {RollItemSaveData} */
    /** @this {RollItemSaveData} */
    static async #setCover(event, target){
      await setCover(this.parent, target.dataset.target, target.dataset.level);
    }

    static async #rowSave(event, target){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      if(!activity?.save) return;
      await rollRowSave(this.parent, event, target, { activity, dc : activity.save.dc?.value, targets : this.targets });
    }

    /* A target's damage / healing, from its row (applyRow) */
    /** @this {RollItemSaveData} */
    static async #rowApply(event, target){
      await applyRow(this.parent, target, { rolls : this.damageRolls, targets : this.targets });
    }

    /* Shove's choice for one target : data-target is its token uuid, data-choice "prone" or "push" */
    /** @this {RollItemSaveData} */
    static async #shove(event, target){
      const { target : uuid, choice } = target.dataset;
      target.disabled = true;
      try { await maneuvers.shove(this.parent, uuid, choice); }
      catch(error){
        console.error("Macro Helper | Shove", error);
        ui.notifications.warn(error.message);
        target.disabled = false;
      }
    }

    /* Each instance onto its own target, instances without a target go to the selected tokens */
    /** @this {RollItemSaveData} */
    static async #applyRays(event, target){
      const byActor = new Map();
      for(const i of this.rays.keys()){
        for(const actor of targetActors(this.rayTarget(i))){
          byActor.set(actor, [...(byActor.get(actor) ?? []), ...this.rayDamage(i)]);
        }
      }
      if(!byActor.size) return ui.notifications.warn("rollItem.apply.noTarget", { localize : true });

      target.disabled = true;
      for(const [actor, rolls] of byActor) await applyDamageRolls(this.parent, actor, rolls);
      target.disabled = false;
    }
  }

  CONFIG.ChatMessage.dataModels[TYPES.attack] = RollItemMessageData;
  CONFIG.ChatMessage.dataModels[TYPES.save] = RollItemSaveData;

  /* Our cards grow after they're posted (damage after the attack, rerolls, save results) : keep the chat log at the
     bottom if it was there, once the new card is in place. Someone scrolled up reading older messages stays put. */
  const ours = new Set(Object.values(TYPES));

  /* A save rolled from one of our cards : redraw the card (its rows show the result) */
  Hooks.on("createChatMessage", message => {
    const card = originOf(message);
    if(card && ours.has(card.type)) ui.chat?.updateMessage(card);
  });

  /* A save rerolled or Lucky'd (rerolls.js) : the card re-reads it, so redraw it. For a private NPC save (DM screen)
     the GM's recorded pass / fail on the card follows the new roll. */
  Hooks.on("updateChatMessage", async (message, changes) => {
    if(!("rolls" in (changes ?? {}))) return;
    const card = originOf(message);
    if(!card || !ours.has(card.type)) return;
    const [roll] = message.rolls ?? [];
    const uuid = message.getAssociatedToken?.()?.uuid;
    const key = uuid ? `saves.${uuidKey(uuid)}` : null;
    if(game.user.isGM && key && card.getFlag(module.id, key) && Number.isFinite(roll?.options?.target)){
      await card.setFlag(module.id, key, { success : roll.total >= roll.options.target });
    }
    ui.chat?.updateMessage(card);
  });
  /* Collapse Card Descriptions (GM) : every card's description starts folded for everyone, as dnd5e's own client
     setting does it (click the card's title to open it) */
  Hooks.on("dnd5e.renderChatMessage", (message, html) => {
    if(!settings.value("collapseCards")) return;
    html.querySelectorAll(".card-header, .card-description, .description.collapsible").forEach(el => el.classList.add("collapsed"));
  });

  /* A note the module put on a dnd5e card (Help : who, which skill) : shown under its description */
  Hooks.on("dnd5e.renderChatMessage", (message, html) => {
    const note = message.getFlag?.(module.id, "note");
    if(!note || ours.has(message.type) || html.querySelector(`.${module.id}-note`)) return;
    const p = document.createElement("p");
    p.className = `supplement ${module.id}-note`;
    p.innerHTML = `<strong>${foundry.utils.escapeHTML(note)}</strong>`;
    const anchor = html.querySelector(".card-content, .description, .card-header");
    if(anchor) anchor.after(p);
    else (html.querySelector(".chat-card") ?? html.querySelector(".message-content") ?? html).append(p);
  });

  /* Damage / healing applied from a card (conditions.onApplyDamage notes it on the creature) : show it on its row */
  Hooks.on("updateActor", (actor, changes) => {
    const applied = foundry.utils.getProperty(changes ?? {}, `flags.${module.id}.applied`) ?? {};
    for(const id of Object.keys(applied)){
      const card = game.messages.get(id);
      if(card && ours.has(card.type)) ui.chat?.updateMessage(card);
    }
  });

  /* Each part of a card (its rows, its hits, dnd5e's damage tray) applies once to each creature : a second click
     would deal the damage again. A rerolled card's damage is applied by hand. */
  Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options = {}) => {
    const card = options.origin;
    if(!card?.id || !ours.has(card.type)) return;
    const part = options[module.id]?.part ?? "tray";
    if(!Number.isFinite(actor.getFlag?.(module.id, `applied.${card.id}.${part}`))) return;
    ui.notifications.warn(module.format("rollItem.apply.already", { name : actor.name }));
    return false;
  });
  Hooks.on("renderChatMessageHTML", message => {
    if(!ours.has(message.type) || !ui.chat?.isAtBottom) return;
    requestAnimationFrame(()=> ui.chat.scrollBottom({ popout : true }));
  });
}
