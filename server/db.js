const { PrismaClient, Prisma } = require('@prisma/client');
require('./config'); // loads .env so DATABASE_URL is available

const prisma = new PrismaClient({
  // Expected conflicts (duplicate link, stale edit...) are answered as 4xx by the error handler,
  // so Prisma's own error logging is off. Set PRISMA_LOG=1 to see every query while debugging.
  log: process.env.PRISMA_LOG ? ['query', 'warn', 'error'] : ['warn'],
});

module.exports = { prisma, Prisma };
