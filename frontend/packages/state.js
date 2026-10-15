// The store, under the name the entry checks import.
//
// The shell and the pages read the store directly; this module is the alias the
// server-side render check and any embedder that knew the old name read. `me`
// is a live view of the signed-in user rather than a snapshot, so a caller that
// holds this object across a sign-in sees the new user.

import { State } from './store.js';

export * from './store.js';

const state = new Proxy(State, {
  get(target, property) {
    if (property === 'me') return target.user;
    return target[property];
  },
});

export default state;
