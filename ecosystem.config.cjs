module.exports = {
  apps: [{
    name: 'brain-service',
    script: 'dist/index.js',
    cwd: '/root/brain-service',
    env: {
      NODE_ENV: 'production',
      PORT: '3002',
    },
    restart_delay: 5000,
    max_restarts: 10,
  }],
};
