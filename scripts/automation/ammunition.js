import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { esc, idOf, gmIds, buttonRow, addButton, makeButton } from '../helpers/utils.js';
const log = logger.for(import.meta.url);

/**
 * Ammunition Recovery (Helpers) : what was shot or thrown in a fight can be found after it. Counted during combat on
 * each attacker : every attack with an Ammunition weapon (the ammo item it used, and the ammunition type), and every
 * thrown attack (not Returning).
 *   Ammunition : half can be found (2024 : a minute's search, half rounded down, the rest lost; Homebrew : or an odd
 *                one by 1d2).
 *   Thrown     : nothing breaks a thrown weapon, so all of it. A player's thrown weapons stay theirs : "still out there"
 *                on their actor, and its owner's Pick Up button returns what's left. If the weapon's quantity goes up
 *                some other way (picked up by hand), that much comes off what's out there, so nothing comes back twice.
 * When the combat ends, a card :
 *   Each its own       : each creature's owner gets back half of its ammunition (onto that item) and its thrown weapons.
 *   Shared Search (Homebrew) : one pool of everything : half the ammunition everyone shot, and every thrown weapon
 *                        (NPCs' and players'; a player's counted live). When the combat ends, a card for everyone with a
 *                        Take button per kind found : whoever clicks it gets those (onto their own of that kind, else a
 *                        new stack) and it greys out for all; clicks at the same moment split it.
 * Hit Recovery (Homebrew's Recovering Ammunition) : only what hits can be found, in the creature it hit. A hit is known
 * when the attack's damage is applied to a creature (after any reroll, Lucky, cover...), on the client applying it :
 * the creature's owner (the GM for monsters). Ammunition rolls 1d4 : 1-2 breaks, 3-4 goes in the creature's inventory
 * (looting it finds it); a thrown weapon always does, and comes off what its thrower can pick up. The GMs get a whisper
 * either way. Anyone's shots, monsters' too. Ammunition that misses is lost; a thrown weapon that misses is found after
 * the fight as usual.
 */
export class ammunition{
  static mode(){
    return settings.value("ammoRecovery") ?? "off";
  }

  /* How it's found (Homebrew) : "rules" (half, rounded down), "oddRoll" (an odd one by 1d2), "hits" (Hit Recovery) */
  static rule(){
    const homebrew = settings.value("homebrewAmmoRecovery");
    if(homebrew && (homebrew !== "rules")) return homebrew;
    return (this.mode() === "halfRoll") ? "oddRoll" : "rules";
  }

  static shared(){
    return !!settings.value("homebrewAmmoSearch");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.rollAttackV2", (rolls, { subject, ammoUpdate } = {}) => this.onShot(subject, rolls?.[0], ammoUpdate));
    Hooks.on("deleteCombat", combat => this.onCombatEnd(combat));
    Hooks.on("renderChatMessageHTML", (message, html) => this.render(message, html));
    /* A thrown weapon's quantity going up some other way : that much is no longer out there */
    Hooks.on("preUpdateItem", (item, changes, options) => this.notePickUp(item, changes, options));
    Hooks.on("updateItem", (item, changes, options, userId) => { if(userId === game.user.id) this.onPickUp(item, options); });
    gm.handle("ammoTake", (data, user) => this.takeAsGM(data, user));
    gm.handle("ammoLodged", data => this.lodgedAsGM(data));
    Hooks.on("dnd5e.applyDamage", (actor, amount, options) => this.onDamaged(actor, amount, options));
  }

  /* ---------- Counting (the attacker's client : its own actor) ---------- */

  static isThrown(item, attack){
    const props = item?.system?.properties;
    return (item?.type === "weapon") && !!props?.has?.("thr") && !props.has("ret") && String(attack?.options?.attackMode ?? "").startsWith("thrown");
  }

