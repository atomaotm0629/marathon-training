#!/usr/bin/env node
/* .fit ファイルの練習内容を解析して、日本語のレポートを出す。
 *
 *   node tools/fit-report.mjs <ファイル または フォルダ> [--maxhr 190] [--goal 5:00:00]
 *
 * 依存パッケージなし。Node.js 18 以降で動く。
 * FIT の仕様（ヘッダ／定義メッセージ／データメッセージ）を直に読んでいる。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const FIT_EPOCH = 631065600;          /* 1989-12-31 00:00:00 UTC からの秒数 */
const MARA = 42.195;

/* ---------- FIT の読み取り ---------- */
const BSZ  = {0:1,1:1,2:1,3:2,4:2,5:4,6:4,7:1,8:4,9:8,10:1,11:2,12:4,13:1,14:8,15:8,16:8};
const BINV = {0:255,1:127,2:255,3:32767,4:65535,5:2147483647,6:4294967295,10:0,11:0,12:0,13:255};

function readVal(dv, pos, size, bt, le) {
  if (bt === 7) {                                   /* 文字列 */
    let t = '';
    for (let i = 0; i < size; i++) { const c = dv.getUint8(pos + i); if (!c) break; t += String.fromCharCode(c); }
    return t || null;
  }
  let v;
  switch (bt) {
    case 0: case 2: case 10: case 13: v = dv.getUint8(pos); break;
    case 1:  v = dv.getInt8(pos); break;
    case 3:  v = dv.getInt16(pos, le); break;
    case 4: case 11: v = dv.getUint16(pos, le); break;
    case 5:  v = dv.getInt32(pos, le); break;
    case 6: case 12: v = dv.getUint32(pos, le); break;
    case 8:  v = dv.getFloat32(pos, le); break;
    case 9:  v = dv.getFloat64(pos, le); break;
    default: return null;
  }
  if (BINV[bt] !== undefined && v === BINV[bt]) return null;
  if ((bt === 8 || bt === 9) && !isFinite(v)) return null;
  return v;
}

export function parseFit(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 14) throw new Error('ファイルが小さすぎます');
  const hsize = dv.getUint8(0);
  let magic = '';
  for (let i = 8; i < 12; i++) magic += String.fromCharCode(dv.getUint8(i));
  if (magic !== '.FIT') throw new Error('FITファイルではありません');
  const end = Math.min(hsize + dv.getUint32(4, true), buf.byteLength);
  let pos = hsize;
  const defs = {}, out = { sessions: [], records: [], laps: [], activity: null, device: null };
  while (pos < end) {
    const h = dv.getUint8(pos++);
    let local, isDef = false;
    if (h & 0x80) { local = (h >> 5) & 0x3; }
    else { local = h & 0x0F; isDef = !!(h & 0x40); }
    if (isDef) {
      if (pos + 5 > end) break;
      const le = dv.getUint8(pos + 1) === 0;
      const g = dv.getUint16(pos + 2, le);
      const n = dv.getUint8(pos + 4);
      pos += 5;
      const fields = [];
      for (let i = 0; i < n; i++) { fields.push([dv.getUint8(pos), dv.getUint8(pos+1), dv.getUint8(pos+2) & 0x1F]); pos += 3; }
      let dev = 0;
      if (h & 0x20) { const nd = dv.getUint8(pos++); for (let i = 0; i < nd; i++) { dev += dv.getUint8(pos+1); pos += 3; } }
      defs[local] = { g, le, fields, dev };
      continue;
    }
    const d = defs[local];
    if (!d) break;
    const keep = [18, 20, 19, 34, 23].includes(d.g);
    const vals = keep ? {} : null;
    for (const f of d.fields) {
      if (keep && pos + f[1] <= buf.byteLength) {
        const v = readVal(dv, pos, f[1], f[2], d.le);
        if (v !== null) vals[f[0]] = v;
      }
      pos += f[1];
    }
    pos += d.dev;
    if (d.g === 18) out.sessions.push(vals);
    else if (d.g === 20) out.records.push(vals);
    else if (d.g === 19) out.laps.push(vals);
    else if (d.g === 34 && !out.activity) out.activity = vals;
    else if (d.g === 23 && !out.device) out.device = vals;
  }
  return out;
}

