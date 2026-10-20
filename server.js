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
// PIN sekrè admin (env var ADMIN_PIN). APK pa janm gen PIN nan — li verifye atravè header X-Admin-Pin.
const ADMIN_PIN = (process.env.ADMIN_PIN || '').trim();

app.use(cors());
// raw body parser pou webhook Kobara APEVA express.json pou kenbe body a byte-pou-byte
app.use('/api/payments/kobara/webhook', express.raw({ type: 'application/json' }));
// kenbe ansyen wout MonCash pou kontinyite (men li itilize Kobara kounye a)
app.use('/api/payments/moncash/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '20mb' }));

// ---- Kobara config ----
const KOBARA_BASE = 'https://api.kobara.app/v1';
const KOBARA_SECRET_KEY = process.env.KOBARA_SECRET_KEY || '';
const KOBARA_WEBHOOK_SECRET = process.env.KOBARA_WEBHOOK_SECRET || '';
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
  // Double sekirite: itilizatè dwe make kòm admin (numéro telefòn admin)
  // EPI bay PIN sekrè valab (nan env var ADMIN_PIN sou backend sèlman).
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: 'Aksè refize' });
  }
  const pin = (req.headers['x-admin-pin'] || '').toString().trim();
  if (!ADMIN_PIN || pin !== ADMIN_PIN) {
    return res.status(403).json({ error: 'PIN admin pa valab' });
  }
  req.user = user;
  next();
}

// Verifye PIN admin san yo pa ekspoze PIN nan APK. Sèlman verifye match.
app.post('/api/admin/verify-pin', requireAuth, (req, res) => {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Aksè refize' });
  }
  const pin = (req.body && req.body.pin ? String(req.body.pin).trim() : '');
  if (!ADMIN_PIN) {
    return res.status(500).json({ error: 'ADMIN_PIN pa konfigir sou sèvè a' });
  }
  if (pin === ADMIN_PIN) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'PIN pa kòrèk' });
});

function serializeUser(user) {
  const subs = db.getSubsForUser(user.id);
  const vipSubs = {};
  for (const s of subs) {
    const product = s.product || 'bol';
    const key = s.lottery_id + ':' + product;
    const status = (s.status === 'cancelled')
      ? 'cancelled'
      : ((new Date(s.end_date).getTime() > Date.now()) ? 'active' : 'expired');
    // Kenbe dènye abònman aktif pou chak kategori (youn nan kategori)
    if (vipSubs[key] && status !== 'active') continue;
    vipSubs[key] = {
      id: s.id,
      lottery_id: s.lottery_id,
      product: product,
      plan: s.plan,
      duration: s.duration,
      price: s.price,
      start_date: s.start_date,
      end_date: s.end_date,
      status: status,
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
  const { phone, name, lottery_id, plan, duration, price, screenshot_base64, product } =
    req.body || {};
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  const cleanProduct = product === 'chif3' ? 'chif3' : 'bol';
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
    product: cleanProduct,
    screenshotPath: filename,
  });
  res.json({ ok: true, id });
});

// ===== Kobara peman (MonCash + NatCash atravè yon sèl API) =====
function kobaraHeaders() {
  return {
    'Authorization': 'Bearer ' + KOBARA_SECRET_KEY,
    'Content-Type': 'application/json',
  };
}