  static async onShot(activity, attack, ammoUpdate){
    if(this.mode() === "off") return;
    const item = activity?.item, actor = activity?.actor;
    const combat = game.combat;
    if((item?.type !== "weapon") || !actor?.isOwner) return;
    const ammoWeapon = !!item.system.properties?.has?.("amm");
    const thrown = this.isThrown(item, attack);
    if(!ammoWeapon && !thrown) return;
    /* A player's throw took one off the stack (dnd5e names the weapon as what it used up); an NPC's always counts */
    const thrownUsed = thrown && (!actor.hasPlayerOwner || ((ammoUpdate?.id === item.id) && (Number(item.system.quantity) > 0)));

    /* Hit Recovery : ammunition is only found where it hit (onDamaged); the rest is lost */
    if(ammoWeapon && (this.rule() === "hits")) return;

    if(!combat?.started) return;
    const shots = actor.getFlag(module.id, "ammoShots");
    const now = (shots?.combat === combat.id) ? foundry.utils.deepClone(shots) : { combat : combat.id, items : {}, types : {}, thrown : {} };
    now.thrown ??= {};
    if(ammoWeapon){
      const ammo = ammoUpdate?.id ? actor.items.get(ammoUpdate.id) : null;
      const type = ammo?.system?.type?.subtype || item.system.ammunition?.type || "arrow";
      now.types[type] = (now.types[type] ?? 0) + 1;
      if(ammo) now.items[ammo.id] = (now.items[ammo.id] ?? 0) + 1;
    }
    else {
      if(!thrownUsed) return;
      now.thrown[item.id] = (now.thrown[item.id] ?? 0) + 1;
    }
    await actor.setFlag(module.id, "ammoShots", now);
  }

  /* Half of a count : rounded down, or the odd one by 1d2 (setting) */
  static async half(count){
    const base = Math.floor(count / 2);
    if(!(count % 2) || (this.rule() !== "oddRoll")) return { value : base, note : "" };
    const roll = await new Roll("1d2").evaluate();
    return { value : base + ((roll.total === 2) ? 1 : 0), note : `1d2 : ${roll.total}` };
  }

  /* ---------- Hit Recovery ---------- */

  /* What a piece is, for give() : the ammunition item or the thrown weapon (a monster's untracked arrows : the type) */
  static entryOf(piece, type){
    if(!piece) return { kind : "ammo", type, label : this.typeLabel(type) };
    if(piece.type === "weapon") return { kind : "weapon", base : this.baseOf(piece), label : piece.name, source : piece.uuid };
    return { kind : "ammo", type : piece.system?.type?.subtype ?? type ?? "", label : piece.name, source : piece.uuid };
  }

  /* The damage's card : Roll Item passes it as origin, dnd5e's trays as originatingMessage */
  static cardOf(options){
    return options?.origin ?? options?.originatingMessage ?? null;
  }

  /**
   * The attacks whose damage this was, that hit this creature : [{ key, attack options }]. Roll Item's card : the box's
   * attack (its ray), or every ray Apply Hits dealt to it; never Graze (a miss) or a save's damage. dnd5e's own damage
   * card : the last attack rolled from its use.
   * @returns {{ key : string, ammunition : string|null, attackMode : string }[]}
   */
  static hitsOf(card, actor, part){
    const system = card?.system;
    if(system?.attackOf){
      if(/^(rows|tray-(graze|save|formula))/.test(part ?? "")) return [];
      const shot = ray => {
        const attack = system.attackOf(ray);
        return attack ? { key : Number.isInteger(ray) ? String(ray) : "single", ammunition : attack.options?.ammunition ?? null, attackMode : attack.options?.attackMode ?? system.mode ?? "" } : null;
      };
      if(!system.isMulti) return [shot(null)].filter(Boolean);
      if(part === "hits"){
        /* Every ray that hit and landed on this creature (its target, or the selected tokens for a ray without one) */
        return system.rays.map((_, i) => i).filter(i => {
          if(!system.isHitOn(i)) return false;
          const target = system.rayTarget(i);
          return !target || (dnd5e.dataModels.chatMessage.fields.TargetsField.resolve(target).actor === actor);
        }).map(shot).filter(Boolean);
      }
      const ray = Number(String(part ?? "").split("-").pop());
      return Number.isInteger(ray) ? [shot(ray)].filter(Boolean) : [];
    }
    /* dnd5e's damage card : the use's last attack (its ammunition and mode) */
    const usage = card?.getOriginatingMessage?.() ?? card;
    const attack = usage?.getAssociatedRolls?.("attack")?.pop?.();
    if(!attack) return [];
    const ammo = attack.system?.ammunitionItem;
    return [{ key : attack.id, ammunition : (typeof ammo === "string") ? ammo : (ammo?.id ?? null), attackMode : attack.system?.mode ?? "" }];
  }

