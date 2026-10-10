// The event bus between the services and the realtime gateway.
//
// A service publishes to a room without knowing a socket exists. The gateway registers
// itself at startup, and until it does, publishes are dropped - which is what makes a
// service testable without a running socket, and what makes the dependency one-way: the
// gateway imports the services, never the other way round.

const bus = {
  handler: null,

  /** The gateway calls this once, with its own broadcast function. */
  attach(fn) {
    bus.handler = fn;
    return () => { bus.handler = null; };
  },

  /** Drop a payload on every socket in a room. */
  emit(room, payload) {
    if (!bus.handler) return;
    try { bus.handler(room, payload); } catch { /* a socket that fails is a socket that closes */ }
  },
};

module.exports = bus;
