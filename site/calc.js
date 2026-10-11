/* Soloh pay package. Port of soloh() from the calculation bot.
   LOAD is 1.18. W2 RT is rounded down to the cent. Gross weekly pay is rounded half-up. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.SolohCalc = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const LOAD = "1.18";
  const NOT_VIABLE = "Not viable at target margin";

  function gcd(a, b) {
    let x = a < 0n ? -a : a;
    let y = b < 0n ? -b : b;
    while (y) {
      const t = y;
      y = x % y;
      x = t;
    }
    return x || 1n;
  }

  function rat(n, d) {
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    return { n: n / g, d: d / g };
  }

  function fromValue(value) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
    } else if (typeof value !== "string" || value.trim() === "") {
      return null;
    }
    let text = String(value).trim().replace(/[$,]/g, "");
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
    let neg = false;
    if (text[0] === "+" || text[0] === "-") {
      neg = text[0] === "-";
      text = text.slice(1);
    }
    if (/e/i.test(text)) {
      const [base, expRaw] = text.toLowerCase().split("e");
      const exp = Number(expRaw);
      const [whole, frac = ""] = base.split(".");
      const digits = `${whole}${frac}`.replace(/^0+(?=\d)/, "") || "0";
      const scale = frac.length - exp;
      let n = BigInt(digits);
      if (neg) n = -n;
      if (scale >= 0) return rat(n, 10n ** BigInt(scale));
      return rat(n * 10n ** BigInt(-scale), 1n);
    }
    const [whole, frac = ""] = text.split(".");
    const digits = `${whole}${frac}`.replace(/^0+(?=\d)/, "") || "0";
    let n = BigInt(digits);
    if (neg) n = -n;
    return rat(n, 10n ** BigInt(frac.length));
  }

  function add(a, b) {
    return rat(a.n * b.d + b.n * a.d, a.d * b.d);
  }
  function sub(a, b) {
    return rat(a.n * b.d - b.n * a.d, a.d * b.d);
  }
  function mul(a, b) {
    return rat(a.n * b.n, a.d * b.d);
  }
  function div(a, b) {
    return rat(a.n * b.d, a.d * b.n);
  }
  function cmp(a, b) {
    const left = a.n * b.d;
    const right = b.n * a.d;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }
  function min(a, b) {
    return cmp(a, b) <= 0 ? a : b;
  }
  function max(a, b) {
    return cmp(a, b) >= 0 ? a : b;
  }
  function isNeg(a) {
    return a.n < 0n;
  }
  function isZero(a) {
    return a.n === 0n;
  }

  function quantize(value, mode) {
    const num = value.n * 100n;
    const den = value.d;
    let quote = num / den;
    const rem = num % den;
    if (mode === "half-up" && rem !== 0n) {
      const absRem = rem < 0n ? -rem : rem;
      const absDen = den < 0n ? -den : den;
      if (absRem * 2n >= absDen) quote += num < 0n ? -1n : 1n;
    }
    return rat(quote, 100n);
  }

  function toNumber(value) {
    return Number(value.n) / Number(value.d);
  }

  function soloh(br, hours, weeks, perDiem, msp, nbo, tnm) {
    const BR = fromValue(br);
    const H = fromValue(hours);
    const Wk = fromValue(weeks);
    const PD = fromValue(perDiem);
    const MSP = fromValue(msp);
    const NBO = fromValue(nbo);
    const TNM = fromValue(tnm);
    if (!BR || !H || !Wk || !PD || !MSP || !NBO || !TNM || isZero(Wk) || isNeg(Wk)) {
      return { computable: false, viable: false, rt: null, gross: null };
    }
    const forty = fromValue(40);
    const cRT = min(H, forty);
    const cOT = max(sub(H, forty), fromValue(0));
    const load = fromValue(LOAD);
    const one = fromValue(1);
    const oneHalf = fromValue("1.5");
    const denom = mul(mul(load, Wk), add(cRT, mul(oneHalf, cOT)));
    if (isZero(denom)) return { computable: false, viable: false, rt: null, gross: null };
    const revenue = mul(mul(BR, H), Wk);
    const orient = mul(mul(NBO, BR), sub(one, MSP));
    const avail = sub(sub(mul(revenue, sub(one, MSP)), orient), add(mul(PD, Wk), TNM));
    const rt = quantize(div(avail, denom), "down");
    if (isNeg(rt) || isZero(rt)) return { computable: true, viable: false, rt: null, gross: null };
    const ot = mul(rt, oneHalf);
    const gross = quantize(add(add(mul(cRT, rt), mul(cOT, ot)), PD), "half-up");
    return { computable: true, viable: true, rt: toNumber(rt), gross: toNumber(gross) };
  }

  const selfCheckA = soloh(90, 36, 13, 1267, 0, 0, 4000);
  const selfCheckB = soloh(90, 36, 13, 1267, 0.06, 16, 4000);
  if (selfCheckA.rt !== 39.2 || selfCheckA.gross !== 2678.2) {
    throw new Error(`Soloh self-check A failed: ${selfCheckA.rt}, ${selfCheckA.gross}`);
  }
  if (selfCheckB.rt !== 32.17 || selfCheckB.gross !== 2425.12) {
    throw new Error(`Soloh self-check B failed: ${selfCheckB.rt}, ${selfCheckB.gross}`);
  }

  return { LOAD: 1.18, NOT_VIABLE, soloh };
});
