// Community analytics.
//
// Read-only, and deliberately so: every figure here is a count over what other
// people wrote. Nothing on this page can change anything, and there is no
// action that mutates the community, because a statistics view that can delete
// a message is a moderation tool wearing a different hat.
//
// The charts are drawn from the server's zero-filled daily series rather than
// from the messages the client happens to have, so a chart and its totals can
// never disagree, and a quiet day is a zero rather than a gap.

import Api from './api.js';
import { clear, el, relTime } from './ui.js';
import { sectionHead, sectionCard, setEmpty } from './settings-ui.js';

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

function tile(label, value, hint) {
  const box = el('div', { class: 'stat-tile' });
  box.appendChild(el('span', { class: 'stat-tile__label' }, label));
  box.appendChild(el('strong', { class: 'stat-tile__value' }, String(value)));
  if (hint) box.appendChild(el('span', { class: 'stat-tile__hint muted small' }, hint));
  return box;
}

// A sparkline drawn as inline SVG. No charting library: the shape needed is one
// polyline, and a dependency for that would be a second thing to keep working.
function sparkline(series, valueOf, opts = {}) {
  const w = 640;
  const h = opts.height || 96;
  const values = series.map(valueOf);
  const max = Math.max(1, ...values);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', opts.label || 'chart');
  svg.setAttribute('preserveAspectRatio', 'none');

  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => [Math.round(i * step), h - Math.round((v / max) * (h - 6)) - 3]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
  const area = document.createElementNS(ns, 'path');
  area.setAttribute('d', d + ' L' + w + ' ' + h + ' L0 ' + h + ' Z');
  area.setAttribute('class', 'sparkline__area');
  const line = document.createElementNS(ns, 'path');
  line.setAttribute('d', d);
  line.setAttribute('class', 'sparkline__line');
  svg.append(area, line);
  return svg;
}

function legendRow(series, valueOf, labelOf) {
  const first = series[0];
  const last = series[series.length - 1];
  const box = el('div', { class: 'chart-legend muted small' });
  box.appendChild(el('span', {}, labelOf(first) + ' ' + valueOf(first)));
  box.appendChild(el('span', { class: 'chart-legend__gap' }, '→'));
  box.appendChild(el('span', {}, labelOf(last) + ' ' + valueOf(last)));
  return box;
}

function barList(rows, { valueKey, labelKey, subKey, empty }) {
  if (!rows.length) return el('p', { class: 'muted small' }, empty);
  const max = Math.max(1, ...rows.map((r) => Number(r[valueKey]) || 0));
  const list = el('ul', { class: 'bar-list' });
  for (const r of rows) {
    const li = el('li', { class: 'bar-row' });
    const head = el('div', { class: 'bar-row__head' });
    head.appendChild(el('span', { class: 'bar-row__label' }, r[labelKey]));
    head.appendChild(el('span', { class: 'bar-row__value' }, String(r[valueKey])));
    li.appendChild(head);
    const track = el('div', { class: 'bar-row__track' });
    const fill = el('div', { class: 'bar-row__fill' });
    fill.style.width = Math.round(((Number(r[valueKey]) || 0) / max) * 100) + '%';
    track.appendChild(fill);
    li.appendChild(track);
    if (r[subKey]) li.appendChild(el('span', { class: 'muted small' }, r[subKey]));
    list.appendChild(li);
  }
  return list;
}

function panel(title, blurb, ...children) {
  const box = el('div', { class: 'settings-panel' });
  box.appendChild(sectionHead(title, blurb));
  for (const c of children) if (c) box.appendChild(c);
  return box;
}

