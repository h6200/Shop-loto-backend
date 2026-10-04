'use strict';
const https = require('https');
const { execFile } = require('child_process');

function httpGetBuf(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } },
        (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            return resolve(httpGetBuf(res.headers.location));
          }
          if (res.statusCode !== 200) {
            return reject(new Error('HTTP ' + res.statusCode));
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }
      )
      .on('error', reject);
  });
}

function pdfToText(buf) {
  return new Promise((resolve) => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = path.join(os.tmpdir(), 'fl_' + Date.now() + '.pdf');
    fs.writeFileSync(tmp, buf);
    execFile('pdftotext', ['-layout', tmp, '-'], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      fs.unlinkSync(tmp);
      if (err) return resolve('');
      resolve(stdout);
    });
  });
}

function normDate(mmddyy) {
  const m = mmddyy.match(/(\d{2})\/(\d{2})\/(\d{2})/);
  if (!m) return null;
  const year = 2000 + Number(m[3]);
  return `${year}-${m[1]}-${m[2]}`;
}

function parsePick3Text(text) {
  const out = [];
  const re = /(\d{2}\/\d{2}\/\d{2})\s+([EM])\s+(\d)\s*-\s*(\d)\s*-\s*(\d)\s+FB\s+(\d)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const date = normDate(m[1]);
    if (!date) continue;
    const session = m[2] === 'E' ? 'evening' : 'midday';
    out.push({
      lottery_id: 'fl',
      draw_date: date,
      game: 'pick3',
      session,
      numbers: [m[3], m[4], m[5]],
      sum: Number(m[3]) + Number(m[4]) + Number(m[5]),
      boost: m[6],
    });
  }
  return out;
}

function parsePick4Text(text) {
  const out = [];
  const re = /(\d{2}\/\d{2}\/\d{2})\s+([EM])\s+(\d)\s*-\s*(\d)\s*-\s*(\d)\s*-\s*(\d)\s+FB\s+(\d)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const date = normDate(m[1]);
    if (!date) continue;
    const session = m[2] === 'E' ? 'evening' : 'midday';
    out.push({
      lottery_id: 'fl',
      draw_date: date,
      game: 'pick4',
      session,
      numbers: [m[3], m[4], m[5], m[6]],
      sum: Number(m[3]) + Number(m[4]) + Number(m[5]) + Number(m[6]),
      boost: m[7],
    });
  }
  return out;
}

const FL_PDF_URLS = {
  pick2: 'https://files.floridalottery.com/exptkt/p2.pdf',
  pick3: 'https://files.floridalottery.com/exptkt/p3.pdf',
  pick4: 'https://files.floridalottery.com/exptkt/p4.pdf',
};

async function fetchFlResults(limit = 14) {
  const all = [];
  for (const [game, url] of Object.entries(FL_PDF_URLS)) {
    try {
      const buf = await httpGetBuf(url);
      const text = await pdfToText(buf);
      if (!text) continue;
      if (game === 'pick3') all.push(...parsePick3Text(text));
      if (game === 'pick4') all.push(...parsePick4Text(text));
      if (game === 'pick2') all.push(...parsePick2(text));
    } catch (e) {
      console.error('[fl] echwe ' + game + ':', e.message);
    }
  }
  const seen = new Set();
  const dedup = all.filter((r) => {
    const k = r.draw_date + '|' + r.game + '|' + r.session;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  dedup.sort((a, b) => (a.draw_date < b.draw_date ? 1 : -1));
  return dedup.slice(0, limit * 4);
}

function parsePick2(text) {
  const out = [];
  const re = /(\d{2}\/\d{2}\/\d{2})\s+([EM])\s+(\d)\s*-\s*(\d)\s+FB\s+(\d)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const date = normDate(m[1]);
    if (!date) continue;
    const session = m[2] === 'E' ? 'evening' : 'midday';
    out.push({
      lottery_id: 'fl',
      draw_date: date,
      game: 'pick2',
      session,
      numbers: [m[3], m[4]],
      sum: Number(m[3]) + Number(m[4]),
      boost: m[5],
    });
  }
  return out;
}

module.exports = { fetchFlResults, parsePick3Text, parsePick4Text };
