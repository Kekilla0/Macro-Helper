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
  const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
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
