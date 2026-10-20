// pm2 process definitions for supervising Trycord with pm2.
//
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup            # once, so the list comes back after a reboot
//
// Three processes: the API (which also serves the web client and the public
// website), a separate status monitor, and the voice subsystem.
//
// The monitor is its own process so it can keep answering while the API is
// restarting or down — putting it inside the API process would lose that
// property.
//
// The voice subsystem is its own process because it fails differently: the
// API can be restarting while a call is still being carried, and the API's
// health says nothing about whether the relay answered a binding request.
//
// All three read backend/.env through dotenv, so database, mail, ports, and
// provider settings stay in one file rather than being copied here.
//
// The API runs in fork mode with a single instance. The shared database,
// in-memory state, realtime connections, and wallet of locks all assume one
// supervisor responsible for these processes, so the interface is 'fork', not
// 'cluster'. Increase concurrency through the configurable job worker pool
// (cpu.worker_count / cpu.concurrent_jobs) inside the process, not by adding
// PM2 instances here.
module.exports = {
  apps: [
    {
      name: 'trycord-api',
      cwd: './backend',
      script: 'src/server.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      restart_delay: 2000,
      max_memory_restart: '512M',
      kill_timeout: 5000,
    },
    {
      // The voice subsystem: the STUN and TURN service, its lifecycle, its
      // health checks and its diagnostics.
      //
      // It is a process of its own because it fails differently from the
      // application. The API can be restarting while a call is still being
      // carried, and the API's health says nothing about whether the relay
      // answered a binding request. One process that reported "I am up" and
      // another that reported "the relay answered" would be a lie told in
      // one voice.
      //
      // It reads the same backend/.env as the API, so the settings cannot
      // disagree between the two, and it binds the STUN and TURN port - so
      // the API does not bind it too.
      name: 'trycord-voice',
      cwd: './backend',
      script: 'src/voice/index.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: '192M',
      kill_timeout: 5000,
    },
    {
      name: 'trycord-status-monitor',
      cwd: './backend',
      script: 'src/status-monitor/index.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: '192M',
      kill_timeout: 5000,
    },
  ],
};