function verifyKobaraWebhookSignature(rawBody, signatureHeader, envHeader) {
  if (!KOBARA_WEBHOOK_SECRET) return false;
  if (!signatureHeader || !rawBody) return false;
  const match = String(signatureHeader).match(/^t=(\d+),v1=([a-f0-9]{64})$/);
  if (!match) return false;
  const timestamp = match[1];
  const signature = match[2];
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > 300) return false;
  const expected = crypto
    .createHmac('sha256', KOBARA_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function activatePaymentSubscription(p) {
  // Menm lojik ak /api/admin/payments/:id/approve
  const user = db.findUserByPhone(p.phone);
  if (user) {
    const days = p.duration === 'week' ? 7 : p.duration === 'year' ? 365 : 30;
    const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    db.createSubscription(user.id, p.lottery_id, p.plan, p.duration, p.price, end, null, p.product || 'bol');
  }
}

app.post('/api/payments/moncash/create', requireAuth, async (req, res) => {
  const { lotteryId, plan, duration, price, product } = req.body || {};
  const cleanLottery = ['ny', 'fl'].includes(lotteryId) ? lotteryId : 'ny';
  const cleanPlan = ['basic', 'silver', 'gold'].includes(plan) ? plan : 'basic';
  const cleanDuration = ['week', 'month', 'year'].includes(duration) ? duration : 'month';
  const cleanProduct = (product === 'chif3') ? 'chif3' : 'bol';
  const amount = Math.round(Number(price) || 0);
  if (amount < 1 || amount > 100000) {
    return res.status(400).json({ error: 'Pri pa valab' });
  }
  if (!KOBARA_SECRET_KEY) {
    return res.status(500).json({ error: 'Peman poko konfigire sou sewè a' });
  }

  const user = req.user;
  const idempotencyKey = 'sl_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
  const fullName = (user.first_name + ' ' + user.last_name).trim();

  try {
    const kbRes = await fetch(KOBARA_BASE + '/payments', {
      method: 'POST',
      headers: {
        ...kobaraHeaders(),
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        amount: amount,
        currency: 'HTG',
        provider: 'kobara',
        description: 'Abonnement VIP Shop loto',
        customer: {
          name: fullName || undefined,
          phone: user.phone,
        },
        metadata: {
          order_id: idempotencyKey,
          lottery_id: cleanLottery,
          plan: cleanPlan,
          duration: cleanDuration,
          product: cleanProduct,
          user_phone: user.phone,
        },
        success_url: RETURN_BASE + '/api/payments/moncash/done',
        cancel_url: RETURN_BASE + '/api/payments/moncash/done',
      }),
    });
    const kbData = await kbRes.json().catch(() => ({}));
    if (!kbRes.ok || !kbData.data) {
      const err = (kbData.error && kbData.error.message) ? kbData.error.message : (kbData.error || 'Kobara pay-create echwe');
      console.error('[kobara] pay-create echwe:', kbRes.status, JSON.stringify(kbData));
      return res.status(502).json({ error: err });
    }

    const reference = kbData.data.reference || kbData.data.id;
    const checkoutUrl = kbData.data.checkout_url || kbData.data.paymentUrl || kbData.data.url || kbData.data.payment_url || '';

    // Enrejistre peman nan db nou pou suiv li (estati = pending)
    const paymentId = db.createPayment({
      userId: user.id,
      phone: user.phone,
      name: fullName,
      lotteryId: cleanLottery,
      plan: cleanPlan,
      duration: cleanDuration,
      product: cleanProduct,
      price: amount,
      screenshotPath: '',
      moncashReference: reference,
    });

    res.json({
      ok: true,
      paymentId: String(paymentId),
      referenceId: reference,
      paymentUrl: checkoutUrl,
      livemode: kbData.data.environment === 'live',
    });
  } catch (e) {
    console.error('[kobara] pay-create erè:', e.message);
    res.status(502).json({ error: 'Pa ka konekte ak Kobara' });
  }
});

// Estati peman: li menm db nou an (Kobara pa gen endpointe piblik pou poll estati).
app.get('/api/payments/moncash/status', requireAuth, (req, res) => {
  const ref = req.query.referenceId || req.query.reference || '';
  if (!ref) return res.status(400).json({ error: 'referenceId obligatwa' });
  const p = db.getPaymentByMoncashReference(ref);
  if (!p) return res.json({ status: 'unknown' });
  // Map estati entèn nou an -> sa app la atann
  let status = 'pending';
  if (p.status === 'approved') status = 'completed';
  else if (p.status === 'rejected' || p.status === 'failed') status = 'failed';
  else if (p.status === 'cancelled') status = 'cancelled';
  res.json({ status: status, internal: p.status });
});

app.get('/api/payments/moncash/return', (req, res) => {
  const ref = req.query.ref || '';
  res.redirect(RETURN_BASE + '/api/payments/moncash/done?ref=' + encodeURIComponent(ref));
});

app.get('/api/payments/moncash/done', (req, res) => {
  res.type('html').send('<h2>Peman fini. Ou ka retounen nan app la.</h2>');
});

// ---- Webhook Kobara ----
function handleKobaraWebhookEvent(rawStr, res) {
  const event = JSON.parse(rawStr);
  const eventType = event.event_type || event.type || '';
  const data = event.data || {};
  const reference = data.reference || data.id || event.reference || null;

  const p = reference ? db.getPaymentByMoncashReference(reference) : null;
  if (!p) {
    // Pa konnen peman sa a men aksèpte (pou evite retries infinies) si evènman pa kritik
    return res.json({ received: true });
  }

  if (eventType === 'payment.succeeded' || data.status === 'succeeded') {
    if (p.status !== 'approved') {
      db.updatePaymentStatus(p.id, 'approved');
      activatePaymentSubscription(p);
    }
  } else if (eventType === 'payment.failed' || data.status === 'failed') {
    if (p.status === 'pending') db.updatePaymentStatus(p.id, 'failed');
  } else if (eventType === 'payment.cancelled' || data.status === 'cancelled') {
    if (p.status === 'pending') db.updatePaymentStatus(p.id, 'cancelled');
  }

  res.json({ received: true });
}

