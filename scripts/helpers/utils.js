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
