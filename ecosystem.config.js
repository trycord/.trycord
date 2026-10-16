// pm2 process definitions for a host that supervises Trycord with pm2.
//
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup            # once, so the list comes back after a reboot
//
// The API and the status monitor are deliberately separate processes. The monitor
// has to keep answering while the API is restarting or down, which is the only
// reason it exists; running it in the API's process would lose that property.
//
// Both read backend/.env through dotenv, so the database, mail and port settings
// stay in one file rather than being copied into this one. The monitor's target
// list defaults to the API on the same host (PORT above), so nothing extra is
// needed for the common single-box deployment.
module.exports = {
  apps: [
    {
      name: 'trycord-api',
      cwd: __dirname + '/backend',
      script: 'src/server.js',
      exec_mode: 'cluster',
      instances: 8,
      autorestart: true,
      restart_delay: 2000,
      max_memory_restart: '512M',
      kill_timeout: 5000,
    },
    {
      name: 'trycord-status-monitor',
      cwd: __dirname + '/backend',
      script: 'src/status-monitor/index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // A little longer than the API's: when the API is being restarted the
      // monitor should keep serving its last report, not bounce with it.
      restart_delay: 5000,
      max_memory_restart: '192M',
      kill_timeout: 5000,
    },
  ],
};
