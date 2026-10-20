// Settings: the language this account reads in.
//
// The reader chooses a locale, the server keeps it, and the client asks for
// the catalogue the instance is serving. The dates and numbers are then
// written the way that locale writes them.
//
// The strings themselves are English in the source. A pack may translate any
// string the build declares, and the client reads the catalogue the server
// sends rather than carrying a second copy of it - so a pack that translates
// nothing leaves the interface exactly as it was.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import locale from '../../packages/locale.js';
import { head, card, row, fault, fold, facts } from '../ui/page.js';
import { toast, errorToast } from '../ui/overlays.js';

const SOURCE_LABEL = {
  reader: 'your own choice',
  instance: 'the instance default',
  browser: 'your browser',
  fallback: 'the built-in English',
};

export function languageView() {
  const list = el('div', { class: 'rowlist' });
  const summary = el('div', { class: 'factline' });
  const sample = el('p', { class: 'form-note language-sample' });

  async function paint() {
    list.replaceChildren(el('p', { class: 'holdline', 'aria-busy': 'true' }, 'Reading the languages'));
    try {
      const [locales, preference] = await Promise.all([
        Api.localisationLocales(),
        Api.localisationPreference(),
      ]);
      const available = Array.isArray(locales) ? locales : [];
      const chosen = preference && preference.locale ? preference.locale : null;

      summary.replaceChildren(facts([
        { value: locale.currentLocale(), label: 'in force' },
        { value: SOURCE_LABEL[locale.currentSource()] || locale.currentSource(), label: 'chosen by' },
        { value: String(available.length), label: 'languages here' },
      ]));

      const options = [{
        locale: null,
        label: 'The instance default',
        sub: 'Follow whatever this instance answers in',
        scope: 'instance',
      }].concat(available.map((entry) => ({
        locale: entry.locale,
        label: entry.locale,
        sub: (entry.scope === 'community' ? 'A community pack' : 'An instance pack')
          + ' · version ' + (entry.version || '?'),
        scope: entry.scope,
      })));

      list.replaceChildren(...options.map((entry) => row({
        class: 'language-row' + (String(entry.locale) === String(chosen) ? ' cardrow--active' : ''),
        lead: el('span', { class: 'language-glyph' }, icon('globe', { size: 15 })),
        title: entry.label,
        sub: entry.sub,
        side: String(entry.locale) === String(chosen)
          ? el('span', { class: 'badge' }, 'in use')
          : null,
        onClick: () => choose(entry.locale),
      })));

      sample.textContent = 'A date is written here as '
        + locale.formatDate(new Date(), { year: 'numeric', month: 'long', day: 'numeric' })
        + ', and a number as ' + locale.formatNumber(1234.5) + '.';
    } catch (error) {
      list.replaceChildren(fault(error, paint));
    }
  }

  async function choose(value) {
    try {
      await locale.setPreference(value);
      toast(value ? 'The language is changed' : 'The instance default is followed again');
    } catch (error) {
      errorToast(error);
    }
  }

  return {
    node: fold([
      head({
        kicker: 'Preferences',
        title: 'Language',
        lede: 'The language this account reads in, and how dates are written.',
      }),
      card({ label: 'The language in force', glyph: 'globe', body: summary }),
      card({
        label: 'Choose a language', glyph: 'globe', flush: true,
        note: 'the languages this instance has a pack for',
        body: list,
      }),
      card({
        label: 'How it is written', glyph: 'clock',
        body: fold([
          sample,
          el('p', { class: 'card-note' },
            'The words of the interface are English in the source. A pack may translate '
            + 'the strings the build declares, and the ones it translates are used; the '
            + 'rest stay as they are written here.'),
        ]),
      }),
    ]),
    onMount: paint,
    cleanup() {},
  };
}

export default { languageView };
