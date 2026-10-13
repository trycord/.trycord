// Labelled sample content, and nothing else.
//
// The demo and the directory prefer this instance's real public communities.
// When there are none - discovery is switched off, or nobody has published a
// public community yet - the page still needs to be something rather than an
// empty frame. This is the something, and every surface that shows it says so.
//
// It is deliberately not dressed up as real: the names are obviously examples,
// there are no invite links, and the counts are stated as sample counts. A
// fabricated community presented as live is exactly the thing the brief forbids.
(function () {
  'use strict';

  function community(id, name, description, memberCount, channels) {
    return {
      id: id,
      name: name,
      description: description,
      member_count: memberCount,
      channel_count: channels.length,
      sample: true,
      channels: channels,
    };
  }

  function ch(id, name, topic) { return { id: id, name: name, topic: topic }; }

  var servers = [
    community('sample-studio', 'Studio Twelve', 'A sample community, shown because this instance has no public communities yet.', 128, [
      ch('s1', 'general', 'Say hello'),
      ch('s2', 'showcase', 'Work in progress'),
      ch('s3', 'feedback', 'Ask for a review'),
      ch('s4', 'off-topic', 'Anything but work'),
    ]),
    community('sample-nightshift', 'Night Shift', 'A second sample community, for showing navigation between communities.', 64, [
      ch('n1', 'lounge', 'Quiet hours'),
      ch('n2', 'build-log', 'What changed today'),
      ch('n3', 'music', 'What is on'),
    ]),
    community('sample-ember', 'Ember Lounge', 'A third sample community.', 42, [
      ch('e1', 'welcome', 'Start here'),
      ch('e2', 'general', ''),
    ]),
  ];

  // The simulated cast. Names are placeholders, shown with a "simulated" label.
  var people = [
    { name: 'Rowan', role: 'Owner', presence: 'online', color: 0 },
    { name: 'Mira', role: 'Admin', presence: 'online', color: 1 },
    { name: 'Kai', role: 'Moderator', presence: 'idle', color: 2 },
    { name: 'Devon', role: 'Member', presence: 'online', color: 3 },
    { name: 'Sam', role: 'Member', presence: 'dnd', color: 4 },
    { name: 'Priya', role: 'Member', presence: 'offline', color: 5 },
  ];

  // A small pool of simulated messages. Reused per channel so the demo has
  // something to show without pretending any of it was sent by anyone.
  var pool = [
    'Welcome to the demo. Nothing you do here leaves this browser.',
    'The channels on the left are real channels from a public community.',
    'Messages are simulated, because real conversations are private.',
    'Try switching channels, changing the theme, or joining the community.',
    'Everything resets when you close the tab.',
    'The rail on the left is the community list, just like the app.',
    'Settings on this page change the demo for this session only.',
  ];

  window.TrycordSample = {
    label: 'Sample data',
    note: 'This instance has no public communities, so the demo is showing sample content.',
    servers: servers,
    people: people,
    messages: pool,
  };
})();
