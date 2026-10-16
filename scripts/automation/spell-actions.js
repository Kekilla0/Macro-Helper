import { module } from '../module.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { settings } from '../settings.js';
import { patch } from '../patch.js';
import { gm } from '../gm.js';
import { spells } from './spells.js';
import { hands } from './hands.js';
import { actions } from './actions.js';
import { actionTracker } from './action-tracker.js';
import { TYPES } from '../roll-item/message.js';
import { idOf, chooseOption, buttonRow, addButton, makeButton, esc, ownerIds, originOf, originItem } from '../helpers/utils.js';
import { conditions } from './conditions.js';
import { rollRequests } from '../requests/requests.js';
import { heldLight } from './held-light.js';
import { stabilize, addTimedEffect } from '../helpers/actors.js';
import { pickTargets, pickSpace } from '../helpers/targets.js';
import { tokenOf, getRange, pullToward, pushAway, addLight, removeLight, getTokensInArea, distanceBetween, canSee } from '../helpers/tokens.js';
const log = logger.for(import.meta.url);

/**
 * What spells do beyond their roll (System Automation → Spells switch). Building blocks, each by spell identifier :
 *
 *   Pull          : a hit pulls the creature straight toward the caster (Thorn Whip, 10 ft, Large or smaller) : the
 *                   GM's button on the attack card, stopping at walls and creatures.
 *   By health     : a spell with one activity for a healthy target and one for a hurt one (Toll the Dead) uses the
 *                   right one for its target (no question).
 *   Stabilize     : Spare the Dying picks a creature at 0 HP in range first (none : nothing cast), then it's Stable
 *                   (Help's Stabilize : someone else's creature, the GM's button).
 *   Enchant       : a spell that enchants an item (True Strike, Shillelagh) asks which of yours, from the eligible
 *                   ones (what's in your hands first), and enchants it. True Strike then attacks with it. Which of its
 *                   enchantments isn't asked : a cantrip's by the caster's level (Shillelagh 1d8 / 1d10 / 1d12 / 2d6),
 *                   True Strike's by the weapon picked (melee or ranged).
 *   Light         : Light : on a creature or object (a token in reach) or on a square in reach; Produce Flame : in
 *                   your hand (your token). A real light, for its duration (an effect on the caster : end it, the light
 *                   goes); casting it again moves it.
 *   Around target : a save for everyone in an area round the creature hit or aimed at (Ice Knife : on its own attack card;
 *                   Hail of Thorns from its Strike) : the area shown, its own save card, no slot (the cast paid).
 *   Sustained     : Witch Bolt cast again at the same creature while its Concentration lasts : its later turns' damage
 *                   (1d12, no roll, no slot : a Bonus Action you remember to take) instead of a new casting; the first
 *                   card no longer rolls it.
 *   Leap          : Chromatic Orb : two of its damage d8s the same : a Leap button for its caster, a free attack at
 *                   another creature within 30 ft of the one hit (as many leaps as the slot's level, each creature once).
 *   Flee          : Dissonant Whispers : a creature that failed its save has a Fleeing (Reaction) button on its row (the
 *                   GM's, beside the damage's Apply) : its Reaction spent moving away (Dashing, Reaction used), and the GM
 *                   reminded to move the token.
 *   Placed summons : Mage Hand, Unseen Servant : its caster picks the space (within the spell's range) and the GM's
 *                   client makes the token, owned by the caster's players, Neutral (no one's ally : no flanking, no
 *                   Sneak Attack), with no speed of its own (the Servant Invisible). Using the spell again with one
 *                   out asks : Move it (its speed for this turn : the hand 30 ft as a Magic action, the Servant 15 ft
 *                   as a Bonus Action; nothing spent) or a New one (replacing it). It vanishes beyond its range from
 *                   the caster (either moved), or when its duration has passed on the world clock.
 *   Message       : choose who hears it from a list (the creatures you can see within range, and the player characters
 *                   in range wherever they are : it goes round barriers), type it, and it's whispered to that
 *                   creature's players (the GM for a monster) and you; they get a Reply button (whispered back).
 *   Command       : the command is chosen when cast (Approach, Drop, Flee, Grovel, Halt); the card is "Command : Halt".
 *                   A failed save : "Commanded : Halt" on the creature until the end of its next turn, and the GM is
 *                   whispered what it must do at the start of that turn (out of combat : at once).
 *   Illusions     : Disguise Self (on the caster only) and Silent Image (a 15 ft space within 60 ft, picked on the map,
 *                   marked by an area that ends with the Concentration). Their Study activity is for others, so using the
 *                   spell goes straight to its Use. The first time each hostile creature can see the disguised caster or
 *                   the image, its Study comes as a Roll Request card for the GM (Intelligence (Investigation) against the
 *                   spell's DC, a row each : Sees through it / Fooled); once per creature.
 *   Water         : Create or Destroy Water asks : Fill containers (the card's rows are the creatures within 30 ft with
 *                   a waterskin, each with the GM's Fill button : up to 20 skins, 10 gallons at half a gallon each :
 *                   4 of dnd5e's Water, fresh (Pint) put inside each) or Rain (its 30 ft cube : the flames inside go out, held torches, lamps, lanterns and
 *                   candles, Produce Flame). Its gallons aren't rolled.
 *   Detection     : Detect Evil and Good, Detect Poison and Disease, Detect Magic : a coloured effect on the caster while
 *                   it lasts (it ends with the Concentration), to keep track of it.
 *   Cast only     : Sanctuary's save is the attacker's (spell-effects), Armor of Agathys's damage is its reaction (spells) :
 *                   using the spell casts it without asking.
 *   Areas         : coloured by the spell (Fog Cloud a fog grey) or the caster's choice (Elementalism : air, earth, fire,
 *                   water, chosen as it's cast : no other question). Fog Cloud's area is heavily obscured : no sight
 *                   into, out of or through it (the Vision rules).
 *   Goodberry     : pick up to 10 creatures on the map (the same one again for more); the card's rows are those creatures,
 *                   each with Spawn N Goodberries (its owner or the GM) : dnd5e's Magical Berries (food, heals 1 when eaten)
 *                   put on its sheet. Nothing goes on anyone by itself.
 *   Produce Flame : one use, the pick decides (within 60 ft) : you (the flame in your hand, your light) or a creature
 *                   (its Hurl Fire attack at it). The flame stays in your hand : it lights nowhere else.
 *   Alarm         : its area is watched (the active GM) : a creature entering it, moving inside it or leaving it is
 *                   whispered to the caster's players and the GM. The caster and creatures friendly to it don't set it
 *                   off (the ones it designates).
 *   Floating Disk : placed like Mage Hand (you pick its space, the GM's client makes it, your players own it). It's a
 *                   container : items dropped on its sheet ride on it, up to 500 lb. It follows your steps : once you
 *                   are more than 20 ft from it, it moves along the path you took until it's within 20 ft (no pathing
 *                   of its own). It ends 100 ft from you, after 1 hour, or cast again; whatever it carried stays as a
 *                   load on the ground (a token its owners can still empty).
 *   Hellish Rebuke : a creature damaged by an attack or spell (its card's damage applied to it) gets a Hellish Rebuke
 *                   button on its row of that card (its owner or the GM), when it has the spell ready, a slot, and the
 *                   one who did it is within 60 ft : the spell cast at that creature (its save card), the slot spent.
 *   Shield        : an attack card that hits a creature with Shield ready (and a slot) gets a Shield button for its
 *                   owner (or the GM) : Shield is cast (slot, its effect) and the card judges that hit again at AC +5.
 *                   A Magic Missile card gets one per target too : that creature takes none of its damage.
 */
export class spellActions{
  static PULLS = { "thorn-whip" : { feet : 10, maxSize : "lg" } };
  /* A failed save pushes the creature away from the caster (feet) : a GM button per creature on the save card */
  static PUSHES = { "thunderwave" : { feet : 10 } };
  static BY_HEALTH = ["toll-the-dead"];
  static STABILIZE = ["spare-the-dying"];
  static ATTACK_AFTER_ENCHANT = ["true-strike"];
  /* What a spell may enchant, by base weapon, where its data allows more (Shillelagh : any Simple Melee weapon) */
  static ENCHANT_ONLY = { "shillelagh" : ["club", "quarterstaff"] };
  /* Enchantments chosen for you : by cantrip tier (levels 1 / 5 / 11 / 17), or by the weapon (ranged or not) */
  static PROFILE_BY_TIER = ["shillelagh"];
  static PROFILE_BY_WEAPON = ["true-strike"];
  static LIGHTS = {
    "light" : { place : "touch", seconds : 3600, light : { bright : 20, dim : 40, color : "#fff1c9", alpha : 0.25 } },
    "produce-flame" : { place : "self", seconds : 600, activity : /produce|cast/i, light : { bright : 20, dim : 40, color : "#ff9b3d", alpha : 0.35, animation : { type : "torch", speed : 3, intensity : 3 } } },
  };
  static SIZES = ["tiny", "sm", "med", "lg", "huge", "grg"];
  /* An area save after the attack (feet round the target), hit or miss */
  static AFTER_ATTACK = { "ice-knife" : 5 };
  static SUSTAINED = ["witch-bolt"];
  static LEAP = { "chromatic-orb" : { feet : 30 } };
  static FLEE = ["dissonant-whispers"];
  static SHIELD = { spell : "shield", ac : 5, negates : ["magic-missile"] };
  static REBUKE = { spell : "hellish-rebuke", range : 60 };
  /* Summons placed by their caster : the leash (feet from the caster) */
  static PLACED = {
    "mage-hand" : { leash : 30, move : 30, action : "action" },
    "unseen-servant" : { leash : 60, move : 15, action : "bonus", invisible : true, sight : 60 },
    "tensers-floating-disk" : { leash : 100, follow : 20, carry : 500 },
  };
  static MESSAGE = "message";
  static ALARM = "alarm";
  static FLAME = { id : "produce-flame", range : 60 };
  static GOODBERRY = { id : "goodberry", max : 10, item : "Compendium.dnd5e.spells24.Item.phbutlMagicalBer" };
  /* Areas : a colour, heavily obscured (no sight through) */
  static AREAS = { "fog-cloud" : { color : "#c4ccd4", obscured : true } };
  static ELEMENTS = { id : "elementalism", colors : { air : "#cdeeff", earth : "#8a6a3a", fire : "#ff6a1a", water : "#2f7fd6" } };
  static #areaColor = null;
  static WATER = { id : "create-or-destroy-water", skins : 20, range : 30, pints : 4, item : "Compendium.dnd5e.equipment24.Item.dmgspWaterfresh0", identifier : "water-fresh-pint" };
  static DETECTION = { "detect-evil-and-good" : "#ffd24a", "detect-poison-and-disease" : "#5cc66b", "detect-magic" : "#a974ff" };
  /* Spells whose other activity is for someone else (Sanctuary's save : the attacker's) : straight to casting */
  static CAST_ONLY = { "sanctuary" : {}, "armor-of-agathys" : { type : "heal" } };
  static ILLUSIONS = { "disguise-self" : { watch : "caster" }, "silent-image" : { watch : "space", feet : 15 } };
  static COMMAND = { id : "command", options : ["approach", "drop", "flee", "grovel", "halt"] };

