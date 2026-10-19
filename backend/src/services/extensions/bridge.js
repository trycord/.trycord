// The host side of the sandbox bridge.
//
// A trusted extension's code runs in a context that can reach nothing. The
// one thing it can reach is this: a function that takes the name of an action
// and its parameters, checks the capability the action needs against the
// extension's grants, and runs it.
//
// The check happens here, on this side of the boundary, in the instance's own
// realm. The extension cannot reach the grant set, cannot change it, and
// cannot skip the check by calling something else: the only door is this
// function, and it checks every time.

const actions = require('../workflows/actions');

/**
 * Build the host an extension's code talks to.
 *
 * @param {object} options
 * @param {Set<string>} options.grants  the capabilities the extension holds
 * @param {object} options.budget       the call budget; every call counts
 * @param {object} options.ctx          the run context (owner, run key, values)
 * @returns {function} (method, args) => Promise<any>
 */
function createHost(options) {
  const grants = options.grants;
  const budget = options.budget;
  const ctx = options.ctx || {};

  return async function host(method, args) {
    const name = String(method || '').trim();
    if (!actions.isKnown(name)) {
      throw new Error('there is no action called "' + name + '"');
    }
    const result = await actions.execute(name, args || {}, Object.assign({}, ctx, { grants, budget }));
    if (name === 'log' && result && result.message) {
      const who = ctx.workflowName || ctx.workflowId || 'extension';
      console.log('[extensions] ' + who + ': ' + result.message);
    }
    return result;
  };
}

module.exports = { createHost };