/* ---------- 表示のための小道具 ---------- */
const pad = (s, n) => String(s).padStart(n);
const padR = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].reduce((a,c)=>a+(c.charCodeAt(0)>0x2000?2:1),0)));
const hms = s => { s = Math.round(s); const h = (s/3600)|0, m = ((s%3600)/60)|0, x = s%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}` : `${m}:${String(x).padStart(2,'0')}`; };
const pace = s => (s && isFinite(s) && s > 0) ? `${(s/60)|0}'${String(Math.round(s%60)).padStart(2,'0')}"` : '—';
const mean = a => a.length ? a.reduce((x,y)=>x+y,0) / a.length : null;
const r1 = v => Math.round(v * 10) / 10;

function parseGoal(s) {
  const p = String(s).split(':').map(Number);
  if (p.some(isNaN)) return null;
  return p.length === 3 ? p[0]*3600 + p[1]*60 + p[2] : p.length === 2 ? p[0]*60 + p[1] : p[0];
}

/* ---------- 解析 ---------- */
const SPORT = {0:'', 1:'ラン', 2:'バイク', 5:'スイム', 11:'ウォーク', 17:'ハイク'};

function analyze(buf, name, opt) {
  const { sessions, records, activity, device } = parseFit(buf);
  if (!sessions.length) throw new Error('走行のまとめ（session）がありません');
  const S = sessions[0];
  const off = (activity && activity[5] != null && activity[253] != null) ? activity[5] - activity[253] : 0;
  const local = v => new Date((FIT_EPOCH + v + off) * 1000).toISOString().replace('T',' ').slice(0, 19);

  const sec = (S[8] != null ? S[8] : S[7]) / 1000;
  const km  = S[9] != null ? S[9] / 100 / 1000 : 0;
  const sum = {
    file: name,
    device: device && device[27] ? device[27] : null,
    sport: SPORT[S[5]] ?? '',
    start: S[2] != null ? local(S[2]) : null,
    tzoff: off / 3600,
    sec, km,
    pace: km > 0 ? sec / km : null,
    hrAvg: S[16] ?? null, hrMax: S[17] ?? null, hrMin: S[64] ?? null,
    cadAvg: S[18] != null ? S[18] * 2 : null, cadMax: S[19] != null ? S[19] * 2 : null,
    stride: S[134] != null ? S[134] / 10 : null,
    kcal: S[11] ?? null, steps: S[10] != null ? S[10] * 2 : null,
    ascent: S[22] ?? null, descent: S[23] ?? null
  };

  /* 1秒ごとの系列。距離フィールドが無い時計は速度を積分して距離を作る */
  const pts = records.filter(r => r[253] != null)
    .map(r => ({ t: r[253], hr: r[3] ?? null, cad: r[4] != null ? r[4] * 2 : null,
                 sp: r[6] != null ? r[6] / 1000 : null, d: r[5] != null ? r[5] / 100 : null }))
    .sort((a, b) => a.t - b.t);

  let dist = 0, last = null, haveD = pts.some(p => p.d != null);
  for (const p of pts) {
    const dt = last == null ? 1 : Math.max(0, Math.min(10, p.t - last));
    last = p.t;
    if (haveD && p.d != null) dist = p.d; else if (p.sp) dist += p.sp * dt;
    p.cum = dist; p.dt = dt;
  }

  /* 止まっている秒を拾う（信号待ち・給水・立ち止まり）。
     0.5 m/s 未満＝1 kmあたり33分より遅い＝実質止まっている、とみなす。 */
  const STOP = 0.5;
  const haveSpeed = pts.some(p => p.sp != null);
  for (const p of pts) p.stopped = haveSpeed ? !(p.sp > STOP) : false;
  const stops = [];
  let cur = null;
  for (const p of pts) {
    if (p.stopped) {
      if (!cur) cur = { at: p.cum, sec: 0, hrs: [] };
      cur.sec += p.dt; if (p.hr) cur.hrs.push(p.hr);
    } else if (cur) { if (cur.sec >= 5) stops.push(cur); cur = null; }
  }
  if (cur && cur.sec >= 5) stops.push(cur);
  const stopSec = pts.filter(p => p.stopped).reduce((a, p) => a + p.dt, 0);
  const moveSec = pts.filter(p => !p.stopped).reduce((a, p) => a + p.dt, 0);
  /* 計測時間と経過時間が同じ＝オートポーズが働いていない＝停止も時間に含まれている */
  const autopause = (S[7] != null && S[8] != null) ? (S[7] - S[8]) / 1000 : null;

  /* 1 kmごとのラップ */
  const splits = [];
  let markD = 0, markT = pts.length ? pts[0].t : 0, seg = [];
  for (const p of pts) {
    seg.push(p);
    while (p.cum - markD >= 1000) {
      markD += 1000;
      splits.push({
        km: markD / 1000, lap: p.t - markT,
        stop: seg.filter(x => x.stopped).reduce((a, x) => a + x.dt, 0),
        hr: mean(seg.filter(x => x.hr).map(x => x.hr)),
        cad: mean(seg.filter(x => x.cad).map(x => x.cad))
      });
      markT = p.t; seg = [];
    }
  }
  if (seg.length && dist - markD > 150) {
    splits.push({ km: r1(dist / 1000), lap: seg[seg.length-1].t - markT, partial: true,
      stop: seg.filter(x => x.stopped).reduce((a, x) => a + x.dt, 0),
      hr: mean(seg.filter(x => x.hr).map(x => x.hr)), cad: mean(seg.filter(x => x.cad).map(x => x.cad)) });
  }

  /* 心拍ゾーンの滞在時間 */
  const hrs = pts.filter(p => p.hr).map(p => p.hr);
  const Z = opt.maxhr ? [
    ['E ジョグ・ロング', 0.65, 0.79], ['M レースペース', 0.79, 0.87],
    ['T 閾値',          0.87, 0.92], ['I インターバル',  0.92, null]
  ].map(([nm, lo, hi]) => {
    const a = Math.round(opt.maxhr * lo);
    const b = hi ? Math.round(opt.maxhr * hi) : Infinity;
    return { nm, lo: a, hi: b, range: hi ? `${a}-${b}` : `${a}以上`,
             n: hrs.filter(h => h >= a && h < b).length };
  }) : null;
  const below = opt.maxhr ? hrs.filter(h => h < Math.round(opt.maxhr * 0.65)).length : 0;

  /* 心拍ドリフト（前半と後半で、同じ速度に対する心拍がどれだけ上がったか） */
  const valid = pts.filter(p => p.hr && !p.stopped);
  const half = valid.length >> 1;
  const ef = a => { const s = mean(a.map(p => p.sp)), h = mean(a.map(p => p.hr)); return (s && h) ? s / h : null; };
  const ef1 = ef(valid.slice(0, half)), ef2 = ef(valid.slice(half));
  const decouple = (ef1 && ef2) ? (ef1 - ef2) / ef1 * 100 : null;

  /* ケイデンスロック（光学式心拍計が歩数を心拍として拾う誤動作）の判定 */
  const both = pts.filter(p => p.hr && p.cad);
  let lock = null;
  if (both.length > 60) {
    const h = both.map(p => p.hr), c = both.map(p => p.cad);
    const mh = mean(h), mc = mean(c);
    const sd = a => Math.sqrt(mean(a.map(x => (x - mean(a)) ** 2)));
    const cov = mean(both.map((p, i) => (h[i] - mh) * (c[i] - mc)));
    const r = cov / (sd(h) * sd(c) || 1);
    const near = both.filter((p, i) => Math.abs(h[i] - c[i]) <= 3).length / both.length;
    lock = { r, near, suspect: r > 0.7 && near > 0.6 };
  }

  sum.stopSec = stopSec;
  sum.moveSec = moveSec;
  /* 距離は時計が出した値を優先する（速度の積分値は1%ほどずれる） */
  const refKm = sum.km > 0 ? sum.km : dist / 1000;
  sum.movePace = (refKm > 0 && moveSec) ? moveSec / refKm : null;
  sum.autopause = autopause;
  return { sum, splits, stops, Z, below, hrN: hrs.length, decouple, lock };
}

