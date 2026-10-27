/**
 * Карта линий плана: всё нарисованное превращается в отрезки с толщиной и длиной, и каждому отрезку
 * присваивается вид — стена, размерная, выносная, дуга двери, прочее. Поиск комнат берёт из карты только стены,
 * распознавание размеров — размерные и выносные.
 *
 * Как строится: тёмные пиксели утончаются до осевых линий шириной в пиксель (скелет), скелет разбирается на цепочки
 * между концами и развилками, цепочки спрямляются в отрезки. Толщина отрезка — удвоенное расстояние от оси
 * до края линии, медиана по его пикселям.
 */

export interface Pt {
  x: number;
  y: number;
}

export type LineKind = 'wall' | 'dim' | 'ext' | 'arc' | 'other';

export interface Seg {
  a: Pt;
  b: Pt;
  /** Толщина, пиксели. */
  thick: number;
  /** Длина, пиксели. */
  len: number;
  kind: LineKind;
  /** Номер цепочки скелета, из которой отрезок получен: соседние отрезки одной цепочки — одна ломаная. */
  chain: number;
}

export interface Chain {
  /** Пиксели оси по порядку (индексы y·W + x). */
  px: number[];
  /** Концы цепочки: развилка (true) или свободный конец (false). */
  aJoint: boolean;
  bJoint: boolean;
}

export interface LineMap {
  W: number;
  H: number;
  segs: Seg[];
  chains: Chain[];
  /** Толщина стены на этом плане, пиксели. */
  wallPx: number;
}

/**
 * Скелет: утончение Чжана — Суня. bin — 1 там, где линия. Возвращает новый массив, исходный не меняет.
 * Проходят только пиксели, которые ещё могут уйти, поэтому толстые стены не замедляют работу на всей картинке.
 */
export function thin(bin: Uint8Array, W: number, H: number): Uint8Array {
  const s = new Uint8Array(bin.length);
  let active: number[] = [];
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (bin[i]) {
        s[i] = 1;
        active.push(i);
      }
    }
  const del: number[] = [];
  const mark = new Uint8Array(bin.length);
  const nb = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];
  for (let changed = true; changed; ) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      const next: number[] = [];
      for (const i of active) {
        mark[i] = 0;
        if (!s[i]) continue;
        const p2 = s[i - W], p3 = s[i - W + 1], p4 = s[i + 1], p5 = s[i + W + 1];
        const p6 = s[i + W], p7 = s[i + W - 1], p8 = s[i - 1], p9 = s[i - W - 1];
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        // Внутренний пиксель (все соседи заняты) ждёт, пока до него дойдёт край: его разбудит удаление соседа.
        if (b === 8) continue;
        const a =
          (+(!p2 && p3) as number) + +(!p3 && p4) + +(!p4 && p5) + +(!p5 && p6) + +(!p6 && p7) + +(!p7 && p8) + +(!p8 && p9) + +(!p9 && p2);
        const ok = b >= 2 && b <= 6 && a === 1 && (pass === 0 ? !(p2 && p4 && p6) && !(p4 && p6 && p8) : !(p2 && p4 && p8) && !(p2 && p6 && p8));
        if (ok) del.push(i);
        else if (!mark[i]) {
          mark[i] = 1;
          next.push(i);
        }
      }
      for (const i of del) {
        s[i] = 0;
        for (const o of nb) {
          const j = i + o;
          if (s[j] && !mark[j]) {
            mark[j] = 1;
            next.push(j);
          }
        }
      }
      if (del.length) changed = true;
      active = next;
    }
  }
  // Ступеньки в две клетки: пиксель, без которого соседи всё равно связаны, лишний — он даёт ложные развилки.
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!s[i]) continue;
      const n = s[i - W], e = s[i + 1], so = s[i + W], w = s[i - 1];
      if ((n && e && !s[i - W - 1] && !s[i + W + 1] && !so && !w) || (e && so && !s[i - W + 1] && !s[i + W - 1] && !n && !w)) s[i] = 0;
      else if ((so && w && !s[i + W + 1] && !s[i - W - 1] && !n && !e) || (w && n && !s[i + W - 1] && !s[i - W + 1] && !so && !e)) s[i] = 0;
    }
  return s;
}

/** Соседи по кругу: С, СВ, В, ЮВ, Ю, ЮЗ, З, СЗ — порядок важен для подсчёта переходов. */
const ring = (W: number) => [-W, -W + 1, 1, W + 1, W, W - 1, -1, -W - 1];

