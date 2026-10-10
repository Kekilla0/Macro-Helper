import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { gm } from '../../gm.js';
import { idOf, chooseOption, whisperOwners, waitFor, originItem } from '../../helpers/utils.js';
import { pickTargets } from '../../helpers/targets.js';
import { tokenOf, pushAway } from '../../helpers/tokens.js';
import { uses } from '../../uses.js';
import { ranger } from './ranger.js';
import { TYPES } from '../../roll-item/message.js';
import { pacts } from './warlock-pacts.js';
import { restChoices } from '../rest-choices.js';
import { chooseOne } from '../../helpers/creatures.js';
import { limits } from '../limits.js';
import { patch } from '../../patch.js';
const log = logger.for(import.meta.url);

/**
 * Warlock, levels 1-2 (Classes setting). Pact Magic's slots and Magical Cunning (half the Pact slots back, once a Long
 * Rest) are the items' own data; changing a prepared spell on a level is Prepared Spells. Works from item identifiers,
 * whoever made them (none of Hex's own activities are used). The pacts (Blade, Chain, Tome) are warlock-pacts.js.
 *
 *   Hex             : Hunter's Mark's handling (ranger.js), plus the curse's ability : using the spell asks for a slot,
 *                     the ability whose checks get disadvantage, and the creature (90 ft). The Warlock concentrates at
 *                     once; the GM's button curses the creature (an effect : disadvantage on that ability's checks; its
 *                     data : flags["macro-helper"].hex = { caster, spell, ability }). Every attack at it rolls 1d6
 *                     Necrotic onto the card (its Apply on a hit; doubled on a crit). The curse ends with the
 *                     Concentration; a new casting moves it; the creature at 0 HP : Hex again moves it (no slot).
 *                     2024 durations : 1 hour; a level 2 slot 4 hours; 3-4 8 hours; 5+ 24 hours.
 *   Invocations on a cantrip (Agonizing Blast, Repelling Blast, Eldritch Spear) : picking the invocation asks which of
 *                     your known Warlock cantrips it goes on (Agonizing : one that deals damage; Repelling : one with an
 *                     attack roll; Spear : damage and a range of 10 ft or more), and puts the invocation's enchantment
 *                     on it (Plutonium's : Agonizing adds CHA to its damage, Spear its range). One without a cantrip
 *                     yet : Rest Choices' Invocation Cantrips row.
 *   Devil's Sight   : a sense of its own on the token (the "Devil's Sight" detection mode, 120 ft) : sight that isn't
 *                     stopped by darkness, magical or not (darkness sources), within its range; walls still block it,
 *                     and an Invisible creature still isn't seen. Vision Rules (canSee) count it like any sense.
 *   Magical Cunning : with no Pact slot spent, nothing would come back : Rule Limits (its use would be wasted).
 *   Repelling Blast : each hit of its cantrip (Eldritch Blast when none is chosen) on a Large or smaller creature : the
 *                     GM's button pushes it 10 ft away.
 */