/* ---------- レポート ---------- */
function report(a, opt) {
  const s = a.sum;
  const L = [];
  L.push('═'.repeat(62));
  L.push(`${s.file}${s.device ? '　（' + s.device + '）' : ''}`);
  L.push('═'.repeat(62));
  L.push(`開始      ${s.start}${s.tzoff ? `  (UTC${s.tzoff >= 0 ? '+' : ''}${s.tzoff})` : ''}　${s.sport}`);
  L.push(`距離/時間 ${r1(s.km)} km / ${hms(s.sec)}　平均 ${pace(s.pace)}/km`);
  if (s.hrAvg) L.push(`心拍      平均 ${s.hrAvg}　最大 ${s.hrMax}　最低 ${s.hrMin ?? '—'} bpm`);
  if (s.cadAvg) L.push(`ピッチ    平均 ${s.cadAvg} spm　最大 ${s.cadMax ?? '—'} spm` +
                       (s.stride ? `　ストライド ${Math.round(s.stride)} mm` : ''));
  const misc = [];
  if (s.ascent != null) misc.push(`↗${s.ascent} m / ↘${s.descent ?? '—'} m`);
  if (s.kcal) misc.push(`${s.kcal} kcal`);
  if (s.steps) misc.push(`${s.steps} 歩`);
  if (misc.length) L.push(`その他    ${misc.join('　')}`);

  if (s.stopSec) {
    L.push(`停止      ${hms(s.stopSec)}　動いている時だけなら 平均 ${pace(s.movePace)}/km`);
  }

  if (a.splits.length) {
    L.push('');
    L.push('── 1 kmごと ' + '─'.repeat(48));
    L.push('  km    ラップ    心拍   ピッチ   停止');
    const laps = a.splits.filter(x => !x.partial).map(x => x.lap);
    for (const x of a.splits) {
      L.push(`  ${pad(x.km, 4)}  ${pad(pace(x.lap), 7)}   ${pad(x.hr ? Math.round(x.hr) : '—', 4)}   ` +
             `${pad(x.cad ? Math.round(x.cad) : '—', 4)}   ${pad(x.stop ? x.stop + '秒' : '', 5)}` +
             `${x.partial ? '  (端数)' : ''}`);
    }
    if (laps.length > 1) {
      const fast = Math.min(...laps), slow = Math.max(...laps);
      L.push(`  最速 ${pace(fast)} / 最遅 ${pace(slow)} / 振れ幅 ${Math.round(slow - fast)}秒`);
    }
  }

  if (a.stops && a.stops.length) {
    L.push('');
    L.push('── 停止（信号待ちなど・5秒以上） ' + '─'.repeat(28));
    L.push('  地点        停止    その間の心拍');
    for (const x of a.stops) {
      L.push(`  ${pad(r1(x.at / 1000) + ' km', 8)}   ${pad(x.sec + '秒', 5)}   ` +
             `${pad(x.hrs.length ? Math.round(mean(x.hrs)) : '—', 4)}`);
    }
    L.push(`  合計 ${a.stops.length} 回 / ${hms(s.stopSec)}`);
    if (s.autopause === 0) {
      L.push('  ※ オートポーズが働いていないため、記録上の平均ペースには停止が含まれています。');
      L.push('     信号の多いコースでは、ペースではなく心拍で強度を管理する方が確かです。');
    }
  }

  if (a.Z) {
    L.push('');
    L.push(`── 心拍ゾーン（最大 ${opt.maxhr} 拍を基準） ` + '─'.repeat(26));
    const tot = a.hrN || 1;
    const bar = n => '█'.repeat(Math.round(n / tot * 30));
    const row = (label, n) =>
      `  ${padR(label, 24)} ${pad(Math.round(n/tot*100), 3)}%  ${pad(hms(n), 6)}  ${bar(n)}`;
    if (a.below) L.push(row('（Eより下）', a.below));
    for (const z of a.Z) L.push(row(`${z.nm} ${z.range}`, z.n));
  }

  if (a.decouple != null) {
    L.push('');
    L.push('── 心拍ドリフト ' + '─'.repeat(44));
    L.push(`  前半と後半で、同じ速度に対する心拍が ${a.decouple >= 0 ? '+' : ''}${r1(a.decouple)}% 変化`);
    L.push(`  ${a.decouple > 8 ? '→ 有酸素の土台がまだ薄い。この強度は今の走力に対して高すぎます'
            : a.decouple > 5 ? '→ やや高め。同じ距離をもう少し遅く走れると良い'
            : '→ 良好。この強度なら持続できています'}`);
  }

  if (a.lock) {
    L.push('');
    L.push('── 心拍データの信頼性 ' + '─'.repeat(38));
    L.push(`  心拍とピッチの相関 r=${Math.round(a.lock.r * 100) / 100}　差が±3拍以内の割合 ${Math.round(a.lock.near * 100)}%`);
    L.push(`  ${a.lock.suspect
      ? '→ ケイデンスロックの疑い。光学式心拍計が歩数を拾っている可能性があります'
      : '→ 問題なし。歩数を拾う誤動作（ケイデンスロック）は起きていません'}`);
  }

  /* 総評 */
  if (opt.maxhr && s.hrAvg) {
    const pct = s.hrAvg / opt.maxhr;
    const eCeil = Math.round(opt.maxhr * 0.79);
    const kind = pct < 0.79 ? 'E（ジョグ）' : pct < 0.87 ? 'M（レースペース相当）'
               : pct < 0.92 ? 'T（閾値相当）' : 'I（インターバル相当）';
    L.push('');
    L.push('── 判定 ' + '─'.repeat(52));
    L.push(`  平均心拍は最大の ${Math.round(pct * 100)}%。この練習の実態は ${kind} です。`);
    if (pct >= 0.79) {
      L.push(`  ジョグとして走るなら、平均心拍を ${eCeil} 拍以下に収めてください。`);
      if (opt.goalPace) {
        L.push(`  目標タイムから計算したイージーペースは ` +
               `${pace(opt.goalPace * 1.15)}〜${pace(opt.goalPace * 1.24)}/km` +
               `（今回は ${pace(s.pace)}/km）。`);
      }
    }
  }
  L.push('');
  return L.join('\n');
}

