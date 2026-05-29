// PCHIP (Piecewise Cubic Hermite, Fritsch-Carlson)
// 和 scripts-plane/mixer.lua interp5 + scipy.interpolate.PchipInterpolator 完全一致.
// 零 overshoot, C¹ 连续.

export function pchip5(
  spd: number,
  V1: number, V2: number, V3: number, VMAX: number,
  K0: number, K1: number, K2: number, K3: number, K4: number,
): number {
  if (spd <= 0) return K0;
  if (spd >= VMAX) return K4;

  const x = [0, V1, V2, V3, VMAX];
  const y = [K0, K1, K2, K3, K4];
  const h = [x[1]-x[0], x[2]-x[1], x[3]-x[2], x[4]-x[3]];
  const d = [(y[1]-y[0])/h[0], (y[2]-y[1])/h[1], (y[3]-y[2])/h[2], (y[4]-y[3])/h[3]];

  const interior = (hl: number, hr: number, dl: number, dr: number): number => {
    if (dl * dr <= 0) return 0;
    const w1 = 2*hr + hl, w2 = hr + 2*hl;
    return (w1 + w2) / (w1/dl + w2/dr);
  };
  const endpt = (de: number, di: number, he: number, hi: number): number => {
    let v = ((2*he + hi) * de - he * di) / (he + hi);
    if (v * de <= 0) return 0;
    if (de * di <= 0 && Math.abs(v) > Math.abs(3*de)) return 3*de;
    return v;
  };

  const m = [
    endpt(d[0], d[1], h[0], h[1]),
    interior(h[0], h[1], d[0], d[1]),
    interior(h[1], h[2], d[1], d[2]),
    interior(h[2], h[3], d[2], d[3]),
    endpt(d[3], d[2], h[3], h[2]),
  ];

  let k: number;
  if (spd <= V1)      k = 0;
  else if (spd <= V2) k = 1;
  else if (spd <= V3) k = 2;
  else                k = 3;

  const t = (spd - x[k]) / h[k];
  const t2 = t*t, t3 = t2*t;
  return y[k]   * (2*t3 - 3*t2 + 1)
       + m[k]   * h[k] * (t3 - 2*t2 + t)
       + y[k+1] * (-2*t3 + 3*t2)
       + m[k+1] * h[k] * (t3 - t2);
}

// 便利: 给定曲线参数对象, 返回当前速度下 K
export function evalCurve(
  prefix: 'KS' | 'KDF' | 'KT' | 'KRD',
  spd: number,
  p: Record<string, number>,
): number {
  return pchip5(
    spd,
    p.MSK_V1, p.MSK_V2, p.MSK_V3, p.MSK_V_MAX,
    p[`MSK_${prefix}0`], p[`MSK_${prefix}1`], p[`MSK_${prefix}2`], p[`MSK_${prefix}3`], p[`MSK_${prefix}4`],
  );
}

// 采样密集点做渲染 (N 个)
export function samplePchipCurve(
  K: [number, number, number, number, number],
  V: [number, number, number, number, number],
  N = 200,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const vmax = V[4];
  for (let i = 0; i <= N; i++) {
    const v = (i / N) * vmax;
    out.push([v, pchip5(v, V[1], V[2], V[3], V[4], K[0], K[1], K[2], K[3], K[4])]);
  }
  return out;
}