app.post('/api/payments/kobara/webhook', (req, res) => {
  const rawBody = req.body;
  const rawStr = rawBody ? rawBody.toString('utf8') : '';
  const signature = req.headers['kobara-signature'] || '';
  const envHeader = req.headers['kobara-environment'] || '';

  const ok = verifyKobaraWebhookSignature(rawStr, signature, envHeader);
  if (!ok) {
    console.error('[kobara] webhook siyati pa valab');
    return res.status(401).json({ error: 'Siyati pa valab' });
  }

  try {
    return handleKobaraWebhookEvent(rawStr, res);
  } catch (e) {
    console.error('[kobara] webhook parse erè:', e.message);
    return res.status(400).json({ error: 'Body pa valab' });
  }
});

// Ansyen wout MonCash webhook -> redireksyon entèn pou kontinyite
app.post('/api/payments/moncash/webhook', (req, res) => {
  const rawBody = req.body;
  const rawStr = rawBody ? rawBody.toString('utf8') : '';
  const signature = req.headers['kobara-signature'] || req.headers['x-mcc-signature'] || '';

  const ok = verifyKobaraWebhookSignature(rawStr, signature);
  if (!ok) {
    console.error('[kobara] webhook (ansyen wout) siyati pa valab');
    return res.status(401).json({ error: 'Siyati pa valab' });
  }

  try {
    return handleKobaraWebhookEvent(rawStr, res);
  } catch (e) {
    return res.status(400).json({ error: 'Body pa valab' });
  }
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
    product: r.product || 'bol',
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

// Anile / kanpe yon plan VIP (itilizatè sèlman ka anile pwòp abònman li).
app.post('/api/subscriptions/:id/cancel', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Id abònman pa valab' });
  }
  const sub = db.cancelSubscription(id, req.user.id);
  if (!sub) {
    return res.status(404).json({ error: 'Abònman pa egziste' });
  }
  res.json({ ok: true, user: serializeUser(req.user) });
});

// Admin ka anile nenpòt abònman VIP (pou chak itilizatè, depi panel admin).
app.post('/api/admin/subscriptions/:id/cancel', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Id abònman pa valab' });
  }
  const sub = db.adminCancelSubscription(id);
  if (!sub) {
    return res.status(404).json({ error: 'Abònman pa egziste' });
  }
  res.json({ ok: true, subscription_id: sub.id, status: sub.status });
});

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  res.json(db.getDashboardStats());
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(db.listUsers().map((u) => serializeUser(u)));
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
    db.createSubscription(user.id, p.lottery_id, p.plan, p.duration, p.price, end, null, p.product || 'bol');
  }
  res.json({ ok: true });
});

