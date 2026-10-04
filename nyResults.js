'use strict';
const https = require('https');

const SOCRATA_URL =
  'https://data.ny.gov/resource/hsys-3def.json?$limit=14&$order=draw_date DESC';

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { Accept: 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error('HTTP ' + res.statusCode));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function dateToYMD(dateStr) {
  const d = new Date(dateStr.replace('T00:00:00', 'T12:00:00'));
  if (isNaN(d.getTime())) return dateStr;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseNyRecord(j) {
  const drawDate = dateToYMD(j.draw_date || '');
  const out = [];
  const add = (session, game, nums, sum) => {
    if (!nums || String(nums).trim() === '') return;
    out.push({
      lottery_id: 'ny',
      draw_date: drawDate,
      game,
      session,
      numbers: String(nums).split('').filter((c) => c.trim() !== ''),
      sum: sum != null ? Number(sum) : null,
      boost: null,
    });
  };
  add('midday', 'numbers', j.midday_daily, j.midday_daily_sum);
  add('evening', 'numbers', j.evening_daily, j.evening_daily_sum);
  add('midday', 'win4', j.midday_win_4, j.midday_win_4_sum);
  add('evening', 'win4', j.evening_win_4, j.evening_win_4_sum);
  return out;
}

async function fetchNyResults(limit = 14) {
  const raw = await httpGetJson(SOCRATA_URL);
  const results = [];
  for (const rec of raw) {
    results.push(...parseNyRecord(rec));
  }
  return results.slice(0, limit * 4);
}

module.exports = { fetchNyResults, parseNyRecord };
