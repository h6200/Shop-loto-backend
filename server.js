'use strict';
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cron = require('node-cron');

const db = require('./database');
const { fetchNyResults } = require('./nyResults');
const { fetchFlResults } = require('./flResults');

const app = express();
const PORT = process.env.PORT || 8080;
const ADMIN_PHONES = (process.env.ADMIN_PHONES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors());
app.use(express.json({ limit: '20mb' }));
// raw body parser pou webhook MonCash (pou verifye HMAC sou body a)
app.use('/api/payments/moncash/webhook', express.raw({ type: 'application/json' }));

// ---- MonCashConnect config ----
const MCC_BASE = 'https://api.moncashconnect.com/v1';
const MCC_SECRET = process.env.MCC_SECRET || '';
const MCC_WEBHOOK_SECRET = process.env.MCC_WEBHOOK_SECRET || '';
const RETURN_BASE = process.env.RETURN_BASE || 'https://shop-loto-backend-production.up.railway.app';

function makeToken(userId) {
  const secret = process.env.JWT_SECRET || 'boulet-vann-sekret';
  const payload = `${userId}:${Date.now()}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex') + '.' + userId;
}
function userIdFromToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const id = Number(parts[parts.length - 1]);
  return Number.isInteger(id) ? id : null;
}
function requireAuth(req, res, next) {
  const uid = userIdFromToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  const user = uid ? db.findUserById(uid) : null;
  if (!user) {
    return res.status(401).json({ error: 'Ou dwe konekte' });
  }
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  const uid = userIdFromToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  const user = uid ? db.findUserById(uid) : null;
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: 'Aksè refize' });
  }
  req.user = user;
  next();
}

function serializeUser(user) {
  const subs = db.getSubsForUser(user.id);
  const vipSubs = {};
  for (const s of subs) {
    vipSubs[s.lottery_id] = {
      lottery_id: s.lottery_id,
      plan: s.plan,
      duration: s.duration,
      price: s.price,
      start_date: s.start_date,
      end_date: s.end_date,
      status: (new Date(s.end_date).getTime() > Date.now()) ? 'active' : 'expired',
      ticket_number: s.ticket_number || null,
    };
  }
  return {
    id: String(user.id),
    phone: user.phone,
    first_name: user.first_name,
    last_name: user.last_name,
    is_admin: !!user.is_admin,
    vip_subs: vipSubs,
  };
}

app.post('/api/auth/register', (req, res) => {
  const { phone, first_name, last_name } = req.body || {};
  if (!phone || String(phone).replace(/\D/g, '').length < 8) {
    return res.status(400).json({ error: 'Nimewo telefòn pa valab' });
  }
  const cleanPhone = String(phone).replace(/\D/g, '');
  let user = db.findUserByPhone(cleanPhone);
  if (!user) {
    const isAdmin = ADMIN_PHONES.includes(cleanPhone);
    user = db.createUser(cleanPhone, first_name || '', last_name || '', isAdmin);
  }
  res.json({ token: makeToken(user.id), user: serializeUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Antre nimewo telefòn' });
  const cleanPhone = String(phone).replace(/\D/g, '');
  let user = db.findUserByPhone(cleanPhone);
  if (!user && ADMIN_PHONES.includes(cleanPhone)) {
    user = db.createUser(cleanPhone, 'Admin', 'Boss', true);
  }
  if (!user) {
    return res.status(404).json({ error: 'Kont pa egziste. Enskri dabò.' });
  }
  res.json({ token: makeToken(user.id), user: serializeUser(user) });
});

app.get('/api/results/ny', async (req, res) => {
  try {
    const cached = db.getCachedResults('ny', 60);
    if (cached.length) return res.json(toDrawResults(cached));
    const results = await fetchNyResults();
    db.upsertResults('ny', results);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: 'Pa ka jwenn rezilta NY: ' + e.message });
  }
});

app.get('/api/results/fl', async (req, res) => {
  try {
    const cached = db.getCachedResults('fl', 60);
    if (cached.length) return res.json(toDrawResults(cached));
    const results = await fetchFlResults();
    if (results.length) db.upsertResults('fl', results);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: 'Pa ka jwenn rezilta FL: ' + e.message });
  }
});

app.get('/api/results/:lottery', async (req, res) => {
  const lottery = req.params.lottery;
  if (lottery === 'ny') return res.redirect('/api/results/ny');
  if (lottery === 'fl') return res.redirect('/api/results/fl');
  res.status(404).json({ error: 'Lotri enkoni' });
});

function toDrawResults(cachedRows) {
  return cachedRows.map((r) => ({
    lottery_id: r.lottery_id,
    draw_date: r.draw_date,
    game: r.game,
    session: r.session,
    numbers: String(r.numbers).split(''),
    sum: r.sum,
    boost: r.boost,
  }));
}

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

function saveScreenshot(base64) {
  if (!base64) return '';
  try {
    const clean = base64.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(clean, 'base64');
    const name = 'shot_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + '.png';
    fs.writeFileSync(path.join(uploadDir, name), buf);
    return name;
  } catch (e) {
    return '';
  }
}

app.post('/api/payments/submit', (req, res) => {
  const { phone, name, lottery_id, plan, duration, price, screenshot_base64 } =
    req.body || {};
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  const user = db.findUserByPhone(cleanPhone);
  const filename = saveScreenshot(screenshot_base64);
  const id = db.createPayment({
    userId: user ? user.id : null,
    phone: cleanPhone,
    name: name || '',
    lotteryId: lottery_id,
    plan: plan,
    duration: duration,
    price: price,
    screenshotPath: filename,
  });
  res.json({ ok: true, id });
});

// ===== MonCashConnect peman =====
function mccHeaders() {
  return {
    'Authorization': 'Bearer ' + MCC_SECRET,
    'Content-Type': 'application/json',
    'Origin': RETURN_BASE,
  };
}

function verifyMcWebhookSignature(rawBody, signature, timestamp) {
  if (!MCC_WEBHOOK_SECRET) return false;
  if (!signature || !rawBody) return false;
  const expected = crypto.createHmac('sha256', MCC_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  const provided = String(signature).replace(/^sha256=/, '');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function activatePaymentSubscription(p) {
  // Menm lojik ak /api/admin/payments/:id/approve
  const user = db.findUserByPhone(p.phone);
  if (user) {
    const days = p.duration === 'week' ? 7 : p.duration === 'year' ? 365 : 30;
    const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    db.createSubscription(user.id, p.lottery_id, p.plan, p.duration, p.price, end);
  }
}

app.post('/api/payments/moncash/create', requireAuth, async (req, res) => {
  const { lotteryId, plan, duration, price } = req.body || {};
  const cleanLottery = ['ny', 'fl'].includes(lotteryId) ? lotteryId : 'ny';
  const cleanPlan = ['basic', 'silver', 'gold'].includes(plan) ? plan : 'basic';
  const cleanDuration = ['week', 'month', 'year'].includes(duration) ? duration : 'month';
  const amount = Math.round(Number(price) || 0);
  if (amount < 1 || amount > 100000) {
    return res.status(400).json({ error: 'Pri pa valab' });
  }
  if (!MCC_SECRET) {
    return res.status(500).json({ error: 'Peman MonCash poko konfigire sou sewè a' });
  }

  const user = req.user;
  const reference = 'sl_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

  const paymentId = db.createPayment({
    userId: user.id,
    phone: user.phone,
    name: (user.first_name + ' ' + user.last_name).trim(),
    lotteryId: cleanLottery,
    plan: cleanPlan,
    duration: cleanDuration,
    price: amount,
    screenshotPath: '',
    moncashReference: reference,
  });

  try {
    const mcRes = await fetch(MCC_BASE + '/pay-create', {
      method: 'POST',
      headers: {
        ...mccHeaders(),
        'Idempotency-Key': reference,
      },
      body: JSON.stringify({
        amount: amount,
        referenceId: reference,
        returnUrl: RETURN_BASE + '/api/payments/moncash/return?ref=' + reference,
        customerName: (user.first_name + ' ' + user.last_name).trim() || undefined,
        customerEmail: undefined,
      }),
    });
    const mcData = await mcRes.json().catch(() => ({}));
    if (!mcRes.ok) {
      console.error('[mcc] pay-create echwe:', mcRes.status, JSON.stringify(mcData));
      return res.status(502).json({ error: mcData.error || 'MonCash pay-create echwe' });
    }
    res.json({
      ok: true,
      paymentId: String(paymentId),
      referenceId: reference,
      paymentUrl: mcData.paymentUrl,
      expiresAt: mcData.expiresAt,
      livemode: !!mcData.livemode,
    });
  } catch (e) {
    console.error('[mcc] pay-create erè:', e.message);
    res.status(502).json({ error: 'Pa ka konekte ak MonCash' });
  }
});

app.get('/api/payments/moncash/status', requireAuth, async (req, res) => {
  const ref = req.query.referenceId || req.query.reference || '';
  if (!ref) return res.status(400).json({ error: 'referenceId obligatwa' });
  if (!MCC_SECRET) return res.status(500).json({ error: 'Peman MonCash poko konfigire' });
  try {
    const mcRes = await fetch(MCC_BASE + '/pay-status?referenceId=' + encodeURIComponent(ref), {
      method: 'GET',
      headers: mccHeaders(),
    });
    const mcData = await mcRes.json().catch(() => ({}));
    if (!mcRes.ok) {
      return res.status(502).json({ error: mcData.error || 'MonCash pay-status echwe' });
    }
    if (mcData.status === 'completed') {
      const p = db.getPaymentByMoncashReference(ref);
      if (p && p.status !== 'approved') {
        db.updatePaymentStatus(p.id, 'approved');
        activatePaymentSubscription(p);
      }
    }
    res.json(mcData);
  } catch (e) {
    res.status(502).json({ error: 'Pa ka konekte ak MonCash' });
  }
});

app.get('/api/payments/moncash/return', (req, res) => {
  const ref = req.query.ref || '';
  res.redirect(RETURN_BASE + '/api/payments/moncash/done?ref=' + encodeURIComponent(ref));
});

app.get('/api/payments/moncash/done', (req, res) => {
  res.type('html').send('<h2>Peman fini. Ou ka retounen nan app la.</h2>');
});

app.post('/api/payments/moncash/webhook', (req, res) => {
  const rawBody = req.body;
  const rawStr = rawBody ? rawBody.toString('utf8') : '';
  const signature = req.headers['x-mcc-signature'] || '';
  const timestamp = req.headers['x-mcc-timestamp'] || '';

  const ok = verifyMcWebhookSignature(rawStr, signature, timestamp);
  if (!ok) {
    console.error('[mcc] webhook siyati pa valab');
    return res.status(401).json({ error: 'Siyati pa valab' });
  }

  let event;
  try {
    event = JSON.parse(rawStr);
  } catch (e) {
    return res.status(400).json({ error: 'Body pa valab' });
  }

  const reference = event.referenceId || event.reference || event.data?.referenceId || null;
  if (!reference) return res.status(400).json({ error: 'referenceId manke' });

  const p = db.getPaymentByMoncashReference(reference);
  if (!p) {
    return res.json({ received: true });
  }

  const status = event.status || event.type || '';
  if (status === 'payment.completed' || status === 'completed' || event.type === 'payment.completed') {
    if (p.status !== 'approved') {
      db.updatePaymentStatus(p.id, 'approved');
      activatePaymentSubscription(p);
    }
  } else if (status === 'payment.failed' || status === 'failed') {
    if (p.status === 'pending') db.updatePaymentStatus(p.id, 'failed');
  } else if (status === 'payment.cancelled' || status === 'cancelled') {
    if (p.status === 'pending') db.updatePaymentStatus(p.id, 'cancelled');
  }

  res.json({ received: true });
});

app.get('/api/payments/mine', requireAuth, (req, res) => {
  const rows = db.listPaymentsByPhone(req.user.phone);
  res.json(rows.map((r) => serializePayment(r)));
});

function serializePayment(r) {
  return {
    id: String(r.id),
    user_id: String(r.user_id || ''),
    phone: r.phone,
    name: r.name,
    lottery_id: r.lottery_id,
    plan: r.plan,
    duration: r.duration,
    price: r.price,
    screenshot_url: r.screenshot_path ? '/api/admin/screenshot/' + r.screenshot_path : '',
    status: r.status,
    created_at: r.created_at,
  };
}

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: serializeUser(req.user) });
});

app.get('/api/admin/payments', requireAdmin, (req, res) => {
  const rows = db.listPayments();
  res.json(rows.map((r) => serializePayment(r)));
});

app.get('/api/admin/screenshot/:file', requireAdmin, (req, res) => {
  const file = path.join(uploadDir, path.basename(req.params.file));
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).json({ error: 'Pa jwenn imaj la' });
});

app.post('/api/admin/payments/:id/approve', requireAdmin, (req, res) => {
  const p = db.getPaymentById(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Demann pa egziste' });
  db.updatePaymentStatus(p.id, 'approved');

  const user = db.findUserByPhone(p.phone);
  if (user) {
    const days = p.duration === 'week' ? 7 : p.duration === 'year' ? 365 : 30;
    const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    db.createSubscription(user.id, p.lottery_id, p.plan, p.duration, p.price, end);
  }
  res.json({ ok: true });
});

app.post('/api/admin/payments/:id/reject', requireAdmin, (req, res) => {
  const p = db.getPaymentById(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Demann pa egziste' });
  db.updatePaymentStatus(p.id, 'rejected');
  res.json({ ok: true });
});

app.get('/api/bols', (req, res) => {
  const lotteryId = req.query.lottery_id || null;
  const category = req.query.category || null;
  const rows = db.listBols(lotteryId, category);
  res.json(rows.map((b) => serializeBol(b)));
});

app.get('/api/bols/mine', requireAuth, (req, res) => {
  const subs = db.getActiveSubsForUser(req.user.id);
  const subsOut = subs.map((s) => ({
    lottery_id: s.lottery_id,
    plan: s.plan,
    duration: s.duration,
    end_date: s.end_date,
    status: 'active',
    ticket_number: s.ticket_number || null,
  }));
  if (!subs.length) return res.json({ bols: [], subs: [] });

  for (const s of subs) {
    const owned = db.getBolsByBuyer(req.user.phone).filter(
      (b) => b.lottery_id === s.lottery_id && b.category === s.plan
    );
    if (owned.length === 0) {
      db.assignAvailableBol(s.lottery_id, s.plan, req.user.phone);
    }
  }

  const myBols = db.getBolsByBuyer(req.user.phone);
  res.json({ bols: myBols.map((b) => serializeBol(b)), subs: subsOut });
});

app.post('/api/bols/:id/buy', requireAuth, (req, res) => {
  const user = req.user;
  const result = db.buyBol(Number(req.params.id), user.phone);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, bol: serializeBol(result.bol) });
});

function serializeBol(b) {
  return {
    id: String(b.id),
    lottery_id: b.lottery_id,
    number: b.number,
    category: b.category,
    price: b.price,
    status: b.status,
    buyer_phone: b.buyer_phone || null,
    created_at: b.created_at,
  };
}

app.post('/api/admin/bols', requireAdmin, (req, res) => {
  const { lottery_id, number, category, price } = req.body || {};
  const cleanNum = String(number || '').trim();
  if (!/^\d{2}$/.test(cleanNum)) {
    return res.status(400).json({ error: 'Nimewo dwe 2 chif (00-99)' });
  }
  const numPrice = Number(price);
  if (!Number.isFinite(numPrice) || numPrice <= 0) {
    return res.status(400).json({ error: 'Pri pa valab' });
  }
  const bol = db.createBol(lottery_id || 'ny', cleanNum, category || 'basic', numPrice);
  res.json({ ok: true, id: String(bol.id) });
});

app.delete('/api/admin/bols/:id', requireAdmin, (req, res) => {
  db.removeBol(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  res.json(db.getDashboardStats());
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(db.listUsers().map((u) => serializeUser(u)));
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

async function syncResults() {
  try {
    const ny = await fetchNyResults();
    if (ny.length) db.upsertResults('ny', ny);
    console.log('[sync] NY rezilta mete ajou:', ny.length);
  } catch (e) {
    console.error('[sync] NY echwe:', e.message);
  }
  try {
    const fl = await fetchFlResults();
    if (fl.length) db.upsertResults('fl', fl);
    console.log('[sync] FL rezilta mete ajou:', fl.length);
  } catch (e) {
    console.error('[sync] FL echwe:', e.message);
  }
}
cron.schedule('*/30 * * * *', syncResults);
syncResults();

app.listen(PORT, () => {
  console.log(`Shop loto backend ap koute sou pò ${PORT}`);
});