export class warlock{
  static HEX = "hex";
  static BLAST = "eldritch-blast";
  static AGONIZING = "agonizing-blast";
  static REPELLING = "repelling-blast";
  static RANGE = 90;
  /* Invocations put on one of the Warlock's cantrips : what the cantrip must have */
  static ON_CANTRIP = { "agonizing-blast" : "damage", "repelling-blast" : "attack", "eldritch-spear" : "spear" };
  static PUSHABLE = ["tiny", "sm", "med", "lg"];
  static ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    /* Pact of the Blade, Chain, Tome : warlock-pacts.js */
    pacts.register();
    uses.onItem("hex", (item, ctx, next) => {
      if(!this.enabled() || (item?.type !== "spell") || (idOf(item) !== this.HEX) || !item.actor) return next();
      return this.useHex(item.actor, item);
    });
    gm.handle("hex", (data, user) => this.applyHex(data, user));
    Hooks.on("createChatMessage", (message, options, userId) => { if(userId === game.user.id) this.onAttackCard(message); });
    Hooks.on("deleteActiveEffect", effect => this.onConcentrationEnd(effect));
    Hooks.on("updateActor", (actor, changes) => this.onDown(actor, changes));
    /* Devil's Sight : its detection mode, and on the tokens of creatures that have it */
    Hooks.once("setup", () => {
      warlock.registerDevilsSight();
      patch.wrap("CONFIG.Token.documentClass.prototype._prepareDetectionModes", function(wrapped, ...args){
        try { if(warlock.enabled() && this.actor?.items?.some?.(i => idOf(i) === warlock.DEVILS_SIGHT)) this.detectionModes.devilsSight ??= { enabled : true, range : warlock.DEVILS_RANGE }; }
        catch(error){ log.debug("Devil's Sight", error); }
        return wrapped(...args);
      });
    });
    /* Magical Cunning with every Pact slot there : nothing to regain */
    Hooks.on("dnd5e.preUseActivity", activity => this.cunningCheck(activity));
    /* An invocation put on a cantrip : which one, as it's picked */
    Hooks.on("createItem", (item, options, userId) => { if(userId === game.user.id) this.onInvocationAdded(item); });
    restChoices.add({
      id : "invocationCantrips", label : "restChoices.invocationCantrips", rest : "level", classes : ["warlock"],
      applies : actor => this.enabled() && this.cantripInvocations(actor).length > 0,
      grant : actor => actor.setFlag(module.id, "cantripSwaps", 1),
      summary : actor => this.cantripSummary(actor),
      open : actor => this.chooseCantrips(actor),
    });
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, context) => this.repelButtons(message, buttons, context));
    Hooks.on(`${module.id}.cardButton`, (message, id, context) => { if(id?.startsWith?.("repel|")) this.repel(message, id.split("|")[1], context?.ray ?? null); });
  }

  /* ---------- Hex ---------- */

  /* The Hex this caster has out now : { effect, token } */
  static hexOf(caster){
    for(const token of canvas.tokens?.placeables ?? []){
      const effect = token.actor?.effects?.find?.(e => e.getFlag(module.id, "hex")?.caster === caster.uuid);
      if(effect) return { effect, token };
    }
    return null;
  }

  static async useHex(actor, spell){
    const current = this.hexOf(actor);
    const down = current && ((Number(current.token.actor.system?.attributes?.hp?.value) || 0) <= 0);
    if(current && down && ranger.concentrationOf(actor, spell)) return this.placeHex(actor, spell, { move : current, ability : current.effect.getFlag(module.id, "hex").ability });
    /* A slot (Hex has no free castings : Hunter's Mark's payments without Favored Enemy) */
    const payments = ranger.payments(actor).filter(p => !p.free);
    if(!payments.length){
      ui.notifications.warn(module.format("classes.ranger.noPay", { name : actor.name, spell : spell.name }));
      return null;
    }
    const value = await chooseOption({ title : spell.name, icon : "fa-solid fa-skull", prompt : module.i18n("classes.ranger.payPrompt"), options : payments });
    const pay = payments.find(p => p.value === value);
    if(!pay) return null;
    const ability = await chooseOption({ title : spell.name, icon : "fa-solid fa-skull", prompt : module.i18n("classes.warlock.hexAbility"),
      options : this.ABILITIES.map(a => ({ value : a, label : CONFIG.DND5E.abilities[a]?.label ?? a })) });
    if(!ability) return null;
    return this.placeHex(actor, spell, { pay, ability });
  }

  static async placeHex(actor, spell, { pay = null, move = null, ability } = {}){
    const [target] = await pickTargets(tokenOf(actor) ?? spell, { count : 1, range : this.RANGE, disposition : "enemy", useTargets : false, confirm : "auto",
      filter : t => !move || (t.id !== move.token.id) });
    if(!target) return null;
    if(pay){
      await actor.update({ [`system.spells.${pay.key}.value`] : Math.max(0, Number(actor.system.spells[pay.key].value) - 1) });
      await ranger.concentrate(actor, spell, pay.level ?? 1, { hours : this.hoursFor(pay.level ?? 1) });
    }
    const label = CONFIG.DND5E.abilities[ability]?.label ?? ability;
    await gm.ask("hex", { caster : actor.uuid, spell : spell.uuid, target : target.document.uuid, from : move?.effect.uuid ?? null, ability,
      hours : this.hoursFor(pay?.level ?? 1) }, { actor,
      text : module.format(move ? "classes.warlock.hexMoved" : "classes.warlock.hexed", { name : actor.name, target : target.name, ability : label }),
      label : module.format("classes.warlock.hexButton", { target : target.name }) });
    log.debug("Hex", actor.name, target.name, ability, move ? "moved" : pay?.value);
    return true;
  }

  /* 2024 Hex : 1 hour; a level 2 slot 4 hours; 3-4 8 hours; 5+ 24 hours */
  static hoursFor(level){
    return (level >= 5) ? 24 : (level >= 3) ? 8 : (level >= 2) ? 4 : 1;
  }

  /* GM : the curse on the creature (moved : off the old one first) */
  static async applyHex({ caster : casterUuid, spell : spellUuid, target : targetUuid, from = null, ability = "str", hours = 1 } = {}, user){
    const caster = fromUuidSync(casterUuid ?? "", { strict : false });
    const target = fromUuidSync(targetUuid ?? "", { strict : false });
    const spell = fromUuidSync(spellUuid ?? "", { strict : false });
    if(!game.user.isGM || !caster || !target?.actor || (user && !caster.testUserPermission(user, "OWNER"))) return false;
    if(!ranger.concentrationOf(caster, spell)){
      ui.notifications.warn(module.format("classes.ranger.noConcentration", { name : caster.name, spell : spell?.name ?? "" }));
      return false;
    }
    if(from){
      const old = fromUuidSync(from, { strict : false });
      if(old?.getFlag?.(module.id, "hex")?.caster === caster.uuid) await old.delete();
    }
    else {
      /* A new casting : any curse of this caster's elsewhere goes */
      for(const t of canvas.tokens?.placeables ?? []){
        for(const e of t.actor?.effects?.filter?.(x => x.getFlag(module.id, "hex")?.caster === caster.uuid) ?? []) await e.delete();
      }
    }
    await target.actor.createEmbeddedDocuments("ActiveEffect", [{
      name : module.format("classes.warlock.hexName", { spell : spell?.name ?? "Hex", name : caster.name, ability : CONFIG.DND5E.abilities[ability]?.label ?? ability }),
      img : spell?.img ?? "icons/svg/skull.svg", origin : spellUuid, duration : { value : hours * 3600, units : "seconds" }, start : { time : game.time.worldTime },
      showIcon : CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2,
      changes : [{ key : `system.abilities.${ability}.check.roll.mode`, type : "add", mode : 2, value : "-1" }],
      flags : { [module.id] : { hex : { caster : caster.uuid, spell : spellUuid, ability } } },
    }]);
    return true;
  }

  static hexedBy(token, attacker){
    return token?.actor?.effects?.find?.(e => e.getFlag(module.id, "hex")?.caster === attacker?.uuid) ?? null;
  }

  /* A new attack card : 1d6 Necrotic on every attack at the Warlock's hexed creature (its Apply on a hit) */
  static async onAttackCard(message){
    if(!this.enabled() || (message.type !== TYPES.attack)) return;
    const attacker = message.getAssociatedActor?.();
    if(!attacker || !this.hexOf(attacker)) return;
    if(message.getFlag(module.id, "reveal") !== undefined){
      await waitFor(() => (game.messages.get(message.id)?.getFlag(module.id, "reveal") ?? 2) >= 2, { timeout : 15000 });
      message = game.messages.get(message.id) ?? message;
    }
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    const rays = message.system.isMulti ? message.system.rays.map((_, i) => i) : [null];
    for(const ray of rays){
      const hexed = (message.system.targetsOf?.(ray) ?? []).some(t => this.hexedBy(TargetsField.resolve(t)?.token, attacker));
      if(!hexed || message.system.extraRolls(ray, "hex").length) continue;
      const isCritical = !!message.system.attackOf(ray)?.isCritical;
      const roll = await new CONFIG.Dice.DamageRoll("1d6", {}, { type : "necrotic", types : ["necrotic"], isCritical, properties : ["mgc"] }).evaluate();
      await message.system.addDamage([roll], { key : "hex", ray, label : "Hex", onHit : true, formula : "1d6" });
    }
  }

  static async onConcentrationEnd(effect){
    if(!game.users.activeGM?.isSelf || !effect?.statuses?.has?.(CONFIG.specialStatusEffects.CONCENTRATING)) return;
    const item = fromUuidSync(effect.getFlag("dnd5e", "item")?.uuid ?? "", { strict : false });
    if((idOf(item) !== this.HEX) || (effect.parent?.documentName !== "Actor")) return;
    const hex = this.hexOf(effect.parent);
    if(hex) await hex.effect.delete();
  }

  static async onDown(actor, changes){
    if(!game.users.activeGM?.isSelf || !foundry.utils.hasProperty(changes ?? {}, "system.attributes.hp.value")) return;
    if((Number(actor.system?.attributes?.hp?.value) || 0) > 0) return;
    const hex = actor.effects?.find?.(e => e.getFlag(module.id, "hex"));
    const caster = hex && fromUuidSync(hex.getFlag(module.id, "hex").caster, { strict : false });
    if(caster) await whisperOwners(caster, module.format("classes.ranger.down", { target : actor.name, spell : "Hex" }));
  }

  /* ---------- Devil's Sight ---------- */

  static DEVILS_SIGHT = "devils-sight";
  static DEVILS_RANGE = 120;

  /* Sight that darkness doesn't stop : basic sight's rules (Blinded, Invisible, walls), minus darkness (a darkness
     source around the viewer, or between it and the target) */
  static registerDevilsSight(){
    const Base = foundry.canvas?.perception?.DetectionMode;
    if(!Base || CONFIG.Canvas.detectionModes.devilsSight) return;
    class DetectionModeDevilsSight extends Base{
      _canDetect(visionSource, target){
        const src = visionSource.object.document;
        if(src.hasStatusEffect(CONFIG.specialStatusEffects.BLIND) || src.hasStatusEffect(CONFIG.specialStatusEffects.BURROW)) return false;
        const tgt = target?.document;
        if(tgt?.hasStatusEffect && (tgt.hasStatusEffect(CONFIG.specialStatusEffects.INVISIBLE) || tgt.hasStatusEffect(CONFIG.specialStatusEffects.BURROW))) return false;
        return true;
      }
      _testLOS(visionSource, mode, target, test){
        return !CONFIG.Canvas.polygonBackends.sight.testCollision({ x : visionSource.x, y : visionSource.y }, test.point,
          { type : "sight", mode : "any", source : visionSource, edgeTypes : { source : false } });
      }
    }
    CONFIG.Canvas.detectionModes.devilsSight = new DetectionModeDevilsSight({
      id : "devilsSight", label : "classes.warlock.devilsSight", type : Base.DETECTION_TYPES.SIGHT, walls : true, angle : true, tokenConfig : true });
  }

  /* ---------- Magical Cunning ---------- */

  static cunningCheck(activity){
    if(!this.enabled() || (idOf(activity?.item) !== "magical-cunning") || !activity.actor) return;
    const pact = activity.actor.system?.spells?.pact;
    if(!(Number(pact?.max) > 0) || (Number(pact.value) < Number(pact.max))) return;
    if(!limits.allow(module.format("classes.warlock.cunningFull", { name : activity.actor.name }), { who : activity.actor.name, what : activity.item.name })) return false;
  }

  /* ---------- Invocations on a cantrip ---------- */

  /* The Warlock's invocations that go on a cantrip */
  static cantripInvocations(actor){
    return actor?.items?.filter?.(i => (i.type === "feat") && this.ON_CANTRIP[idOf(i)]) ?? [];
  }

  /* The cantrip an invocation item is on (its enchantment's origin) */
  static cantripOf(actor, invocation){
    return actor?.items?.find?.(i => (i.type === "spell") && i.effects?.some?.(e => (e.type === "enchantment") && !e.disabled && (originItem(e) === invocation))) ?? null;
  }

  /* A cantrip carrying this kind of invocation (any copy of it) */
  static carries(item, ident){
    return !!item?.effects?.some?.(e => (e.type === "enchantment") && !e.disabled && (idOf(originItem(e)) === ident));
  }

  /* Known Warlock cantrips the invocation can go on (not one already carrying the same invocation) */
  static candidates(actor, invocation){
    const kind = this.ON_CANTRIP[idOf(invocation)];
    const ident = idOf(invocation);
    return actor.items.filter(i => {
      if((i.type !== "spell") || (Number(i.system.level) !== 0) || this.carries(i, ident)) return false;
      const warlock = (String(i.system.sourceItem ?? "") === "class:warlock") || (i.system.classIdentifier === "warlock");
      if(!warlock) return false;
      const acts = [...(i.system.activities ?? [])];
      const damage = acts.some(a => a.damage?.parts?.length);
      if(kind === "attack") return acts.some(a => a.type === "attack");
      if(kind === "spear") return damage && (((i.system.range?.units === "ft") && (Number(i.system.range?.value) >= 10)) || ["mi"].includes(i.system.range?.units));
      return damage;
    });
  }

  /* Put the invocation's enchantment on the cantrip (as dnd5e's card would) */
  static async enchant(invocation, cantrip){
    const activity = invocation.system.activities?.find?.(a => a.type === "enchant");
    const profile = activity?.effects?.[0]?._id;
    const source = (profile && invocation.effects.get(profile)) ?? invocation.effects.find(e => e.type === "enchantment");
    if(!activity || !source) return false;
    const data = foundry.utils.mergeObject(source.toObject(), { origin : activity.uuid, disabled : false, "flags.dnd5e.enchantmentProfile" : profile ?? source.id }, { inplace : false });
    delete data._id;
    await cantrip.createEmbeddedDocuments("ActiveEffect", [data]);
    return true;
  }

  /* Which cantrip it goes on : asked (one choice : taken) */
  static async assign(actor, invocation){
    const options = this.candidates(actor, invocation);
    if(!options.length){
      ui.notifications.warn(module.format("classes.warlock.noCantrip", { name : actor.name, invocation : invocation.name }));
      return null;
    }
    /* Their own names (an enchantment adds to them : "Eldritch Blast, Agonizing") */
    const chosen = (options.length === 1) ? options[0].id : await chooseOne(options.map(c => ({ value : c.id, label : c._source?.name ?? c.name, img : c.img })),
      { title : invocation.name, icon : "fa-solid fa-wand-sparkles", columns : 3, prompt : module.format("classes.warlock.cantripPrompt", { invocation : invocation.name }) });
    const cantrip = chosen ? actor.items.get(chosen) : null;
    if(!cantrip) return null;
    await this.enchant(invocation, cantrip);
    log.debug("Invocation on a cantrip", actor.name, invocation.name, cantrip.name);
    return cantrip;
  }

  /* Picked (added to the character) : which cantrip, once the import has settled */
  static async onInvocationAdded(item){
    const actor = item?.parent;
    if(!this.enabled() || (actor?.documentName !== "Actor") || (item.type !== "feat") || !this.ON_CANTRIP[idOf(item)]) return;
    await new Promise(r => setTimeout(r, 1500));
    if(!actor.items.get(item.id) || this.cantripOf(actor, item)) return;
    await this.assign(actor, item);
  }

  static cantripSummary(actor){
    return this.cantripInvocations(actor).map(i => { const c = this.cantripOf(actor, i); return `${i.name.replace(/^.*?:\s*/, "")} : ${c ? (c._source?.name ?? c.name) : "—"}`; }).join(" · ");
  }

  /* The row : each invocation without a cantrip gets one; all placed : moving one (a Warlock level gained; the GM freely;
     past that, Rule Limits) */
  static async chooseCantrips(actor){
    const open = this.cantripInvocations(actor).filter(i => !this.cantripOf(actor, i));
    if(open.length){
      for(const invocation of open) await this.assign(actor, invocation);
      return;
    }
    const swaps = game.user.isGM ? Infinity : (Number(actor.getFlag(module.id, "cantripSwaps")) || 0);
    if(!(swaps > 0) && !limits.allow(module.i18n("classes.warlock.cantripRule"), { who : actor.name, what : module.i18n("restChoices.invocationCantrips") })) return;
    const invocations = this.cantripInvocations(actor);
    const pick = await chooseOne(invocations.map(i => ({ value : i.id, label : i.name, img : i.img, detail : this.cantripOf(actor, i)?._source?.name ?? "" })),
      { title : module.i18n("restChoices.invocationCantrips"), icon : "fa-solid fa-wand-sparkles", columns : 2, prompt : module.i18n("classes.warlock.cantripMove") });
    const invocation = pick ? actor.items.get(pick) : null;
    if(!invocation) return;
    const old = this.cantripOf(actor, invocation);
    const moved = await this.assign(actor, invocation);
    if(!moved) return;
    const effect = old?.effects?.find?.(e => (e.type === "enchantment") && (originItem(e) === invocation));
    if(effect) await effect.delete();
    if(Number.isFinite(swaps)) await actor.setFlag(module.id, "cantripSwaps", Math.max(0, swaps - 1));
  }

  /* ---------- Repelling Blast ---------- */

  /* Its cantrip's hits : the GM's push (Large or smaller); Eldritch Blast when no cantrip carries it */
  static repelButtons(message, buttons, { ray } = {}){
    if(!game.user.isGM || !this.enabled() || (message.type !== TYPES.attack)) return;
    const actor = message.getAssociatedActor?.();
    const item = message.getAssociatedItem?.();
    if(!actor?.items?.some?.(i => idOf(i) === this.REPELLING)) return;
    const chosen = actor.items.some(i => (i.type === "spell") && this.carries(i, this.REPELLING));
    if(!(chosen ? this.carries(item, this.REPELLING) : (idOf(item) === this.BLAST))) return;
    for(const token of message.system.hitTargets?.(ray) ?? []){
      if(!this.PUSHABLE.includes(token.actor?.system?.traits?.size ?? "med")) continue;
      const key = `repelled.${String(ray ?? "x")}-${token.document.id}`;
      if(message.getFlag(module.id, key)) continue;
      buttons.push({ id : `repel|${token.document.uuid}`, icon : "fa-arrows-left-right", label : module.format("classes.warlock.repel", { name : token.name }) });
    }
  }

  static async repel(message, uuid, ray){
    if(!game.user.isGM) return;
    const token = fromUuidSync(uuid, { strict : false })?.object;
    const from = message.getAssociatedToken?.()?.object ?? tokenOf(message.getAssociatedActor?.());
    if(!token || !from) return;
    const moved = await pushAway(token, from, 10);
    if(!moved) ui.notifications.info(module.format("rollItem.mastery.blocked", { name : token.name }));
    await message.setFlag(module.id, `repelled.${String(ray ?? "x")}-${token.document.id}`, true);
    log.debug("Repelling Blast", token.name, moved);
  }
}
