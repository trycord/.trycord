with open('community.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Find renderVoice function
start_marker = '// voice channels delegate to the media module'
start_idx = content.find(start_marker)
if start_idx == -1:
    print('start_marker not found')
    exit(1)

# Find escapeHtml function
end_marker = 'function escapeHtml(text)'
end_idx = content.find(end_marker)
if end_idx == -1:
    print('end_marker not found')
    exit(1)

print('Found renderVoice at byte', start_idx)
print('Found escapeHtml at byte', end_idx)
print('Total content length:', len(content))

# New voice implementation - inline, no class
new_voice = '''// voice channels delegate to the media module, which is the only place that
// knows whether this instance even offers a session.
function renderVoice(ctx, serverId, channel) {
  const host = el('div', { class: 'voice-stage' });
  const node = page({ wide: true }, host);
  const head = el('div', { class: 'stage-head-content' },
    el('span', { class: 'stage-head-icon' }, icon('volume', { size: 19 })),
    el('div', { class: 'stage-head-main' },
      el('h2', { class: 'voice-head-title' }, channel.name),
      el('div', { class: 'voice-head-sub' }, channel.type === 'stage' ? 'Stage channel' : 'Voice channel')
    )
  );
  host.appendChild(head);

  const body = el('div', { class: 'voice-body' });
  node.appendChild(body);

  const participants = el('div', { class: 'voice-participants' });
  const participantsHead = el('div', { class: 'voice-participants-head' });
  participantsHead.appendChild(el('h3', { class: 'voice-participants-title' }, 'Participants'));
  participantsHead.appendChild(el('span', { class: 'voice-participants-count' }, '0'));
  participants.appendChild(participantsHead);
  const participantsList = el('div', { class: 'voice-participants-list' });
  participants.appendChild(participantsList);
  body.appendChild(participants);

  const controls = el('div', { class: 'voice-controls' });
  controls.appendChild(
    el('div', { class: 'voice-control-group' },
      el('button', {
        class: 'btn btn--default btn--sm',
        type: 'button',
        onClick: () => toggleMute(),
      },
      el('span', { class: 'voice-control-icon' }, icon('mic-off', { size: 20 })),
      el('span', { class: 'voice-control-label' }, 'Unmute')
      )
    ));
    controls.appendChild(
      el('div', { class: 'voice-control-group' },
        el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          onClick: () => toggleDeafen(),
        },
        el('span', { class: 'voice-control-icon' }, icon('volume-2', { size: 20 })),
        el('span', { class: 'voice-control-label' }, 'Deafen')
      )
    ));
    controls.appendChild(
      el('div', { class: 'voice-control-group' },
        el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          onClick: () => toggleScreenShare(),
        },
        el('span', { class: 'voice-control-icon' }, icon('screen', { size: 20 })),
        el('span', { class: 'voice-control-label' }, 'Share screen')
      )
    ));
    body.appendChild(controls);

    const status = el('div', { class: 'voice-status' });
    body.appendChild(status);

    const speakers = el('div', { class: 'voice-speakers' });
    body.appendChild(speakers);

    let muted = true;
    let deafened = false;
    let screenSharing = false;
    let sessionId = null;
    let provider = null;
    const participantsMap = new Map();

    async function load() {
      participantsList.innerHTML = '';
      participantsCount.textContent = '0';
      status.textContent = 'Connecting…';
      status.className = 'voice-status';

      try {
        const out = await Api.voiceJoin(channel.id);
        sessionId = out.sessionId;
        provider = out.provider || 'mesh';
        const me = { userId: out.sessionId, sessionId: out.sessionId };
        participantsCount.textContent = '1';
        status.textContent = 'Connected';
        status.className = 'voice-status voice-status-ok';

        addParticipant(out.sessionId, 'You', null, true);

        await startMedia();
      } catch (error) {
        host.replaceChildren(el('div', { class: 'view-loading' }, 'Failed to connect: ' + (error.message || 'unknown error')));
        status.textContent = 'Failed to connect: ' + (error.message || 'unknown error');
        status.className = 'voice-status voice-status-error';
      }
    }

    async function startMedia() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        mediaDevices.audio = stream.getAudioTracks()[0];

        if (provider === 'mesh') {
          await initMesh();
        }
      } catch (e) {
        console.error('Failed to access microphone:', e);
        status.textContent = 'Microphone access denied';
        status.className = 'voice-status voice-status-error';
      }
    }

    async function initMesh() {
      const caps = await Api.voiceCapabilities();
      const iceServers = caps.iceServers || [];

      const pc = new RTCPeerConnection({ iceServers: iceServers });

      if (mediaDevices.audio) {
        pc.addTrack(mediaDevices.audio, null);
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
        }
      };

      pc.ontrack = (event) => {
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.srcObject = event.stream;
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    }

    async function toggleMute() {
      muted = !muted;
      if (mediaDevices.audio) {
        mediaDevices.audio.enabled = !muted;
      }
      const btn = node.querySelector('.voice-control-group:nth-child(1) button');
      if (btn) {
        btn.className = 'btn btn--' + (muted ? 'default' : 'danger') + ' btn--sm';
        btn.querySelector('.voice-control-label').textContent = muted ? 'Unmute' : 'Mute';
        btn.querySelector('.voice-control-icon').innerHTML = '';
        btn.querySelector('.voice-control-icon').appendChild(icon(this.muted ? 'mic-off' : 'mic', { size: 20 }));
      }
      await setSelfState({ muted: muted });
    }

    async function toggleDeafen() {
      deafened = !deafened;
      const btn = node.querySelector('.voice-control-group:nth-child(2) button');
      if (btn) {
        btn.querySelector('.voice-control-label').textContent = deafened ? 'Unmute sound' : 'Deafen';
      }
      await setSelfState({ muted: muted, deafened: deafened });
    }

    async function toggleScreenShare() {
      if (screenSharing) {
        stopScreenShare();
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        mediaDevices.video = stream.getVideoTracks()[0];
        screenSharing = true;
        const btn = node.querySelector('.voice-control-group:nth-child(3) button');
        if (btn) {
          btn.querySelector('.voice-control-label').textContent = 'Stop sharing';
          btn.querySelector('.voice-control-icon').innerHTML = '';
          btn.querySelector('.voice-control-icon').appendChild(icon('stop-screen', { size: 20 }));
        }
        if (pc) {
          pc.addTrack(mediaDevices.video, null);
        }
      } catch (e) {
        console.error('Failed to share screen:', e);
        toast('Failed to share screen: ' + (e.message || 'unknown error'), { type: 'danger' });
      }
    }

    async function stopScreenShare() {
      screenSharing = false;
      if (mediaDevices.video) {
        mediaDevices.video.stop();
        mediaDevices.video = null;
      }
      const btn = node.querySelector('.voice-control-group:nth-child(3) button');
      if (btn) {
        btn.querySelector('.voice-control-label').textContent = 'Share screen';
        btn.querySelector('.voice-control-icon').innerHTML = '';
        btn.querySelector('.voice-control-icon').appendChild(icon('screen', { size: 20 }));
      }
      if (pc) {
        const senders = pc.getSenders();
        for (const sender of senders) {
          if (sender.track && sender.track.kind === 'video') {
            sender.replaceTrack(null);
          }
        }
      }
    }

    async function setSelfState({ muted, deafened }) {
      try {
        await Api.patch('/api/voice/channels/' + channelId + '/state', {
          muted: muted !== undefined ? muted : muted,
          deafened: deafened !== undefined ? deafened : deafened,
        });
      } catch (e) {
        console.error('Failed to update state:', e);
      }
    }

    function addParticipant(userId, name, avatarUrl, isMe = false) {
      if (participantsMap.has(userId)) return;
      const participant = {
        id: userId,
        name: name || 'Unknown',
        avatarUrl: avatarUrl || null,
        speaking: false,
        muted: false,
        deafened: false,
        isMe,
      };
      participantsMap.set(userId, participant);
      renderParticipant(participant);
      participantsCount.textContent = participantsMap.size;
    }

    function renderParticipant(participant) {
      const existing = participantsList.querySelector('[data-user="' + participant.id + '"]');
      if (existing) return;

      const node = document.createElement('div');
      node.className = 'voice-participant' + (participant.isMe ? ' voice-participant-me' : '');
      node.setAttribute('data-user', participant.id);
      node.innerHTML = `
        <div class="voice-participant-avatar">
          ${participant.avatarUrl ? '<img src="' + participant.avatarUrl + '" alt="' + escapeHtml(participant.name) + '">' : '<span class="voice-avatar-placeholder">' + participant.name.charAt(0).toUpperCase() + '</span>'}
        </div>
        <div class="voice-participant-info">
          <div class="voice-participant-name">${escapeHtml(participant.name)}</div>
          <div class="voice-participant-status">${participant.muted ? 'Muted' : ''}${participant.deafened ? ' Deafened' : ''}</div>
        </div>
        <div class="voice-participant-actions">
          ${participant.isMe ? '' : '<button class="btn btn--ghost btn--sm" type="button" title="Mute ' + escapeHtml(participant.name) + '"><span class="voice-control-icon">🔇</span></button>'}
        </div>
        <div class="voice-participant-speaking">
          <div class="voice-speaking-bar"></div>
        </div>
      `;
      participantsList.appendChild(node);
    }

    function updateParticipant(userId, updates) {
      const participant = participantsMap.get(userId);
      if (!participant) return;
      Object.assign(participant, updates);
      const el = participantsList.querySelector('[data-user="' + userId + '"]');
      if (!el) return;
      const speakingBar = el.querySelector('.voice-speaking-bar');
      if (updates.speaking !== undefined) {
        speakingBar.style.opacity = participant.speaking ? '1' : '0.2';
      }
    }

    function removeParticipant(userId) {
      const el = participantsList.querySelector('[data-user="' + userId + '"]');
      if (el) el.remove();
      participantsMap.delete(userId);
      participantsCount.textContent = participantsMap.size;
    }

    async function leave() {
      screenSharing = false;
      if (mediaDevices.audio) {
        mediaDevices.audio.stop();
        mediaDevices.audio = null;
      }
      if (mediaDevices.video) {
        mediaDevices.video.stop();
        mediaDevices.video = null;
      }
      if (pc) {
        pc.close();
        pc = null;
      }
      try {
        await Api.post('/api/voice/channels/' + channelId + '/leave', {});
      } catch (e) {}
      participantsMap.clear();
      participantsList.innerHTML = '';
      participantsCount.textContent = '0';
      status.textContent = 'Left';
    }

    load();

    return {
      node,
      onMount: load,
      cleanup() {
        screenSharing = false;
        if (mediaDevices.audio) { mediaDevices.audio.stop(); mediaDevices.audio = null; }
        if (mediaDevices.video) { mediaDevices.video.stop(); mediaDevices.video = null; }
        if (pc) { pc.close(); pc = null; }
        try { Api.post('/api/voice/channels/' + channelId + '/leave', {}); } catch (e) {}
        participantsMap.clear();
        participantsList.innerHTML = '';
        participantsCount.textContent = '0';
        status.textContent = 'Left';
      },
    };
  }

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
'''

new_content = content[:start_idx] + new_voice + content[end_idx:]

with open('community.js', 'w', encoding='utf-8') as f:
    f.write(new_content)

print('Done!')
PYEOF