  static enabled(){
    return spells.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on(`${module.id}.rowButtons`, (message, uuid, buttons, { result } = {}) => this.pullButton(message, uuid, buttons, result));
    Hooks.on(`${module.id}.rowButton`, (message, uuid, id) => { if(id === "spellPull") this.pull(message, uuid); });
    Hooks.on(`${module.id}.rowButtons`, (message, uuid, buttons, { result } = {}) => this.pushButton(message, uuid, buttons, result));
    Hooks.on(`${module.id}.rowButton`, (message, uuid, id) => { if(id === "spellPush") this.push(message, uuid); });
    uses.onItem("byHealth", (item, ctx, next) => this.byHealthStep(item, ctx, next));
    uses.onActivity("spareTheDying", (activity, ctx, next) => this.stabilizeStep(activity, ctx, next));
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.afterEnchant(activity, usage, results));
    uses.onActivity("enchantProfile", (activity, ctx, next) => this.profileStep(activity, ctx, next));
    Hooks.on("renderActivityUsageDialog", (app, html) => this.lockProfile(app, html));
    uses.onActivity("spellLight", (activity, ctx, next) => this.lightStep(activity, ctx, next));
    gm.handle("spellLight", data => this.lightAsGM(data));
    gm.handle("spellLightOff", data => this.lightOffAsGM(data));
    Hooks.on("deleteActiveEffect", effect => this.onLightEnded(effect));
    /* Around the target */
    gm.handle("areaRegion", data => this.regionAsGM(data));
    gm.handle("spellFlee", data => this.fleeAsGM(data));
    uses.onItem("afterAttack", (item, ctx, next) => this.afterAttackStep(item, ctx, next));
    Hooks.on(`${module.id}.riderTargets`, (save, target, out) => this.burstTargets(save, target, out));
    /* Sustained */
    Hooks.on(`${module.id}.isExtra`, activity => !this.SUSTAINED.includes(idOf(activity?.item)));
    uses.onItem("sustained", (item, ctx, next) => this.sustainedStep(item, ctx, next));
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.noteSustained(activity, usage, results));
    /* Leap */
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, context) => this.leapButtons(message, buttons, context));
    Hooks.on(`${module.id}.cardButton`, (message, id, context) => { if(id === "orbLeap") this.leap(message, context); });
    Hooks.on(`${module.id}.damageType`, (activity, { types, preset }) => { const kept = this.#leapType; if(kept && (kept.item === activity?.item?.id) && ((Date.now() - kept.at) < 15000) && types.includes(kept.type)) preset.type = kept.type; });
    /* Flee */
    Hooks.on(`${module.id}.rowEffect`, (message, uuid, row, { success } = {}) => this.fleeRow(message, uuid, row, success));
    Hooks.on(`${module.id}.preApplyEffects`, (message, actor, effects, { uuid } = {}) => this.fleeApply(message, actor, uuid));
    /* Command */
    uses.onActivity("spellCommand", (activity, ctx, next) => this.commandStep(activity, ctx, next));
    Hooks.on("createChatMessage", message => this.commandOutcome(message));
    Hooks.on("updateChatMessage", message => this.commandOutcome(message));
    Hooks.on("combatTurnChange", combat => this.commandTurn(combat));
    /* Areas */
    Hooks.on("dnd5e.preCreateMeasuredTemplate", (activity, config) => this.areaColor(activity, config));
    Hooks.on("createRegion", region => { this.obscureArea(region); this.alarmStart(region); });
    /* dnd5e makes the final area in the user's colour : ours, as it's created */
    Hooks.on("preCreateRegion", region => this.regionColor(region));
    uses.onItem("element", (item, ctx, next) => this.elementStep(item, ctx, next));
    /* Produce Flame */
    uses.onItem("flame", (item, ctx, next) => this.flameStep(item, ctx, next));
    /* Alarm */
    Hooks.on("updateToken", (token, changes) => { if(("x" in (changes ?? {})) || ("y" in (changes ?? {})) || ("elevation" in (changes ?? {}))) this.alarmWatch(token); });
    Hooks.on("createToken", token => this.alarmWatch(token));
    /* Goodberry */
    uses.onItem("goodberry", (item, ctx, next) => this.goodberryStep(item, ctx, next));
    gm.handle("goodberries", (data, user) => this.goodberriesAsGM(data, user));
    Hooks.on(`${module.id}.rowButtons`, (message, uuid, buttons) => this.berryButton(message, uuid, buttons));
    Hooks.on(`${module.id}.rowButton`, (message, uuid, id) => { if(id === "spawnBerries") this.spawnBerries(message, uuid); });
    /* Water */
    uses.onItem("water", (item, ctx, next) => this.waterStep(item, ctx, next));
    Hooks.on(`${module.id}.rollFormula`, activity => idOf(activity?.item) !== this.WATER.id);
    Hooks.on(`${module.id}.rowButtons`, (message, uuid, buttons) => this.fillButton(message, uuid, buttons));
    Hooks.on(`${module.id}.rowButton`, (message, uuid, id) => { if(id === "waterFill") this.fill(message, uuid); });
    gm.handle("waterDouse", (data, user) => this.douseAsGM(data, user));
    /* Detection */
    Hooks.on("dnd5e.postUseActivity", activity => this.detectionMark(activity));
    /* Illusions */
    uses.onItem("illusion", (item, ctx, next) => this.illusionStep(item, ctx, next));
    gm.handle("illusionMark", (data, user) => this.illusionMarkAsGM(data, user));
    Hooks.on("updateToken", (token, changes) => { if(["x", "y", "hidden", "disposition"].some(k => k in (changes ?? {}))) this.watchIllusions(token.parent); });
    for(const hook of ["createWall", "updateWall", "deleteWall"]) Hooks.on(hook, wall => this.watchIllusions(wall.parent));
    Hooks.on("createToken", token => this.watchIllusions(token.parent));
    Hooks.on("createActiveEffect", effect => {
      if(this.ILLUSIONS[idOf(originItem(effect))]?.watch !== "caster") return;
      const actor = effect.parent;
      const scenes = new Set((actor?.isToken ? [actor.token] : (actor?.getActiveTokens?.(false, true) ?? []).map(t => t.document ?? t)).map(t => t?.parent).filter(Boolean));
      setTimeout(() => { for(const scene of scenes) this.watchIllusions(scene); }, 300);
    });
    /* The Concentration on Silent Image ends : its area goes (the active GM) */
    Hooks.on("deleteActiveEffect", (effect, options, userId) => this.illusionEnded(effect, userId));
    /* Message */
    uses.onActivity("spellMessage", (activity, ctx, next) => this.messageStep(activity, ctx, next));
    Hooks.on("dnd5e.renderChatMessage", (message, html) => this.replyButton(message, html));
    /* Placed summons */
    uses.onActivity("placedSummon", (activity, ctx, next) => this.placedStep(activity, ctx, next));
    gm.handle("placedSummon", (data, user) => this.placedAsGM(data, user));
    gm.handle("placedMove", (data, user) => this.placedMoveAsGM(data, user));
    /* An Invisible summon (Unseen Servant) : its owners always see its token, whichever token they're looking through */
    Hooks.once("setup", () => patch.wrap("CONFIG.Token.objectClass.prototype.isVisible", function(wrapped, ...args){
      const visible = wrapped(...args);
      if(visible || !this.document?.getFlag?.(module.id, "placedSummon")) return visible;
      return !!this.document.isOwner && !this.document.hidden;
    }));
    Hooks.on("updateToken", (token, changes) => this.placedMoved(token, changes));
    Hooks.on("updateWorldTime", () => this.placedExpire());
    /* Floating Disk : it follows the caster's steps, and carries up to 500 lb */
    Hooks.on("moveToken", (token, movement) => this.diskFollow(token, movement));
    Hooks.on("preCreateItem", item => this.diskWeight(item));
    Hooks.on("preUpdateItem", (item, change) => JSON.stringify(change ?? {}).match(/quantity|weight/) ? this.diskWeight(item, change) : undefined);
    /* True Strike : the spell's face on the attack card (both : the weapon's rules and the spell's) */
    Hooks.on(`${module.id}.cardFaces`, (message, faces) => { const uuid = message.getFlag?.(module.id, "castAs"); if(uuid && !faces.some(f => f.uuid === uuid)) faces.push({ uuid }); });
    /* Hellish Rebuke */
    Hooks.on(`${module.id}.rowButtons`, (message, uuid, buttons) => this.rebukeButton(message, uuid, buttons));
    Hooks.on(`${module.id}.rowButton`, (message, uuid, id) => { if(id === "hellishRebuke") this.rebuke(message, uuid); });
    gm.handle("spellRebuked", (data, user) => this.rebukedAsGM(data, user));
    /* Shield */
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, context) => this.shieldButtons(message, buttons, context));
    Hooks.on(`${module.id}.cardButton`, (message, id) => { if(String(id).startsWith("shield|")) this.shield(message, String(id).slice(7)); });
    Hooks.on("dnd5e.renderChatMessage", (message, html) => this.missileShieldButtons(message, html));
    Hooks.on("dnd5e.calculateDamage", (actor, damages, options) => this.shieldedFrom(actor, damages, options));
    gm.handle("spellShield", (data, user) => this.shieldAsGM(data, user));
  }

  /* ========== Pull (Thorn Whip) ========== */

  /* On the line of a creature the attack hit (the GM's) : Large or smaller */
  static pullButton(message, uuid, buttons, result){
    if(!game.user.isGM || !this.enabled() || (message.type !== TYPES.attack) || !result?.hit) return;
    const pull = this.PULLS[idOf(message.getAssociatedItem?.())];
    const token = pull ? fromUuidSync(uuid, { strict : false }) : null;
    if(!token) return;
    const size = token.actor?.system?.traits?.size ?? "med";
    if(this.SIZES.indexOf(size) > this.SIZES.indexOf(pull.maxSize)) return;
    const done = !!message.getFlag(module.id, `pulled.${uuid.replaceAll(".", "-")}`);
    buttons.push({ id : "spellPull", icon : "fa-arrows-to-dot", disabled : done,
      label : module.format(done ? "spellActions.pulled" : "spellActions.pullShort", { feet : pull.feet }) });
  }

  static async pull(message, uuid){
    const pull = this.PULLS[idOf(message.getAssociatedItem?.())];
    const token = fromUuidSync(uuid, { strict : false });
    const key = `pulled.${uuid.replaceAll(".", "-")}`;
    if(!game.user.isGM || !pull || !token || message.getFlag(module.id, key)) return;
    const from = message.getAssociatedToken?.()?.object ?? tokenOf(message.getAssociatedActor?.());
    const moved = (token.object && from) ? await pullToward(token.object, from, pull.feet) : 0;
    if(!moved) ui.notifications.info(module.format("rollItem.mastery.blocked", { name : token.name }));
    await message.setFlag(module.id, key, true);
  }

  /* ========== Push (Thunderwave) ========== */

  /* On the row of a creature that failed its save (the GM's) */
  static pushButton(message, uuid, buttons, result){
    if(!game.user.isGM || !this.enabled() || (message.type !== TYPES.save) || !result || result.success) return;
    const push = this.PUSHES[idOf(message.getAssociatedItem?.())];
    const token = push ? fromUuidSync(uuid, { strict : false }) : null;
    if(!token) return;
    const done = !!message.getFlag(module.id, `pushed.${uuid.replaceAll(".", "-")}`);
    buttons.push({ id : "spellPush", icon : "fa-arrows-left-right-to-line", disabled : done,
      label : module.format(done ? "spellActions.pushed" : "spellActions.push", { feet : push.feet }) });
  }

  static async push(message, uuid){
    const push = this.PUSHES[idOf(message.getAssociatedItem?.())];
    const token = fromUuidSync(uuid, { strict : false });
    const key = `pushed.${uuid.replaceAll(".", "-")}`;
    if(!game.user.isGM || !push || !token || message.getFlag(module.id, key)) return;
    const from = message.getAssociatedToken?.()?.object ?? tokenOf(message.getAssociatedActor?.());
    const moved = (token.object && from) ? await pushAway(token.object, from, push.feet) : 0;
    if(!moved) ui.notifications.info(module.format("rollItem.mastery.blocked", { name : token.name }));
    await message.setFlag(module.id, key, true);
  }

  /* ========== By health (Toll the Dead) ========== */

  static async byHealthStep(item, ctx, next){
    if(!this.enabled() || !this.BY_HEALTH.includes(idOf(item))) return next();
    const activities = item.system.activities?.contents ?? [];
    if(activities.length < 2) return next();
    /* Pick Targets : the creature first (its Hit Points decide which activity); then no second pick */
    let picked = false;
    const caster = tokenOf(item);
    const pick = settings.value("rollItemPick");
    if(settings.value("rollItem") && (pick !== "off") && canvas.ready && caster && (caster.document.parent === canvas.scene)
      && !((pick === "empty") && (game.user.targets.size === 1))){
      const range = getRange(activities[0]) || Number(item.system.range?.value) || 60;
      const [target] = await pickTargets(item, { count : 1, range, disposition : "any", includeSelf : false, useTargets : false });
      if(!target) return null;
      picked = true;
    }
    if(game.user.targets.size !== 1) return next();
    const actor = game.user.targets.first()?.actor;
    const hp = actor?.system?.attributes?.hp;
    if(!hp) return next();
    const hurt = Number(hp.value) < Number(hp.max);
    const activity = activities.find(a => (hurt ? /damag|hurt|wound|missing/i : /healthy|full|unharm/i).test(a.name ?? "")) ?? null;
    if(!activity) return next();
    const { chooseActivity, ...usage } = ctx.config ?? {};
    if(picked) usage[module.id] = { ...(usage[module.id] ?? {}), skipPick : true, useTargets : true };
    return activity.use(usage, ctx.dialog, ctx.message);
  }

  /* ========== Stabilize (Spare the Dying) ========== */

  static async stabilizeStep(activity, ctx, next){
    if(!this.enabled() || !this.STABILIZE.includes(idOf(activity?.item)) || !activity.actor?.isOwner) return next();
    const range = getRange(activity) || 15;
    const [target] = await pickTargets(activity.item, { count : 1, range, disposition : "any", includeSelf : true, useTargets : false,
      filter : t => actions.canStabilize(t.actor) });
    if(!target?.actor) return;
    uses.flag(ctx, { note : module.format("spellActions.spareNote", { name : target.name }) });
    const result = await next();
    if(result) await stabilize(target.actor);
    return result;
  }

  /* ========== Enchant (True Strike, Shillelagh) ========== */

  /* A cantrip's tier : 0 below level 5, then 1 / 2 / 3 at 5, 11 and 17 (a character's level, a monster's spellcaster level) */
  static cantripTier(actor){
    const level = Number(actor?.system?.details?.level) || Number(actor?.system?.attributes?.spell?.level) || Number(actor?.system?.details?.spellLevel) || 1;
    return (level >= 17) ? 3 : (level >= 11) ? 2 : (level >= 5) ? 1 : 0;
  }

  /* The enchantment it'll use, chosen before dnd5e's window (which then can't change it) */
  static profileStep(activity, ctx, next){
    if(!this.enabled() || (activity?.type !== "enchant")) return next();
    const id = idOf(activity.item);
    const profiles = activity.effects ?? [];
    if(profiles.length < 2) return next();
    if(this.PROFILE_BY_TIER.includes(id)){
      const profile = profiles[Math.min(this.cantripTier(activity.actor), profiles.length - 1)];
      ctx.config = { ...ctx.config, enchantmentProfile : profile._id };
      uses.mark(ctx, { profileChosen : "tier" });
    }
    else if(this.PROFILE_BY_WEAPON.includes(id)) uses.mark(ctx, { profileChosen : "weapon" });
    else return next();
    /* A cantrip : nothing left to choose in dnd5e's window */
    if(!Number(activity.item.system.level)) ctx.dialog = { ...(ctx.dialog ?? {}), configure : false };
    /* True Strike : no card of its own, the attack's card is the spell's */
    if(this.ATTACK_AFTER_ENCHANT.includes(id)) ctx.message = { ...(ctx.message ?? {}), create : false };
    return next();
  }

  static lockProfile(app, html){
    const chosen = app?.config?.[module.id]?.profileChosen;
    if(!chosen) return;
    const select = (html instanceof HTMLElement ? html : html?.[0])?.querySelector?.('[name="enchantmentProfile"]');
    if(!select) return;
    if(app.config.enchantmentProfile) select.value = app.config.enchantmentProfile;
    select.disabled = true;
    select.dataset.tooltip = module.i18n(chosen === "tier" ? "spellActions.profileByLevel" : "spellActions.profileByWeapon");
  }

  /* True Strike : its ranged enchantment for a ranged weapon, else its melee one */
  static profileForWeapon(activity, item){
    const profiles = activity.effects ?? [];
    const ranged = (item.system?.attackType === "ranged") || ["simpleR", "martialR"].includes(item.system?.type?.value);
    const named = p => (p.effect?.name ?? activity.item.effects.get(p._id)?.name ?? "");
    return (profiles.find(p => /ranged/i.test(named(p)) === ranged) ?? profiles[0])?._id;
  }

  /* Cast : which of your items it enchants (held ones first), then True Strike's attack with it */
  static async afterEnchant(activity, usage, results){
    if(!this.enabled() || (activity?.type !== "enchant") || (activity.item?.type !== "spell") || activity.enchant?.self) return;
    const actor = activity.actor;
    if(!results?.message || !actor?.isOwner) return;
    const held = new Set(hands.heldItems(actor).map(i => i.id));
    const only = this.ENCHANT_ONLY[idOf(activity.item)];
    const eligible = actor.items.filter(i => (i !== activity.item) && (activity.canEnchant(i) === true) && (!only || only.includes(i.system.type?.baseItem) || only.includes(idOf(i))))
      .sort((a, b) => (held.has(b.id) - held.has(a.id)) || a.name.localeCompare(b.name));
    if(!eligible.length) return ui.notifications.warn(module.format("spellActions.noEnchant", { name : actor.name, spell : activity.item.name }));
    const id = (eligible.length === 1) ? eligible[0].id : await chooseOption({ title : activity.item.name, icon : "fa-solid fa-wand-magic-sparkles",
      prompt : module.i18n("spellActions.enchantPrompt"), value : eligible[0].id,
      options : eligible.map(i => ({ value : i.id, label : held.has(i.id) ? module.format("spellActions.inHand", { name : i.name }) : i.name })) });
    const item = id ? actor.items.get(id) : null;
    if(!item) return;
    const profile = this.PROFILE_BY_WEAPON.includes(idOf(activity.item)) ? this.profileForWeapon(activity, item)
      : (usage?.enchantmentProfile ?? activity.effects?.[0]?._id);
    const concentration = (results.effects ?? []).find(e => e.statuses?.has?.("concentrating"));
    /* Cast again : the earlier enchantment from this spell ends (on whichever item it was) */
    const from = activity.item.uuid;
    for(const owned of actor.items){
      const old = owned.effects.filter(e => (e.type === "enchantment") && [e.origin, e.system?.origin?.activity, e.system?.origin?.item].some(o => String(o ?? "").startsWith(from)));
      if(old.length) await owned.deleteEmbeddedDocuments("ActiveEffect", old.map(e => e.id)).catch(error => log.debug(error));
    }
    const chatMessage = (results.message?.documentName === "ChatMessage") ? results.message : undefined;
    const enchantment = await activity.applyEnchantment(profile, actor.items.get(item.id) ?? item, { chatMessage, concentration });
    if(!enchantment) return;
    log.debug("Enchanted", item.name, "with", activity.item.name);
    /* True Strike : the attack with it now (the enchantment is what makes it use your spellcasting ability) */
    if(this.ATTACK_AFTER_ENCHANT.includes(idOf(activity.item))){
      const attack = actor.items.get(item.id)?.system?.activities?.find?.(a => a.type === "attack");
      const used = attack ? await attack.use({ [module.id] : { economy : "free", note : module.format("spellActions.trueStrikeNote", { spell : activity.item.name }), cardFlags : { castAs : activity.item.uuid } } }) : null;
      /* Instantaneous : the enchantment ends once the attack's card is done */
      if(used) await uses.cardOf(used).catch(() => null);
      if(!enchantment.isDeleted) await enchantment.delete().catch(error => log.debug(error));
    }
  }

  /* ========== Around the target (Ice Knife, Hail of Thorns) ========== */

  /**
   * A save for everyone round a creature : an area shown (feet from its space), everyone in it targeted (it too), and
   * the spell's save activity used at them with no slot (the cast already paid).
   * @param {Item} spell
   * @param {Token|TokenDocument} center
   * @param {object} [options]
   * @param {number} [options.level]   the cast level (damage scaling)
   * @param {number} [options.feet=5]
   */
  static async areaSave(spell, center, { level, feet = 5 } = {}){
    const save = spell?.system?.activities?.find?.(a => a.type === "save");
    const token = center?.object ?? center;
    if(!save || !token?.center || !canvas.ready) return null;
    const radius = (feet / canvas.scene.grid.distance) * canvas.grid.size + (Math.max(token.w, token.h) / 2);
    const made = await gm.run("areaRegion", { scene : canvas.scene.id, name : spell.name, color : game.user.color?.css ?? "#ffd700",
      x : token.center.x, y : token.center.y, radius, activity : save.uuid, origin : (tokenOf(save.item?.actor)?.document ?? token.document).uuid });
    const region = made?.id ? canvas.scene.regions.get(made.id) : null;
    const inside = region ? getTokensInArea(region) : [token];
    if(!inside.includes(token)) inside.push(token);
    canvas.tokens.setTargets(inside.map(t => t.id));
    const scaling = Math.max(0, (Number(level) || Number(spell.system.level) || 1) - (Number(spell.system.level) || 1));
    return save.use({ consume : { spellSlot : false, resources : false }, scaling, [module.id] : { skipPick : true, noCast : true, useTargets : true } }, { configure : false });
  }

  static async regionAsGM({ scene, name, color, x, y, radius, activity, origin } = {}){
    const target = game.scenes.get(scene);
    if(!target) return null;
    const [region] = await target.createEmbeddedDocuments("Region", [{ name, color, visibility : CONST.REGION_VISIBILITY?.ALWAYS ?? 2,
      shapes : [{ type : "circle", x, y, radius }], flags : { dnd5e : { activity, origin } } }]);
    return { id : region?.id ?? null };
  }

  /* Ice Knife : straight to its attack (its save rides on the attack's card, for everyone round the target) */
  static afterAttackStep(item, ctx, next){
    if(!this.enabled() || !this.AFTER_ATTACK[idOf(item)]) return next();
    const attack = item.system.activities?.find?.(a => a.type === "attack");
    if(!attack) return next();
    const { chooseActivity, ...usage } = ctx.config ?? {};
    return attack.use(usage, ctx.dialog, ctx.message);
  }

  /* The save's creatures : the target and everyone within 5 ft of it, hit or miss (the area shown) */
  static burstTargets(save, target, out){
    const feet = this.AFTER_ATTACK[idOf(save?.item)];
    const token = target?.object ?? target;
    if(!feet || !this.enabled() || !token?.document) return;
    const scene = token.document.parent;
    for(const t of scene.tokens){
      if(!t.actor || !t.object) continue;
      if((t === token.document) || (distanceBetween(t.object, token) <= feet)) out.push(t.uuid);
    }
    /* The burst shown on the map (the GM's client makes it) */
    const radius = (feet / scene.grid.distance) * scene.grid.size + (Math.max(token.w, token.h) / 2);
    gm.run("areaRegion", { scene : scene.id, name : save.item.name, color : game.user.color?.css ?? "#ffd700",
      x : token.center.x, y : token.center.y, radius, activity : save.uuid, origin : (tokenOf(save.item?.actor)?.document ?? token.document).uuid }).catch(error => log.debug(error));
  }

  /* ========== Sustained (Witch Bolt) ========== */

  static sustainedOf(actor, item){
    return actor?.effects?.find?.(e => e.statuses?.has?.("concentrating") && (e.getFlag("dnd5e", "item")?.id === item?.id) && e.getFlag(module.id, "sustained")) ?? null;
  }

  /* Cast : remember who it's on (with its Concentration) */
  static async noteSustained(activity, usage, results){
    if(!this.SUSTAINED.includes(idOf(activity?.item)) || (activity.type !== "attack") || !results || !activity.actor?.isOwner || usage?.[module.id]?.noCast) return;
    /* The target : the attack card's, once it's made (picked after the use; its card promise waits for the dice) */
    const card = await this.nextCard(activity.item);
    const target = card?.system?.targets?.[0]?.token ?? null;
    if(!target) return;
    /* Its Concentration may land a moment later */
    let concentration = null;
    for(let i = 0; (i < 20) && !concentration; i++){
      concentration = activity.actor.effects.find(e => e.statuses?.has?.("concentrating") && (e.getFlag("dnd5e", "item")?.id === activity.item.id));
      if(!concentration) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if(concentration) await concentration.setFlag(module.id, "sustained", { target, level : (Number(activity.item.system.level) || 1) + (Number(usage?.scaling) || 0) });
  }

  /* The next card made for this item (up to a minute : the pick can take a while), null if none */
  static nextCard(item, ms = 60000){
    return new Promise(resolve => {
      const done = message => { Hooks.off("createChatMessage", id); clearTimeout(timer); resolve(message); };
      const id = Hooks.on("createChatMessage", message => {
        if((message.getAssociatedItem?.()?.uuid === item.uuid) && message.system?.targets) done(message);
      });
      const timer = setTimeout(() => done(null), ms);
    });
  }

  /* Cast again at the same creature : the later turns' damage, no slot, no roll */
  static async sustainedStep(item, ctx, next){
    if(!this.enabled() || !this.SUSTAINED.includes(idOf(item))) return next();
    const sustained = this.sustainedOf(item.actor, item);
    const damage = item.system.activities?.find?.(a => a.type === "damage");
    const attack = item.system.activities?.find?.(a => a.type === "attack");
    if(!sustained || !damage || !attack) return next();
    /* Pick Targets : the creature is picked first (the same one or a new casting decides what this is) */
    const caster = tokenOf(item);
    const pick = settings.value("rollItemPick");
    const picking = settings.value("rollItem") && (pick !== "off") && canvas.ready && caster && (caster.document.parent === canvas.scene)
      && !((pick === "empty") && (game.user.targets.size === 1));
    let target = game.user.targets.first() ?? null;
    if(picking){
      [target] = await pickTargets(item, { count : 1, range : getRange(attack) || Infinity, disposition : "any", includeSelf : false, useTargets : false });
      if(!target) return null;
    }
    if(!target || (game.user.targets.size !== 1)) return next();
    if(sustained.getFlag(module.id, "sustained").target !== target.document.uuid){
      /* Another creature : a new casting at it (no second pick) */
      return picking ? attack.use({ [module.id] : { useTargets : true } }) : next();
    }
    return damage.use({ consume : { spellSlot : false, resources : false }, concentration : { begin : false }, scaling : 0,
      [module.id] : { skipPick : true, noCast : true, economy : "bonus", note : module.i18n("spellActions.sustainedNote") } }, { configure : false });
  }

  /* ========== Leap (Chromatic Orb) ========== */

  static #leapType = null;

  /* The leaps done from this casting (the first card's) and those it still has */
  static leapState(message){
    const root = message.getFlag(module.id, "orbLeap")?.root ? game.messages.get(message.getFlag(module.id, "orbLeap").root) : message;
    const state = root?.getFlag(module.id, "orbLeaps") ?? { done : 0, targeted : [] };
    const level = Number(root?.getFlag(module.id, "orbLevel")) || Number(root?.system?.level) || ((Number(root?.getAssociatedItem?.()?.system?.level) || 1) + (Number(root?.system?.scaling) || 0));
    return { root, state, left : Math.max(0, level - (Number(state.done) || 0)) };
  }

  static matchingDice(message){
    for(const roll of message.rolls ?? []){
      if(!(roll instanceof CONFIG.Dice.DamageRoll)) continue;
      const faces = roll.dice.filter(d => d.faces === 8).flatMap(d => d.results.filter(r => r.active !== false).map(r => r.result));
      if(new Set(faces).size < faces.length) return true;
    }
    return false;
  }

  static leapButtons(message, buttons, { ray } = {}){
    const leap = this.LEAP[idOf(message.getAssociatedItem?.())];
    if(!leap || !this.enabled() || !message.isOwner || (message.type !== TYPES.attack) || message.getFlag(module.id, "orbLeapt")) return;
    if(!message.system?.isHitOn?.(ray) || !this.matchingDice(message)) return;
    if(!(this.leapState(message).left > 0)) return;
    buttons.push({ id : "orbLeap", label : module.i18n("spellActions.leap"), icon : "fa-meteor" });
  }

  static async leap(message, { ray } = {}){
    const item = message.getAssociatedItem?.();
    const activity = message.getAssociatedActivity?.();
    const leap = this.LEAP[idOf(item)];
    const from = message.system?.hitTargets?.(ray)?.[0];
    const origin = from?.object ?? from;
    if(!leap || !activity || !origin) return;
    const { root, state, left } = this.leapState(message);
    if(!(left > 0)) return;
    const targeted = new Set([...(state.targeted ?? []), ...(message.system.targets ?? []).map(t => t.token)]);
    const [next] = await pickTargets(origin, { count : 1, range : leap.feet, disposition : "any", includeSelf : false, useTargets : false,
      filter : t => !targeted.has(t.document.uuid) && (t.actor !== activity.actor) });
    if(!next) return;
    await root.setFlag(module.id, "orbLeaps", { done : (Number(state.done) || 0) + 1, targeted : [...targeted, next.document.uuid] });
    await message.setFlag(module.id, "orbLeapt", true);
    /* The same damage type as the first */
    const type = message.rolls.find(r => r instanceof CONFIG.Dice.DamageRoll)?.options?.type;
    this.#leapType = type ? { item : item.id, type, at : Date.now() } : null;
    canvas.tokens.setTargets([next.id]);
    return activity.use({ consume : { spellSlot : false, resources : false }, scaling : Number(message.system?.scaling) || 0,
      [module.id] : { skipPick : true, useTargets : true, noCast : true, cardFlags : { orbLeap : { root : root.id } } } }, { configure : false });
  }

  /* ========== Flee (Dissonant Whispers) ========== */

  /* The row's effect button (GM) : on a failed save, Fleeing */
  static fleeRow(message, uuid, row, success){
    if(!this.enabled() || success || !this.FLEE.includes(idOf(message?.getAssociatedItem?.()))) return;
    row.show = true;
    row.names = module.i18n("spellActions.fleeing");
    row.done = !!message.getFlag(module.id, `effects.${String(uuid).replaceAll(".", "-")}`);
  }

  /* Its click : the Reaction spent fleeing; the card remembers (the GM) */
  static fleeApply(message, actor, uuid){
    if(!this.enabled() || !actor || !this.FLEE.includes(idOf(message?.getAssociatedItem?.()))) return;
    if(message.system?.outcomes?.get?.(uuid) !== "failure") return;
    const caster = message.getAssociatedActor?.();
    this.fleeAsGM({ actor : actor.uuid, from : caster?.name ?? "", spell : message.getAssociatedItem?.()?.name ?? "" })
      .then(() => message.setFlag(module.id, `effects.${String(uuid).replaceAll(".", "-")}`, true)).catch(error => log.debug(error));
    return false;
  }

  /* GM : its Reaction spent on a Dash away (until its next turn), and a reminder to move it */
  static async fleeAsGM({ actor : uuid, from, spell } = {}){
    const actor = fromUuidSync(uuid, { strict : false });
    if(!actor) return false;
    await addTimedEffect(actor, { name : module.format("spellActions.fleeEffect", { spell }), img : "icons/svg/wingfoot.svg",
      statuses : ["dashing"], flags : { [module.id] : { reactionUsed : true } } }, { of : actor, until : "turnStart" });
    await ChatMessage.implementation.create({ speaker : { alias : module.title }, whisper : game.users.filter(u => u.isGM).map(u => u.id),
      content : `<p>${module.format("spellActions.fleeGM", { name : actor.name, from })}</p>` });
    return true;
  }

  /* ========== Command ========== */

  static async commandStep(activity, ctx, next){
    if(!this.enabled() || (idOf(activity?.item) !== this.COMMAND.id) || (activity.type !== "save")) return next();
    const value = await chooseOption({ title : activity.item.name, icon : "fa-solid fa-bullhorn", prompt : module.i18n("spellActions.command.prompt"),
      options : this.COMMAND.options.map(o => ({ value : o, label : module.i18n(`spellActions.command.${o}`) })) });
    if(!value) return;
    const word = module.i18n(`spellActions.command.${value}`);
    const title = module.format("spellActions.command.title", { spell : activity.item.name, word });
    uses.mark(ctx, { cardFlags : { command : value, title } });
    uses.flag(ctx, { command : value, title });
    return next();
  }

  /* A save against a Command card : failed, the creature is Commanded (the active GM; a reroll that saves takes it off) */
  static async commandOutcome(message){
    if(!game.users.activeGM?.isSelf || (message?.type !== "save") || !this.enabled()) return;
    const card = originOf(message);
    const word = card?.getFlag?.(module.id, "command");
    const actor = message.getAssociatedActor?.() ?? message.getSpeakerActor?.();
    if(!word || !actor || !message.rolls?.length) return;
    const outcome = conditions.saveOutcome(message);
    if(!outcome) return;
    const existing = actor.effects.find(e => e.getFlag(module.id, "commanded")?.card === card.id);
    if(outcome.success){
      if(existing) await existing.delete().catch(error => log.debug(error));
      return;
    }
    if(existing) return;
    const label = module.i18n(`spellActions.command.${word}`);
    const caster = card.getAssociatedActor?.();
    await addTimedEffect(actor, { name : module.format("spellActions.command.effect", { word : label }), img : "icons/svg/sound.svg",
      origin : card.getAssociatedItem?.()?.uuid ?? null, description : module.i18n(`spellActions.command.${word}Text`),
      flags : { [module.id] : { commanded : { card : card.id, word, caster : caster?.uuid ?? null } } } }, { of : actor, until : "turnEnd" });
    if(!game.combat?.started) await this.commandWhisper(actor, word, caster);
  }

  static async commandWhisper(actor, word, caster){
    await ChatMessage.implementation.create({ speaker : { alias : module.title }, whisper : game.users.filter(u => u.isGM).map(u => u.id),
      content : `<p><strong>${esc(module.format("spellActions.command.gm", { name : actor.name, word : module.i18n(`spellActions.command.${word}`), caster : caster?.name ?? "" }))}</strong></p><p>${esc(module.i18n(`spellActions.command.${word}Text`))}</p>` });
  }

  /* The commanded creature's turn begins : the GM is told what it must do */
  static async commandTurn(combat){
    if(!game.users.activeGM?.isSelf || !this.enabled()) return;
    const actor = combat?.combatant?.actor;
    for(const effect of actor?.effects?.filter?.(e => e.getFlag(module.id, "commanded")) ?? []){
      const { word, caster } = effect.getFlag(module.id, "commanded");
      await this.commandWhisper(actor, word, fromUuidSync(caster ?? "", { strict : false }));
    }
  }

  /* ========== Areas (Fog Cloud, Elementalism) ========== */

  static areaColor(activity, config){
    if(!this.enabled() || !config) return;
    const chosen = this.#areaColor;
    if(chosen && (chosen.item === activity?.item?.id) && ((Date.now() - chosen.at) < 60000)){ config.color = chosen.color; return; }
    const area = this.AREAS[idOf(activity?.item)];
    if(area?.color) config.color = area.color;
  }

  static regionColor(region){
    if(!this.enabled()) return;
    const item = fromUuidSync(region.getFlag?.("dnd5e", "item") ?? region.flags?.dnd5e?.item ?? "", { strict : false });
    if(!item) return;
    const chosen = this.#areaColor;
    const color = (chosen && (chosen.item === item.id) && ((Date.now() - chosen.at) < 60000)) ? chosen.color : this.AREAS[idOf(item)]?.color;
    if(color) region.updateSource({ color });
  }

  /* The active GM : a heavily obscuring spell's area is flagged (the Vision rules read it) */
  static async obscureArea(region){
    if(!game.users.activeGM?.isSelf || !this.enabled()) return;
    const item = fromUuidSync(region.getFlag("dnd5e", "item") ?? "", { strict : false });
    if(this.AREAS[idOf(item)]?.obscured && !region.getFlag(module.id, "obscured")) await region.setFlag(module.id, "obscured", true).catch(error => log.debug(error));
  }

  /* Elementalism : which element, then its area in that colour (Beckon and Sculpt aren't asked) */
  static async elementStep(item, ctx, next){
    if(!this.enabled() || (idOf(item) !== this.ELEMENTS.id)) return next();
    const use = item.system.activities?.contents?.[0];
    if(!use) return next();
    const element = await chooseOption({ title : item.name, icon : "fa-solid fa-wind", prompt : module.i18n("spellActions.element.prompt"),
      options : Object.keys(this.ELEMENTS.colors).map(e => ({ value : e, label : module.i18n(`spellActions.element.${e}`) })) });
    if(!element) return null;
    this.#areaColor = { item : item.id, color : this.ELEMENTS.colors[element], at : Date.now() };
    const word = module.i18n(`spellActions.element.${element}`);
    const { chooseActivity, ...usage } = ctx.config ?? {};
    const title = module.format("spellActions.command.title", { spell : item.name, word });
    usage[module.id] = { ...(usage[module.id] ?? {}), cardFlags : { title } };
    return use.use(usage, ctx.dialog, foundry.utils.mergeObject(ctx.message ?? {}, { data : { flags : { [module.id] : { title } } } }, { inplace : false }));
  }

  /* ========== Alarm ========== */

  /* An Alarm area placed : who's already in it (their moves there are "moves inside", not "entered") */
  static async alarmStart(region){
    if(!game.users.activeGM?.isSelf || !this.enabled()) return;
    const item = fromUuidSync(region.getFlag("dnd5e", "item") ?? "", { strict : false });
    if(idOf(item) !== this.ALARM) return;
    const grid = region.parent.grid.size;
    const inside = region.parent.tokens.filter(t => t.actor && region.testPoint({ x : t.x + (t.width * grid / 2), y : t.y + (t.height * grid / 2), elevation : t.elevation ?? 0 })).map(t => t.uuid);
    await region.setFlag(module.id, "alarmInside", inside).catch(() => {});
  }

  /* A token moved (or appeared) : each Alarm area on its scene, who's inside now against who was */
  static async alarmWatch(token){
    if(!game.users.activeGM?.isSelf || !this.enabled() || !token?.parent) return;
    const scene = token.parent;
    for(const region of scene.regions){
      const item = fromUuidSync(region.getFlag("dnd5e", "item") ?? "", { strict : false });
      if(idOf(item) !== this.ALARM) continue;
      const caster = item.actor;
      const casterToken = scene.tokens.find(t => t.actor === caster) ?? null;
      const D = CONST.TOKEN_DISPOSITIONS;
      /* Not the caster, not its friends (the creatures it designated) */
      if(!token.actor || (token.actor === caster) || (casterToken && (token.disposition === casterToken.disposition) && (token.disposition === D.FRIENDLY))) continue;
      const grid = scene.grid.size;
      const point = { x : token.x + (token.width * grid / 2), y : token.y + (token.height * grid / 2), elevation : token.elevation ?? 0 };
      const now = region.testPoint(point);
      const inside = new Set(region.getFlag(module.id, "alarmInside") ?? []);
      const was = inside.has(token.uuid);
      if(!now && !was) continue;
      const what = (now && !was) ? "entered" : (!now && was) ? "left" : "moved";
      if(now) inside.add(token.uuid); else inside.delete(token.uuid);
      await region.setFlag(module.id, "alarmInside", [...inside]).catch(() => {});
      const players = game.users.filter(u => !u.isGM && caster?.testUserPermission(u, "OWNER")).map(u => u.id);
      await ChatMessage.implementation.create({ speaker : { alias : item.name }, whisper : [...new Set([...players, ...game.users.filter(u => u.isGM).map(u => u.id)])],
        content : `<p>${esc(module.format(`spellActions.alarm.${what}`, { name : token.name, spell : item.name, caster : caster?.name ?? "" }))}</p>` });
    }
  }

  /* ========== Produce Flame ========== */

  static async flameStep(item, ctx, next){
    if(!this.enabled() || (idOf(item) !== this.FLAME.id)) return next();
    const cast = item.system.activities?.find?.(a => a.type === "utility");
    const hurl = item.system.activities?.find?.(a => a.type === "attack");
    const caster = tokenOf(item.actor);
    if(!cast || !hurl || !caster) return next();
    /* Yourself or a creature (one you can't see too : the attack has disadvantage) */
    const [token] = await pickTargets(item, { count : 1, range : this.FLAME.range, disposition : "any", includeSelf : true, useTargets : false, sight : false,
      notice : module.i18n("spellActions.flame.pick") });
    if(!token) return null;
    const { chooseActivity, ...usage } = ctx.config ?? {};
    /* A creature : Hurl Fire at it */
    if(token && (token !== caster)){
      canvas.tokens.setTargets([token.id]);
      return hurl.use({ ...usage, [module.id] : { ...(usage[module.id] ?? {}), skipPick : true, useTargets : true } }, ctx.dialog, ctx.message);
    }
    /* You : the flame in your hand (your light) */
    const lightWhere = { token : caster.document.uuid };
    canvas.tokens.setTargets([]);
    return cast.use({ ...usage, [module.id] : { ...(usage[module.id] ?? {}), skipPick : true, lightWhere } }, ctx.dialog, ctx.message);
  }

  /* ========== Goodberry ========== */

  static async goodberryStep(item, ctx, next){
    if(!this.enabled() || (idOf(item) !== this.GOODBERRY.id)) return next();
    const use = item.system.activities?.contents?.[0];
    if(!use || !tokenOf(item.actor)) return next();
    const picks = await pickTargets(item, { count : this.GOODBERRY.max, repeat : true, confirm : "manual", range : Infinity, disposition : "any",
      includeSelf : true, useTargets : false, sight : false, notice : module.format("spellActions.goodberry.pick", { n : this.GOODBERRY.max }) });
    if(!picks?.length) return null;
    /* How many each, its row's Spawn button gives them */
    const counts = {};
    for(const t of picks.slice(0, this.GOODBERRY.max)) counts[t.document.uuid.replaceAll(".", "-")] = (counts[t.document.uuid.replaceAll(".", "-")] ?? 0) + 1;
    canvas.tokens.setTargets([...new Set(picks)].map(t => t.id));
    const { chooseActivity, ...usage } = ctx.config ?? {};
    return use.use({ ...usage, [module.id] : { ...(usage[module.id] ?? {}), mode : "utility", skipPick : true, useTargets : true } }, ctx.dialog,
      foundry.utils.mergeObject(ctx.message ?? {}, { data : { flags : { [module.id] : { goodberries : counts } } } }, { inplace : false }));
  }

  /* A Goodberry card's rows : Spawn, for the creature's owner or the GM */
  static berryButton(message, uuid, buttons){
    const counts = message?.getFlag?.(module.id, "goodberries");
    const n = counts?.[uuid.replaceAll(".", "-")];
    const actor = n ? fromUuidSync(uuid, { strict : false })?.actor : null;
    if(!actor || !(game.user.isGM || actor.isOwner)) return;
    const done = !!message.getFlag(module.id, `berriesGiven.${uuid.replaceAll(".", "-")}`);
    buttons.push({ id : "spawnBerries", icon : "fa-seedling", disabled : done,
      label : module.format(done ? "spellActions.goodberry.spawned" : "spellActions.goodberry.spawn", { n }) });
  }

  static async spawnBerries(message, uuid){
    const n = message.getFlag(module.id, "goodberries")?.[uuid.replaceAll(".", "-")];
    if(!n || message.getFlag(module.id, `berriesGiven.${uuid.replaceAll(".", "-")}`)) return;
    await gm.run("goodberries", { message : message.id, token : uuid, n });
  }

  /* GM : that creature's berries (its owner or the GM pressed Spawn), stacked; the card remembers */
  static async goodberriesAsGM({ message : id, token : uuid, n = 1 } = {}, user){
    const message = game.messages.get(id);
    const actor = fromUuidSync(uuid ?? "", { strict : false })?.actor;
    const key = `berriesGiven.${String(uuid).replaceAll(".", "-")}`;
    if(!message || !actor || message.getFlag(module.id, key) || !(user.isGM || actor.testUserPermission(user, "OWNER"))) return false;
    const count = Math.min(this.GOODBERRY.max, Number(message.getFlag(module.id, "goodberries")?.[String(uuid).replaceAll(".", "-")]) || Number(n) || 1);
    const source = await fromUuid(this.GOODBERRY.item).catch(() => null);
    if(!source) return ui.notifications.warn(module.i18n("spellActions.goodberry.noItem"));
    const stack = actor.items.find(i => i.getFlag(module.id, "goodberry"));
    if(stack) await stack.update({ "system.quantity" : (Number(stack.system.quantity) || 0) + count });
    else {
      const data = source.toObject();
      delete data._id;
      foundry.utils.mergeObject(data, { name : module.i18n("spellActions.goodberry.name"), system : { quantity : count },
        flags : { [module.id] : { goodberry : { at : game.time.worldTime, caster : message.getAssociatedActor?.()?.uuid ?? null } } }, _stats : { compendiumSource : source.uuid } });
      await actor.createEmbeddedDocuments("Item", [data]);
    }
    await message.setFlag(module.id, key, true);
    return true;
  }

  /* ========== Water (Create or Destroy Water) ========== */

  static async waterStep(item, ctx, next){
    if(!this.enabled() || (idOf(item) !== this.WATER.id)) return next();
    const use = item.system.activities?.contents?.[0];
    if(!use) return next();
    const choice = await chooseOption({ title : item.name, icon : "fa-solid fa-droplet", prompt : module.i18n("spellActions.water.prompt"),
      options : [{ value : "fill", label : module.i18n("spellActions.water.fill") }, { value : "rain", label : module.i18n("spellActions.water.rain") }] });
    if(!choice) return null;
    const { chooseActivity, ...usage } = ctx.config ?? {};
    const caster = tokenOf(item.actor);
    if(choice === "fill"){
      /* No area to place : the card's rows are the creatures within range carrying a waterskin, each with its Fill */
      const near = caster ? canvas.tokens.placeables.filter(t => t.actor && ((t === caster) || (distanceBetween(t, caster) <= this.WATER.range))
        && t.actor.items.some(i => idOf(i) === "waterskin")) : [];
      if(!near.length) ui.notifications.info(module.i18n("spellActions.water.noSkins"));
      canvas.tokens.setTargets(near.map(t => t.id));
      return use.use({ ...usage, create : { ...(usage.create ?? {}), measuredTemplate : false },
        [module.id] : { ...(usage[module.id] ?? {}), skipPick : true, useTargets : true, cardFlags : { water : "fill" } } },
        ctx.dialog, foundry.utils.mergeObject(ctx.message ?? {}, { data : { flags : { [module.id] : { water : "fill" } } } }, { inplace : false }));
    }
    const result = await use.use({ ...usage, [module.id] : { ...(usage[module.id] ?? {}), skipPick : true } }, ctx.dialog, ctx.message);
    const regions = (result?.templates ?? []).map(t => (t?.document ?? t)?.uuid).filter(Boolean);
    if(result && regions.length) await gm.run("waterDouse", { item : item.uuid, regions });
    return result;
  }

  /* A Fill card's rows : the GM's Fill for that creature's waterskins (20 at most from one casting) */
  static fillButton(message, uuid, buttons){
    if(!game.user.isGM || (message?.getFlag?.(module.id, "water") !== "fill")) return;
    const actor = fromUuidSync(uuid, { strict : false })?.actor;
    const skins = actor?.items?.filter(i => idOf(i) === "waterskin") ?? [];
    if(!skins.length) return;
    const done = message.getFlag(module.id, `waterFilled.${uuid.replaceAll(".", "-")}`);
    const used = Object.values(message.getFlag(module.id, "waterFilled") ?? {}).reduce((n, v) => n + (Number(v) || 0), 0);
    buttons.push({ id : "waterFill", icon : "fa-droplet", disabled : !!done || (used >= this.WATER.skins),
      label : done ? module.format("spellActions.water.filledN", { n : done }) : module.format("spellActions.water.fillN", { n : skins.length }) });
  }

  static async fill(message, uuid){
    const key = `waterFilled.${uuid.replaceAll(".", "-")}`;
    const actor = fromUuidSync(uuid, { strict : false })?.actor;
    if(!game.user.isGM || !actor || message.getFlag(module.id, key)) return;
    const used = Object.values(message.getFlag(module.id, "waterFilled") ?? {}).reduce((n, v) => n + (Number(v) || 0), 0);
    const skins = actor.items.filter(i => idOf(i) === "waterskin").slice(0, Math.max(0, this.WATER.skins - used));
    /* Each skin holds 4 pints : dnd5e's Water, fresh (Pint), inside it, topped up to 4 */
    const source = await fromUuid(this.WATER.item).catch(() => null);
    if(!source) return ui.notifications.warn(module.i18n("spellActions.water.noItem"));
    for(const skin of skins){
      const inside = actor.items.filter(i => (i.system?.container === skin.id) && (idOf(i) === this.WATER.identifier));
      const have = inside.reduce((n, i) => n + (Number(i.system.quantity) || 0), 0);
      const need = Math.max(0, this.WATER.pints - have);
      if(!need) continue;
      if(inside.length) await inside[0].update({ "system.quantity" : (Number(inside[0].system.quantity) || 0) + need });
      else {
        const data = source.toObject();
        delete data._id;
        foundry.utils.mergeObject(data, { system : { container : skin.id, quantity : need }, _stats : { compendiumSource : source.uuid } });
        await actor.createEmbeddedDocuments("Item", [data]);
      }
    }
    await message.setFlag(module.id, key, skins.length);
  }

  /* GM : the flames inside the rain's area go out */
  static async douseAsGM({ item : itemUuid, regions = [] } = {}, user){
    const item = fromUuidSync(itemUuid ?? "", { strict : false });
    if(!item?.actor?.testUserPermission(user, "OWNER")) return false;
    const out = [];
    for(const uuid of regions){
      const region = fromUuidSync(uuid, { strict : false });
      if(!region) continue;
      for(const token of getTokensInArea(region, { includeHidden : true })){
        const actor = token.actor;
        if(!actor) continue;
        /* Held lights (torch, lamp, lantern, candle) */
        for(const id of Object.values(actor.getFlag(module.id, "hands") ?? {})){
          const held = id ? actor.items.get(id) : null;
          if(held && heldLight.sourceOf(held) && heldLight.isLit(actor, id)){ await heldLight.putOut(actor, id, { keepTime : true }); out.push(`${token.name} : ${held.name}`); }
        }
        /* Produce Flame */
        const flames = actor.effects.filter(e => idOf(originItem(e)) === "produce-flame");
        if(flames.length){ await actor.deleteEmbeddedDocuments("ActiveEffect", flames.map(e => e.id)).catch(() => {}); out.push(`${token.name} : ${flames[0].name}`); }
      }
    }
    await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor : item.actor }),
      content : `<p>${esc(out.length ? module.format("spellActions.water.doused", { list : out.join(", ") }) : module.i18n("spellActions.water.noFlames"))}</p>` });
    return true;
  }

  /* ========== Detection (Detect Evil and Good...) ========== */

  /* A coloured effect on the caster, tied to its Concentration (spell-effects) */
  static async detectionMark(activity){
    const color = this.DETECTION[idOf(activity?.item)];
    const actor = activity?.actor;
    if(!color || !this.enabled() || !actor?.isOwner) return;
    const item = actor.items.get(activity.item.id) ?? activity.item;
    if(actor.effects.some(e => !e.disabled && String(e.origin ?? "").startsWith(item.uuid) && e.getFlag(module.id, "detection"))) return;
    /* After dnd5e's Concentration lands, so the effect depends on it */
    await new Promise(resolve => setTimeout(resolve, 400));
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name : module.format("spellActions.detecting", { spell : item.name }), img : item.img, tint : color, origin : item.uuid,
      duration : activity.duration?.getEffectData?.() ?? {}, showIcon : CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2,
      flags : { [module.id] : { detection : true } },
    }]).catch(error => log.debug(error));
  }

  /* ========== Illusions (Disguise Self, Silent Image) ========== */

  static async illusionStep(item, ctx, next){
    const spec = this.ILLUSIONS[idOf(item)] ?? this.CAST_ONLY[idOf(item)];
    const use = spec ? item.system.activities?.find?.(a => a.type === (spec.type ?? "utility")) : null;
    if(!this.enabled() || !use) return next();
    const { chooseActivity, ...usage } = ctx.config ?? {};
    if(spec.watch !== "space") return use.use(usage, ctx.dialog, ctx.message);
    /* The image's space */
    const from = tokenOf(item.actor);
    if(!from) return use.use(usage, ctx.dialog, ctx.message);
    const size = Math.max(1, Math.round(spec.feet / canvas.scene.grid.distance));
    const space = await pickSpace(from, { range : Number(item.system.range?.value) || 60, size, occupied : true, notice : item.name });
    if(!space) return null;
    const result = await use.use({ ...usage, [module.id] : { ...(usage[module.id] ?? {}), skipPick : true } }, ctx.dialog, ctx.message);
    if(!result) return result;
    await gm.run("illusionMark", { item : item.uuid, scene : from.document.parent.id, x : space.x, y : space.y, size, dc : this.studyDC(item) });
    return result;
  }

  static studyDC(item){
    const check = item?.system?.activities?.find?.(a => a.type === "check");
    return Number(check?.check?.dc?.value) || Number(item?.actor?.system?.attributes?.spell?.dc) || 10;
  }

  /* GM : the image's area, ending with the caster's Concentration on it */
  static async illusionMarkAsGM({ item : itemUuid, scene : sceneId, x, y, size = 3, dc } = {}, user){
    const item = fromUuidSync(itemUuid ?? "", { strict : false });
    const scene = game.scenes.get(sceneId);
    if(!item?.actor?.testUserPermission(user, "OWNER") || !scene) return false;
    /* Cast again : the old image goes */
    const old = scene.regions.filter(r => r.getFlag(module.id, "illusion")?.item === item.uuid);
    if(old.length) await scene.deleteEmbeddedDocuments("Region", old.map(r => r.id)).catch(error => log.debug(error));
    const grid = scene.grid.size;
    const [region] = await scene.createEmbeddedDocuments("Region", [{
      name : module.format("spellActions.illusion.area", { spell : item.name }), color : "#b48cff",
      shapes : [{ type : "rectangle", x, y, width : size * grid, height : size * grid, rotation : 0 }],
      visibility : CONST.REGION_VISIBILITY?.ALWAYS ?? 2,
      flags : { [module.id] : { illusion : { item : item.uuid, caster : item.actor.uuid, dc, seen : [] } } },
    }]);
    /* Its Concentration (dnd5e starts it as the spell is cast) : the area is one of its dependents */
    let concentration = null;
    for(let i = 0; (i < 10) && !concentration; i++){
      concentration = item.actor.effects.find(e => e.statuses?.has?.(CONFIG.specialStatusEffects.CONCENTRATING) && (e.getFlag("dnd5e", "item")?.id === item.id)) ?? null;
      if(!concentration) await new Promise(r => setTimeout(r, 150));
    }
    if(concentration && region){
      await concentration.setFlag("dnd5e", "dependents", [...(concentration.getFlag("dnd5e", "dependents") ?? []), { uuid : region.uuid }]);
      await region.setFlag(module.id, "illusion.concentration", concentration.uuid);
    }
    await this.watchIllusions(scene);
    return true;
  }

  static async illusionEnded(effect, userId){
    const mine = (userId === game.user.id) && game.user.isGM;
    if(!(game.users.activeGM?.isSelf || mine) || !effect?.statuses?.has?.(CONFIG.specialStatusEffects?.CONCENTRATING ?? "concentrating")) return;
    const itemUuid = effect.getFlag("dnd5e", "item")?.uuid;
    if(!itemUuid) return;
    for(const scene of game.scenes){
      /* The image's area, and any area the spell placed (Fog Cloud, Entangle...) : they end with its Concentration */
      const ids = scene.regions.filter(r => (r.getFlag(module.id, "illusion")?.item === itemUuid) || (r.getFlag(module.id, "illusion")?.concentration === effect.uuid)
        || (r.getFlag("dnd5e", "item") === itemUuid)).map(r => r.id);
      if(ids.length) await scene.deleteEmbeddedDocuments("Region", ids).catch(error => log.debug(error));
    }
  }

  /* Hostile to the caster : the other side (a Neutral caster : anyone not Neutral). Documents. GM-hidden ones count */
  static hostileTo(token, caster){
    const D = CONST.TOKEN_DISPOSITIONS;
    if(!token?.actor || (token === caster) || (token.disposition === D.SECRET)) return false;
    const mine = caster?.disposition ?? D.NEUTRAL;
    if(mine === D.FRIENDLY) return token.disposition === D.HOSTILE;
    if(mine === D.HOSTILE) return token.disposition === D.FRIENDLY;
    return token.disposition !== D.NEUTRAL;
  }

  static centreOf(token){
    const grid = token.parent.grid.size;
    return { x : token.x + ((token.width * grid) / 2), y : token.y + ((token.height * grid) / 2) };
  }

  /* A wall that blocks sight between two points, from the scene's own walls (no canvas needed : any scene) */
  static sightBlocked(scene, a, b){
    const { NONE } = CONST.WALL_SENSE_TYPES;
    const OPEN = CONST.WALL_DOOR_STATES?.OPEN ?? 1;
    for(const wall of scene.walls){
      if((wall.sight === NONE) || (wall.door && (wall.ds === OPEN))) continue;
      const [x0, y0, x1, y1] = wall.c;
      if(foundry.utils.lineSegmentIntersects(a, b, { x : x0, y : y0 }, { x : x1, y : y1 })) return true;
    }
    return false;
  }

  /* Can this creature see that point : not Blinded, no wall in the way */
  static sees(token, point){
    if(token.actor?.statuses?.has?.("blinded")) return false;
    return !this.sightBlocked(token.parent, this.centreOf(token), point);
  }

  /* Each illusion on the scene : hostile creatures that see it now, and haven't yet, get their Study (the active GM) */
  static async watchIllusions(scene){
    if(!game.users.activeGM?.isSelf || !this.enabled() || !scene) return;
    const tokens = scene.tokens.contents;
    /* Disguised casters (not while Invisible : nothing to see) */
    for(const caster of tokens){
      const actor = caster.actor;
      const effect = actor?.effects?.find?.(e => !e.disabled && (this.ILLUSIONS[idOf(originItem(e))]?.watch === "caster"));
      if(!effect || actor.statuses?.has?.("invisible") || caster.hidden) continue;
      const seen = new Set(effect.getFlag(module.id, "seenBy") ?? []);
      const fresh = tokens.filter(t => this.hostileTo(t, caster) && !seen.has(t.actor.uuid) && this.sees(t, this.centreOf(caster)));
      if(!fresh.length) continue;
      await effect.setFlag(module.id, "seenBy", [...seen, ...fresh.map(t => t.actor.uuid)]);
      await this.studyCard(fresh, originItem(effect));
    }
    /* Images */
    for(const region of scene.regions.filter(r => r.getFlag(module.id, "illusion"))){
      const data = region.getFlag(module.id, "illusion");
      const item = fromUuidSync(data.item ?? "", { strict : false });
      const caster = scene.tokens.find(t => t.actor?.uuid === data.caster) ?? scene.tokens.find(t => t.actorId === item?.actor?.id) ?? null;
      const shape = region.shapes?.[0];
      if(!shape) continue;
      const point = { x : shape.x + (shape.width / 2), y : shape.y + (shape.height / 2) };
      const seen = new Set(data.seen ?? []);
      const fresh = tokens.filter(t => this.hostileTo(t, caster) && !seen.has(t.actor.uuid) && this.sees(t, point));
      if(!fresh.length) continue;
      await region.setFlag(module.id, "illusion.seen", [...seen, ...fresh.map(t => t.actor.uuid)]);
      await this.studyCard(fresh, item, data.dc);
    }
  }

  /* Their Study : a Roll Request card (whispered to the GM and their owners), a row each : Investigation against the DC */
  static async studyCard(tokens, item, dc = null){
    dc ??= this.studyDC(item);
    const who = tokens.map(t => ({ actor : t.actor.uuid, token : t.uuid, name : t.name, img : t.texture?.src || t.actor.img }));
    await rollRequests.request({ who, what : "skill:inv", dc, whisper : true, hideDC : false,
      label : module.format("spellActions.illusion.studyTitle", { spell : item?.name ?? "" }),
      outcomes : { success : module.i18n("spellActions.illusion.seesThrough"), failure : module.i18n("spellActions.illusion.fooled") } });
  }

  /* ========== Message ========== */

  /* Who can hear it : seen creatures in range, and the player characters in range (around barriers too) */
  static messageTargets(from, range){
    const pc = t => t.actor?.hasPlayerOwner && (t.actor.type === "character");
    /* Not creatures : Dancing Lights, a Mage Hand; nor hidden tokens */
    const thing = t => t.document.hidden || t.document.getFlag(module.id, "dancingLight") || t.document.getFlag(module.id, "placedSummon");
    return canvas.tokens.placeables.filter(t => (t !== from) && t.actor && !thing(t) && (distanceBetween(from, t) <= range) && (pc(t) || canSee(from, t)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /* Its players (the GM for a monster) */
  static listeners(actor){
    const players = ownerIds(actor, { players : true });
    return players.length ? players : game.users.filter(u => u.isGM).map(u => u.id);
  }

  static async messageStep(activity, ctx, next){
    if(!this.enabled() || (idOf(activity?.item) !== this.MESSAGE)) return next();
    const from = tokenOf(activity.actor);
    if(!from) return next();
    const range = getRange(activity) || 120;
    const candidates = this.messageTargets(from, range);
    if(!candidates.length) return ui.notifications.warn(module.format("spellActions.messageNobody", { feet : range }));
    let picked = null;
    await foundry.applications.api.DialogV2.wait({
      window : { title : activity.item.name, icon : "fa-solid fa-comment-dots" },
      content : `<div class="form-group"><label>${esc(module.i18n("spellActions.messageTo"))}</label>
          <select name="to">${candidates.map(t => `<option value="${t.document.uuid}">${esc(t.name)}</option>`).join("")}</select></div>
        <div class="form-group stacked"><label>${esc(module.i18n("spellActions.messageText"))}</label><textarea name="text" rows="3"></textarea></div>`,
      buttons : [{ action : "send", label : module.i18n("spellActions.messageSend"), icon : "fa-solid fa-paper-plane", default : true,
        callback : (event, button) => { picked = { to : button.form.elements.to.value, text : button.form.elements.text.value.trim() }; } },
        { action : "cancel", label : game.i18n.localize("Cancel"), icon : "fa-solid fa-xmark" }],
      rejectClose : false,
    }).catch(() => null);
    if(!picked?.to || !picked.text) return;
    const target = fromUuidSync(picked.to, { strict : false });
    if(!target?.actor) return;
    uses.mark(ctx, { skipPick : true });
    const result = await next();
    if(!result) return result;
    const caster = activity.actor;
    await ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor : caster }),
      whisper : [...new Set([...this.listeners(target.actor), ...ownerIds(caster), ...game.users.filter(u => u.isGM).map(u => u.id), game.user.id])],
      content : `<p><strong>${esc(module.format("spellActions.messageHead", { from : caster.name, to : target.name }))}</strong></p><p>${esc(picked.text)}</p>`,
      flags : { [module.id] : { spellMessage : { from : caster.uuid, to : target.actor.uuid, toName : target.name } } },
    });
    return result;
  }

  /* The one it was sent to : Reply, whispered back to the sender's players */
  static replyButton(message, html){
    const data = message.getFlag?.(module.id, "spellMessage");
    if(!data || data.replied) return;
    const to = fromUuidSync(data.to ?? "", { strict : false });
    const from = fromUuidSync(data.from ?? "", { strict : false });
    if(!to || !from || !this.listeners(to).includes(game.user.id)) return;
    const row = buttonRow(html, { key : `${module.id}-message-reply` });
    if(row.childElementCount) return;
    addButton(row, makeButton({ icon : "fa-reply", text : module.i18n("spellActions.messageReply"), once : true, onClick : async () => {
      let text = null;
      await foundry.applications.api.DialogV2.wait({
        window : { title : module.i18n("spellActions.messageReply"), icon : "fa-solid fa-reply" },
        content : `<div class="form-group stacked"><textarea name="text" rows="3"></textarea></div>`,
        buttons : [{ action : "send", label : module.i18n("spellActions.messageSend"), icon : "fa-solid fa-paper-plane", default : true,
          callback : (event, button) => { text = button.form.elements.text.value.trim(); } }],
        rejectClose : false,
      }).catch(() => null);
      if(!text) return;
      await ChatMessage.implementation.create({
        speaker : { alias : data.toName ?? to.name },
        whisper : [...new Set([...ownerIds(from, { players : true }), ...this.listeners(to), ...game.users.filter(u => u.isGM).map(u => u.id), game.user.id])],
        content : `<p><strong>${esc(module.format("spellActions.messageReplyHead", { from : data.toName ?? to.name, to : from.name }))}</strong></p><p>${esc(text)}</p>`,
      });
    } }));
  }

  /* ========== Placed summons (Mage Hand) ========== */

  static async placedStep(activity, ctx, next){
    const spec = this.PLACED[idOf(activity?.item)];
    const profile = activity?.availableProfiles?.[0] ?? activity?.profiles?.[0];
    if(!this.enabled() || !spec || (activity.type !== "summon") || !profile?.uuid) return next();
    const from = tokenOf(activity.actor);
    if(!from) return next();
    /* One out already : move it, or a new one */
    if(spec.move && this.placedOf(activity.item.uuid).length){
      const choice = await chooseOption({ title : activity.item.name, icon : "fa-solid fa-hand", prompt : module.i18n("spellActions.placedPrompt"),
        options : [{ value : "move", label : module.format("spellActions.placedMove", { feet : spec.move, action : module.i18n(`spellActions.action.${spec.action}`) }) },
          { value : "new", label : module.i18n("spellActions.placedNew") }] });
      if(!choice) return;
      if(choice === "move"){
        await gm.run("placedMove", { item : activity.item.uuid });
        await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor : activity.actor }),
          content : `<p>${esc(module.format("spellActions.placedMoved", { name : activity.actor.name, spell : activity.item.name, feet : spec.move, action : module.i18n(`spellActions.action.${spec.action}`) }))}</p>`,
          flags : { [module.id] : { actionUsed : { type : spec.action, item : activity.item.uuid } } } });
        return null;
      }
    }
    const range = getRange(activity) || spec.leash;
    const space = await pickSpace(from, { range, notice : activity.item.name });
    if(!space) return;
    uses.mark(ctx, { skipPick : true });
    ctx.config = { ...ctx.config, create : { ...(ctx.config?.create ?? {}), summons : false } };
    const result = await next();
    if(!result) return result;
    try {
      await gm.run("placedSummon", { item : activity.item.uuid, activity : activity.id, profile : profile._id, scene : from.document.parent.id,
        x : space.x, y : space.y, elevation : from.document.elevation ?? 0, caster : from.document.uuid });
    } catch(error){
      log.error(error);
      ui.notifications.warn(error.message);
    }
    return result;
  }

  static placedOf(itemUuid){
    return game.scenes.contents.flatMap(s => s.tokens.filter(t => t.getFlag(module.id, "placedSummon")?.item === itemUuid));
  }

  static async removeTokens(tokens){
    const byScene = new Map();
    for(const t of tokens) byScene.set(t.parent, [...(byScene.get(t.parent) ?? []), t.id]);
    for(const [scene, ids] of byScene) await scene.deleteEmbeddedDocuments("Token", ids).catch(error => log.debug(error));
  }

  /* GM : the token in the picked space, through dnd5e's summon data, owned by the caster's players */
  static async placedAsGM({ item : itemUuid, activity : activityId, profile : profileId, scene : sceneId, x, y, elevation = 0, caster } = {}, user){
    const item = fromUuidSync(itemUuid ?? "", { strict : false });
    const activity = item?.system?.activities?.get?.(activityId);
    const spec = this.PLACED[idOf(item)];
    const scene = game.scenes.get(sceneId);
    if(!activity || !spec || !scene || !item.actor?.testUserPermission(user, "OWNER")) return false;
    const profile = activity.profiles.find(p => p._id === profileId) ?? activity.profiles[0];
    const actor = profile?.uuid ? await dnd5e.documents.Actor5e.fetchExisting(profile.uuid, { origin : { key : "flags.dnd5e.summon.origin", value : item.uuid } }).catch(error => { log.error(error); return null; }) : null;
    if(!actor) return false;
    /* Cast again : the old one goes */
    await this.endPlaced(this.placedOf(item.uuid));
    const options = { profile : profile._id };
    const changes = await activity.getChanges(actor, profile, options);
    /* No one's ally (not beside a target for flanking or Sneak Attack); no speed until it's moved */
    changes.tokenUpdates.disposition = CONST.TOKEN_DISPOSITIONS.NEUTRAL;
    /* Invisible : its owners see it through its own senses (a token without vision would be hidden from them too) */
    if(spec.sight) changes.tokenUpdates.sight = { enabled : true, range : spec.sight };
    for(const kind of ["walk", "fly", "climb", "swim", "burrow"]) changes.actorUpdates[`system.attributes.movement.speeds.${kind}`] = "0";
    const owners = Object.fromEntries(game.users.filter(u => !u.isGM && item.actor.testUserPermission(u, "OWNER")).map(u => [u.id, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER]));
    changes.actorUpdates.ownership = { ...(actor.ownership ?? {}), ...owners };
    const config = { actor, placement : { x, y, elevation, rotation : 0 }, ...changes };
    if(Hooks.call("dnd5e.preSummonToken", activity, profile, config, options) === false) return false;
    const tokenData = await activity.getTokenData(config);
    const { value, units } = item.system?.duration ?? {};
    const seconds = (Number(value) || 0) * ({ minute : 60, hour : 3600, day : 86400, round : 6, turn : 6 }[units] ?? 0);
    const from = caster ? fromUuidSync(caster, { strict : false }) : null;
    foundry.utils.setProperty(tokenData, `flags.${module.id}.placedSummon`, { item : item.uuid, caster : caster ?? null,
      leash : spec.follow ? spec.leash : (getRange(activity) || spec.leash), ends : seconds ? game.time.worldTime + seconds : null,
      ...(spec.follow ? { follow : spec.follow, carry : spec.carry ?? null, trail : from ? [{ x : from.x, y : from.y, elevation : from.elevation ?? 0 }] : [] } : {}) });
    /* Its art from a module that isn't on (dnd5e's Floating Disk : the Player's Handbook) : the creature's picture */
    const art = foundry.utils.getProperty(tokenData, "texture.src") ?? "";
    const artModule = art.match(/^modules\/([^/]+)\//)?.[1];
    if(artModule && !game.modules.get(artModule)?.active) foundry.utils.setProperty(tokenData, "texture.src", actor.img);
    Hooks.callAll("dnd5e.summonToken", activity, profile, tokenData, options);
    tokenData.disposition = CONST.TOKEN_DISPOSITIONS.NEUTRAL;
    if(spec.sight) foundry.utils.setProperty(tokenData, "sight.enabled", true), foundry.utils.setProperty(tokenData, "sight.range", spec.sight);
    const created = await scene.createEmbeddedDocuments("Token", [tokenData], { dnd5e : { autoRollNPCHP : "no" } });
    Hooks.callAll("dnd5e.postSummon", activity, profile, created, options);
    if(spec.invisible) for(const token of created ?? []) await token.actor?.toggleStatusEffect("invisible", { active : true }).catch(error => log.debug(error));
    return true;
  }

  /* GM : moved this turn : its speed until the end of the caster's turn */
  static async placedMoveAsGM({ item : itemUuid } = {}, user){
    const item = fromUuidSync(itemUuid ?? "", { strict : false });
    const spec = this.PLACED[idOf(item)];
    if(!spec || !item.actor?.testUserPermission(user, "OWNER")) return false;
    for(const token of this.placedOf(item.uuid)){
      if(!token.actor) continue;
      await addTimedEffect(token.actor, { name : module.format("spellActions.placedMoving", { feet : spec.move }), img : "icons/svg/wingfoot.svg", origin : item.uuid,
        changes : ["walk", "fly"].map(kind => ({ key : `system.attributes.movement.speeds.${kind}`, type : "override", mode : 5, value : String(spec.move) })) },
        { of : item.actor, until : "turnEnd" });
    }
    return true;
  }

  /* Beyond its leash from the caster (either moved) : it vanishes */
  static async placedMoved(token, changes){
    if(!game.users.activeGM?.isSelf || !(("x" in (changes ?? {})) || ("y" in (changes ?? {})))) return;
    const scene = token.parent;
    const flag = token.getFlag(module.id, "placedSummon");
    const casterOf = f => { const t = f?.caster ? fromUuidSync(f.caster, { strict : false }) : null; return (t?.parent === scene) ? t : null; };
    const pairs = flag ? [[token, casterOf(flag)]] : scene.tokens.filter(t => t.getFlag(module.id, "placedSummon")?.caster === token.uuid).map(t => [t, token]);
    const centre = t => ({ x : t.x + (t.width * scene.grid.size / 2), y : t.y + (t.height * scene.grid.size / 2) });
    const far = pairs.filter(([s, c]) => c && (scene.grid.measurePath([centre(s), centre(c)]).distance > (Number(s.getFlag(module.id, "placedSummon")?.leash) || 30))).map(([s]) => s);
    if(far.length) await this.endPlaced(far);
  }

  /* Its duration passed on the world clock */
  static async placedExpire(){
    if(!game.users.activeGM?.isSelf) return;
    const done = game.scenes.contents.flatMap(s => s.tokens.filter(t => { const ends = t.getFlag(module.id, "placedSummon")?.ends; return Number.isFinite(ends) && (game.time.worldTime >= ends); }));
    if(done.length) await this.endPlaced(done);
  }

  /* Gone : a disk that carried something leaves its load on the ground (a token its owners can still empty) */
  static async endPlaced(tokens){
    const loads = tokens.filter(t => t.getFlag(module.id, "placedSummon")?.carry && t.actor?.items?.some(i => this.weightOf(i) > 0));
    for(const token of loads){
      await token.update({ name : module.format("spellActions.disk.load", { name : token.name }), "texture.src" : this.DISK_LOAD_ART,
        [`flags.${module.id}.diskLoad`] : true, [`flags.${module.id}.placedSummon`] : globalThis._del ?? new foundry.data.operators.ForcedDeletion() }).catch(error => log.debug(error));
    }
    await this.removeTokens(tokens.filter(t => !loads.includes(t)));
  }

  /* ========== Floating Disk ========== */

  static DISK_LOAD_ART = "icons/containers/bags/sack-simple-leather-brown.webp";

  /* An item's weight in lb (its quantity's) : what rides on the disk */
  static weightOf(item){
    const w = item?.system?.weight;
    if(w === undefined) return 0;
    const value = Number((typeof w === "object") ? w.value : w) || 0;
    const kg = (typeof w === "object") && (w.units === "kg");
    return value * (kg ? 2.2 : 1) * (Number(item.system?.quantity ?? 1) || 0);
  }

  static diskOf(actor){
    const flag = actor?.isToken ? actor.token?.getFlag?.(module.id, "placedSummon") : null;
    return Number(flag?.carry) > 0 ? flag : null;
  }

  /* More than it carries (500 lb) : refused */
  static diskWeight(item, change = null){
    const actor = item?.parent;
    const disk = this.diskOf(actor);
    if(!disk) return;
    const now = actor.items.reduce((sum, i) => sum + ((i.id === item.id) ? 0 : this.weightOf(i)), 0);
    const next = change ? this.weightOf({ system : foundry.utils.mergeObject(item.toObject().system, foundry.utils.expandObject(change).system ?? {}, { inplace : false }) }) : this.weightOf(item);
    if(now + next <= disk.carry) return;
    ui.notifications.warn(module.format("spellActions.disk.full", { name : actor.name, max : disk.carry, total : Math.round(now + next) }));
    return false;
  }

  /* The caster moved : its path is the disk's; more than 20 ft away, the disk goes along it until it's within 20 ft */
  static async diskFollow(token, movement){
    if(!game.users.activeGM?.isSelf || !this.enabled()) return;
    const scene = token.parent;
    const disks = scene?.tokens?.filter(t => { const f = t.getFlag(module.id, "placedSummon"); return f?.follow && (f.caster === token.uuid); }) ?? [];
    if(!disks.length) return;
    /* Teleported (a GM's drag with the teleport key, Misty Step) : no steps to follow */
    const passed = movement.passed?.waypoints ?? [];
    if(passed.length && passed.every(p => p.action === "displace")) return;
    const grid = scene.grid;
    const size = grid.size;
    const centreOf = (p, w = 1, h = 1) => ({ x : p.x + (w * size / 2), y : p.y + (h * size / 2) });
    /* Its steps, square by square (the disk is one square) */
    const points = [movement.origin, ...(movement.passed?.waypoints ?? [])].filter(Boolean).map(p => ({ x : p.x, y : p.y, elevation : p.elevation ?? 0 }));
    const steps = [];
    for(let i = 1; i < points.length; i++){
      const a = centreOf(points[i - 1], token.width, token.height), b = centreOf(points[i], token.width, token.height);
      const cells = grid.isGridless ? [] : grid.getDirectPath([a, b]);
      if(!cells.length) steps.push({ x : b.x - (size / 2), y : b.y - (size / 2), elevation : points[i].elevation });
      for(const cell of cells){ const tl = grid.getTopLeftPoint(cell); steps.push({ x : tl.x, y : tl.y, elevation : points[i].elevation }); }
    }
    const dest = centreOf(movement.destination ?? token, token.width, token.height);
    const far = p => grid.measurePath([centreOf(p), dest]).distance;
    for(const disk of disks){
      const flag = disk.getFlag(module.id, "placedSummon");
      const trail = [...(flag.trail ?? []), ...steps].filter((p, i, all) => !i || (p.x !== all[i - 1].x) || (p.y !== all[i - 1].y)).slice(-300);
      const stop = (far(disk) > flag.follow) ? trail.findIndex(p => far(p) <= flag.follow) : -1;
      await disk.update({ [`flags.${module.id}.placedSummon.trail`] : (stop < 0) ? trail : trail.slice(stop) });
      if(stop < 0) continue;
      await disk.move(trail.slice(0, stop + 1).map(p => ({ x : p.x, y : p.y, elevation : p.elevation })),
        { autoRotate : false, showRuler : false, constrainOptions : { ignoreWalls : true, ignoreCost : true } }).catch(error => log.debug("Disk follow", error));
    }
  }

  /* ========== Hellish Rebuke ========== */

  /* A reaction spell it can cast now : it can react (not incapacitated, not at 0 HP), the spell ready (prepared, or
     always ready) and a slot for it : { spell, slot } or null */
  static OUT = ["incapacitated", "unconscious", "paralyzed", "petrified", "stunned", "dead"];
  static reactionReady(actor, id){
    if(!actor || this.OUT.some(s => actor.statuses?.has(s)) || (Number(actor.system?.attributes?.hp?.value) <= 0)) return null;
    /* Its Reaction already used (Action Tracker) */
    if(!actionTracker.left(actor, "reaction")) return null;
    const spell = actor?.items?.find?.(i => (i.type === "spell") && (idOf(i) === id) && ((i.system.method !== "spell") || (Number(i.system.prepared) > 0)));
    if(!spell) return null;
    const slots = Object.entries(actor.system?.spells ?? {})
      .filter(([, s]) => (Number(s?.value) > 0) && (Number(s?.level) >= 1))
      .sort(([, a], [, b]) => a.level - b.level);
    return slots.length ? { spell, slot : slots[0][0] } : null;
  }

  static rebukeKey(uuid){
    return `rebuked.${String(uuid).replaceAll(".", "-")}`;
  }

  /* The damaged creature's row : once this card's damage is applied to it */
  static rebukeButton(message, uuid, buttons){
    if(!this.enabled()) return;
    const token = fromUuidSync(uuid, { strict : false });
    const actor = token?.actor;
    if(!actor || !(actor.isOwner) || message.getFlag?.(module.id, this.rebukeKey(uuid))) return;
    const hurt = Object.values(actor.getFlag(module.id, `applied.${message.id}`) ?? {}).some(v => Number(v) > 0);
    if(!hurt || !this.reactionReady(actor, this.REBUKE.spell)) return;
    const from = message.getAssociatedToken?.() ?? null;
    const attacker = from?.object ?? tokenOf(message.getAssociatedActor?.());
    if(!attacker || (attacker.actor === actor) || !token.object || (distanceBetween(token.object, attacker) > this.REBUKE.range)) return;
    buttons.push({ id : "hellishRebuke", icon : "fa-fire", label : module.i18n("spellActions.rebuke") });
  }

  /* Cast at the one who did it (its save card), the slot spent; the card remembers */
  static async rebuke(message, uuid){
    const token = fromUuidSync(uuid, { strict : false });
    const actor = token?.actor;
    const ready = actor?.isOwner ? this.reactionReady(actor, this.REBUKE.spell) : null;
    const attacker = message.getAssociatedToken?.()?.object ?? tokenOf(message.getAssociatedActor?.());
    if(!ready || !attacker || message.getFlag(module.id, this.rebukeKey(uuid))) return;
    const save = ready.spell.system.activities?.find?.(a => a.type === "save") ?? ready.spell.system.activities?.contents?.[0];
    if(!save) return;
    canvas.tokens.setTargets([attacker.id]);
    const used = await save.use({ spell : { slot : ready.slot }, [module.id] : { skipPick : true, useTargets : true } }, { configure : false });
    if(used) await gm.run("spellRebuked", { message : message.id, token : uuid });
  }

  static async rebukedAsGM({ message : id, token : uuid } = {}, user){
    const message = game.messages.get(id);
    const actor = fromUuidSync(uuid ?? "", { strict : false })?.actor;
    if(!message || !actor?.testUserPermission(user, "OWNER")) return false;
    await message.setFlag(module.id, this.rebukeKey(uuid), true);
    return true;
  }

  /* ========== Shield ========== */

  /* Its Shield spell, ready to cast (prepared, or always ready), with a slot for it : { spell, slot } or null */
  static shieldReady(actor){
    const ready = this.reactionReady(actor, this.SHIELD.spell);
    /* Shield is already up (its +5 counts on new attacks) */
    if(!ready || actor.effects.some(e => !e.disabled && String(e.origin ?? "").startsWith(ready.spell.uuid))) return null;
    return ready;
  }

  static shieldKey(uuid){
    return `shielded.${String(uuid).replaceAll(".", "-")}`;
  }

  /* Attack cards : each hit creature you own that can cast Shield */
  static shieldButtons(message, buttons, { ray } = {}){
    if(!this.enabled() || (message.type !== TYPES.attack) || (typeof message.system?.raiseAC !== "function")) return;
    /* A critical hit hits whatever the AC */
    if(message.system.attackOf?.(ray)?.isCritical) return;
    for(const hit of message.system.hitTargets?.(ray) ?? []){
      const token = hit?.document ?? hit;
      if(!token?.actor?.isOwner || message.getFlag(module.id, this.shieldKey(token.uuid)) || !this.shieldReady(token.actor)) continue;
      buttons.push({ id : `shield|${token.uuid}`, icon : "fa-shield-halved", label : module.i18n("spellActions.shield"),
        tooltip : module.format("spellActions.shieldTip", { name : token.name, ac : this.SHIELD.ac }) });
    }
  }

  /* Magic Missile cards : a Shield button for each target you own that can cast it */
  static missileShieldButtons(message, html){
    /* dnd5e's own turn / rest messages have no item (asking throws) */
    let item = null;
    try { item = message.getAssociatedItem?.(); } catch { return; }
    if(!this.enabled() || !this.SHIELD.negates.includes(idOf(item))) return;
    const mine = (message.system?.targets ?? []).map(t => fromUuidSync(t.token, { strict : false })).filter(t => t?.actor?.isOwner && this.shieldReady(t.actor));
    const done = (message.system?.targets ?? []).map(t => fromUuidSync(t.token, { strict : false })).filter(t => t?.actor?.isOwner && message.getFlag(module.id, this.shieldKey(t.uuid)));
    if(!mine.length && !done.length) return;
    const row = buttonRow(html, { key : `${module.id}-spell-shield` });
    if(row.childElementCount) return;
    for(const token of [...new Set([...mine, ...done])]){
      addButton(row, makeButton({ icon : "fa-shield-halved", once : true, disabled : !!message.getFlag(module.id, this.shieldKey(token.uuid)),
        text : module.format("spellActions.shieldMissile", { name : token.name }), onClick : () => this.shield(message, token.uuid) }));
    }
  }

  /* Cast it (its slot, its effect), then the card : the hit judged again at AC +5, or no Magic Missile damage */
  static async shield(message, uuid){
    const token = fromUuidSync(uuid, { strict : false });
    const actor = token?.actor;
    const ready = actor?.isOwner && this.shieldReady(actor);
    if(!ready || message.getFlag(module.id, this.shieldKey(uuid))) return;
    const { spell, slot } = ready;
    const activity = spell.system.activities?.find?.(a => a.effects?.length) ?? spell.system.activities?.contents?.[0];
    if(!activity) return;
    const used = await activity.use({ spell : { slot }, [module.id] : { skipPick : true } }, { configure : false });
    if(!used) return;
    /* Its effect on the caster, if the cast didn't put it there (it lands a moment after the use) */
    const up = () => actor.effects.some(e => !e.disabled && String(e.origin ?? "").startsWith(spell.uuid));
    for(let i = 0; (i < 8) && !up(); i++) await new Promise(resolve => setTimeout(resolve, 250));
    if(!up()){
      const datas = spell.effects.filter(e => !e.transfer && (e.type !== "enchantment")).map(e => ({ ...e.toObject(), _id : undefined, origin : spell.uuid, disabled : false }));
      if(datas.length) await actor.createEmbeddedDocuments("ActiveEffect", datas).catch(() => {});
    }
    const missile = this.SHIELD.negates.includes(idOf(message.getAssociatedItem?.()));
    await gm.run("spellShield", { message : message.id, target : uuid, ac : missile ? 0 : this.SHIELD.ac });
  }

  /* GM : the card remembers it, and an attack card raises that creature's AC */
  static async shieldAsGM({ message : id, target : uuid, ac = 0 } = {}, user){
    const message = game.messages.get(id);
    const token = fromUuidSync(uuid ?? "", { strict : false });
    if(!message || !token?.actor?.testUserPermission(user, "OWNER") || message.getFlag(module.id, this.shieldKey(uuid))) return false;
    await message.setFlag(module.id, this.shieldKey(uuid), true);
    if(ac && (typeof message.system?.raiseAC === "function")) await message.system.raiseAC(uuid, ac);
    return true;
  }

  /* Damage from a Magic Missile card that creature shielded itself from : none */
  static shieldedFrom(actor, damages, options = {}){
    const message = options.origin ?? options.originatingMessage;
    if(!message?.getFlag || !this.SHIELD.negates.includes(idOf(message.getAssociatedItem?.()))) return;
    const token = actor.token ?? actor.getActiveTokens?.(false, true)?.[0];
    if(!token || !message.getFlag(module.id, this.shieldKey(token.uuid))) return;
    for(const d of Array.isArray(damages) ? damages : []) d.value = 0;
    if(Number.isFinite(damages?.amount)) damages.amount = 0;
  }

  /* ========== Light (Light, Produce Flame) ========== */

  static lightOf(activity){
    const spec = this.LIGHTS[idOf(activity?.item)];
    if(!spec || (spec.activity && !spec.activity.test(activity.name ?? ""))) return null;
    return spec;
  }

  static async lightStep(activity, ctx, next){
    const spec = this.enabled() ? this.lightOf(activity) : null;
    if(!spec) return next();
    const actor = activity.actor, caster = tokenOf(actor);
    if(!caster) return next();
    let where = ctx.config?.[module.id]?.lightWhere ?? null;
    if(where) {}
    else if(spec.place === "self") where = { token : caster.document.uuid };
    else {
      const how = await chooseOption({ title : activity.item.name, icon : "fa-solid fa-lightbulb", prompt : module.i18n("spellActions.lightWhere"),
        options : [{ value : "token", label : module.i18n("spellActions.lightToken") }, { value : "square", label : module.i18n("spellActions.lightSquare") }] });
      if(!how) return;
      const reach = canvas.scene?.grid.distance ?? 5;
      if(how === "token"){
        const [token] = await pickTargets(activity.item, { count : 1, range : reach, disposition : "any", includeSelf : true, useTargets : false, sight : false });
        if(!token) return;
        where = { token : token.document.uuid };
      }
      else {
        const space = await pickSpace(caster, { range : reach, occupied : true, banner : activity.item.name });
        if(!space) return;
        where = { scene : canvas.scene.id, x : space.x + (canvas.grid.size / 2), y : space.y + (canvas.grid.size / 2) };
      }
    }
    /* No summoning (Plutonium's Light is a summon) : the light is ours */
    ctx.config = { ...ctx.config, create : { ...(ctx.config?.create ?? {}), summons : false } };
    const result = await next();
    if(!result) return result;
    /* Cast again : the old light goes */
    const old = actor.effects.filter(e => e.getFlag(module.id, "spellLight")?.item === activity.item.uuid);
    if(old.length) await actor.deleteEmbeddedDocuments("ActiveEffect", old.map(e => e.id));
    const made = await gm.run("spellLight", { ...where, light : spec.light, key : `spell-${activity.item.id}` });
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name : activity.item.name, img : activity.item.img, origin : activity.item.uuid,
      duration : { value : Math.round(spec.seconds / 60), units : "minutes" },
      flags : { [module.id] : { spellLight : { item : activity.item.uuid, key : `spell-${activity.item.id}`, ...where, light : made?.light ?? null } } },
    }]);
    return result;
  }

  /* GM : the light on a token (its own light, remembered to put back) or a light on a square */
  static async lightAsGM({ token, scene, x, y, light, key } = {}){
    if(token){
      const doc = fromUuidSync(token, { strict : false });
      if(doc) await addLight(doc, light, { key });
      return { token };
    }
    const target = game.scenes.get(scene);
    if(!target) return null;
    const [ambient] = await target.createEmbeddedDocuments("AmbientLight", [{ x, y, config : { ...light }, flags : { [module.id] : { spellLight : key } } }]);
    return { light : ambient?.id ?? null };
  }

  static async lightOffAsGM({ token, scene, light, key } = {}){
    if(token){
      const doc = fromUuidSync(token, { strict : false });
      if(doc) await removeLight(doc, { key });
      return true;
    }
    const target = game.scenes.get(scene);
    if(target && light && target.lights.get(light)) await target.deleteEmbeddedDocuments("AmbientLight", [light]);
    return true;
  }

  /* The caster's effect ended (expired, deleted, cast again) : the light goes (the active GM) */
  static async onLightEnded(effect){
    const data = effect?.getFlag?.(module.id, "spellLight");
    if(!data || !game.users.activeGM?.isSelf) return;
    await this.lightOffAsGM(data).catch(error => log.debug(error));
  }
}
