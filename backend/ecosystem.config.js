module.exports = {
  apps: [{
    name: 'trycord-api',
    script: './src/server.js',
    cwd: '/home/ultim/trycord/.trycord/backend',
    env_file: '.env',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G'
  }]
};