/**
 * Разбор скелета на цепочки от конца или развилки до конца или развилки. Узел — пиксель, вокруг которого
 * число переходов «пусто → линия» не равно двум: 1 — конец, 3 и больше — развилка. Ступеньки скелета
 * (у пикселя три соседа, но два из них рядом) узлами так не считаются.
 */
export function trace(s: Uint8Array, W: number, H: number): Chain[] {
  const off = ring(W);
  const N = W * H;
  const kind = new Uint8Array(N); // 0 — не скелет, 1 — проходной, 2 — конец, 3 — развилка
  for (let i = W + 1; i < N - W - 1; i++) {
    if (!s[i]) continue;
    const x = i % W;
    if (x === 0 || x === W - 1) continue;
    let t = 0;
    for (let k = 0; k < 8; k++) if (!s[i + off[k]] && s[i + off[(k + 1) & 7]]) t++;
    kind[i] = t === 2 ? 1 : t < 2 ? 2 : 3;
  }
  const visited = new Uint8Array(N);
  const chains: Chain[] = [];
  // Следующий шаг: сначала прямые соседи, потом диагональные, — так не перепрыгиваем через угол ступеньки.
  const order = [0, 2, 4, 6, 1, 3, 5, 7];
  const walk = (start: number, first: number) => {
    const px = [start, first];
    let cur = first;
    let prev = start;
    while (kind[cur] === 1) {
      visited[cur] = 1;
      let nxt = -1;
      for (const k of order) {
        const j = cur + off[k];
        if (!kind[j] || j === prev || visited[j]) continue;
        if (kind[j] !== 1 && j === start && px.length < 4) continue;
        nxt = j;
        break;
      }
      if (nxt < 0) break;
      px.push(nxt);
      prev = cur;
      cur = nxt;
    }
    chains.push({ px, aJoint: kind[start] === 3, bJoint: kind[cur] === 3 });
  };
  for (let i = 0; i < N; i++) {
    if (kind[i] < 2) continue;
    for (const k of order) {
      const j = i + off[k];
      if (kind[j] === 1 && !visited[j]) walk(i, j);
    }
  }
  // Замкнутые петли без узлов.
  for (let i = 0; i < N; i++) {
    if (kind[i] !== 1 || visited[i]) continue;
    for (const k of order) {
      const j = i + off[k];
      if (kind[j] === 1 && !visited[j]) {
        walk(i, j);
        break;
      }
    }
  }
  return chains;
}

/** Упрощение ломаной Дугласом — Пекером: индексы оставленных точек. */
function simplify(xs: number[], ys: number[], eps: number): number[] {
  const keepIdx = new Uint8Array(xs.length);
  const n = xs.length - 1;
  keepIdx[0] = keepIdx[n] = 1;
  const stack: [number, number][] = [];
  // Замкнутая петля: начало и конец совпадают, поэтому сначала делим её в самой дальней от начала точке.
  if (n > 2 && Math.hypot(xs[n] - xs[0], ys[n] - ys[0]) <= 2) {
    let far = 1;
    for (let k = 1; k < n; k++) if (Math.hypot(xs[k] - xs[0], ys[k] - ys[0]) > Math.hypot(xs[far] - xs[0], ys[far] - ys[0])) far = k;
    keepIdx[far] = 1;
    stack.push([0, far], [far, n]);
  } else stack.push([0, n]);
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const dx = xs[i1] - xs[i0], dy = ys[i1] - ys[i0];
    const L = Math.hypot(dx, dy) || 1;
    let best = -1, bd = eps;
    for (let k = i0 + 1; k < i1; k++) {
      const d = Math.abs(dy * (xs[k] - xs[i0]) - dx * (ys[k] - ys[i0])) / L;
      if (d > bd) {
        bd = d;
        best = k;
      }
    }
    if (best >= 0) {
      keepIdx[best] = 1;
      stack.push([i0, best], [best, i1]);
    }
  }
  const out: number[] = [];
  keepIdx.forEach((v, i) => v && out.push(i));
  return out;
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = a.slice().sort((p, q) => p - q);
  return s[s.length >> 1];
}

/**
 * Карта линий. bin — 1 там, где линия (стены уже залиты, если были нарисованы двумя линиями);
 * dist — расстояние от каждого пикселя линии до ближайшего пустого (distanceTransform той же маски).
 */
