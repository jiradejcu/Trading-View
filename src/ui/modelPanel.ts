import type { LagModel, LagParams, Norm } from '../custom/liquidity';
import { MAX_LAG_WEEKS, NORM_LABEL } from '../custom/liquidity';
import type { LagCorr } from '../lib/series';
import { C } from './theme';

export interface ModelPanelState { lag: LagParams; btcAsPrice: boolean; showAllLines: boolean }

const r2 = (r: number) => (Number.isFinite(r) ? r.toFixed(2) : '–');

export class ModelPanel {
  private canvas!: HTMLCanvasElement;
  private tip!: HTMLElement;
  private model: LagModel | null = null;
  private hoverLag: number | null = null;

  constructor(private el: HTMLElement, private onChange: (patch: Partial<ModelPanelState>) => void) {}

  mount(st: ModelPanelState) {
    const norms = (Object.keys(NORM_LABEL) as Norm[])
      .map((n) => `<option value="${n}"${n === st.lag.norm ? ' selected' : ''}>${NORM_LABEL[n]}</option>`).join('');
    this.el.innerHTML = `
      <h3>Lag model</h3>
      <p class="sub">Inverse MOVE + global liquidity, shifted forward to lead Bitcoin</p>
      <div class="mp-field">
        <div class="row"><span class="key"><i style="background:${C.s3}"></i>Global liquidity lead</span><output id="o-gli"></output></div>
        <input id="i-gli" type="range" min="0" max="${MAX_LAG_WEEKS}" step="1" value="${st.lag.lagGli}" aria-label="Global liquidity lead in weeks" />
      </div>
      <div class="mp-field">
        <div class="row"><span class="key"><i style="background:${C.s4}"></i>Inverse MOVE lead</span><output id="o-move"></output></div>
        <input id="i-move" type="range" min="0" max="${MAX_LAG_WEEKS}" step="1" value="${st.lag.lagMove}" aria-label="Inverse MOVE lead in weeks" />
      </div>
      <div class="mp-field">
        <div class="row"><span class="key"><i style="background:${C.s2}"></i>Composite weight</span><output id="o-w"></output></div>
        <input id="i-w" type="range" min="0" max="100" step="5" value="${Math.round(st.lag.wGli * 100)}" aria-label="Weight of global liquidity in the composite" />
      </div>
      <div class="mp-field">
        <label for="i-norm" class="muted">Normalization</label>
        <select id="i-norm">${norms}</select>
      </div>
      <label class="mp-check" title="Off: BTC plus the two lines that correlate best with it">
        <input id="i-comp" type="checkbox"${st.showAllLines ? ' checked' : ''}/> Show all lines</label>
      <label class="mp-check"><input id="i-price" type="checkbox"${st.btcAsPrice ? ' checked' : ''}/> BTC price pane (log)</label>
      <button id="i-auto" class="mp-btn">Auto-fit lags (max correlation)</button>
      <dl class="stats" id="stats"></dl>
      <div>
        <div class="xc-legend"><span><i style="background:${C.s3}"></i>GLI → BTC</span><span><i style="background:${C.s4}"></i>inv MOVE → BTC</span></div>
        <div class="xc-wrap"><canvas id="xc" aria-label="Cross-correlation by lead in weeks"></canvas><div class="xc-tip" id="xc-tip" hidden></div></div>
        <p class="note">Correlation with BTC (same normalization) at each lead, 0–${MAX_LAG_WEEKS} weeks. Dots mark the chosen leads.</p>
      </div>
      <p class="note"><b>Method.</b> GLI = Fed (WALCL − TGA − RRP) + ECB assets × EURUSD + BOJ assets ÷ USDJPY, weekly, USD.
        Inverse MOVE = 100 / MOVE. Each is normalized, shifted forward by its lead, and blended into the composite.
        Points after the latest BTC week are a projection. Correlation of trending series overstates fit; the rolling z-score and YoY modes reduce that.</p>`;

    const $ = <T extends HTMLElement>(id: string) => this.el.querySelector<T>(`#${id}`)!;
    const num = (id: string) => +$<HTMLInputElement>(id).value;
    const emitLag = () => this.onChange({
      lag: { lagGli: num('i-gli'), lagMove: num('i-move'), wGli: num('i-w') / 100, norm: $<HTMLSelectElement>('i-norm').value as Norm },
    });
    for (const id of ['i-gli', 'i-move', 'i-w']) $(id).addEventListener('input', emitLag);
    $('i-norm').addEventListener('change', emitLag);
    $('i-comp').addEventListener('change', () => this.onChange({ showAllLines: $<HTMLInputElement>('i-comp').checked }));
    $('i-price').addEventListener('change', () => this.onChange({ btcAsPrice: $<HTMLInputElement>('i-price').checked }));
    $('i-auto').addEventListener('click', () => {
      if (!this.model) return;
      $<HTMLInputElement>('i-gli').value = String(this.model.bestGli.lag);
      $<HTMLInputElement>('i-move').value = String(this.model.bestMove.lag);
      emitLag();
    });

    this.canvas = $('xc');
    this.tip = $('xc-tip');
    this.canvas.addEventListener('pointermove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const lag = Math.round(((e.clientX - rect.left - 28) / (rect.width - 36)) * MAX_LAG_WEEKS);
      this.hoverLag = lag >= 0 && lag <= MAX_LAG_WEEKS ? lag : null;
      this.drawXc();
    });
    this.canvas.addEventListener('pointerleave', () => { this.hoverLag = null; this.drawXc(); });
    new ResizeObserver(() => this.drawXc()).observe(this.canvas);
    this.updateOutputs(st);
  }

  private updateOutputs(st: ModelPanelState) {
    const $ = (id: string) => this.el.querySelector<HTMLElement>(`#${id}`)!;
    $('o-gli').textContent = `${st.lag.lagGli} wk`;
    $('o-move').textContent = `${st.lag.lagMove} wk`;
    const w = Math.round(st.lag.wGli * 100);
    $('o-w').textContent = `${w}% GLI · ${100 - w}% MOVE⁻¹`;
  }

  update(st: ModelPanelState, m: LagModel) {
    this.model = m;
    this.updateOutputs(st);
    const at = (xc: LagCorr[], lag: number) => xc[lag]?.r ?? NaN;
    this.el.querySelector('#stats')!.innerHTML = `
      <dt>Composite vs BTC, r</dt><dd>${r2(m.rComposite)} <span class="muted">(n=${m.nComposite}w)</span></dd>
      <dt>GLI at +${st.lag.lagGli}w, r</dt><dd>${r2(at(m.xcGli, st.lag.lagGli))}</dd>
      <dt>Inverse MOVE at +${st.lag.lagMove}w, r</dt><dd>${r2(at(m.xcMove, st.lag.lagMove))}</dd>
      <dt>Best GLI lead</dt><dd>${m.bestGli.lag}w · r ${r2(m.bestGli.r)}</dd>
      <dt>Best inverse MOVE lead</dt><dd>${m.bestMove.lag}w · r ${r2(m.bestMove.r)}</dd>`;
    this.drawXc();
  }

  private drawXc() {
    const m = this.model, cv = this.canvas;
    if (!m || !cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const L = 28, R = 8, T = 6, B = 18;
    const x = (lag: number) => L + (lag / MAX_LAG_WEEKS) * (w - L - R);
    const y = (r: number) => T + ((1 - r) / 2) * (h - T - B);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = C.muted;
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (const r of [1, 0.5, 0, -0.5, -1]) {
      ctx.beginPath(); ctx.moveTo(L, y(r)); ctx.lineTo(w - R, y(r));
      ctx.strokeStyle = r === 0 ? C.border : C.grid; ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(r.toFixed(1), L - 4, y(r));
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let lag = 0; lag <= MAX_LAG_WEEKS; lag += 13) ctx.fillText(`${lag}w`, x(lag), h - B + 4);

    const chosen = [this.currentLag('i-gli'), this.currentLag('i-move')];
    [[m.xcGli, C.s3], [m.xcMove, C.s4]].forEach(([xc, color], k) => {
      const list = xc as LagCorr[];
      ctx.strokeStyle = color as string; ctx.lineWidth = 2; ctx.beginPath();
      let started = false;
      for (const c of list) {
        if (!Number.isFinite(c.r)) { started = false; continue; }
        if (!started) { ctx.moveTo(x(c.lag), y(c.r)); started = true; } else ctx.lineTo(x(c.lag), y(c.r));
      }
      ctx.stroke();
      const c = list[chosen[k]];
      if (c && Number.isFinite(c.r)) {
        ctx.fillStyle = color as string; ctx.strokeStyle = C.bg; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x(c.lag), y(c.r), 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    });

    if (this.hoverLag != null) {
      const lag = this.hoverLag;
      ctx.strokeStyle = C.muted; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x(lag), T); ctx.lineTo(x(lag), h - B); ctx.stroke(); ctx.setLineDash([]);
      this.tip.hidden = false;
      this.tip.innerHTML = `Lead ${lag}w<br>GLI r ${r2(m.xcGli[lag]?.r)} · inv MOVE r ${r2(m.xcMove[lag]?.r)}`;
      const tx = Math.min(Math.max(x(lag) - 70, 0), w - 150);
      this.tip.style.left = `${tx}px`; this.tip.style.top = `${T}px`;
    } else this.tip.hidden = true;
  }

  private currentLag(id: string) {
    return +(this.el.querySelector<HTMLInputElement>(`#${id}`)?.value ?? 0);
  }
}
