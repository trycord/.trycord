// What this instance is, for the versioned API to say out loud.
//
// The instance id and name are the ones the rest of the server already uses:
// the id from the environment, the name from the configuration centre when it
// has been loaded.

const { VERSION, API_VERSION } = require('../../version');

function info() {
  // Required lazily: the configuration centre reads modules that read this
  // one, and requiring it at load time would close that cycle.
  const settings = require('../../services/settings');
  const id = String(process.env.TRYCORD_INSTANCE_ID || 'local').trim() || 'local';
  const name = settings.isLoaded() ? (settings.get('instance.name') || id) : id;
  return { id, name, version: VERSION, apiVersion: API_VERSION };
}

module.exports = { info };
