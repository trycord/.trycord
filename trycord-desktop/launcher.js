// The launcher.
//
// It is the startup layer: it asks the main process what the update check
// found, it draws the answer, and it opens the application.
//
// Every state on screen corresponds to something the updater reported. There is
// no staged sequence and no invented percentage: when the updater gives a
// number the bar is determinate, and when it does not the bar is an
// indeterminate sweep, which means "working, size unknown" rather than a
// number that is not true.
//
// Every failure state still offers the way in. An update server that cannot be
// reached is not a reason somebody cannot talk to their community.

'use strict';

const state = document.getElementById('state');
const bar = document.getElementById('bar');
const barFill = bar.querySelector('span');
const go = document.getElementById('go');
const note = document.getElementById('note');

function say(text) {
  state.textContent = text;
}

function progress(info) {
  if (info && Number.isFinite(info.percent)) {
    bar.hidden = false;
    bar.classList.remove('is-indeterminate');
    barFill.style.width = Math.max(0, Math.min(100, info.percent)) + '%';
    return;
  }
  // Working, and the size is not known. The bar says so by moving, not by
  // claiming a number.
  bar.hidden = false;
  bar.classList.add('is-indeterminate');
}

function noProgress() {
  bar.hidden = true;
  bar.classList.remove('is-indeterminate');
  barFill.style.width = '0';
}

function paint(answer) {
  if (!answer) {
    say('Starting Trycord…');
    return;
  }
  switch (answer.state) {
    case 'available':
    case 'downloading':
      say(answer.detail || 'Downloading the new version.');
      progress(answer.progress);
      break;
    case 'downloaded':
      say(answer.detail || 'The new version is ready.');
      progress({ percent: 100 });
      break;
    case 'current':
      say(answer.detail || 'Trycord is up to date.');
      noProgress();
      break;
    case 'missing-metadata':
      say(answer.detail || 'This release carries no update information.');
      noProgress();
      note.textContent = 'Opening Trycord anyway.';
      break;
    case 'offline':
      say(answer.detail || 'The update service could not be reached.');
      noProgress();
      note.textContent = 'Opening Trycord anyway.';
      break;
    default:
      say(answer.detail || 'The update could not be checked.');
      noProgress();
      note.textContent = 'Opening Trycord anyway.';
      break;
  }
}

if (window.trycordLauncher && window.trycordLauncher.onUpdate) {
  window.trycordLauncher.onUpdate(paint);
}

go.addEventListener('click', () => {
  if (window.trycordLauncher && window.trycordLauncher.launch) window.trycordLauncher.launch();
});

// The reader should not have to wait for a download to get in. The window
// opens the application as soon as the update check has said what it has to
// say, and the download goes on in the background.
window.addEventListener('load', () => {
  setTimeout(() => {
    if (window.trycordLauncher && window.trycordLauncher.launch) window.trycordLauncher.launch();
  }, 1200);
});