app.post('/api/admin/payments/:id/reject', requireAdmin, (req, res) => {
  const p = db.getPaymentById(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Demann pa egziste' });
  db.updatePaymentStatus(p.id, 'rejected');
  res.json({ ok: true });
});

app.delete('/api/admin/payments/:id', requireAdmin, (req, res) => {
  const p = db.getPaymentById(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Demann pa egziste' });
  db.deletePayment(p.id);
  res.json({ ok: true });
});

app.get('/api/bols', (req, res) => {
  const lotteryId = req.query.lottery_id || null;
  const category = req.query.category || null;
  const rows = db.listBols(lotteryId, category);
  res.json(rows.map((b) => serializeBol(b)));
});

app.get('/api/bols/mine', requireAuth, (req, res) => {
  const subs = db.getActiveSubsForUser(req.user.id).filter((s) => (s.product || 'bol') === 'bol');
  const subsOut = subs.map((s) => ({
    lottery_id: s.lottery_id,
    product: s.product || 'bol',
    plan: s.plan,
    duration: s.duration,
    end_date: s.end_date,
    status: 'active',
    ticket_number: s.ticket_number || null,
  }));
  if (!subs.length) return res.json({ bols: [], subs: [] });

  for (const s of subs) {
    db.assignAvailableBol(s.lottery_id, s.plan, req.user.phone);
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

// Kreye plizyè boul alafwa (plage '01-15' oswa lis '01,05,12,33')
app.post('/api/admin/bols/bulk', requireAdmin, (req, res) => {
  const { lottery_id, numbers, category, price } = req.body || {};
  const cleanId = lottery_id || 'ny';

  // Parse 'numbers': ka yon etabli, yon chèn '01-15', oswa yon chèn '01,05,12'
  let nums = [];
  if (Array.isArray(numbers)) {
    nums = numbers.map((n) => String(n).trim());
  } else {
    const raw = String(numbers || '').trim();
    if (!raw) return res.status(400).json({ error: 'Bay nimewo yo' });
    nums = raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // Expand plage yo (egzanp '01-15' -> 01..15)
  const expanded = [];
  const rangeRe = /^(\d{1,2})-(\d{1,2})$/;
  for (const n of nums) {
    const m = n.match(rangeRe);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      if (b - a > 200) return res.status(400).json({ error: 'Plage a twò laj' });
      for (let i = a; i <= b; i++) expanded.push(String(i).padStart(2, '0'));
    } else {
      expanded.push(n);
    }
  }

  // Valide chak nimewo (2 chif 00-99)
  const cleanNums = [];
  for (const n of expanded) {
    const c = String(n).replace(/\D/g, '');
    if (!/^\d{1,2}$/.test(c)) {
      return res.status(400).json({ error: 'Nimewo pa valab: ' + n });
    }
    cleanNums.push(c.length === 1 ? '0' + c : c);
  }
  if (!cleanNums.length) return res.status(400).json({ error: 'Bay nimewo yo' });

  const numPrice = Number(price);
  if (!Number.isFinite(numPrice) || numPrice <= 0) {
    return res.status(400).json({ error: 'Pri pa valab' });
  }

  const created = [];
  for (const n of cleanNums) {
    const bol = db.createBol(cleanId, n, category || 'basic', numPrice);
    created.push(String(bol.id));
  }
  res.json({ ok: true, ids: created, count: created.length });
});

// ===== Loto 3 chif (000-999) =====
function serializeChif3(b) {
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

app.get('/api/chif3', (req, res) => {
  const lotteryId = req.query.lottery_id || null;
  const category = req.query.category || null;
  res.json(db.listChif3(lotteryId, category).map(serializeChif3));
});

app.get('/api/chif3/mine', requireAuth, (req, res) => {
  const subs = db.getActiveSubsForUser(req.user.id).filter((s) => (s.product || 'bol') === 'chif3');
  const subsOut = subs.map((s) => ({
    lottery_id: s.lottery_id,
    product: s.product || 'bol',
    plan: s.plan,
    duration: s.duration,
    end_date: s.end_date,
    status: 'active',
    ticket_number: s.ticket_number || null,
  }));
  if (!subs.length) return res.json({ chif3: [], subs: [] });

  for (const s of subs) {
    db.assignAvailableChif3(s.lottery_id, s.plan, req.user.phone);
  }

  const mine = db.getChif3ByBuyer(req.user.phone);
  res.json({ chif3: mine.map(serializeChif3), subs: subsOut });
});

app.post('/api/admin/chif3', requireAdmin, (req, res) => {
  const { lottery_id, number, category, price } = req.body || {};
  const cleanNum = String(number || '').replace(/\D/g, '');
  if (!/^\d{1,3}$/.test(cleanNum)) {
    return res.status(400).json({ error: 'Nimewo dwe 3 chif (000-999)' });
  }
  const numPrice = Number(price);
  if (!Number.isFinite(numPrice) || numPrice <= 0) {
    return res.status(400).json({ error: 'Pri pa valab' });
  }
  const c = db.createChif3(lottery_id || 'ny', cleanNum.padStart(3, '0'), category || 'basic', numPrice);
  res.json({ ok: true, id: String(c.id) });
});

app.delete('/api/admin/chif3/:id', requireAdmin, (req, res) => {
  db.removeChif3(Number(req.params.id));
  res.json({ ok: true });
});

// Kreye plizyè nimewo 3 chif alafwa (plage '000-015' oswa lis '000,015,123')
app.post('/api/admin/chif3/bulk', requireAdmin, (req, res) => {
  const { lottery_id, numbers, category, price } = req.body || {};
  const cleanId = lottery_id || 'ny';

  let nums = [];
  if (Array.isArray(numbers)) {
    nums = numbers.map((n) => String(n).trim());
  } else {
    const raw = String(numbers || '').trim();
    if (!raw) return res.status(400).json({ error: 'Bay nimewo yo' });
    nums = raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const expanded = [];
  const rangeRe = /^(\d{1,3})-(\d{1,3})$/;
  for (const n of nums) {
    const m = n.match(rangeRe);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      if (b - a > 300) return res.status(400).json({ error: 'Plage a twò laj' });
      for (let i = a; i <= b; i++) expanded.push(String(i).padStart(3, '0'));
    } else {
      expanded.push(n);
    }
  }

  const cleanNums = [];
  for (const n of expanded) {
    const c = String(n).replace(/\D/g, '');
    if (!/^\d{1,3}$/.test(c)) {
      return res.status(400).json({ error: 'Nimewo pa valab: ' + n });
    }
    cleanNums.push(c.padStart(3, '0'));
  }
  if (!cleanNums.length) return res.status(400).json({ error: 'Bay nimewo yo' });
  if (cleanNums.some((n) => Number(n) > 999)) {
    return res.status(400).json({ error: 'Nimewo dwe ant 000 ak 999' });
  }

  const numPrice = Number(price);
  if (!Number.isFinite(numPrice) || numPrice <= 0) {
    return res.status(400).json({ error: 'Pri pa valab' });
  }

  const created = [];
  for (const n of cleanNums) {
    const c = db.createChif3(cleanId, n, category || 'basic', numPrice);
    created.push(String(c.id));
  }
  res.json({ ok: true, ids: created, count: created.length });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ===== Notifikasyon (admin -> itilizatè) =====
// FCM — sipòte de mòd:
//   1) FCM_SERVICE_ACCOUNT (JSON string) -> HTTP v1 OAuth2 (rekòmande, modèn)
//   2) FCM_SERVER_KEY (legacy) -> fallback
const FCM_SERVICE_ACCOUNT = process.env.FCM_SERVICE_ACCOUNT || '';
const FCM_V1_PROJECT_ID = process.env.FCM_V1_PROJECT_ID || '';
const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY || '';

// Rejistre token FCM itilizatè a (pou push reyèl).
app.post('/api/notifications/register-token', requireAuth, (req, res) => {
  const token = (req.body && req.body.token ? String(req.body.token).trim() : '');
  if (!token) return res.status(400).json({ error: 'Token obligatwa' });
  db.saveFcmToken(req.user.id, token);
  res.json({ ok: true });
});

// Lis notifikasyon pou itilizatè konekte (sèlman sa ki adrese l').
app.get('/api/notifications', requireAuth, (req, res) => {
  const user = req.user;
  const subs = db.getActiveSubsForUser(user.id);
  const lotteryIds = new Set(subs.map((s) => s.lottery_id));
  const categories = new Set(subs.map((s) => s.plan));
  const isVip = subs.length > 0;

  const rows = db.listNotifications().filter((n) => {
    const a = n.audience;
    if (!a || a === 'all') return true;
    if (a === 'vip') return isVip;
    if (a === 'ny' || a === 'fl') return lotteryIds.has(a);
    if (a === 'basic' || a === 'silver' || a === 'gold') return categories.has(a);
    return true;
  });
  res.json(rows.map(serializeNotification));
});

function serializeNotification(n) {
  return {
    id: String(n.id),
    title: n.title,
    body: n.body,
    audience: n.audience || 'all',
    created_at: n.created_at,
  };
}

// Admin voye yon notifikasyon. audience: all | vip | ny | fl | basic | silver | gold
app.post('/api/admin/notifications/send', requireAdmin, async (req, res) => {
  const { title, body, audience } = req.body || {};
  const cleanTitle = String(title || '').trim();
  const cleanBody = String(body || '').trim();
  if (!cleanTitle || !cleanBody) {
    return res.status(400).json({ error: 'Tit ak mesaj obligatwa' });
  }
  const cleanAudience = ['all', 'vip', 'ny', 'fl', 'basic', 'silver', 'gold'].includes(audience)
    ? audience
    : 'all';

  const n = db.createNotification({ title: cleanTitle, body: cleanBody, audience: cleanAudience });

  // Push reyèl FCM (si kle prezan) — voye a moun ki nan odyans lan.
  let pushed = 0;
  try {
    const tokens = collectAudienceTokens(cleanAudience);
    for (const tk of tokens) {
      const ok = await sendFcm(tk, cleanTitle, cleanBody);
      if (ok) pushed++;
    }
  } catch (e) {
    console.error('[fcm] voye echwe:', e.message);
  }

  res.json({ ok: true, id: String(n.id), pushed: pushed, audience: cleanAudience });
});

function collectAudienceTokens(audience) {
  const tokens = [];
  for (const u of db.listUsers()) {
    if (!Array.isArray(u.fcm_tokens) || !u.fcm_tokens.length) continue;
    const subs = db.getActiveSubsForUser(u.id);
    let include = audience === 'all';
    if (audience === 'vip') {
      include = subs.length > 0;
    } else if (audience === 'ny' || audience === 'fl') {
      include = subs.some((s) => s.lottery_id === audience);
    } else if (audience === 'basic' || audience === 'silver' || audience === 'gold') {
      include = subs.some((s) => s.plan === audience);
    }
    if (include) tokens.push(...u.fcm_tokens);
  }
  return tokens;
}

// FCM (sipòte HTTP v1 OAuth2 ak legacy). Si pa konfig, skip silansyeman.
async function sendFcm(token, title, body) {
  try {
    if (FCM_SERVICE_ACCOUNT && FCM_V1_PROJECT_ID) {
      return await sendFcmV1(token, title, body);
    }
    if (FCM_SERVER_KEY) {
      return await sendFcmLegacy(token, title, body);
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function sendFcmLegacy(token, title, body) {
  const res = await fetch('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'key=' + FCM_SERVER_KEY,
    },
    body: JSON.stringify({
      to: token,
      notification: { title: title, body: body, sound: 'default' },
      data: { title: title, body: body },
    }),
  });
  const j = await res.json().catch(() => ({}));
  return res.ok && (j.success === 1 || j.success === true);
}

// HTTP v1 + OAuth2 (sèvis kont). Signature JWT gen n mwaye kourte (1 èdtan).
async function sendFcmV1(token, title, body) {
  let sa;
  try {
    sa = JSON.parse(FCM_SERVICE_ACCOUNT);
  } catch (e) {
    return false;
  }
  const accessToken = await getGoogleAccessToken(sa, 'https://www.googleapis.com/auth/firebase.messaging');
  if (!accessToken) return false;
  const url = `https://fcm.googleapis.com/v1/projects/${FCM_V1_PROJECT_ID}/messages:send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + accessToken,
    },
    body: JSON.stringify({
      message: {
        token: token,
        notification: { title: title, body: body },
        data: { title: title, body: body },
        android: { priority: 'HIGH' },
      },
    }),
  });
  const j = await res.json().catch(() => ({}));
  return res.ok && !j.error;
}

function getGoogleAccessToken(sa, scope) {
  const crypto = require('crypto');
  const email = sa.client_email;
  const key = sa.private_key;
  if (!email || !key) return Promise.resolve(null);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: email,
    scope: scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = b64(header) + '.' + b64(claims);
  const sig = crypto.createSign('RSA-SHA256').update(input).sign(key, 'base64url');
  const jwt = input + '.' + sig;
  return fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(jwt),
  })
    .then((r) => r.json())
    .then((j) => (j && j.access_token) || null)
    .catch(() => null);
}

// --- APK otomatik update ---
const LATEST_APK_VERSION = process.env.LATEST_APK_VERSION || '3.8.0';
const LATEST_APK_URL = process.env.LATEST_APK_URL || '';
app.get('/api/version', (req, res) => {
  res.json({
    version: LATEST_APK_VERSION,
    version_code: Number(process.env.LATEST_APK_CODE || '8'),
    download_url: LATEST_APK_URL,
    force: (process.env.FORCE_UPDATE || 'false') === 'true',
  });
});

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
// Sinkwonize rezilta apre chak tiraj (lè ET) + chak 30 minit kòm backup.
// FL: midday 1:30pm ET -> 1:45pm; evening 9:45pm ET -> 10:00pm ET
// NY: midday 2:30pm ET -> 2:45pm; evening 10:30pm ET -> 10:45pm ET
// (America/New_York = ET; node-cron pran timezone ladan)
const ET = 'America/New_York';
cron.schedule('45 13 * * *', syncResults, { timezone: ET }); // FL midday
cron.schedule('45 10 * * *', syncResults, { timezone: ET }); // FL evening
cron.schedule('45 14 * * *', syncResults, { timezone: ET }); // NY midday
cron.schedule('45 22 * * *', syncResults, { timezone: ET }); // NY evening
cron.schedule('*/30 * * * *', syncResults);
syncResults();

app.listen(PORT, () => {
  console.log(`Shop loto backend ap koute sou pò ${PORT}`);
});
