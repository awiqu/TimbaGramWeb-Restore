/**
 * Большие неотрицательные числа для кликера: мантисса 1…10 и десятичный порядок. Обычные double
 * кончаются на 1e308, а названия чисел (S, D, G, X, F, L…) уходят на тысячи порядков дальше.
 * Тип неизменяемый; сложение, вычитание, умножение, деление, корень, сравнение — всё, что нужно игре.
 * Точность — около 15 значащих цифр, как у double.
 */

/** Порядок выше этого не растёт (защита от мусора в сохранениях) */
const MAX_E = 1e9;
/** Числа с разницей порядков больше этой складываются без потерь: меньшее просто не заметно */
const FAR = 17;

export type BigLike = Big | number;

export class Big {
  private constructor(
    /** 1 ≤ m < 10, либо 0 для нуля */
    readonly m: number,
    /** десятичный порядок, целый */
    readonly e: number,
  ) {}

  static readonly ZERO = new Big(0, 0);
  static readonly ONE = new Big(1, 0);

  /** m × 10^e с приведением к нормальному виду; отрицательное и нечисловое — ноль */
  static from(m: number, e = 0): Big {
    if (!(m > 0) || Number.isNaN(e)) return Big.ZERO;
    if (!Number.isFinite(m)) return new Big(1, MAX_E);
    const k = Math.floor(Math.log10(m));
    let mm = m / 10 ** k;
    let ee = e + k;
    if (mm >= 10) {
      mm /= 10;
      ee++;
    } else if (mm < 1) {
      mm *= 10;
      ee--;
    }
    if (ee > MAX_E) return new Big(1, MAX_E);
    if (ee < -MAX_E) return Big.ZERO;
    return new Big(mm, ee);
  }

  static of(v: BigLike): Big {
    return v instanceof Big ? v : Big.from(v);
  }

  /** Читает сохранённое: число, пару [мантисса, порядок] или Big; всё остальное — ноль */
  static decode(v: unknown): Big {
    if (v instanceof Big) return v;
    if (typeof v === 'number') return Number.isFinite(v) ? Big.from(v) : Big.ZERO;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && Number.isFinite(v[0]) && Number.isFinite(v[1])) {
      return Big.from(v[0], Math.trunc(v[1]));
    }
    return Big.ZERO;
  }

  /** Для сохранения: обычное число, пока оно влезает, иначе пара [мантисса, порядок] */
  encode(): number | [number, number] {
    return this.e < 300 ? this.toNumber() : [this.m, this.e];
  }

  get isZero(): boolean {
    return this.m === 0;
  }

  add(o: BigLike): Big {
    const b = Big.of(o);
    if (this.isZero) return b;
    if (b.isZero) return this;
    const [hi, lo] = this.e >= b.e ? [this, b] : [b, this];
    const d = hi.e - lo.e;
    if (d > FAR) return hi;
    return Big.from(hi.m + lo.m / 10 ** d, hi.e);
  }

  /** Разность, не ниже нуля */
  sub(o: BigLike): Big {
    const b = Big.of(o);
    if (b.isZero) return this;
    if (this.cmp(b) <= 0) return Big.ZERO;
    const d = this.e - b.e;
    if (d > FAR) return this;
    return Big.from(this.m - b.m / 10 ** d, this.e);
  }

  mul(o: BigLike): Big {
    const b = Big.of(o);
    if (this.isZero || b.isZero) return Big.ZERO;
    return Big.from(this.m * b.m, this.e + b.e);
  }

  div(o: BigLike): Big {
    const b = Big.of(o);
    if (this.isZero || b.isZero) return Big.ZERO;
    return Big.from(this.m / b.m, this.e - b.e);
  }

  sqrt(): Big {
    if (this.isZero) return Big.ZERO;
    return this.e % 2 === 0 ? Big.from(Math.sqrt(this.m), this.e / 2) : Big.from(Math.sqrt(this.m * 10), (this.e - 1) / 2);
  }

  /** Целая часть (у чисел от 1e16 дробной части уже нет) */
  floor(): Big {
    return this.e >= 16 ? this : Big.from(Math.floor(this.toNumber()));
  }

  cmp(o: BigLike): number {
    const b = Big.of(o);
    if (this.isZero || b.isZero) return this.isZero ? (b.isZero ? 0 : -1) : 1;
    if (this.e !== b.e) return this.e > b.e ? 1 : -1;
    return this.m === b.m ? 0 : this.m > b.m ? 1 : -1;
  }
  gt = (o: BigLike) => this.cmp(o) > 0;
  gte = (o: BigLike) => this.cmp(o) >= 0;
  lt = (o: BigLike) => this.cmp(o) < 0;
  lte = (o: BigLike) => this.cmp(o) <= 0;

  min(o: BigLike): Big {
    const b = Big.of(o);
    return this.cmp(b) <= 0 ? this : b;
  }
  max(o: BigLike): Big {
    const b = Big.of(o);
    return this.cmp(b) >= 0 ? this : b;
  }

  /** В обычное число (Infinity, если не влезает) */
  toNumber(): number {
    if (this.isZero) return 0;
    if (this.e > 308) return Infinity;
    if (this.e < -323) return 0;
    return this.m * 10 ** this.e;
  }

  log10(): number {
    return this.isZero ? -Infinity : this.e + Math.log10(this.m);
  }
}

export const big = (v: BigLike) => Big.of(v);
/** m × 10^e — для чисел, которые не записать обычным литералом */
export const E = (m: number, e: number) => Big.from(m, e);
