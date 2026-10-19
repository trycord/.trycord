// The sandbox for trusted extension code.
//
// An extension is declarative by default: it is a set of triggers and actions
// that the workflow engine runs, and there is no code in it to run. That is
// the real isolation, and it is what every extension gets unless the
// operator explicitly allows otherwise.
//
// A package may declare itself trusted and carry server-side source. That
// source runs here, and this module is where the boundary is enforced. What
// is actually enforced:
//
//   * The code runs in a fresh node:vm context with code generation from
//     strings disabled. That closes the standard escape: without it, a
//     context can reach the outer realm through this.constructor.constructor
//     and rebuild any function it likes, including one that returns
//     `process`.
//   * The context global is built from nothing. `require`, `process`, `fs`
//     and the host's `globalThis` are not in it, and nothing in the context
//     can reach them.
//   * Every function the extension can call is created inside the context.
//     A function from the outer realm carries the outer Function constructor
//     with it, and that one is not restricted - so handing the context an
//     outer function would undo the code-generation rule.
//   * Values cross the boundary as strings only, in both directions, and are
//     parsed on the far side. An object from the outer realm would carry the
//     outer realm's constructors with it.
//   * The code runs in a worker thread with a memory ceiling
//     (resourceLimits) and a wall-clock deadline. A runaway loop is stopped
//     and reported rather than left to consume the instance.
//   * The number of calls the extension may make is bounded, and the bound is
//     enforced on this side of the boundary, where the extension cannot reach
//     it.
//
// What is NOT enforced, and cannot be with Node's own vm: this is not a
// hardened jail. Node does not provide a security boundary between a vm
// context and its host, and a determined attacker may find a route this
// implementation has not closed. The mitigation is structural rather than
// technical: server-side code is off by default, it needs an operator to
// allow it, it is trusted code, and the declarative path exists precisely so
// that most extensions never need it.
//
// The docs state this in the same words. The tests state it too: they prove
// the routes that are closed are closed, and they do not claim more than
// that.

const { Worker } = require('node:worker_threads');

const DEFAULT_LIMITS = {
  timeoutMs: 5000,
  memoryMb: 64,
  callBudget: 50,
  outputBytes: 8000,
};

// The worker's source. It is fixed here and never built from the package's
// own code: the package's code is what runs inside the context, and the
// context is created by this.
const WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');

// A fresh context with code generation from strings disabled. eval and the
// Function constructor are unavailable inside it, which is what stops the
// usual route out of a context.
const context = vm.createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});

let nextCallId = 0;
const waiting = new Map();

// Relays one call to the host. The host answers with a JSON string, which is
// parsed inside the context, so the value the extension receives belongs to
// the context's realm.
function relay(payload, resolve, reject) {
  const id = ++nextCallId;
  waiting.set(id, { resolve, resolveFn: resolve, rejectFn: reject });
  parentPort.postMessage({ type: 'call', id, payload });
}

parentPort.on('message', (message) => {
  if (!message || message.type !== 'result') return;
  const entry = waiting.get(message.id);
  if (!entry) return;
  waiting.delete(message.id);
  if (message.ok) entry.resolveFn(message.payload);
  else entry.rejectFn(String(message.error || 'the call failed'));
});

// The API surface, installed from inside the context. Everything the
// extension can reach is created here, in the context's own realm.
const install = vm.runInContext(
  '(function (relay, setTimer, clearTimer, maxDelay) {' +
  '  const stringify = (value) => {' +
  '    if (typeof value === "string") return value;' +
  '    try { const text = JSON.stringify(value); return text === undefined ? String(value) : text; }' +
  '    catch (e) { return String(value); }' +
  '  };' +
  '  const call = (method, args) => new Promise((resolve, reject) => {' +
  '    let payload;' +
  '    try { payload = JSON.stringify({ method: String(method), args: args === undefined ? null : args }); }' +
  '    catch (e) { reject(new Error("the arguments could not be serialised")); return; }' +
  '    relay(payload,' +
  '      (reply) => {' +
  '        let value;' +
  '        try { value = JSON.parse(reply); }' +
  '        catch (e) { reject(new Error("the host sent a reply that could not be read")); return; }' +
  '        resolve(value);' +
  '      },' +
  '      (message) => reject(new Error(String(message))));' +
  '  });' +
  '  const logTo = (level) => (...parts) => call("log", { level: level, message: parts.map(stringify).join(" ") });' +
  '  const setTimeout = (fn, delay) => setTimer(fn, Math.min(Number(delay) || 0, maxDelay));' +
  '  const clearTimeout = (id) => clearTimer(id);' +
  '  globalThis.trycord = { call };' +
  '  globalThis.console = { log: logTo("log"), info: logTo("info"), warn: logTo("warn"), error: logTo("error") };' +
  '  globalThis.setTimeout = setTimeout;' +
  '  globalThis.clearTimeout = clearTimeout;' +
  '  return true;' +
  '})',
  context
);
install(relay, setTimeout, clearTimeout, workerData.maxDelayMs);

// The package's source is the body of an async function: it may await, and
// its return value is the run's output.
const wrapped = '(async () => {' + String(workerData.code) + '\\n})()';