export function buildLineMap(bin: Uint8Array, dist: Float32Array, W: number, H: number, mmPerPx: number): LineMap {
  const skel = thin(bin, W, H);
  let chains = trace(skel, W, H);
  // Отростки скелета в углах толстых стен: цепочка от свободного конца до развилки короче толщины линии там.
  chains = chains.filter((c) => {
    if (c.aJoint === c.bJoint) return true;
    const j = c.aJoint ? c.px[0] : c.px[c.px.length - 1];
    return c.px.length > 1.6 * dist[j] + 2;
  });
  const segs: Seg[] = [];
  chains.forEach((c, ci) => {
    const xs = c.px.map((i) => i % W);
    const ys = c.px.map((i) => Math.floor(i / W));
    // Расстояние считается от центра пикселя: у линии шириной w в середине оно (w + 1) / 2.
    const th = c.px.map((i) => Math.max(1, 2 * dist[i] - 1));
    const eps = Math.max(1.5, 0.5 * median(th));
    const idx = simplify(xs, ys, eps);
    for (let k = 0; k + 1 < idx.length; k++) {
      const i0 = idx[k], i1 = idx[k + 1];
      // Толщину меряем в середине отрезка: у развилок расстояние до края завышено.
      const n = i1 - i0;
      const cut = Math.min(Math.floor(n / 4), Math.ceil(th[i0] / 2) + 1);
      const mid = th.slice(i0 + cut, i1 - cut + 1);
      const a = { x: xs[i0], y: ys[i0] }, b = { x: xs[i1], y: ys[i1] };
      segs.push({ a, b, thick: Math.max(1, median(mid.length ? mid : th.slice(i0, i1 + 1))), len: Math.hypot(b.x - a.x, b.y - a.y), kind: 'other', chain: ci });
    }
  });
  const wallPx = wallThickness(segs, mmPerPx);
  classify(segs, chains, wallPx, mmPerPx);
  return { W, H, segs, chains, wallPx };
}

/** Толщина стены: самая толстая линия, которой на плане много по длине (верхние 10% длины всех линий толще 1 px). */
function wallThickness(segs: Seg[], mmPerPx: number): number {
  const list = segs.filter((s) => s.len * mmPerPx >= 300).sort((p, q) => q.thick - p.thick);
  const total = list.reduce((t, s) => t + s.len, 0);
  let acc = 0;
  for (const s of list) {
    acc += s.len;
    if (acc >= 0.1 * total) return s.thick;
  }
  return list.length ? list[list.length - 1].thick : 1;
}

