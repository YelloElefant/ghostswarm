const Redis = require('ioredis');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
module.exports = {
   redis,
}