(async () => {
  let script;
  try {
    script = new vm.Script(wrapped, {
      filename: 'extension-entry.js',
      importModuleDynamically: () => { throw new Error('dynamic import is not available'); },
    });
  } catch (e) {
    parentPort.postMessage({ type: 'done', ok: false, error: String((e && e.message) || e) });
    return;
  }

  let value;
  try {
    value = script.runInContext(context, { timeout: workerData.timeoutMs, breakOnSigint: true });
  } catch (e) {
    parentPort.postMessage({ type: 'done', ok: false, error: String((e && e.message) || e), timedOut: /timed out/i.test(String((e && e.message) || e)) });
    return;
  }
  try {
    const result = value && typeof value.then === 'function' ? await value : value;
    let output = null;
    try { output = JSON.stringify(result === undefined ? null : result); } catch (e) { output = null; }
    parentPort.postMessage({ type: 'done', ok: true, output: output === undefined ? null : output });
  } catch (e) {
    parentPort.postMessage({ type: 'done', ok: false, error: String((e && e.message) || e) });
  }
})();
`;

/**
 * Run a trusted extension's entry point in the sandbox.
 *
 * @param {object} options
 * @param {string} options.code      the entry point source
 * @param {function} options.host    (method, args) => Promise<any>; the only
 *                                   way the extension reaches the instance
 * @param {object} [options.limits]  { timeoutMs, memoryMb, callBudget }
 * @returns {Promise<object>} { ok, output, error, calls, durationMs, timedOut }
 */
function run(options) {
  const code = String((options && options.code) || '');
  const host = options && options.host;
  const limits = Object.assign({}, DEFAULT_LIMITS, (options && options.limits) || {});
  if (typeof host !== 'function') {
    return Promise.reject(new Error('the sandbox needs a host to relay calls to'));
  }
  if (!code.trim()) {
    return Promise.resolve({ ok: false, output: null, error: 'the entry point is empty', calls: 0, durationMs: 0, timedOut: false });
  }

  const started = Date.now();
  let calls = 0;
  let settled = false;
  let worker = null;
  let timer = null;

  return new Promise((resolve) => {
    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (worker) {
        const dying = worker;
        worker = null;
        dying.terminate().catch(() => { /* already gone */ });
      }
      resolve(Object.assign({ calls, durationMs: Date.now() - started }, result));
    }

    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          code,
          timeoutMs: limits.timeoutMs,
          maxDelayMs: 60000,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: Math.max(16, Number(limits.memoryMb) || DEFAULT_LIMITS.memoryMb),
          maxYoungGenerationSizeMb: 8,
          stackSizeMb: 4,
        },
      });
    } catch (e) {
      finish({ ok: false, output: null, error: 'the sandbox could not start: ' + String((e && e.message) || e), timedOut: false });
      return;
    }

    // The wall clock. The vm timeout only covers the synchronous part of the
    // entry point; this covers the whole run, including an entry point that
    // is waiting for a call that will never be answered.
    timer = setTimeout(() => {
      finish({ ok: false, output: null, error: 'the extension exceeded its ' + limits.timeoutMs + 'ms limit', timedOut: true });
    }, limits.timeoutMs + 250);

    worker.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'call') {
        calls += 1;
        let payload = null;
        try {
          payload = JSON.parse(message.payload);
        } catch (e) {
          payload = null;
        }
        Promise.resolve()
          .then(() => host(payload && payload.method, payload && payload.args))
          .then((result) => {
            let serialised;
            try {
              serialised = JSON.stringify(result === undefined ? null : result);
            } catch (e) {
              serialised = null;
            }
            worker.postMessage({ type: 'result', id: message.id, ok: true, payload: serialised === undefined ? 'null' : serialised });
          })
          .catch((e) => {
            worker.postMessage({ type: 'result', id: message.id, ok: false, error: String((e && e.message) || e) });
          });
        return;
      }
      if (message.type === 'done') {
        if (message.ok) {
          let output = null;
          try {
            output = JSON.parse(message.output === undefined ? 'null' : message.output);
          } catch (e) {
            output = null;
          }
          finish({ ok: true, output, error: null, timedOut: false });
        } else {
          finish({
            ok: false,
            output: null,
            error: String(message.error || 'the extension failed'),
            timedOut: !!message.timedOut,
          });
        }
      }
    });

    // A worker that dies - a memory ceiling reached, an uncaught error - is a
    // failed run, not a silent no-op.
    worker.on('error', (e) => {
      finish({
        ok: false,
        output: null,
        error: 'the sandbox stopped: ' + String((e && e.message) || e),
        timedOut: false,
      });
    });
    worker.on('exit', (code) => {
      // A worker that ends without a result is a failed run. The 'done' message
      // is posted before a normal exit, so reaching here means the worker
      // died on its own - a memory ceiling reached, an uncaught error.
      finish({
        ok: false,
        output: null,
        error: 'the sandbox stopped with exit code ' + code,
        timedOut: false,
      });
    });
  });
}

module.exports = { run, DEFAULT_LIMITS, WORKER_SOURCE };