  /**
   * Damage applied (Hit Recovery) : the hit is final, after rerolls, Lucky and cover. On the client that applies it (the
   * creature's owner : the GM for monsters). Ammunition rolls 1d4 : 1-2 breaks, 3-4 goes in the creature's inventory; a
   * thrown weapon always does, and comes off what its thrower can pick up. Each attack once per creature. The GMs get a
   * whisper either way.
   */
  static async onDamaged(actor, amount, options = {}){
    if((this.mode() === "off") || (this.rule() !== "hits") || !actor?.isOwner || !(amount >= 0)) return;
    const card = this.cardOf(options);
    const shooter = card?.getAssociatedActor?.();
    const weapon = card?.getAssociatedItem?.();
    if(!shooter || (weapon?.type !== "weapon") || (shooter === actor)) return;
    const ammoWeapon = !!weapon.system.properties?.has?.("amm");
    for(const hit of this.hitsOf(card, actor, options[module.id]?.part)){
      const thrown = this.isThrown(weapon, { options : { attackMode : hit.attackMode } });
      if(!ammoWeapon && !thrown) continue;
      const seen = `lodged.${card.id}.${hit.key}`;
      if(actor.getFlag(module.id, seen)) continue;
      await actor.setFlag(module.id, seen, true);
      const type = weapon.system.ammunition?.type || "arrow";
      const entry = ammoWeapon ? this.entryOf(hit.ammunition ? shooter.items.get(hit.ammunition) : null, type) : this.entryOf(weapon);
      await this.lodge(shooter, entry, actor, { breaks : ammoWeapon });
      if(thrown) await gm.run("ammoLodged", { thrower : shooter.uuid, item : weapon.id });
    }
  }