/* ---------- 入口 ---------- */
/* 他のスクリプトから parseFit だけを使いたいことがあるので、
   直接このファイルを実行したときだけコマンドとして動かす */
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

function main() {
const args = process.argv.slice(2);
const opt = { maxhr: null, goal: null, goalPace: null };
const paths = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--maxhr') opt.maxhr = Number(args[++i]);
  else if (args[i] === '--age') opt.maxhr = opt.maxhr || Math.round(208 - 0.7 * Number(args[++i]));
  else if (args[i] === '--goal') { opt.goal = parseGoal(args[++i]); opt.goalPace = opt.goal ? opt.goal / MARA : null; }
  else paths.push(args[i]);
}
if (!paths.length) {
  console.error('使い方: node tools/fit-report.mjs <ファイル または フォルダ> [--maxhr 190] [--age 38] [--goal 5:00:00]');
  process.exit(1);
}
const files = [];
for (const p of paths) {
  let st;
  try { st = statSync(p); }
  catch { console.error(`見つかりません: ${p}`);
    console.error('  パスを確認してください。フォルダ名に空白が含まれる場合は "..." で囲みます。');
    process.exit(1); }
  if (st.isDirectory()) {
    const found = readdirSync(p).sort().filter(f => extname(f).toLowerCase() === '.fit');
    if (!found.length) console.error(`${p} に .fit ファイルがありません`);
    for (const f of found) files.push(join(p, f));
  } else files.push(p);
}
if (!files.length) { console.error('.fit ファイルが見つかりません'); process.exit(1); }

const done = [];
for (const f of files) {
  try {
    const a = analyze(readFileSync(f), basename(f), opt);
    console.log(report(a, opt));
    done.push(a.sum);
  } catch (e) {
    console.log(`${basename(f)}：読み取れません（${e.message}）\n`);
  }
}
if (done.length > 1) {
  console.log('═'.repeat(62));
  console.log('まとめ');
  console.log('═'.repeat(62));
  console.log('  日付              距離    時間      ペース   平均心拍');
  for (const s of done) {
    console.log(`  ${padR(s.start ? s.start.slice(0, 16) : '—', 17)} ${pad(r1(s.km), 5)} km ` +
                `${pad(hms(s.sec), 8)}  ${pad(pace(s.pace), 7)}  ${pad(s.hrAvg ?? '—', 5)}`);
  }
  const tot = done.reduce((a, s) => a + s.km, 0), tsec = done.reduce((a, s) => a + s.sec, 0);
  console.log(`  合計 ${r1(tot)} km / ${hms(tsec)}`);
  console.log('');
}
}
