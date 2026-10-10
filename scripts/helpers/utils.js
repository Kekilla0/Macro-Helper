import { module } from '../module.js';

/**
 * Wait a number of milliseconds.
 * @param {number} ms
 */
export function wait(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait until a condition is true, checking every `interval` ms, giving up after `timeout` ms.
 * @param {Function} condition  () => boolean
 * @param {object} [options]
 * @param {number} [options.interval=100]
 * @param {number} [options.timeout=20000]
 * @returns {Promise<boolean>}  true if the condition was met, false on timeout
 */
export async function waitFor(condition, { interval = 100, timeout = 20000 } = {}){
  const end = Date.now() + timeout;
  while(Date.now() < end){
    if(await condition()) return true;
    await wait(interval);
  }
  return !!(await condition());
}

/**
 * The item an effect came from : its origin is the item, or one of the item's activities (dnd5e's effect tray
 * Apply sets the activity).
 * @param {ActiveEffect} effect
 * @returns {Item|null}
 */
export function originItem(effect){
  const origin = effect?.origin ? fromUuidSync(effect.origin, { strict : false }) : null;
  if(!origin) return null;
  return (origin.documentName === "Item") ? origin : (origin.item ?? null);
}

/**
 * The chat card a message came from (a save rolled from a save card...). dnd5e's message models turn
 * system.origin into the card itself, data that hasn't gone through them keeps its id : either works.
 * @param {ChatMessage|object} message
 * @returns {ChatMessage|null}
 */
export function originOf(message){
  const origin = message?.system?.origin ?? message?._source?.system?.origin;
  if(!origin) return null;
  return (typeof origin === "string") ? (game.messages.get(origin) ?? null) : origin;
}

/**
 * Ask the user to choose one option from a dropdown (a skill, a damage type...).
 * @param {object} options
 * @param {string} options.title
 * @param {{ value : string, label : string }[]} options.options
 * @param {string} [options.prompt]   a line above the dropdown
 * @param {string} [options.value]    the option chosen to begin with
 * @param {string} [options.icon]     Font Awesome classes for the window
 * @param {string} [options.confirm]  the button's label
 * @returns {Promise<string|null>}  the chosen value, null when closed
 */
export async function chooseOption({ title, options = [], prompt = "", value, icon = "fa-solid fa-list", confirm } = {}){
  if(!options.length) return null;
  if(options.length === 1) return options[0].value;
  const chosen = await foundry.applications.api.DialogV2.wait({
    window : { title, icon },
    content : `${prompt ? `<p>${esc(prompt)}</p>` : ""}
      <select name="choice" autofocus>${options.map(o => `<option value="${esc(o.value)}"${o.value === value ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`,
    buttons : [{ action : "ok", label : confirm ?? game.i18n.localize("Confirm"), icon : "fa-solid fa-check", default : true,
      callback : (event, button) => button.form.elements.choice.value }],
    rejectClose : false,
  });
  return (!chosen || (chosen === "ok")) ? null : chosen;
}

/**
 * A document's dnd5e identifier ("wild-shape", "unarmed-strike"), from an item, an index entry or raw data; "" if none.
 * @param {Item|object} doc
 * @returns {string}
 */
export function idOf(doc){
  return doc?.identifier ?? doc?.system?.identifier ?? "";
}

/* ---------- Text ---------- */

/**
 * Text made safe to put in HTML.
 * @param {*} value
 * @returns {string}
 */
export function esc(value){
  return foundry.utils.escapeHTML(String(value ?? ""));
}

/* ---------- Who gets told ---------- */

/* The GMs' user ids (a whisper to the GM) */
export function gmIds(){
  return game.users.filter(u => u.isGM).map(u => u.id);
}

/**
 * The user ids that own an actor (GMs count as owners).
 * @param {Actor} actor
 * @param {object} [options]
 * @param {boolean} [options.players=false]  players only, no GMs
 * @returns {string[]}
 */
export function ownerIds(actor, { players = false } = {}){
  return game.users.filter(u => (!players || !u.isGM) && actor?.testUserPermission(u, "OWNER")).map(u => u.id);
}

/**
 * A message whispered to an actor's owners and the GMs, spoken by the actor.
 * @param {Actor} actor
 * @param {string} content   HTML; plain text is wrapped in a paragraph (escaped)
 * @param {object} [data]    more message data (flags...)
 * @returns {Promise<ChatMessage>}
 */
export function whisperOwners(actor, content, data = {}){
  const html = /^\s*</.test(content) ? content : `<p>${esc(content)}</p>`;
  return ChatMessage.implementation.create({
    speaker : ChatMessage.implementation.getSpeaker({ actor }),
    whisper : [...new Set([...ownerIds(actor), ...gmIds()])],
    content : html,
    ...data,
  });
}

/**
 * A table whispered to the GMs (the equipment and Rule Limits logs) : one row per [label key, HTML value].
 * @param {[string, string][]} rows
 * @param {object} [options]
 * @param {string} [options.alias]   who it's from
 * @returns {Promise<ChatMessage>}
 */
export function whisperGMTable(rows, { alias = module.title } = {}){
  const table = rows.map(([label, value]) => `<tr><th>${module.i18n(label)}</th><td>${value}</td></tr>`).join("");
  return ChatMessage.implementation.create({
    content : `<table class="${module.id}-equip-log">${table}</table>`,
    whisper : gmIds(),
    speaker : { alias },
  });
}

/* ---------- Compendiums ---------- */

/**
 * Run fn with a compendium unlocked, locking it again after (if it was locked).
 * @param {CompendiumCollection} pack
 * @param {Function} fn
 */
export async function withUnlocked(pack, fn){
  const locked = pack.locked;
  if(locked) await pack.configure({ locked : false });
  try { return await fn(); }
  finally { if(locked) await pack.configure({ locked : true }); }
}

/* ---------- Buttons and rows on rendered messages ---------- */

/**
 * A button that runs onClick : disabled while it runs; an error is logged and shown as a warning.
 * @param {object} options
 * @param {string} options.icon             Font Awesome class ("fa-rotate")
 * @param {string} [options.label]          what it does : its tooltip and aria label
 * @param {string} [options.text]           words shown on it (none : icon only)
 * @param {string} [options.className]
 * @param {boolean} [options.tooltip=true]  label as a tooltip
 * @param {boolean} [options.disabled]
 * @param {boolean} [options.once]          stays disabled after it worked (used up)
 * @param {(event : Event) => any} options.onClick
 * @returns {HTMLButtonElement}
 */
export function makeButton({ icon, label = "", text = "", className = "", tooltip = true, disabled = false, once = false, onClick }){
  const button = document.createElement("button");
  button.type = "button";
  if(className) button.className = className;
  if(tooltip && label) button.dataset.tooltip = label;
  if(label) button.ariaLabel = label;
  button.disabled = disabled;
  button.innerHTML = `<i class="fa-solid ${icon}" inert></i>${text ? ` <span>${esc(text)}</span>` : ""}`;
  button.addEventListener("click", async event => {
    event.preventDefault();
    button.disabled = true;
    let worked = false;
    try { await onClick(event); worked = true; }
    catch(error){ console.error(`${module.title} |`, error); ui.notifications.warn(error.message); }
    finally { if(!(once && worked)) button.disabled = false; }
  });
  return button;
}

/**
 * A row of buttons on a rendered message : the one already there with this key, or a new one.
 *   stack : full buttons one under another (div.card-buttons), at the bottom
 *   icons : dnd5e's icon row, a list of buttons beside an icon (under a roll)
 * @param {HTMLElement} html                 the message's element
 * @param {object} options
 * @param {string} options.key               the row's class ("macro-helper-rerolls")
 * @param {"stack"|"icons"} [options.layout="stack"]
 * @param {string} [options.icon]            icons : the row's icon (default a play circle)
 * @param {HTMLElement|string} [options.into] where it goes : an element, or a selector in html (default the content)
 * @returns {HTMLElement}  the row : addButton(row, button)
 */
export function buttonRow(html, { key, layout = "stack", icon = "fa-circle-play", into } = {}){
  const found = html.querySelector(`.${key}`);
  if(found) return found;
  const parent = ((typeof into === "string") ? html.querySelector(into) : into) ?? html.querySelector(".message-content") ?? html;
  let row;
  if(layout === "icons"){
    row = document.createElement("section");
    row.className = `icon-row ${key}`;
    row.innerHTML = `<i class="fa-solid fa-fw ${icon}" inert></i><ul class="unlist"></ul>`;
  }
  else {
    row = document.createElement("div");
    row.className = `card-buttons ${key}`;
  }
  parent.append(row);
  return row;
}

/* A button added to a row from buttonRow */
export function addButton(row, button){
  const list = row.querySelector(":scope > ul");
  if(!list) return row.append(button);
  const li = document.createElement("li");
  li.append(button);
  list.append(li);
}

/**
 * A short line on a rendered dnd5e card, under its description (once per key).
 * @param {HTMLElement} html
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.key]   its class (default "macro-helper-note")
 * @returns {HTMLElement}
 */
export function addNote(html, text, { key = `${module.id}-note` } = {}){
  const found = html.querySelector(`.${key}`);
  if(found) return found;
  const p = document.createElement("p");
  p.className = `supplement ${key}`;
  p.innerHTML = `<strong>${esc(text)}</strong>`;
  const anchor = html.querySelector(".card-content, .description, .card-header");
  if(anchor) anchor.after(p);
  else (html.querySelector(".chat-card") ?? html.querySelector(".message-content") ?? html).append(p);
  return p;
}