/** Вид каждого отрезка. */
function classify(segs: Seg[], chains: Chain[], wallPx: number, mmPerPx: number) {
  // Порог стены: почти половина самой толстой стены, но не выше 50 мм — тонкие перегородки тоже стены.
  const minWall = Math.max(2, Math.min(0.45 * wallPx, 50 / mmPerPx));
  // Тонкая стена (перегородка) должна быть длинной: короткие толстые штрихи — это буквы и цифры подписей.
  // Длина считается по всей связной группе толстых отрезков: размерные и выносные, касаясь стены, рвут её
  // скелет на короткие куски, но группа остаётся одной.
  const cand = segs.filter((s) => s.thick >= minWall);
  const parent = cand.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < cand.length; i++)
    for (let j = i + 1; j < cand.length; j++) {
      const p = cand[i], q = cand[j];
      const tol = Math.max(p.thick, q.thick, 3);
      if (Math.min(dist2(p.a, q.a), dist2(p.a, q.b), dist2(p.b, q.a), dist2(p.b, q.b)) <= tol * tol) parent[find(i)] = find(j);
    }
  // Группа тонких отрезков — перегородка, только если она примыкает к толстой стене: подписи и их подчёркивания
  // висят в воздухе посреди комнаты.
  const groupLen = new Map<number, number>();
  const groupThick = new Set<number>();
  cand.forEach((s, i) => {
    groupLen.set(find(i), (groupLen.get(find(i)) ?? 0) + s.len);
    if (s.thick >= 0.45 * wallPx) groupThick.add(find(i));
  });
  cand.forEach((s, i) => {
    const g = find(i);
    if (s.thick >= 0.45 * wallPx || (groupThick.has(g) && (groupLen.get(g) ?? 0) * mmPerPx >= 400)) s.kind = 'wall';
  });
  // Отрезок короче своей толщины лежит внутри пятна стены: это ус скелета к углу, где к стене подходит тонкая
  // линия (коробка двери, стекло). Стеной его не считаем, иначе у торца появляется ложное косое направление.
  for (const s of segs) if (s.kind === 'wall' && s.len < s.thick) s.kind = 'other';
  // Дуга двери: цепочка из многих коротких тонких отрезков, поворачивающих в одну сторону, радиус 500–1200 мм.
  const byChain = new Map<number, Seg[]>();
  for (const s of segs) {
    if (!byChain.has(s.chain)) byChain.set(s.chain, []);
    byChain.get(s.chain)!.push(s);
  }
  for (const list of byChain.values()) {
    if (list.length < 3 || list.some((s) => s.kind === 'wall')) continue;
    let turn = 0, sign = 0, ok = true, len = 0;
    for (let k = 0; k + 1 < list.length; k++) {
      const p = list[k], q = list[k + 1];
      const a1 = Math.atan2(p.b.y - p.a.y, p.b.x - p.a.x), a2 = Math.atan2(q.b.y - q.a.y, q.b.x - q.a.x);
      let d = a2 - a1;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) > 0.6) ok = false;
      const sg = Math.sign(d);
      if (sg && sign && sg !== sign) ok = false;
      if (sg) sign = sg;
      turn += Math.abs(d);
    }
    for (const s of list) len += s.len;
    const r = len / Math.max(turn, 1e-3);
    if (ok && turn > 0.8 && r * mmPerPx >= 400 && r * mmPerPx <= 1400) for (const s of list) s.kind = 'arc';
  }
  // Размерная: тонкая прямая, у обоих концов которой поперёк проходит короткая засечка или выносная.
  const thinSegs = segs.filter((s) => s.kind === 'other');
  const crossAt = (p: Pt, s: Seg) =>
    thinSegs.filter((t) => {
      if (t === s) return false;
      if (Math.min(dist2(p, t.a), dist2(p, t.b), segDist2(p, t)) > 9) return false;
      const c = Math.abs(cosBetween(s, t));
      return c < 0.85;
    });
  for (const s of thinSegs) {
    if (s.len * mmPerPx < 300) continue;
    const ca = crossAt(s.a, s), cb = crossAt(s.b, s);
    if (ca.length && cb.length) {
      s.kind = 'dim';
      for (const t of [...ca, ...cb]) if (t.kind === 'other' && t.len * mmPerPx >= 400 && Math.abs(cosBetween(s, t)) < 0.2) t.kind = 'ext';
    }
  }
  void chains;
}

const dist2 = (p: Pt, q: Pt) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2;

function segDist2(p: Pt, s: Seg): number {
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
  const L = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / L));
  return dist2(p, { x: s.a.x + t * dx, y: s.a.y + t * dy });
}

function cosBetween(s: Seg, t: Seg): number {
  return ((s.b.x - s.a.x) * (t.b.x - t.a.x) + (s.b.y - s.a.y) * (t.b.y - t.a.y)) / (s.len * t.len || 1);
}

/** Отрезок толщиной w в маску (1 — закрашено), круглой кистью. */
export function drawSeg(m: Uint8Array, W: number, H: number, a: Pt, b: Pt, w: number) {
  const r = Math.max(0.5, w / 2);
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - r)), x1 = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x) + r));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - r)), y1 = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y) + r));
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy || 1;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L));
      if ((x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2 <= r * r) m[y * W + x] = 1;
    }
}

/**
 * Маска стен по карте: исходные пиксели линий, лежащие на отрезках-стенах. Мебель, размеры, текст и дуги
 * в неё не попадают, как бы толсто они ни были нарисованы, — если только сами не стали отрезками-стенами.
 */
export function wallPixels(map: LineMap, bin: Uint8Array): Uint8Array {
  const { W, H } = map;
  const near = new Uint8Array(W * H);
  // Радиус с запасом √2: наружный угол стены лежит дальше от оси, чем её бок.
  for (const s of map.segs) if (s.kind === 'wall') drawSeg(near, W, H, s.a, s.b, s.thick * Math.SQRT2 + 3);
  for (let i = 0; i < near.length; i++) near[i] = near[i] && bin[i] ? 1 : 0;
  return near;
}

interface End {
  p: Pt;
  /** Направление наружу из стены, единичный вектор. */
  d: Pt;
  thick: number;
  seg: Seg;
}

/**
 * Свободные концы стен: конец отрезка-стены, рядом с которым нет другой стены. Это торцы у дверей и окон
 * (рядом с ними только тонкое — коробка, створка, стекло) и обрывы стен у края нарисованного.
 */