  /**
   * A hit piece : ammunition rolls 1d4 (1-2 breaks), a thrown weapon doesn't break. What's left goes in the creature's
   * inventory. A whisper to the GMs either way.
   * @param {Actor} shooter
   * @param {object} entry   entryOf : the ammunition, or the thrown weapon
   * @param {Actor} target   the creature hit (owned here)
   * @param {object} [options]
   * @param {boolean} [options.breaks]  roll 1d4 (ammunition)
   */
  static async lodge(shooter, entry, target, { breaks = false } = {}){
    const roll = breaks ? await new Roll("1d4").evaluate() : null;
    const names = { item : entry.label, name : shooter.name, target : target.name, roll : roll ? `1d4 : ${roll.total}` : "" };
    const broke = !!roll && (roll.total <= 2);
    if(!broke) await this.give(target, entry, 1);
    const line = broke ? "ammunition.broke" : roll ? "ammunition.lodged" : "ammunition.lodgedThrown";
    return ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor : shooter }),
      content : `<p>${esc(module.format(line, names))}</p>`,
      whisper : gmIds(),
    });
  }

  /* GM : a thrown weapon that lodged in a creature isn't on the ground : one off its thrower's count (this combat's
     throws, else what's still out there after one) */
  static async lodgedAsGM({ thrower, item } = {}){
    const actor = thrower ? fromUuidSync(thrower, { strict : false }) : null;
    if(!actor || !item) return false;
    const shots = actor.getFlag(module.id, "ammoShots");
    if(Number(shots?.thrown?.[item]) > 0) return actor.setFlag(module.id, `ammoShots.thrown.${item}`, shots.thrown[item] - 1);
    const out = this.outThere(actor, item);
    if(out > 0) return actor.setFlag(module.id, `thrownOut.${item}`, out - 1);
    return false;
  }

  static typeLabel(type){
    return game.i18n.localize(CONFIG.DND5E.consumableTypes?.ammo?.subtypes?.[type] ?? type);
  }

  /* ---------- Thrown weapons still out there (on the thrower's actor) ---------- */

  static outThere(actor, itemId){
    return Number(actor?.getFlag?.(module.id, `thrownOut.${itemId}`)) || 0;
  }

  /* Before an update : how much a weapon with thrown ones out there goes up (not the module's own Pick Up) */
  static notePickUp(item, changes, options){
    if(options?.[module.id]?.pickUp || !foundry.utils.hasProperty(changes ?? {}, "system.quantity")) return;
    const actor = item.parent;
    const pending = this.outThere(actor, item.id) + (Number(actor?.getFlag?.(module.id, "ammoShots")?.thrown?.[item.id]) || 0);
    const gain = Number(foundry.utils.getProperty(changes, "system.quantity")) - (Number(item.system.quantity) || 0);
    if(pending && (gain > 0)) foundry.utils.setProperty(options, `${module.id}.pickedUp`, gain);
  }

  /* After it : that much off what's out there (from this combat's throws first, then earlier ones) */
  static async onPickUp(item, options){
    let gain = Number(options?.[module.id]?.pickedUp) || 0;
    const actor = item.parent;
    if(!gain || !actor?.isOwner) return;
    const shots = actor.getFlag(module.id, "ammoShots");
    if(shots?.thrown?.[item.id]){
      const off = Math.min(gain, shots.thrown[item.id]);
      gain -= off;
      await actor.setFlag(module.id, `ammoShots.thrown.${item.id}`, shots.thrown[item.id] - off);
    }
    const out = this.outThere(actor, item.id);
    if(gain && out) await actor.setFlag(module.id, `thrownOut.${item.id}`, Math.max(0, out - gain));
  }

  /* ---------- Combat over (the active GM) ---------- */

  static async onCombatEnd(combat){
    if(!game.users.activeGM?.isSelf || (this.mode() === "off")) return;
    const shooters = [];
    for(const c of combat.combatants){
      const actor = c.actor;
      const shots = actor?.getFlag(module.id, "ammoShots");
      if(shots?.combat === combat.id) shooters.push({ actor, shots });
    }
    if(!shooters.length) return;
    const shared = this.shared();
    /* A player's thrown weapons are still out there (their Pick Up, or the shared pool : both read it live) */
    for(const { actor, shots } of shooters){
      if(shared && !actor.hasPlayerOwner) continue;
      for(const [id, n] of Object.entries(shots.thrown ?? {})){
        if((n > 0) && actor.items.get(id)) await actor.setFlag(module.id, `thrownOut.${id}`, this.outThere(actor, id) + n);
      }
    }
    const card = shared ? await this.searchCard(shooters) : await this.ownCard(shooters);
    for(const { actor } of shooters) await actor.unsetFlag(module.id, "ammoShots").catch(() => {});
    return card;
  }

  /* Rows for one creature's thrown weapons still out there (read when the card is drawn) */
  static thrownRows(shooters, { skipPooled = false } = {}){
    const rows = [];
    for(const { actor, shots } of shooters){
      if(skipPooled && !actor.hasPlayerOwner) continue;
      for(const [id, n] of Object.entries(shots.thrown ?? {})){
        const item = actor.items.get(id);
        if(item && (n > 0)) rows.push({ actor : actor.uuid, item : id, name : actor.name, itemName : item.name, thrown : true });
      }
    }
    return rows;
  }

  /* Each its own : half of each ammunition item used, and the thrown weapons */
  static async ownCard(shooters){
    const rows = [];
    for(const { actor, shots } of shooters){
      for(const [id, used] of Object.entries(shots.items ?? {})){
        const item = actor.items.get(id);
        if(!item) continue;
        const { value, note } = await this.half(used);
        if(value > 0) rows.push({ actor : actor.uuid, item : id, name : actor.name, itemName : item.name, used, value, note });
      }
    }
    rows.push(...this.thrownRows(shooters));
    if(!rows.length) return null;
    const list = rows.map(r => `<li>${esc(r.thrown
      ? module.format("ammunition.thrownRow", { name : r.name, item : r.itemName })
      : module.format("ammunition.ownRow", { name : r.name, item : r.itemName, used : r.used, value : r.value }))}${r.note ? ` <span class="hint">(${esc(r.note)})</span>` : ""}</li>`).join("");
    return ChatMessage.implementation.create({
      speaker : { alias : module.i18n("ammunition.title") },
      content : `<div class="${module.id}-ammo"><p><strong>${esc(module.i18n("ammunition.title"))}</strong> : ${esc(module.i18n("ammunition.ownHint"))}</p><ul>${list}</ul></div>`,
      flags : { [module.id] : { ammo : { mode : "own", rows } } },
    });
  }

  /* Shared Search : one pool of everything : the ammunition everyone shot (half), and every thrown weapon (all; a
     player's counted live from what's still out there, so what they picked up by hand isn't found twice) */
  static async searchCard(shooters){
    const types = {}, weapons = {};
    const pool = [], notes = [];
    for(const { actor, shots } of shooters){
      for(const [type, n] of Object.entries(shots.types ?? {})) types[type] = (types[type] ?? 0) + n;
      for(const [id, n] of Object.entries(shots.thrown ?? {})){
        const item = actor.items.get(id);
        if(!item || !(n > 0)) continue;
        if(actor.hasPlayerOwner){
          pool.push({ key : this.keyOf(`thrown-${actor.id}-${id}`), kind : "thrown", actor : actor.uuid, item : id, base : this.baseOf(item), label : item.name, source : item.uuid });
          continue;
        }
        const key = this.baseOf(item);
        weapons[key] ??= { n : 0, name : item.name, source : item.uuid };
        weapons[key].n += n;
      }
    }
    for(const [type, shot] of Object.entries(types)){
      const { value, note } = await this.half(shot);
      const source = shooters.map(x => x.actor.items.find(i => (i.type === "consumable") && (i.system.type?.value === "ammo") && (i.system.type?.subtype === type))).find(Boolean);
      if(value > 0) pool.unshift({ key : this.keyOf(`ammo-${type}`), kind : "ammo", type, n : value, label : this.typeLabel(type), source : source?.uuid });
      if(note) notes.push(`${this.typeLabel(type)} ${note}`);
    }
    for(const [key, w] of Object.entries(weapons)) pool.push({ key : this.keyOf(`weapon-${key}`), kind : "weapon", base : key, n : w.n, label : w.name, source : w.source });
    if(!pool.length) return null;
    return ChatMessage.implementation.create({
      speaker : { alias : module.i18n("ammunition.title") },
      content : `<div class="${module.id}-ammo"><p><strong>${esc(module.i18n("ammunition.title"))}</strong> : ${esc(module.i18n("ammunition.poolHint"))}</p>${notes.length ? `<p class="hint">${esc(notes.join(" · "))}</p>` : ""}</div>`,
      flags : { [module.id] : { ammo : { mode : "pool", pool, taken : {} } } },
    });
  }

  /* A pool entry's key : no dots (a flag key with dots becomes nested objects) */
  static keyOf(text){
    return String(text).replace(/[.\s]/g, "-");
  }

  /* What makes two thrown weapons the same kind (Javelin) */
  static baseOf(item){
    return item.system.type?.baseItem || idOf(item) || item.name;
  }

  /* How many of a pool entry are still to be found (a player's thrown weapons : what's still out there) */
  static countOf(entry){
    if(entry.kind !== "thrown") return entry.n;
    return this.outThere(fromUuidSync(entry.actor, { strict : false }), entry.item);
  }

  /* ---------- The card's buttons ---------- */

  static render(message, html){
    const data = message.getFlag?.(module.id, "ammo");
    if(!data) return;
    const row = buttonRow(html, { key : `${module.id}-ammo-buttons` });
    if(row.childElementCount) return;
    if(data.mode === "pool") return this.poolButtons(message, row, data);
    this.ownButtons(message, row, data.rows ?? []);
  }

  /* Each owner's buttons : half its ammunition back (once), its thrown weapons still out there */
  static ownButtons(message, row, rows){
    for(const r of rows){
      const actor = fromUuidSync(r.actor, { strict : false });
      if(!actor?.isOwner) continue;
      if(r.thrown){
        const left = this.outThere(actor, r.item);
        addButton(row, makeButton({ icon : "fa-hand-holding", once : true, disabled : !left,
          text : module.format("ammunition.pickUp", { value : left, item : r.itemName, name : r.name }),
          onClick : () => this.pickUp(actor, r.item) }));
        continue;
      }
      const done = !!actor.getFlag(module.id, `ammoRecovered.${message.id}.${r.item}`);
      addButton(row, makeButton({ icon : "fa-hand-holding", once : true, disabled : done,
        text : module.format("ammunition.recover", { value : r.value, item : r.itemName, name : r.name }),
        onClick : () => this.recoverOwn(message, r) }));
    }
  }

  /* The owner's button : half back onto the ammunition item it came from */
  static async recoverOwn(message, row){
    const actor = fromUuidSync(row.actor, { strict : false });
    const item = actor?.items?.get(row.item);
    if(!item || !actor.isOwner || actor.getFlag(module.id, `ammoRecovered.${message.id}.${row.item}`)) return;
    await item.update({ "system.quantity" : (Number(item.system.quantity) || 0) + row.value }, { [module.id] : { pickUp : true } });
    await actor.setFlag(module.id, `ammoRecovered.${message.id}.${row.item}`, true);
  }

  /* The owner's button : the thrown weapons still out there, all of them */
  static async pickUp(actor, itemId){
    const item = actor?.items?.get(itemId);
    const left = this.outThere(actor, itemId);
    if(!item || !actor.isOwner || !left) return;
    await item.update({ "system.quantity" : (Number(item.system.quantity) || 0) + left }, { [module.id] : { pickUp : true } });
    await actor.unsetFlag(module.id, `thrownOut.${itemId}`);
  }

  /* The pool card : each kind found, Take for whoever wants it (greyed once taken, with who took it) */
  static poolButtons(message, row, data){
    for(const entry of data.pool){
      const taken = data.taken?.[entry.key];
      const n = taken ? taken.n : this.countOf(entry);
      if(!(n > 0)) continue;
      const text = taken ? module.format("ammunition.takenBy", { n, item : entry.label, name : taken.by }) : module.format("ammunition.take", { n, item : entry.label });
      addButton(row, makeButton({ icon : "fa-hand-holding", text, once : true, disabled : !!taken,
        onClick : () => this.take(message, entry.key) }));
    }
  }

  /* Take : onto this user's character (or a token they own and have selected) */
  static async take(message, key){
    const actor = (canvas.tokens?.controlled ?? []).map(t => t.actor).find(a => a?.isOwner) ?? game.user.character;
    if(!actor) return ui.notifications.warn(module.i18n("ammunition.whoSearches"));
    await gm.run("ammoTake", { message : message.id, key, actor : actor.uuid });
  }

  /* GM : a kind onto whoever takes it (their own). Clicks on the same kind within a moment of each other are gathered and
     split (half each; leftovers by a die), so together they never get more than was found; later clicks get nothing */
  static GATHER = 500;
  static #pending = new Map();
  static #takes = Promise.resolve();

  static takeAsGM({ message : id, key, actor : uuid } = {}, user){
    const actor = fromUuidSync(uuid ?? "", { strict : false });
    if(!actor?.testUserPermission?.(user, "OWNER")) return false;
    const slot = `${id}|${key}`;
    let batch = this.#pending.get(slot);
    if(!batch){
      batch = { takers : [], done : null };
      this.#pending.set(slot, batch);
      batch.done = new Promise(resolve => setTimeout(resolve, this.GATHER)).then(() => {
        this.#pending.delete(slot);
        const run = this.#takes.then(() => this.#split(id, key, batch.takers));
        this.#takes = run.catch(() => {});
        return run;
      });
    }
    if(!batch.takers.some(a => a.uuid === actor.uuid)) batch.takers.push(actor);
    return batch.done;
  }

  static async #split(id, key, takers){
    const message = game.messages.get(id);
    const data = message?.getFlag(module.id, "ammo");
    const entry = data?.pool?.find(e => e.key === key);
    if(!entry || data.taken?.[key] || !takers.length) return false;
    const n = this.countOf(entry);
    if(!(n > 0)) return false;
    const k = takers.length;
    const shares = takers.map(() => Math.floor(n / k));
    for(let left = n % k; left > 0; left--){
      const roll = await new Roll(`1d${k}`).evaluate();
      shares[Math.min(k - 1, Math.max(0, (Number(roll.total) || 1) - 1))] += 1;
    }
    const by = takers.map((a, i) => (k > 1) ? `${a.name} (${shares[i]})` : a.name).join(", ");
    await message.setFlag(module.id, "ammo", { ...data, taken : { ...(data.taken ?? {}), [key] : { n, by } } });
    for(const [i, actor] of takers.entries()) if(shares[i] > 0) await this.give(actor, entry, shares[i]);
    if(entry.kind === "thrown") await fromUuidSync(entry.actor, { strict : false })?.unsetFlag(module.id, `thrownOut.${entry.item}`);
    log.debug("Ammunition taken", entry.label, by);
    return true;
  }

  /* Onto the searcher's own of that kind (ammunition of the type, or the same weapon), else a new stack (a copy) */
  static async give(actor, entry, n){
    const have = (entry.kind === "ammo")
      ? actor.items.find(i => (i.type === "consumable") && (i.system.type?.value === "ammo") && (i.system.type?.subtype === entry.type))
      : actor.items.find(i => (i.type === "weapon") && (this.baseOf(i) === entry.base));
    if(have) return have.update({ "system.quantity" : (Number(have.system.quantity) || 0) + n }, { [module.id] : { pickUp : true } });
    const source = entry.source ? fromUuidSync(entry.source, { strict : false }) : null;
    const data = source ? source.toObject() : { name : entry.label, type : "consumable", system : { type : { value : "ammo", subtype : entry.type } } };
    delete data._id;
    foundry.utils.setProperty(data, "system.quantity", n);
    foundry.utils.setProperty(data, "system.equipped", false);
    await actor.createEmbeddedDocuments("Item", [data]);
  }
}