export async function renderAnalytics(container, serverId, opts = {}) {
  clear(container);
  const days = opts.days || 30;

  const picker = el('div', { class: 'range-picker', role: 'group', 'aria-label': 'Time range' });
  for (const r of RANGES) {
    const b = el('button', {
      class: 'btn' + (r.days === days ? ' primary' : ''),
      type: 'button',
      'aria-pressed': r.days === days ? 'true' : 'false',
    }, r.label);
    b.addEventListener('click', () => { opts.onRange && opts.onRange(r.days); });
    picker.appendChild(b);
  }

  const head = sectionHead('Analytics', 'What this community has looked like over the window below. Figures are counted from the messages themselves, so they agree with the history.', [picker]);

  let rep;
  try {
    rep = await Api.analytics(serverId, days);
  } catch (ex) {
    container.appendChild(sectionCard(head));
    container.appendChild(el('p', { class: 'form-error' }, ex.message || 'Could not load analytics.'));
    return;
  }

  const t = rep.totals || {};
  const a = rep.averages || {};

  container.appendChild(sectionCard(head, el('p', { class: 'muted small' }, 'Updated ' + relTime(rep.generatedAt))));

  container.appendChild(sectionCard(
    el('div', { class: 'stat-grid' },
      tile('Messages', t.messages, 'in the last ' + rep.windowDays + ' days'),
      tile('Per day', a.messagesPerDay, a.activeDays + ' active day' + (a.activeDays === 1 ? '' : 's')),
      tile('On an active day', a.messagesPerActiveDay, 'ignoring quiet days'),
      tile('Members', t.members, t.channels + ' channel' + (t.channels === 1 ? '' : 's')),
      tile('Joined', t.joined, 'in the window'),
      tile('Left', t.left, 'in the window'),
      tile('Reactions', t.reactions, 'in the window'),
      tile('Attachments', t.attachments, 'in the window'))
  ));

  if (!t.messages && !t.joined && !t.left) {
    container.appendChild(setEmpty(
      'Nothing has happened in this community in the last ' + rep.windowDays + ' days. '
      + 'Widen the range to see older activity.'
    ));
    return;
  }

  container.appendChild(panel(
    'Message volume',
    'Bars are per day. A day with no messages is a zero, not a gap — a gap would read as missing data.',
    sparkline(rep.daily, (d) => d.messages, { label: 'Messages per day' }),
    legendRow(rep.daily, (d) => d.messages, (d) => d.day)
  ));

  container.appendChild(panel(
    'Who is taking part',
    'Counted by distinct messages, not by membership: someone who joined and never spoke is not participating.',
    sparkline(rep.daily, (d) => d.posters, { label: 'Distinct posters per day', height: 64 }),
    barList(rep.topMembers || [], {
      valueKey: 'messages', labelKey: 'displayName', subKey: null, empty: 'Nobody has posted in this window.',
    })
  ));

  container.appendChild(panel(
    'Where the conversation happens',
    'Channel volume over the same window. Channels with no messages are listed so a silent one is visible.',
    barList(rep.topChannels || [], {
      valueKey: 'messages', labelKey: 'name',
      subKey: 'posters', empty: 'No channels to report on.',
    })
  ));

  if ((rep.membership || []).some((d) => d.joined || d.left)) {
    container.appendChild(panel(
      'Membership change',
      'Departures are counted from the join and leave history, which survives a member row being removed.',
      sparkline(rep.membership, (d) => d.joined, { label: 'Members joining per day', height: 64 }),
      barList(
        (rep.membership || []).filter((d) => d.joined || d.left).slice(-14).reverse().map((d) => ({
          day: d.day, messages: d.joined, label: d.day, value: d.joined,
          sub: d.left ? d.left + ' left' : null,
        })),
        { valueKey: 'value', labelKey: 'label', subKey: 'sub', empty: 'No membership change in this window.' }
      )
    ));
  }

  if (rep.streaks) {
    container.appendChild(sectionCard(
      el('div', { class: 'streak-row' },
        tile('Current streak', rep.streaks.current + (rep.streaks.current === 1 ? ' day' : ' days'), 'consecutive days with a message'),
        tile('Longest streak', rep.streaks.longest + (rep.streaks.longest === 1 ? ' day' : ' days'), 'since this community began'))
    ));
  }
}

export default { renderAnalytics };