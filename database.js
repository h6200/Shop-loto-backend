'use strict';
const fs = require('fs');
const path = require('path');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'data.json');

const state = {
  users: [],
  subscriptions: [],
  payments: [],
  results: [],
  bols: [],
  counters: { user: 0, sub: 0, payment: 0, bol: 0, ticket: 0 },
};

function load() {
  try {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(dbPath)) {
      const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      state.users = raw.users || [];
      state.subscriptions = raw.subscriptions || [];
      state.payments = raw.payments || [];
      state.results = raw.results || [];
      state.bols = raw.bols || [];
      state.counters = raw.counters || { user: 0, sub: 0, payment: 0, bol: 0, ticket: 0 };
    }
  } catch (e) {
    console.error('[db] chaj echwe:', e.message);
  }
}
function save() {
  try {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dbPath, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[db] sov echwe:', e.message);
  }
}
load();

function nowIso() {
  return new Date().toISOString();
}

function findUserByPhone(phone) {
  return state.users.find((u) => u.phone === phone) || null;
}
function findUserById(id) {
  return state.users.find((u) => u.id === id) || null;
}
function listUsers() {
  return [...state.users];
}
function createUser(phone, firstName, lastName, isAdmin) {
  const id = ++state.counters.user;
  const user = {
    id,
    phone,
    first_name: firstName || '',
    last_name: lastName || '',
    is_admin: isAdmin ? 1 : 0,
    created_at: nowIso(),
  };
  state.users.push(user);
  save();
  return user;
}

function getActiveSubsForUser(userId) {
  const now = Date.now();
  return state.subscriptions
    .filter((s) => s.user_id === userId && new Date(s.end_date).getTime() > now)
    .sort((a, b) => new Date(b.end_date) - new Date(a.end_date));
}
function getSubsForUser(userId) {
  return state.subscriptions
    .filter((s) => s.user_id === userId)
    .sort((a, b) => new Date(b.end_date) - new Date(a.end_date));
}

// Gen yon nimewo tikèt inik SHP-2026-XXXXXX
function nextTicketNumber() {
  if (!state.counters.ticket) state.counters.ticket = 0;
  state.counters.ticket += 1;
  const year = new Date().getFullYear();
  const num = String(state.counters.ticket).padStart(6, '0');
  return 'SHP-' + year + '-' + num;
}

function createSubscription(userId, lotteryId, plan, duration, price, endDate, ticketNumber) {
  const id = ++state.counters.sub;
  const sub = {
    id,
    user_id: userId,
    lottery_id: lotteryId,
    plan,
    duration,
    price,
    start_date: nowIso(),
    end_date: endDate,
    status: 'active',
    ticket_number: ticketNumber || nextTicketNumber(),
  };
  state.subscriptions.push(sub);
  save();
  return id;
}

function createPayment(data) {
  const id = ++state.counters.payment;
  const p = {
    id,
    user_id: data.userId || null,
    phone: data.phone || '',
    name: data.name || '',
    lottery_id: data.lotteryId || '',
    plan: data.plan || '',
    duration: data.duration || '',
    price: data.price || 0,
    screenshot_path: data.screenshotPath || '',
    moncash_reference: data.moncashReference || null,
    status: 'pending',
    created_at: nowIso(),
  };
  state.payments.push(p);
  save();
  return id;
}
function getPaymentById(id) {
  return state.payments.find((p) => p.id === id) || null;
}
function getPaymentByMoncashReference(ref) {
  return state.payments.find((p) => p.moncash_reference === ref) || null;
}
function listPayments() {
  return [...state.payments].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}
function listPaymentsByPhone(phone) {
  return state.payments
    .filter((p) => p.phone === phone)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}
function updatePaymentStatus(id, status) {
  const p = getPaymentById(id);
  if (p) {
    p.status = status;
    save();
  }
  return p;
}

function listBols(lotteryId, category) {
  let list = state.bols;
  if (lotteryId) list = list.filter((b) => b.lottery_id === lotteryId);
  if (category) list = list.filter((b) => b.category === category);
  return [...list].sort((a, b) => a.number.localeCompare(b.number));
}
function getBolById(id) {
  return state.bols.find((b) => b.id === id) || null;
}
function getBolsByBuyer(phone) {
  return state.bols
    .filter((b) => b.buyer_phone === phone)
    .sort((a, b) => a.lottery_id.localeCompare(b.lottery_id) || a.number.localeCompare(b.number));
}
function assignAvailableBol(lotteryId, category, buyerPhone) {
  const bol = state.bols.find(
    (b) => b.lottery_id === lotteryId && b.category === category && b.status === 'available'
  );
  if (!bol) return null;
  bol.status = 'sold';
  bol.buyer_phone = buyerPhone;
  save();
  return bol;
}
function createBol(lotteryId, number, category, price) {
  const id = ++state.counters.bol;
  const bol = {
    id,
    lottery_id: lotteryId,
    number,
    category,
    price,
    status: 'available',
    buyer_phone: null,
    created_at: nowIso(),
  };
  state.bols.push(bol);
  save();
  return bol;
}
function removeBol(id) {
  state.bols = state.bols.filter((b) => b.id !== id);
  save();
  return true;
}
function buyBol(id, buyerPhone) {
  const bol = getBolById(id);
  if (!bol) return { ok: false, error: 'Boul pa egziste' };
  if (bol.status !== 'available') return { ok: false, error: 'Boul sa a deja vann' };
  bol.status = 'sold';
  bol.buyer_phone = buyerPhone;
  save();
  return { ok: true, bol };
}

function upsertResults(lotteryId, results) {
  state.results = state.results.filter((r) => r.lottery_id !== lotteryId);
  for (const r of results) {
    state.results.push({
      lottery_id: lotteryId,
      draw_date: r.draw_date,
      game: r.game,
      session: r.session,
      numbers: Array.isArray(r.numbers) ? r.numbers.join('') : String(r.numbers),
      sum: r.sum || null,
      boost: r.boost || null,
      fetched_at: nowIso(),
    });
  }
  save();
}
function getCachedResults(lotteryId, limit) {
  return state.results
    .filter((r) => r.lottery_id === lotteryId)
    .sort((a, b) => new Date(b.draw_date) - new Date(a.draw_date))
    .slice(0, limit || 60);
}

function getDashboardStats() {
  const now = Date.now();
  const totalUsers = state.users.length;
  const totalVip = state.subscriptions.filter((s) => new Date(s.end_date).getTime() > now).length;
  const totalRevenue = state.payments
    .filter((p) => p.status === 'approved')
    .reduce((a, p) => a + (Number(p.price) || 0), 0);
  const pendingCount = state.payments.filter((p) => p.status === 'pending').length;
  const totalBols = state.bols.length;
  const soldBols = state.bols.filter((b) => b.status === 'sold').length;
  return {
    total_users: totalUsers,
    total_vip: totalVip,
    total_revenue: totalRevenue,
    pending_count: pendingCount,
    total_bols: totalBols,
    sold_bols: soldBols,
  };
}

module.exports = {
  findUserByPhone,
  findUserById,
  listUsers,
  createUser,
  getActiveSubsForUser,
  getSubsForUser,
  createSubscription,
  nextTicketNumber,
  createPayment,
  getPaymentById,
  getPaymentByMoncashReference,
  listPayments,
  listPaymentsByPhone,
  updatePaymentStatus,
  listBols,
  getBolById,
  getBolsByBuyer,
  assignAvailableBol,
  createBol,
  removeBol,
  buyBol,
  upsertResults,
  getCachedResults,
  getDashboardStats,
};