export function wallEnds(map: LineMap): End[] {
  const walls = map.segs.filter((s) => s.kind === 'wall');
  const ends: End[] = [];
  for (const s of walls)
    for (const [p, q] of [
      [s.a, s.b],
      [s.b, s.a],
    ]) {
      const tol = Math.max(3, 0.8 * s.thick);
      const joined = walls.some((t) => t !== s && segDist2(p, t) <= tol * tol);
      if (joined) continue;
      const L = Math.hypot(p.x - q.x, p.y - q.y) || 1;
      ends.push({ p, d: { x: (p.x - q.x) / L, y: (p.y - q.y) / L }, thick: s.thick, seg: s });
    }
  return ends;
}

/**
 * Мостики через проёмы по концам стен, под любым углом: два свободных конца, смотрящих друг на друга
 * (направление на другой конец отклоняется от направления стены не больше чем на 20°), не дальше maxGap.
 * Возвращает отрезки мостиков в пикселях.
 */
export function endBridges(map: LineMap, maxGap: number, walls?: Uint8Array, sideGap = 0): { a: Pt; b: Pt; w: number }[] {
  const ends = wallEnds(map);
  const cosMax = Math.cos((20 * Math.PI) / 180);
  const cosOpp = Math.cos((25 * Math.PI) / 180);
  const out: { a: Pt; b: Pt; w: number }[] = [];
  const used = new Set<End>();
  // Пары от ближних к дальним: каждый конец закрывается один раз, ближайшим подходящим.
  const pairs: [number, End, End][] = [];
  for (let i = 0; i < ends.length; i++)
    for (let j = i + 1; j < ends.length; j++) {
      const e = ends[i], f = ends[j];
      if (e.seg === f.seg) continue;
      const vx = f.p.x - e.p.x, vy = f.p.y - e.p.y;
      const L = Math.hypot(vx, vy);
      if (L < 1 || L > maxGap) continue;
      // У короткого обрубка (косой простенок у двери) направление по скелету неточное: ему хватает 60° вместо 20°.
      const eSure = e.seg.len >= 2.5 * e.thick, fSure = f.seg.len >= 2.5 * f.thick;
      if ((!eSure || !fSure) && L > 0.75 * maxGap) continue;
      if ((vx * e.d.x + vy * e.d.y) / L < (eSure ? cosMax : 0.5)) continue;
      if (-(vx * f.d.x + vy * f.d.y) / L < (fSure ? cosMax : 0.5)) continue;
      // Стены по обе стороны проёма — продолжение друг друга, а не две случайно смотрящие друг на друга линии.
      if (eSure && fSure && -(e.d.x * f.d.x + e.d.y * f.d.y) < cosOpp) continue;
      pairs.push([L, e, f]);
    }
  pairs.sort((p, q) => p[0] - q[0]);
  for (const [, e, f] of pairs) {
    if (used.has(e) || used.has(f)) continue;
    used.add(e);
    used.add(f);
    // Мостик заходит в стену на полтолщины с каждой стороны: конец оси лежит внутри пятна стены, и без
    // захода у косого торца остаётся щель в пиксель, через которую комнаты сливаются.
    const w = Math.max(e.thick, f.thick);
    const L = Math.hypot(f.p.x - e.p.x, f.p.y - e.p.y) || 1;
    const ux = (f.p.x - e.p.x) / L, uy = (f.p.y - e.p.y) / L;
    out.push({ a: { x: e.p.x - (ux * w) / 2, y: e.p.y - (uy * w) / 2 }, b: { x: f.p.x + (ux * w) / 2, y: f.p.y + (uy * w) / 2 }, w });
  }
  // Торец без пары напротив бока другой стены (дверь в углу комнаты): идём от торца вдоль стены до первой стены.
  if (walls && sideGap > 0)
    for (const e of ends) {
      if (used.has(e)) continue;
      const { W, H } = map;
      // Начинаем за пределами своего торца, чтобы не упереться в собственную стену.
      for (let t = e.thick / 2 + 2; t <= sideGap; t += 1) {
        const x = Math.round(e.p.x + t * e.d.x), y = Math.round(e.p.y + t * e.d.y);
        if (x < 0 || y < 0 || x >= W || y >= H) break;
        if (walls[y * W + x]) {
          if (t > e.thick / 2 + 3) out.push({ a: e.p, b: { x, y }, w: e.thick });
          break;
        }
      }
    }
  return out;
}
