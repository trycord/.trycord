// The update check.
//
// It never blocks the launch, and it never touches anything but the desktop
// application: the server configuration, the database and the API the client
// talks to are none of its business.
//
// Every failure is classified, because "could not check" and "there is nothing
// to install" are different answers and a reader should not be told one when
// the other happened.
//
//   missing-metadata   the release carries no latest.yml - a pipeline problem
//   offline            DNS or connection failure, the update host is unreachable
//   unknown            anything else; the detail stays in the main process log
//
// `electron-updater` is only needed by a packaged build. A development run
// never contacts an update server, which is what keeps development from
// updating itself from production.

'use strict';

const path = require('node:path');
const fs = require('node:fs');

// The update source, named here so the application can report which one it is
// using and why. Nothing else depends on it: where the updater talks is
// separate from which instance the client connects to, and the two never meet.
const PROVIDER = 'github';
const REPO_OWNER = 'trycord';
const REPO_NAME = '.trycord';
const CHANNEL = 'latest';

// The channel the reader is on, and whether prereleases are wanted.
//
// It lives beside the application rather than in it, so a reader who is on a
// prerelease stays there across an update.
function preferencesPath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'updater-prefs.json');
  } catch {
    return null;
  }
}

function readPreferences() {
  const file = preferencesPath();
  if (!file || !fs.existsSync(file)) return { channel: CHANNEL, allowPrerelease: false };
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      channel: typeof json.channel === 'string' && json.channel ? json.channel : CHANNEL,
      allowPrerelease: json.allowPrerelease === true,
    };
  } catch {
    return { channel: CHANNEL, allowPrerelease: false };
  }
}

function writePreferences(next) {
  const file = preferencesPath();
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  } catch (error) {
    console.warn('[desktop] the update preferences could not be written: ' + error.message);
  }
}

// The check itself.
//
// The answer is what the launcher draws: what was found, and what kind of
// failure it was if it failed.
async function check() {
  const preferences = readPreferences();
  const answer = {
    provider: PROVIDER,
    repository: REPO_OWNER + '/' + REPO_NAME,
    channel: preferences.channel,
    state: 'unknown',
    detail: '',
    version: null,
    progress: null,
  };

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    // A development run has no updater, and that is not a fault.
    answer.state = 'missing-metadata';
    answer.detail = 'This build does not check for updates.';
    return answer;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.channel = preferences.channel;
  autoUpdater.allowPrerelease = preferences.allowPrerelease;

  autoUpdater.on('update-available', (info) => {
    answer.state = 'available';
    answer.version = info && info.version ? info.version : null;
    answer.detail = 'A newer version is downloading.';
  });
  autoUpdater.on('update-not-available', () => {
    answer.state = 'current';
    answer.detail = 'Trycord is up to date.';
  });
  autoUpdater.on('download-progress', (progress) => {
    answer.state = 'downloading';
    // The bar is only determinate when the updater says how far it is: a
    // number that is not true is worse than no number.
    answer.progress = progress && Number.isFinite(progress.percent)
      ? { percent: progress.percent, transferred: progress.transferred, total: progress.total }
      : null;
    answer.detail = 'Downloading the new version.';
  });
  autoUpdater.on('update-downloaded', (info) => {
    answer.state = 'downloaded';
    answer.version = info && info.version ? info.version : answer.version;
    answer.detail = 'The new version is ready. It installs when Trycord closes.';
  });
  autoUpdater.on('error', (error) => {
    const message = String((error && error.message) || error || '');
    if (/no published versions|latest\.yml|metadata|ENOENT/i.test(message)) {
      answer.state = 'missing-metadata';
      answer.detail = 'This release carries no update information.';
      return;
    }
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|getaddrinfo/i.test(message)) {
      answer.state = 'offline';
      answer.detail = 'The update service could not be reached.';
      return;
    }
    answer.state = 'unknown';
    answer.detail = 'The update could not be checked.';
    console.warn('[desktop] the update check failed: ' + message);
  });

  try {
    const result = await autoUpdater.checkForUpdates();
    if (result && result.updateInfo && result.updateInfo.version) {
      answer.version = result.updateInfo.version;
    }
    if (!answer.state || answer.state === 'unknown') {
      answer.state = 'current';
      answer.detail = 'Trycord is up to date.';
    }
  } catch (error) {
    const message = String((error && error.message) || error || '');
    if (/latest\.yml|metadata|ENOENT/i.test(message)) {
      answer.state = 'missing-metadata';
      answer.detail = 'This release carries no update information.';
    } else if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|getaddrinfo/i.test(message)) {
      answer.state = 'offline';
      answer.detail = 'The update service could not be reached.';
    } else {
      answer.state = 'unknown';
      answer.detail = 'The update could not be checked.';
      console.warn('[desktop] the update check failed: ' + message);
    }
  }

  return answer;
}

// The channel the reader is on, and whether prereleases are wanted.
function setChannel(channel) {
  const preferences = readPreferences();
  const next = {
    channel: typeof channel === 'string' && channel ? channel : CHANNEL,
    allowPrerelease: preferences.allowPrerelease,
  };
  writePreferences(next);
  return next;
}

function setPrerelease(allow) {
  const preferences = readPreferences();
  const next = { channel: preferences.channel, allowPrerelease: allow === true };
  writePreferences(next);
  return next;
}

module.exports = {
  PROVIDER, REPO_OWNER, REPO_NAME, CHANNEL,
  check, readPreferences, setChannel, setPrerelease,
};
